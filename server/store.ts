import fs from 'fs';
import path from 'path';
import { INITIAL_STUDIO_STATE } from '../src/data/seedPodcasts.ts';
import type {
  BotAutomationConfig,
  DistributionLog,
  PodcastClip,
  PodcastEpisode,
  SocialPlatform,
  StudioStoreState,
} from '../src/types/clipper.ts';
import {
  DEFAULT_AUTOMATION_MAX_CLIP_SEC,
  DEFAULT_AUTOMATION_MIN_CLIP_SEC,
  formatTimestamp,
  generateSrtFromClip,
  normalizeAutomationDurationBounds,
} from '../src/utils/youtube.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const RENDERS_DIR = path.join(DATA_DIR, 'renders');
const STORE_PATH = path.join(DATA_DIR, 'klipcast-store.json');

function reconcileClipRenderFiles(clips: PodcastClip[]): PodcastClip[] {
  return clips.map((clip) => {
    if (clip.renderedClipUrl && clip.renderedClipUrl.startsWith('/api/clips/')) {
      const expectedFile = path.join(RENDERS_DIR, `${clip.id}.mp4`);
      if (!fs.existsSync(expectedFile)) {
        const rest = { ...clip };
        delete rest.renderedClipUrl;
        delete rest.renderedFileSizeBytes;
        return rest;
      }
    }
    return clip;
  });
}

function ensureStoreFile(): StudioStoreState {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(STORE_PATH)) {
    const initial = structuredClone(INITIAL_STUDIO_STATE);
    fs.writeFileSync(STORE_PATH, JSON.stringify(initial, null, 2), 'utf-8');
    return initial;
  }
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as StudioStoreState;
    if (!Array.isArray(parsed.episodes) || !Array.isArray(parsed.clips)) {
      throw new Error('Corrupt store');
    }
    const baseAuto = INITIAL_STUDIO_STATE.automation;
    const rawAuto = (parsed.automation ?? {}) as Partial<BotAutomationConfig>;
    const enableUltraHdRender =
      typeof rawAuto.enableUltraHdRender === 'boolean'
        ? rawAuto.enableUltraHdRender
        : rawAuto.defaultRenderQuality === '4k';
    const defaultRenderQuality =
      rawAuto.defaultRenderQuality === '4k' || enableUltraHdRender ? '4k' : '1080p';
    const defaultRenderLayout =
      rawAuto.defaultRenderLayout === 'full_16_9_focus' ||
      rawAuto.defaultRenderLayout === 'shorts_studio_focus' ||
      rawAuto.defaultRenderLayout === 'shorts_full_bleed'
        ? rawAuto.defaultRenderLayout
        : baseAuto.defaultRenderLayout;
    const enableAiEmotionEffects =
      typeof rawAuto.enableAiEmotionEffects === 'boolean'
        ? rawAuto.enableAiEmotionEffects
        : baseAuto.enableAiEmotionEffects;
    const enableAiIntro =
      typeof rawAuto.enableAiIntro === 'boolean'
        ? rawAuto.enableAiIntro
        : baseAuto.enableAiIntro;
    const isLegacyShortDefault = rawAuto.minClipSec === 25 && rawAuto.maxClipSec === 55;
    const { minClipSec, maxClipSec } = isLegacyShortDefault
      ? {
          minClipSec: DEFAULT_AUTOMATION_MIN_CLIP_SEC,
          maxClipSec: DEFAULT_AUTOMATION_MAX_CLIP_SEC,
        }
      : normalizeAutomationDurationBounds(rawAuto.minClipSec, rawAuto.maxClipSec);

    return {
      ...parsed,
      clips: reconcileClipRenderFiles(parsed.clips),
      automation: {
        ...baseAuto,
        ...rawAuto,
        minClipSec,
        maxClipSec,
        enableUltraHdRender,
        defaultRenderQuality,
        defaultRenderLayout,
        enableAiEmotionEffects,
        enableAiIntro,
      },
    };
  } catch {
    const initial = structuredClone(INITIAL_STUDIO_STATE);
    fs.writeFileSync(STORE_PATH, JSON.stringify(initial, null, 2), 'utf-8');
    return initial;
  }
}

export function readStore(): StudioStoreState {
  return ensureStoreFile();
}

export function writeStore(next: StudioStoreState): StudioStoreState {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(STORE_PATH, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

export async function dispatchWebhookIfConfigured(
  config: BotAutomationConfig,
  payload: {
    event: 'clip.published' | 'bot.test';
    mode?: 'auto' | 'manual';
    platforms?: SocialPlatform[];
    episode?: PodcastEpisode;
    clip?: PodcastClip;
  }
): Promise<{ attempted: boolean; delivered: boolean; statusCode?: number; error?: string }> {
  const url = config.webhookUrl.trim();
  if (!url) {
    return { attempted: false, delivered: false };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { attempted: true, delivered: false, error: 'Protokol webhook harus HTTP/HTTPS.' };
    }
  } catch {
    return { attempted: true, delivered: false, error: 'Format URL webhook tidak valid.' };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'KlipCast-Bot/1.0',
  };
  if (config.webhookSecretHeader.trim()) {
    headers['X-KlipCast-Secret'] = config.webhookSecretHeader.trim();
  }

  const body =
    payload.event === 'bot.test'
      ? {
          event: 'bot.test',
          sentAt: new Date().toISOString(),
          message: 'Koneksi webhook bot KlipCast aktif.',
        }
      : {
          event: 'clip.published',
          sentAt: new Date().toISOString(),
          mode: payload.mode,
          platforms: payload.platforms,
          youtubeVisibility: config.youtubeDefaultVisibility,
          renderQuality: config.enableUltraHdRender ? '4k' : config.defaultRenderQuality,
          ultraHdEnabled: config.enableUltraHdRender,
          episode: payload.episode
            ? {
                id: payload.episode.id,
                videoId: payload.episode.videoId,
                sourceUrl: payload.episode.sourceUrl,
                title: payload.episode.title,
                channelName: payload.episode.channelName,
              }
            : null,
          clip: payload.clip
            ? {
                id: payload.clip.id,
                title: payload.clip.title,
                startTime: formatTimestamp(payload.clip.startSec),
                endTime: formatTimestamp(payload.clip.endSec),
                startSec: payload.clip.startSec,
                endSec: payload.clip.endSec,
                durationSec: payload.clip.endSec - payload.clip.startSec,
                renderedClipUrl: payload.clip.renderedClipUrl ?? null,
                renderedQuality:
                  payload.clip.renderedQuality ??
                  (config.enableUltraHdRender ? '4k' : config.defaultRenderQuality),
                ringkasanTeks: payload.clip.ringkasanTeks,
                poinKunci: payload.clip.poinKunci,
                srtSubtitles: generateSrtFromClip(payload.clip),
                platformCopies: payload.clip.platformCopies,
              }
            : null,
        };

  try {
    const res = await fetch(parsedUrl.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });
    return {
      attempted: true,
      delivered: res.ok,
      statusCode: res.status,
      error: res.ok ? undefined : `Server webhook membalas HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      attempted: true,
      delivered: false,
      error: err instanceof Error ? err.message : 'Gagal terhubung ke endpoint webhook.',
    };
  }
}

export function buildDistributionLog(params: {
  clip: PodcastClip;
  episodeTitle: string;
  mode: 'auto' | 'manual';
  platforms: SocialPlatform[];
  webhookResult: { attempted: boolean; delivered: boolean; statusCode?: number; error?: string };
}): DistributionLog {
  const { clip, episodeTitle, mode, platforms, webhookResult } = params;
  const status: DistributionLog['status'] =
    webhookResult.attempted && !webhookResult.delivered ? 'partial' : 'success';

  const platformNames = platforms.join(', ');
  const message = webhookResult.attempted
    ? webhookResult.delivered
      ? `Terkirim ke webhook bot (HTTP ${webhookResult.statusCode}) & paket ${mode === 'auto' ? 'otomatis' : 'manual'} disiapkan untuk: ${platformNames}.`
      : `Paket disiapkan untuk ${platformNames}, namun webhook gagal (${webhookResult.error ?? 'error'}).`
    : mode === 'auto'
      ? `Bot memproses publikasi otomatis untuk ${platformNames}.`
      : `Paket YouTube Shorts & salinan sosial disiapkan secara manual (${platformNames}).`;

  return {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    clipId: clip.id,
    clipTitle: clip.title,
    episodeTitle,
    mode,
    platforms,
    webhookDelivered: webhookResult.delivered,
    webhookStatusCode: webhookResult.statusCode,
    status,
    message,
    timestamp: new Date().toISOString(),
  };
}
