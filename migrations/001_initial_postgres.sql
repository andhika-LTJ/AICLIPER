-- PostgreSQL reference migration for KlipCast / AICLIPER multi-user architecture
-- Compatible with PostgreSQL 15+ (mirrors the 13 relational tables in server/db.ts)

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  email TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  display_name TEXT,
  photo_url TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('super_admin', 'admin', 'user')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  plan_tier TEXT NOT NULL DEFAULT 'free' CHECK (plan_tier IN ('free', 'starter', 'pro', 'business')),
  revoked_before_sec BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_profiles (
  uid TEXT PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
  bio TEXT NOT NULL DEFAULT '',
  creator_niche TEXT NOT NULL DEFAULT 'Podcast & Edukasi',
  default_language TEXT NOT NULL DEFAULT 'id',
  timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta',
  theme_preference TEXT NOT NULL DEFAULT 'light' CHECK (theme_preference IN ('light', 'dark', 'system')),
  onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_settings (
  uid TEXT PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
  automation_json JSONB NOT NULL,
  webhook_secret TEXT NOT NULL DEFAULT '',
  ai_preferred_model TEXT NOT NULL DEFAULT 'gemini-4-hydrogen',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  title TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  thumbnail_url TEXT NOT NULL,
  fallback_image_url TEXT NOT NULL,
  duration_sec INTEGER NOT NULL,
  transcript_source TEXT NOT NULL,
  episode_summary TEXT NOT NULL,
  key_topics_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  chapters_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  quotes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  has_uploaded_source_video BOOLEAN NOT NULL DEFAULT FALSE,
  direct_video_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_episodes_user_created ON episodes(user_uid, created_at DESC);

CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  order_index INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  hook_line TEXT NOT NULL DEFAULT '',
  start_sec INTEGER NOT NULL,
  end_sec INTEGER NOT NULL,
  ringkasan_teks TEXT NOT NULL DEFAULT '',
  poin_kunci_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  transcript_excerpt TEXT NOT NULL DEFAULT '',
  caption_cues_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  priority_label TEXT NOT NULL DEFAULT 'Sorotan Utama',
  quality_scores_json JSONB,
  viral_score INTEGER,
  viral_reason TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  published_platforms_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  scheduled_for TIMESTAMPTZ,
  platform_copies_json JSONB NOT NULL,
  repurposed_json JSONB,
  overlay_style_json JSONB,
  render_meta_json JSONB,
  youtube_video_id TEXT,
  youtube_watch_url TEXT,
  last_published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_clips_user_episode ON clips(user_uid, episode_id, order_index);

CREATE TABLE IF NOT EXISTS render_jobs (
  job_id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  layout TEXT NOT NULL,
  quality TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  stage TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  duration_ms BIGINT,
  output_size_bytes BIGINT,
  result_json JSONB,
  error TEXT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_render_jobs_user_created ON render_jobs(user_uid, created_at DESC);

CREATE TABLE IF NOT EXISTS upload_jobs (
  id TEXT PRIMARY KEY,
  clip_id TEXT,
  episode_id TEXT,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  target_platform TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'uploading', 'completed', 'failed')),
  file_size_bytes BIGINT,
  external_url TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_upload_jobs_user_created ON upload_jobs(user_uid, created_at DESC);

CREATE TABLE IF NOT EXISTS distribution_logs (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  clip_title TEXT NOT NULL,
  episode_title TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('auto', 'manual')),
  platforms_json JSONB NOT NULL,
  webhook_delivered BOOLEAN NOT NULL DEFAULT FALSE,
  webhook_status_code INTEGER,
  status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dist_logs_user_created ON distribution_logs(user_uid, created_at DESC);

CREATE TABLE IF NOT EXISTS subscriptions (
  uid TEXT PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
  plan_tier TEXT NOT NULL DEFAULT 'free' CHECK (plan_tier IN ('free', 'starter', 'pro', 'business')),
  status TEXT NOT NULL DEFAULT 'active',
  monthly_ai_limit INTEGER NOT NULL DEFAULT 15,
  monthly_render_limit INTEGER NOT NULL DEFAULT 20,
  monthly_upload_limit INTEGER NOT NULL DEFAULT 10,
  max_video_duration_sec INTEGER NOT NULL DEFAULT 180,
  max_storage_mb INTEGER NOT NULL DEFAULT 1024,
  max_projects INTEGER NOT NULL DEFAULT 15,
  max_export_quality TEXT NOT NULL DEFAULT '1080p',
  billing_provider TEXT NOT NULL DEFAULT 'none',
  period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period_end TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  period_ym TEXT NOT NULL,
  ai_analyses_used INTEGER NOT NULL DEFAULT 0,
  renders_used INTEGER NOT NULL DEFAULT 0,
  uploads_used INTEGER NOT NULL DEFAULT 0,
  storage_bytes_used BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_uid, period_ym)
);

CREATE TABLE IF NOT EXISTS api_usage (
  id TEXT PRIMARY KEY,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  feature TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  cached BOOLEAN NOT NULL DEFAULT FALSE,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'success',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_usage_user_created ON api_usage(user_uid, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  related_id TEXT,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_uid, is_read, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id TEXT PRIMARY KEY,
  actor_uid TEXT,
  actor_email TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON admin_audit_logs(created_at DESC);
