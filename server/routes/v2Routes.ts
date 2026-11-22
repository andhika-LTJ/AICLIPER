import { Router, type RequestHandler } from 'express';
import type {
  ClippingApproach,
  StudioTemplateCategory,
} from '../../src/types/clipper.ts';
import type { AuthenticatedRequest } from '../authMiddleware.ts';
import type { KlipCastDatabase } from '../db.ts';
import {
  askGroundedEpisodeAssistant,
  generateCustomContentStudioAsset,
  generateGroundedGrowthRecommendations,
} from '../aiStudio.ts';
import {
  assertQuotaAvailable,
  consumeQuota,
  getUserQuotaSummary,
  QuotaExceededError,
  trackGeminiApiUsage,
} from '../quotaService.ts';
import { V2Repository } from '../repositories/v2Repository.ts';
import {
  buildUserAnalyticsOverview,
  syncYouTubeStatsForUser,
} from '../services/analyticsService.ts';
import { resolvePaymentProvider } from '../services/paymentProvider.ts';
import {
  createDefaultEditingProject,
  deriveClipBoundsFromTimeline,
} from '../utils/timelineMath.ts';
import {
  AdvisorAskSchema,
  CreateTemplateSchema,
  CreateWorkspaceSchema,
  CustomContentGenerationSchema,
  SaveEditingProjectSchema,
  UpdateSystemSettingsSchema,
  formatZodError,
} from '../validators/schemas.ts';

export interface V2RouterDeps {
  db: KlipCastDatabase;
  requireAuth: RequestHandler;
  requireAdmin: RequestHandler;
  requireSuperAdmin: RequestHandler;
  apiRateLimit: RequestHandler;
  aiRateLimit: RequestHandler;
  getClientIp: (req: AuthenticatedRequest) => string;
}

export function createV2Router(deps: V2RouterDeps): Router {
  const { db, requireAuth, requireAdmin, requireSuperAdmin, apiRateLimit, aiRateLimit, getClientIp } = deps;
  const repo = new V2Repository(db);
  const router = Router();

  // =========================================================================
  // WORKSPACES
  // =========================================================================

  router.get('/workspaces', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    repo.ensureDefaultWorkspace(user.uid, user.name);
    const workspaces = repo.listUserWorkspaces(user.uid);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ workspaces });
  });

  router.post('/workspaces', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    const parsed = CreateWorkspaceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }
    const existing = repo.listUserWorkspaces(user.uid);
    if (existing.length >= 10) {
      res.status(400).json({ error: 'Maksimal 10 workspace per akun telah tercapai.' });
      return;
    }
    const workspace = repo.createWorkspace({
      ownerUid: user.uid,
      name: parsed.data.name,
      description: parsed.data.description,
    });
    res.status(201).json({ workspace });
  });

  // =========================================================================
  // SMART VIDEO EDITOR (NON-DESTRUCTIVE MULTI-TRACK TIMELINE)
  // =========================================================================

  router.get('/editor/:clipId', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const clipId = String(req.params.clipId);
    const clip = db.getClipForUser(uid, clipId);
    if (!clip) {
      res.status(404).json({ error: 'Klip tidak ditemukan atau bukan milik akun Anda.' });
      return;
    }

    const existing = repo.getEditingProject(uid, clipId);
    if (existing) {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ project: existing, clip });
      return;
    }

    const defaultWs = repo.ensureDefaultWorkspace(uid, req.authUser!.name);
    const created = repo.upsertEditingProject(
      createDefaultEditingProject(clip, uid, defaultWs.id)
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({ project: created, clip });
  });

  router.put('/editor/:clipId', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const clipId = String(req.params.clipId);
    const clip = db.getClipForUser(uid, clipId);
    if (!clip) {
      res.status(404).json({ error: 'Klip tidak ditemukan atau bukan milik akun Anda.' });
      return;
    }

    const parsed = SaveEditingProjectSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    const defaultWs = repo.ensureDefaultWorkspace(uid, req.authUser!.name);
    const saved = repo.upsertEditingProject({
      id: `edproj-${clipId}`,
      clipId,
      userUid: uid,
      workspaceId: defaultWs.id,
      title: parsed.data.title,
      durationSec: parsed.data.durationSec,
      zoomLevel: parsed.data.zoomLevel,
      safeAreaEnabled: parsed.data.safeAreaEnabled,
      elements: parsed.data.elements,
      exportPreset: parsed.data.exportPreset,
      version: 1,
      updatedAt: new Date().toISOString(),
    });

    if (parsed.data.syncClipBounds) {
      const bounds = deriveClipBoundsFromTimeline(saved, clip.startSec, clip.endSec);
      db.upsertClip(uid, {
        ...clip,
        startSec: bounds.startSec,
        endSec: bounds.endSec,
        introEnabled: parsed.data.exportPreset.includeIntro,
      });
    }

    res.json({ project: saved });
  });

  // =========================================================================
  // TEMPLATE LIBRARY (SUBTITLE, INTRO, THUMBNAIL, EXPORT)
  // =========================================================================

  router.get('/templates', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const rawCat = typeof req.query.category === 'string' ? req.query.category : undefined;
    const validCats = new Set(['subtitle', 'intro', 'thumbnail', 'export']);
    const category =
      rawCat && validCats.has(rawCat) ? (rawCat as StudioTemplateCategory) : undefined;
    const templates = repo.listTemplates(uid, category);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ templates });
  });

  router.post('/templates', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const parsed = CreateTemplateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }
    const template = repo.createTemplate({
      userUid: uid,
      workspaceId: parsed.data.workspaceId ?? null,
      name: parsed.data.name,
      category: parsed.data.category,
      description: parsed.data.description,
      isPublic: parsed.data.isPublic,
      config: parsed.data.config,
    });
    res.status(201).json({ template });
  });

  router.delete(
    '/templates/:templateId',
    apiRateLimit,
    requireAuth,
    (req: AuthenticatedRequest, res) => {
      const uid = req.authUser!.uid;
      const deleted = repo.deleteTemplate(uid, String(req.params.templateId));
      if (!deleted) {
        res.status(404).json({ error: 'Template tidak ditemukan atau bukan milik akun Anda.' });
        return;
      }
      res.json({ ok: true });
    }
  );

  // =========================================================================
  // AI CONTENT STUDIO 2.0 (CUSTOM GENERATOR + PERSISTENT HISTORY)
  // =========================================================================

  router.get(
    '/content-studio/generations',
    apiRateLimit,
    requireAuth,
    (req: AuthenticatedRequest, res) => {
      const uid = req.authUser!.uid;
      const generations = repo.listContentGenerations(uid, 30);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ generations });
    }
  );

  router.post(
    '/content-studio/generations',
    aiRateLimit,
    requireAuth,
    async (req: AuthenticatedRequest, res) => {
      const uid = req.authUser!.uid;
      const parsed = CustomContentGenerationSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: formatZodError(parsed.error) });
        return;
      }

      try {
        assertQuotaAvailable(db, uid, 'ai');
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          res.status(err.status).json({ code: err.code, error: err.message });
          return;
        }
        throw err;
      }

      const episode = parsed.data.episodeId
        ? db.getEpisodeForUser(uid, parsed.data.episodeId)
        : null;
      const clip = parsed.data.clipId ? db.getClipForUser(uid, parsed.data.clipId) : null;

      if (parsed.data.episodeId && !episode) {
        res.status(404).json({ error: 'Episode tidak ditemukan.' });
        return;
      }
      if (parsed.data.clipId && !clip) {
        res.status(404).json({ error: 'Klip tidak ditemukan.' });
        return;
      }

      try {
        const { output, usage } = await generateCustomContentStudioAsset({
          episode,
          clip,
          options: {
            kind: parsed.data.kind,
            language: parsed.data.language,
            platform: parsed.data.platform,
            tone: parsed.data.tone,
            audience: parsed.data.audience,
            objective: parsed.data.objective,
            textLength: parsed.data.textLength,
            writingStyle: parsed.data.writingStyle,
            topicFocus: parsed.data.topicFocus,
          },
        });

        consumeQuota(db, uid, 'ai');
        trackGeminiApiUsage(db, {
          userUid: uid,
          operation: `content_studio_${parsed.data.kind}`,
          model: usage.model,
          promptTokens: usage.promptTokens,
          outputTokens: usage.outputTokens,
          cached: false,
        });

        const record = repo.insertContentGeneration({
          userUid: uid,
          episodeId: episode?.id ?? null,
          clipId: clip?.id ?? null,
          params: {
            kind: parsed.data.kind,
            language: parsed.data.language,
            platform: parsed.data.platform,
            tone: parsed.data.tone,
            audience: parsed.data.audience,
            objective: parsed.data.objective,
            textLength: parsed.data.textLength,
            writingStyle: parsed.data.writingStyle,
            topicFocus: parsed.data.topicFocus,
          },
          output,
          modelUsed: usage.model,
        });

        res.status(201).json({ generation: record });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Gagal menghasilkan materi konten AI.';
        res.status(500).json({ error: msg });
      }
    }
  );

  router.delete(
    '/content-studio/generations/:id',
    apiRateLimit,
    requireAuth,
    (req: AuthenticatedRequest, res) => {
      const uid = req.authUser!.uid;
      const ok = repo.deleteContentGeneration(uid, String(req.params.id));
      if (!ok) {
        res.status(404).json({ error: 'Riwayat konten tidak ditemukan.' });
        return;
      }
      res.json({ ok: true });
    }
  );

  // =========================================================================
  // PERSISTENT AI CONTENT ADVISOR (PER EPISODE & USER)
  // =========================================================================

  router.get(
    '/advisor/:episodeId/messages',
    apiRateLimit,
    requireAuth,
    (req: AuthenticatedRequest, res) => {
      const uid = req.authUser!.uid;
      const episodeId = String(req.params.episodeId);
      const episode = db.getEpisodeForUser(uid, episodeId);
      if (!episode) {
        res.status(404).json({ error: 'Episode tidak ditemukan.' });
        return;
      }
      const messages = repo.listAdvisorMessages(uid, episodeId, 60);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ messages });
    }
  );

  router.post(
    '/advisor/:episodeId/messages',
    aiRateLimit,
    requireAuth,
    async (req: AuthenticatedRequest, res) => {
      const uid = req.authUser!.uid;
      const episodeId = String(req.params.episodeId);
      const episode = db.getEpisodeForUser(uid, episodeId);
      if (!episode) {
        res.status(404).json({ error: 'Episode tidak ditemukan.' });
        return;
      }

      const parsed = AdvisorAskSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: formatZodError(parsed.error) });
        return;
      }

      try {
        assertQuotaAvailable(db, uid, 'ai');
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          res.status(err.status).json({ code: err.code, error: err.message });
          return;
        }
        throw err;
      }

      const clips = db.listUserClips(uid, 200, 0).filter((c) => c.episodeId === episodeId);
      const priorMessages = repo.listAdvisorMessages(uid, episodeId, 12);
      const userMsg = repo.appendAdvisorMessage({
        userUid: uid,
        episodeId,
        role: 'user',
        content: parsed.data.question,
      });

      try {
        const { answer, usage } = await askGroundedEpisodeAssistant({
          episode,
          clips,
          question: parsed.data.question,
          history: priorMessages.map((m) => ({ role: m.role, content: m.content })),
        });

        consumeQuota(db, uid, 'ai');
        trackGeminiApiUsage(db, {
          userUid: uid,
          operation: 'advisor_chat',
          model: usage.model,
          promptTokens: usage.promptTokens,
          outputTokens: usage.outputTokens,
          cached: false,
        });

        const assistantMsg = repo.appendAdvisorMessage({
          userUid: uid,
          episodeId,
          role: 'assistant',
          content: answer,
          modelUsed: usage.model,
        });

        res.status(201).json({
          userMessage: userMsg,
          assistantMessage: assistantMsg,
          messages: repo.listAdvisorMessages(uid, episodeId, 60),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Asisten AI gagal merespons.';
        res.status(500).json({ error: msg, userMessage: userMsg });
      }
    }
  );

  router.delete(
    '/advisor/:episodeId/messages',
    apiRateLimit,
    requireAuth,
    (req: AuthenticatedRequest, res) => {
      const uid = req.authUser!.uid;
      const episodeId = String(req.params.episodeId);
      const episode = db.getEpisodeForUser(uid, episodeId);
      if (!episode) {
        res.status(404).json({ error: 'Episode tidak ditemukan.' });
        return;
      }
      const deletedCount = repo.clearAdvisorMessages(uid, episodeId);
      res.json({ ok: true, deletedCount });
    }
  );

  // =========================================================================
  // REAL CONTENT ANALYTICS & GROUNDED AI GROWTH RECOMMENDATIONS
  // =========================================================================

  router.get('/analytics/overview', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const overview = buildUserAnalyticsOverview(db, repo, uid);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ overview });
  });

  router.post(
    '/analytics/sync-youtube',
    apiRateLimit,
    requireAuth,
    async (req: AuthenticatedRequest, res) => {
      const uid = req.authUser!.uid;
      const ytToken = String(req.headers['x-youtube-access-token'] ?? '').trim();
      if (!ytToken) {
        res.status(400).json({
          error:
            'Header X-YouTube-Access-Token diperlukan. Aktifkan izin akun YouTube terlebih dahulu untuk menyinkronkan statistik nyata YouTube Data API v3.',
          needsYouTubeAuth: true,
        });
        return;
      }

      try {
        const result = await syncYouTubeStatsForUser({
          db,
          v2Repo: repo,
          userUid: uid,
          youtubeAccessToken: ytToken,
        });
        const overview = buildUserAnalyticsOverview(db, repo, uid);
        res.json({ ok: true, ...result, overview });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Gagal menyinkronkan statistik YouTube.';
        res.status(502).json({ error: msg });
      }
    }
  );

  router.post(
    '/analytics/growth-recommendations',
    aiRateLimit,
    requireAuth,
    async (req: AuthenticatedRequest, res) => {
      const uid = req.authUser!.uid;
      try {
        assertQuotaAvailable(db, uid, 'ai');
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          res.status(err.status).json({ code: err.code, error: err.message });
          return;
        }
        throw err;
      }

      const overview = buildUserAnalyticsOverview(db, repo, uid);
      try {
        const { recommendations, usage } = await generateGroundedGrowthRecommendations(overview);
        consumeQuota(db, uid, 'ai');
        trackGeminiApiUsage(db, {
          userUid: uid,
          operation: 'analytics_growth_recommendations',
          model: usage.model,
          promptTokens: usage.promptTokens,
          outputTokens: usage.outputTokens,
          cached: false,
        });
        res.json({ recommendations, basedOnOverview: overview.sourceSummary });
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : 'Gagal menghasilkan rekomendasi pertumbuhan AI.';
        res.status(500).json({ error: msg });
      }
    }
  );

  // =========================================================================
  // BILLING, QUOTA CATALOG & PAYMENT PROVIDER READINESS
  // =========================================================================

  router.get('/billing/summary', apiRateLimit, requireAuth, (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const settings = repo.getSystemSettings();
    const quota = getUserQuotaSummary(db, uid);
    const provider = resolvePaymentProvider();
    const billingRecords = repo.listUserBillingRecords(uid, 20);

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      currentPlan: quota.planTier,
      quota,
      plans: Object.values(settings.plans),
      paymentProvider: provider.getStatus(),
      billingRecords,
    });
  });

  // =========================================================================
  // ADMIN 2.0: WORKSPACES & CONFIGURABLE SYSTEM SETTINGS
  // =========================================================================

  router.get(
    '/admin/workspaces',
    apiRateLimit,
    requireAuth,
    requireAdmin,
    (_req: AuthenticatedRequest, res) => {
      const workspaces = repo.listAllWorkspacesAdmin(60);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ workspaces });
    }
  );

  router.get(
    '/admin/system-settings',
    apiRateLimit,
    requireAuth,
    requireAdmin,
    (_req: AuthenticatedRequest, res) => {
      const settings = repo.getSystemSettings();
      const paymentProvider = resolvePaymentProvider().getStatus();
      res.setHeader('Cache-Control', 'no-store');
      res.json({ settings, paymentProvider });
    }
  );

  router.patch(
    '/admin/system-settings',
    apiRateLimit,
    requireAuth,
    requireSuperAdmin,
    (req: AuthenticatedRequest, res) => {
      const actor = req.authUser!;
      const parsed = UpdateSystemSettingsSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: formatZodError(parsed.error) });
        return;
      }

      const updated = repo.updateSystemSettings(parsed.data, actor.uid);
      db.insertAuditLog({
        actorUid: actor.uid,
        actorEmail: actor.email,
        action: 'admin.system_settings_updated',
        targetType: 'system_settings',
        targetId: 'platform_config',
        metadata: {
          defaultAiModel: updated.defaultAiModel,
          maintenanceMode: updated.maintenanceMode,
          defaultThemePreset: updated.defaultThemePreset,
          plansUpdated: Boolean(parsed.data.plans),
        },
        ipAddress: getClientIp(req),
      });

      res.json({ settings: updated });
    }
  );

  return router;
}

export function normalizeClippingApproach(input: unknown): ClippingApproach {
  const valid = new Set<ClippingApproach>([
    'educational',
    'storytelling',
    'motivational',
    'informative',
    'entertainment',
    'promotional',
  ]);
  if (typeof input === 'string' && valid.has(input as ClippingApproach)) {
    return input as ClippingApproach;
  }
  return 'educational';
}
