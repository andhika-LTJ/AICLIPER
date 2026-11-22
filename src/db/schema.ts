import {
  pgTable,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * AICLIPER Production PostgreSQL Schema (Drizzle ORM)
 * Covers all 19 core production tables for Staged Migration to Google Cloud SQL.
 * Existing authentication (Firebase Auth / YouTube OAuth) stays untouched and maps via users.uid.
 */

export const users = pgTable(
  'users',
  {
    uid: text('uid').primaryKey(),
    email: text('email').notNull().default(''),
    displayName: text('display_name').notNull().default(''),
    avatarUrl: text('avatar_url').notNull().default(''),
    role: text('role').notNull().default('user'),
    planTier: text('plan_tier').notNull().default('free'),
    status: text('status').notNull().default('active'),
    preferencesJson: jsonb('preferences_json').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('idx_pg_users_role').on(t.role), index('idx_pg_users_plan').on(t.planTier)]
);

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    userUid: text('user_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    sourceType: text('source_type').notNull().default('youtube'),
    sourceUrl: text('source_url').notNull().default(''),
    sourceVideoId: text('source_video_id').notNull().default(''),
    channelName: text('channel_name').notNull().default(''),
    durationSec: integer('duration_sec').notNull().default(0),
    thumbnailUrl: text('thumbnail_url').notNull().default(''),
    status: text('status').notNull().default('ready'),
    metadataJson: jsonb('metadata_json').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('idx_pg_projects_user').on(t.userUid, t.updatedAt)]
);

export const sourceAssets = pgTable(
  'source_assets',
  {
    id: text('id').primaryKey(),
    userUid: text('user_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sourceFingerprint: text('source_fingerprint').notNull(),
    storageBackend: text('storage_backend').notNull().default('gcs'),
    gcsUri: text('gcs_uri').notNull().default(''),
    localPath: text('local_path').notNull().default(''),
    mimeType: text('mime_type').notNull().default('video/mp4'),
    sizeBytes: integer('size_bytes').notNull().default(0),
    width: integer('width').notNull().default(0),
    height: integer('height').notNull().default(0),
    fps: doublePrecision('fps').notNull().default(30),
    durationSec: doublePrecision('duration_sec').notNull().default(0),
    audioChannels: integer('audio_channels').notNull().default(2),
    probeMetadataJson: jsonb('probe_metadata_json').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_pg_source_assets_project').on(t.projectId),
    index('idx_pg_source_assets_fingerprint').on(t.sourceFingerprint),
  ]
);

export const transcripts = pgTable(
  'transcripts',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userUid: text('user_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    language: text('language').notNull().default('id'),
    source: text('source').notNull().default('gemini_audio'),
    fullText: text('full_text').notNull().default(''),
    segmentsJson: jsonb('segments_json').$type<Array<Record<string, unknown>>>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('idx_pg_transcripts_project').on(t.projectId)]
);

export const videoAnalyses = pgTable(
  'video_analyses',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userUid: text('user_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    sourceFingerprint: text('source_fingerprint').notNull().default(''),
    pipelineVersion: text('pipeline_version').notNull().default('v3-balanced'),
    summary: text('summary').notNull().default(''),
    topicsJson: jsonb('topics_json').$type<string[]>().notNull().default([]),
    highlightsJson: jsonb('highlights_json').$type<Array<Record<string, unknown>>>().notNull().default([]),
    audioVadJson: jsonb('audio_vad_json').$type<Array<Record<string, unknown>>>().notNull().default([]),
    confidenceScore: doublePrecision('confidence_score').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_pg_video_analyses_project').on(t.projectId),
    index('idx_pg_video_analyses_fp').on(t.sourceFingerprint),
  ]
);

export const clipCandidates = pgTable(
  'clip_candidates',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userUid: text('user_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    hook: text('hook').notNull().default(''),
    startSec: doublePrecision('start_sec').notNull().default(0),
    endSec: doublePrecision('end_sec').notNull().default(45),
    durationSec: doublePrecision('duration_sec').notNull().default(45),
    viralScore: integer('viral_score').notNull().default(0),
    status: text('status').notNull().default('draft'),
    aspectRatio: text('aspect_ratio').notNull().default('9:16'),
    introConfigJson: jsonb('intro_config_json').$type<Record<string, unknown>>().notNull().default({}),
    subtitleConfigJson: jsonb('subtitle_config_json').$type<Record<string, unknown>>().notNull().default({}),
    editorStateJson: jsonb('editor_state_json').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('idx_pg_clips_project').on(t.projectId), index('idx_pg_clips_user').on(t.userUid)]
);

export const speakerProfiles = pgTable(
  'speaker_profiles',
  {
    id: text('id').primaryKey(),
    clipId: text('clip_id')
      .notNull()
      .references(() => clipCandidates.id, { onDelete: 'cascade' }),
    userUid: text('user_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    speakerKey: text('speaker_key').notNull(),
    label: text('label').notNull(),
    colorHex: text('color_hex').notNull().default('#F59E0B'),
    avgCenterX: doublePrecision('avg_center_x').notNull().default(0.5),
    avgCenterY: doublePrecision('avg_center_y').notNull().default(0.4),
    speakingRatio: doublePrecision('speaking_ratio').notNull().default(0),
    avgConfidence: doublePrecision('avg_confidence').notNull().default(0),
    isLocked: boolean('is_locked').notNull().default(false),
    isIgnored: boolean('is_ignored').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_pg_speaker_profiles_clip').on(t.clipId),
    uniqueIndex('uq_pg_speaker_profiles_clip_key').on(t.clipId, t.speakerKey),
  ]
);

export const speakerSegments = pgTable(
  'speaker_segments',
  {
    id: text('id').primaryKey(),
    clipId: text('clip_id')
      .notNull()
      .references(() => clipCandidates.id, { onDelete: 'cascade' }),
    speakerKey: text('speaker_key').notNull(),
    startSec: doublePrecision('start_sec').notNull(),
    endSec: doublePrecision('end_sec').notNull(),
    audioActivityScore: doublePrecision('audio_activity_score').notNull().default(0),
    lipSyncScore: doublePrecision('lip_sync_score').notNull().default(0),
    diarizationScore: doublePrecision('diarization_score').notNull().default(0),
    activeSpeakerScore: doublePrecision('active_speaker_score').notNull().default(0),
    transcriptExcerpt: text('transcript_excerpt').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('idx_pg_speaker_segments_clip').on(t.clipId, t.startSec)]
);

export const faceTracks = pgTable(
  'face_tracks',
  {
    id: text('id').primaryKey(),
    clipId: text('clip_id')
      .notNull()
      .references(() => clipCandidates.id, { onDelete: 'cascade' }),
    speakerKey: text('speaker_key').notNull(),
    timeSec: doublePrecision('time_sec').notNull(),
    x: doublePrecision('x').notNull(),
    y: doublePrecision('y').notNull(),
    width: doublePrecision('width').notNull(),
    height: doublePrecision('height').notNull(),
    mouthActivity: doublePrecision('mouth_activity').notNull().default(0),
    trackingConfidence: doublePrecision('tracking_confidence').notNull().default(0),
    occluded: boolean('occluded').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('idx_pg_face_tracks_clip_time').on(t.clipId, t.timeSec)]
);

export const cameraTrackingSegments = pgTable(
  'camera_tracking_segments',
  {
    id: text('id').primaryKey(),
    clipId: text('clip_id')
      .notNull()
      .references(() => clipCandidates.id, { onDelete: 'cascade' }),
    userUid: text('user_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    startSec: doublePrecision('start_sec').notNull(),
    endSec: doublePrecision('end_sec').notNull(),
    activeSpeakerKey: text('active_speaker_key').notNull().default('none'),
    framingMode: text('framing_mode').notNull().default('speaker_focus'),
    layoutMode: text('layout_mode').notNull().default('active_speaker_full'),
    targetX: doublePrecision('target_x').notNull().default(0.5),
    targetY: doublePrecision('target_y').notNull().default(0.4),
    zoom: doublePrecision('zoom').notNull().default(1.0),
    confidence: doublePrecision('confidence').notNull().default(0),
    reason: text('reason').notNull().default('auto_active_speaker'),
    isManualOverride: boolean('is_manual_override').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('idx_pg_camera_segments_clip').on(t.clipId, t.startSec)]
);

export const cameraTrackingSettings = pgTable(
  'camera_tracking_settings',
  {
    clipId: text('clip_id')
      .primaryKey()
      .references(() => clipCandidates.id, { onDelete: 'cascade' }),
    userUid: text('user_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    autoMode: boolean('auto_mode').notNull().default(true),
    framingMode: text('framing_mode').notNull().default('speaker_focus'),
    multiSpeakerLayout: text('multi_speaker_layout').notNull().default('active_speaker_full'),
    lockedSpeakerKey: text('locked_speaker_key'),
    ignoredSpeakerKeysJson: jsonb('ignored_speaker_keys_json').$type<string[]>().notNull().default([]),
    trackingSensitivity: doublePrecision('tracking_sensitivity').notNull().default(0.65),
    switchingSensitivity: doublePrecision('switching_sensitivity').notNull().default(0.55),
    minShotDurationSec: doublePrecision('min_shot_duration_sec').notNull().default(2.4),
    confidenceThreshold: doublePrecision('confidence_threshold').notNull().default(0.48),
    cooldownSec: doublePrecision('cooldown_sec').notNull().default(1.2),
    manualCropX: doublePrecision('manual_crop_x').notNull().default(0.5),
    manualCropY: doublePrecision('manual_crop_y').notNull().default(0.4),
    manualZoom: doublePrecision('manual_zoom').notNull().default(1.0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('idx_pg_camera_settings_user').on(t.userUid)]
);

export const introTemplates = pgTable(
  'intro_templates',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    category: text('category').notNull(),
    description: text('description').notNull().default(''),
    durationSec: doublePrecision('duration_sec').notNull().default(2.0),
    isGlobal: boolean('is_global').notNull().default(true),
    configJson: jsonb('config_json').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('uq_pg_intro_templates_slug').on(t.slug), index('idx_pg_intro_templates_cat').on(t.category)]
);

export const userIntroTemplates = pgTable(
  'user_intro_templates',
  {
    id: text('id').primaryKey(),
    userUid: text('user_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    baseTemplateId: text('base_template_id'),
    name: text('name').notNull(),
    category: text('category').notNull().default('Viral Hook'),
    description: text('description').notNull().default(''),
    durationSec: doublePrecision('duration_sec').notNull().default(2.0),
    currentVersion: integer('current_version').notNull().default(1),
    configJson: jsonb('config_json').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('idx_pg_user_intro_templates_user').on(t.userUid, t.updatedAt)]
);

export const introTemplateVersions = pgTable(
  'intro_template_versions',
  {
    id: text('id').primaryKey(),
    templateId: text('template_id')
      .notNull()
      .references(() => userIntroTemplates.id, { onDelete: 'cascade' }),
    userUid: text('user_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    changeNote: text('change_note').notNull().default(''),
    configJson: jsonb('config_json').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_pg_intro_versions_template').on(t.templateId, t.versionNumber),
    uniqueIndex('uq_pg_intro_versions_num').on(t.templateId, t.versionNumber),
  ]
);

export const renderJobs = pgTable(
  'render_jobs',
  {
    id: text('id').primaryKey(),
    userUid: text('user_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().default(''),
    clipId: text('clip_id').notNull().default(''),
    status: text('status').notNull().default('queued'),
    progress: integer('progress').notNull().default(0),
    renderProfile: text('render_profile').notNull().default('balanced_1080p'),
    sourceFingerprint: text('source_fingerprint').notNull().default(''),
    renderFingerprint: text('render_fingerprint').notNull().default(''),
    cloudTaskName: text('cloud_task_name').notNull().default(''),
    cloudRunExecution: text('cloud_run_execution').notNull().default(''),
    payloadJson: jsonb('payload_json').$type<Record<string, unknown>>().notNull().default({}),
    resultJson: jsonb('result_json').$type<Record<string, unknown>>(),
    errorMessage: text('error_message').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_pg_render_jobs_user').on(t.userUid, t.createdAt),
    index('idx_pg_render_jobs_fp').on(t.renderFingerprint),
  ]
);

export const renderAssets = pgTable(
  'render_assets',
  {
    id: text('id').primaryKey(),
    userUid: text('user_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    clipId: text('clip_id').notNull().default(''),
    renderJobId: text('render_job_id').references(() => renderJobs.id, { onDelete: 'set null' }),
    sourceFingerprint: text('source_fingerprint').notNull(),
    renderFingerprint: text('render_fingerprint').notNull(),
    renderProfile: text('render_profile').notNull().default('balanced_1080p'),
    storageBackend: text('storage_backend').notNull().default('local'),
    gcsUri: text('gcs_uri').notNull().default(''),
    localPath: text('local_path').notNull().default(''),
    sizeBytes: integer('size_bytes').notNull().default(0),
    durationSec: doublePrecision('duration_sec').notNull().default(0),
    width: integer('width').notNull().default(1080),
    height: integer('height').notNull().default(1920),
    pipelineVersion: text('pipeline_version').notNull().default('v3-balanced'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('uq_pg_render_assets_fp').on(t.userUid, t.renderFingerprint),
    index('idx_pg_render_assets_clip').on(t.clipId),
  ]
);

export const jobEvents = pgTable(
  'job_events',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    jobType: text('job_type').notNull().default('render'),
    userUid: text('user_uid').notNull().default(''),
    stage: text('stage').notNull(),
    status: text('status').notNull(),
    message: text('message').notNull().default(''),
    durationMs: integer('duration_ms').notNull().default(0),
    metadataJson: jsonb('metadata_json').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('idx_pg_job_events_job').on(t.jobId, t.createdAt)]
);

export const performanceMetrics = pgTable(
  'performance_metrics',
  {
    id: text('id').primaryKey(),
    userUid: text('user_uid').notNull().default(''),
    category: text('category').notNull(), // 'ai_analysis' | 'active_speaker' | 'intro_compile' | 'ffmpeg_render' | 'storage'
    operation: text('operation').notNull(),
    durationMs: integer('duration_ms').notNull().default(0),
    success: boolean('success').notNull().default(true),
    cacheHit: boolean('cache_hit').notNull().default(false),
    metadataJson: jsonb('metadata_json').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('idx_pg_perf_metrics_cat').on(t.category, t.createdAt)]
);

export const usageRecords = pgTable(
  'usage_records',
  {
    id: text('id').primaryKey(),
    userUid: text('user_uid')
      .notNull()
      .references(() => users.uid, { onDelete: 'cascade' }),
    actionType: text('action_type').notNull(),
    units: integer('units').notNull().default(1),
    periodMonth: text('period_month').notNull(),
    metadataJson: jsonb('metadata_json').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('idx_pg_usage_records_user_month').on(t.userUid, t.periodMonth, t.actionType)]
);
