-- AICLIPER Fase 0B — Cloud Worker & Render Job Lifecycle PostgreSQL Migration
-- Safe, idempotent ALTER statements extending render_jobs for atomic worker claiming,
-- retry tracking, stage-level failure history, and quota idempotency protection.

ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS output_size_bytes BIGINT;
ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS error_code TEXT;
ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS failed_stage TEXT;
ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS worker_claim_token TEXT;
ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS worker_claimed_at TIMESTAMPTZ;
ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS quota_consumed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_pg_render_jobs_status_updated
  ON render_jobs(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_pg_render_jobs_fingerprint
  ON render_jobs(user_uid, render_fingerprint);

CREATE INDEX IF NOT EXISTS idx_pg_render_jobs_execution
  ON render_jobs(cloud_run_execution)
  WHERE cloud_run_execution <> '';
