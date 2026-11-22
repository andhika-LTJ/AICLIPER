import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

const { Pool } = pg;

export type DrizzlePgDb = NodePgDatabase<typeof schema>;

let cachedPool: pg.Pool | null = null;
let cachedDb: DrizzlePgDb | null = null;

export interface PostgresReadinessStatus {
  configured: boolean;
  hostConfigured: boolean;
  databaseName: string;
  mode: 'cloud_sql_postgres' | 'sqlite_staged_fallback';
}

export function isPostgresConfigured(): boolean {
  return Boolean(
    process.env.SQL_HOST &&
      process.env.SQL_USER &&
      process.env.SQL_DB_NAME
  );
}

export function getPostgresReadinessStatus(): PostgresReadinessStatus {
  const configured = isPostgresConfigured();
  return {
    configured,
    hostConfigured: Boolean(process.env.SQL_HOST),
    databaseName: process.env.SQL_DB_NAME || '',
    mode: configured ? 'cloud_sql_postgres' : 'sqlite_staged_fallback',
  };
}

/**
 * Lazy PostgreSQL connection via pg.Pool Object Method (Cloud SQL compatible).
 * Zero startup probes: pool is created only on first active database call when configured.
 */
export function getPgPool(): pg.Pool {
  if (!isPostgresConfigured()) {
    throw new Error('PostgreSQL Cloud SQL belum dikonfigurasi (SQL_HOST / SQL_USER / SQL_DB_NAME).');
  }
  if (!cachedPool) {
    cachedPool = new Pool({
      host: process.env.SQL_HOST,
      port: Number(process.env.SQL_PORT) || 5432,
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD || '',
      database: process.env.SQL_DB_NAME,
      ssl: false,
      max: Number(process.env.SQL_POOL_MAX) || 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
    });
  }
  return cachedPool;
}

export function getPgDb(): DrizzlePgDb {
  if (!cachedDb) {
    cachedDb = drizzle(getPgPool(), { schema });
  }
  return cachedDb;
}

export async function closePgPool(): Promise<void> {
  if (cachedPool) {
    await cachedPool.end();
    cachedPool = null;
    cachedDb = null;
  }
}

export function sanitizePgError(err: unknown): { status: number; error: string } {
  const code = (err as { code?: string; cause?: { code?: string } })?.code ||
    (err as { cause?: { code?: string } })?.cause?.code;
  if (code === '23505') return { status: 409, error: 'Data sudah terdaftar.' };
  if (code === '23503') return { status: 400, error: 'Referensi data tidak valid.' };
  if (code === '22P02') return { status: 400, error: 'Format parameter tidak valid.' };
  return { status: 500, error: 'Terjadi kesalahan saat memproses database.' };
}
