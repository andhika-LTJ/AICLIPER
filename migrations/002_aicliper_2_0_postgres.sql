-- AICLIPER 2.0 — Non-Destructive PostgreSQL Migration (002_aicliper_2_0_schema)
-- Additive only: preserves all existing tables and user rows from 001_initial_postgres.sql.
-- Rollback strategy: DROP TABLE IF EXISTS billing_records, system_settings, analytics_snapshots,
--   ai_advisor_messages, content_generations, templates, editing_projects, workspace_members, workspaces;
--   ALTER TABLE user_profiles DROP COLUMN IF EXISTS theme_preset;

BEGIN;

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS theme_preset TEXT NOT NULL DEFAULT 'minimal_light';

-- 14. Workspaces
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_uid, created_at DESC);

-- 15. WorkspaceMembers
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'editor', 'viewer')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_uid)
);

-- 16. EditingProjects (Non-destructive Smart Video Editor timeline state)
CREATE TABLE IF NOT EXISTS editing_projects (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  duration_sec DOUBLE PRECISION NOT NULL DEFAULT 45,
  zoom_level DOUBLE PRECISION NOT NULL DEFAULT 1,
  safe_area_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  timeline_json JSONB NOT NULL,
  export_preset_json JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (clip_id, user_uid)
);
CREATE INDEX IF NOT EXISTS idx_editing_projects_user ON editing_projects(user_uid, updated_at DESC);

-- 17. Templates (Reusable Subtitle, Intro, Thumbnail, Export presets)
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('subtitle', 'intro', 'thumbnail', 'export')),
  description TEXT NOT NULL DEFAULT '',
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  config_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_templates_user_cat ON templates(user_uid, category, created_at DESC);

-- 18. ContentGenerations (AI Content Studio 2.0 history)
CREATE TABLE IF NOT EXISTS content_generations (
  id TEXT PRIMARY KEY,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  clip_id TEXT REFERENCES clips(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  params_json JSONB NOT NULL,
  output_json JSONB NOT NULL,
  model_used TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_content_gen_user ON content_generations(user_uid, created_at DESC);

-- 19. AiAdvisorMessages (Persistent AI Content Advisor chat per episode)
CREATE TABLE IF NOT EXISTS ai_advisor_messages (
  id TEXT PRIMARY KEY,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  model_used TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_advisor_msg_user_ep ON ai_advisor_messages(user_uid, episode_id, created_at ASC);

-- 20. AnalyticsSnapshots (Real YouTube Data API v3 or DB snapshots)
CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id TEXT PRIMARY KEY,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  external_video_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('youtube_api', 'internal_db')),
  views BIGINT NOT NULL DEFAULT 0,
  likes BIGINT NOT NULL DEFAULT 0,
  comments BIGINT NOT NULL DEFAULT 0,
  shares BIGINT NOT NULL DEFAULT 0,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_uid, clip_id, platform)
);
CREATE INDEX IF NOT EXISTS idx_analytics_user_sync ON analytics_snapshots(user_uid, last_synced_at DESC);

-- 21. SystemSettings (Dynamic platform config & editable SaaS plans)
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value_json JSONB NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 22. BillingRecords (Plan change history & future payment provider invoices)
CREATE TABLE IF NOT EXISTS billing_records (
  id TEXT PRIMARY KEY,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  plan_tier TEXT NOT NULL CHECK (plan_tier IN ('free', 'starter', 'pro', 'business')),
  amount_idr BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'IDR',
  provider TEXT NOT NULL DEFAULT 'manual_admin',
  status TEXT NOT NULL CHECK (status IN ('recorded_manual', 'pending', 'paid', 'failed', 'refunded')),
  reference_code TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_billing_user_created ON billing_records(user_uid, created_at DESC);

COMMIT;
