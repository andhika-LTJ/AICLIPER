import express from 'express';
import fs from 'fs';
import path from 'path';
import type { KlipCastDatabase } from '../db.ts';
import type { AuthenticatedRequest } from '../authMiddleware.ts';
import { V3Repository } from '../repositories/v3Repository.ts';
import { recalculateClipCameraAnalysis } from '../clipIntelligence.ts';
import {
  normalizeCameraTrackingSettings,
  runActiveSpeakerBenchmark,
  type AudioSpeechWindow,
} from '../services/activeSpeakerEngine.ts';
import {
  compileIntroTemplateForFfmpeg,
  normalizeIntroTemplateDefinition,
} from '../services/introRenderCompiler.ts';
import {
  BALANCED_RENDER_PROFILES,
  computeSourceFingerprint,
} from '../services/renderFingerprint.ts';
import { getGcsReadinessStatus, isGcsConfigured } from '../services/gcsStorageService.ts';
import { getCloudTasksReadinessStatus } from '../services/cloudTasksService.ts';
import { getCloudRunJobsReadinessStatus } from '../services/cloudRunJobsService.ts';
import { checkPgHealth, isPostgresConfigured } from '../../src/db/index.ts';
import { ensureFfmpegPath, ensureFfprobePath } from '../ffmpegBinaries.ts';
import {
  GLOBAL_INTRO_TEMPLATES,
  INTRO_TEMPLATE_CATEGORIES,
} from '../../src/data/introTemplatesCatalog.ts';
import { isSafeResourceId, sanitizePublicErrorMessage } from '../security.ts';
import type {
  CameraTrackingSegment,
  CameraTrackingSettings,
  FaceTrackCandidate,
  IntroTemplateCategory,
  IntroTemplateDefinition,
  PodcastClip,
} from '../../src/types/clipper.ts';

export interface CreateV3RouterDeps {
  db: KlipCastDatabase;
  requireAuth: express.RequestHandler;
  apiRateLimit: express.RequestHandler;
  renderRateLimit: express.RequestHandler;
  onEnqueueRender: (req: AuthenticatedRequest, res: express.Response, explicitClipId?: string) => void;
}

const LOCAL_STORAGE_ROOT = path.resolve(process.cwd(), 'data', 'storage');

function sanitizeUidPrefix(uid: string): string {
  return uid.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_').slice(0, 120) || 'item';
}

export function createV3Router(deps: CreateV3RouterDeps): express.Router {
  const router = express.Router();
  const repo = new V3Repository(deps.db);

  // =========================================================================
  // 1. INTELLIGENT ACTIVE SPEAKER & CAMERA STUDIO
  // =========================================================================

  router.get('/clips/:clipId/camera', deps.apiRateLimit, deps.requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const uid = req.authUser!.uid;
      const { clipId } = req.params;
      if (!isSafeResourceId(clipId)) {
        res.status(400).json({ error: 'Clip ID tidak valid.' });
        return;
      }

      const clip = deps.db.getClipForUser(uid, clipId);
      if (!clip) {
        res.status(404).json({ error: 'Klip tidak ditemukan.' });
        return;
      }

      const data = await repo.getCameraData(clipId);
      res.json({
        clipId,
        durationSec: Math.max(2, clip.endSec - clip.startSec),
        ...data,
      });
    } catch (err) {
      res.status(500).json({ error: sanitizePublicErrorMessage(err, 'Gagal memuat data kamera klip.') });
    }
  });

  router.put('/clips/:clipId/camera', deps.apiRateLimit, deps.requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const uid = req.authUser!.uid;
      const { clipId } = req.params;
      if (!isSafeResourceId(clipId)) {
        res.status(400).json({ error: 'Clip ID tidak valid.' });
        return;
      }

      const clip = deps.db.getClipForUser(uid, clipId);
      if (!clip) {
        res.status(404).json({ error: 'Klip tidak ditemukan.' });
        return;
      }
      const episode = deps.db.getEpisodeForUser(uid, clip.episodeId);
      const body = (req.body ?? {}) as {
        settings?: Partial<CameraTrackingSettings>;
        cameraSegments?: CameraTrackingSegment[];
        lockedSpeakerKey?: string | null;
        ignoredSpeakerKeys?: string[];
      };

      const existingData = await repo.getCameraData(clipId);
      const mergedSettings = normalizeCameraTrackingSettings(clipId, {
        ...existingData.settings,
        ...(body.settings ?? {}),
        ...(body.lockedSpeakerKey !== undefined ? { lockedSpeakerKey: body.lockedSpeakerKey } : {}),
        ...(Array.isArray(body.ignoredSpeakerKeys)
          ? { ignoredSpeakerKeys: body.ignoredSpeakerKeys }
          : {}),
      });

      const savedSettings = await repo.saveCameraSettings({
        userUid: uid,
        clip,
        episode,
        settings: mergedSettings,
      });

      let nextCameraSegments = existingData.cameraSegments;
      let nextSpeakers = existingData.speakers;

      if (Array.isArray(body.cameraSegments) && body.cameraSegments.length > 0) {
        nextCameraSegments = body.cameraSegments.map((seg, i) => ({
          id: seg.id || `cam_${clipId}_${i}`,
          clipId,
          startSec: Number(seg.startSec) || 0,
          endSec: Number(seg.endSec) || Math.max(2, clip.endSec - clip.startSec),
          activeSpeakerKey: String(seg.activeSpeakerKey || 'none'),
          framingMode: seg.framingMode || savedSettings.framingMode,
          layoutMode: seg.layoutMode || savedSettings.multiSpeakerLayout,
          targetX: Number.isFinite(seg.targetX) ? Math.max(0.05, Math.min(0.95, seg.targetX)) : 0.5,
          targetY: Number.isFinite(seg.targetY) ? Math.max(0.1, Math.min(0.85, seg.targetY)) : 0.4,
          zoom: Number.isFinite(seg.zoom) ? Math.max(1.0, Math.min(2.0, seg.zoom)) : 1.15,
          confidence: Number.isFinite(seg.confidence) ? seg.confidence : 0.9,
          reason: seg.isManualOverride ? 'manual_override' : seg.reason || 'auto_active_speaker',
          isManualOverride: Boolean(seg.isManualOverride),
        }));
      }

      if (existingData.speakers.length > 0) {
        const ignoredSet = new Set(savedSettings.ignoredSpeakerKeys);
        nextSpeakers = existingData.speakers.map((s) => ({
          ...s,
          isLocked: savedSettings.lockedSpeakerKey === s.speakerKey,
          isIgnored: ignoredSet.has(s.speakerKey),
        }));
      }

      if (
        Array.isArray(body.cameraSegments) ||
        body.lockedSpeakerKey !== undefined ||
        Array.isArray(body.ignoredSpeakerKeys)
      ) {
        await repo.saveCameraAnalysis({
          userUid: uid,
          clip,
          episode,
          speakers: nextSpeakers,
          faceTracks: existingData.faceTracks,
          speakerSegments: existingData.speakerSegments,
          cameraSegments: nextCameraSegments,
        });
      }

      res.json({
        ok: true,
        clipId,
        settings: savedSettings,
        speakers: nextSpeakers,
        cameraSegments: nextCameraSegments,
      });
    } catch (err) {
      res.status(500).json({ error: sanitizePublicErrorMessage(err, 'Gagal menyimpan pengaturan kamera.') });
    }
  });

  router.post(
    '/clips/:clipId/camera/recalculate',
    deps.apiRateLimit,
    deps.requireAuth,
    async (req: AuthenticatedRequest, res) => {
      const startedAt = Date.now();
      try {
        const uid = req.authUser!.uid;
        const { clipId } = req.params;
        if (!isSafeResourceId(clipId)) {
          res.status(400).json({ error: 'Clip ID tidak valid.' });
          return;
        }

        const clip = deps.db.getClipForUser(uid, clipId);
        if (!clip) {
          res.status(404).json({ error: 'Klip tidak ditemukan.' });
          return;
        }
        const episode = deps.db.getEpisodeForUser(uid, clip.episodeId);
        const body = (req.body ?? {}) as { settings?: Partial<CameraTrackingSettings> };
        const current = await repo.getCameraData(clipId);
        const nextSettings = normalizeCameraTrackingSettings(clipId, {
          ...current.settings,
          ...(body.settings ?? {}),
        });

        await repo.saveCameraSettings({
          userUid: uid,
          clip,
          episode,
          settings: nextSettings,
        });

        const durationSec = Math.max(5, clip.endSec - clip.startSec);
        const srcFp = computeSourceFingerprint({
          videoId: episode?.videoId,
          sourceUrl: episode?.sourceUrl,
          startSec: clip.startSec,
          endSec: clip.endSec,
        });
        const tmpDir = path.resolve(process.cwd(), 'data', 'tmp');
        const fpIntelPath = path.join(tmpDir, `intel_src_${srcFp}.json`);
        const legacyIntelPath = path.join(
          tmpDir,
          `intel_${clip.id}_${clip.startSec}_${clip.endSec}.json`
        );
        const intelPath = fs.existsSync(fpIntelPath)
          ? fpIntelPath
          : fs.existsSync(legacyIntelPath)
            ? legacyIntelPath
            : undefined;

        let faceTracks: FaceTrackCandidate[] = current.faceTracks;
        let audioWindows: AudioSpeechWindow[] | undefined;
        let usedCachedIntelligence = false;
        if (intelPath && fs.existsSync(intelPath)) {
          try {
            const parsed = JSON.parse(fs.readFileSync(intelPath, 'utf-8')) as {
              cameraAnalysis?: { faceTracks?: FaceTrackCandidate[] };
              vadWindows?: AudioSpeechWindow[];
            };
            if (Array.isArray(parsed?.cameraAnalysis?.faceTracks) && parsed.cameraAnalysis.faceTracks.length > 0) {
              faceTracks = parsed.cameraAnalysis.faceTracks;
              usedCachedIntelligence = true;
            }
            if (Array.isArray(parsed?.vadWindows) && parsed.vadWindows.length > 0) {
              audioWindows = parsed.vadWindows;
            }
          } catch {
            // Ignore unreadable intelligence cache
          }
        }

        const recalc = recalculateClipCameraAnalysis({
          clipId: clip.id,
          durationSec,
          faceTracks,
          audioWindows,
          settings: nextSettings,
        });

        const summary = `Active speaker tracking (${recalc.cameraAnalysis.speakers.length} pembicara, ${recalc.cameraAnalysis.cameraSegments.length} segmen, stabilitas ${Math.round(recalc.cameraAnalysis.metrics.stabilityScore * 100)}%).`;

        await repo.saveCameraAnalysis({
          userUid: uid,
          clip,
          episode,
          speakers: recalc.cameraAnalysis.speakers,
          faceTracks: recalc.cameraAnalysis.faceTracks,
          speakerSegments: recalc.cameraAnalysis.speakerSegments,
          cameraSegments: recalc.cameraAnalysis.cameraSegments,
        });

        await repo.recordPerformanceMetric({
          userUid: uid,
          category: 'camera',
          operation: 'camera_recalculate',
          durationMs: Date.now() - startedAt,
          success: true,
          cacheHit: usedCachedIntelligence,
          metadata: {
            clipId,
            switchCount: recalc.cameraAnalysis.metrics.switchCount,
            stabilityScore: recalc.cameraAnalysis.metrics.stabilityScore,
          },
        });

        res.json({
          ...recalc.cameraAnalysis,
          ok: true,
          usedCachedIntelligence,
          keyframes: recalc.keyframes,
          summary,
        });
      } catch (err) {
        res.status(500).json({ error: sanitizePublicErrorMessage(err, 'Gagal menghitung ulang pelacakan pembicara.') });
      }
    }
  );

  router.get('/camera/benchmark', deps.apiRateLimit, deps.requireAuth, (_req, res) => {
    const report = runActiveSpeakerBenchmark();
    res.json(report);
  });

  // =========================================================================
  // 2. PROFESSIONAL SHORTS INTRO STUDIO & TEMPLATE VERSIONING
  // =========================================================================

  router.get('/intro-templates/catalog', deps.apiRateLimit, deps.requireAuth, (req, res) => {
    const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
    const search = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const templates = GLOBAL_INTRO_TEMPLATES.filter((t) => {
      if (category && category !== 'ALL' && t.category !== category) return false;
      if (search) {
        const hay = `${t.name} ${t.category} ${t.description} ${t.slug}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
    res.json({
      categories: INTRO_TEMPLATE_CATEGORIES,
      totalCount: templates.length,
      templates,
    });
  });

  router.get('/intro-templates/personal', deps.apiRateLimit, deps.requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const templates = await repo.listUserIntroTemplates(req.authUser!.uid);
      res.json({ templates });
    } catch (err) {
      res.status(500).json({ error: sanitizePublicErrorMessage(err, 'Gagal memuat template intro pribadi.') });
    }
  });

  router.post('/intro-templates/personal', deps.apiRateLimit, deps.requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const uid = req.authUser!.uid;
      const body = (req.body ?? {}) as {
        id?: string;
        baseTemplateId?: string | null;
        name?: string;
        category?: IntroTemplateCategory;
        description?: string;
        durationSec?: number;
        config?: Partial<IntroTemplateDefinition>;
        changeNote?: string;
      };

      const name = (body.name || body.config?.name || '').trim().slice(0, 100);
      if (!name) {
        res.status(400).json({ error: 'Nama template intro wajib diisi.' });
        return;
      }

      const normalized = normalizeIntroTemplateDefinition({
        ...(body.config ?? {}),
        name,
        ...(body.category ? { category: body.category } : {}),
        ...(typeof body.description === 'string' ? { description: body.description.slice(0, 300) } : {}),
        ...(typeof body.durationSec === 'number' ? { durationSec: body.durationSec } : {}),
      });

      const saved = await repo.saveUserIntroTemplate({
        id: body.id,
        userUid: uid,
        baseTemplateId: body.baseTemplateId ?? null,
        name,
        category: normalized.category,
        description: normalized.description,
        durationSec: normalized.durationSec,
        config: normalized,
        changeNote: body.changeNote,
      });

      res.status(201).json({ template: saved });
    } catch (err) {
      res.status(500).json({ error: sanitizePublicErrorMessage(err, 'Gagal menyimpan template intro pribadi.') });
    }
  });

  router.put(
    '/intro-templates/personal/:templateId',
    deps.apiRateLimit,
    deps.requireAuth,
    async (req: AuthenticatedRequest, res) => {
      try {
        const uid = req.authUser!.uid;
        const { templateId } = req.params;
        if (!isSafeResourceId(templateId)) {
          res.status(400).json({ error: 'Template ID tidak valid.' });
          return;
        }
        const existingList = await repo.listUserIntroTemplates(uid);
        const existing = existingList.find((t) => t.id === templateId);
        if (!existing) {
          res.status(404).json({ error: 'Template intro pribadi tidak ditemukan.' });
          return;
        }

        const body = (req.body ?? {}) as {
          name?: string;
          category?: IntroTemplateCategory;
          description?: string;
          durationSec?: number;
          config?: Partial<IntroTemplateDefinition>;
          changeNote?: string;
        };

        const normalized = normalizeIntroTemplateDefinition({
          ...existing.config,
          ...(body.config ?? {}),
          name: (body.name || body.config?.name || existing.name).trim().slice(0, 100),
          category: body.category || body.config?.category || existing.category,
          description:
            typeof body.description === 'string'
              ? body.description.slice(0, 300)
              : body.config?.description ?? existing.description,
          durationSec: body.durationSec ?? body.config?.durationSec ?? existing.durationSec,
        });

        const updated = await repo.saveUserIntroTemplate({
          id: existing.id,
          userUid: uid,
          baseTemplateId: existing.baseTemplateId,
          name: normalized.name,
          category: normalized.category,
          description: normalized.description,
          durationSec: normalized.durationSec,
          config: normalized,
          changeNote: body.changeNote || 'Pembaruan konfigurasi layer & gaya intro',
        });

        res.json({ template: updated });
      } catch (err) {
        res.status(500).json({ error: sanitizePublicErrorMessage(err, 'Gagal memperbarui template intro.') });
      }
    }
  );

  router.delete(
    '/intro-templates/personal/:templateId',
    deps.apiRateLimit,
    deps.requireAuth,
    async (req: AuthenticatedRequest, res) => {
      try {
        const uid = req.authUser!.uid;
        const { templateId } = req.params;
        if (!isSafeResourceId(templateId)) {
          res.status(400).json({ error: 'Template ID tidak valid.' });
          return;
        }
        const deleted = await repo.deleteUserIntroTemplate(uid, templateId);
        if (!deleted) {
          res.status(404).json({ error: 'Template intro tidak ditemukan.' });
          return;
        }
        res.json({ ok: true, id: templateId });
      } catch (err) {
        res.status(500).json({ error: sanitizePublicErrorMessage(err, 'Gagal menghapus template intro.') });
      }
    }
  );

  router.post(
    '/intro-templates/personal/:templateId/duplicate',
    deps.apiRateLimit,
    deps.requireAuth,
    async (req: AuthenticatedRequest, res) => {
      try {
        const uid = req.authUser!.uid;
        const { templateId } = req.params;
        const personal = (await repo.listUserIntroTemplates(uid)).find((t) => t.id === templateId);
        const globalTpl = GLOBAL_INTRO_TEMPLATES.find((t) => t.id === templateId);
        const source = personal?.config ?? globalTpl;
        if (!source) {
          res.status(404).json({ error: 'Template sumber tidak ditemukan untuk diduplikasi.' });
          return;
        }

        const copyName = `${source.name} (Salinan)`.slice(0, 100);
        const duplicated = await repo.saveUserIntroTemplate({
          userUid: uid,
          baseTemplateId: globalTpl ? globalTpl.id : personal?.baseTemplateId ?? source.id,
          name: copyName,
          category: source.category,
          description: source.description,
          durationSec: source.durationSec,
          config: { ...source, name: copyName, isGlobal: false },
          changeNote: `Duplikasi dari "${source.name}"`,
        });

        res.status(201).json({ template: duplicated });
      } catch (err) {
        res.status(500).json({ error: sanitizePublicErrorMessage(err, 'Gagal menduplikasi template intro.') });
      }
    }
  );

  router.get(
    '/intro-templates/personal/:templateId/versions',
    deps.apiRateLimit,
    deps.requireAuth,
    async (req: AuthenticatedRequest, res) => {
      try {
        const uid = req.authUser!.uid;
        const { templateId } = req.params;
        if (!isSafeResourceId(templateId)) {
          res.status(400).json({ error: 'Template ID tidak valid.' });
          return;
        }
        const versions = await repo.listIntroTemplateVersions(uid, templateId);
        res.json({ versions });
      } catch (err) {
        res.status(500).json({ error: sanitizePublicErrorMessage(err, 'Gagal memuat riwayat versi template.') });
      }
    }
  );

  router.post(
    '/intro-templates/personal/:templateId/versions/:versionNumber/restore',
    deps.apiRateLimit,
    deps.requireAuth,
    async (req: AuthenticatedRequest, res) => {
      try {
        const uid = req.authUser!.uid;
        const { templateId, versionNumber } = req.params;
        if (!isSafeResourceId(templateId)) {
          res.status(400).json({ error: 'Template ID tidak valid.' });
          return;
        }
        const targetVerNum = Number(versionNumber);
        const versions = await repo.listIntroTemplateVersions(uid, templateId);
        const target = versions.find((v) => v.versionNumber === targetVerNum);
        if (!target) {
          res.status(404).json({ error: 'Versi template tidak ditemukan.' });
          return;
        }

        const restored = await repo.saveUserIntroTemplate({
          id: templateId,
          userUid: uid,
          name: target.config.name,
          category: target.config.category,
          description: target.config.description,
          durationSec: target.config.durationSec,
          config: target.config,
          changeNote: `Dipulihkan ke versi v${targetVerNum}`,
        });

        res.json({ template: restored });
      } catch (err) {
        res.status(500).json({ error: sanitizePublicErrorMessage(err, 'Gagal memulihkan versi template.') });
      }
    }
  );

  router.post('/intro-templates/compile-preview', deps.apiRateLimit, deps.requireAuth, (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        template?: Partial<IntroTemplateDefinition>;
        width?: number;
        height?: number;
        fps?: number;
      };
      const normalized = normalizeIntroTemplateDefinition(body.template);
      const plan = compileIntroTemplateForFfmpeg({
        template: normalized,
        width: body.width ?? 1080,
        height: body.height ?? 1920,
        fps: body.fps ?? 30,
      });
      res.json({ ok: true, template: normalized, plan });
    } catch (err) {
      res.status(400).json({ error: sanitizePublicErrorMessage(err, 'Konfigurasi template intro tidak valid.') });
    }
  });

  // =========================================================================
  // 3. BALANCED RENDER PROFILES, FINGERPRINT CACHE & WORKER DISPATCH
  // =========================================================================

  router.get('/render-profiles', deps.apiRateLimit, deps.requireAuth, (_req, res) => {
    res.json({
      defaultProfile: 'balanced_1080p',
      profiles: Object.values(BALANCED_RENDER_PROFILES),
    });
  });

  router.post('/renders/enqueue', deps.renderRateLimit, deps.requireAuth, (req: AuthenticatedRequest, res) => {
    deps.onEnqueueRender(req, res);
  });

  // Confined local media storage endpoint when GCS_BUCKET_NAME is not provisioned
  router.get('/storage/local', deps.apiRateLimit, deps.requireAuth, (req: AuthenticatedRequest, res) => {
    const key = typeof req.query.key === 'string' ? req.query.key.trim() : '';
    if (!key) {
      res.status(400).json({ error: 'Parameter object key storage diperlukan.' });
      return;
    }
    const normalized = path.normalize(key).replace(/^(\.\.(\/|\\|$))+/, '');
    const full = path.resolve(LOCAL_STORAGE_ROOT, normalized);
    if (!full.startsWith(LOCAL_STORAGE_ROOT + path.sep)) {
      res.status(403).json({ error: 'Akses path storage ditolak.' });
      return;
    }

    const user = req.authUser!;
    const isAdmin = user.role === 'admin' || user.role === 'super_admin';
    const expectedPrefix = `users/${sanitizeUidPrefix(user.uid)}/`;
    if (!isAdmin && !normalized.replace(/\\/g, '/').startsWith(expectedPrefix)) {
      res.status(403).json({ error: 'Anda tidak memiliki izin mengakses file storage pengguna lain.' });
      return;
    }

    if (!fs.existsSync(full)) {
      res.status(404).json({ error: 'File asset storage tidak ditemukan.' });
      return;
    }
    res.sendFile(full);
  });

  // =========================================================================
  // 4. OBSERVABILITY & PRODUCTION READINESS
  // =========================================================================

  router.get('/observability/metrics', deps.apiRateLimit, deps.requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const user = req.authUser!;
      const isAdmin = user.role === 'admin' || user.role === 'super_admin';
      const scopeUid = isAdmin && req.query.scope === 'all' ? undefined : user.uid;
      const summary = await repo.getObservabilitySummary(scopeUid);
      res.json(summary);
    } catch (err) {
      res.status(500).json({ error: sanitizePublicErrorMessage(err, 'Gagal memuat metrik observabilitas.') });
    }
  });

  router.get(
    '/observability/jobs/:jobId/events',
    deps.apiRateLimit,
    deps.requireAuth,
    async (req: AuthenticatedRequest, res) => {
      try {
        const user = req.authUser!;
        const { jobId } = req.params;
        const jobRecord = deps.db.getRenderJobById(jobId);
        const isAdmin = user.role === 'admin' || user.role === 'super_admin';
        if (jobRecord && !isAdmin && jobRecord.userUid !== user.uid) {
          res.status(403).json({ error: 'Akses log event render pengguna lain ditolak.' });
          return;
        }
        const events = await repo.listJobEvents(jobId, isAdmin ? undefined : user.uid);
        res.json({ jobId, events });
      } catch (err) {
        res.status(500).json({ error: sanitizePublicErrorMessage(err, 'Gagal memuat riwayat event job.') });
      }
    }
  );

  router.get('/readiness', deps.apiRateLimit, deps.requireAuth, async (_req, res) => {
    const pgConfigured = isPostgresConfigured();
    const pgHealth = await checkPgHealth();
    const gcs = getGcsReadinessStatus();
    const tasks = getCloudTasksReadinessStatus();
    const runJobs = getCloudRunJobsReadinessStatus();

    let ffmpegReady = false;
    let ffprobeReady = false;
    try {
      ffmpegReady = Boolean(await ensureFfmpegPath());
    } catch {
      ffmpegReady = false;
    }
    try {
      ffprobeReady = Boolean(await ensureFfprobePath());
    } catch {
      ffprobeReady = false;
    }

    res.json({
      architecture: 'AICLIPER-V3-CLOUD-NATIVE',
      database: {
        targetEngine: 'Google Cloud SQL PostgreSQL + Drizzle ORM',
        backend: pgHealth.connected ? 'postgresql' : 'sqlite_staged',
        activeMode: pgHealth.connected ? 'postgresql_cloud_sql' : 'sqlite_staged_fallback',
        configured: pgConfigured,
        connected: pgHealth.connected,
        latencyMs: pgHealth.latencyMs ?? null,
        error: pgHealth.error ?? null,
      },
      media: {
        ffmpegReady,
        ffprobeReady,
      },
      storage: gcs,
      queue: tasks,
      renderWorker: runJobs,
      cvSidecar: {
        configured: Boolean(process.env.CV_WORKER_URL?.trim()),
        mode: process.env.CV_WORKER_URL?.trim() ? 'external_python_cv' : 'gemini_plus_ffmpeg_vad_fallback',
      },
      renderStrategy: 'balanced',
      introCatalogCount: GLOBAL_INTRO_TEMPLATES.length,
      introCategoryCount: INTRO_TEMPLATE_CATEGORIES.length,
      allCloudResourcesProvisioned: Boolean(
        pgHealth.connected && isGcsConfigured() && tasks.configured && runJobs.configured
      ),
    });
  });

  return router;
}
