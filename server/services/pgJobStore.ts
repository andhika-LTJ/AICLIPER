/**
 * AICLIPER Fase 0B — PostgreSQL Runtime Store for Render Job Lifecycle & Telemetry
 *
 * Uses strictly parameterized queries (`$1`, `$2`, ...) and explicit PostgreSQL
 * transactions (`BEGIN`/`COMMIT`/`ROLLBACK`) for:
 *   - Atomic worker job claiming (prevents duplicate concurrent execution)
 *   - Full status lifecycle: queued -> dispatching -> running -> uploading -> completed | failed | cancelled
 *   - Idempotent quota consumption flag (`quota_consumed`)
 *   - Ownership-isolated lookups
 *   - Real operational latency & failure metrics for Admin Readiness
 */

import type { Pool, PoolClient, QueryResult } from 'pg';
import { getPgPool, withPgTransaction } from '../../src/db/index.ts';

export type ProductionRenderJobStatus =
  | 'queued'
  | 'dispatching'
  | 'running'
  | 'uploading'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface PgRenderJobRecord {
  id: string;
  userUid: string;
  projectId: string;
  clipId: string;
  status: ProductionRenderJobStatus;
  stage: string;
  progress: number;
  renderProfile: string;
  sourceFingerprint: string;
  renderFingerprint: string;
  cloudTaskName: string;
  cloudRunExecution: string;
  retryCount: number;
  durationMs: number | null;
  outputSizeBytes: number | null;
  errorCode: string | null;
  errorMessage: string;
  failedStage: string | null;
  workerClaimToken: string | null;
  workerClaimedAt: string | null;
  quotaConsumed: boolean;
  payloadJson: Record<string, unknown>;
  resultJson: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface PgQueryRunner {
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ) => Promise<QueryResult<T>>;
}

export interface PgQueryable extends PgQueryRunner {
  connect?: () => Promise<PoolClient>;
}

export interface PgRenderTelemetrySummary {
  lastSuccessfulRenderAt: string | null;
  avgQueueLatencyMs: number | null;
  avgDispatchLatencyMs: number | null;
  avgRenderDurationMs: number | null;
  avgUploadDurationMs: number | null;
  renderFailureCount: number;
  renderRetryCount: number;
  completedRenderCount: number;
  activeRenderCount: number;
  queuedRenderCount: number;
  processingRenderCount: number;
  recentErrors: Array<{
    jobId: string;
    errorCode: string;
    stage: string;
    message: string;
    occurredAt: string;
  }>;
}

function mapPgRenderJobRow(row: Record<string, unknown>): PgRenderJobRecord {
  const toIso = (val: unknown): string | null => {
    if (!val) return null;
    if (val instanceof Date) return val.toISOString();
    return String(val);
  };
  return {
    id: String(row.id ?? ''),
    userUid: String(row.user_uid ?? ''),
    projectId: String(row.project_id ?? ''),
    clipId: String(row.clip_id ?? ''),
    status: String(row.status ?? 'queued') as ProductionRenderJobStatus,
    stage: String(row.stage ?? row.status ?? 'queued'),
    progress: Number(row.progress ?? 0),
    renderProfile: String(row.render_profile ?? 'balanced_1080p'),
    sourceFingerprint: String(row.source_fingerprint ?? ''),
    renderFingerprint: String(row.render_fingerprint ?? ''),
    cloudTaskName: String(row.cloud_task_name ?? ''),
    cloudRunExecution: String(row.cloud_run_execution ?? ''),
    retryCount: Number(row.retry_count ?? 0),
    durationMs: row.duration_ms !== null && row.duration_ms !== undefined ? Number(row.duration_ms) : null,
    outputSizeBytes:
      row.output_size_bytes !== null && row.output_size_bytes !== undefined
        ? Number(row.output_size_bytes)
        : null,
    errorCode: row.error_code ? String(row.error_code) : null,
    errorMessage: String(row.error_message ?? ''),
    failedStage: row.failed_stage ? String(row.failed_stage) : null,
    workerClaimToken: row.worker_claim_token ? String(row.worker_claim_token) : null,
    workerClaimedAt: toIso(row.worker_claimed_at),
    quotaConsumed: Boolean(row.quota_consumed),
    payloadJson:
      row.payload_json && typeof row.payload_json === 'object'
        ? (row.payload_json as Record<string, unknown>)
        : {},
    resultJson:
      row.result_json && typeof row.result_json === 'object'
        ? (row.result_json as Record<string, unknown>)
        : null,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
  };
}

export class PgRenderJobStore {
  private readonly poolOverride?: PgQueryable;

  constructor(poolOverride?: PgQueryable) {
    this.poolOverride = poolOverride;
  }

  private getPool(): PgQueryable | null {
    return this.poolOverride ?? (getPgPool() as PgQueryable | null);
  }

  isAvailable(): boolean {
    return this.getPool() !== null;
  }

  async createOrUpsertRenderJob(input: {
    id: string;
    userUid: string;
    projectId: string;
    clipId: string;
    status: ProductionRenderJobStatus;
    stage: string;
    progress?: number;
    renderProfile: string;
    sourceFingerprint: string;
    renderFingerprint: string;
    cloudTaskName?: string;
    cloudRunExecution?: string;
    payloadJson?: Record<string, unknown>;
  }): Promise<PgRenderJobRecord | null> {
    const pool = this.getPool();
    if (!pool) return null;
    const res = await pool.query(
      `INSERT INTO render_jobs (
         id, user_uid, project_id, clip_id, status, stage, progress,
         render_profile, source_fingerprint, render_fingerprint,
         cloud_task_name, cloud_run_execution, payload_json, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         stage = EXCLUDED.stage,
         progress = EXCLUDED.progress,
         cloud_task_name = CASE WHEN EXCLUDED.cloud_task_name <> '' THEN EXCLUDED.cloud_task_name ELSE render_jobs.cloud_task_name END,
         cloud_run_execution = CASE WHEN EXCLUDED.cloud_run_execution <> '' THEN EXCLUDED.cloud_run_execution ELSE render_jobs.cloud_run_execution END,
         updated_at = NOW()
       RETURNING *`,
      [
        input.id,
        input.userUid,
        input.projectId,
        input.clipId,
        input.status,
        input.stage,
        Math.max(0, Math.min(100, Math.round(input.progress ?? 0))),
        input.renderProfile,
        input.sourceFingerprint,
        input.renderFingerprint,
        input.cloudTaskName ?? '',
        input.cloudRunExecution ?? '',
        JSON.stringify(input.payloadJson ?? {}),
      ]
    );
    return res.rows[0] ? mapPgRenderJobRow(res.rows[0]) : null;
  }

  async getRenderJobById(jobId: string, ownerUid?: string): Promise<PgRenderJobRecord | null> {
    const pool = this.getPool();
    if (!pool) return null;
    const res = ownerUid
      ? await pool.query('SELECT * FROM render_jobs WHERE id = $1 AND user_uid = $2 LIMIT 1', [
          jobId,
          ownerUid,
        ])
      : await pool.query('SELECT * FROM render_jobs WHERE id = $1 LIMIT 1', [jobId]);
    return res.rows[0] ? mapPgRenderJobRow(res.rows[0]) : null;
  }

  /**
   * Atomically transitions a queued/failed job to `dispatching` inside a transaction
   * to prevent duplicate Cloud Run Job triggers from concurrent Cloud Tasks deliveries.
   */
  async markDispatching(params: {
    jobId: string;
    cloudTaskName?: string;
  }): Promise<{ claimed: boolean; job: PgRenderJobRecord | null }> {
    const pool = this.getPool();
    if (!pool) return { claimed: false, job: null };

    const runner = async (client: PgQueryRunner) => {
      const updated = await client.query(
        `UPDATE render_jobs
         SET status = 'dispatching',
             stage = 'Mengirim pekerjaan render ke Cloud Run Jobs...',
             cloud_task_name = CASE WHEN $2 <> '' THEN $2 ELSE cloud_task_name END,
             updated_at = NOW()
         WHERE id = $1
           AND status IN ('queued', 'failed')
           AND (cloud_run_execution = '' OR status = 'failed')
         RETURNING *`,
        [params.jobId, params.cloudTaskName ?? '']
      );
      if (updated.rows[0]) {
        return { claimed: true, job: mapPgRenderJobRow(updated.rows[0]) };
      }
      const existing = await client.query('SELECT * FROM render_jobs WHERE id = $1 LIMIT 1', [
        params.jobId,
      ]);
      return {
        claimed: false,
        job: existing.rows[0] ? mapPgRenderJobRow(existing.rows[0]) : null,
      };
    };

    if (pool.connect) {
      return withPgTransaction((client) => runner(client), pool as Pick<Pool, 'connect'>);
    }
    return runner(pool);
  }

  async attachCloudRunExecution(params: {
    jobId: string;
    executionName: string;
    cloudTaskName?: string;
  }): Promise<PgRenderJobRecord | null> {
    const pool = this.getPool();
    if (!pool) return null;
    const res = await pool.query(
      `UPDATE render_jobs
       SET cloud_run_execution = $2,
           cloud_task_name = CASE WHEN $3 <> '' THEN $3 ELSE cloud_task_name END,
           stage = 'Cloud Run Job terpicu, menunggu worker memulai render...',
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [params.jobId, params.executionName, params.cloudTaskName ?? '']
    );
    return res.rows[0] ? mapPgRenderJobRow(res.rows[0]) : null;
  }

  /**
   * Atomically claims a render job for execution by a standalone Cloud Run Job worker.
   * Guarantees two concurrent worker containers cannot process the same job simultaneously.
   */
  async claimJobForWorker(params: {
    jobId: string;
    claimToken: string;
    staleLockTtlSec?: number;
  }): Promise<{ claimed: boolean; job: PgRenderJobRecord | null }> {
    const pool = this.getPool();
    if (!pool) return { claimed: false, job: null };
    const ttlRaw = params.staleLockTtlSec ?? Number(process.env.WORKER_LOCK_TTL_SECONDS ?? 2100);
    const staleLockTtlSec = Number.isFinite(ttlRaw) && ttlRaw >= 1 ? Math.round(ttlRaw) : 2100;
    const staleCutoffIso = new Date(Date.now() - staleLockTtlSec * 1000).toISOString();

    const runner = async (client: PgQueryRunner) => {
      const updated = await client.query(
        `UPDATE render_jobs
         SET status = 'running',
             stage = 'Worker Cloud Run memulai proses render video...',
             progress = GREATEST(progress, 10),
             worker_claim_token = $2,
             worker_claimed_at = NOW(),
             started_at = COALESCE(started_at, NOW()),
             retry_count = CASE
               WHEN status IN ('failed', 'running', 'uploading') THEN retry_count + 1
               ELSE retry_count
             END,
             updated_at = NOW()
         WHERE id = $1
           AND (
             status IN ('queued', 'dispatching', 'failed')
             OR (status IN ('running', 'uploading') AND COALESCE(worker_claimed_at, updated_at) <= $3::timestamptz)
           )
         RETURNING *`,
        [params.jobId, params.claimToken, staleCutoffIso]
      );
      if (updated.rows[0]) {
        return { claimed: true, job: mapPgRenderJobRow(updated.rows[0]) };
      }
      const existing = await client.query('SELECT * FROM render_jobs WHERE id = $1 LIMIT 1', [
        params.jobId,
      ]);
      return {
        claimed: false,
        job: existing.rows[0] ? mapPgRenderJobRow(existing.rows[0]) : null,
      };
    };

    if (pool.connect) {
      return withPgTransaction((client) => runner(client), pool as Pick<Pool, 'connect'>);
    }
    return runner(pool);
  }

  async updateJobLifecycle(params: {
    jobId: string;
    status: ProductionRenderJobStatus;
    stage: string;
    progress?: number;
    durationMs?: number | null;
    outputSizeBytes?: number | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    failedStage?: string | null;
    resultJson?: Record<string, unknown> | null;
    quotaConsumed?: boolean;
  }): Promise<PgRenderJobRecord | null> {
    const pool = this.getPool();
    if (!pool) return null;
    const isTerminal =
      params.status === 'completed' || params.status === 'failed' || params.status === 'cancelled';

    const res = await pool.query(
      `UPDATE render_jobs
       SET status = $2,
           stage = $3,
           progress = COALESCE($4, progress),
           duration_ms = COALESCE($5, duration_ms),
           output_size_bytes = COALESCE($6, output_size_bytes),
           error_code = $7,
           error_message = COALESCE($8, error_message),
           failed_stage = $9,
           result_json = COALESCE($10::jsonb, result_json),
           quota_consumed = CASE WHEN $11 IS TRUE THEN TRUE ELSE quota_consumed END,
           completed_at = CASE WHEN $12 IS TRUE THEN NOW() ELSE completed_at END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        params.jobId,
        params.status,
        params.stage,
        params.progress !== undefined ? Math.max(0, Math.min(100, Math.round(params.progress))) : null,
        params.durationMs ?? null,
        params.outputSizeBytes ?? null,
        params.errorCode ?? null,
        params.errorMessage ?? '',
        params.failedStage ?? null,
        params.resultJson ? JSON.stringify(params.resultJson) : null,
        params.quotaConsumed === true,
        isTerminal,
      ]
    );
    return res.rows[0] ? mapPgRenderJobRow(res.rows[0]) : null;
  }

  async getRenderTelemetrySummary(): Promise<PgRenderTelemetrySummary | null> {
    const pool = this.getPool();
    if (!pool) return null;
    const [jobsRes, perfRes, errRes] = await Promise.all([
      pool.query(
        `SELECT
           MAX(CASE WHEN status = 'completed' THEN completed_at END) AS last_success,
           COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
           COALESCE(SUM(retry_count), 0)::int AS retry_count,
           COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count,
           COUNT(*) FILTER (WHERE status = 'queued')::int AS queued_count,
           COUNT(*) FILTER (WHERE status IN ('dispatching', 'running', 'uploading'))::int AS processing_count,
           COUNT(*) FILTER (WHERE status IN ('queued', 'dispatching', 'running', 'uploading'))::int AS active_count
         FROM render_jobs`
      ),
      pool.query(
        `SELECT
           AVG(CASE WHEN operation = 'queue_enqueue' THEN duration_ms END)::float AS avg_queue_ms,
           AVG(CASE WHEN operation = 'cloud_run_dispatch' THEN duration_ms END)::float AS avg_dispatch_ms,
           AVG(CASE WHEN category = 'render' AND operation LIKE 'render_%' THEN duration_ms END)::float AS avg_render_ms,
           AVG(CASE WHEN operation = 'gcs_upload' THEN duration_ms END)::float AS avg_upload_ms
         FROM performance_metrics
         WHERE created_at >= NOW() - INTERVAL '30 days'`
      ),
      pool.query(
        `SELECT id, error_code, failed_stage, stage, error_message, COALESCE(completed_at, updated_at) AS occurred_at
         FROM render_jobs
         WHERE status = 'failed'
         ORDER BY COALESCE(completed_at, updated_at) DESC
         LIMIT 5`
      ),
    ]);

    const j = jobsRes.rows[0] ?? {};
    const p = perfRes.rows[0] ?? {};
    const toRoundedOrNull = (v: unknown): number | null =>
      v !== null && v !== undefined && Number.isFinite(Number(v)) ? Math.round(Number(v)) : null;

    return {
      lastSuccessfulRenderAt: j.last_success
        ? j.last_success instanceof Date
          ? j.last_success.toISOString()
          : String(j.last_success)
        : null,
      avgQueueLatencyMs: toRoundedOrNull(p.avg_queue_ms),
      avgDispatchLatencyMs: toRoundedOrNull(p.avg_dispatch_ms),
      avgRenderDurationMs: toRoundedOrNull(p.avg_render_ms),
      avgUploadDurationMs: toRoundedOrNull(p.avg_upload_ms),
      renderFailureCount: Number(j.failed_count ?? 0),
      renderRetryCount: Number(j.retry_count ?? 0),
      completedRenderCount: Number(j.completed_count ?? 0),
      activeRenderCount: Number(j.active_count ?? 0),
      queuedRenderCount: Number(j.queued_count ?? 0),
      processingRenderCount: Number(j.processing_count ?? 0),
      recentErrors: (errRes.rows ?? []).map((r) => ({
        jobId: String(r.id ?? ''),
        errorCode: String(r.error_code ?? 'RENDER_FAILED'),
        stage: String(r.failed_stage ?? r.stage ?? 'render'),
        message: String(r.error_message ?? 'Render gagal').slice(0, 220),
        occurredAt:
          r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at ?? ''),
      })),
    };
  }
}
