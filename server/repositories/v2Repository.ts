import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AdvisorMessage,
  AnalyticsSnapshot,
  BillingRecord,
  ContentGenerationRecord,
  ContentStudioCustomParams,
  ContentGenerationResult,
  EditingProjectData,
  PlanTier,
  SocialPlatform,
  StudioTemplate,
  StudioTemplateCategory,
  SystemSettingsData,
  WorkspaceRecord,
} from '../../src/types/clipper.ts';
import type { KlipCastDatabase } from '../db.ts';
import { createDefaultSystemSettings } from '../services/paymentProvider.ts';

function nowIso(): string {
  return new Date().toISOString();
}

function makeSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return `${base || 'workspace'}-${crypto.randomBytes(2).toString('hex')}`;
}

export class V2Repository {
  private readonly appDb: KlipCastDatabase;
  private readonly db: DatabaseSync;

  constructor(appDb: KlipCastDatabase) {
    this.appDb = appDb;
    this.db = appDb.getRawDb();
  }

  // ---------- WORKSPACES ----------

  ensureDefaultWorkspace(userUid: string, displayName?: string | null): WorkspaceRecord {
    const existing = this.listUserWorkspaces(userUid);
    if (existing.length > 0) return existing[0];

    const label = displayName?.trim()
      ? `Studio ${displayName.trim().slice(0, 28)}`
      : 'Workspace Utama';
    return this.createWorkspace({
      ownerUid: userUid,
      name: label,
      description: 'Ruang kerja utama produksi klip, subtitle, dan distribusi konten.',
    });
  }

  createWorkspace(params: {
    ownerUid: string;
    name: string;
    description?: string;
  }): WorkspaceRecord {
    const id = `ws-${crypto.randomUUID()}`;
    const slug = makeSlug(params.name);
    const now = nowIso();
    this.appDb.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO workspaces (id, owner_uid, name, slug, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          params.ownerUid,
          params.name.trim().slice(0, 64),
          slug,
          (params.description ?? '').trim().slice(0, 240),
          now,
          now
        );

      this.db
        .prepare(
          `INSERT OR IGNORE INTO workspace_members (workspace_id, user_uid, role, joined_at)
           VALUES (?, ?, 'owner', ?)`
        )
        .run(id, params.ownerUid, now);
    });

    return {
      id,
      ownerUid: params.ownerUid,
      name: params.name.trim().slice(0, 64),
      slug,
      description: (params.description ?? '').trim().slice(0, 240),
      memberCount: 1,
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    };
  }

  listUserWorkspaces(userUid: string): WorkspaceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT w.id, w.owner_uid, w.name, w.slug, w.description, w.created_at, w.updated_at,
                wm.role,
                (SELECT COUNT(*) FROM workspace_members m2 WHERE m2.workspace_id = w.id) AS member_count
         FROM workspaces w
         JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_uid = ?
         ORDER BY w.created_at ASC`
      )
      .all(userUid) as Array<{
      id: string;
      owner_uid: string;
      name: string;
      slug: string;
      description: string;
      created_at: string;
      updated_at: string;
      role: 'owner' | 'editor' | 'viewer';
      member_count: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      ownerUid: r.owner_uid,
      name: r.name,
      slug: r.slug,
      description: r.description,
      role: r.role,
      memberCount: Number(r.member_count ?? 1),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  listAllWorkspacesAdmin(limit = 50): Array<WorkspaceRecord & { ownerEmail: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT w.id, w.owner_uid, w.name, w.slug, w.description, w.created_at, w.updated_at,
                u.email AS owner_email,
                (SELECT COUNT(*) FROM workspace_members m2 WHERE m2.workspace_id = w.id) AS member_count,
                (SELECT COUNT(*) FROM editing_projects ep WHERE ep.workspace_id = w.id) AS project_count
         FROM workspaces w
         LEFT JOIN users u ON u.uid = w.owner_uid
         ORDER BY w.created_at DESC
         LIMIT ?`
      )
      .all(limit) as Array<{
      id: string;
      owner_uid: string;
      name: string;
      slug: string;
      description: string;
      created_at: string;
      updated_at: string;
      owner_email: string | null;
      member_count: number;
      project_count: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      ownerUid: r.owner_uid,
      ownerEmail: r.owner_email,
      name: r.name,
      slug: r.slug,
      description: r.description,
      memberCount: Number(r.member_count ?? 1),
      projectCount: Number(r.project_count ?? 0),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  // ---------- SMART VIDEO EDITOR PROJECTS ----------

  getEditingProject(userUid: string, clipId: string): EditingProjectData | null {
    const row = this.db
      .prepare(
        `SELECT * FROM editing_projects WHERE user_uid = ? AND clip_id = ? LIMIT 1`
      )
      .get(userUid, clipId) as
      | {
          id: string;
          clip_id: string;
          user_uid: string;
          workspace_id: string | null;
          title: string;
          duration_sec: number;
          zoom_level: number;
          safe_area_enabled: number;
          timeline_json: string;
          export_preset_json: string;
          version: number;
          updated_at: string;
        }
      | undefined;

    if (!row) return null;
    try {
      return {
        id: row.id,
        clipId: row.clip_id,
        userUid: row.user_uid,
        workspaceId: row.workspace_id,
        title: row.title,
        durationSec: Number(row.duration_sec),
        zoomLevel: Number(row.zoom_level),
        safeAreaEnabled: Boolean(row.safe_area_enabled),
        elements: JSON.parse(row.timeline_json),
        exportPreset: JSON.parse(row.export_preset_json),
        version: Number(row.version),
        updatedAt: row.updated_at,
      };
    } catch {
      return null;
    }
  }

  upsertEditingProject(project: EditingProjectData): EditingProjectData {
    const now = nowIso();
    const existing = this.getEditingProject(project.userUid, project.clipId);
    const id = existing?.id ?? project.id ?? `edproj-${crypto.randomUUID()}`;
    const nextVersion = existing ? existing.version + 1 : 1;

    this.db
      .prepare(
        `INSERT INTO editing_projects (
           id, clip_id, user_uid, workspace_id, title, duration_sec, zoom_level,
           safe_area_enabled, timeline_json, export_preset_json, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(clip_id, user_uid) DO UPDATE SET
           title = excluded.title,
           duration_sec = excluded.duration_sec,
           zoom_level = excluded.zoom_level,
           safe_area_enabled = excluded.safe_area_enabled,
           timeline_json = excluded.timeline_json,
           export_preset_json = excluded.export_preset_json,
           version = excluded.version,
           updated_at = excluded.updated_at`
      )
      .run(
        id,
        project.clipId,
        project.userUid,
        project.workspaceId ?? null,
        project.title.slice(0, 160),
        project.durationSec,
        project.zoomLevel,
        project.safeAreaEnabled ? 1 : 0,
        JSON.stringify(project.elements),
        JSON.stringify(project.exportPreset),
        nextVersion,
        now,
        now
      );

    return {
      ...project,
      id,
      version: nextVersion,
      updatedAt: now,
    };
  }

  // ---------- TEMPLATE LIBRARY ----------

  listTemplates(userUid: string, category?: StudioTemplateCategory): StudioTemplate[] {
    const rows = category
      ? (this.db
          .prepare(
            `SELECT * FROM templates
             WHERE (user_uid = ? OR is_public = 1) AND category = ?
             ORDER BY created_at DESC LIMIT 80`
          )
          .all(userUid, category) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `SELECT * FROM templates
             WHERE user_uid = ? OR is_public = 1
             ORDER BY created_at DESC LIMIT 80`
          )
          .all(userUid) as Array<Record<string, unknown>>);

    return rows.map((r) => ({
      id: String(r.id),
      userUid: String(r.user_uid),
      workspaceId: r.workspace_id ? String(r.workspace_id) : null,
      name: String(r.name),
      category: String(r.category) as StudioTemplateCategory,
      description: String(r.description ?? ''),
      isPublic: Boolean(r.is_public),
      config: JSON.parse(String(r.config_json ?? '{}')),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  createTemplate(params: {
    userUid: string;
    workspaceId?: string | null;
    name: string;
    category: StudioTemplateCategory;
    description: string;
    isPublic: boolean;
    config: Record<string, unknown>;
  }): StudioTemplate {
    const id = `tpl-${crypto.randomUUID()}`;
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO templates (id, user_uid, workspace_id, name, category, description, is_public, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.userUid,
        params.workspaceId ?? null,
        params.name.trim().slice(0, 80),
        params.category,
        params.description.trim().slice(0, 240),
        params.isPublic ? 1 : 0,
        JSON.stringify(params.config),
        now,
        now
      );

    return {
      id,
      userUid: params.userUid,
      workspaceId: params.workspaceId ?? null,
      name: params.name.trim().slice(0, 80),
      category: params.category,
      description: params.description.trim().slice(0, 240),
      isPublic: params.isPublic,
      config: params.config,
      createdAt: now,
      updatedAt: now,
    };
  }

  deleteTemplate(userUid: string, templateId: string): boolean {
    const res = this.db
      .prepare('DELETE FROM templates WHERE id = ? AND user_uid = ?')
      .run(templateId, userUid);
    return Number(res.changes) > 0;
  }

  // ---------- AI CONTENT STUDIO GENERATIONS ----------

  insertContentGeneration(params: {
    userUid: string;
    episodeId?: string | null;
    clipId?: string | null;
    params: ContentStudioCustomParams;
    output: ContentGenerationResult;
    modelUsed: string;
  }): ContentGenerationRecord {
    const id = `cg-${crypto.randomUUID()}`;
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO content_generations (id, user_uid, episode_id, clip_id, kind, params_json, output_json, model_used, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.userUid,
        params.episodeId ?? null,
        params.clipId ?? null,
        params.params.kind,
        JSON.stringify(params.params),
        JSON.stringify(params.output),
        params.modelUsed,
        now
      );

    return {
      id,
      userUid: params.userUid,
      episodeId: params.episodeId ?? null,
      clipId: params.clipId ?? null,
      kind: params.params.kind,
      params: params.params,
      output: params.output,
      modelUsed: params.modelUsed,
      createdAt: now,
    };
  }

  listContentGenerations(userUid: string, limit = 30): ContentGenerationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM content_generations
         WHERE user_uid = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(userUid, limit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      userUid: String(r.user_uid),
      episodeId: r.episode_id ? String(r.episode_id) : null,
      clipId: r.clip_id ? String(r.clip_id) : null,
      kind: String(r.kind) as ContentStudioCustomParams['kind'],
      params: JSON.parse(String(r.params_json)),
      output: JSON.parse(String(r.output_json)),
      modelUsed: String(r.model_used),
      createdAt: String(r.created_at),
    }));
  }

  deleteContentGeneration(userUid: string, generationId: string): boolean {
    const res = this.db
      .prepare('DELETE FROM content_generations WHERE id = ? AND user_uid = ?')
      .run(generationId, userUid);
    return Number(res.changes) > 0;
  }

  // ---------- PERSISTENT AI CONTENT ADVISOR ----------

  listAdvisorMessages(userUid: string, episodeId: string, limit = 50): AdvisorMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM ai_advisor_messages
         WHERE user_uid = ? AND episode_id = ?
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(userUid, episodeId, limit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      userUid: String(r.user_uid),
      episodeId: String(r.episode_id),
      role: String(r.role) as 'user' | 'assistant',
      content: String(r.content),
      modelUsed: r.model_used ? String(r.model_used) : null,
      createdAt: String(r.created_at),
    }));
  }

  appendAdvisorMessage(params: {
    userUid: string;
    episodeId: string;
    role: 'user' | 'assistant';
    content: string;
    modelUsed?: string | null;
  }): AdvisorMessage {
    const id = `adv-${crypto.randomUUID()}`;
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO ai_advisor_messages (id, user_uid, episode_id, role, content, model_used, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.userUid,
        params.episodeId,
        params.role,
        params.content,
        params.modelUsed ?? null,
        now
      );

    return {
      id,
      userUid: params.userUid,
      episodeId: params.episodeId,
      role: params.role,
      content: params.content,
      modelUsed: params.modelUsed ?? null,
      createdAt: now,
    };
  }

  clearAdvisorMessages(userUid: string, episodeId: string): number {
    const res = this.db
      .prepare('DELETE FROM ai_advisor_messages WHERE user_uid = ? AND episode_id = ?')
      .run(userUid, episodeId);
    return Number(res.changes);
  }

  // ---------- ANALYTICS SNAPSHOTS ----------

  upsertAnalyticsSnapshot(params: {
    userUid: string;
    clipId: string;
    platform: SocialPlatform;
    externalVideoId?: string | null;
    source: 'youtube_api' | 'internal_db';
    views: number;
    likes: number;
    comments: number;
    shares?: number;
  }): AnalyticsSnapshot {
    const id = `an-${crypto.randomUUID()}`;
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO analytics_snapshots (
           id, user_uid, clip_id, platform, external_video_id, source, views, likes, comments, shares, last_synced_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_uid, clip_id, platform) DO UPDATE SET
           external_video_id = excluded.external_video_id,
           source = excluded.source,
           views = excluded.views,
           likes = excluded.likes,
           comments = excluded.comments,
           shares = excluded.shares,
           last_synced_at = excluded.last_synced_at`
      )
      .run(
        id,
        params.userUid,
        params.clipId,
        params.platform,
        params.externalVideoId ?? null,
        params.source,
        Math.max(0, Math.round(params.views)),
        Math.max(0, Math.round(params.likes)),
        Math.max(0, Math.round(params.comments)),
        Math.max(0, Math.round(params.shares ?? 0)),
        now
      );

    return {
      id,
      userUid: params.userUid,
      clipId: params.clipId,
      platform: params.platform,
      externalVideoId: params.externalVideoId ?? null,
      source: params.source,
      views: Math.max(0, Math.round(params.views)),
      likes: Math.max(0, Math.round(params.likes)),
      comments: Math.max(0, Math.round(params.comments)),
      shares: Math.max(0, Math.round(params.shares ?? 0)),
      lastSyncedAt: now,
    };
  }

  listAnalyticsSnapshots(userUid: string): AnalyticsSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT a.*, c.title AS clip_title
         FROM analytics_snapshots a
         LEFT JOIN clips c ON c.id = a.clip_id
         WHERE a.user_uid = ?
         ORDER BY a.last_synced_at DESC
         LIMIT 100`
      )
      .all(userUid) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      userUid: String(r.user_uid),
      clipId: String(r.clip_id),
      clipTitle: r.clip_title ? String(r.clip_title) : undefined,
      platform: String(r.platform) as SocialPlatform,
      externalVideoId: r.external_video_id ? String(r.external_video_id) : null,
      source: String(r.source) as 'youtube_api' | 'internal_db',
      views: Number(r.views ?? 0),
      likes: Number(r.likes ?? 0),
      comments: Number(r.comments ?? 0),
      shares: Number(r.shares ?? 0),
      lastSyncedAt: String(r.last_synced_at),
    }));
  }

  // ---------- SYSTEM SETTINGS & CONFIGURABLE PLANS ----------

  getSystemSettings(): SystemSettingsData {
    const defaults = createDefaultSystemSettings();
    const row = this.db
      .prepare('SELECT value_json, updated_at FROM system_settings WHERE key = ?')
      .get('platform_config') as { value_json: string; updated_at: string } | undefined;

    if (!row) return defaults;
    try {
      const parsed = JSON.parse(row.value_json) as Partial<SystemSettingsData>;
      return {
        defaultAiModel: parsed.defaultAiModel || defaults.defaultAiModel,
        fallbackAiModel: parsed.fallbackAiModel || defaults.fallbackAiModel,
        maintenanceMode: Boolean(parsed.maintenanceMode),
        allowNewRegistrations:
          typeof parsed.allowNewRegistrations === 'boolean'
            ? parsed.allowNewRegistrations
            : defaults.allowNewRegistrations,
        defaultThemePreset: parsed.defaultThemePreset || defaults.defaultThemePreset,
        plans: {
          ...defaults.plans,
          ...(parsed.plans ?? {}),
        },
        updatedAt: row.updated_at,
      };
    } catch {
      return defaults;
    }
  }

  updateSystemSettings(
    patch: Partial<SystemSettingsData>,
    actorUid: string
  ): SystemSettingsData {
    const current = this.getSystemSettings();
    const next: SystemSettingsData = {
      ...current,
      ...patch,
      plans: patch.plans ? { ...current.plans, ...patch.plans } : current.plans,
      updatedAt: nowIso(),
    };

    this.db
      .prepare(
        `INSERT INTO system_settings (key, value_json, updated_by, updated_at)
         VALUES ('platform_config', ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(next), actorUid, next.updatedAt);

    return next;
  }

  // ---------- BILLING RECORDS ----------

  insertBillingRecord(params: {
    userUid: string;
    planTier: PlanTier;
    amountIdr: number;
    provider?: string;
    status?: BillingRecord['status'];
    referenceCode?: string | null;
    notes?: string | null;
  }): BillingRecord {
    const id = `bill-${crypto.randomUUID()}`;
    const now = nowIso();
    const provider = params.provider ?? 'manual_admin';
    const status = params.status ?? 'recorded_manual';

    this.db
      .prepare(
        `INSERT INTO billing_records (id, user_uid, plan_tier, amount_idr, currency, provider, status, reference_code, notes, created_at)
         VALUES (?, ?, ?, ?, 'IDR', ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.userUid,
        params.planTier,
        Math.max(0, Math.round(params.amountIdr)),
        provider,
        status,
        params.referenceCode ?? null,
        params.notes ?? null,
        now
      );

    return {
      id,
      userUid: params.userUid,
      planTier: params.planTier,
      amountIdr: Math.max(0, Math.round(params.amountIdr)),
      currency: 'IDR',
      provider,
      status,
      referenceCode: params.referenceCode ?? null,
      notes: params.notes ?? null,
      createdAt: now,
    };
  }

  listUserBillingRecords(userUid: string, limit = 25): BillingRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM billing_records
         WHERE user_uid = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(userUid, limit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      userUid: String(r.user_uid),
      planTier: String(r.plan_tier) as PlanTier,
      amountIdr: Number(r.amount_idr ?? 0),
      currency: String(r.currency ?? 'IDR'),
      provider: String(r.provider ?? 'manual_admin'),
      status: String(r.status) as BillingRecord['status'],
      referenceCode: r.reference_code ? String(r.reference_code) : null,
      notes: r.notes ? String(r.notes) : null,
      createdAt: String(r.created_at),
    }));
  }
}
