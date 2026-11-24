import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INITIAL_STUDIO_STATE } from './src/data/seedPodcasts.ts';
import type {
  ClipOverlayStyle,
  ClipRenderLayout,
  ClipRenderQuality,
  DistributionLog,
  HookStyleTone,
  PlanTier,
  PodcastClip,
  SocialPlatform,
  StudioStoreState,
  UserRole,
} from './src/types/clipper.ts';
import {
  computeOverlayStyleFingerprint,
  normalizeClipOverlayStyle,
} from './src/utils/clipOverlayStyle.ts';
import {
  clampClipRange,
  extractYouTubeVideoId,
  normalizeAutomationDurationBounds,
  SHORTS_MAX_CLIP_SEC,
  SHORTS_MIN_CLIP_SEC,
} from './src/utils/youtube.ts';
import { buildDistributionLog, dispatchWebhookIfConfigured } from './server/store.ts';
import {
  getTargetCanvasDimensions,
  isValidRenderLayoutInput,
  isValidRenderProfileInput,
  isValidRenderQualityInput,
  normalizeRenderLayout,
  normalizeRenderQuality,
  resolveEffectiveRenderQuality,
} from './server/speakerFocusMath.ts';
import {
  getEpisodeSourceFingerprintTag,
  getRenderedClipPath,
  getUploadTargetPath,
  hasYoutubeCookies,
  invalidateLowResSegmentCache,
  RenderCancelledError,
  renderClipMp4,
  RenderTimeoutError,
  saveYoutubeCookies,
  YoutubeBotCheckError,
} from './server/videoClipper.ts';
import { RenderJobManager } from './server/renderJobManager.ts';
import { prewarmEpisodeStream } from './server/thirdPartyDownloader.ts';
import { resolveCappedByteRange } from './server/videoStreamRange.ts';
import { analyzePodcastWithGemini } from './server/youtubeAnalyzer.ts';
import {
  askGroundedEpisodeAssistant,
  generateRepurposedContentForClip,
  generateViralHooksForClip,
  polishSubtitlesMeaningSafe,
} from './server/aiStudio.ts';
import {
  buildYouTubeUploadMetadata,
  uploadVideoFileToYouTube,
  YouTubeUploadHttpError,
  type YouTubePrivacyStatus,
} from './server/youtubeUploader.ts';
import { createV2Router, normalizeClippingApproach } from './server/routes/v2Routes.ts';
import { V2Repository } from './server/repositories/v2Repository.ts';
import { createV3Router } from './server/routes/v3ProductionRoutes.ts';
import { V3Repository } from './server/repositories/v3Repository.ts';
import { normalizeCameraTrackingSettings } from './server/services/activeSpeakerEngine.ts';
import { normalizeIntroTemplateDefinition } from './server/services/introRenderCompiler.ts';
import {
  BALANCED_RENDER_PROFILES,
  computeRenderFingerprint,
  computeSourceFingerprint,
  resolveBalancedRenderProfile,
  type BalancedRenderProfileSpec,
} from './server/services/renderFingerprint.ts';
import { enqueueCloudTask, isCloudTasksConfigured } from './server/services/cloudTasksService.ts';
import {
  dispatchCloudRunRenderJob,
  isCloudRunJobsConfigured,
  type CloudRunDispatchDependencies,
} from './server/services/cloudRunJobsService.ts';
import {
  createInternalDispatchRouter,
} from './server/routes/internalDispatchRoutes.ts';
import type { OidcVerifierConfig, VerifyIdTokenFn } from './server/services/oidcVerifier.ts';
import { PgRenderJobStore } from './server/services/pgJobStore.ts';
import { closePgPool } from './src/db/index.ts';
import { finalizeRenderWorkerOutput } from './workers/renderWorker.ts';
import { GoogleTokenVerificationError } from './server/googleAuthVerifier.ts';
import {
  getAvailableFfmpegPathSync,
  getAvailableFfprobePathSync,
} from './server/ffmpegBinaries.ts';
import { getDatabase, type KlipCastDatabase } from './server/db.ts';
import {
  createAuthMiddlewares,
  createSignedStreamToken,
  getClientIp,
  verifySignedStreamToken,
  type AuthenticatedRequest,
  type FirebaseTokenVerifierFn,
} from './server/authMiddleware.ts';
import {
  assertQuotaAvailable,
  consumeQuota,
  getUserQuotaSummary,
  QuotaExceededError,
  trackGeminiApiUsage,
} from './server/quotaService.ts';
import {
  corsAllowlistMiddleware,
  createRateLimiter,
  isSafeResourceId,
  MAX_UPLOAD_BYTES,
  releaseUploadSlot,
  sanitizeAutomationForClient,
  sanitizePublicErrorMessage,
  securityHeadersMiddleware,
  tryAcquireUploadSlot,
  validateSafeExternalUrl,
  validateVideoMagicBytes,
} from './server/security.ts';
import { buildRealAdminOverview } from './server/systemMonitor.ts';

export interface CreateAppOptions {
  db?: KlipCastDatabase;
  verifyToken?: FirebaseTokenVerifierFn;
  disableRateLimit?: boolean;
  renderClipFn?: typeof renderClipMp4;
  dispatchCloudRunJobFn?: typeof dispatchCloudRunRenderJob;
  enqueueCloudTaskFn?: typeof enqueueCloudTask;
  requireExternalWorker?: boolean;
  requireCloudTasksDispatch?: boolean;
  oidcConfigOverride?: Partial<OidcVerifierConfig>;
  verifyOidcIdTokenFn?: VerifyIdTokenFn;
  cloudRunDeps?: CloudRunDispatchDependencies;
  pgJobStore?: PgRenderJobStore;
}

function attachSignedVideoUrls(uid: string, clips: PodcastClip[]): PodcastClip[] {
  return clips.map((clip) => {
    if (!clip.renderedClipUrl || !clip.renderedClipUrl.startsWith('/api/clips/')) {
      return clip;
    }
    const renderedPath = getRenderedClipPath(clip.id);
    if (!renderedPath) {
      const rest = { ...clip };
      delete rest.renderedClipUrl;
      delete rest.renderedFileSizeBytes;
      return rest;
    }
    const token = createSignedStreamToken({
      uid,
      resourceId: clip.id,
      scope: 'clip_video',
      ttlSec: 3600,
    });
    const base = clip.renderedClipUrl.split('?')[0];
    return {
      ...clip,
      renderedClipUrl: `${base}?st=${encodeURIComponent(token)}`,
    };
  });
}

function buildUserStudioState(db: KlipCastDatabase, uid: string): StudioStoreState {
  const episodes = db.listUserEpisodes(uid, 100, 0);
  const rawClips = db.listUserClips(uid, 300, 0);
  const clips = attachSignedVideoUrls(uid, rawClips);
  const distributionLogs = db.listUserDistributionLogs(uid, 100, 0);
  const automation = sanitizeAutomationForClient(db.getUserAutomation(uid));
  const userProfile = db.getUserProfileData(uid) ?? undefined;
  const quota = getUserQuotaSummary(db, uid);
  const unreadNotificationsCount = db.countUnreadNotifications(uid);

  return {
    episodes,
    clips,
    distributionLogs,
    automation,
    userProfile,
    quota,
    unreadNotificationsCount,
  };
}

export function createApp(options: CreateAppOptions = {}) {
  const db = options.db ?? getDatabase();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(securityHeadersMiddleware);
  app.use(corsAllowlistMiddleware);
  app.use(express.json({ limit: '2mb' }));

  const noopMiddleware: express.RequestHandler = (_req, _res, next) => next();
  const authRateLimit = options.disableRateLimit
    ? noopMiddleware
    : createRateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'auth' });
  const apiRateLimit = options.disableRateLimit
    ? noopMiddleware
    : createRateLimiter({ windowMs: 60_000, maxRequests: 180, keyPrefix: 'api' });
  const aiRateLimit = options.disableRateLimit
    ? noopMiddleware
    : createRateLimiter({
        windowMs: 60_000,
        maxRequests: 20,
        keyPrefix: 'ai',
        message: 'Batas permintaan AI per menit tercapai. Tunggu sebentar sebelum mencoba lagi.',
      });
  const renderRateLimit = options.disableRateLimit
    ? noopMiddleware
    : createRateLimiter({
        windowMs: 60_000,
        maxRequests: 12,
        keyPrefix: 'render',
        message: 'Terlalu banyak permintaan render dalam 1 menit. Tunggu sebentar.',
      });
  const webhookRateLimit = options.disableRateLimit
    ? noopMiddleware
    : createRateLimiter({
        windowMs: 60_000,
        maxRequests: 15,
        keyPrefix: 'webhook',
      });

  const { authenticateRequest, requireAuth, requireAdmin, requireSuperAdmin } =
    createAuthMiddlewares({
      db,
      verifyToken: options.verifyToken,
    });

  const renderClipExec = options.renderClipFn ?? renderClipMp4;
  const dispatchCloudRunJobExec = options.dispatchCloudRunJobFn ?? dispatchCloudRunRenderJob;
  const enqueueCloudTaskExec = options.enqueueCloudTaskFn ?? enqueueCloudTask;

  const renderJobManager = new RenderJobManager(60 * 60 * 1000, db);

  // =========================================================================
  // PUBLIC ENDPOINTS (strictly non-sensitive health, login verify, render specs)
  // =========================================================================

  app.get('/api/health', (_req, res) => {
    const dbHealthy = db.checkHealth();
    res.status(dbHealthy ? 200 : 503).json({
      ok: dbHealthy,
      service: 'klipcast-bot',
      dbStatus: dbHealthy ? 'healthy' : 'error',
      ffmpegReady: Boolean(getAvailableFfmpegPathSync()),
      ffprobeReady: Boolean(getAvailableFfprobePathSync()),
    });
  });

  app.post('/api/auth/verify-google', authRateLimit, async (req: AuthenticatedRequest, res) => {
    try {
      const authUser = await authenticateRequest(req);
      const profile = db.getUserProfileData(authUser.uid);
      const quota = getUserQuotaSummary(db, authUser.uid);

      db.insertAuditLog({
        actorUid: authUser.uid,
        actorEmail: authUser.email,
        action: 'auth.login',
        targetType: 'user',
        targetId: authUser.uid,
        metadata: { role: authUser.role },
        ipAddress: getClientIp(req),
      });

      res.setHeader('Cache-Control', 'no-store');
      res.json({
        verified: true,
        user: {
          uid: authUser.uid,
          email: authUser.email,
          emailVerified: authUser.emailVerified,
          name: authUser.name,
          picture: authUser.picture,
          role: authUser.role,
          status: authUser.status,
          authTime: authUser.authTime,
          expiresAt: authUser.expiresAt,
        },
        profile,
        quota,
      });
    } catch (err) {
      if (err instanceof GoogleTokenVerificationError) {
        res.status(err.status).json({
          verified: false,
          code: err.code,
          error: err.message,
        });
        return;
      }
      res.status(500).json({
        verified: false,
        code: 'VERIFY_INTERNAL_ERROR',
        error: 'Gagal memverifikasi sesi Google di server.',
      });
    }
  });

  app.get('/api/render/capabilities', (_req, res) => {
    const defaultLayout = normalizeRenderLayout('shorts_full_bleed');
    const defaultQuality = '1080p' as const;
    const activeDims = getTargetCanvasDimensions(defaultLayout, defaultQuality);
    res.json({
      supportedQualities: ['1080p', '4k'] as const,
      supportedLayouts: [
        'shorts_full_bleed',
        'shorts_studio_focus',
        'full_16_9_focus',
        'square_1_1',
        'portrait_4_5',
      ] as const,
      unlimitedDuration: true,
      defaultQuality,
      defaultLayout,
      activeResolution: {
        width: activeDims.outW,
        height: activeDims.outH,
      },
      presets: {
        shorts_full_bleed: {
          '1080p': getTargetCanvasDimensions('shorts_full_bleed', '1080p'),
          '4k': getTargetCanvasDimensions('shorts_full_bleed', '4k'),
        },
        shorts_studio_focus: {
          '1080p': getTargetCanvasDimensions('shorts_studio_focus', '1080p'),
          '4k': getTargetCanvasDimensions('shorts_studio_focus', '4k'),
        },
        full_16_9_focus: {
          '1080p': getTargetCanvasDimensions('full_16_9_focus', '1080p'),
          '4k': getTargetCanvasDimensions('full_16_9_focus', '4k'),
        },
        square_1_1: {
          '1080p': getTargetCanvasDimensions('square_1_1', '1080p'),
          '4k': getTargetCanvasDimensions('square_1_1', '4k'),
        },
        portrait_4_5: {
          '1080p': getTargetCanvasDimensions('portrait_4_5', '1080p'),
          '4k': getTargetCanvasDimensions('portrait_4_5', '4k'),
        },
      },
      endpoints: {
        renderClip: '/api/clips/:clipId/render-mp4',
        renderGeneric: '/api/render',
        jobStatus: '/api/render-jobs/:jobId',
      },
    });
  });

  // =========================================================================
  // AUTHENTICATED USER SESSION, PROFILE, DASHBOARD & NOTIFICATIONS
  // =========================================================================

  app.post('/api/auth/logout', requireAuth, (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    db.revokeUserSessions(user.uid, Math.floor(Date.now() / 1000) + 1);
    db.insertAuditLog({
      actorUid: user.uid,
      actorEmail: user.email,
      action: 'auth.logout_revoke',
      targetType: 'user',
      targetId: user.uid,
      ipAddress: getClientIp(req),
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true });
  });

  app.get('/api/state', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    res.setHeader('Cache-Control', 'no-store');
    res.json(buildUserStudioState(db, uid));
  });

  app.get('/api/me', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      profile: db.getUserProfileData(uid),
      quota: getUserQuotaSummary(db, uid),
      unreadNotificationsCount: db.countUnreadNotifications(uid),
    });
  });

  app.patch('/api/me/profile', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const body = (req.body ?? {}) as {
      displayName?: string;
      creatorNiche?: string;
      themePreference?: 'light' | 'dark' | 'system';
      preferredTheme?: 'light' | 'dark' | 'system';
      themePreset?: 'minimal_light' | 'dark_studio' | 'creator_neon' | 'professional';
      onboardingCompleted?: boolean;
    };
    const updated = db.updateUserProfile(uid, {
      displayName: body.displayName,
      creatorNiche: body.creatorNiche,
      themePreference: body.themePreference ?? body.preferredTheme,
      themePreset: body.themePreset,
      onboardingCompleted: body.onboardingCompleted,
    });
    res.json({ profile: updated });
  });

  app.get('/api/me/export', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const payload = db.exportUserData(uid);
    payload.automation = sanitizeAutomationForClient(payload.automation);
    res.setHeader('Cache-Control', 'no-store');
    res.json(payload);
  });

  app.delete('/api/me/data', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    const result = db.deleteAllUserContent(user.uid);
    db.insertAuditLog({
      actorUid: user.uid,
      actorEmail: user.email,
      action: 'user.delete_own_data',
      targetType: 'user',
      targetId: user.uid,
      metadata: result,
      ipAddress: getClientIp(req),
    });
    res.json({ ok: true, ...result, store: buildUserStudioState(db, user.uid) });
  });

  app.get('/api/dashboard', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const episodes = db.listUserEpisodes(uid, 12, 0);
    const clips = attachSignedVideoUrls(uid, db.listUserClips(uid, 20, 0));
    const renderJobs = db.listRenderJobs({ userUid: uid, limit: 15 });
    const uploadJobs = db.listUserUploadJobs(uid, 15);
    const quota = getUserQuotaSummary(db, uid);
    const profile = db.getUserProfileData(uid);
    const unreadNotificationsCount = db.countUnreadNotifications(uid);

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      profile,
      quota,
      unreadNotificationsCount,
      summary: {
        totalEpisodes: db.countUserEpisodes(uid),
        totalClips: db.listUserClips(uid, 1000, 0).length,
        publishedClips: clips.filter(
          (c) => c.status === 'published_auto' || c.status === 'published_manual'
        ).length,
        scheduledClips: clips.filter((c) => c.status === 'scheduled').length,
        renderedClips: clips.filter((c) => Boolean(c.renderedClipUrl)).length,
      },
      recentEpisodes: episodes.slice(0, 6),
      recentClips: clips.slice(0, 8),
      recentRenderJobs: renderJobs,
      recentUploadJobs: uploadJobs,
    });
  });

  app.get('/api/notifications', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const notifications = db.listUserNotifications(uid, 40);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      unreadCount: db.countUnreadNotifications(uid),
      notifications,
    });
  });

  app.post('/api/notifications/read-all', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const updated = db.markAllNotificationsRead(uid);
    res.json({ ok: true, updated, unreadCount: 0 });
  });

  app.post('/api/notifications/:id/read', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const id = req.params.id;
    if (!isSafeResourceId(id)) {
      res.status(400).json({ error: 'ID notifikasi tidak valid.' });
      return;
    }
    const updated = db.markNotificationRead(uid, id);
    res.json({ ok: updated, unreadCount: db.countUnreadNotifications(uid) });
  });

  // =========================================================================
  // PODCAST ANALYSIS, EPISODE & CLIP MANAGEMENT (STRICT UID ISOLATION)
  // =========================================================================

  app.post('/api/podcast/analyze', aiRateLimit, requireAuth, async (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    try {
      const { url, manualTranscript, autoPostOverride, clippingApproach } = (req.body ?? {}) as {
        url?: string;
        manualTranscript?: string;
        autoPostOverride?: boolean;
        clippingApproach?: string;
      };

      if (!url || typeof url !== 'string' || !url.trim()) {
        res.status(400).json({ error: 'Masukkan link YouTube podcast terlebih dahulu.' });
        return;
      }

      const videoId = extractYouTubeVideoId(url);
      if (!videoId) {
        res.status(400).json({
          error: 'Link YouTube tidak valid. Gunakan format youtube.com/watch?v=... atau youtu.be/...',
        });
        return;
      }

      if (typeof manualTranscript === 'string' && manualTranscript.length > 60_000) {
        res.status(400).json({ error: 'Transkrip manual maksimal 60.000 karakter.' });
        return;
      }

      assertQuotaAvailable(db, user.uid, 'project');
      assertQuotaAvailable(db, user.uid, 'ai');

      const automation = db.getUserAutomation(user.uid);
      const episodeId = `ep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      const { episode, clips, usage } = await analyzePodcastWithGemini({
        episodeId,
        sourceUrl: url.trim(),
        videoId,
        manualTranscript,
        targetClipCount: automation.targetClipCount,
        minDurationSec: automation.minClipSec,
        maxDurationSec: automation.maxClipSec,
        autoAddHashtagShorts: automation.autoAddHashtagShorts,
        clippingApproach: normalizeClippingApproach(clippingApproach),
      });

      const shouldAutoPost =
        typeof autoPostOverride === 'boolean' ? autoPostOverride : automation.autoPostOnAnalyze;

      const finalClips: PodcastClip[] = [];
      const newLogs: DistributionLog[] = [];

      for (const clip of clips) {
        if (shouldAutoPost && clip.priorityLabel === 'Sorotan Utama') {
          const platforms = automation.defaultPlatforms;
          const webhookResult = await dispatchWebhookIfConfigured(automation, {
            event: 'clip.published',
            mode: 'auto',
            platforms,
            episode,
            clip,
          });
          const publishedClip: PodcastClip = {
            ...clip,
            userUid: user.uid,
            status: 'published_auto',
            publishedPlatforms: platforms,
            lastPublishedAt: new Date().toISOString(),
          };
          finalClips.push(publishedClip);
          newLogs.push(
            buildDistributionLog({
              clip: publishedClip,
              episodeTitle: episode.title,
              mode: 'auto',
              platforms,
              webhookResult,
            })
          );
        } else {
          finalClips.push({ ...clip, userUid: user.uid });
        }
      }

      db.transaction(() => {
        db.upsertEpisode(user.uid, episode);
        for (const c of finalClips) {
          db.upsertClip(user.uid, c);
        }
        for (const log of newLogs) {
          db.insertDistributionLog(user.uid, log);
        }
      });

      trackGeminiApiUsage(db, {
        userUid: user.uid,
        operation: 'podcast_analyze',
        model: usage.model,
        promptTokens: usage.promptTokens,
        outputTokens: usage.outputTokens,
        cached: usage.cached,
      });
      consumeQuota(db, user.uid, 'ai');

      db.createNotification({
        userUid: user.uid,
        type: 'analysis_complete',
        title: 'Analisis Podcast Selesai',
        message: `${finalClips.length} klip potensial ditemukan untuk "${episode.title.slice(0, 60)}".`,
        relatedId: episode.id,
      });

      void prewarmEpisodeStream(episode.sourceUrl, episode.videoId);

      res.json({
        episode,
        clips: finalClips,
        store: buildUserStudioState(db, user.uid),
      });
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        res.status(err.status).json({ code: err.code, error: err.message });
        return;
      }
      res.status(500).json({
        error: sanitizePublicErrorMessage(err, 'Terjadi kesalahan saat menganalisis podcast.'),
      });
    }
  });

  app.delete('/api/episodes/:episodeId', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const { episodeId } = req.params;
    if (!isSafeResourceId(episodeId)) {
      res.status(400).json({ error: 'Episode ID tidak valid.' });
      return;
    }
    const deleted = db.softDeleteEpisodeForUser(uid, episodeId);
    if (!deleted) {
      res.status(404).json({ error: 'Episode tidak ditemukan atau bukan milik akun Anda.' });
      return;
    }
    res.json({ ok: true, store: buildUserStudioState(db, uid) });
  });

  app.patch('/api/clips/:clipId', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const { clipId } = req.params;
    if (!isSafeResourceId(clipId)) {
      res.status(400).json({ error: 'Clip ID tidak valid.' });
      return;
    }

    const existing = db.getClipForUser(uid, clipId);
    if (!existing) {
      res.status(404).json({ error: 'Klip tidak ditemukan.' });
      return;
    }

    const episode = db.getEpisodeForUser(uid, existing.episodeId);
    const maxEpDuration = episode?.durationSec ?? 3600;
    const patch = (req.body ?? {}) as Partial<PodcastClip>;

    const nextRange =
      typeof patch.startSec === 'number' || typeof patch.endSec === 'number'
        ? clampClipRange(
            patch.startSec ?? existing.startSec,
            patch.endSec ?? existing.endSec,
            maxEpDuration,
            SHORTS_MIN_CLIP_SEC,
            SHORTS_MAX_CLIP_SEC
          )
        : { startSec: existing.startSec, endSec: existing.endSec };

    const rangeChanged =
      nextRange.startSec !== existing.startSec || nextRange.endSec !== existing.endSec;

    const nextOverlayStyle =
      patch.overlayStyle === null
        ? undefined
        : patch.overlayStyle
          ? normalizeClipOverlayStyle(patch.overlayStyle)
          : existing.overlayStyle;

    const nextCameraSettings =
      patch.cameraTrackingSettings === null
        ? undefined
        : patch.cameraTrackingSettings
          ? normalizeCameraTrackingSettings(existing.id, patch.cameraTrackingSettings)
          : existing.cameraTrackingSettings;

    const nextIntroTemplateConfig =
      patch.introTemplateConfig === null
        ? undefined
        : patch.introTemplateConfig
          ? normalizeIntroTemplateDefinition(patch.introTemplateConfig)
          : existing.introTemplateConfig;

    const nextRenderProfile = patch.renderProfile
      ? resolveBalancedRenderProfile(patch.renderProfile).id
      : existing.renderProfile;

    const updatedClip: PodcastClip = {
      ...existing,
      ...(typeof patch.title === 'string' ? { title: patch.title.slice(0, 140) } : {}),
      ...(typeof patch.hookLine === 'string' ? { hookLine: patch.hookLine.slice(0, 240) } : {}),
      ...(typeof patch.ringkasanTeks === 'string'
        ? { ringkasanTeks: patch.ringkasanTeks.slice(0, 1000) }
        : {}),
      ...(Array.isArray(patch.poinKunci) ? { poinKunci: patch.poinKunci.slice(0, 6) } : {}),
      ...(Array.isArray(patch.captionCues) ? { captionCues: patch.captionCues.slice(0, 120) } : {}),
      ...(patch.platformCopies ? { platformCopies: patch.platformCopies } : {}),
      ...(typeof patch.scheduledFor === 'string'
        ? { scheduledFor: patch.scheduledFor, status: 'scheduled' as const }
        : {}),
      id: existing.id,
      episodeId: existing.episodeId,
      userUid: uid,
      startSec: nextRange.startSec,
      endSec: nextRange.endSec,
      overlayStyle: nextOverlayStyle,
      cameraTrackingSettings: nextCameraSettings,
      introTemplateConfig: nextIntroTemplateConfig,
      renderProfile: nextRenderProfile,
      ...(rangeChanged
        ? {
            renderedClipUrl: undefined,
            renderedLayout: undefined,
            renderedQuality: undefined,
            renderedSourceWidth: undefined,
            renderedSourceHeight: undefined,
            renderedSourceType: undefined,
            renderedFileSizeBytes: undefined,
            subtitleAccuracySource: undefined,
            speakerFocusSummary: undefined,
            emotionMoments: undefined,
            emotionSummary: undefined,
            introEnabled: undefined,
            introTag: undefined,
            introHeadline: undefined,
            introTeaser: undefined,
            introDurationSec: undefined,
          }
        : {}),
    };

    db.upsertClip(uid, updatedClip);
    res.json({ clip: updatedClip, store: buildUserStudioState(db, uid) });
  });

  app.post('/api/clips/:clipId/schedule', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const { clipId } = req.params;
    if (!isSafeResourceId(clipId)) {
      res.status(400).json({ error: 'Clip ID tidak valid.' });
      return;
    }
    const existing = db.getClipForUser(uid, clipId);
    if (!existing) {
      res.status(404).json({ error: 'Klip tidak ditemukan.' });
      return;
    }
    const { scheduledFor } = (req.body ?? {}) as { scheduledFor?: string | null };
    if (scheduledFor && Number.isNaN(Date.parse(scheduledFor))) {
      res.status(400).json({ error: 'Format tanggal jadwal tidak valid.' });
      return;
    }
    const updatedClip: PodcastClip = {
      ...existing,
      scheduledFor: scheduledFor || undefined,
      status: scheduledFor ? 'scheduled' : existing.status === 'scheduled' ? 'draft' : existing.status,
    };
    db.upsertClip(uid, updatedClip);
    res.json({ clip: updatedClip, store: buildUserStudioState(db, uid) });
  });

  app.post('/api/clips/:clipId/publish', webhookRateLimit, requireAuth, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const { clipId } = req.params;
    if (!isSafeResourceId(clipId)) {
      res.status(400).json({ error: 'Clip ID tidak valid.' });
      return;
    }
    const { mode, platforms } = (req.body ?? {}) as {
      mode?: 'auto' | 'manual';
      platforms?: SocialPlatform[];
    };

    const clip = db.getClipForUser(uid, clipId);
    if (!clip) {
      res.status(404).json({ error: 'Klip tidak ditemukan.' });
      return;
    }

    const episode = db.getEpisodeForUser(uid, clip.episodeId) ?? undefined;
    const automation = db.getUserAutomation(uid);
    const resolvedMode = mode === 'auto' ? 'auto' : 'manual';
    const resolvedPlatforms =
      Array.isArray(platforms) && platforms.length > 0 ? platforms : automation.defaultPlatforms;

    const webhookResult = await dispatchWebhookIfConfigured(automation, {
      event: 'clip.published',
      mode: resolvedMode,
      platforms: resolvedPlatforms,
      episode,
      clip,
    });

    const mergedPlatforms = Array.from(new Set([...clip.publishedPlatforms, ...resolvedPlatforms]));
    const updatedClip: PodcastClip = {
      ...clip,
      status: resolvedMode === 'auto' ? 'published_auto' : 'published_manual',
      publishedPlatforms: mergedPlatforms,
      lastPublishedAt: new Date().toISOString(),
    };

    const logEntry = buildDistributionLog({
      clip: updatedClip,
      episodeTitle: episode?.title ?? 'Podcast Episode',
      mode: resolvedMode,
      platforms: resolvedPlatforms,
      webhookResult,
    });

    db.transaction(() => {
      db.upsertClip(uid, updatedClip);
      db.insertDistributionLog(uid, logEntry);
    });

    res.json({
      clip: updatedClip,
      log: logEntry,
      webhookResult,
      store: buildUserStudioState(db, uid),
    });
  });

  app.post('/api/clips/:clipId/youtube-upload', apiRateLimit, requireAuth, async (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    const ytTokenHeader = req.header('X-YouTube-Access-Token')?.trim();
    const ytTokenBody =
      typeof (req.body as { youtubeAccessToken?: unknown } | undefined)?.youtubeAccessToken === 'string'
        ? (req.body as { youtubeAccessToken: string }).youtubeAccessToken.trim()
        : '';
    const accessToken = ytTokenHeader || ytTokenBody;
    if (!accessToken) {
      res.status(401).json({
        needsReauth: true,
        error: 'Token izin unggah YouTube diperlukan. Klik hubungkan akun YouTube terlebih dahulu.',
      });
      return;
    }

    const { clipId } = req.params;
    if (!isSafeResourceId(clipId)) {
      res.status(400).json({ error: 'Clip ID tidak valid.' });
      return;
    }

    const clip = db.getClipForUser(user.uid, clipId);
    if (!clip) {
      res.status(404).json({ error: 'Klip tidak ditemukan.' });
      return;
    }

    try {
      assertQuotaAvailable(db, user.uid, 'upload');
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        res.status(err.status).json({ code: err.code, error: err.message });
        return;
      }
      throw err;
    }

    const episode = db.getEpisodeForUser(user.uid, clip.episodeId);
    const automation = db.getUserAutomation(user.uid);
    const renderedPath = getRenderedClipPath(clipId);
    if (!renderedPath) {
      res.status(400).json({
        code: 'CLIP_NOT_RENDERED',
        error: 'Render video klip .MP4 terlebih dahulu sebelum mengunggah langsung ke YouTube Shorts.',
      });
      return;
    }

    const body = (req.body ?? {}) as {
      title?: string;
      description?: string;
      tags?: string[];
      privacyStatus?: YouTubePrivacyStatus;
    };
    const shortsCopy = clip.platformCopies.youtube_shorts;
    const metadata = buildYouTubeUploadMetadata({
      title: body.title ?? clip.autoGeneratedTitle ?? shortsCopy.title ?? clip.title,
      description:
        body.description ??
        `${clip.autoGeneratedCaption ?? shortsCopy.caption}\n\nSumber: ${episode?.sourceUrl ?? ''}`,
      tags: Array.isArray(body.tags) ? body.tags : shortsCopy.hashtags,
      privacyStatus: body.privacyStatus ?? automation.youtubeDefaultVisibility,
      includeShortsTag: automation.autoAddHashtagShorts,
    });

    const uploadJob = db.recordUploadJob({
      userUid: user.uid,
      episodeId: clip.episodeId,
      clipId: clip.id,
      kind: 'youtube_publish',
      status: 'running',
      fileSizeBytes: fs.statSync(renderedPath).size,
    });

    try {
      const uploaded = await uploadVideoFileToYouTube({
        accessToken,
        filePath: renderedPath,
        metadata,
      });

      const mergedPlatforms = Array.from(
        new Set<SocialPlatform>([...clip.publishedPlatforms, 'youtube_shorts'])
      );
      const updatedClip: PodcastClip = {
        ...clip,
        status: 'published_auto',
        publishedPlatforms: mergedPlatforms,
        lastPublishedAt: new Date().toISOString(),
        youtubeVideoId: uploaded.youtubeVideoId,
        youtubeWatchUrl: uploaded.youtubeWatchUrl,
      };

      const logEntry = {
        id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        clipId: updatedClip.id,
        clipTitle: updatedClip.title,
        episodeTitle: episode?.title ?? 'Podcast Episode',
        mode: 'auto' as const,
        platforms: ['youtube_shorts'] as SocialPlatform[],
        webhookDelivered: true,
        status: 'success' as const,
        message: `Berhasil diunggah langsung ke YouTube Shorts (${metadata.status.privacyStatus}) — ${uploaded.youtubeWatchUrl}`,
        timestamp: new Date().toISOString(),
      };

      db.transaction(() => {
        db.upsertClip(user.uid, updatedClip);
        db.insertDistributionLog(user.uid, logEntry);
        db.recordUploadJob({
          id: uploadJob.id,
          userUid: user.uid,
          episodeId: clip.episodeId,
          clipId: clip.id,
          kind: 'youtube_publish',
          status: 'completed',
          fileSizeBytes: uploadJob.file_size_bytes,
          externalUrl: uploaded.youtubeWatchUrl,
        });
      });

      consumeQuota(db, user.uid, 'upload');
      db.createNotification({
        userUid: user.uid,
        type: 'upload_complete',
        title: 'Unggah ke YouTube Shorts Berhasil',
        message: `Klip "${updatedClip.title.slice(0, 60)}" berhasil diunggah (${metadata.status.privacyStatus}).`,
        relatedId: updatedClip.id,
      });

      res.json({
        ok: true,
        youtubeVideoId: uploaded.youtubeVideoId,
        youtubeWatchUrl: uploaded.youtubeWatchUrl,
        clip: updatedClip,
        store: buildUserStudioState(db, user.uid),
      });
    } catch (err) {
      const errMsg = sanitizePublicErrorMessage(err, 'Gagal mengunggah video ke YouTube.');
      db.recordUploadJob({
        id: uploadJob.id,
        userUid: user.uid,
        episodeId: clip.episodeId,
        clipId: clip.id,
        kind: 'youtube_publish',
        status: 'failed',
        fileSizeBytes: uploadJob.file_size_bytes,
        errorMessage: errMsg,
      });
      db.createNotification({
        userUid: user.uid,
        type: 'upload_failed',
        title: 'Unggah ke YouTube Gagal',
        message: errMsg,
        relatedId: clip.id,
      });

      if (err instanceof YouTubeUploadHttpError) {
        res.status(err.status).json({
          needsReauth: err.needsReauth,
          error: err.message,
        });
        return;
      }
      res.status(500).json({ error: errMsg });
    }
  });

  app.delete('/api/clips/:clipId', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const { clipId } = req.params;
    if (!isSafeResourceId(clipId)) {
      res.status(400).json({ error: 'Clip ID tidak valid.' });
      return;
    }
    const deleted = db.softDeleteClipForUser(uid, clipId);
    if (!deleted) {
      res.status(404).json({ error: 'Klip tidak ditemukan.' });
      return;
    }
    res.json({ ok: true, store: buildUserStudioState(db, uid) });
  });

  // =========================================================================
  // AUTOMATION & WEBHOOK CONFIGURATION (PER-USER, SECRET REDACTED)
  // =========================================================================

  app.put('/api/automation', apiRateLimit, requireAuth, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const current = db.getUserAutomation(uid);
    const incoming = (req.body ?? {}) as Partial<typeof current> & { clearWebhookSecret?: boolean };

    const nextWebhookUrl =
      typeof incoming.webhookUrl === 'string' ? incoming.webhookUrl.trim() : current.webhookUrl;
    if (nextWebhookUrl) {
      const check = await validateSafeExternalUrl(nextWebhookUrl, {
        allowedDomainsEnv: process.env.WEBHOOK_ALLOWED_DOMAINS,
      });
      if (!check.valid) {
        res.status(400).json({ error: check.reason ?? 'URL webhook tidak valid.' });
        return;
      }
    }

    const { minClipSec, maxClipSec } = normalizeAutomationDurationBounds(
      incoming.minClipSec ?? current.minClipSec,
      incoming.maxClipSec ?? current.maxClipSec
    );
    const targetClipCount = Math.max(
      1,
      Math.min(5, Number(incoming.targetClipCount ?? current.targetClipCount))
    );

    let enableUltraHdRender = current.enableUltraHdRender;
    let defaultRenderQuality = current.defaultRenderQuality;
    if (typeof incoming.enableUltraHdRender === 'boolean') {
      enableUltraHdRender = incoming.enableUltraHdRender;
      defaultRenderQuality = enableUltraHdRender ? '4k' : '1080p';
    } else if (incoming.defaultRenderQuality) {
      defaultRenderQuality = normalizeRenderQuality(incoming.defaultRenderQuality);
      enableUltraHdRender = defaultRenderQuality === '4k';
    }

    const defaultRenderLayout = incoming.defaultRenderLayout
      ? normalizeRenderLayout(incoming.defaultRenderLayout)
      : current.defaultRenderLayout;

    // Never overwrite existing webhook secret with empty string unless explicit clearWebhookSecret=true
    const nextWebhookSecret = incoming.clearWebhookSecret
      ? ''
      : typeof incoming.webhookSecretHeader === 'string' && incoming.webhookSecretHeader.trim()
        ? incoming.webhookSecretHeader.trim()
        : current.webhookSecretHeader;

    const saved = db.saveUserAutomation(uid, {
      ...current,
      ...incoming,
      webhookUrl: nextWebhookUrl,
      webhookSecretHeader: nextWebhookSecret,
      minClipSec,
      maxClipSec,
      targetClipCount,
      enableUltraHdRender,
      defaultRenderQuality,
      defaultRenderLayout,
      enableAiEmotionEffects:
        typeof incoming.enableAiEmotionEffects === 'boolean'
          ? incoming.enableAiEmotionEffects
          : current.enableAiEmotionEffects,
      enableAiIntro:
        typeof incoming.enableAiIntro === 'boolean'
          ? incoming.enableAiIntro
          : current.enableAiIntro,
    });

    res.json({
      automation: sanitizeAutomationForClient(saved),
      store: buildUserStudioState(db, uid),
    });
  });

  app.post('/api/automation/test-webhook', webhookRateLimit, requireAuth, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const current = db.getUserAutomation(uid);
    const { webhookUrl, webhookSecretHeader } = (req.body ?? {}) as {
      webhookUrl?: string;
      webhookSecretHeader?: string;
    };

    const testConfig = {
      ...current,
      webhookUrl: typeof webhookUrl === 'string' ? webhookUrl.trim() : current.webhookUrl,
      webhookSecretHeader:
        typeof webhookSecretHeader === 'string' && webhookSecretHeader.trim()
          ? webhookSecretHeader.trim()
          : current.webhookSecretHeader,
    };

    if (!testConfig.webhookUrl) {
      res.status(400).json({ error: 'Masukkan URL webhook terlebih dahulu untuk menguji koneksi.' });
      return;
    }

    const urlCheck = await validateSafeExternalUrl(testConfig.webhookUrl, {
      allowedDomainsEnv: process.env.WEBHOOK_ALLOWED_DOMAINS,
    });
    if (!urlCheck.valid) {
      res.status(400).json({ error: urlCheck.reason ?? 'URL webhook ditolak demi keamanan server.' });
      return;
    }

    const result = await dispatchWebhookIfConfigured(testConfig, { event: 'bot.test' });
    if (!result.attempted) {
      res.status(400).json({ error: 'Masukkan URL webhook terlebih dahulu untuk menguji koneksi.' });
      return;
    }
    res.json(result);
  });

  app.post('/api/reset-demo', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const seed = structuredClone(INITIAL_STUDIO_STATE);
    const suffix = `${Date.now().toString(36)}`;
    db.transaction(() => {
      for (const ep of seed.episodes) {
        const newEpId = `${ep.id}-${uid.slice(0, 6)}-${suffix}`;
        db.upsertEpisode(uid, { ...ep, id: newEpId, userUid: uid });
        for (const clip of seed.clips.filter((c) => c.episodeId === ep.id)) {
          db.upsertClip(uid, {
            ...clip,
            id: `${clip.id}-${uid.slice(0, 6)}-${suffix}`,
            episodeId: newEpId,
            userUid: uid,
          });
        }
      }
    });
    res.json({ store: buildUserStudioState(db, uid) });
  });

  // Server-wide cookies.txt management restricted strictly to admins
  app.get('/api/automation/cookies-status', requireAuth, (req: AuthenticatedRequest, res) => {
    const isAdmin = req.authUser!.role === 'admin' || req.authUser!.role === 'super_admin';
    res.json({ hasYoutubeCookies: hasYoutubeCookies(), canManage: isAdmin });
  });

  app.post(
    '/api/automation/youtube-cookies',
    apiRateLimit,
    requireAuth,
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const { cookiesTxt } = (req.body ?? {}) as { cookiesTxt?: string };
      const result = saveYoutubeCookies(typeof cookiesTxt === 'string' ? cookiesTxt : '');
      if (result.error) {
        res.status(400).json({ error: result.error, hasYoutubeCookies: result.saved });
        return;
      }
      db.insertAuditLog({
        actorUid: req.authUser!.uid,
        actorEmail: req.authUser!.email,
        action: 'admin.update_youtube_cookies',
        targetType: 'system',
        metadata: { hasCookies: result.saved },
        ipAddress: getClientIp(req),
      });
      res.json({ hasYoutubeCookies: result.saved });
    }
  );

  // =========================================================================
  // SECURE VIDEO UPLOAD & DIRECT SOURCE URL (MAGIC BYTES, SIZE, SSRF LOCK)
  // =========================================================================

  app.post('/api/episodes/:episodeId/upload-video', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    const { episodeId } = req.params;
    if (!isSafeResourceId(episodeId)) {
      res.status(400).json({ error: 'Episode ID tidak valid.' });
      return;
    }

    const episode = db.getEpisodeForUser(user.uid, episodeId);
    if (!episode) {
      res.status(404).json({ error: 'Episode tidak ditemukan atau bukan milik akun Anda.' });
      return;
    }

    const contentLength = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
      res.status(413).json({
        error: `Ukuran file terlalu besar. Maksimal ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`,
      });
      return;
    }

    try {
      assertQuotaAvailable(db, user.uid, 'upload', {
        incomingBytes: Number.isFinite(contentLength) ? contentLength : 0,
      });
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        res.status(err.status).json({ code: err.code, error: err.message });
        return;
      }
      res.status(500).json({
        code: 'QUOTA_CHECK_FAILED',
        error: sanitizePublicErrorMessage(err, 'Gagal memeriksa kuota unggah video.'),
      });
      return;
    }

    if (!tryAcquireUploadSlot()) {
      res.status(429).json({
        error: 'Server sedang memproses unggahan video lain. Tunggu beberapa detik lalu coba lagi.',
      });
      return;
    }

    const destPath = getUploadTargetPath(episodeId);
    const tmpPath = `${destPath}.${Date.now()}.part`;
    const writeStream = fs.createWriteStream(tmpPath);
    let bytes = 0;
    let headerChecked = false;
    let headerChunks: Buffer[] = [];
    let aborted = false;
    let slotReleased = false;

    const releaseOnce = () => {
      if (!slotReleased) {
        slotReleased = true;
        releaseUploadSlot();
      }
    };

    const failUpload = (statusCode: number, message: string) => {
      if (aborted) return;
      aborted = true;
      writeStream.destroy();
      if (fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // Ignore cleanup error
        }
      }
      releaseOnce();
      db.recordUploadJob({
        userUid: user.uid,
        episodeId,
        kind: 'source_video',
        status: 'failed',
        fileSizeBytes: bytes,
        errorMessage: message,
      });
      if (!res.headersSent) {
        res.status(statusCode).json({ error: message });
      }
    };

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) {
        failUpload(
          413,
          `Ukuran file melebihi batas maksimal ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`
        );
        req.resume();
        return;
      }

      if (!headerChecked) {
        headerChunks.push(chunk);
        const combined = Buffer.concat(headerChunks);
        if (combined.length >= 16) {
          headerChecked = true;
          headerChunks = [];
          const magic = validateVideoMagicBytes(combined);
          if (!magic.valid) {
            failUpload(400, magic.reason ?? 'File bukan format video yang valid.');
            req.resume();
            return;
          }
        }
      }

      writeStream.write(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      if (!headerChecked && headerChunks.length > 0) {
        const combined = Buffer.concat(headerChunks);
        const magic = validateVideoMagicBytes(combined);
        if (!magic.valid) {
          failUpload(400, magic.reason ?? 'File bukan format video yang valid.');
          return;
        }
      }
      writeStream.end();
    });

    req.on('error', () => {
      failUpload(400, 'Koneksi unggah terputus.');
    });

    writeStream.on('finish', () => {
      if (aborted) return;
      releaseOnce();
      if (bytes === 0) {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        res.status(400).json({ error: 'File video kosong.' });
        return;
      }
      fs.renameSync(tmpPath, destPath);
      invalidateLowResSegmentCache(episodeId);
      db.upsertEpisode(user.uid, { ...episode, hasUploadedSourceVideo: true });
      db.recordUploadJob({
        userUid: user.uid,
        episodeId,
        kind: 'source_video',
        status: 'completed',
        fileSizeBytes: bytes,
      });
      consumeQuota(db, user.uid, 'upload', bytes);
      res.json({ ok: true, sizeBytes: bytes, store: buildUserStudioState(db, user.uid) });
    });

    writeStream.on('error', () => {
      failUpload(500, 'Gagal menyimpan file video sumber.');
    });
  });

  app.post('/api/episodes/:episodeId/source-url', apiRateLimit, requireAuth, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const { episodeId } = req.params;
    if (!isSafeResourceId(episodeId)) {
      res.status(400).json({ error: 'Episode ID tidak valid.' });
      return;
    }

    const episode = db.getEpisodeForUser(uid, episodeId);
    if (!episode) {
      res.status(404).json({ error: 'Episode tidak ditemukan.' });
      return;
    }

    const { directVideoUrl } = (req.body ?? {}) as { directVideoUrl?: string };
    const trimmed = typeof directVideoUrl === 'string' ? directVideoUrl.trim() : '';
    if (trimmed) {
      const check = await validateSafeExternalUrl(trimmed);
      if (!check.valid) {
        res.status(400).json({ error: check.reason ?? 'URL video langsung ditolak demi keamanan.' });
        return;
      }
    }

    invalidateLowResSegmentCache(episodeId);
    db.upsertEpisode(uid, {
      ...episode,
      directVideoUrl: trimmed || undefined,
    });
    res.json({ ok: true, directVideoUrl: trimmed || null, store: buildUserStudioState(db, uid) });
  });

  // =========================================================================
  // RENDER QUEUE, SSE STREAM & SIGNED VIDEO STREAMING (PER-UID ISOLATED)
  // =========================================================================

  app.get('/api/render-jobs', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      jobs: db.listRenderJobs({ userUid: uid, limit, offset }),
    });
  });

  app.get('/api/render-jobs/active', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const active = renderJobManager.listActive(uid);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      activeCount: active.length,
      jobs: active.map((job) => ({
        jobId: job.jobId,
        clipId: job.clipId,
        status: job.status,
        stage: job.stage,
        progress: job.progress,
        elapsedMs: Date.now() - job.createdAt,
      })),
    });
  });

  app.post('/api/render-jobs/cancel-active', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const cancelledJobIds = renderJobManager.cancelAllRunning(
      'Semua proses render aktif dibatalkan oleh pengguna.',
      uid
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      cancelledCount: cancelledJobIds.length,
      cancelledJobIds,
    });
  });

  app.post('/api/render-jobs/:jobId/cancel', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    const isAdmin = user.role === 'admin' || user.role === 'super_admin';
    const { found, forbidden, wasRunning, job } = renderJobManager.cancel(
      req.params.jobId,
      'Proses render dibatalkan oleh pengguna.',
      { uid: user.uid, isAdmin }
    );
    if (forbidden) {
      res.status(403).json({ error: 'Anda tidak memiliki izin membatalkan render milik pengguna lain.' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      found,
      wasRunning,
      jobId: req.params.jobId,
      status: job?.status ?? 'missing',
    });
  });

  app.get('/api/render-jobs/:jobId', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    const isAdmin = user.role === 'admin' || user.role === 'super_admin';
    const job = renderJobManager.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Antrean render tidak ditemukan.' });
      return;
    }
    if (!isAdmin && job.userUid !== user.uid) {
      res.status(403).json({ error: 'Akses ke antrean render pengguna lain ditolak.' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      jobId: job.jobId,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      elapsedMs: Date.now() - job.createdAt,
      result: job.result,
      error: job.error,
      code: job.code,
    });
  });

  app.get('/api/render-jobs/:jobId/events', async (req: AuthenticatedRequest, res) => {
    const jobId = req.params.jobId;
    const job = renderJobManager.get(jobId);
    if (!job) {
      res.status(404).json({ error: 'Antrean render tidak ditemukan.' });
      return;
    }

    // Authorize via short-lived signed SSE stream token `?st=` OR Bearer header
    const streamToken = typeof req.query.st === 'string' ? req.query.st : '';
    let authorizedUid: string | null = null;
    let isAdmin = false;

    if (streamToken) {
      const verified = verifySignedStreamToken(streamToken, 'render_sse', jobId);
      if (verified) authorizedUid = verified.uid;
    }
    if (!authorizedUid) {
      try {
        const authUser = await authenticateRequest(req);
        authorizedUid = authUser.uid;
        isAdmin = authUser.role === 'admin' || authUser.role === 'super_admin';
      } catch {
        res.status(401).json({ error: 'Autentikasi diperlukan untuk stream progres render.' });
        return;
      }
    }

    if (!isAdmin && job.userUid !== authorizedUid) {
      res.status(403).json({ error: 'Akses ke stream render pengguna lain ditolak.' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let lastSentKey = '';
    let closed = false;
    const openedAt = Date.now();

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(tickTimer);
      clearInterval(keepAliveTimer);
    };

    const sendSnapshot = () => {
      if (closed) return;
      const current = renderJobManager.get(jobId);
      if (!current) {
        res.write(`event: missing\ndata: ${JSON.stringify({ error: 'Antrean render tidak ditemukan.' })}\n\n`);
        cleanup();
        res.end();
        return;
      }

      const key = `${current.status}|${current.progress}|${current.stage}`;
      if (key !== lastSentKey) {
        lastSentKey = key;
        const payload = {
          jobId: current.jobId,
          status: current.status,
          stage: current.stage,
          progress: current.progress,
          elapsedMs: Date.now() - current.createdAt,
          result: current.status === 'completed' ? current.result : undefined,
          error:
            current.status === 'failed' || current.status === 'cancelled'
              ? current.error
              : undefined,
          code:
            current.status === 'failed' || current.status === 'cancelled'
              ? current.code
              : undefined,
        };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }

      if (
        current.status === 'completed' ||
        current.status === 'failed' ||
        current.status === 'cancelled'
      ) {
        cleanup();
        res.end();
        return;
      }

      if (Date.now() - openedAt > 45_000) {
        res.write(`event: recycle\ndata: ${JSON.stringify({ jobId })}\n\n`);
        cleanup();
        res.end();
      }
    };

    sendSnapshot();
    const tickTimer = setInterval(sendSnapshot, 1000);
    const keepAliveTimer = setInterval(() => {
      if (!closed) res.write(': keepalive\n\n');
    }, 12_000);

    req.on('close', cleanup);
  });

  const v3Repo = new V3Repository(db);

  const handleEnqueueRender = async (
    req: AuthenticatedRequest,
    res: express.Response,
    explicitClipId?: string
  ) => {
    renderJobManager.pruneOld();
    const user = req.authUser!;
    const body = (req.body ?? {}) as {
      clipId?: string;
      layout?: ClipRenderLayout;
      quality?: ClipRenderQuality | string;
      renderProfile?: string;
      cameraSettings?: Partial<PodcastClip['cameraTrackingSettings']> | null;
      introTemplateConfig?: PodcastClip['introTemplateConfig'] | null;
      enableEmotionEffects?: boolean;
      enableAiIntro?: boolean;
      overlayStyle?: Partial<ClipOverlayStyle> | null;
      forceRestart?: boolean;
    };
    const clipId = explicitClipId ?? body.clipId;
    if (!clipId || !isSafeResourceId(clipId)) {
      res.status(400).json({ code: 'INVALID_RENDER_PARAMS', error: 'Parameter clipId tidak valid.' });
      return;
    }

    if (body.layout !== undefined && body.layout !== null && !isValidRenderLayoutInput(body.layout)) {
      res.status(400).json({
        code: 'INVALID_RENDER_PARAMS',
        error: 'Parameter layout rasio video tidak valid.',
      });
      return;
    }
    if (body.quality !== undefined && body.quality !== null && !isValidRenderQualityInput(body.quality)) {
      res.status(400).json({
        code: 'INVALID_RENDER_PARAMS',
        error: 'Parameter kualitas video harus "1080p" atau "4k".',
      });
      return;
    }
    if (
      body.renderProfile !== undefined &&
      body.renderProfile !== null &&
      body.renderProfile !== '' &&
      !isValidRenderProfileInput(body.renderProfile)
    ) {
      res.status(400).json({
        code: 'INVALID_RENDER_PARAMS',
        error: 'Parameter renderProfile tidak dikenal.',
      });
      return;
    }

    const clip = db.getClipForUser(user.uid, clipId);
    if (!clip) {
      res.status(404).json({ code: 'CLIP_NOT_FOUND', error: 'Klip tidak ditemukan atau bukan milik akun Anda.' });
      return;
    }
    const episode = db.getEpisodeForUser(user.uid, clip.episodeId);
    if (!episode) {
      res.status(404).json({ code: 'EPISODE_NOT_FOUND', error: 'Episode podcast sumber tidak ditemukan.' });
      return;
    }

    if (
      !Number.isFinite(clip.startSec) ||
      !Number.isFinite(clip.endSec) ||
      clip.startSec < 0 ||
      clip.endSec - clip.startSec < 2
    ) {
      res.status(422).json({
        code: 'INVALID_CLIP_RANGE',
        error: 'Rentang timestamp klip tidak valid untuk dirender (minimal 2 detik).',
      });
      return;
    }

    const automation = db.getUserAutomation(user.uid);
    const resolvedLayout = normalizeRenderLayout(body.layout ?? automation.defaultRenderLayout);
    const hasExplicitQuality =
      body.quality !== undefined && body.quality !== null && String(body.quality).trim() !== '';
    const hasExplicitProfile =
      typeof body.renderProfile === 'string' && body.renderProfile.trim() !== '';
    const requestedBaseQuality = resolveEffectiveRenderQuality({
      requestedQuality: body.quality,
      enableUltraHdRender: automation.enableUltraHdRender,
      defaultRenderQuality: automation.defaultRenderQuality,
    });

    let profileSpec: BalancedRenderProfileSpec;
    if (hasExplicitProfile) {
      profileSpec = resolveBalancedRenderProfile(body.renderProfile, requestedBaseQuality);
    } else if (hasExplicitQuality) {
      if (
        clip.renderProfile &&
        BALANCED_RENDER_PROFILES[clip.renderProfile]?.quality === requestedBaseQuality
      ) {
        profileSpec = resolveBalancedRenderProfile(clip.renderProfile, requestedBaseQuality);
      } else {
        profileSpec = resolveBalancedRenderProfile(undefined, requestedBaseQuality);
      }
    } else {
      profileSpec = resolveBalancedRenderProfile(clip.renderProfile, requestedBaseQuality);
    }
    const resolvedQuality = profileSpec.quality;

    let quotaSummary;
    try {
      quotaSummary = assertQuotaAvailable(db, user.uid, 'render', {
        videoDurationSec: episode.durationSec,
      });
      if (resolvedQuality === '4k') {
        quotaSummary = assertQuotaAvailable(db, user.uid, 'quality_4k');
      }
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        const currentSummary = getUserQuotaSummary(db, user.uid);
        res.status(err.status).json({
          code: err.code,
          resource: err.resource,
          error: err.message,
          currentPlan: currentSummary.planTier,
          maxExportQuality: currentSummary.maxExportQuality,
        });
        return;
      }
      res.status(500).json({
        code: 'QUOTA_CHECK_FAILED',
        error: sanitizePublicErrorMessage(err, 'Gagal memeriksa hak akses & kuota render.'),
      });
      return;
    }
    void quotaSummary;

    const resolvedEmotionEffects =
      typeof body.enableEmotionEffects === 'boolean'
        ? body.enableEmotionEffects
        : automation.enableAiEmotionEffects;
    const resolvedAiIntro =
      typeof body.enableAiIntro === 'boolean' ? body.enableAiIntro : automation.enableAiIntro;
    const resolvedOverlayStyle =
      body.overlayStyle !== undefined
        ? body.overlayStyle
          ? normalizeClipOverlayStyle(body.overlayStyle)
          : undefined
        : clip.overlayStyle;
    const storedCameraSettings = db.getCameraTrackingSettings(clip.id);
    const resolvedCameraSettings =
      body.cameraSettings !== undefined
        ? body.cameraSettings
          ? normalizeCameraTrackingSettings(clip.id, body.cameraSettings)
          : undefined
        : storedCameraSettings ?? clip.cameraTrackingSettings;
    const resolvedIntroConfig =
      body.introTemplateConfig !== undefined
        ? body.introTemplateConfig
          ? normalizeIntroTemplateDefinition(body.introTemplateConfig)
          : undefined
        : clip.introTemplateConfig;

    const styleFingerprint = computeOverlayStyleFingerprint(resolvedOverlayStyle);
    const targetDims = getTargetCanvasDimensions(resolvedLayout, resolvedQuality);
    const sourceFingerprint = computeSourceFingerprint({
      videoId: episode.videoId,
      sourceUrl: episode.sourceUrl,
      uploadedFileHash: getEpisodeSourceFingerprintTag(episode),
      startSec: clip.startSec,
      endSec: clip.endSec,
    });
    const renderFingerprint = computeRenderFingerprint({
      sourceFingerprint,
      startSec: clip.startSec,
      endSec: clip.endSec,
      renderProfile: profileSpec.id,
      resolution: `${targetDims.outW}x${targetDims.outH}`,
      codec: profileSpec.videoCodec,
      bitrateKbps: profileSpec.maxrateKbps,
      aspectRatio: resolvedLayout,
      captionConfig: clip.captionCues,
      introConfig: resolvedAiIntro ? resolvedIntroConfig ?? { enabled: true, styleFingerprint } : null,
      cameraSettings: resolvedCameraSettings ?? null,
      speakerOverrides: {
        locked: resolvedCameraSettings?.lockedSpeakerKey ?? null,
        ignored: resolvedCameraSettings?.ignoredSpeakerKeys ?? [],
      },
      layoutConfig: resolvedLayout,
      overlayStyle: resolvedOverlayStyle ?? null,
      audioSettings: {
        normalizeAudio: resolvedOverlayStyle?.normalizeAudio ?? true,
        emotionEffects: resolvedEmotionEffects,
        audioBitrateKbps: profileSpec.audioBitrateKbps,
      },
    });

    const dedupeKey = `${user.uid}:${clip.id}:${renderFingerprint}`;
    const initialStage = `Menyiapkan ${profileSpec.label}...`;

    const pgJobStore = options.pgJobStore ?? new PgRenderJobStore();
    const cloudQueueDispatchMode = Boolean(
      options.requireCloudTasksDispatch ||
        process.env.CLOUD_RENDER_DISPATCH_ENABLED === 'true' ||
        (process.env.NODE_ENV === 'production' && isCloudTasksConfigured())
    );
    const externalWorkerRequired = Boolean(
      options.requireExternalWorker || isCloudRunJobsConfigured() || cloudQueueDispatchMode
    );

    const { job, reused } = renderJobManager.createOrReuse({
      clipId: clip.id,
      userUid: user.uid,
      layout: resolvedLayout,
      quality: resolvedQuality,
      dedupeKey,
      initialStage,
      initialProgress: 8,
      forceRestart: Boolean(body.forceRestart),
      externalWorker: externalWorkerRequired,
    });

    let taskDispatch: { backend: string; taskName?: string; queueLatencyMs?: number } | null = null;
    let jobDispatch: { backend: string; executionName?: string } | null = null;

    if (!reused) {
      const workerJobPayload: Record<string, unknown> = {
        renderProfile: profileSpec.id,
        sourceFingerprint,
        renderFingerprint,
        layout: resolvedLayout,
        quality: resolvedQuality,
        enableEmotionEffects: resolvedEmotionEffects,
        enableAiIntro: resolvedAiIntro,
        overlayStyle: resolvedOverlayStyle ?? null,
        cameraSettings: resolvedCameraSettings ?? null,
        introTemplateConfig: resolvedIntroConfig ?? null,
      };

      db.upsertRenderJobCloudState({
        jobId: job.jobId,
        userUid: user.uid,
        clipId: clip.id,
        lifecycleStatus: 'queued',
        renderProfile: profileSpec.id,
        sourceFingerprint,
        renderFingerprint,
        payloadJson: workerJobPayload,
      });

      if (pgJobStore.isAvailable()) {
        await pgJobStore
          .createOrUpsertRenderJob({
            id: job.jobId,
            userUid: user.uid,
            projectId: episode.id,
            clipId: clip.id,
            status: 'queued',
            stage: initialStage,
            progress: 8,
            renderProfile: profileSpec.id,
            sourceFingerprint,
            renderFingerprint,
            payloadJson: workerJobPayload,
          })
          .catch(() => undefined);
      }

      if (cloudQueueDispatchMode) {
        // Production Cloud Architecture: API -> DB -> Cloud Tasks (OIDC) -> Dispatcher -> Cloud Run Jobs -> Worker
        const reqCorrelationRaw = String(req.headers['x-correlation-id'] ?? '').trim();
        const correlationId =
          reqCorrelationRaw.replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 128) || `corr_${job.jobId}`;
        try {
          taskDispatch = await enqueueCloudTaskExec({
            queue: 'video_render',
            idempotencyKey: `${job.jobId}:${renderFingerprint}`,
            correlationId,
            targetPath: '/api/internal/dispatch/render',
            dispatchDeadlineSec: 30,
            payload: {
              jobId: job.jobId,
              userUid: user.uid,
              clipId: clip.id,
              renderProfile: profileSpec.id,
              renderFingerprint,
              sourceFingerprint,
              correlationId,
            },
          });
          if (taskDispatch?.taskName) {
            db.upsertRenderJobCloudState({
              jobId: job.jobId,
              userUid: user.uid,
              clipId: clip.id,
              lifecycleStatus: 'queued',
              cloudTaskName: taskDispatch.taskName,
            });
          }
          await v3Repo.recordPerformanceMetric({
            userUid: user.uid,
            category: 'render',
            operation: 'queue_enqueue',
            durationMs: taskDispatch?.queueLatencyMs ?? 0,
            success: true,
            cacheHit: false,
            metadata: {
              jobId: job.jobId,
              correlationId,
              backend: taskDispatch?.backend ?? 'cloud_tasks',
            },
          });
          await v3Repo.recordJobEvent({
            jobId: job.jobId,
            jobType: 'render',
            userUid: user.uid,
            stage: 'queued',
            status: 'completed',
            message: 'Render job dimasukkan ke Google Cloud Tasks (OIDC dispatcher).',
            durationMs: taskDispatch?.queueLatencyMs ?? 0,
            metadata: {
              correlationId,
              queueBackend: taskDispatch?.backend,
              taskName: taskDispatch?.taskName,
              renderProfile: profileSpec.id,
              renderFingerprint,
            },
          });
        } catch (queueErr) {
          const queueErrMsg = sanitizePublicErrorMessage(
            queueErr,
            'Antrean Cloud Tasks sedang tidak tersedia. Render tidak dapat dijalankan.'
          );
          renderJobManager.fail(job.jobId, queueErrMsg, 'QUEUE_UNAVAILABLE');
          db.upsertRenderJobCloudState({
            jobId: job.jobId,
            userUid: user.uid,
            clipId: clip.id,
            lifecycleStatus: 'failed',
            failedStage: 'queued',
          });
          await v3Repo.recordJobEvent({
            jobId: job.jobId,
            jobType: 'render',
            userUid: user.uid,
            stage: 'queued',
            status: 'failed',
            message: queueErrMsg,
            metadata: { renderProfile: profileSpec.id, renderFingerprint },
          });
          res.status(503).json({
            code: 'QUEUE_UNAVAILABLE',
            error: queueErrMsg,
            jobId: job.jobId,
          });
          return;
        }
      } else {
        // Non-production / direct Cloud Run Jobs or local async mode (preserves Fase 0A compatibility)
        taskDispatch = await enqueueCloudTaskExec({
          queue: 'video_render',
          idempotencyKey: `${job.jobId}:${renderFingerprint}`,
          targetPath: '/api/internal/dispatch/render',
          payload: {
            jobId: job.jobId,
            userUid: user.uid,
            clipId: clip.id,
            renderProfile: profileSpec.id,
            renderFingerprint,
            sourceFingerprint,
          },
        }).catch(() => null);

        try {
          jobDispatch = await dispatchCloudRunJobExec(
            {
              renderJobId: job.jobId,
              userUid: user.uid,
              clipId: clip.id,
              renderProfile: profileSpec.id,
              renderFingerprint,
              sourceFingerprint,
            },
            options.cloudRunDeps
          );
          if (jobDispatch?.executionName) {
            db.attachCloudRunExecution(job.jobId, jobDispatch.executionName, taskDispatch?.taskName);
          }
        } catch (dispatchErr) {
          if (externalWorkerRequired) {
            const workerErrMsg = sanitizePublicErrorMessage(
              dispatchErr,
              'Layanan worker render sedang tidak tersedia. Coba beberapa saat lagi.'
            );
            renderJobManager.fail(job.jobId, workerErrMsg, 'WORKER_UNAVAILABLE');
            db.upsertRenderJobCloudState({
              jobId: job.jobId,
              userUid: user.uid,
              clipId: clip.id,
              lifecycleStatus: 'failed',
              failedStage: 'dispatching',
            });
            await v3Repo.recordJobEvent({
              jobId: job.jobId,
              jobType: 'render',
              userUid: user.uid,
              stage: 'dispatch_failed',
              status: 'failed',
              message: workerErrMsg,
              metadata: { renderProfile: profileSpec.id, renderFingerprint },
            });
            res.status(503).json({
              code: 'WORKER_UNAVAILABLE',
              error: workerErrMsg,
              jobId: job.jobId,
            });
            return;
          }
          jobDispatch = null;
        }
      }
    }

    const delegatedToCloudWorker = Boolean(
      cloudQueueDispatchMode || jobDispatch?.backend === 'cloud_run_jobs'
    );

    const sseToken = createSignedStreamToken({
      uid: user.uid,
      resourceId: job.jobId,
      scope: 'render_sse',
      ttlSec: 3600,
    });

    res.status(202).json({
      jobId: job.jobId,
      streamToken: sseToken,
      status: delegatedToCloudWorker ? 'queued' : job.status,
      stage: delegatedToCloudWorker ? 'Antrean Cloud Tasks / Cloud Run Jobs' : job.stage,
      progress: job.progress,
      quality: resolvedQuality,
      renderProfile: profileSpec.id,
      renderFingerprint,
      sourceFingerprint,
      executionMode: cloudQueueDispatchMode
        ? 'cloud_tasks_dispatcher'
        : jobDispatch?.backend === 'cloud_run_jobs'
          ? 'cloud_run_jobs'
          : 'local_async_worker',
      cloudTaskName: taskDispatch?.taskName ?? null,
      executionName: jobDispatch?.executionName ?? null,
      isUltraHd: resolvedQuality === '4k',
      targetWidth: profileSpec.id === 'fast_preview' && resolvedLayout !== 'full_16_9_focus' ? 720 : targetDims.outW,
      targetHeight: profileSpec.id === 'fast_preview' && resolvedLayout !== 'full_16_9_focus' ? 1280 : targetDims.outH,
    });

    if (reused || delegatedToCloudWorker) return;

    const jobSignal = job.abortController.signal;
    const renderStartedAt = Date.now();

    void (async () => {
      try {
        await v3Repo.recordJobEvent({
          jobId: job.jobId,
          jobType: 'render',
          userUid: user.uid,
          stage: 'dispatched',
          status: 'started',
          message: `Job render dimulai (${profileSpec.label}, fingerprint ${renderFingerprint.slice(0, 10)}).`,
          metadata: {
            queueBackend: taskDispatch?.backend ?? 'local_fallback',
            workerBackend: jobDispatch?.backend ?? 'local_worker_fallback',
            renderProfile: profileSpec.id,
            renderFingerprint,
          },
        });

        // Fast render fingerprint cache hit check (unless forceRestart)
        const cachedAsset = !body.forceRestart
          ? await v3Repo.findRenderAssetByFingerprint(user.uid, renderFingerprint)
          : null;
        if (
          cachedAsset &&
          cachedAsset.renderProfile === profileSpec.id &&
          cachedAsset.localPath &&
          fs.existsSync(cachedAsset.localPath) &&
          fs.statSync(cachedAsset.localPath).size > 10_000
        ) {
          renderJobManager.updateProgress(
            job.jobId,
            'Menggunakan cache hasil render (parameter identik)...',
            90
          );
          const canonicalOut = path.resolve(process.cwd(), 'data', 'renders', `${clip.id}.mp4`);
          fs.mkdirSync(path.dirname(canonicalOut), { recursive: true });
          if (path.resolve(cachedAsset.localPath) !== canonicalOut) {
            fs.copyFileSync(cachedAsset.localPath, canonicalOut);
          }
          const videoToken = createSignedStreamToken({
            uid: user.uid,
            resourceId: clip.id,
            scope: 'clip_video',
            ttlSec: 3600,
          });
          const videoUrl = `/api/clips/${clip.id}/video?st=${encodeURIComponent(videoToken)}&t=${Date.now()}`;
          const latestClip = db.getClipForUser(user.uid, clip.id) ?? clip;
          const cachedWasCapped =
            resolvedQuality === '4k' && Math.max(cachedAsset.width, cachedAsset.height) < 2160;
          const cachedEffectiveQuality: ClipRenderQuality = cachedWasCapped
            ? '1080p'
            : resolvedQuality;
          const updatedClip: PodcastClip = {
            ...latestClip,
            renderedClipUrl: `/api/clips/${clip.id}/video`,
            renderedLayout: resolvedLayout,
            renderedQuality: cachedEffectiveQuality,
            renderedFileSizeBytes: cachedAsset.sizeBytes,
            renderProfile: profileSpec.id,
            cameraTrackingSettings: resolvedCameraSettings ?? latestClip.cameraTrackingSettings,
            introTemplateConfig: resolvedIntroConfig ?? latestClip.introTemplateConfig,
          };
          db.upsertClip(user.uid, updatedClip);
          await v3Repo.recordJobEvent({
            jobId: job.jobId,
            jobType: 'render',
            userUid: user.uid,
            stage: 'cache_hit',
            status: 'completed',
            message: 'Render instan selesai dari cache fingerprint.',
            durationMs: Date.now() - renderStartedAt,
            metadata: { renderFingerprint, sizeBytes: cachedAsset.sizeBytes },
          });
          await v3Repo.recordPerformanceMetric({
            userUid: user.uid,
            category: 'render',
            operation: `render_${profileSpec.id}`,
            durationMs: Date.now() - renderStartedAt,
            success: true,
            cacheHit: true,
            metadata: { clipId: clip.id, sizeBytes: cachedAsset.sizeBytes },
          });
          renderJobManager.complete(job.jobId, {
            videoUrl,
            renderedClipUrl: videoUrl,
            sizeBytes: cachedAsset.sizeBytes,
            width: cachedAsset.width,
            height: cachedAsset.height,
            layout: resolvedLayout,
            quality: cachedEffectiveQuality,
            renderProfile: profileSpec.id,
            cacheHit: true,
            isUltraHd: cachedEffectiveQuality === '4k',
            upscalePrevented: cachedWasCapped,
            upscaleNote: cachedWasCapped
              ? `Sumber video hanya tersedia pada resolusi di bawah 4K. Cache menggunakan output ${cachedAsset.width}×${cachedAsset.height} tanpa upscaling otomatis.`
              : undefined,
            store: buildUserStudioState(db, user.uid),
          });
          return;
        }

        const result = await renderClipExec({
          episode,
          clip,
          layout: resolvedLayout,
          quality: resolvedQuality,
          renderProfile: profileSpec.id,
          cameraSettings: resolvedCameraSettings,
          introTemplateConfig: resolvedIntroConfig,
          sourceFingerprint,
          renderFingerprint,
          enableEmotionEffects: resolvedEmotionEffects,
          enableAiIntro: resolvedAiIntro,
          overlayStyle: resolvedOverlayStyle,
          signal: jobSignal,
          onProgress: (stage, progress) => {
            renderJobManager.updateProgress(job.jobId, stage, progress);
          },
        });
        if (jobSignal.aborted) return;

        const intel = result.intelligence;
        if (intel.cameraAnalysis) {
          await v3Repo.saveCameraAnalysis({
            userUid: user.uid,
            clip,
            episode,
            speakers: intel.cameraAnalysis.speakers,
            faceTracks: intel.cameraAnalysis.faceTracks,
            speakerSegments: intel.cameraAnalysis.speakerSegments,
            cameraSegments: intel.cameraAnalysis.cameraSegments,
          });
        }

        const storageOut = await finalizeRenderWorkerOutput({
          renderJobId: job.jobId,
          userUid: user.uid,
          clipId: clip.id,
          renderProfile: profileSpec.id,
          renderFingerprint,
          sourceFingerprint,
          localOutputPath: result.outputPath,
          width: result.width,
          height: result.height,
          durationSec: result.durationSec,
          db,
        });

        const videoToken = createSignedStreamToken({
          uid: user.uid,
          resourceId: clip.id,
          scope: 'clip_video',
          ttlSec: 3600,
        });
        const videoUrl = `/api/clips/${clip.id}/video?st=${encodeURIComponent(videoToken)}&t=${Date.now()}`;
        const isAudioAccurate = intel.subtitleSource === 'audio_transcribed';

        const latestClip = db.getClipForUser(user.uid, clip.id) ?? clip;
        const nextYoutubeCopy = {
          ...latestClip.platformCopies.youtube_shorts,
          title: isAudioAccurate ? intel.autoTitle : latestClip.platformCopies.youtube_shorts.title,
          caption: isAudioAccurate
            ? intel.autoCaption
            : latestClip.platformCopies.youtube_shorts.caption,
          hashtags: isAudioAccurate
            ? intel.hashtags
            : latestClip.platformCopies.youtube_shorts.hashtags,
        };

        const updatedClip: PodcastClip = {
          ...latestClip,
          userUid: user.uid,
          title: isAudioAccurate ? intel.autoTitle : latestClip.title,
          captionCues: intel.cues.length > 0 ? intel.cues : latestClip.captionCues,
          transcriptExcerpt: intel.verbatimTranscript || latestClip.transcriptExcerpt,
          renderedClipUrl: `/api/clips/${clip.id}/video`,
          renderedLayout: result.layout,
          renderedQuality: result.quality,
          renderProfile: result.renderProfile,
          renderedSourceWidth: result.sourceWidth,
          renderedSourceHeight: result.sourceHeight,
          renderedSourceType: result.sourceUsed,
          renderedFileSizeBytes: result.sizeBytes,
          subtitleAccuracySource: isAudioAccurate
            ? 'audio_transcribed'
            : episode.transcriptSource === 'youtube_captions'
              ? 'youtube_captions'
              : 'ai_estimated',
          autoGeneratedTitle: intel.autoTitle,
          autoGeneratedCaption: intel.autoCaption,
          speakerFocusSummary: intel.speakerFocusSummary,
          emotionSummary: intel.emotionSummary,
          emotionMoments: intel.emotionMoments,
          emotionEffectsEnabled: result.emotionEffectsEnabled,
          introEnabled: result.introEnabled,
          introTag: result.resolvedIntro.tag,
          introHeadline: result.resolvedIntro.headline,
          introTeaser: result.resolvedIntro.teaser,
          introDurationSec: result.resolvedIntro.durationSec,
          overlayStyle: resolvedOverlayStyle ?? latestClip.overlayStyle,
          cameraTrackingSettings:
            intel.cameraAnalysis?.settings ??
            resolvedCameraSettings ??
            latestClip.cameraTrackingSettings,
          introTemplateConfig: resolvedIntroConfig ?? latestClip.introTemplateConfig,
          platformCopies: {
            ...latestClip.platformCopies,
            youtube_shorts: nextYoutubeCopy,
          },
        };

        db.upsertClip(user.uid, updatedClip);
        consumeQuota(db, user.uid, 'render', result.sizeBytes);

        const totalDurationMs = Date.now() - renderStartedAt;
        await v3Repo.recordJobEvent({
          jobId: job.jobId,
          jobType: 'render',
          userUid: user.uid,
          stage: 'completed',
          status: 'completed',
          message: `Render ${profileSpec.label} selesai (${result.width}x${result.height}, ${storageOut.storageBackend}).`,
          durationMs: totalDurationMs,
          metadata: {
            storageBackend: storageOut.storageBackend,
            gcsUri: storageOut.gcsUri,
            sizeBytes: result.sizeBytes,
            renderFingerprint,
            upscalePrevented: result.upscalePrevented,
          },
        });
        await v3Repo.recordPerformanceMetric({
          userUid: user.uid,
          category: 'render',
          operation: `render_${profileSpec.id}`,
          durationMs: totalDurationMs,
          success: true,
          cacheHit: false,
          metadata: {
            clipId: clip.id,
            sizeBytes: result.sizeBytes,
            width: result.width,
            height: result.height,
          },
        });

        db.createNotification({
          userUid: user.uid,
          type: 'render_complete',
          title: 'Render Video Klip Selesai',
          message: `Klip "${updatedClip.title.slice(0, 60)}" siap diunduh (${profileSpec.label}).`,
          relatedId: updatedClip.id,
        });

        renderJobManager.complete(job.jobId, {
          videoUrl,
          renderedClipUrl: videoUrl,
          sizeBytes: result.sizeBytes,
          width: result.width,
          height: result.height,
          sourceWidth: result.sourceWidth,
          sourceHeight: result.sourceHeight,
          sourceUsed: result.sourceUsed,
          layout: result.layout,
          quality: result.quality,
          renderProfile: result.renderProfile,
          storageBackend: storageOut.storageBackend,
          cacheHit: false,
          isUltraHd: result.quality === '4k',
          upscalePrevented: result.upscalePrevented,
          upscaleNote: result.upscaleNote,
          emotionEffectsEnabled: result.emotionEffectsEnabled,
          emotionMoments: intel.emotionMoments,
          emotionSummary: intel.emotionSummary,
          introEnabled: result.introEnabled,
          intro: result.resolvedIntro,
          subtitleSource: intel.subtitleSource,
          speakerFocusSummary: intel.speakerFocusSummary,
          cameraAnalysis: intel.cameraAnalysis,
          autoTitle: intel.autoTitle,
          autoCaption: intel.autoCaption,
          store: buildUserStudioState(db, user.uid),
        });
      } catch (err) {
        if (err instanceof RenderCancelledError || jobSignal.aborted) {
          await v3Repo.recordJobEvent({
            jobId: job.jobId,
            jobType: 'render',
            userUid: user.uid,
            stage: 'cancelled',
            status: 'cancelled',
            message: 'Proses render dibatalkan.',
            durationMs: Date.now() - renderStartedAt,
          });
          renderJobManager.cancel(job.jobId, 'Proses render dibatalkan.');
          return;
        }
        const errorCode =
          err instanceof YoutubeBotCheckError
            ? err.code
            : err instanceof RenderTimeoutError
              ? err.code
              : 'WORKER_FAILED';
        const safeErr =
          err instanceof YoutubeBotCheckError || err instanceof RenderTimeoutError
            ? err.message
            : sanitizePublicErrorMessage(err, 'Gagal merender video klip MP4.');
        await v3Repo.recordJobEvent({
          jobId: job.jobId,
          jobType: 'render',
          userUid: user.uid,
          stage: 'failed',
          status: 'failed',
          message: safeErr,
          durationMs: Date.now() - renderStartedAt,
          metadata: { errorCode },
        });
        await v3Repo.recordPerformanceMetric({
          userUid: user.uid,
          category: 'render',
          operation: `render_${profileSpec.id}`,
          durationMs: Date.now() - renderStartedAt,
          success: false,
          cacheHit: false,
          metadata: { clipId: clip.id, error: safeErr, errorCode },
        });
        renderJobManager.fail(job.jobId, safeErr, errorCode);
        db.createNotification({
          userUid: user.uid,
          type: 'render_failed',
          title: 'Render Video Klip Gagal',
          message: safeErr,
          relatedId: clip.id,
        });
      }
    })();
  };

  app.post('/api/clips/:clipId/render-mp4', renderRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    void handleEnqueueRender(req, res, req.params.clipId);
  });

  app.post('/api/render', renderRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    void handleEnqueueRender(req, res);
  });

  app.get('/api/clips/:clipId/video', async (req: AuthenticatedRequest, res) => {
    const { clipId } = req.params;
    if (!isSafeResourceId(clipId)) {
      res.status(400).json({ error: 'Clip ID tidak valid.' });
      return;
    }

    const record = db.getClipByIdInternal(clipId);
    if (!record) {
      res.status(404).json({ error: 'Klip tidak ditemukan.' });
      return;
    }

    const streamToken = typeof req.query.st === 'string' ? req.query.st : '';
    let authorizedUid: string | null = null;
    let isAdmin = false;

    if (streamToken) {
      const verified = verifySignedStreamToken(streamToken, 'clip_video', clipId);
      if (verified) authorizedUid = verified.uid;
    }
    if (!authorizedUid) {
      try {
        const authUser = await authenticateRequest(req);
        authorizedUid = authUser.uid;
        isAdmin = authUser.role === 'admin' || authUser.role === 'super_admin';
      } catch {
        res.status(401).json({ error: 'Autentikasi diperlukan untuk mengakses file video.' });
        return;
      }
    }

    if (!isAdmin && record.userUid !== authorizedUid) {
      res.status(403).json({ error: 'Anda tidak memiliki akses ke file video milik pengguna lain.' });
      return;
    }

    const videoPath = getRenderedClipPath(clipId);
    if (!videoPath) {
      res.status(404).json({ error: 'File video klip MP4 belum dirender.' });
      return;
    }

    const stat = fs.statSync(videoPath);
    const totalSize = stat.size;
    const isDownload = req.query.download === '1' || req.query.download === 'true';

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, no-cache');

    if (isDownload) {
      res.setHeader('Content-Disposition', `attachment; filename="klip_${clipId}.mp4"`);
    }

    const rangeHeader = req.headers.range;
    if (rangeHeader && !isDownload) {
      const resolved = resolveCappedByteRange(rangeHeader, totalSize);
      if (resolved) {
        if (resolved.status === 416) {
          res.status(416);
          res.setHeader('Content-Range', resolved.contentRange);
          res.end();
          return;
        }
        res.status(206);
        res.setHeader('Content-Range', resolved.contentRange);
        res.setHeader('Content-Length', String(resolved.chunkLength));
        const stream = fs.createReadStream(videoPath, {
          start: resolved.start,
          end: resolved.end,
        });
        stream.on('error', () => {
          if (!res.headersSent) res.status(500).end();
          else res.end();
        });
        req.on('close', () => stream.destroy());
        stream.pipe(res);
        return;
      }
    }

    res.status(200);
    res.setHeader('Content-Length', String(totalSize));
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(videoPath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    req.on('close', () => stream.destroy());
    stream.pipe(res);
  });

  // =========================================================================
  // AI CONTENT STUDIO ENDPOINTS (HOOKS, REPURPOSE, SUBTITLE POLISH, ASSISTANT)
  // =========================================================================

  app.post('/api/ai/hooks', aiRateLimit, requireAuth, async (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    try {
      const { clipId, tones } = (req.body ?? {}) as {
        clipId?: string;
        tones?: HookStyleTone[];
      };
      if (!clipId || !isSafeResourceId(clipId)) {
        res.status(400).json({ error: 'Pilih klip yang valid terlebih dahulu.' });
        return;
      }
      const clip = db.getClipForUser(user.uid, clipId);
      if (!clip) {
        res.status(404).json({ error: 'Klip tidak ditemukan.' });
        return;
      }
      const episode = db.getEpisodeForUser(user.uid, clip.episodeId);
      if (!episode) {
        res.status(404).json({ error: 'Episode sumber tidak ditemukan.' });
        return;
      }

      assertQuotaAvailable(db, user.uid, 'ai');
      const { variants, usage } = await generateViralHooksForClip({ clip, episode, tones });
      trackGeminiApiUsage(db, {
        userUid: user.uid,
        operation: 'ai_hook_generator',
        model: usage.model,
        promptTokens: usage.promptTokens,
        outputTokens: usage.outputTokens,
      });
      consumeQuota(db, user.uid, 'ai');

      res.json({ variants, quota: getUserQuotaSummary(db, user.uid) });
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        res.status(err.status).json({ code: err.code, error: err.message });
        return;
      }
      res.status(500).json({
        error: sanitizePublicErrorMessage(err, 'Gagal menghasilkan variasi hook AI.'),
      });
    }
  });

  app.post('/api/ai/repurpose', aiRateLimit, requireAuth, async (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    try {
      const { clipId } = (req.body ?? {}) as { clipId?: string };
      if (!clipId || !isSafeResourceId(clipId)) {
        res.status(400).json({ error: 'Pilih klip yang valid terlebih dahulu.' });
        return;
      }
      const clip = db.getClipForUser(user.uid, clipId);
      if (!clip) {
        res.status(404).json({ error: 'Klip tidak ditemukan.' });
        return;
      }
      const episode = db.getEpisodeForUser(user.uid, clip.episodeId);
      if (!episode) {
        res.status(404).json({ error: 'Episode sumber tidak ditemukan.' });
        return;
      }

      assertQuotaAvailable(db, user.uid, 'ai');
      const { bundle, platformCopies, usage } = await generateRepurposedContentForClip({
        clip,
        episode,
      });

      const updatedClip: PodcastClip = {
        ...clip,
        repurposedContent: bundle,
        ...(platformCopies ? { platformCopies } : {}),
      };
      db.upsertClip(user.uid, updatedClip);

      trackGeminiApiUsage(db, {
        userUid: user.uid,
        operation: 'ai_content_repurpose',
        model: usage.model,
        promptTokens: usage.promptTokens,
        outputTokens: usage.outputTokens,
      });
      consumeQuota(db, user.uid, 'ai');

      res.json({
        bundle,
        clip: updatedClip,
        store: buildUserStudioState(db, user.uid),
      });
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        res.status(err.status).json({ code: err.code, error: err.message });
        return;
      }
      res.status(500).json({
        error: sanitizePublicErrorMessage(err, 'Gagal membuat paket repurposing konten AI.'),
      });
    }
  });

  app.post('/api/ai/subtitle-polish', aiRateLimit, requireAuth, async (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    try {
      const { clipId } = (req.body ?? {}) as { clipId?: string };
      if (!clipId || !isSafeResourceId(clipId)) {
        res.status(400).json({ error: 'Pilih klip yang valid terlebih dahulu.' });
        return;
      }
      const clip = db.getClipForUser(user.uid, clipId);
      if (!clip) {
        res.status(404).json({ error: 'Klip tidak ditemukan.' });
        return;
      }

      assertQuotaAvailable(db, user.uid, 'ai');
      const { cues, usage } = await polishSubtitlesMeaningSafe(clip.captionCues);
      const updatedClip: PodcastClip = { ...clip, captionCues: cues };
      db.upsertClip(user.uid, updatedClip);

      trackGeminiApiUsage(db, {
        userUid: user.uid,
        operation: 'ai_subtitle_polish',
        model: usage.model,
        promptTokens: usage.promptTokens,
        outputTokens: usage.outputTokens,
      });
      consumeQuota(db, user.uid, 'ai');

      res.json({
        cues,
        clip: updatedClip,
        store: buildUserStudioState(db, user.uid),
      });
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        res.status(err.status).json({ code: err.code, error: err.message });
        return;
      }
      res.status(500).json({
        error: sanitizePublicErrorMessage(err, 'Gagal merapikan subtitle dengan AI.'),
      });
    }
  });

  app.post('/api/ai/assistant', aiRateLimit, requireAuth, async (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    try {
      const { episodeId, question, history } = (req.body ?? {}) as {
        episodeId?: string;
        question?: string;
        history?: Array<{ role: 'user' | 'assistant'; content: string }>;
      };
      if (!episodeId || !isSafeResourceId(episodeId)) {
        res.status(400).json({ error: 'Pilih episode terlebih dahulu.' });
        return;
      }
      if (!question || typeof question !== 'string' || question.trim().length < 2) {
        res.status(400).json({ error: 'Tulis pertanyaan untuk asisten AI.' });
        return;
      }
      if (question.length > 2000) {
        res.status(400).json({ error: 'Pertanyaan maksimal 2000 karakter.' });
        return;
      }

      const episode = db.getEpisodeForUser(user.uid, episodeId);
      if (!episode) {
        res.status(404).json({ error: 'Episode tidak ditemukan.' });
        return;
      }
      const clips = db.listUserClips(user.uid, 100, 0).filter((c) => c.episodeId === episodeId);

      assertQuotaAvailable(db, user.uid, 'ai');
      const { answer, usage } = await askGroundedEpisodeAssistant({
        episode,
        clips,
        question,
        history,
      });

      trackGeminiApiUsage(db, {
        userUid: user.uid,
        operation: 'ai_episode_assistant',
        model: usage.model,
        promptTokens: usage.promptTokens,
        outputTokens: usage.outputTokens,
      });
      consumeQuota(db, user.uid, 'ai');

      res.json({ answer, quota: getUserQuotaSummary(db, user.uid) });
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        res.status(err.status).json({ code: err.code, error: err.message });
        return;
      }
      res.status(500).json({
        error: sanitizePublicErrorMessage(err, 'Gagal menghubungi asisten AI.'),
      });
    }
  });

  // =========================================================================
  // ADMIN CONTROL CENTER (STRICTLY admin / super_admin VIA SERVER-SIDE RBAC)
  // =========================================================================

  app.get('/api/admin/overview', apiRateLimit, requireAuth, requireAdmin, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(buildRealAdminOverview(db));
  });

  app.get('/api/admin/users', apiRateLimit, requireAuth, requireAdmin, (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      users: db.listUsersForAdmin({ search, limit, offset }),
    });
  });

  app.patch(
    '/api/admin/users/:uid/status',
    apiRateLimit,
    requireAuth,
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const actor = req.authUser!;
      const targetUid = req.params.uid;
      const { status } = (req.body ?? {}) as { status?: 'active' | 'suspended' };

      if (status !== 'active' && status !== 'suspended') {
        res.status(400).json({ error: 'Status akun harus "active" atau "suspended".' });
        return;
      }
      if (targetUid === actor.uid) {
        res.status(400).json({ error: 'Anda tidak dapat menangguhkan akun Anda sendiri.' });
        return;
      }

      const target = db.getUser(targetUid);
      if (!target) {
        res.status(404).json({ error: 'Pengguna tidak ditemukan.' });
        return;
      }
      if (target.role === 'super_admin' && actor.role !== 'super_admin') {
        res.status(403).json({ error: 'Hanya Super Admin yang dapat mengubah status Super Admin.' });
        return;
      }

      db.setUserStatus(targetUid, status);
      if (status === 'suspended') {
        db.revokeUserSessions(targetUid, Math.floor(Date.now() / 1000) + 1);
      }

      db.createNotification({
        userUid: targetUid,
        type: 'account_status',
        title: status === 'suspended' ? 'Akun Ditangguhkan' : 'Akun Diaktifkan Kembali',
        message:
          status === 'suspended'
            ? 'Akun Anda telah ditangguhkan oleh administrator.'
            : 'Akun Anda telah diaktifkan kembali oleh administrator.',
      });

      db.insertAuditLog({
        actorUid: actor.uid,
        actorEmail: actor.email,
        action: `admin.user_status_${status}`,
        targetType: 'user',
        targetId: targetUid,
        metadata: { previousStatus: target.status, nextStatus: status, targetEmail: target.email },
        ipAddress: getClientIp(req),
      });

      res.json({ ok: true, uid: targetUid, status });
    }
  );

  app.patch(
    '/api/admin/users/:uid/role',
    apiRateLimit,
    requireAuth,
    requireSuperAdmin,
    (req: AuthenticatedRequest, res) => {
      const actor = req.authUser!;
      const targetUid = req.params.uid;
      const { role } = (req.body ?? {}) as { role?: UserRole };

      if (role !== 'user' && role !== 'admin' && role !== 'super_admin') {
        res.status(400).json({ error: 'Role tidak valid. Gunakan user, admin, atau super_admin.' });
        return;
      }
      if (targetUid === actor.uid && role !== 'super_admin') {
        res.status(400).json({ error: 'Super Admin tidak dapat menurunkan perannya sendiri.' });
        return;
      }

      const target = db.getUser(targetUid);
      if (!target) {
        res.status(404).json({ error: 'Pengguna tidak ditemukan.' });
        return;
      }

      db.setUserRole(targetUid, role);
      db.insertAuditLog({
        actorUid: actor.uid,
        actorEmail: actor.email,
        action: 'super_admin.update_user_role',
        targetType: 'user',
        targetId: targetUid,
        metadata: { previousRole: target.role, nextRole: role, targetEmail: target.email },
        ipAddress: getClientIp(req),
      });

      res.json({ ok: true, uid: targetUid, role });
    }
  );

  app.patch(
    '/api/admin/users/:uid/plan',
    apiRateLimit,
    requireAuth,
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const actor = req.authUser!;
      const targetUid = req.params.uid;
      const { planTier } = (req.body ?? {}) as { planTier?: PlanTier };

      if (!planTier || !['free', 'starter', 'pro', 'business'].includes(planTier)) {
        res.status(400).json({ error: 'Plan tier tidak valid.' });
        return;
      }

      const target = db.getUser(targetUid);
      if (!target) {
        res.status(404).json({ error: 'Pengguna tidak ditemukan.' });
        return;
      }

      const updated = db.updateUserPlan(targetUid, planTier);
      const v2Repo = new V2Repository(db);
      const planInfo = v2Repo.getSystemSettings().plans[planTier];
      v2Repo.insertBillingRecord({
        userUid: targetUid,
        planTier,
        amountIdr: planInfo?.monthlyPriceIdr ?? 0,
        provider: 'manual_admin',
        status: 'recorded_manual',
        notes: `Paket diperbarui oleh ${actor.email ?? actor.uid}`,
      });
      db.insertAuditLog({
        actorUid: actor.uid,
        actorEmail: actor.email,
        action: 'admin.update_user_plan',
        targetType: 'subscription',
        targetId: targetUid,
        metadata: { nextPlan: planTier, targetEmail: target.email },
        ipAddress: getClientIp(req),
      });

      res.json({ ok: true, subscription: updated });
    }
  );

  app.get('/api/admin/ai-usage', apiRateLimit, requireAuth, requireAdmin, (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    res.setHeader('Cache-Control', 'no-store');
    res.json(db.getAiUsageBreakdown(limit));
  });

  app.get('/api/admin/renders', apiRateLimit, requireAuth, requireAdmin, (req, res) => {
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      activeInMemory: renderJobManager.listActive().length,
      jobs: db.listRenderJobs({ status, limit, offset }),
    });
  });

  app.post(
    '/api/admin/renders/:jobId/cancel',
    apiRateLimit,
    requireAuth,
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const actor = req.authUser!;
      const { found, wasRunning, job } = renderJobManager.cancel(
        req.params.jobId,
        'Proses render dihentikan oleh administrator.',
        { uid: actor.uid, isAdmin: true }
      );
      db.insertAuditLog({
        actorUid: actor.uid,
        actorEmail: actor.email,
        action: 'admin.cancel_render_job',
        targetType: 'render_job',
        targetId: req.params.jobId,
        metadata: { found, wasRunning },
        ipAddress: getClientIp(req),
      });
      res.json({ ok: true, found, wasRunning, status: job?.status ?? 'missing' });
    }
  );

  app.get('/api/admin/audit-logs', apiRateLimit, requireAuth, requireAdmin, (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ logs: db.listAuditLogs(limit, offset) });
  });

  app.post(
    '/api/admin/backup',
    apiRateLimit,
    requireAuth,
    requireSuperAdmin,
    (req: AuthenticatedRequest, res) => {
      const actor = req.authUser!;
      const snapshot = db.createDatabaseBackupSnapshot();
      db.insertAuditLog({
        actorUid: actor.uid,
        actorEmail: actor.email,
        action: 'super_admin.create_backup',
        targetType: 'database',
        metadata: { sizeBytes: snapshot.sizeBytes, createdAt: snapshot.createdAt },
        ipAddress: getClientIp(req),
      });
      res.json({
        ok: true,
        sizeBytes: snapshot.sizeBytes,
        createdAt: snapshot.createdAt,
        fileName: path.basename(snapshot.backupFilePath),
      });
    }
  );

  // Mount modular AICLIPER 2.0 & V3 Production routes (/api/v2/* and /api/v3/*)
  app.use(
    '/api/v2',
    createV2Router({
      db,
      requireAuth,
      requireAdmin,
      requireSuperAdmin,
      apiRateLimit,
      aiRateLimit,
      getClientIp,
    })
  );

  app.use(
    '/api/v3',
    createV3Router({
      db,
      requireAuth,
      apiRateLimit,
      renderRateLimit,
      onEnqueueRender: handleEnqueueRender,
    })
  );

  // Authenticated Cloud Tasks -> Cloud Run Jobs Internal Render Dispatcher
  const internalDispatchRouter = createInternalDispatchRouter({
    db,
    v3Repo,
    pgJobStore: options.pgJobStore,
    oidcConfigOverride: options.oidcConfigOverride,
    verifyIdTokenFn: options.verifyOidcIdTokenFn,
    dispatchCloudRunJobFn: dispatchCloudRunJobExec,
    cloudRunDeps: options.cloudRunDeps,
    strictProduction: options.requireExternalWorker,
  });
  app.use('/api/internal/dispatch', internalDispatchRouter);
  app.use('/workers/render', internalDispatchRouter);

  // Final sanitized Express error handler (never leaks stack traces)
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      if (res.headersSent) return;
      res.status(500).json({
        error: sanitizePublicErrorMessage(err, 'Terjadi kesalahan internal server.'),
      });
    }
  );

  return { app, db, renderJobManager };
}

async function startServer() {
  const { app } = createApp();
  const PORT = Number(process.env.PORT) || 3000;

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`KlipCast server listening on http://localhost:${PORT}`);
  });

  const gracefulShutdown = (signal: string) => {
    console.log(`[Server] Received ${signal}, shutting down gracefully...`);
    httpServer.close(() => {
      void closePgPool().finally(() => process.exit(0));
    });
  };
  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.once('SIGINT', () => gracefulShutdown('SIGINT'));
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFilePath)) {
  startServer().catch((err) => {
    console.error('Failed to start KlipCast server:', err);
    process.exit(1);
  });
}
