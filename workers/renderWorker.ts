/**
 * AICLIPER Fase 0B — Standalone Cloud Run Job Video Render Worker
 *
 * Executed inside Google Cloud Run Jobs containers (and callable programmatically in tests):
 *   1. Reads & validates `AICLIPER_RENDER_JOB_ID` (verifying job, user ownership, clip & episode in DB).
 *   2. Enforces idempotency & atomic worker claim locking (prevents duplicate execution & double quota charging).
 *   3. Hydrates source video from GCS into an isolated temporary working dir when not present locally.
 *   4. Reuses the EXISTING `renderClipMp4()` pipeline in `server/videoClipper.ts` (zero duplicate FFmpeg pipeline!).
 *   5. Validates rendered output via FFprobe (width, height, duration, codec, size, audio status).
 *   6. Uploads verified MP4 to GCS (strictly enforced in production), records `render_assets` & clip metadata.
 *   7. Consumes user quota AT MOST ONCE via atomic `markRenderJobQuotaConsumed()` guard.
 *   8. Transitions job lifecycle: queued/dispatching -> running -> uploading -> completed | failed | cancelled.
 *   9. Records structured JSON logs, `job_events`, and `performance_metrics` (startup, render, upload, total).
 *  10. Always cleans up temporary working files in `finally`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  BalancedRenderProfile,
  CameraTrackingSettings,
  ClipOverlayStyle,
  ClipRenderLayout,
  ClipRenderQuality,
  IntroTemplateDefinition,
  PodcastClip,
} from '../src/types/clipper.ts';
import { getDatabase, type KlipCastDatabase } from '../server/db.ts';
import { V3Repository } from '../server/repositories/v3Repository.ts';
import {
  downloadMediaToLocalPath,
  uploadLocalFileToStorage,
  type GcsClientAdapter,
  type GcsConfig,
} from '../server/services/gcsStorageService.ts';
import { PgRenderJobStore } from '../server/services/pgJobStore.ts';
import { consumeQuota } from '../server/quotaService.ts';
import { logStructuredEvent, redactSensitiveString } from '../server/services/structuredLogger.ts';
import {
  getUploadedVideoPath,
  getUploadTargetPath,
  probeVideoMeta,
  renderClipMp4,
} from '../server/videoClipper.ts';
import { closePgPool } from '../src/db/index.ts';

type RenderClipResult = Awaited<ReturnType<typeof renderClipMp4>>;

export interface RenderWorkerFinalizeInput {
  renderJobId: string;
  userUid: string;
  clipId: string;
  renderProfile: BalancedRenderProfile;
  renderFingerprint: string;
  sourceFingerprint: string;
  localOutputPath: string;
  width: number;
  height: number;
  durationSec: number;
  db: KlipCastDatabase;
  gcsConfigOverride?: Partial<GcsConfig>;
  gcsAdapter?: GcsClientAdapter;
}

/**
 * Uploads final rendered MP4 to GCS (or dev local fallback) and persists `render_assets`
 * for fingerprint reuse. Kept backward-compatible with Fase 0A callers.
 */
export async function finalizeRenderWorkerOutput(input: RenderWorkerFinalizeInput): Promise<{
  storageBackend: 'gcs' | 'local';
  gcsUri: string;
  localPath: string;
  sizeBytes: number;
  uploadDurationMs: number;
}> {
  const uploadStart = Date.now();
  const repo = new V3Repository(input.db);
  const stored = await uploadLocalFileToStorage({
    localFilePath: input.localOutputPath,
    userUid: input.userUid,
    projectId: input.clipId,
    category: 'renders',
    filename: `${input.clipId}_${input.renderFingerprint.slice(0, 12)}.mp4`,
    contentType: 'video/mp4',
    configOverride: input.gcsConfigOverride,
    gcsAdapter: input.gcsAdapter,
  });
  const uploadDurationMs = Date.now() - uploadStart;

  await repo.upsertRenderAsset({
    userUid: input.userUid,
    clipId: input.clipId,
    renderJobId: input.renderJobId,
    sourceFingerprint: input.sourceFingerprint,
    renderFingerprint: input.renderFingerprint,
    renderProfile: input.renderProfile,
    storageBackend: stored.backend,
    gcsUri: stored.gcsUri,
    localPath: stored.localPath,
    sizeBytes: stored.sizeBytes,
    durationSec: input.durationSec,
    width: input.width,
    height: input.height,
  });

  await repo.recordPerformanceMetric({
    userUid: input.userUid,
    category: 'render',
    operation: 'gcs_upload',
    durationMs: uploadDurationMs,
    success: true,
    cacheHit: false,
    metadata: {
      renderJobId: input.renderJobId,
      clipId: input.clipId,
      backend: stored.backend,
      sizeBytes: stored.sizeBytes,
      resumableUsed: stored.resumableUsed ?? false,
    },
  });

  return {
    storageBackend: stored.backend,
    gcsUri: stored.gcsUri,
    localPath: stored.localPath,
    sizeBytes: stored.sizeBytes,
    uploadDurationMs,
  };
}

export interface ExecuteRenderWorkerOptions {
  renderJobId?: string;
  expectedUserUid?: string;
  expectedClipId?: string;
  executionName?: string;
  db?: KlipCastDatabase;
  pgJobStore?: PgRenderJobStore;
  gcsConfigOverride?: Partial<GcsConfig>;
  gcsAdapter?: GcsClientAdapter;
  renderClipFn?: typeof renderClipMp4;
  probeVideoFn?: typeof probeVideoMeta;
  persistJobCompletionFn?: (params: {
    jobId: string;
    resultPayload: Record<string, unknown>;
  }) => Promise<void> | void;
  correlationId?: string;
  staleLockTtlSec?: number;
  signal?: AbortSignal;
}

export interface ExecuteRenderWorkerResult {
  status: 'completed' | 'failed' | 'cancelled' | 'skipped_completed' | 'skipped_locked';
  jobId: string;
  correlationId?: string;
  clipId?: string;
  userUid?: string;
  skipped: boolean;
  retryCount: number;
  recoveredStaleLock?: boolean;
  preservedOutputGcsUri?: string;
  errorCode?: string;
  errorMessage?: string;
  failedStage?: string;
  output?: {
    storageBackend: 'gcs' | 'local';
    gcsUri: string;
    localPath: string;
    sizeBytes: number;
    width: number;
    height: number;
    durationSec: number;
    videoCodec: string;
    audioCodec: string | null;
    audioChannels: number;
    renderProfile: BalancedRenderProfile;
    quality: ClipRenderQuality;
    upscalePrevented: boolean;
    quotaCharged: boolean;
  };
  timings?: {
    startupMs: number;
    sourceDownloadMs: number;
    renderMs: number;
    ffprobeMs: number;
    uploadMs: number;
    totalMs: number;
  };
}

export async function executeRenderWorkerJob(
  options: ExecuteRenderWorkerOptions = {}
): Promise<ExecuteRenderWorkerResult> {
  const totalStart = Date.now();
  const startedAtIso = new Date(totalStart).toISOString();
  const renderJobId = (options.renderJobId ?? process.env.AICLIPER_RENDER_JOB_ID ?? '').trim();
  const envUserUid = (options.expectedUserUid ?? process.env.AICLIPER_USER_UID ?? '').trim();
  const envClipId = (options.expectedClipId ?? process.env.AICLIPER_CLIP_ID ?? '').trim();
  const executionName = (
    options.executionName ??
    process.env.CLOUD_RUN_EXECUTION ??
    `worker-${crypto.randomBytes(4).toString('hex')}`
  ).trim();
  const correlationId = (
    options.correlationId ??
    process.env.AICLIPER_CORRELATION_ID ??
    (renderJobId ? `corr_${renderJobId}` : '')
  )
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, '')
    .slice(0, 128);

  if (!renderJobId) {
    logStructuredEvent({
      service: 'aicliper-render-worker',
      event: 'worker_missing_job_id',
      severity: 'ERROR',
      stage: 'boot',
      errorCode: 'MISSING_JOB_ID',
      errorMessage: 'AICLIPER_RENDER_JOB_ID wajib diberikan pada container worker.',
    });
    return {
      status: 'failed',
      jobId: '',
      skipped: false,
      retryCount: 0,
      errorCode: 'MISSING_JOB_ID',
      errorMessage: 'AICLIPER_RENDER_JOB_ID tidak ditemukan di environment worker.',
      failedStage: 'boot',
    };
  }

  const db = options.db ?? getDatabase();
  const v3Repo = new V3Repository(db);
  const pgStore = options.pgJobStore ?? new PgRenderJobStore();
  const renderExec = options.renderClipFn ?? renderClipMp4;
  const probeExec = options.probeVideoFn ?? probeVideoMeta;
  const claimToken = `claim-${executionName}-${crypto.randomBytes(6).toString('hex')}`;
  let uploadedGcsUriPreserved: string | undefined;

  // Isolated temporary directory always cleaned up in `finally`
  const workerTempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `aicliper-worker-${renderJobId.replace(/[^a-zA-Z0-9_-]/g, '')}-`)
  );
  let hydratedUploadCleanupPath: string | null = null;
  let currentStage = 'boot';

  const jobRow = db.getRenderJobById(renderJobId);
  const cloudState = db.getRenderJobCloudState(renderJobId);

  const failJob = async (
    errorCode: string,
    rawMessage: string,
    failedStage: string,
    retryCount = jobRow?.retryCount ?? 0
  ): Promise<ExecuteRenderWorkerResult> => {
    const cleanMessage = redactSensitiveString(rawMessage);
    const totalMs = Date.now() - totalStart;
    const completedAtIso = new Date().toISOString();

    if (jobRow) {
      db.upsertRenderJobCloudState({
        jobId: renderJobId,
        userUid: jobRow.userUid,
        clipId: jobRow.clipId,
        lifecycleStatus: 'failed',
        failedStage,
        cloudRunExecution: executionName,
      });
      db.upsertRenderJob({
        jobId: jobRow.jobId,
        clipId: jobRow.clipId,
        userUid: jobRow.userUid,
        layout: jobRow.layout,
        quality: jobRow.quality,
        status: 'failed',
        stage: `Render gagal pada tahap ${failedStage}.`,
        progress: jobRow.progress,
        retryCount,
        durationMs: totalMs,
        errorCode,
        errorMessage: cleanMessage,
        createdAt: jobRow.createdAt,
        completedAt: completedAtIso,
      });
    }
    if (pgStore.isAvailable()) {
      await pgStore
        .updateJobLifecycle({
          jobId: renderJobId,
          status: 'failed',
          stage: `Render gagal pada tahap ${failedStage}.`,
          durationMs: totalMs,
          errorCode,
          errorMessage: cleanMessage,
          failedStage,
        })
        .catch(() => undefined);
    }

    await v3Repo
      .recordJobEvent({
        jobId: renderJobId,
        jobType: 'render',
        userUid: jobRow?.userUid ?? envUserUid,
        stage: failedStage,
        status: 'failed',
        message: cleanMessage,
        durationMs: totalMs,
        metadata: { errorCode, executionName, retryCount },
      })
      .catch(() => undefined);

    await v3Repo
      .recordPerformanceMetric({
        userUid: jobRow?.userUid ?? envUserUid,
        category: 'render',
        operation: 'worker_total',
        durationMs: totalMs,
        success: false,
        cacheHit: false,
        metadata: { renderJobId, errorCode, failedStage, retryCount },
      })
      .catch(() => undefined);

    logStructuredEvent({
      service: 'aicliper-render-worker',
      event: 'worker_job_failed',
      severity: 'ERROR',
      renderJobId,
      userUid: jobRow?.userUid ?? envUserUid,
      clipId: jobRow?.clipId ?? envClipId,
      executionName,
      renderProfile: cloudState?.renderProfile,
      renderFingerprint: cloudState?.renderFingerprint,
      sourceFingerprint: cloudState?.sourceFingerprint,
      queueTaskName: cloudState?.cloudTaskName,
      stage: failedStage,
      startedAt: startedAtIso,
      completedAt: completedAtIso,
      durationMs: totalMs,
      retryCount,
      errorCode,
      errorMessage: cleanMessage,
    });

    return {
      status: 'failed',
      jobId: renderJobId,
      clipId: jobRow?.clipId ?? envClipId,
      userUid: jobRow?.userUid ?? envUserUid,
      skipped: false,
      retryCount,
      errorCode,
      errorMessage: cleanMessage,
      failedStage,
    };
  };

  try {
    // 1. Validate job exists in DB (never trust env alone)
    if (!jobRow) {
      return await failJob(
        'RENDER_JOB_NOT_FOUND',
        `Render job "${renderJobId}" tidak ditemukan di database.`,
        'validate_job',
        0
      );
    }

    // 2. Validate user ownership & clip match against env hints if provided
    if (envUserUid && envUserUid !== jobRow.userUid) {
      return await failJob(
        'OWNERSHIP_MISMATCH',
        'User UID pada environment worker tidak cocok dengan pemilik render job di database.',
        'validate_ownership'
      );
    }
    if (envClipId && envClipId !== jobRow.clipId) {
      return await failJob(
        'CLIP_MISMATCH',
        'Clip ID pada environment worker tidak cocok dengan render job di database.',
        'validate_ownership'
      );
    }

    const userUid = jobRow.userUid;
    const clipId = jobRow.clipId;

    // 3. Handle cancelled / already completed jobs idempotently
    if (jobRow.status === 'cancelled' || cloudState?.lifecycleStatus === 'cancelled') {
      logStructuredEvent({
        service: 'aicliper-render-worker',
        event: 'worker_job_skipped_cancelled',
        severity: 'INFO',
        renderJobId,
        userUid,
        clipId,
        executionName,
        stage: 'cancelled',
      });
      return {
        status: 'cancelled',
        jobId: renderJobId,
        clipId,
        userUid,
        skipped: true,
        retryCount: jobRow.retryCount,
      };
    }

    if (jobRow.status === 'completed' || cloudState?.lifecycleStatus === 'completed') {
      logStructuredEvent({
        service: 'aicliper-render-worker',
        event: 'worker_job_skipped_completed',
        severity: 'INFO',
        renderJobId,
        userUid,
        clipId,
        executionName,
        stage: 'completed',
      });
      return {
        status: 'skipped_completed',
        jobId: renderJobId,
        clipId,
        userUid,
        skipped: true,
        retryCount: jobRow.retryCount,
      };
    }

    // 4. Verify clip & episode exist and belong to the user
    const clip = db.getClipForUser(userUid, clipId);
    if (!clip) {
      return await failJob(
        'CLIP_NOT_FOUND',
        `Klip "${clipId}" tidak ditemukan atau bukan milik pengguna.`,
        'validate_clip'
      );
    }
    const episode = db.getEpisodeForUser(userUid, clip.episodeId);
    if (!episode) {
      return await failJob(
        'EPISODE_NOT_FOUND',
        `Episode sumber "${clip.episodeId}" tidak ditemukan atau bukan milik pengguna.`,
        'validate_episode'
      );
    }

    // Ensure cloud state row exists before atomic claim
    const payloadObj = cloudState?.payload ?? {};
    const renderProfile = (
      cloudState?.renderProfile ||
      (typeof payloadObj.renderProfile === 'string' ? payloadObj.renderProfile : '') ||
      (jobRow.quality === '4k' ? 'balanced_4k' : 'balanced_1080p')
    ) as BalancedRenderProfile;
    const sourceFingerprint =
      cloudState?.sourceFingerprint ||
      (typeof payloadObj.sourceFingerprint === 'string' ? payloadObj.sourceFingerprint : '') ||
      `src_${clip.episodeId}_${clip.startSec}_${clip.endSec}`;
    const renderFingerprint =
      cloudState?.renderFingerprint ||
      (typeof payloadObj.renderFingerprint === 'string' ? payloadObj.renderFingerprint : '') ||
      `rfp_${renderJobId}`;

    if (!cloudState) {
      db.upsertRenderJobCloudState({
        jobId: renderJobId,
        userUid,
        clipId,
        lifecycleStatus: 'queued',
        renderProfile,
        sourceFingerprint,
        renderFingerprint,
        cloudRunExecution: executionName,
      });
    }

    // 5. Atomic Worker Claim Lock (prevents concurrent duplicate execution; recovers stale crashed worker locks)
    currentStage = 'claim_lock';
    const claimResult = db.claimRenderJobForWorker(renderJobId, claimToken, {
      staleLockTtlSec: options.staleLockTtlSec,
    });
    if (!claimResult.claimed) {
      logStructuredEvent({
        service: 'aicliper-render-worker',
        event: 'worker_job_skipped_locked',
        severity: 'WARNING',
        correlationId,
        renderJobId,
        userUid,
        clipId,
        executionName,
        stage: 'claim_lock',
        currentLifecycle: claimResult.state?.lifecycleStatus,
      });
      return {
        status: 'skipped_locked',
        jobId: renderJobId,
        correlationId,
        clipId,
        userUid,
        skipped: true,
        retryCount: claimResult.retryCount,
      };
    }

    const activeRetryCount = claimResult.retryCount;
    db.attachCloudRunExecution(renderJobId, executionName);
    if (pgStore.isAvailable()) {
      await pgStore
        .claimJobForWorker({
          jobId: renderJobId,
          claimToken,
          staleLockTtlSec: options.staleLockTtlSec,
        })
        .catch(() => undefined);
    }

    const startupMs = Date.now() - totalStart;
    await v3Repo.recordJobEvent({
      jobId: renderJobId,
      jobType: 'render',
      userUid,
      stage: 'running',
      status: 'started',
      message: `Cloud Run Render Worker memulai eksekusi (${renderProfile}, retry #${activeRetryCount}${claimResult.recoveredStaleLock ? ', recovered stale lock' : ''}).`,
      durationMs: startupMs,
      metadata: {
        correlationId,
        executionName,
        renderProfile,
        renderFingerprint,
        retryCount: activeRetryCount,
        recoveredStaleLock: Boolean(claimResult.recoveredStaleLock),
      },
    });

    logStructuredEvent({
      service: 'aicliper-render-worker',
      event: 'worker_job_started',
      severity: 'INFO',
      correlationId,
      renderJobId,
      userUid,
      clipId,
      executionName,
      renderProfile,
      renderFingerprint,
      sourceFingerprint,
      queueTaskName: cloudState?.cloudTaskName,
      stage: 'running',
      startedAt: startedAtIso,
      durationMs: startupMs,
      retryCount: activeRetryCount,
      recoveredStaleLock: Boolean(claimResult.recoveredStaleLock),
    });

    // 6. Hydrate source asset from GCS if not present locally
    currentStage = 'source_download';
    const downloadStart = Date.now();
    const localUploadedPath = getUploadedVideoPath(episode.id);
    const sourceGcsKey =
      (typeof payloadObj.sourceGcsUri === 'string' && payloadObj.sourceGcsUri.trim()) ||
      (typeof payloadObj.sourceObjectKey === 'string' && payloadObj.sourceObjectKey.trim()) ||
      '';

    if (!localUploadedPath) {
      if (sourceGcsKey) {
        const downloadedTmpPath = path.join(workerTempDir, `source_${episode.id}.mp4`);
        await downloadMediaToLocalPath({
          objectKey: sourceGcsKey,
          requesterUid: userUid,
          destinationPath: downloadedTmpPath,
          configOverride: options.gcsConfigOverride,
          gcsAdapter: options.gcsAdapter,
        });
        const expectedUploadTarget = getUploadTargetPath(episode.id);
        fs.mkdirSync(path.dirname(expectedUploadTarget), { recursive: true });
        fs.copyFileSync(downloadedTmpPath, expectedUploadTarget);
        hydratedUploadCleanupPath = expectedUploadTarget;
      } else if (!episode.directVideoUrl?.trim() && !episode.sourceUrl?.trim()) {
        return await failJob(
          'SOURCE_ASSET_MISSING',
          `File sumber video untuk episode "${episode.id}" tidak tersedia secara lokal maupun di GCS.`,
          'source_download',
          activeRetryCount
        );
      }
    }
    const sourceDownloadMs = Date.now() - downloadStart;

    // 7. Invoke the EXISTING `renderClipMp4()` pipeline (NO duplicate FFmpeg pipeline!)
    currentStage = 'ffmpeg_render';
    const renderStart = Date.now();
    const layout = (jobRow.layout || 'shorts_full_bleed') as ClipRenderLayout;
    const quality = (jobRow.quality || '1080p') as ClipRenderQuality;
    const overlayStyle = (payloadObj.overlayStyle as ClipOverlayStyle | undefined) ?? clip.overlayStyle;
    const cameraSettings =
      (payloadObj.cameraSettings as CameraTrackingSettings | undefined) ??
      clip.cameraTrackingSettings;
    const introTemplateConfig =
      (payloadObj.introTemplateConfig as IntroTemplateDefinition | undefined) ??
      clip.introTemplateConfig;
    const enableEmotionEffects =
      typeof payloadObj.enableEmotionEffects === 'boolean'
        ? payloadObj.enableEmotionEffects
        : clip.emotionEffectsEnabled !== false;
    const enableAiIntro =
      typeof payloadObj.enableAiIntro === 'boolean'
        ? payloadObj.enableAiIntro
        : clip.introEnabled !== false;

    const renderResult: RenderClipResult = await renderExec({
      episode,
      clip,
      layout,
      quality,
      renderProfile,
      cameraSettings,
      introTemplateConfig,
      sourceFingerprint,
      renderFingerprint,
      enableEmotionEffects,
      enableAiIntro,
      overlayStyle,
      signal: options.signal,
      onProgress: (stage, progress) => {
        db.upsertRenderJob({
          jobId: jobRow.jobId,
          clipId: jobRow.clipId,
          userUid: jobRow.userUid,
          layout: jobRow.layout,
          quality: jobRow.quality,
          status: 'running',
          stage,
          progress: Math.min(89, progress),
          retryCount: activeRetryCount,
          createdAt: jobRow.createdAt,
        });
      },
    });
    const renderMs = Date.now() - renderStart;

    // 8. Explicit FFprobe output verification
    currentStage = 'ffprobe_validation';
    const probeStart = Date.now();
    if (!renderResult.outputPath || !fs.existsSync(renderResult.outputPath)) {
      return await failJob(
        'FFPROBE_VALIDATION_FAILED',
        'File output hasil render FFmpeg tidak ditemukan di disk worker.',
        'ffprobe_validation',
        activeRetryCount
      );
    }
    let probedMeta: Awaited<ReturnType<typeof probeVideoMeta>>;
    try {
      probedMeta = await probeExec(renderResult.outputPath);
    } catch (probeErr) {
      return await failJob(
        'FFPROBE_VALIDATION_FAILED',
        `FFprobe gagal memverifikasi hasil render MP4: ${probeErr instanceof Error ? probeErr.message : String(probeErr)}`,
        'ffprobe_validation',
        activeRetryCount
      );
    }
    if (
      !probedMeta ||
      probedMeta.width <= 0 ||
      probedMeta.height <= 0 ||
      probedMeta.durationSec <= 0 ||
      probedMeta.sizeBytes <= 0 ||
      !probedMeta.videoCodec
    ) {
      return await failJob(
        'FFPROBE_VALIDATION_FAILED',
        `Output video hasil render korup atau tidak valid (width=${probedMeta?.width ?? 0}, height=${probedMeta?.height ?? 0}, duration=${probedMeta?.durationSec ?? 0}).`,
        'ffprobe_validation',
        activeRetryCount
      );
    }
    const ffprobeMs = Date.now() - probeStart;

    // 9. Mark status = uploading and upload verified output to GCS
    currentStage = 'uploading';
    db.upsertRenderJobCloudState({
      jobId: renderJobId,
      userUid,
      clipId,
      lifecycleStatus: 'uploading',
      cloudRunExecution: executionName,
    });
    db.upsertRenderJob({
      jobId: jobRow.jobId,
      clipId: jobRow.clipId,
      userUid: jobRow.userUid,
      layout: jobRow.layout,
      quality: jobRow.quality,
      status: 'running',
      stage: 'Mengunggah video hasil render terverifikasi ke Cloud Storage...',
      progress: 93,
      retryCount: activeRetryCount,
      createdAt: jobRow.createdAt,
    });
    if (pgStore.isAvailable()) {
      await pgStore
        .updateJobLifecycle({
          jobId: renderJobId,
          status: 'uploading',
          stage: 'Mengunggah video hasil render terverifikasi ke Cloud Storage...',
          progress: 93,
        })
        .catch(() => undefined);
    }

    const storageOut = await finalizeRenderWorkerOutput({
      renderJobId,
      userUid,
      clipId,
      renderProfile,
      renderFingerprint,
      sourceFingerprint,
      localOutputPath: renderResult.outputPath,
      width: probedMeta.width,
      height: probedMeta.height,
      durationSec: probedMeta.durationSec,
      db,
      gcsConfigOverride: options.gcsConfigOverride,
      gcsAdapter: options.gcsAdapter,
    });
    if (storageOut.gcsUri) {
      uploadedGcsUriPreserved = storageOut.gcsUri;
    }

    // 10. Persist clip metadata, idempotent quota charge, and mark completed
    currentStage = 'db_finalize';
    const latestClip = db.getClipForUser(userUid, clipId) ?? clip;
    const intel = renderResult.intelligence;
    const updatedClip: PodcastClip = {
      ...latestClip,
      userUid,
      renderedClipUrl: `/api/clips/${clipId}/video`,
      renderedLayout: renderResult.layout,
      renderedQuality: renderResult.quality,
      renderProfile: renderResult.renderProfile,
      renderedSourceWidth: renderResult.sourceWidth,
      renderedSourceHeight: renderResult.sourceHeight,
      renderedSourceType: renderResult.sourceUsed,
      renderedFileSizeBytes: probedMeta.sizeBytes,
      introEnabled: renderResult.introEnabled,
      emotionEffectsEnabled: renderResult.emotionEffectsEnabled,
      ...(intel?.autoTitle ? { autoGeneratedTitle: intel.autoTitle } : {}),
    };
    db.upsertClip(userUid, updatedClip);

    // Idempotency guard: ensure retries NEVER double-charge quota!
    const quotaCharged = db.markRenderJobQuotaConsumed(renderJobId);
    if (quotaCharged) {
      consumeQuota(db, userUid, 'render', probedMeta.sizeBytes);
    }

    const totalMs = Date.now() - totalStart;
    const completedAtIso = new Date().toISOString();
    const resultPayload: Record<string, unknown> = {
      storageBackend: storageOut.storageBackend,
      gcsUri: storageOut.gcsUri,
      localPath: storageOut.localPath,
      sizeBytes: probedMeta.sizeBytes,
      width: probedMeta.width,
      height: probedMeta.height,
      durationSec: probedMeta.durationSec,
      videoCodec: probedMeta.videoCodec,
      audioCodec: probedMeta.audioCodec,
      audioChannels: probedMeta.audioChannels,
      layout: renderResult.layout,
      quality: renderResult.quality,
      renderProfile: renderResult.renderProfile,
      upscalePrevented: renderResult.upscalePrevented,
      upscaleNote: renderResult.upscaleNote,
      executionName,
    };

    if (options.persistJobCompletionFn) {
      await options.persistJobCompletionFn({ jobId: renderJobId, resultPayload });
    }

    db.upsertRenderJobCloudState({
      jobId: renderJobId,
      userUid,
      clipId,
      lifecycleStatus: 'completed',
      cloudRunExecution: executionName,
      failedStage: null,
    });
    db.upsertRenderJob({
      jobId: jobRow.jobId,
      clipId: jobRow.clipId,
      userUid: jobRow.userUid,
      layout: jobRow.layout,
      quality: jobRow.quality,
      status: 'completed',
      stage: 'Render video MP4 selesai & terverifikasi FFprobe!',
      progress: 100,
      retryCount: activeRetryCount,
      durationMs: totalMs,
      outputSizeBytes: probedMeta.sizeBytes,
      resultJson: JSON.stringify(resultPayload),
      createdAt: jobRow.createdAt,
      completedAt: completedAtIso,
    });

    if (pgStore.isAvailable()) {
      await pgStore
        .updateJobLifecycle({
          jobId: renderJobId,
          status: 'completed',
          stage: 'Render video MP4 selesai & terverifikasi FFprobe!',
          progress: 100,
          durationMs: totalMs,
          outputSizeBytes: probedMeta.sizeBytes,
          resultJson: resultPayload,
          quotaConsumed: true,
        })
        .catch(() => undefined);
    }

    await v3Repo.recordJobEvent({
      jobId: renderJobId,
      jobType: 'render',
      userUid,
      stage: 'completed',
      status: 'completed',
      message: `Cloud Run Render Worker selesai (${probedMeta.width}x${probedMeta.height}, ${storageOut.storageBackend}).`,
      durationMs: totalMs,
      metadata: {
        executionName,
        storageBackend: storageOut.storageBackend,
        gcsUri: storageOut.gcsUri,
        sizeBytes: probedMeta.sizeBytes,
        renderMs,
        ffprobeMs,
        uploadMs: storageOut.uploadDurationMs,
        upscalePrevented: renderResult.upscalePrevented,
      },
    });

    await v3Repo.recordPerformanceMetric({
      userUid,
      category: 'render',
      operation: `render_${renderProfile}`,
      durationMs: renderMs,
      success: true,
      cacheHit: false,
      metadata: {
        renderJobId,
        clipId,
        width: probedMeta.width,
        height: probedMeta.height,
        sizeBytes: probedMeta.sizeBytes,
        storageBackend: storageOut.storageBackend,
      },
    });

    logStructuredEvent({
      service: 'aicliper-render-worker',
      event: 'worker_job_completed',
      severity: 'INFO',
      correlationId,
      renderJobId,
      userUid,
      clipId,
      executionName,
      renderProfile,
      renderFingerprint,
      sourceFingerprint,
      queueTaskName: cloudState?.cloudTaskName,
      stage: 'completed',
      startedAt: startedAtIso,
      completedAt: completedAtIso,
      durationMs: totalMs,
      retryCount: activeRetryCount,
      width: probedMeta.width,
      height: probedMeta.height,
      sizeBytes: probedMeta.sizeBytes,
      storageBackend: storageOut.storageBackend,
    });

    return {
      status: 'completed',
      jobId: renderJobId,
      correlationId,
      clipId,
      userUid,
      skipped: false,
      retryCount: activeRetryCount,
      recoveredStaleLock: Boolean(claimResult.recoveredStaleLock),
      output: {
        storageBackend: storageOut.storageBackend,
        gcsUri: storageOut.gcsUri,
        localPath: storageOut.localPath,
        sizeBytes: probedMeta.sizeBytes,
        width: probedMeta.width,
        height: probedMeta.height,
        durationSec: probedMeta.durationSec,
        videoCodec: probedMeta.videoCodec,
        audioCodec: probedMeta.audioCodec ?? null,
        audioChannels: probedMeta.audioChannels,
        renderProfile: renderResult.renderProfile,
        quality: renderResult.quality,
        upscalePrevented: renderResult.upscalePrevented,
        quotaCharged,
      },
      timings: {
        startupMs,
        sourceDownloadMs,
        renderMs,
        ffprobeMs,
        uploadMs: storageOut.uploadDurationMs,
        totalMs,
      },
    };
  } catch (err) {
    const isSignalAborted = Boolean(options.signal?.aborted);
    const errCode = isSignalAborted
      ? 'WORKER_SIGTERM_INTERRUPTED'
      : (err as { code?: string })?.code && typeof (err as { code?: string }).code === 'string'
        ? (err as { code: string }).code
        : currentStage === 'uploading'
          ? 'GCS_UPLOAD_FAILED'
          : currentStage === 'source_download'
            ? 'GCS_DOWNLOAD_FAILED'
            : currentStage === 'ffmpeg_render'
              ? 'FFMPEG_RENDER_FAILED'
              : currentStage === 'db_finalize'
                ? 'DB_UPDATE_FAILED'
                : 'WORKER_EXECUTION_FAILED';
    const message = isSignalAborted
      ? 'Worker container dihentikan (SIGTERM) sebelum render selesai; job siap di-retry secara aman.'
      : err instanceof Error
        ? err.message
        : String(err);
    const failedRes = await failJob(errCode, message, currentStage, jobRow?.retryCount ?? 0);
    return {
      ...failedRes,
      correlationId,
      ...(uploadedGcsUriPreserved ? { preservedOutputGcsUri: uploadedGcsUriPreserved } : {}),
    };
  } finally {
    // Always clean up isolated temporary working files
    if (fs.existsSync(workerTempDir)) {
      fs.rmSync(workerTempDir, { recursive: true, force: true });
    }
    if (hydratedUploadCleanupPath && fs.existsSync(hydratedUploadCleanupPath)) {
      fs.rmSync(hydratedUploadCleanupPath, { force: true });
    }
  }
}

// Standalone Cloud Run Job CLI entrypoint with graceful SIGTERM/SIGINT handling
const isMainModule =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  const abortController = new AbortController();
  const handleTerminationSignal = (sig: NodeJS.Signals) => {
    logStructuredEvent({
      service: 'aicliper-render-worker',
      event: 'worker_signal_received',
      severity: 'WARNING',
      renderJobId: process.env.AICLIPER_RENDER_JOB_ID || undefined,
      correlationId: process.env.AICLIPER_CORRELATION_ID || undefined,
      stage: 'shutdown',
      signal: sig,
    });
    abortController.abort(new Error(`Worker terminated by ${sig}`));
  };
  process.once('SIGTERM', handleTerminationSignal);
  process.once('SIGINT', handleTerminationSignal);

  void (async () => {
    try {
      const result = await executeRenderWorkerJob({ signal: abortController.signal });
      await closePgPool();
      if (result.status === 'failed') {
        process.exitCode = 1;
      } else {
        process.exitCode = 0;
      }
    } catch (err) {
      logStructuredEvent({
        service: 'aicliper-render-worker',
        event: 'worker_uncaught_fatal',
        severity: 'ERROR',
        errorCode: 'WORKER_FATAL',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      await closePgPool();
      process.exitCode = 1;
    }
  })();
}
