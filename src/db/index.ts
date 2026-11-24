/**
 * AICLIPER Fase 0B — Drizzle ORM + Google Cloud SQL PostgreSQL Connection Manager
 *
 * Supports:
 *   1. Cloud SQL Unix socket via `SQL_INSTANCE_CONNECTION_NAME` -> `/cloudsql/<conn>`
 *   2. Direct TCP via `SQL_HOST` + `SQL_PORT` with optional TLS (`SQL_SSL=true`)
 *   3. Production pool limits, connection/idle/statement timeouts, explicit transactions,
 *      and graceful shutdown (`closePgPool()`).
 *
 * Safety:
 *   - Lazy initialization ONLY (never connects at import time).
 *   - Uses pg.Pool Object Method (never concatenates credentials into a URL string).
 *   - Sanitizes PostgreSQL error strings so credentials/passwords never leak.
 */

import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.ts';

let poolInstance: Pool | null = null;
let drizzleInstance: NodePgDatabase<typeof schema> | null = null;

export interface PgConnectionOptions {
  host?: string;
  instanceConnectionName?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
  sslRejectUnauthorized?: boolean;
  maxPoolSize?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  statementTimeoutMs?: number;
}

export interface PgReadinessSnapshot {
  configured: boolean;
  authenticated: boolean;
  connected: boolean;
  operational: boolean;
  tested: boolean;
  connectionMode: 'cloud_sql_unix_socket' | 'tcp_tls' | 'tcp' | 'unconfigured';
  latencyMs?: number;
  poolStats?: {
    totalCount: number;
    idleCount: number;
    waitingCount: number;
    maxPoolSize: number;
  };
  error?: string;
}

export function resolvePgPoolConfig(override?: PgConnectionOptions): {
  configured: boolean;
  connectionMode: 'cloud_sql_unix_socket' | 'tcp_tls' | 'tcp' | 'unconfigured';
  poolConfig: PoolConfig | null;
  maxPoolSize: number;
} {
  const instanceConnectionName = (
    override?.instanceConnectionName ??
    process.env.SQL_INSTANCE_CONNECTION_NAME ??
    process.env.CLOUD_SQL_CONNECTION_NAME ??
    ''
  ).trim();
  const explicitHost = (override?.host ?? process.env.SQL_HOST ?? '').trim();
  const host = instanceConnectionName
    ? `/cloudsql/${instanceConnectionName}`
    : explicitHost;
  const user = (override?.user ?? process.env.SQL_USER ?? process.env.CLOUD_SQL_USER ?? '').trim();
  const password = override?.password ?? process.env.SQL_PASSWORD ?? '';
  const database = (
    override?.database ??
    process.env.SQL_DB_NAME ??
    process.env.CLOUD_SQL_DATABASE ??
    ''
  ).trim();
  const portRaw = override?.port ?? Number(process.env.SQL_PORT ?? 5432);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 5432;

  const maxRaw = override?.maxPoolSize ?? Number(process.env.PG_POOL_MAX ?? 10);
  const maxPoolSize = Number.isFinite(maxRaw) && maxRaw >= 1 ? Math.min(maxRaw, 50) : 10;
  const idleRaw = override?.idleTimeoutMillis ?? Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30_000);
  const idleTimeoutMillis = Number.isFinite(idleRaw) && idleRaw >= 1000 ? idleRaw : 30_000;
  const connRaw =
    override?.connectionTimeoutMillis ?? Number(process.env.PG_CONNECTION_TIMEOUT_MS ?? 5_000);
  const connectionTimeoutMillis = Number.isFinite(connRaw) && connRaw >= 500 ? connRaw : 5_000;
  const stmtRaw =
    override?.statementTimeoutMs ?? Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 15_000);
  const statementTimeoutMs = Number.isFinite(stmtRaw) && stmtRaw >= 1000 ? stmtRaw : 15_000;

  if (!host || !user || !database) {
    return {
      configured: false,
      connectionMode: 'unconfigured',
      poolConfig: null,
      maxPoolSize,
    };
  }

  const isUnixSocket = host.startsWith('/');
  const useSsl =
    !isUnixSocket &&
    (override?.ssl === true ||
      process.env.SQL_SSL === 'true' ||
      process.env.SQL_SSL === 'require');
  const sslRejectUnauthorized =
    override?.sslRejectUnauthorized ?? process.env.SQL_SSL_REJECT_UNAUTHORIZED !== 'false';

  const poolConfig: PoolConfig = {
    host,
    port: isUnixSocket ? undefined : port,
    user,
    password,
    database,
    max: maxPoolSize,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    statement_timeout: statementTimeoutMs,
    query_timeout: statementTimeoutMs,
    ...(useSsl
      ? {
          ssl: {
            rejectUnauthorized: sslRejectUnauthorized,
          },
        }
      : {}),
  };

  return {
    configured: true,
    connectionMode: isUnixSocket ? 'cloud_sql_unix_socket' : useSsl ? 'tcp_tls' : 'tcp',
    poolConfig,
    maxPoolSize,
  };
}

export function isPostgresConfigured(override?: PgConnectionOptions): boolean {
  return resolvePgPoolConfig(override).configured;
}

export function getPgPool(override?: PgConnectionOptions): Pool | null {
  if (override) {
    const resolved = resolvePgPoolConfig(override);
    if (!resolved.configured || !resolved.poolConfig) return null;
    return new Pool(resolved.poolConfig);
  }

  if (!isPostgresConfigured()) return null;
  if (!poolInstance) {
    const resolved = resolvePgPoolConfig();
    if (!resolved.poolConfig) return null;
    poolInstance = new Pool(resolved.poolConfig);
    poolInstance.on('error', (err) => {
      console.error('[PG Pool] Unexpected idle client error:', sanitizePgError(err));
    });
  }
  return poolInstance;
}

export function getDrizzleDb(): NodePgDatabase<typeof schema> | null {
  const pool = getPgPool();
  if (!pool) return null;
  if (!drizzleInstance) {
    drizzleInstance = drizzle(pool, { schema });
  }
  return drizzleInstance;
}

export function getPgDb(): NodePgDatabase<typeof schema> {
  const db = getDrizzleDb();
  if (!db) {
    throw new Error('PostgreSQL database belum dikonfigurasi.');
  }
  return db;
}

/**
 * Executes a callback inside an explicit PostgreSQL transaction (`BEGIN` / `COMMIT` / `ROLLBACK`).
 */
export async function withPgTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  poolOverride?: Pick<Pool, 'connect'>
): Promise<T> {
  const pool = poolOverride ?? getPgPool();
  if (!pool) {
    throw new Error('PostgreSQL pool belum terkonfigurasi.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failure after primary error
    }
    throw err;
  } finally {
    client.release();
  }
}

export function isTransientPgError(err: unknown): boolean {
  const anyErr = err as { code?: string; message?: string } | undefined;
  const code = String(anyErr?.code ?? '').toUpperCase();
  const msg = String(anyErr?.message ?? err ?? '');
  // Never retry auth or constraint violations
  if (code === '28P01' || code === '28000' || code === '23505' || code === '23503' || code === '22P02') {
    return false;
  }
  const transientCodes = new Set([
    '08000',
    '08003',
    '08006',
    '53300',
    '57P01',
    '57P02',
    '57P03',
    '40001',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
  ]);
  if (transientCodes.has(code)) return true;
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|connection terminated unexpectedly|the database system is starting up|too many clients/i.test(
    msg
  );
}

/**
 * Runs a PostgreSQL operation with controlled exponential backoff for transient
 * Cloud SQL failover / cold-start connection errors.
 */
export async function withPgRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    maxAttempts?: number;
    baseDelayMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
  } = {}
): Promise<T> {
  const maxAttempts = Math.max(1, Math.min(5, options.maxAttempts ?? 3));
  const baseDelayMs = Math.max(10, options.baseDelayMs ?? 150);
  const sleep = options.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !isTransientPgError(err)) {
        throw err;
      }
      await sleep(baseDelayMs * Math.pow(2, attempt - 1));
    }
  }
  throw lastErr;
}

export async function closePgPool(): Promise<void> {
  if (poolInstance) {
    const current = poolInstance;
    poolInstance = null;
    drizzleInstance = null;
    await current.end().catch(() => undefined);
  }
}

export function sanitizePgErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, 'postgresql://[REDACTED]@')
    .replace(/password[=:]\s*[^\s,;]+/gi, 'password=[REDACTED]')
    .replace(/secret[=:]\s*[^\s,;]+/gi, 'secret=[REDACTED]');
}

export function sanitizePgError(err: unknown): { status: number; error: string; code?: string } {
  const anyErr = err as { code?: string; message?: string } | undefined;
  const code = anyErr?.code;
  const cleanMessage = sanitizePgErrorMessage(err);
  if (code === '23505') {
    return { status: 409, error: 'Data sudah terdaftar di database.', code };
  }
  if (code === '23503') {
    return { status: 400, error: 'Referensi data relasional tidak valid.', code };
  }
  if (code === '28P01' || code === '28000') {
    return { status: 503, error: 'Autentikasi database PostgreSQL gagal.', code };
  }
  return {
    status: 500,
    error: cleanMessage || 'Terjadi kesalahan pada database PostgreSQL.',
    code,
  };
}

export async function checkPgHealth(): Promise<{
  configured: boolean;
  connected: boolean;
  latencyMs?: number;
  error?: string;
}> {
  if (!isPostgresConfigured()) {
    return { configured: false, connected: false };
  }
  const start = Date.now();
  try {
    const pool = getPgPool();
    if (!pool) return { configured: false, connected: false };
    await pool.query('SELECT 1 AS ok');
    return {
      configured: true,
      connected: true,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      configured: true,
      connected: false,
      latencyMs: Date.now() - start,
      error: sanitizePgErrorMessage(err),
    };
  }
}

/**
 * Honest 5-level PostgreSQL / Cloud SQL readiness probe.
 */
export async function checkPgReadiness(
  override?: PgConnectionOptions
): Promise<PgReadinessSnapshot> {
  const resolved = resolvePgPoolConfig(override);
  if (!resolved.configured) {
    return {
      configured: false,
      authenticated: false,
      connected: false,
      operational: false,
      tested: false,
      connectionMode: 'unconfigured',
      error: 'SQL_HOST / SQL_INSTANCE_CONNECTION_NAME, SQL_USER, dan SQL_DB_NAME belum dikonfigurasi.',
    };
  }

  const start = Date.now();
  const pool = override ? getPgPool(override) : getPgPool();
  if (!pool) {
    return {
      configured: false,
      authenticated: false,
      connected: false,
      operational: false,
      tested: false,
      connectionMode: resolved.connectionMode,
    };
  }

  try {
    await pool.query('SELECT 1 AS ok');
    const schemaCheck = await pool
      .query(
        `SELECT COUNT(*)::int AS table_count
         FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('users', 'render_jobs', 'render_assets', 'job_events')`
      )
      .catch(() => ({ rows: [{ table_count: 0 }] }));
    const tableCount = Number(schemaCheck.rows?.[0]?.table_count ?? 0);
    const operational = tableCount >= 4;

    return {
      configured: true,
      authenticated: true,
      connected: true,
      operational,
      tested: true,
      connectionMode: resolved.connectionMode,
      latencyMs: Date.now() - start,
      poolStats: {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount,
        maxPoolSize: resolved.maxPoolSize,
      },
      ...(operational
        ? {}
        : {
            error: `PostgreSQL terhubung, namun schema tabel inti belum lengkap (${tableCount}/4 tabel inti ditemukan). Jalankan migrasi PostgreSQL.`,
          }),
    };
  } catch (err) {
    const cleanErr = sanitizePgErrorMessage(err);
    const isAuthErr = /password authentication failed|28P01|28000/i.test(cleanErr);
    return {
      configured: true,
      authenticated: !isAuthErr,
      connected: false,
      operational: false,
      tested: false,
      connectionMode: resolved.connectionMode,
      latencyMs: Date.now() - start,
      error: cleanErr,
    };
  } finally {
    if (override) {
      await pool.end().catch(() => undefined);
    }
  }
}

export { schema };
