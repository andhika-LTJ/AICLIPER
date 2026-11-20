import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { INITIAL_STUDIO_STATE } from './src/data/seedPodcasts.ts';
import type {
  ClipRenderLayout,
  ClipRenderQuality,
  PodcastClip,
  SocialPlatform,
} from './src/types/clipper.ts';
import { clampClipRange, extractYouTubeVideoId } from './src/utils/youtube.ts';
import { buildDistributionLog, dispatchWebhookIfConfigured, readStore, writeStore } from './server/store.ts';
import {
  getTargetCanvasDimensions,
  normalizeRenderLayout,
  normalizeRenderQuality,
  resolveEffectiveRenderQuality,
} from './server/speakerFocusMath.ts';
import {
  getRenderedClipPath,
  getUploadTargetPath,
  hasYoutubeCookies,
  invalidateLowResSegmentCache,
  prewarmYtDlpBinary,
  RenderCancelledError,
  renderClipMp4,
  saveYoutubeCookies,
  YoutubeBotCheckError,
} from './server/videoClipper.ts';
import { RenderJobManager } from './server/renderJobManager.ts';
import { prewarmEpisodeStream } from './server/thirdPartyDownloader.ts';
import { resolveCappedByteRange } from './server/videoStreamRange.ts';
import { analyzePodcastWithGemini } from './server/youtubeAnalyzer.ts';
import {
  buildYouTubeUploadMetadata,
  uploadVideoFileToYouTube,
  YouTubeUploadHttpError,
  type YouTubePrivacyStatus,
} from './server/youtubeUploader.ts';
import {
  GoogleTokenVerificationError,
  verifyFirebaseGoogleIdToken,
} from './server/googleAuthVerifier.ts';

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'klipcast-bot' });
  });

  app.post('/api/auth/verify-google', async (req, res) => {
    try {
      const headerToken = req.header('X-Firebase-Id-Token')?.trim();
      const bodyToken =
        typeof (req.body as { idToken?: unknown } | undefined)?.idToken === 'string'
          ? (req.body as { idToken: string }).idToken.trim()
          : '';
      const idToken = headerToken || bodyToken;

      const user = await verifyFirebaseGoogleIdToken(idToken);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        verified: true,
        user,
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

  app.get('/api/state', (_req, res) => {
    const state = readStore();
    res.json(state);
  });

  app.post('/api/podcast/analyze', async (req, res) => {
    try {
      const { url, manualTranscript, autoPostOverride } = req.body as {
        url?: string;
        manualTranscript?: string;
        autoPostOverride?: boolean;
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

      const store = readStore();
      const episodeId = `ep-${Date.now()}`;

      const { episode, clips } = await analyzePodcastWithGemini({
        episodeId,
        sourceUrl: url.trim(),
        videoId,
        manualTranscript,
        targetClipCount: store.automation.targetClipCount,
        minDurationSec: store.automation.minClipSec,
        maxDurationSec: store.automation.maxClipSec,
        autoAddHashtagShorts: store.automation.autoAddHashtagShorts,
      });

      const shouldAutoPost =
        typeof autoPostOverride === 'boolean' ? autoPostOverride : store.automation.autoPostOnAnalyze;

      const finalClips: PodcastClip[] = [];
      const newLogs = [...store.distributionLogs];

      for (const clip of clips) {
        if (shouldAutoPost && clip.priorityLabel === 'Sorotan Utama') {
          const platforms = store.automation.defaultPlatforms;
          const webhookResult = await dispatchWebhookIfConfigured(store.automation, {
            event: 'clip.published',
            mode: 'auto',
            platforms,
            episode,
            clip,
          });
          const publishedClip: PodcastClip = {
            ...clip,
            status: 'published_auto',
            publishedPlatforms: platforms,
            lastPublishedAt: new Date().toISOString(),
          };
          finalClips.push(publishedClip);
          newLogs.unshift(
            buildDistributionLog({
              clip: publishedClip,
              episodeTitle: episode.title,
              mode: 'auto',
              platforms,
              webhookResult,
            })
          );
        } else {
          finalClips.push(clip);
        }
      }

      const updatedStore = writeStore({
        ...store,
        episodes: [episode, ...store.episodes],
        clips: [...finalClips, ...store.clips],
        distributionLogs: newLogs.slice(0, 100),
      });

      void prewarmEpisodeStream(episode.sourceUrl, episode.videoId);

      res.json({
        episode,
        clips: finalClips,
        store: updatedStore,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Terjadi kesalahan saat menganalisis podcast.';
      res.status(500).json({ error: message });
    }
  });

  app.patch('/api/clips/:clipId', (req, res) => {
    const { clipId } = req.params;
    const store = readStore();
    const targetIdx = store.clips.findIndex((c) => c.id === clipId);
    if (targetIdx === -1) {
      res.status(404).json({ error: 'Klip tidak ditemukan.' });
      return;
    }

    const existing = store.clips[targetIdx];
    const episode = store.episodes.find((e) => e.id === existing.episodeId);
    const maxEpDuration = episode?.durationSec ?? 3600;

    const patch = req.body as Partial<PodcastClip>;
    const nextRange =
      typeof patch.startSec === 'number' || typeof patch.endSec === 'number'
        ? clampClipRange(
            patch.startSec ?? existing.startSec,
            patch.endSec ?? existing.endSec,
            maxEpDuration,
            10,
            60
          )
        : { startSec: existing.startSec, endSec: existing.endSec };

    const rangeChanged =
      nextRange.startSec !== existing.startSec || nextRange.endSec !== existing.endSec;

    const updatedClip: PodcastClip = {
      ...existing,
      ...patch,
      id: existing.id,
      episodeId: existing.episodeId,
      startSec: nextRange.startSec,
      endSec: nextRange.endSec,
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
          }
        : {}),
    };

    const nextClips = [...store.clips];
    nextClips[targetIdx] = updatedClip;
    const nextStore = writeStore({ ...store, clips: nextClips });

    res.json({ clip: updatedClip, store: nextStore });
  });

  app.post('/api/clips/:clipId/publish', async (req, res) => {
    const { clipId } = req.params;
    const { mode, platforms } = req.body as {
      mode?: 'auto' | 'manual';
      platforms?: SocialPlatform[];
    };

    const store = readStore();
    const targetIdx = store.clips.findIndex((c) => c.id === clipId);
    if (targetIdx === -1) {
      res.status(404).json({ error: 'Klip tidak ditemukan.' });
      return;
    }

    const clip = store.clips[targetIdx];
    const episode = store.episodes.find((e) => e.id === clip.episodeId);
    const resolvedMode = mode === 'auto' ? 'auto' : 'manual';
    const resolvedPlatforms =
      Array.isArray(platforms) && platforms.length > 0
        ? platforms
        : store.automation.defaultPlatforms;

    const webhookResult = await dispatchWebhookIfConfigured(store.automation, {
      event: 'clip.published',
      mode: resolvedMode,
      platforms: resolvedPlatforms,
      episode,
      clip,
    });

    const mergedPlatforms = Array.from(
      new Set([...clip.publishedPlatforms, ...resolvedPlatforms])
    );

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

    const nextClips = [...store.clips];
    nextClips[targetIdx] = updatedClip;

    const nextStore = writeStore({
      ...store,
      clips: nextClips,
      distributionLogs: [logEntry, ...store.distributionLogs].slice(0, 100),
    });

    res.json({
      clip: updatedClip,
      log: logEntry,
      webhookResult,
      store: nextStore,
    });
  });

  app.post('/api/clips/:clipId/youtube-upload', async (req, res) => {
    const authHeader = req.headers.authorization ?? '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    const accessToken = match?.[1]?.trim();
    if (!accessToken) {
      res.status(401).json({
        needsReauth: true,
        error: 'Silakan masuk dengan Google terlebih dahulu untuk mengunggah video ke YouTube.',
      });
      return;
    }

    const { clipId } = req.params;
    const store = readStore();
    const targetIdx = store.clips.findIndex((c) => c.id === clipId);
    if (targetIdx === -1) {
      res.status(404).json({ error: 'Klip tidak ditemukan.' });
      return;
    }

    const clip = store.clips[targetIdx];
    const episode = store.episodes.find((e) => e.id === clip.episodeId);
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
      privacyStatus: body.privacyStatus ?? store.automation.youtubeDefaultVisibility,
      includeShortsTag: store.automation.autoAddHashtagShorts,
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

      const nextClips = [...store.clips];
      nextClips[targetIdx] = updatedClip;
      const nextStore = writeStore({
        ...store,
        clips: nextClips,
        distributionLogs: [logEntry, ...store.distributionLogs].slice(0, 100),
      });

      res.json({
        ok: true,
        youtubeVideoId: uploaded.youtubeVideoId,
        youtubeWatchUrl: uploaded.youtubeWatchUrl,
        clip: updatedClip,
        store: nextStore,
      });
    } catch (err) {
      if (err instanceof YouTubeUploadHttpError) {
        res.status(err.status).json({
          needsReauth: err.needsReauth,
          error: err.message,
        });
        return;
      }
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Gagal mengunggah video ke YouTube.',
      });
    }
  });

  app.delete('/api/clips/:clipId', (req, res) => {
    const { clipId } = req.params;
    const store = readStore();
    const nextStore = writeStore({
      ...store,
      clips: store.clips.filter((c) => c.id !== clipId),
    });
    res.json({ store: nextStore });
  });

  app.put('/api/automation', (req, res) => {
    const store = readStore();
    const incoming = req.body as Partial<typeof store.automation>;
    const minClipSec = Math.max(15, Math.min(45, Number(incoming.minClipSec ?? store.automation.minClipSec)));
    const maxClipSec = Math.max(
      minClipSec + 5,
      Math.min(60, Number(incoming.maxClipSec ?? store.automation.maxClipSec))
    );
    const targetClipCount = Math.max(
      1,
      Math.min(5, Number(incoming.targetClipCount ?? store.automation.targetClipCount))
    );

    let enableUltraHdRender = store.automation.enableUltraHdRender;
    let defaultRenderQuality = store.automation.defaultRenderQuality;

    if (typeof incoming.enableUltraHdRender === 'boolean') {
      enableUltraHdRender = incoming.enableUltraHdRender;
      defaultRenderQuality = enableUltraHdRender ? '4k' : '1080p';
    } else if (incoming.defaultRenderQuality) {
      defaultRenderQuality = normalizeRenderQuality(incoming.defaultRenderQuality);
      enableUltraHdRender = defaultRenderQuality === '4k';
    }

    const defaultRenderLayout = incoming.defaultRenderLayout
      ? normalizeRenderLayout(incoming.defaultRenderLayout)
      : store.automation.defaultRenderLayout;
    const enableAiEmotionEffects =
      typeof incoming.enableAiEmotionEffects === 'boolean'
        ? incoming.enableAiEmotionEffects
        : store.automation.enableAiEmotionEffects;

    const nextStore = writeStore({
      ...store,
      automation: {
        ...store.automation,
        ...incoming,
        minClipSec,
        maxClipSec,
        targetClipCount,
        enableUltraHdRender,
        defaultRenderQuality,
        defaultRenderLayout,
        enableAiEmotionEffects,
      },
    });
    res.json({ automation: nextStore.automation, store: nextStore });
  });

  app.post('/api/automation/test-webhook', async (req, res) => {
    const store = readStore();
    const { webhookUrl, webhookSecretHeader } = req.body as {
      webhookUrl?: string;
      webhookSecretHeader?: string;
    };

    const testConfig = {
      ...store.automation,
      webhookUrl: typeof webhookUrl === 'string' ? webhookUrl : store.automation.webhookUrl,
      webhookSecretHeader:
        typeof webhookSecretHeader === 'string'
          ? webhookSecretHeader
          : store.automation.webhookSecretHeader,
    };

    const result = await dispatchWebhookIfConfigured(testConfig, { event: 'bot.test' });
    if (!result.attempted) {
      res.status(400).json({ error: 'Masukkan URL webhook terlebih dahulu untuk menguji koneksi.' });
      return;
    }
    res.json(result);
  });

  app.post('/api/reset-demo', (_req, res) => {
    const nextStore = writeStore(structuredClone(INITIAL_STUDIO_STATE));
    res.json({ store: nextStore });
  });

  app.get('/api/automation/cookies-status', (_req, res) => {
    res.json({ hasYoutubeCookies: hasYoutubeCookies() });
  });

  app.post('/api/automation/youtube-cookies', (req, res) => {
    const { cookiesTxt } = req.body as { cookiesTxt?: string };
    const result = saveYoutubeCookies(typeof cookiesTxt === 'string' ? cookiesTxt : '');
    if (result.error) {
      res.status(400).json({ error: result.error, hasYoutubeCookies: result.saved });
      return;
    }
    res.json({ hasYoutubeCookies: result.saved });
  });

  app.post('/api/episodes/:episodeId/upload-video', (req, res) => {
    const { episodeId } = req.params;
    const store = readStore();
    const epIdx = store.episodes.findIndex((e) => e.id === episodeId);
    if (epIdx === -1) {
      res.status(404).json({ error: 'Episode tidak ditemukan.' });
      return;
    }

    const destPath = getUploadTargetPath(episodeId);
    const writeStream = fs.createWriteStream(destPath);
    let bytes = 0;

    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });

    req.pipe(writeStream);

    writeStream.on('finish', () => {
      if (bytes === 0) {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        res.status(400).json({ error: 'File video kosong.' });
        return;
      }
      invalidateLowResSegmentCache(episodeId);
      const nextEpisodes = [...store.episodes];
      nextEpisodes[epIdx] = { ...nextEpisodes[epIdx], hasUploadedSourceVideo: true };
      const nextStore = writeStore({ ...store, episodes: nextEpisodes });
      res.json({ ok: true, sizeBytes: bytes, store: nextStore });
    });

    writeStream.on('error', () => {
      res.status(500).json({ error: 'Gagal menyimpan file video sumber.' });
    });
  });

  app.post('/api/episodes/:episodeId/source-url', (req, res) => {
    const { episodeId } = req.params;
    const { directVideoUrl } = (req.body ?? {}) as { directVideoUrl?: string };
    const store = readStore();
    const epIdx = store.episodes.findIndex((e) => e.id === episodeId);
    if (epIdx === -1) {
      res.status(404).json({ error: 'Episode tidak ditemukan.' });
      return;
    }

    const trimmed = typeof directVideoUrl === 'string' ? directVideoUrl.trim() : '';
    if (trimmed) {
      try {
        const parsed = new URL(trimmed);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          res.status(400).json({ error: 'URL video langsung harus menggunakan protokol HTTP/HTTPS.' });
          return;
        }
      } catch {
        res.status(400).json({ error: 'Format URL video langsung tidak valid.' });
        return;
      }
    }

    invalidateLowResSegmentCache(episodeId);
    const nextEpisodes = [...store.episodes];
    nextEpisodes[epIdx] = {
      ...nextEpisodes[epIdx],
      directVideoUrl: trimmed || undefined,
    };
    const nextStore = writeStore({ ...store, episodes: nextEpisodes });
    res.json({ ok: true, directVideoUrl: trimmed || null, store: nextStore });
  });

  const renderJobManager = new RenderJobManager();

  app.get('/api/render/capabilities', (_req, res) => {
    const store = readStore();
    const defaultLayout = normalizeRenderLayout(store.automation.defaultRenderLayout);
    const defaultQuality = resolveEffectiveRenderQuality({
      enableUltraHdRender: store.automation.enableUltraHdRender,
      defaultRenderQuality: store.automation.defaultRenderQuality,
    });
    const activeDims = getTargetCanvasDimensions(defaultLayout, defaultQuality);
    res.json({
      supportedQualities: ['1080p', '4k'] as const,
      ultraHdEnabled: store.automation.enableUltraHdRender,
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
      },
      endpoints: {
        renderClip: '/api/clips/:clipId/render-mp4',
        renderGeneric: '/api/render',
        jobStatus: '/api/render-jobs/:jobId',
      },
    });
  });

  app.get('/api/render-jobs/active', (_req, res) => {
    const active = renderJobManager.listActive();
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

  app.post('/api/render-jobs/cancel-active', (_req, res) => {
    const cancelledJobIds = renderJobManager.cancelAllRunning(
      'Semua proses render aktif dibatalkan oleh pengguna.'
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      cancelledCount: cancelledJobIds.length,
      cancelledJobIds,
    });
  });

  app.post('/api/render-jobs/:jobId/cancel', (req, res) => {
    const { found, wasRunning, job } = renderJobManager.cancel(
      req.params.jobId,
      'Proses render dibatalkan oleh pengguna.'
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      found,
      wasRunning,
      jobId: req.params.jobId,
      status: job?.status ?? 'missing',
    });
  });

  app.get('/api/render-jobs/:jobId', (req, res) => {
    const job = renderJobManager.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Antrean render tidak ditemukan.' });
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

  // Server-Sent Events (SSE) live progress stream: cuts polling requests by 95%+ so
  // Cloud Run / preview edge rate limiters (HTTP 429) are never triggered during 4K renders.
  app.get('/api/render-jobs/:jobId/events', (req, res) => {
    const jobId = req.params.jobId;
    const job = renderJobManager.get(jobId);
    if (!job) {
      res.status(404).json({ error: 'Antrean render tidak ditemukan.' });
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

      // Gracefully recycle stream before Cloud Run's 60s HTTP timeout so browser reconnects cleanly
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

  const handleEnqueueRender = (
    req: express.Request,
    res: express.Response,
    explicitClipId?: string
  ) => {
    renderJobManager.pruneOld();
    const body = (req.body ?? {}) as {
      clipId?: string;
      layout?: ClipRenderLayout;
      quality?: ClipRenderQuality | string;
      enableEmotionEffects?: boolean;
      forceRestart?: boolean;
    };
    const clipId = explicitClipId ?? body.clipId;
    if (!clipId) {
      res.status(400).json({ error: 'Parameter clipId wajib diisi.' });
      return;
    }

    const store = readStore();
    const clip = store.clips.find((c) => c.id === clipId);
    if (!clip) {
      res.status(404).json({ error: 'Klip tidak ditemukan.' });
      return;
    }
    const episode = store.episodes.find((e) => e.id === clip.episodeId);
    if (!episode) {
      res.status(404).json({ error: 'Episode podcast sumber tidak ditemukan.' });
      return;
    }

    const resolvedLayout = normalizeRenderLayout(
      body.layout ?? store.automation.defaultRenderLayout
    );
    const resolvedQuality = resolveEffectiveRenderQuality({
      requestedQuality: body.quality,
      enableUltraHdRender: store.automation.enableUltraHdRender,
      defaultRenderQuality: store.automation.defaultRenderQuality,
    });
    const resolvedEmotionEffects =
      typeof body.enableEmotionEffects === 'boolean'
        ? body.enableEmotionEffects
        : store.automation.enableAiEmotionEffects;
    const targetDims = getTargetCanvasDimensions(resolvedLayout, resolvedQuality);

    const dedupeKey = `${clip.id}:${resolvedLayout}:${resolvedQuality}:${resolvedEmotionEffects ? 'emo1' : 'emo0'}:${clip.startSec}-${clip.endSec}`;
    const initialStage =
      resolvedQuality === '4k'
        ? 'Menyiapkan render 4K Ultra HD (2160p)...'
        : 'Menyiapkan render 1080p Full HD...';

    const { job, reused } = renderJobManager.createOrReuse({
      clipId: clip.id,
      dedupeKey,
      initialStage,
      initialProgress: 8,
      forceRestart: Boolean(body.forceRestart),
    });

    // Respond immediately (<50ms) so Cloud Run / reverse-proxy 60s HTTP timeout is never triggered
    res.status(202).json({
      jobId: job.jobId,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      quality: resolvedQuality,
      isUltraHd: resolvedQuality === '4k',
      targetWidth: targetDims.outW,
      targetHeight: targetDims.outH,
    });

    if (reused) {
      return;
    }

    const jobSignal = job.abortController.signal;

    void (async () => {
      try {
        const result = await renderClipMp4({
          episode,
          clip,
          layout: resolvedLayout,
          quality: resolvedQuality,
          enableEmotionEffects: resolvedEmotionEffects,
          signal: jobSignal,
          onProgress: (stage, progress) => {
            renderJobManager.updateProgress(job.jobId, stage, progress);
          },
        });
        if (jobSignal.aborted) {
          return;
        }
        const videoUrl = `/api/clips/${clip.id}/video?t=${Date.now()}`;
        const intel = result.intelligence;
        const isAudioAccurate = intel.subtitleSource === 'audio_transcribed';

        // Re-read latest store state to avoid overwriting concurrent updates
        const latestStore = readStore();
        const latestIdx = latestStore.clips.findIndex((c) => c.id === clip.id);
        const latestClip = latestIdx >= 0 ? latestStore.clips[latestIdx] : clip;
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
          title: isAudioAccurate ? intel.autoTitle : latestClip.title,
          captionCues: intel.cues.length > 0 ? intel.cues : latestClip.captionCues,
          transcriptExcerpt: intel.verbatimTranscript || latestClip.transcriptExcerpt,
          renderedClipUrl: videoUrl,
          renderedLayout: result.layout,
          renderedQuality: result.quality,
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
          platformCopies: {
            ...latestClip.platformCopies,
            youtube_shorts: nextYoutubeCopy,
          },
        };

        const nextClips = [...latestStore.clips];
        if (latestIdx >= 0) {
          nextClips[latestIdx] = updatedClip;
        }
        const nextStore = writeStore({ ...latestStore, clips: nextClips });

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
          isUltraHd: result.quality === '4k',
          emotionEffectsEnabled: result.emotionEffectsEnabled,
          emotionMoments: intel.emotionMoments,
          emotionSummary: intel.emotionSummary,
          subtitleSource: intel.subtitleSource,
          speakerFocusSummary: intel.speakerFocusSummary,
          autoTitle: intel.autoTitle,
          autoCaption: intel.autoCaption,
          store: nextStore,
        });
      } catch (err) {
        if (err instanceof RenderCancelledError || jobSignal.aborted) {
          renderJobManager.cancel(job.jobId, 'Proses render dibatalkan.');
          return;
        }
        if (err instanceof YoutubeBotCheckError) {
          renderJobManager.fail(job.jobId, err.message, err.code);
        } else {
          renderJobManager.fail(
            job.jobId,
            err instanceof Error ? err.message : 'Gagal merender video klip MP4.'
          );
        }
      }
    })();
  };

  app.post('/api/clips/:clipId/render-mp4', (req, res) => {
    handleEnqueueRender(req, res, req.params.clipId);
  });

  app.post('/api/render', (req, res) => {
    handleEnqueueRender(req, res);
  });

  app.get('/api/clips/:clipId/video', (req, res) => {
    const { clipId } = req.params;
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
    res.setHeader('Cache-Control', 'no-cache');

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

    // Fallback when no Range header was supplied (e.g., direct download or HEAD probe)
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

  if (process.env.NODE_ENV !== 'production') {
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`KlipCast server listening on http://localhost:${PORT}`);
    void prewarmYtDlpBinary();
  });
}

startServer().catch((err) => {
  console.error('Failed to start KlipCast server:', err);
  process.exit(1);
});
