import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { INITIAL_STUDIO_STATE } from '../src/data/seedPodcasts.ts';
import type {
  AccountStatus,
  AppNotification,
  BotAutomationConfig,
  DistributionLog,
  PersistedRenderJobSummary,
  PlanTier,
  PodcastClip,
  PodcastEpisode,
  StudioStoreState,
  UserProfileData,
  UserRole,
} from '../src/types/clipper.ts';
import {
  DEFAULT_AUTOMATION_MAX_CLIP_SEC,
  DEFAULT_AUTOMATION_MIN_CLIP_SEC,
  normalizeAutomationDurationBounds,
} from '../src/utils/youtube.ts';

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), 'data');

export interface DbUserRow {
  uid: string;
  email: string | null;
  display_name: string | null;
  photo_url: string | null;
  role: UserRole;
  status: AccountStatus;
  revoked_before_sec: number;
  created_at: string;
  updated_at: string;
  last_login_at: string;
  deleted_at: string | null;
}

export interface DbSubscriptionRow {
  user_uid: string;
  plan_tier: PlanTier;
  status: string;
  billing_provider: string;
  monthly_ai_limit: number;
  monthly_render_limit: number;
  monthly_upload_limit: number;
  max_video_duration_sec: number;
  max_export_quality: '1080p' | '4k';
  max_storage_mb: number;
  max_projects: number;
  period_start: string;
  period_end: string;
  updated_at: string;
}

export interface DbUploadJobRow {
  id: string;
  user_uid: string;
  episode_id: string | null;
  clip_id: string | null;
  kind: 'source_video' | 'youtube_publish';
  status: 'running' | 'completed' | 'failed';
  file_size_bytes: number;
  external_url: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbApiUsageRow {
  id: string;
  user_uid: string;
  operation: string;
  model: string;
  prompt_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
  cached: number;
  created_at: string;
}

export interface DbAdminAuditLogRow {
  id: string;
  actor_uid: string;
  actor_email: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  metadata_json: string;
  ip_address: string | null;
  created_at: string;
}

export interface MigrationReport {
  migrated: boolean;
  reason?: string;
  backupPath?: string;
  episodesImported: number;
  clipsImported: number;
  logsImported: number;
  verifiedEpisodesCount: number;
  verifiedClipsCount: number;
}

export interface PlanQuotaDefaults {
  planTier: PlanTier;
  monthlyAiLimit: number;
  monthlyRenderLimit: number;
  monthlyUploadLimit: number;
  maxVideoDurationSec: number;
  maxExportQuality: '1080p' | '4k';
  maxStorageMb: number;
  maxProjects: number;
}

export const PLAN_DEFAULTS: Record<PlanTier, PlanQuotaDefaults> = {
  free: {
    planTier: 'free',
    monthlyAiLimit: 25,
    monthlyRenderLimit: 15,
    monthlyUploadLimit: 15,
    maxVideoDurationSec: 3600,
    maxExportQuality: '1080p',
    maxStorageMb: 1024,
    maxProjects: 15,
  },
  starter: {
    planTier: 'starter',
    monthlyAiLimit: 100,
    monthlyRenderLimit: 60,
    monthlyUploadLimit: 60,
    maxVideoDurationSec: 7200,
    maxExportQuality: '1080p',
    maxStorageMb: 4096,
    maxProjects: 50,
  },
  pro: {
    planTier: 'pro',
    monthlyAiLimit: 400,
    monthlyRenderLimit: 250,
    monthlyUploadLimit: 250,
    maxVideoDurationSec: 14400,
    maxExportQuality: '4k',
    maxStorageMb: 16384,
    maxProjects: 200,
  },
  business: {
    planTier: 'business',
    monthlyAiLimit: 2000,
    monthlyRenderLimit: 1000,
    monthlyUploadLimit: 1000,
    maxVideoDurationSec: 28800,
    maxExportQuality: '4k',
    maxStorageMb: 65536,
    maxProjects: 1000,
  },
};

function nowIso(): string {
  return new Date().toISOString();
}

export function getCurrentPeriodYm(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function normalizeAutomation(rawAuto: Partial<BotAutomationConfig> | null | undefined): BotAutomationConfig {
  const baseAuto = INITIAL_STUDIO_STATE.automation;
  const raw = rawAuto ?? {};
  const enableUltraHdRender =
    typeof raw.enableUltraHdRender === 'boolean'
      ? raw.enableUltraHdRender
      : raw.defaultRenderQuality === '4k';
  const defaultRenderQuality =
    raw.defaultRenderQuality === '4k' || enableUltraHdRender ? '4k' : '1080p';
  const validLayouts = new Set([
    'shorts_full_bleed',
    'shorts_studio_focus',
    'full_16_9_focus',
    'square_1_1',
    'portrait_4_5',
  ]);
  const defaultRenderLayout =
    raw.defaultRenderLayout && validLayouts.has(raw.defaultRenderLayout)
      ? raw.defaultRenderLayout
      : baseAuto.defaultRenderLayout;
  const isLegacyShortDefault = raw.minClipSec === 25 && raw.maxClipSec === 55;
  const { minClipSec, maxClipSec } = isLegacyShortDefault
    ? {
        minClipSec: DEFAULT_AUTOMATION_MIN_CLIP_SEC,
        maxClipSec: DEFAULT_AUTOMATION_MAX_CLIP_SEC,
      }
    : normalizeAutomationDurationBounds(raw.minClipSec, raw.maxClipSec);

  return {
    ...baseAuto,
    ...raw,
    minClipSec,
    maxClipSec,
    enableUltraHdRender,
    defaultRenderQuality,
    defaultRenderLayout,
    enableAiEmotionEffects:
      typeof raw.enableAiEmotionEffects === 'boolean'
        ? raw.enableAiEmotionEffects
        : baseAuto.enableAiEmotionEffects,
    enableAiIntro:
      typeof raw.enableAiIntro === 'boolean' ? raw.enableAiIntro : baseAuto.enableAiIntro,
  };
}

export class KlipCastDatabase {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  readonly dataDir: string;

  constructor(options?: { dbPath?: string; dataDir?: string }) {
    this.dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
    const configured = options?.dbPath ?? process.env.SQLITE_DB_PATH?.trim();
    this.dbPath = configured || path.join(this.dataDir, 'klipcast.sqlite');

    if (this.dbPath !== ':memory:') {
      const parent = path.dirname(this.dbPath);
      if (!fs.existsSync(parent)) {
        fs.mkdirSync(parent, { recursive: true });
      }
    }

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (this.dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
      this.db.exec('PRAGMA busy_timeout = 5000;');
    }

    this.runMigrations();
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Ignore already closed
    }
  }

  private txDepth = 0;

  getRawDb(): DatabaseSync {
    return this.db;
  }

  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      const spName = `sp_${this.txDepth}_${Date.now()}`;
      this.txDepth += 1;
      this.db.exec(`SAVEPOINT ${spName}`);
      try {
        const result = fn();
        this.db.exec(`RELEASE SAVEPOINT ${spName}`);
        return result;
      } catch (err) {
        try {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${spName}`);
          this.db.exec(`RELEASE SAVEPOINT ${spName}`);
        } catch {
          // Ignore rollback error
        }
        throw err;
      } finally {
        this.txDepth -= 1;
      }
    }

    this.txDepth = 1;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore rollback error
      }
      throw err;
    } finally {
      this.txDepth = 0;
    }
  }

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const applied = new Set(
      (
        this.db.prepare('SELECT version FROM schema_migrations').all() as Array<{
          version: string;
        }>
      ).map((r) => r.version)
    );

    if (!applied.has('001_initial_multi_user_schema')) {
      this.transaction(() => {
        this.db.exec(`
          -- 1. Users
          CREATE TABLE IF NOT EXISTS users (
            uid TEXT PRIMARY KEY,
            email TEXT,
            display_name TEXT,
            photo_url TEXT,
            role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('super_admin', 'admin', 'user')),
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
            revoked_before_sec INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_login_at TEXT NOT NULL,
            deleted_at TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
          CREATE INDEX IF NOT EXISTS idx_users_role_status ON users(role, status);

          -- 2. UserProfiles
          CREATE TABLE IF NOT EXISTS user_profiles (
            user_uid TEXT PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
            creator_niche TEXT NOT NULL DEFAULT 'Podcast & Edukasi',
            theme_preference TEXT NOT NULL DEFAULT 'light' CHECK (theme_preference IN ('light', 'dark', 'system')),
            onboarding_completed INTEGER NOT NULL DEFAULT 0,
            bio TEXT NOT NULL DEFAULT '',
            default_language TEXT NOT NULL DEFAULT 'id',
            updated_at TEXT NOT NULL
          );

          -- 3. UserSettings
          CREATE TABLE IF NOT EXISTS user_settings (
            user_uid TEXT PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
            automation_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          -- 4. Episodes
          CREATE TABLE IF NOT EXISTS episodes (
            id TEXT PRIMARY KEY,
            user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
            video_id TEXT NOT NULL,
            source_url TEXT NOT NULL,
            title TEXT NOT NULL,
            channel_name TEXT NOT NULL,
            thumbnail_url TEXT NOT NULL,
            duration_sec INTEGER NOT NULL DEFAULT 0,
            transcript_source TEXT NOT NULL DEFAULT 'metadata_and_search',
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_episodes_user_created ON episodes(user_uid, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_episodes_video_id ON episodes(video_id);

          -- 5. Clips
          CREATE TABLE IF NOT EXISTS clips (
            id TEXT PRIMARY KEY,
            episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
            user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
            order_index INTEGER NOT NULL DEFAULT 1,
            title TEXT NOT NULL,
            start_sec INTEGER NOT NULL DEFAULT 0,
            end_sec INTEGER NOT NULL DEFAULT 45,
            status TEXT NOT NULL DEFAULT 'draft',
            viral_score INTEGER,
            scheduled_for TEXT,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_clips_user_episode ON clips(user_uid, episode_id);
          CREATE INDEX IF NOT EXISTS idx_clips_user_status ON clips(user_uid, status);

          -- 6. RenderJobs
          CREATE TABLE IF NOT EXISTS render_jobs (
            job_id TEXT PRIMARY KEY,
            clip_id TEXT NOT NULL,
            user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
            layout TEXT NOT NULL,
            quality TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
            stage TEXT NOT NULL,
            progress INTEGER NOT NULL DEFAULT 0,
            retry_count INTEGER NOT NULL DEFAULT 0,
            duration_ms INTEGER,
            output_size_bytes INTEGER,
            error_message TEXT,
            error_code TEXT,
            result_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_render_jobs_user_created ON render_jobs(user_uid, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_render_jobs_status ON render_jobs(status);

          -- 7. UploadJobs
          CREATE TABLE IF NOT EXISTS upload_jobs (
            id TEXT PRIMARY KEY,
            user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
            episode_id TEXT,
            clip_id TEXT,
            kind TEXT NOT NULL CHECK (kind IN ('source_video', 'youtube_publish')),
            status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
            file_size_bytes INTEGER NOT NULL DEFAULT 0,
            external_url TEXT,
            error_message TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_upload_jobs_user_created ON upload_jobs(user_uid, created_at DESC);

          -- 8. DistributionLogs
          CREATE TABLE IF NOT EXISTS distribution_logs (
            id TEXT PRIMARY KEY,
            user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
            clip_id TEXT NOT NULL,
            clip_title TEXT NOT NULL,
            episode_title TEXT NOT NULL,
            mode TEXT NOT NULL,
            platforms_json TEXT NOT NULL,
            webhook_delivered INTEGER NOT NULL DEFAULT 0,
            webhook_status_code INTEGER,
            status TEXT NOT NULL,
            message TEXT NOT NULL,
            timestamp TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_dist_logs_user_ts ON distribution_logs(user_uid, timestamp DESC);

          -- 9. Subscriptions
          CREATE TABLE IF NOT EXISTS subscriptions (
            user_uid TEXT PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
            plan_tier TEXT NOT NULL DEFAULT 'free' CHECK (plan_tier IN ('free', 'starter', 'pro', 'business')),
            status TEXT NOT NULL DEFAULT 'active',
            billing_provider TEXT NOT NULL DEFAULT 'none',
            monthly_ai_limit INTEGER NOT NULL DEFAULT 25,
            monthly_render_limit INTEGER NOT NULL DEFAULT 15,
            monthly_upload_limit INTEGER NOT NULL DEFAULT 15,
            max_video_duration_sec INTEGER NOT NULL DEFAULT 3600,
            max_export_quality TEXT NOT NULL DEFAULT '1080p',
            max_storage_mb INTEGER NOT NULL DEFAULT 1024,
            max_projects INTEGER NOT NULL DEFAULT 15,
            period_start TEXT NOT NULL,
            period_end TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          -- 10. UsageRecords
          CREATE TABLE IF NOT EXISTS usage_records (
            user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
            period_ym TEXT NOT NULL,
            ai_analyses_used INTEGER NOT NULL DEFAULT 0,
            renders_used INTEGER NOT NULL DEFAULT 0,
            uploads_used INTEGER NOT NULL DEFAULT 0,
            storage_bytes_used INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (user_uid, period_ym)
          );

          -- 11. ApiUsage
          CREATE TABLE IF NOT EXISTS api_usage (
            id TEXT PRIMARY KEY,
            user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
            operation TEXT NOT NULL,
            model TEXT NOT NULL,
            prompt_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            estimated_cost_usd REAL NOT NULL DEFAULT 0,
            cached INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_api_usage_user_created ON api_usage(user_uid, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_api_usage_created ON api_usage(created_at DESC);

          -- 12. Notifications
          CREATE TABLE IF NOT EXISTS notifications (
            id TEXT PRIMARY KEY,
            user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            related_id TEXT,
            is_read INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_uid, is_read, created_at DESC);

          -- 13. AdminAuditLogs
          CREATE TABLE IF NOT EXISTS admin_audit_logs (
            id TEXT PRIMARY KEY,
            actor_uid TEXT NOT NULL,
            actor_email TEXT,
            action TEXT NOT NULL,
            target_type TEXT NOT NULL,
            target_id TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            ip_address TEXT,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON admin_audit_logs(created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON admin_audit_logs(actor_uid, created_at DESC);
        `);

        this.db
          .prepare(
            'INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)'
          )
          .run(
            '001_initial_multi_user_schema',
            'Create all 13 multi-user relational tables with foreign keys and indexes',
            nowIso()
          );
      });
    }

    if (!applied.has('002_aicliper_2_0_schema')) {
      this.transaction(() => {
        // Safely add theme_preset to user_profiles if missing (non-destructive)
        const profileCols = this.db
          .prepare('PRAGMA table_info(user_profiles)')
          .all() as Array<{ name: string }>;
        if (!profileCols.some((c) => c.name === 'theme_preset')) {
          this.db.exec(
            `ALTER TABLE user_profiles ADD COLUMN theme_preset TEXT NOT NULL DEFAULT 'minimal_light'`
          );
        }

        this.db.exec(`
          -- 14. Workspaces
          CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY,
            owner_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
            name TEXT NOT NULL,
            slug TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_uid, created_at DESC);

          -- 15. WorkspaceMembers
          CREATE TABLE IF NOT EXISTS workspace_members (
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
            role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'editor', 'viewer')),
            joined_at TEXT NOT NULL,
            PRIMARY KEY (workspace_id, user_uid)
          );

          -- 16. EditingProjects (Smart Video Editor non-destructive timeline)
          CREATE TABLE IF NOT EXISTS editing_projects (
            id TEXT PRIMARY KEY,
            clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
            user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
            workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
            title TEXT NOT NULL,
            duration_sec REAL NOT NULL DEFAULT 45,
            zoom_level REAL NOT NULL DEFAULT 1,
            safe_area_enabled INTEGER NOT NULL DEFAULT 1,
            timeline_json TEXT NOT NULL,
            export_preset_json TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
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
            is_public INTEGER NOT NULL DEFAULT 0,
            config_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_templates_user_cat ON templates(user_uid, category, created_at DESC);

          -- 18. ContentGenerations (AI Content Studio 2.0 custom generator history)
          CREATE TABLE IF NOT EXISTS content_generations (
            id TEXT PRIMARY KEY,
            user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
            episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
            clip_id TEXT REFERENCES clips(id) ON DELETE SET NULL,
            kind TEXT NOT NULL,
            params_json TEXT NOT NULL,
            output_json TEXT NOT NULL,
            model_used TEXT NOT NULL,
            created_at TEXT NOT NULL
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
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_advisor_msg_user_ep ON ai_advisor_messages(user_uid, episode_id, created_at ASC);

          -- 20. AnalyticsSnapshots (Real YouTube API v3 & internal DB metrics)
          CREATE TABLE IF NOT EXISTS analytics_snapshots (
            id TEXT PRIMARY KEY,
            user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
            clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
            platform TEXT NOT NULL,
            external_video_id TEXT,
            source TEXT NOT NULL CHECK (source IN ('youtube_api', 'internal_db')),
            views INTEGER NOT NULL DEFAULT 0,
            likes INTEGER NOT NULL DEFAULT 0,
            comments INTEGER NOT NULL DEFAULT 0,
            shares INTEGER NOT NULL DEFAULT 0,
            last_synced_at TEXT NOT NULL,
            UNIQUE (user_uid, clip_id, platform)
          );
          CREATE INDEX IF NOT EXISTS idx_analytics_user_sync ON analytics_snapshots(user_uid, last_synced_at DESC);

          -- 21. SystemSettings (Dynamic platform config & editable SaaS plans)
          CREATE TABLE IF NOT EXISTS system_settings (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_by TEXT,
            updated_at TEXT NOT NULL
          );

          -- 22. BillingRecords (Plan change history & future payment provider invoices)
          CREATE TABLE IF NOT EXISTS billing_records (
            id TEXT PRIMARY KEY,
            user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
            plan_tier TEXT NOT NULL CHECK (plan_tier IN ('free', 'starter', 'pro', 'business')),
            amount_idr INTEGER NOT NULL DEFAULT 0,
            currency TEXT NOT NULL DEFAULT 'IDR',
            provider TEXT NOT NULL DEFAULT 'manual_admin',
            status TEXT NOT NULL CHECK (status IN ('recorded_manual', 'pending', 'paid', 'failed', 'refunded')),
            reference_code TEXT,
            notes TEXT,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_billing_user_created ON billing_records(user_uid, created_at DESC);
        `);

        this.db
          .prepare(
            'INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)'
          )
          .run(
            '002_aicliper_2_0_schema',
            'Add 9 AICLIPER 2.0 tables (workspaces, editing_projects, templates, content_generations, ai_advisor_messages, analytics_snapshots, system_settings, billing_records) and theme_preset',
            nowIso()
          );
      });
    }
  }

  // ---------- USERS, PROFILES & SETTINGS ----------

  getUser(uid: string): DbUserRow | null {
    const row = this.db
      .prepare('SELECT * FROM users WHERE uid = ? AND deleted_at IS NULL')
      .get(uid) as DbUserRow | undefined;
    return row ?? null;
  }

  upsertAuthenticatedUser(params: {
    uid: string;
    email: string | null;
    displayName: string | null;
    photoUrl: string | null;
    resolvedRole: UserRole;
  }): DbUserRow {
    const now = nowIso();
    return this.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM users WHERE uid = ?')
        .get(params.uid) as DbUserRow | undefined;

      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO users (uid, email, display_name, photo_url, role, status, revoked_before_sec, created_at, updated_at, last_login_at, deleted_at)
             VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, NULL)`
          )
          .run(
            params.uid,
            params.email,
            params.displayName,
            params.photoUrl,
            params.resolvedRole,
            now,
            now,
            now
          );

        this.db
          .prepare(
            `INSERT OR IGNORE INTO user_profiles (user_uid, creator_niche, theme_preference, onboarding_completed, bio, default_language, updated_at)
             VALUES (?, 'Podcast & Edukasi', 'light', 0, '', 'id', ?)`
          )
          .run(params.uid, now);

        this.db
          .prepare(
            `INSERT OR IGNORE INTO user_settings (user_uid, automation_json, updated_at)
             VALUES (?, ?, ?)`
          )
          .run(params.uid, JSON.stringify(INITIAL_STUDIO_STATE.automation), now);

        const defaultPlan: PlanTier =
          params.resolvedRole === 'super_admin' || params.resolvedRole === 'admin'
            ? 'business'
            : 'free';
        this.ensureSubscription(params.uid, defaultPlan);

        // Welcome notification for new user
        this.createNotification({
          userUid: params.uid,
          type: 'system',
          title: 'Selamat Datang di KlipCast AI Studio',
          message:
            'Tempel link YouTube podcast pertamamu untuk mulai menganalisis klip viral, subtitle otomatis, dan konten multi-platform.',
        });
      } else {
        this.db
          .prepare(
            `UPDATE users
             SET email = COALESCE(?, email),
                 display_name = COALESCE(?, display_name),
                 photo_url = COALESCE(?, photo_url),
                 role = ?,
                 last_login_at = ?,
                 updated_at = ?,
                 deleted_at = NULL
             WHERE uid = ?`
          )
          .run(
            params.email,
            params.displayName,
            params.photoUrl,
            params.resolvedRole,
            now,
            now,
            params.uid
          );

        this.db
          .prepare(
            `INSERT OR IGNORE INTO user_profiles (user_uid, creator_niche, theme_preference, onboarding_completed, bio, default_language, updated_at)
             VALUES (?, 'Podcast & Edukasi', 'light', 0, '', 'id', ?)`
          )
          .run(params.uid, now);

        this.db
          .prepare(
            `INSERT OR IGNORE INTO user_settings (user_uid, automation_json, updated_at)
             VALUES (?, ?, ?)`
          )
          .run(params.uid, JSON.stringify(INITIAL_STUDIO_STATE.automation), now);

        this.ensureSubscription(
          params.uid,
          params.resolvedRole === 'super_admin' ? 'business' : 'free'
        );
      }

      return this.db
        .prepare('SELECT * FROM users WHERE uid = ?')
        .get(params.uid) as unknown as DbUserRow;
    });
  }

  ensureSubscription(userUid: string, planTier: PlanTier = 'free'): DbSubscriptionRow {
    const existing = this.db
      .prepare('SELECT * FROM subscriptions WHERE user_uid = ?')
      .get(userUid) as DbSubscriptionRow | undefined;
    if (existing) return existing;

    const defaults = PLAN_DEFAULTS[planTier] ?? PLAN_DEFAULTS.free;
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

    this.db
      .prepare(
        `INSERT INTO subscriptions (
           user_uid, plan_tier, status, billing_provider,
           monthly_ai_limit, monthly_render_limit, monthly_upload_limit,
           max_video_duration_sec, max_export_quality, max_storage_mb, max_projects,
           period_start, period_end, updated_at
         ) VALUES (?, ?, 'active', 'none', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        userUid,
        defaults.planTier,
        defaults.monthlyAiLimit,
        defaults.monthlyRenderLimit,
        defaults.monthlyUploadLimit,
        defaults.maxVideoDurationSec,
        defaults.maxExportQuality,
        defaults.maxStorageMb,
        defaults.maxProjects,
        start,
        end,
        nowIso()
      );

    return this.db
      .prepare('SELECT * FROM subscriptions WHERE user_uid = ?')
      .get(userUid) as unknown as DbSubscriptionRow;
  }

  updateUserPlan(userUid: string, planTier: PlanTier): DbSubscriptionRow {
    const defaults = PLAN_DEFAULTS[planTier];
    this.ensureSubscription(userUid, planTier);
    this.db
      .prepare(
        `UPDATE subscriptions
         SET plan_tier = ?,
             monthly_ai_limit = ?,
             monthly_render_limit = ?,
             monthly_upload_limit = ?,
             max_video_duration_sec = ?,
             max_export_quality = ?,
             max_storage_mb = ?,
             max_projects = ?,
             updated_at = ?
         WHERE user_uid = ?`
      )
      .run(
        defaults.planTier,
        defaults.monthlyAiLimit,
        defaults.monthlyRenderLimit,
        defaults.monthlyUploadLimit,
        defaults.maxVideoDurationSec,
        defaults.maxExportQuality,
        defaults.maxStorageMb,
        defaults.maxProjects,
        nowIso(),
        userUid
      );
    return this.db
      .prepare('SELECT * FROM subscriptions WHERE user_uid = ?')
      .get(userUid) as unknown as DbSubscriptionRow;
  }

  getUserProfileData(uid: string): UserProfileData | null {
    const row = this.db
      .prepare(
        `SELECT u.uid, u.email, u.display_name, u.photo_url, u.role, u.status,
                u.created_at, u.last_login_at,
                COALESCE(p.creator_niche, 'Podcast & Edukasi') AS creator_niche,
                COALESCE(p.theme_preference, 'light') AS theme_preference,
                COALESCE(p.theme_preset, CASE WHEN p.theme_preference = 'dark' THEN 'dark_studio' ELSE 'minimal_light' END) AS theme_preset,
                COALESCE(p.onboarding_completed, 0) AS onboarding_completed,
                COALESCE(s.plan_tier, 'free') AS plan_tier
         FROM users u
         LEFT JOIN user_profiles p ON p.user_uid = u.uid
         LEFT JOIN subscriptions s ON s.user_uid = u.uid
         WHERE u.uid = ? AND u.deleted_at IS NULL`
      )
      .get(uid) as
      | {
          uid: string;
          email: string | null;
          display_name: string | null;
          photo_url: string | null;
          role: UserRole;
          status: AccountStatus;
          created_at: string;
          last_login_at: string;
          creator_niche: string;
          theme_preference: 'light' | 'dark' | 'system';
          theme_preset: 'minimal_light' | 'dark_studio' | 'creator_neon' | 'professional';
          onboarding_completed: number;
          plan_tier: PlanTier;
        }
      | undefined;

    if (!row) return null;
    return {
      uid: row.uid,
      email: row.email,
      displayName: row.display_name,
      photoUrl: row.photo_url,
      role: row.role,
      status: row.status,
      planTier: row.plan_tier,
      themePreference: row.theme_preference,
      themePreset: row.theme_preset,
      onboardingCompleted: Boolean(row.onboarding_completed),
      creatorNiche: row.creator_niche,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
    };
  }

  updateUserProfile(
    uid: string,
    patch: {
      displayName?: string;
      creatorNiche?: string;
      themePreference?: 'light' | 'dark' | 'system';
      themePreset?: 'minimal_light' | 'dark_studio' | 'creator_neon' | 'professional';
      onboardingCompleted?: boolean;
    }
  ): UserProfileData | null {
    const now = nowIso();
    const validPresets = new Set(['minimal_light', 'dark_studio', 'creator_neon', 'professional']);
    this.transaction(() => {
      if (typeof patch.displayName === 'string' && patch.displayName.trim()) {
        this.db
          .prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE uid = ?')
          .run(patch.displayName.trim().slice(0, 80), now, uid);
      }

      const existing = this.db
        .prepare('SELECT * FROM user_profiles WHERE user_uid = ?')
        .get(uid) as
        | {
            creator_niche: string;
            theme_preference: string;
            theme_preset?: string;
            onboarding_completed: number;
          }
        | undefined;

      const nextNiche =
        typeof patch.creatorNiche === 'string'
          ? patch.creatorNiche.trim().slice(0, 80) || 'Podcast & Edukasi'
          : existing?.creator_niche ?? 'Podcast & Edukasi';
      const nextPreset =
        patch.themePreset && validPresets.has(patch.themePreset)
          ? patch.themePreset
          : patch.themePreference === 'dark'
            ? 'dark_studio'
            : patch.themePreference === 'light'
              ? 'minimal_light'
              : existing?.theme_preset ?? 'minimal_light';
      const nextTheme =
        patch.themePreference === 'light' ||
        patch.themePreference === 'dark' ||
        patch.themePreference === 'system'
          ? patch.themePreference
          : nextPreset === 'dark_studio' || nextPreset === 'creator_neon'
            ? 'dark'
            : 'light';
      const nextOnboard =
        typeof patch.onboardingCompleted === 'boolean'
          ? patch.onboardingCompleted
            ? 1
            : 0
          : existing?.onboarding_completed ?? 0;

      this.db
        .prepare(
          `INSERT INTO user_profiles (user_uid, creator_niche, theme_preference, theme_preset, onboarding_completed, bio, default_language, updated_at)
           VALUES (?, ?, ?, ?, ?, '', 'id', ?)
           ON CONFLICT(user_uid) DO UPDATE SET
             creator_niche = excluded.creator_niche,
             theme_preference = excluded.theme_preference,
             theme_preset = excluded.theme_preset,
             onboarding_completed = excluded.onboarding_completed,
             updated_at = excluded.updated_at`
        )
        .run(uid, nextNiche, nextTheme, nextPreset, nextOnboard, now);
    });
    return this.getUserProfileData(uid);
  }

  revokeUserSessions(uid: string, revokedBeforeSec = Math.floor(Date.now() / 1000)): void {
    this.db
      .prepare('UPDATE users SET revoked_before_sec = ?, updated_at = ? WHERE uid = ?')
      .run(revokedBeforeSec, nowIso(), uid);
  }

  setUserStatus(uid: string, status: AccountStatus): boolean {
    const res = this.db
      .prepare('UPDATE users SET status = ?, updated_at = ? WHERE uid = ? AND deleted_at IS NULL')
      .run(status, nowIso(), uid);
    return Number(res.changes) > 0;
  }

  setUserRole(uid: string, role: UserRole): boolean {
    const res = this.db
      .prepare('UPDATE users SET role = ?, updated_at = ? WHERE uid = ? AND deleted_at IS NULL')
      .run(role, nowIso(), uid);
    return Number(res.changes) > 0;
  }

  getUserAutomation(uid: string): BotAutomationConfig {
    const row = this.db
      .prepare('SELECT automation_json FROM user_settings WHERE user_uid = ?')
      .get(uid) as { automation_json: string } | undefined;
    if (!row) {
      return normalizeAutomation(INITIAL_STUDIO_STATE.automation);
    }
    try {
      return normalizeAutomation(JSON.parse(row.automation_json) as Partial<BotAutomationConfig>);
    } catch {
      return normalizeAutomation(INITIAL_STUDIO_STATE.automation);
    }
  }

  saveUserAutomation(uid: string, config: BotAutomationConfig): BotAutomationConfig {
    const normalized = normalizeAutomation(config);
    this.db
      .prepare(
        `INSERT INTO user_settings (user_uid, automation_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_uid) DO UPDATE SET
           automation_json = excluded.automation_json,
           updated_at = excluded.updated_at`
      )
      .run(uid, JSON.stringify(normalized), nowIso());
    return normalized;
  }

  // ---------- EPISODES, CLIPS & DISTRIBUTION LOGS ----------

  listUserEpisodes(uid: string, limit = 100, offset = 0): PodcastEpisode[] {
    const rows = this.db
      .prepare(
        `SELECT payload_json FROM episodes
         WHERE user_uid = ? AND deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(uid, limit, offset) as Array<{ payload_json: string }>;

    const episodes: PodcastEpisode[] = [];
    for (const r of rows) {
      try {
        episodes.push(JSON.parse(r.payload_json) as PodcastEpisode);
      } catch {
        // Skip corrupt row
      }
    }
    return episodes;
  }

  countUserEpisodes(uid: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM episodes WHERE user_uid = ? AND deleted_at IS NULL')
      .get(uid) as { cnt: number };
    return Number(row?.cnt ?? 0);
  }

  getEpisodeForUser(uid: string, episodeId: string): PodcastEpisode | null {
    const row = this.db
      .prepare(
        'SELECT payload_json FROM episodes WHERE id = ? AND user_uid = ? AND deleted_at IS NULL'
      )
      .get(episodeId, uid) as { payload_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.payload_json) as PodcastEpisode;
    } catch {
      return null;
    }
  }

  upsertEpisode(uid: string, episode: PodcastEpisode): PodcastEpisode {
    const now = nowIso();
    const withOwner: PodcastEpisode = { ...episode, userUid: uid };
    this.db
      .prepare(
        `INSERT INTO episodes (
           id, user_uid, video_id, source_url, title, channel_name, thumbnail_url,
           duration_sec, transcript_source, payload_json, created_at, updated_at, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           channel_name = excluded.channel_name,
           thumbnail_url = excluded.thumbnail_url,
           duration_sec = excluded.duration_sec,
           transcript_source = excluded.transcript_source,
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at,
           deleted_at = NULL
         WHERE episodes.user_uid = excluded.user_uid`
      )
      .run(
        withOwner.id,
        uid,
        withOwner.videoId,
        withOwner.sourceUrl,
        withOwner.title,
        withOwner.channelName,
        withOwner.thumbnailUrl,
        Math.max(0, Math.floor(withOwner.durationSec || 0)),
        withOwner.transcriptSource,
        JSON.stringify(withOwner),
        withOwner.createdAt || now,
        now
      );
    return withOwner;
  }

  softDeleteEpisodeForUser(uid: string, episodeId: string): boolean {
    const now = nowIso();
    return this.transaction(() => {
      const res = this.db
        .prepare(
          'UPDATE episodes SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_uid = ? AND deleted_at IS NULL'
        )
        .run(now, now, episodeId, uid);
      if (Number(res.changes) > 0) {
        this.db
          .prepare(
            'UPDATE clips SET deleted_at = ?, updated_at = ? WHERE episode_id = ? AND user_uid = ? AND deleted_at IS NULL'
          )
          .run(now, now, episodeId, uid);
        return true;
      }
      return false;
    });
  }

  listUserClips(uid: string, limit = 300, offset = 0): PodcastClip[] {
    const rows = this.db
      .prepare(
        `SELECT payload_json FROM clips
         WHERE user_uid = ? AND deleted_at IS NULL
         ORDER BY created_at DESC, order_index ASC
         LIMIT ? OFFSET ?`
      )
      .all(uid, limit, offset) as Array<{ payload_json: string }>;

    const clips: PodcastClip[] = [];
    for (const r of rows) {
      try {
        clips.push(JSON.parse(r.payload_json) as PodcastClip);
      } catch {
        // Skip corrupt row
      }
    }
    return clips;
  }

  getClipForUser(uid: string, clipId: string): PodcastClip | null {
    const row = this.db
      .prepare(
        'SELECT payload_json FROM clips WHERE id = ? AND user_uid = ? AND deleted_at IS NULL'
      )
      .get(clipId, uid) as { payload_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.payload_json) as PodcastClip;
    } catch {
      return null;
    }
  }

  getClipByIdInternal(clipId: string): { clip: PodcastClip; userUid: string } | null {
    const row = this.db
      .prepare('SELECT user_uid, payload_json FROM clips WHERE id = ? AND deleted_at IS NULL')
      .get(clipId) as { user_uid: string; payload_json: string } | undefined;
    if (!row) return null;
    try {
      return {
        userUid: row.user_uid,
        clip: JSON.parse(row.payload_json) as PodcastClip,
      };
    } catch {
      return null;
    }
  }

  upsertClip(uid: string, clip: PodcastClip): PodcastClip {
    const now = nowIso();
    const withOwner: PodcastClip = { ...clip, userUid: uid };
    this.db
      .prepare(
        `INSERT INTO clips (
           id, episode_id, user_uid, order_index, title, start_sec, end_sec,
           status, viral_score, scheduled_for, payload_json, created_at, updated_at, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           order_index = excluded.order_index,
           title = excluded.title,
           start_sec = excluded.start_sec,
           end_sec = excluded.end_sec,
           status = excluded.status,
           viral_score = excluded.viral_score,
           scheduled_for = excluded.scheduled_for,
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at,
           deleted_at = NULL
         WHERE clips.user_uid = excluded.user_uid`
      )
      .run(
        withOwner.id,
        withOwner.episodeId,
        uid,
        withOwner.orderIndex ?? 1,
        withOwner.title,
        Math.max(0, Math.floor(withOwner.startSec || 0)),
        Math.max(0, Math.floor(withOwner.endSec || 0)),
        withOwner.status,
        typeof withOwner.viralScore === 'number' ? withOwner.viralScore : null,
        withOwner.scheduledFor ?? null,
        JSON.stringify(withOwner),
        now,
        now
      );
    return withOwner;
  }

  softDeleteClipForUser(uid: string, clipId: string): boolean {
    const now = nowIso();
    const res = this.db
      .prepare(
        'UPDATE clips SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_uid = ? AND deleted_at IS NULL'
      )
      .run(now, now, clipId, uid);
    return Number(res.changes) > 0;
  }

  insertDistributionLog(uid: string, log: DistributionLog): DistributionLog {
    const withOwner: DistributionLog = { ...log, userUid: uid };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO distribution_logs (
           id, user_uid, clip_id, clip_title, episode_title, mode,
           platforms_json, webhook_delivered, webhook_status_code, status, message, timestamp
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        withOwner.id,
        uid,
        withOwner.clipId,
        withOwner.clipTitle,
        withOwner.episodeTitle,
        withOwner.mode,
        JSON.stringify(withOwner.platforms),
        withOwner.webhookDelivered ? 1 : 0,
        withOwner.webhookStatusCode ?? null,
        withOwner.status,
        withOwner.message,
        withOwner.timestamp || nowIso()
      );
    return withOwner;
  }

  listUserDistributionLogs(uid: string, limit = 100, offset = 0): DistributionLog[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM distribution_logs
         WHERE user_uid = ?
         ORDER BY timestamp DESC
         LIMIT ? OFFSET ?`
      )
      .all(uid, limit, offset) as Array<{
      id: string;
      user_uid: string;
      clip_id: string;
      clip_title: string;
      episode_title: string;
      mode: 'auto' | 'manual';
      platforms_json: string;
      webhook_delivered: number;
      webhook_status_code: number | null;
      status: 'success' | 'partial' | 'failed';
      message: string;
      timestamp: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      userUid: r.user_uid,
      clipId: r.clip_id,
      clipTitle: r.clip_title,
      episodeTitle: r.episode_title,
      mode: r.mode,
      platforms: JSON.parse(r.platforms_json) as DistributionLog['platforms'],
      webhookDelivered: Boolean(r.webhook_delivered),
      webhookStatusCode: r.webhook_status_code ?? undefined,
      status: r.status,
      message: r.message,
      timestamp: r.timestamp,
    }));
  }

  // ---------- RENDER JOBS ----------

  upsertRenderJob(job: {
    jobId: string;
    clipId: string;
    userUid: string;
    layout: string;
    quality: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    stage: string;
    progress: number;
    retryCount?: number;
    durationMs?: number | null;
    outputSizeBytes?: number | null;
    errorMessage?: string | null;
    errorCode?: string | null;
    resultJson?: string | null;
    createdAt?: string;
    completedAt?: string | null;
  }): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO render_jobs (
           job_id, clip_id, user_uid, layout, quality, status, stage, progress,
           retry_count, duration_ms, output_size_bytes, error_message, error_code,
           result_json, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           status = excluded.status,
           stage = excluded.stage,
           progress = excluded.progress,
           retry_count = excluded.retry_count,
           duration_ms = COALESCE(excluded.duration_ms, render_jobs.duration_ms),
           output_size_bytes = COALESCE(excluded.output_size_bytes, render_jobs.output_size_bytes),
           error_message = excluded.error_message,
           error_code = excluded.error_code,
           result_json = COALESCE(excluded.result_json, render_jobs.result_json),
           updated_at = excluded.updated_at,
           completed_at = COALESCE(excluded.completed_at, render_jobs.completed_at)`
      )
      .run(
        job.jobId,
        job.clipId,
        job.userUid,
        job.layout,
        job.quality,
        job.status,
        job.stage,
        Math.max(0, Math.min(100, Math.round(job.progress))),
        job.retryCount ?? 0,
        job.durationMs ?? null,
        job.outputSizeBytes ?? null,
        job.errorMessage ?? null,
        job.errorCode ?? null,
        job.resultJson ?? null,
        job.createdAt ?? now,
        now,
        job.completedAt ?? null
      );
  }

  recoverInterruptedRenderJobs(): number {
    const now = nowIso();
    const res = this.db
      .prepare(
        `UPDATE render_jobs
         SET status = 'failed',
             stage = 'Dihentikan karena restart server.',
             error_message = 'Proses render terputus saat server dimulai ulang. Silakan klik Render Ulang.',
             error_code = 'SERVER_RESTARTED',
             updated_at = ?,
             completed_at = ?
         WHERE status = 'running'`
      )
      .run(now, now);
    return Number(res.changes);
  }

  listRenderJobs(params: {
    userUid?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): PersistedRenderJobSummary[] {
    const clauses: string[] = [];
    const args: Array<string | number> = [];

    if (params.userUid) {
      clauses.push('r.user_uid = ?');
      args.push(params.userUid);
    }
    if (params.status) {
      clauses.push('r.status = ?');
      args.push(params.status);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    args.push(params.limit ?? 50, params.offset ?? 0);

    const rows = this.db
      .prepare(
        `SELECT r.*, u.email AS user_email
         FROM render_jobs r
         LEFT JOIN users u ON u.uid = r.user_uid
         ${whereSql}
         ORDER BY r.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...args) as Array<{
      job_id: string;
      clip_id: string;
      user_uid: string;
      user_email: string | null;
      layout: string;
      quality: string;
      status: PersistedRenderJobSummary['status'];
      stage: string;
      progress: number;
      retry_count: number;
      duration_ms: number | null;
      output_size_bytes: number | null;
      error_message: string | null;
      error_code: string | null;
      created_at: string;
      updated_at: string;
      completed_at: string | null;
    }>;

    return rows.map((r) => ({
      jobId: r.job_id,
      clipId: r.clip_id,
      userUid: r.user_uid,
      userEmail: r.user_email,
      layout: r.layout,
      quality: r.quality,
      status: r.status,
      stage: r.stage,
      progress: r.progress,
      retryCount: r.retry_count,
      durationMs: r.duration_ms,
      outputSizeBytes: r.output_size_bytes,
      error: r.error_message,
      errorCode: r.error_code,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      completedAt: r.completed_at,
    }));
  }

  // ---------- UPLOAD JOBS ----------

  recordUploadJob(job: {
    id?: string;
    userUid: string;
    episodeId?: string | null;
    clipId?: string | null;
    kind: 'source_video' | 'youtube_publish';
    status: 'running' | 'completed' | 'failed';
    fileSizeBytes?: number;
    externalUrl?: string | null;
    errorMessage?: string | null;
  }): DbUploadJobRow {
    const id = job.id ?? `upl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO upload_jobs (
           id, user_uid, episode_id, clip_id, kind, status,
           file_size_bytes, external_url, error_message, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           file_size_bytes = excluded.file_size_bytes,
           external_url = COALESCE(excluded.external_url, upload_jobs.external_url),
           error_message = excluded.error_message,
           updated_at = excluded.updated_at`
      )
      .run(
        id,
        job.userUid,
        job.episodeId ?? null,
        job.clipId ?? null,
        job.kind,
        job.status,
        Math.max(0, Math.floor(job.fileSizeBytes ?? 0)),
        job.externalUrl ?? null,
        job.errorMessage ?? null,
        now,
        now
      );
    return this.db
      .prepare('SELECT * FROM upload_jobs WHERE id = ?')
      .get(id) as unknown as DbUploadJobRow;
  }

  listUserUploadJobs(uid: string, limit = 30): DbUploadJobRow[] {
    return this.db
      .prepare('SELECT * FROM upload_jobs WHERE user_uid = ? ORDER BY created_at DESC LIMIT ?')
      .all(uid, limit) as unknown as DbUploadJobRow[];
  }

  // ---------- USAGE RECORDS & API USAGE ----------

  getOrCreateUsageRecord(uid: string, periodYm = getCurrentPeriodYm()): {
    user_uid: string;
    period_ym: string;
    ai_analyses_used: number;
    renders_used: number;
    uploads_used: number;
    storage_bytes_used: number;
    updated_at: string;
  } {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO usage_records (user_uid, period_ym, ai_analyses_used, renders_used, uploads_used, storage_bytes_used, updated_at)
         VALUES (?, ?, 0, 0, 0, 0, ?)`
      )
      .run(uid, periodYm, now);
    return this.db
      .prepare('SELECT * FROM usage_records WHERE user_uid = ? AND period_ym = ?')
      .get(uid, periodYm) as {
      user_uid: string;
      period_ym: string;
      ai_analyses_used: number;
      renders_used: number;
      uploads_used: number;
      storage_bytes_used: number;
      updated_at: string;
    };
  }

  incrementUsageRecord(
    uid: string,
    delta: {
      aiAnalyses?: number;
      renders?: number;
      uploads?: number;
      storageBytesDelta?: number;
    },
    periodYm = getCurrentPeriodYm()
  ): void {
    this.getOrCreateUsageRecord(uid, periodYm);
    this.db
      .prepare(
        `UPDATE usage_records
         SET ai_analyses_used = MAX(0, ai_analyses_used + ?),
             renders_used = MAX(0, renders_used + ?),
             uploads_used = MAX(0, uploads_used + ?),
             storage_bytes_used = MAX(0, storage_bytes_used + ?),
             updated_at = ?
         WHERE user_uid = ? AND period_ym = ?`
      )
      .run(
        delta.aiAnalyses ?? 0,
        delta.renders ?? 0,
        delta.uploads ?? 0,
        delta.storageBytesDelta ?? 0,
        nowIso(),
        uid,
        periodYm
      );
  }

  recordApiUsage(entry: {
    userUid: string;
    operation: string;
    model: string;
    promptTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    cached?: boolean;
  }): void {
    const id = `aiu-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.db
      .prepare(
        `INSERT INTO api_usage (id, user_uid, operation, model, prompt_tokens, output_tokens, estimated_cost_usd, cached, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        entry.userUid,
        entry.operation,
        entry.model,
        Math.max(0, Math.round(entry.promptTokens)),
        Math.max(0, Math.round(entry.outputTokens)),
        Number(Math.max(0, entry.estimatedCostUsd).toFixed(6)),
        entry.cached ? 1 : 0,
        nowIso()
      );
  }

  // ---------- NOTIFICATIONS ----------

  createNotification(params: {
    userUid: string;
    type: AppNotification['type'];
    title: string;
    message: string;
    relatedId?: string | null;
  }): AppNotification {
    const id = `ntf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO notifications (id, user_uid, type, title, message, related_id, is_read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .run(id, params.userUid, params.type, params.title, params.message, params.relatedId ?? null, createdAt);

    return {
      id,
      userUid: params.userUid,
      type: params.type,
      title: params.title,
      message: params.message,
      relatedId: params.relatedId ?? null,
      isRead: false,
      createdAt,
    };
  }

  listUserNotifications(uid: string, limit = 40): AppNotification[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM notifications
         WHERE user_uid = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(uid, limit) as Array<{
      id: string;
      user_uid: string;
      type: AppNotification['type'];
      title: string;
      message: string;
      related_id: string | null;
      is_read: number;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      userUid: r.user_uid,
      type: r.type,
      title: r.title,
      message: r.message,
      relatedId: r.related_id,
      isRead: Boolean(r.is_read),
      createdAt: r.created_at,
    }));
  }

  countUnreadNotifications(uid: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM notifications WHERE user_uid = ? AND is_read = 0')
      .get(uid) as { cnt: number };
    return Number(row?.cnt ?? 0);
  }

  markNotificationRead(uid: string, notificationId: string): boolean {
    const res = this.db
      .prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_uid = ?')
      .run(notificationId, uid);
    return Number(res.changes) > 0;
  }

  markAllNotificationsRead(uid: string): number {
    const res = this.db
      .prepare('UPDATE notifications SET is_read = 1 WHERE user_uid = ? AND is_read = 0')
      .run(uid);
    return Number(res.changes);
  }

  // ---------- AUDIT LOGS ----------

  insertAuditLog(entry: {
    actorUid: string;
    actorEmail: string | null;
    action: string;
    targetType: string;
    targetId?: string | null;
    metadata?: Record<string, unknown>;
    ipAddress?: string | null;
  }): void {
    const id = `aud-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.db
      .prepare(
        `INSERT INTO admin_audit_logs (id, actor_uid, actor_email, action, target_type, target_id, metadata_json, ip_address, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        entry.actorUid,
        entry.actorEmail,
        entry.action,
        entry.targetType,
        entry.targetId ?? null,
        JSON.stringify(entry.metadata ?? {}),
        entry.ipAddress ?? null,
        nowIso()
      );
  }

  listAuditLogs(limit = 100, offset = 0): DbAdminAuditLogRow[] {
    return this.db
      .prepare('SELECT * FROM admin_audit_logs ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as unknown as DbAdminAuditLogRow[];
  }

  // ---------- ADMIN QUERIES ----------

  listUsersForAdmin(params?: { search?: string; limit?: number; offset?: number }) {
    const search = params?.search?.trim().toLowerCase() ?? '';
    const limit = Math.min(100, Math.max(1, params?.limit ?? 50));
    const offset = Math.max(0, params?.offset ?? 0);
    const periodYm = getCurrentPeriodYm();

    const where = search
      ? "WHERE u.deleted_at IS NULL AND (LOWER(COALESCE(u.email, '')) LIKE ? OR LOWER(COALESCE(u.display_name, '')) LIKE ? OR LOWER(u.uid) LIKE ?)"
      : 'WHERE u.deleted_at IS NULL';
    const like = `%${search}%`;
    const args: Array<string | number> = search
      ? [periodYm, like, like, like, limit, offset]
      : [periodYm, limit, offset];

    const rows = this.db
      .prepare(
        `SELECT u.uid, u.email, u.display_name, u.photo_url, u.role, u.status,
                u.created_at, u.last_login_at,
                COALESCE(s.plan_tier, 'free') AS plan_tier,
                COALESCE(ur.ai_analyses_used, 0) AS ai_analyses_used,
                COALESCE(ur.renders_used, 0) AS renders_used,
                (SELECT COUNT(*) FROM episodes e WHERE e.user_uid = u.uid AND e.deleted_at IS NULL) AS episodes_count,
                (SELECT COUNT(*) FROM clips c WHERE c.user_uid = u.uid AND c.deleted_at IS NULL) AS clips_count
         FROM users u
         LEFT JOIN subscriptions s ON s.user_uid = u.uid
         LEFT JOIN usage_records ur ON ur.user_uid = u.uid AND ur.period_ym = ?
         ${where}
         ORDER BY u.last_login_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...args) as Array<{
      uid: string;
      email: string | null;
      display_name: string | null;
      photo_url: string | null;
      role: UserRole;
      status: AccountStatus;
      created_at: string;
      last_login_at: string;
      plan_tier: PlanTier;
      ai_analyses_used: number;
      renders_used: number;
      episodes_count: number;
      clips_count: number;
    }>;

    return rows;
  }

  getAdminMetricsSummary() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const usersTotal = Number(
      (this.db.prepare('SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL').get() as { c: number })?.c ?? 0
    );
    const usersActive7d = Number(
      (
        this.db
          .prepare('SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL AND last_login_at >= ?')
          .get(sevenDaysAgo) as { c: number }
      )?.c ?? 0
    );
    const usersNew7d = Number(
      (
        this.db
          .prepare('SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL AND created_at >= ?')
          .get(sevenDaysAgo) as { c: number }
      )?.c ?? 0
    );
    const usersSuspended = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL AND status = 'suspended'")
          .get() as { c: number }
      )?.c ?? 0
    );

    const totalEpisodes = Number(
      (this.db.prepare('SELECT COUNT(*) AS c FROM episodes WHERE deleted_at IS NULL').get() as { c: number })?.c ?? 0
    );
    const totalClips = Number(
      (this.db.prepare('SELECT COUNT(*) AS c FROM clips WHERE deleted_at IS NULL').get() as { c: number })?.c ?? 0
    );
    const totalUploads = Number(
      (this.db.prepare('SELECT COUNT(*) AS c FROM upload_jobs').get() as { c: number })?.c ?? 0
    );

    const renderRows = this.db
      .prepare('SELECT status, COUNT(*) AS c FROM render_jobs GROUP BY status')
      .all() as Array<{ status: string; c: number }>;
    const renderCounts = { total: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const r of renderRows) {
      const cnt = Number(r.c);
      renderCounts.total += cnt;
      if (r.status === 'running') renderCounts.running = cnt;
      if (r.status === 'completed') renderCounts.completed = cnt;
      if (r.status === 'failed') renderCounts.failed = cnt;
      if (r.status === 'cancelled') renderCounts.cancelled = cnt;
    }

    const aiAgg = this.db
      .prepare(
        `SELECT COUNT(*) AS total_requests,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(estimated_cost_usd), 0) AS total_cost
         FROM api_usage`
      )
      .get() as {
      total_requests: number;
      prompt_tokens: number;
      output_tokens: number;
      total_cost: number;
    };

    return {
      users: {
        total: usersTotal,
        activeLast7Days: usersActive7d,
        newLast7Days: usersNew7d,
        suspended: usersSuspended,
      },
      content: {
        totalEpisodes,
        totalClips,
        totalUploads,
      },
      renders: renderCounts,
      ai: {
        totalRequests: Number(aiAgg?.total_requests ?? 0),
        totalPromptTokens: Number(aiAgg?.prompt_tokens ?? 0),
        totalOutputTokens: Number(aiAgg?.output_tokens ?? 0),
        estimatedCostUsd: Number(Number(aiAgg?.total_cost ?? 0).toFixed(5)),
      },
    };
  }

  getAiUsageBreakdown(limit = 50) {
    const byOperation = this.db
      .prepare(
        `SELECT operation, model,
                COUNT(*) AS requests,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(estimated_cost_usd), 0) AS estimated_cost_usd,
                COALESCE(SUM(cached), 0) AS cached_hits
         FROM api_usage
         GROUP BY operation, model
         ORDER BY requests DESC`
      )
      .all();

    const byUser = this.db
      .prepare(
        `SELECT a.user_uid, u.email, u.display_name,
                COUNT(*) AS requests,
                COALESCE(SUM(a.prompt_tokens + a.output_tokens), 0) AS total_tokens,
                COALESCE(SUM(a.estimated_cost_usd), 0) AS estimated_cost_usd
         FROM api_usage a
         LEFT JOIN users u ON u.uid = a.user_uid
         GROUP BY a.user_uid
         ORDER BY total_tokens DESC
         LIMIT ?`
      )
      .all(limit);

    const recent = this.db
      .prepare(
        `SELECT a.*, u.email
         FROM api_usage a
         LEFT JOIN users u ON u.uid = a.user_uid
         ORDER BY a.created_at DESC
         LIMIT ?`
      )
      .all(limit);

    return { byOperation, byUser, recent };
  }

  // ---------- USER SELF-DATA EXPORT & DELETION ----------

  exportUserData(uid: string) {
    return {
      exportedAt: nowIso(),
      profile: this.getUserProfileData(uid),
      automation: this.getUserAutomation(uid),
      episodes: this.listUserEpisodes(uid, 500, 0),
      clips: this.listUserClips(uid, 1000, 0),
      distributionLogs: this.listUserDistributionLogs(uid, 500, 0),
      renderJobs: this.listRenderJobs({ userUid: uid, limit: 200 }),
      notifications: this.listUserNotifications(uid, 200),
    };
  }

  deleteAllUserContent(uid: string): { deletedEpisodes: number; deletedClips: number } {
    const now = nowIso();
    return this.transaction(() => {
      const epRes = this.db
        .prepare(
          'UPDATE episodes SET deleted_at = ?, updated_at = ? WHERE user_uid = ? AND deleted_at IS NULL'
        )
        .run(now, now, uid);
      const clipRes = this.db
        .prepare(
          'UPDATE clips SET deleted_at = ?, updated_at = ? WHERE user_uid = ? AND deleted_at IS NULL'
        )
        .run(now, now, uid);
      this.db.prepare('DELETE FROM distribution_logs WHERE user_uid = ?').run(uid);
      this.db.prepare('DELETE FROM notifications WHERE user_uid = ?').run(uid);
      return {
        deletedEpisodes: Number(epRes.changes),
        deletedClips: Number(clipRes.changes),
      };
    });
  }

  // ---------- LEGACY JSON -> SQLITE SAFE MIGRATION & BACKUP ----------

  /**
   * Migrates legacy single-file `data/klipcast-store.json` into SQLite cleanly:
   * 1. Creates a timestamped backup in `data/backups/`.
   * 2. Assigns legacy records to `ownerUid` (default: 'legacy_migrated_owner' or super admin UID).
   * 3. Uses an atomic transaction with `INSERT OR IGNORE` (idempotent — safe to re-run).
   * 4. Preserves the original JSON file untouched and verifies inserted row counts.
   */
  migrateLegacyJsonStore(params?: {
    legacyJsonPath?: string;
    ownerUid?: string;
    ownerEmail?: string | null;
  }): MigrationReport {
    const legacyPath =
      params?.legacyJsonPath ?? path.join(this.dataDir, 'klipcast-store.json');
    if (!fs.existsSync(legacyPath)) {
      return {
        migrated: false,
        reason: 'File legacy klipcast-store.json tidak ditemukan.',
        episodesImported: 0,
        clipsImported: 0,
        logsImported: 0,
        verifiedEpisodesCount: 0,
        verifiedClipsCount: 0,
      };
    }

    const migrationKey = `legacy_json_${path.basename(legacyPath)}`;
    const already = this.db
      .prepare('SELECT version FROM schema_migrations WHERE version = ?')
      .get(migrationKey) as { version: string } | undefined;
    if (already) {
      return {
        migrated: false,
        reason: 'Migrasi legacy JSON sudah pernah dijalankan sebelumnya (idempotent).',
        episodesImported: 0,
        clipsImported: 0,
        logsImported: 0,
        verifiedEpisodesCount: Number(
          (this.db.prepare('SELECT COUNT(*) AS c FROM episodes').get() as { c: number })?.c ?? 0
        ),
        verifiedClipsCount: Number(
          (this.db.prepare('SELECT COUNT(*) AS c FROM clips').get() as { c: number })?.c ?? 0
        ),
      };
    }

    const rawContent = fs.readFileSync(legacyPath, 'utf-8');
    let parsed: StudioStoreState;
    try {
      parsed = JSON.parse(rawContent) as StudioStoreState;
    } catch {
      throw new Error('File klipcast-store.json rusak dan tidak dapat diparsing.');
    }

    if (!Array.isArray(parsed.episodes) || !Array.isArray(parsed.clips)) {
      throw new Error('Struktur klipcast-store.json tidak valid.');
    }

    // 1. Create timestamped backup BEFORE touching DB
    const backupDir = path.join(this.dataDir, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `klipcast-store.${stamp}.backup.json`);
    fs.copyFileSync(legacyPath, backupPath);

    const ownerUid = params?.ownerUid ?? 'legacy_owner';
    const ownerEmail = params?.ownerEmail ?? null;

    let episodesImported = 0;
    let clipsImported = 0;
    let logsImported = 0;

    this.transaction(() => {
      this.upsertAuthenticatedUser({
        uid: ownerUid,
        email: ownerEmail,
        displayName: 'Migrated Legacy Workspace',
        photoUrl: null,
        resolvedRole: 'user',
      });

      if (parsed.automation) {
        this.saveUserAutomation(ownerUid, normalizeAutomation(parsed.automation));
      }

      const validEpisodeIds = new Set<string>();
      for (const ep of parsed.episodes) {
        if (!ep?.id) continue;
        validEpisodeIds.add(ep.id);
        this.upsertEpisode(ownerUid, ep);
        episodesImported += 1;
      }

      for (const clip of parsed.clips) {
        if (!clip?.id || !clip?.episodeId || !validEpisodeIds.has(clip.episodeId)) continue;
        this.upsertClip(ownerUid, clip);
        clipsImported += 1;
      }

      for (const log of parsed.distributionLogs ?? []) {
        if (!log?.id) continue;
        this.insertDistributionLog(ownerUid, log);
        logsImported += 1;
      }

      this.db
        .prepare(
          'INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)'
        )
        .run(
          migrationKey,
          `Migrated ${episodesImported} episodes, ${clipsImported} clips, ${logsImported} logs from ${path.basename(legacyPath)}`,
          nowIso()
        );
    });

    const verifiedEpisodesCount = this.countUserEpisodes(ownerUid);
    const verifiedClipsCount = this.listUserClips(ownerUid, 1000, 0).length;

    return {
      migrated: true,
      backupPath,
      episodesImported,
      clipsImported,
      logsImported,
      verifiedEpisodesCount,
      verifiedClipsCount,
    };
  }

  /**
   * Re-assigns legacy_owner episodes/clips to the first verified super_admin who logs in
   * so existing workspace data is seamlessly preserved without loss!
   */
  claimLegacyDataIfPresent(targetUid: string): boolean {
    const legacy = this.db
      .prepare("SELECT uid FROM users WHERE uid = 'legacy_owner' AND deleted_at IS NULL")
      .get() as { uid: string } | undefined;
    if (!legacy || targetUid === 'legacy_owner') return false;

    const legacyCount = this.countUserEpisodes('legacy_owner');
    if (legacyCount === 0) return false;

    this.transaction(() => {
      this.db
        .prepare("UPDATE episodes SET user_uid = ? WHERE user_uid = 'legacy_owner'")
        .run(targetUid);
      this.db
        .prepare("UPDATE clips SET user_uid = ? WHERE user_uid = 'legacy_owner'")
        .run(targetUid);
      this.db
        .prepare("UPDATE distribution_logs SET user_uid = ? WHERE user_uid = 'legacy_owner'")
        .run(targetUid);
      this.db
        .prepare("DELETE FROM users WHERE uid = 'legacy_owner'")
        .run();
    });
    return true;
  }

  createDatabaseBackupSnapshot(): { backupFilePath: string; sizeBytes: number; createdAt: string } {
    const backupDir = path.join(this.dataDir, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFilePath = path.join(backupDir, `klipcast-db-${stamp}.json`);
    const snapshot = {
      createdAt: nowIso(),
      engine: 'node:sqlite',
      users: this.db.prepare('SELECT * FROM users').all(),
      subscriptions: this.db.prepare('SELECT * FROM subscriptions').all(),
      episodes: this.db.prepare('SELECT * FROM episodes').all(),
      clips: this.db.prepare('SELECT * FROM clips').all(),
      renderJobs: this.db.prepare('SELECT * FROM render_jobs').all(),
      distributionLogs: this.db.prepare('SELECT * FROM distribution_logs').all(),
      usageRecords: this.db.prepare('SELECT * FROM usage_records').all(),
      apiUsage: this.db.prepare('SELECT * FROM api_usage').all(),
      adminAuditLogs: this.db.prepare('SELECT * FROM admin_audit_logs').all(),
    };
    const serialized = JSON.stringify(snapshot, null, 2);
    fs.writeFileSync(backupFilePath, serialized, 'utf-8');
    return {
      backupFilePath,
      sizeBytes: Buffer.byteLength(serialized, 'utf-8'),
      createdAt: snapshot.createdAt,
    };
  }

  checkHealth(): boolean {
    try {
      const row = this.db.prepare('SELECT 1 AS ok').get() as { ok: number };
      return row?.ok === 1;
    } catch {
      return false;
    }
  }
}

let defaultDbInstance: KlipCastDatabase | null = null;

export function getDatabase(): KlipCastDatabase {
  if (!defaultDbInstance) {
    defaultDbInstance = new KlipCastDatabase();
    defaultDbInstance.recoverInterruptedRenderJobs();
    try {
      defaultDbInstance.migrateLegacyJsonStore();
    } catch (err) {
      console.error('Legacy JSON migration warning:', err);
    }
  }
  return defaultDbInstance;
}
