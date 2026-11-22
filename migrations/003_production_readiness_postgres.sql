-- AICLIPER Migration 003: Production Readiness (PostgreSQL / Google Cloud SQL)
-- Non-destructive additive DDL for staged rollout. Safe to re-run (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  email TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',
  plan_tier TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active',
  preferences_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT 'youtube',
  source_url TEXT NOT NULL DEFAULT '',
  source_video_id TEXT NOT NULL DEFAULT '',
  channel_name TEXT NOT NULL DEFAULT '',
  duration_sec INTEGER NOT NULL DEFAULT 0,
  thumbnail_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ready',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS source_assets (
  id TEXT PRIMARY KEY,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_fingerprint TEXT NOT NULL,
  storage_backend TEXT NOT NULL DEFAULT 'gcs',
  gcs_uri TEXT NOT NULL DEFAULT '',
  local_path TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT 'video/mp4',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  fps DOUBLE PRECISION NOT NULL DEFAULT 30,
  duration_sec DOUBLE PRECISION NOT NULL DEFAULT 0,
  audio_channels INTEGER NOT NULL DEFAULT 2,
  probe_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  language TEXT NOT NULL DEFAULT 'id',
  source TEXT NOT NULL DEFAULT 'gemini_audio',
  full_text TEXT NOT NULL DEFAULT '',
  segments_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS video_analyses (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  source_fingerprint TEXT NOT NULL DEFAULT '',
  pipeline_version TEXT NOT NULL DEFAULT 'v3-balanced',
  summary TEXT NOT NULL DEFAULT '',
  topics_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  highlights_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  audio_vad_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clip_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  title TEXT NOT NULL,
  hook TEXT NOT NULL DEFAULT '',
  start_sec DOUBLE PRECISION NOT NULL DEFAULT 0,
  end_sec DOUBLE PRECISION NOT NULL DEFAULT 45,
  duration_sec DOUBLE PRECISION NOT NULL DEFAULT 45,
  viral_score INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  aspect_ratio TEXT NOT NULL DEFAULT '9:16',
  intro_config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  subtitle_config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  editor_state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS speaker_profiles (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clip_candidates(id) ON DELETE CASCADE,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  speaker_key TEXT NOT NULL,
  label TEXT NOT NULL,
  color_hex TEXT NOT NULL DEFAULT '#F59E0B',
  avg_center_x DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  avg_center_y DOUBLE PRECISION NOT NULL DEFAULT 0.4,
  speaking_ratio DOUBLE PRECISION NOT NULL DEFAULT 0,
  avg_confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  is_locked BOOLEAN NOT NULL DEFAULT FALSE,
  is_ignored BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(clip_id, speaker_key)
);

CREATE TABLE IF NOT EXISTS speaker_segments (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clip_candidates(id) ON DELETE CASCADE,
  speaker_key TEXT NOT NULL,
  start_sec DOUBLE PRECISION NOT NULL,
  end_sec DOUBLE PRECISION NOT NULL,
  audio_activity_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  lip_sync_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  diarization_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  active_speaker_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  transcript_excerpt TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS face_tracks (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clip_candidates(id) ON DELETE CASCADE,
  speaker_key TEXT NOT NULL,
  time_sec DOUBLE PRECISION NOT NULL,
  x DOUBLE PRECISION NOT NULL,
  y DOUBLE PRECISION NOT NULL,
  width DOUBLE PRECISION NOT NULL,
  height DOUBLE PRECISION NOT NULL,
  mouth_activity DOUBLE PRECISION NOT NULL DEFAULT 0,
  tracking_confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  occluded BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS camera_tracking_segments (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clip_candidates(id) ON DELETE CASCADE,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  start_sec DOUBLE PRECISION NOT NULL,
  end_sec DOUBLE PRECISION NOT NULL,
  active_speaker_key TEXT NOT NULL DEFAULT 'none',
  framing_mode TEXT NOT NULL DEFAULT 'speaker_focus',
  layout_mode TEXT NOT NULL DEFAULT 'active_speaker_full',
  target_x DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  target_y DOUBLE PRECISION NOT NULL DEFAULT 0.4,
  zoom DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT 'auto_active_speaker',
  is_manual_override BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS camera_tracking_settings (
  clip_id TEXT PRIMARY KEY REFERENCES clip_candidates(id) ON DELETE CASCADE,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  auto_mode BOOLEAN NOT NULL DEFAULT TRUE,
  framing_mode TEXT NOT NULL DEFAULT 'speaker_focus',
  multi_speaker_layout TEXT NOT NULL DEFAULT 'active_speaker_full',
  locked_speaker_key TEXT,
  ignored_speaker_keys_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  tracking_sensitivity DOUBLE PRECISION NOT NULL DEFAULT 0.65,
  switching_sensitivity DOUBLE PRECISION NOT NULL DEFAULT 0.55,
  min_shot_duration_sec DOUBLE PRECISION NOT NULL DEFAULT 2.4,
  confidence_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.48,
  cooldown_sec DOUBLE PRECISION NOT NULL DEFAULT 1.2,
  manual_crop_x DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  manual_crop_y DOUBLE PRECISION NOT NULL DEFAULT 0.4,
  manual_zoom DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS intro_templates (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_sec DOUBLE PRECISION NOT NULL DEFAULT 2.0,
  is_global BOOLEAN NOT NULL DEFAULT TRUE,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_intro_templates (
  id TEXT PRIMARY KEY,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  base_template_id TEXT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Viral Hook',
  description TEXT NOT NULL DEFAULT '',
  duration_sec DOUBLE PRECISION NOT NULL DEFAULT 2.0,
  current_version INTEGER NOT NULL DEFAULT 1,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS intro_template_versions (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES user_intro_templates(id) ON DELETE CASCADE,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  change_note TEXT NOT NULL DEFAULT '',
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(template_id, version_number)
);

CREATE TABLE IF NOT EXISTS render_jobs (
  id TEXT PRIMARY KEY,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  project_id TEXT NOT NULL DEFAULT '',
  clip_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  render_profile TEXT NOT NULL DEFAULT 'balanced_1080p',
  source_fingerprint TEXT NOT NULL DEFAULT '',
  render_fingerprint TEXT NOT NULL DEFAULT '',
  cloud_task_name TEXT NOT NULL DEFAULT '',
  cloud_run_execution TEXT NOT NULL DEFAULT '',
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_json JSONB,
  error_message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS render_assets (
  id TEXT PRIMARY KEY,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  clip_id TEXT NOT NULL DEFAULT '',
  render_job_id TEXT REFERENCES render_jobs(id) ON DELETE SET NULL,
  source_fingerprint TEXT NOT NULL,
  render_fingerprint TEXT NOT NULL,
  render_profile TEXT NOT NULL DEFAULT 'balanced_1080p',
  storage_backend TEXT NOT NULL DEFAULT 'local',
  gcs_uri TEXT NOT NULL DEFAULT '',
  local_path TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  duration_sec DOUBLE PRECISION NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 1080,
  height INTEGER NOT NULL DEFAULT 1920,
  pipeline_version TEXT NOT NULL DEFAULT 'v3-balanced',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_uid, render_fingerprint)
);

CREATE TABLE IF NOT EXISTS job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  job_type TEXT NOT NULL DEFAULT 'render',
  user_uid TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS performance_metrics (
  id TEXT PRIMARY KEY,
  user_uid TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  operation TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  success BOOLEAN NOT NULL DEFAULT TRUE,
  cache_hit BOOLEAN NOT NULL DEFAULT FALSE,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 1,
  period_month TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pg_source_assets_fp ON source_assets(source_fingerprint);
CREATE INDEX IF NOT EXISTS idx_pg_speaker_segments_clip ON speaker_segments(clip_id, start_sec);
CREATE INDEX IF NOT EXISTS idx_pg_face_tracks_clip_time ON face_tracks(clip_id, time_sec);
CREATE INDEX IF NOT EXISTS idx_pg_camera_segments_clip ON camera_tracking_segments(clip_id, start_sec);
CREATE INDEX IF NOT EXISTS idx_pg_user_intro_user ON user_intro_templates(user_uid, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pg_render_jobs_fp ON render_jobs(render_fingerprint);
CREATE INDEX IF NOT EXISTS idx_pg_job_events_job ON job_events(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pg_perf_metrics_cat ON performance_metrics(category, created_at);
