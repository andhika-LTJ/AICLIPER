import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import { z } from 'zod';
import type {
  ClipQualityScores,
  ClippingApproach,
  EpisodeChapter,
  PodcastClip,
  PodcastEpisode,
  SocialPlatform,
} from '../src/types/clipper.ts';
import { resolveAssetUrl } from '../src/utils/assetUrl.ts';
import {
  clampClipRange,
  formatGeminiErrorMessage,
  formatTimestamp,
  normalizeAutomationDurationBounds,
  SHORTS_MAX_CLIP_SEC,
} from '../src/utils/youtube.ts';

interface TranscriptSegment {
  startSec: number;
  durationSec: number;
  text: string;
}

interface YouTubeFetchedContext {
  videoId: string;
  title: string;
  channelName: string;
  thumbnailUrl: string;
  durationSec: number;
  description: string;
  transcriptSegments: TranscriptSegment[];
  transcriptSource: PodcastEpisode['transcriptSource'];
}

export interface GeminiUsageMeta {
  model: string;
  promptTokens: number;
  outputTokens: number;
  cached: boolean;
}

export interface QualityScoreWeights {
  hookStrength: number;
  emotionalImpact: number;
  informationValue: number;
  entertainmentValue: number;
  contextCompleteness: number;
  engagementPotential: number;
  shareabilityPotential: number;
}

export const DEFAULT_QUALITY_SCORE_WEIGHTS: QualityScoreWeights = {
  hookStrength: 0.22,
  emotionalImpact: 0.14,
  informationValue: 0.15,
  entertainmentValue: 0.11,
  contextCompleteness: 0.14,
  engagementPotential: 0.12,
  shareabilityPotential: 0.12,
};

function clampScore(val: unknown, fallback = 78): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(40, Math.min(99, Math.round(n)));
}

/**
 * Computes a transparent, weighted 7-dimension Content Quality Score ("Estimasi Kualitas Konten")
 * with configurable weights so creators get an honest, structured editorial signal rather than a black-box number.
 */
export function computeWeightedContentQualityScore(
  raw: Partial<ClipQualityScores> | undefined,
  fallbackBase = 84,
  weights: QualityScoreWeights = DEFAULT_QUALITY_SCORE_WEIGHTS
): ClipQualityScores {
  const hookStrength = clampScore(raw?.hookStrength, fallbackBase + 2);
  const emotionalImpact = clampScore(raw?.emotionalImpact, fallbackBase - 2);
  const informationValue = clampScore(raw?.informationValue, fallbackBase + 1);
  const entertainmentValue = clampScore(raw?.entertainmentValue, fallbackBase - 3);
  const contextCompleteness = clampScore(raw?.contextCompleteness, fallbackBase);
  const engagementPotential = clampScore(raw?.engagementPotential, fallbackBase);
  const shareabilityPotential = clampScore(raw?.shareabilityPotential, fallbackBase - 1);

  const totalWeight =
    weights.hookStrength +
    weights.emotionalImpact +
    weights.informationValue +
    weights.entertainmentValue +
    weights.contextCompleteness +
    weights.engagementPotential +
    weights.shareabilityPotential;

  const weighted =
    (hookStrength * weights.hookStrength +
      emotionalImpact * weights.emotionalImpact +
      informationValue * weights.informationValue +
      entertainmentValue * weights.entertainmentValue +
      contextCompleteness * weights.contextCompleteness +
      engagementPotential * weights.engagementPotential +
      shareabilityPotential * weights.shareabilityPotential) /
    (totalWeight || 1);

  const validTypes = new Set([
    'lucu',
    'emosional',
    'kontroversial',
    'inspiratif',
    'edukatif',
    'informatif',
  ]);
  const momentType =
    raw?.momentType && validTypes.has(raw.momentType)
      ? raw.momentType
      : 'informatif';

  return {
    hookStrength,
    emotionalImpact,
    informationValue,
    entertainmentValue,
    contextCompleteness,
    engagementPotential,
    shareabilityPotential,
    overallScore: clampScore(Math.round(weighted), fallbackBase),
    momentType,
  };
}

/**
 * Removes near-duplicate/heavily overlapping clips (>65% overlap ratio) while keeping
 * the highest quality-scored clip first.
 */
export function deduplicateOverlappingClips<
  T extends { startSec: number; endSec: number; viralScore?: number },
>(clips: T[], maxOverlapRatio = 0.65): T[] {
  const sorted = [...clips].sort((a, b) => (b.viralScore ?? 0) - (a.viralScore ?? 0));
  const accepted: T[] = [];

  for (const candidate of sorted) {
    const cDur = Math.max(1, candidate.endSec - candidate.startSec);
    const hasHeavyOverlap = accepted.some((existing) => {
      const overlapStart = Math.max(existing.startSec, candidate.startSec);
      const overlapEnd = Math.min(existing.endSec, candidate.endSec);
      const overlapDur = Math.max(0, overlapEnd - overlapStart);
      const minDur = Math.min(cDur, Math.max(1, existing.endSec - existing.startSec));
      return overlapDur / minDur > maxOverlapRatio;
    });
    if (!hasHeavyOverlap) {
      accepted.push(candidate);
    }
  }
  return accepted;
}

const RawClipZodSchema = z.object({
  title: z.string().min(2),
  hookLine: z.string().min(2),
  startSec: z.number(),
  endSec: z.number(),
  viralScore: z.number().optional(),
  viralReason: z.string().optional(),
  priorityLabel: z.string().optional(),
  momentType: z
    .enum(['lucu', 'emosional', 'kontroversial', 'inspiratif', 'edukatif', 'informatif'])
    .optional(),
  qualityScores: z
    .object({
      hookStrength: z.number().optional(),
      emotionalImpact: z.number().optional(),
      informationValue: z.number().optional(),
      entertainmentValue: z.number().optional(),
      contextCompleteness: z.number().optional(),
      engagementPotential: z.number().optional(),
      shareabilityPotential: z.number().optional(),
    })
    .optional(),
  ringkasanTeks: z.string().min(2),
  poinKunci: z.array(z.string()).default([]),
  transcriptExcerpt: z.string().default(''),
  captionCues: z
    .array(
      z.object({
        offsetSec: z.number(),
        durationSec: z.number(),
        text: z.string(),
      })
    )
    .default([]),
  youtubeTitle: z.string().default(''),
  youtubeCaption: z.string().default(''),
  youtubeHashtags: z.array(z.string()).default([]),
  tiktokTitle: z.string().default(''),
  tiktokCaption: z.string().default(''),
  tiktokHashtags: z.array(z.string()).default([]),
  instagramTitle: z.string().default(''),
  instagramCaption: z.string().default(''),
  instagramHashtags: z.array(z.string()).default([]),
  facebookTitle: z.string().optional(),
  facebookCaption: z.string().optional(),
  facebookHashtags: z.array(z.string()).optional(),
  xTitle: z.string().default(''),
  xCaption: z.string().default(''),
  xHashtags: z.array(z.string()).default([]),
  linkedinTitle: z.string().default(''),
  linkedinCaption: z.string().default(''),
  linkedinHashtags: z.array(z.string()).default([]),
});

const AnalyzerResponseZodSchema = z.object({
  episodeSummary: z.string().min(5),
  keyTopics: z.array(z.string()).default([]),
  chapters: z
    .array(
      z.object({
        timeSec: z.number(),
        title: z.string(),
      })
    )
    .optional(),
  keyQuotes: z.array(z.string()).optional(),
  clips: z.array(RawClipZodSchema).min(1),
});

interface AnalysisCacheEntry {
  episode: PodcastEpisode;
  clips: PodcastClip[];
  expiresAtMs: number;
}

const analysisCache = new Map<string, AnalysisCacheEntry>();
const ANALYSIS_CACHE_TTL_MS = 20 * 60 * 1000;

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseIso8601Duration(iso: string): number | null {
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return null;
  const h = Number(match[1] ?? 0);
  const m = Number(match[2] ?? 0);
  const s = Number(match[3] ?? 0);
  const total = h * 3600 + m * 60 + s;
  return total > 10 ? total : null;
}

export async function fetchYouTubeContext(
  videoId: string,
  manualTranscript?: string
): Promise<YouTubeFetchedContext> {
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  let title = `Podcast YouTube (${videoId})`;
  let channelName = 'Kanal Podcast YouTube';
  let thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  let durationSec = 1800;
  let description = '';
  let transcriptSegments: TranscriptSegment[] = [];
  let transcriptSource: PodcastEpisode['transcriptSource'] = 'metadata_and_search';

  await Promise.all([
    (async () => {
      try {
        const thumbRes = await fetch(`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`, {
          method: 'HEAD',
          signal: AbortSignal.timeout(2500),
        });
        if (thumbRes.ok) {
          thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
        }
      } catch {
        // Keep hqdefault fallback
      }
    })(),
    (async () => {
      try {
        const oembedRes = await fetch(
          `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (oembedRes.ok) {
          const oembed = (await oembedRes.json()) as {
            title?: string;
            author_name?: string;
            thumbnail_url?: string;
          };
          if (oembed.title) title = oembed.title;
          if (oembed.author_name) channelName = oembed.author_name;
          if (oembed.thumbnail_url && thumbnailUrl.includes('hqdefault')) {
            thumbnailUrl = oembed.thumbnail_url;
          }
        }
      } catch {
        // Fallback to watch page or defaults
      }
    })(),
  ]);

  if (manualTranscript && manualTranscript.trim().length > 30) {
    const lines = manualTranscript
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    transcriptSegments = lines.map((line, i) => ({
      startSec: i * 12,
      durationSec: 12,
      text: line,
    }));
    transcriptSource = 'manual_transcript';
  } else {
    try {
      const pageRes = await fetch(canonicalUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        },
        signal: AbortSignal.timeout(7000),
      });

      if (pageRes.ok) {
        const html = await pageRes.text();
        const metaDur = html.match(/itemprop=["']duration["']\s+content=["']([^"']+)["']/i)?.[1];
        if (metaDur) {
          const parsedIso = parseIso8601Duration(metaDur);
          if (parsedIso) durationSec = parsedIso;
        }
        const metaDesc = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)?.[1];
        if (metaDesc && !description) {
          description = decodeHtmlEntities(metaDesc).slice(0, 3000);
        }

        const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
        if (playerMatch?.[1]) {
          try {
            const playerJson = JSON.parse(playerMatch[1]);
            const details = playerJson?.videoDetails;
            if (details?.title) title = details.title;
            if (details?.author) channelName = details.author;
            if (details?.lengthSeconds) {
              const parsedLen = Number(details.lengthSeconds);
              if (Number.isFinite(parsedLen) && parsedLen > 30) {
                durationSec = parsedLen;
              }
            }
            if (details?.shortDescription) {
              description = String(details.shortDescription).slice(0, 3000);
            }

            const tracks = playerJson?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
            if (Array.isArray(tracks) && tracks.length > 0) {
              const preferred =
                tracks.find((t: { languageCode?: string }) => t.languageCode === 'id') ??
                tracks.find((t: { languageCode?: string }) => t.languageCode?.startsWith('en')) ??
                tracks[0];
              if (preferred?.baseUrl) {
                const capRes = await fetch(preferred.baseUrl, { signal: AbortSignal.timeout(5000) });
                if (capRes.ok) {
                  const xml = await capRes.text();
                  const regex = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
                  let match: RegExpExecArray | null;
                  while ((match = regex.exec(xml)) !== null) {
                    const text = decodeHtmlEntities(match[3]);
                    if (text) {
                      transcriptSegments.push({
                        startSec: Number(match[1]),
                        durationSec: Number(match[2]) || 3,
                        text,
                      });
                    }
                  }
                  if (transcriptSegments.length > 5) {
                    transcriptSource = 'youtube_captions';
                  }
                }
              }
            }
          } catch {
            // Ignore malformed inline player JSON
          }
        }
      }
    } catch {
      // Watch page fetch failed or timed out; proceed with Gemini metadata/search grounding
    }
  }

  return {
    videoId,
    title,
    channelName,
    thumbnailUrl,
    durationSec,
    description,
    transcriptSegments,
    transcriptSource,
  };
}

interface AnalyzeOptions {
  episodeId: string;
  sourceUrl: string;
  videoId: string;
  manualTranscript?: string;
  targetClipCount: number;
  minDurationSec: number;
  maxDurationSec: number;
  autoAddHashtagShorts: boolean;
  clippingApproach?: ClippingApproach;
  skipCache?: boolean;
}

const APPROACH_DIRECTIVES: Record<ClippingApproach, string> = {
  educational:
    'PENDEKATAN EDUKATIF: Prioritaskan momen penjelasan konsep, framework, langkah praktis, atau kesalahan umum yang memberi nilai belajar langsung bagi audiens.',
  storytelling:
    'PENDEKATAN STORYTELLING: Prioritaskan kisah personal, konflik, titik balik, dan resolusi naratif yang membuat penonton mengikuti cerita sampai selesai.',
  motivational:
    'PENDEKATAN MOTIVASIONAL: Prioritaskan momen inspiratif, mindset shift, refleksi perjuangan, atau pesan penguat yang mendorong audiens bertindak.',
  informative:
    'PENDEKATAN INFORMATIF: Prioritaskan fakta menarik, data spesifik, berita/tren industri, dan wawasan padat yang mudah dicerna dan dibagikan.',
  entertainment:
    'PENDEKATAN HIBURAN: Prioritaskan momen lucu, spontan, banter tajam, reaksi tak terduga, dan punchline yang mengundang tawa atau komentar.',
  promotional:
    'PENDEKATAN PROMOSIONAL / HOOK BISNIS: Prioritaskan momen studi kasus, bukti hasil, masalah-solusi produk/jasa, dan ajakan bernilai tinggi tanpa terasa hard-selling.',
};

const APPROACH_PLATFORM_HINT: Record<ClippingApproach, SocialPlatform> = {
  educational: 'youtube_shorts',
  storytelling: 'tiktok',
  motivational: 'instagram_reels',
  informative: 'linkedin',
  entertainment: 'tiktok',
  promotional: 'instagram_reels',
};

export async function analyzePodcastWithGemini(
  options: AnalyzeOptions
): Promise<{
  episode: PodcastEpisode;
  clips: PodcastClip[];
  usage: GeminiUsageMeta;
}> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY belum tersedia di environment server.');
  }

  const approach: ClippingApproach = options.clippingApproach ?? 'educational';
  const normalizedBounds = normalizeAutomationDurationBounds(
    options.minDurationSec,
    options.maxDurationSec
  );
  const cacheKey = `${options.videoId}:${approach}:${options.targetClipCount}:${normalizedBounds.minClipSec}-${normalizedBounds.maxClipSec}:${options.autoAddHashtagShorts ? '1' : '0'}:${(options.manualTranscript ?? '').trim().slice(0, 120)}`;

  if (!options.skipCache) {
    const cached = analysisCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      const clonedEpisode: PodcastEpisode = {
        ...structuredClone(cached.episode),
        id: options.episodeId,
        sourceUrl: options.sourceUrl,
        createdAt: new Date().toISOString(),
      };
      const clonedClips: PodcastClip[] = structuredClone(cached.clips).map((clip, idx) => ({
        ...clip,
        id: `${options.episodeId}-clip-${idx + 1}`,
        episodeId: options.episodeId,
        status: 'draft',
        publishedPlatforms: [],
      }));
      return {
        episode: clonedEpisode,
        clips: clonedClips,
        usage: { model: 'cache', promptTokens: 0, outputTokens: 0, cached: true },
      };
    }
  }

  const ctx = await fetchYouTubeContext(options.videoId, options.manualTranscript);

  let transcriptContext = '';
  if (ctx.transcriptSegments.length > 0) {
    transcriptContext = ctx.transcriptSegments
      .slice(0, 450)
      .map((s) => `[${formatTimestamp(s.startSec)} | ${Math.floor(s.startSec)}s] ${s.text}`)
      .join('\n')
      .slice(0, 18000);
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const targetMinSec = Math.min(normalizedBounds.minClipSec, Math.max(15, ctx.durationSec));
  const targetMaxSec = Math.min(
    SHORTS_MAX_CLIP_SEC,
    Math.max(targetMinSec, normalizedBounds.maxClipSec, Math.min(ctx.durationSec, targetMinSec + 15))
  );

  const prompt = `Kamu adalah AI Viral Video Strategist & Produser Podcast Shorts kelas atas.
Analisis link video podcast YouTube berikut untuk menemukan ${options.targetClipCount} momen TERBAIK dengan durasi UTUH ${targetMinSec}–${targetMaxSec} detik per klip.

Data Video:
- URL: ${options.sourceUrl}
- Video ID: ${ctx.videoId}
- Judul Episode: ${ctx.title}
- Channel: ${ctx.channelName}
- Perkiraan Durasi Total: ${ctx.durationSec} detik (${formatTimestamp(ctx.durationSec)})
- Deskripsi Video: ${ctx.description || '(tidak tersedia)'}
- Sumber Transkrip: ${ctx.transcriptSource}

${
  transcriptContext
    ? `Transkrip Berstempel Waktu:\n${transcriptContext}`
    : `Transkrip langsung belum tersedia. Gunakan pencarian web untuk menelusuri topik episode "${ctx.title}" (${ctx.channelName}), pembicara/bintang tamu, kutipan penting, atau chapter video ini, lalu petakan momen terbaik beserta rentang timestamp yang logis di dalam 0 sampai ${ctx.durationSec} detik.`
}

Kriteria WAJIB:
0. ${APPROACH_DIRECTIVES[approach]}
1. ALUR CERITA UTUH (${targetMinSec}–${targetMaxSec} detik): JANGAN memilih potongan 10–25 detik yang menggantung. Setiap klip wajib mencakup Hook Pembuka (0–5d), Penjelasan/Cerita Detail, dan Klimaks/Kesimpulan Tuntas. Pastikan timestamp antar klip TIDAK saling tumpang tindih.
2. KESESUAIAN JUDUL 100%: Judul di setiap platform wajib relevan dengan isi klip.${options.autoAddHashtagShorts ? ' Sertakan #Shorts pada youtubeTitle.' : ''}
3. SKOR ESTIMASI KUALITAS KONTEN 7 DIMENSI (nilai 40–99): Isi \`qualityScores\` (hookStrength, emotionalImpact, informationValue, entertainmentValue, contextCompleteness, engagementPotential, shareabilityPotential) serta \`momentType\` ("lucu" | "emosional" | "kontroversial" | "inspiratif" | "edukatif" | "informatif") dan \`viralReason\` 1 kalimat jujur.
4. EKSTRAKSI EPISODE: Sertakan \`chapters\` (3–5 chapter berstempel waktu) dan \`keyQuotes\` (2–4 kutipan kunci verbatim/relevan dari episode).
5. CAPTION LINTAS PLATFORM: Buat copy lengkap untuk YouTube Shorts, TikTok, Instagram Reels, Facebook Reels, X/Twitter, dan LinkedIn dengan 4–6 hashtag relevan.
6. SUBTITLE: Sertakan 6–10 \`captionCues\` merata dari awal sampai akhir klip.`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      episodeSummary: { type: Type.STRING },
      keyTopics: { type: Type.ARRAY, items: { type: Type.STRING } },
      chapters: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            timeSec: { type: Type.INTEGER },
            title: { type: Type.STRING },
          },
          required: ['timeSec', 'title'],
        },
      },
      keyQuotes: { type: Type.ARRAY, items: { type: Type.STRING } },
      clips: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            hookLine: { type: Type.STRING },
            startSec: { type: Type.INTEGER },
            endSec: { type: Type.INTEGER },
            viralScore: { type: Type.INTEGER },
            viralReason: { type: Type.STRING },
            momentType: { type: Type.STRING },
            qualityScores: {
              type: Type.OBJECT,
              properties: {
                hookStrength: { type: Type.INTEGER },
                emotionalImpact: { type: Type.INTEGER },
                informationValue: { type: Type.INTEGER },
                entertainmentValue: { type: Type.INTEGER },
                contextCompleteness: { type: Type.INTEGER },
                engagementPotential: { type: Type.INTEGER },
                shareabilityPotential: { type: Type.INTEGER },
              },
            },
            priorityLabel: { type: Type.STRING },
            ringkasanTeks: { type: Type.STRING },
            poinKunci: { type: Type.ARRAY, items: { type: Type.STRING } },
            transcriptExcerpt: { type: Type.STRING },
            captionCues: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  offsetSec: { type: Type.NUMBER },
                  durationSec: { type: Type.NUMBER },
                  text: { type: Type.STRING },
                },
                required: ['offsetSec', 'durationSec', 'text'],
              },
            },
            youtubeTitle: { type: Type.STRING },
            youtubeCaption: { type: Type.STRING },
            youtubeHashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
            tiktokTitle: { type: Type.STRING },
            tiktokCaption: { type: Type.STRING },
            tiktokHashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
            instagramTitle: { type: Type.STRING },
            instagramCaption: { type: Type.STRING },
            instagramHashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
            facebookTitle: { type: Type.STRING },
            facebookCaption: { type: Type.STRING },
            facebookHashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
            xTitle: { type: Type.STRING },
            xCaption: { type: Type.STRING },
            xHashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
            linkedinTitle: { type: Type.STRING },
            linkedinCaption: { type: Type.STRING },
            linkedinHashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: [
            'title',
            'hookLine',
            'startSec',
            'endSec',
            'viralScore',
            'viralReason',
            'ringkasanTeks',
            'poinKunci',
            'transcriptExcerpt',
            'captionCues',
            'youtubeTitle',
            'youtubeCaption',
            'youtubeHashtags',
            'tiktokTitle',
            'tiktokCaption',
            'tiktokHashtags',
            'instagramTitle',
            'instagramCaption',
            'instagramHashtags',
            'xTitle',
            'xCaption',
            'xHashtags',
            'linkedinTitle',
            'linkedinCaption',
            'linkedinHashtags',
          ],
        },
      },
    },
    required: ['episodeSummary', 'keyTopics', 'clips'],
  };

  const attempts: Array<{ model: string; useSearch: boolean; useThinkingLow: boolean }> =
    transcriptContext
      ? [
          { model: 'gemini-4-hydrogen', useSearch: false, useThinkingLow: true },
          { model: 'gemini-3.1-flash-lite', useSearch: false, useThinkingLow: false },
        ]
      : [
          { model: 'gemini-4-hydrogen', useSearch: true, useThinkingLow: true },
          { model: 'gemini-4-hydrogen', useSearch: false, useThinkingLow: true },
          { model: 'gemini-3.1-flash-lite', useSearch: false, useThinkingLow: false },
        ];

  let response: Awaited<ReturnType<typeof ai.models.generateContent>> | null = null;
  let usedModel = attempts[0].model;
  let lastErr: unknown = null;

  for (const attempt of attempts) {
    try {
      usedModel = attempt.model;
      response = await ai.models.generateContent({
        model: attempt.model,
        contents: prompt,
        config: {
          ...(attempt.useThinkingLow
            ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
            : {}),
          ...(attempt.useSearch ? { tools: [{ googleSearch: {} }] } : {}),
          responseMimeType: 'application/json',
          responseSchema,
          abortSignal: AbortSignal.timeout(attempt.useSearch ? 24_000 : 35_000),
        },
      });
      break;
    } catch (err) {
      lastErr = err;
      const errMsg = (err instanceof Error ? err.message : String(err)).toUpperCase();
      const isRetriable =
        errMsg.includes('429') ||
        errMsg.includes('RESOURCE_EXHAUSTED') ||
        errMsg.includes('503') ||
        errMsg.includes('UNAVAILABLE') ||
        errMsg.includes('HIGH DEMAND') ||
        errMsg.includes('500') ||
        errMsg.includes('TIMEOUT') ||
        errMsg.includes('ABORT') ||
        (attempt.useSearch && errMsg.includes('INVALID_ARGUMENT'));
      if (!isRetriable) {
        throw new Error(formatGeminiErrorMessage(err));
      }
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  if (!response) {
    throw new Error(formatGeminiErrorMessage(lastErr));
  }

  const rawText = (response.text ?? '').trim();
  if (!rawText) {
    throw new Error('Model AI tidak mengembalikan hasil analisis. Silakan coba lagi.');
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(rawText);
  } catch {
    throw new Error('Format respons analisis AI tidak valid. Silakan ulangi proses.');
  }

  const zodResult = AnalyzerResponseZodSchema.safeParse(parsedRaw);
  if (!zodResult.success) {
    throw new Error('Struktur JSON hasil analisis AI tidak lengkap. Silakan ulangi proses.');
  }
  const parsed = zodResult.data;

  const chapters: EpisodeChapter[] = (parsed.chapters ?? [])
    .filter((ch) => Number.isFinite(ch.timeSec) && ch.title.trim().length > 0)
    .map((ch) => ({
      timeSec: Math.max(0, Math.min(ctx.durationSec, Math.round(ch.timeSec))),
      title: ch.title.trim().slice(0, 100),
    }))
    .sort((a, b) => a.timeSec - b.timeSec)
    .slice(0, 8);

  const keyQuotes = (parsed.keyQuotes ?? [])
    .map((q) => q.trim())
    .filter(Boolean)
    .slice(0, 6);

  const episode: PodcastEpisode = {
    id: options.episodeId,
    videoId: ctx.videoId,
    sourceUrl: options.sourceUrl,
    title: ctx.title,
    channelName: ctx.channelName,
    thumbnailUrl: ctx.thumbnailUrl,
    fallbackImageUrl: resolveAssetUrl('/src/assets/images/podcast_creator_desk_1794847027324.jpg'),
    durationSec: ctx.durationSec,
    transcriptSource: ctx.transcriptSource,
    episodeSummary: parsed.episodeSummary,
    keyTopics: (parsed.keyTopics ?? []).slice(0, 4),
    chapters,
    keyQuotes,
    createdAt: new Date().toISOString(),
  };

  const ensureTags = (tags: string[], extra?: string) => {
    const clean = (tags ?? [])
      .map((t) => (t.startsWith('#') ? t : `#${t.replace(/\s+/g, '')}`))
      .filter(Boolean);
    if (extra && !clean.some((t) => t.toLowerCase() === extra.toLowerCase())) {
      clean.unshift(extra);
    }
    return clean.slice(0, 6);
  };

  const normalizedRawClips = parsed.clips.map((c, idx) => {
    const rawStart = Number.isFinite(Number(c.startSec)) ? Number(c.startSec) : idx * 120;
    const rawEnd = Number.isFinite(Number(c.endSec)) ? Number(c.endSec) : rawStart + targetMinSec;
    const clamped = clampClipRange(
      rawStart,
      rawEnd,
      ctx.durationSec,
      targetMinSec,
      targetMaxSec
    );
    const qualityScores = computeWeightedContentQualityScore(
      { ...c.qualityScores, momentType: c.momentType },
      Number(c.viralScore) || 88 - idx * 3
    );
    return { c, clamped, qualityScores };
  });

  const dedupedClips = deduplicateOverlappingClips(
    normalizedRawClips.map((item) => ({
      ...item,
      startSec: item.clamped.startSec,
      endSec: item.clamped.endSec,
      viralScore: item.qualityScores.overallScore,
    }))
  ).slice(0, options.targetClipCount);

  const clips: PodcastClip[] = dedupedClips.map(({ c, clamped, qualityScores }, idx) => {
    const normalizePlatform = (
      title: string,
      caption: string,
      hashtags: string[],
      extraTag?: string
    ) => ({
      title: title || c.title,
      caption: caption || c.ringkasanTeks,
      hashtags: ensureTags(hashtags, extraTag),
    });

    const ytTitle =
      options.autoAddHashtagShorts && !/#shorts/i.test(c.youtubeTitle)
        ? `${c.youtubeTitle || c.title} #Shorts`
        : c.youtubeTitle || c.title;
    const ytTags = ensureTags(
      c.youtubeHashtags,
      options.autoAddHashtagShorts ? '#Shorts' : undefined
    );

    return {
      id: `${options.episodeId}-clip-${idx + 1}`,
      episodeId: options.episodeId,
      orderIndex: idx + 1,
      title: c.title,
      hookLine: c.hookLine,
      startSec: clamped.startSec,
      endSec: clamped.endSec,
      viralScore: qualityScores.overallScore,
      qualityScores,
      viralReason:
        c.viralReason?.trim() ||
        'Memiliki hook pembuka tajam di 3 detik pertama dengan penjelasan yang utuh.',
      autoGeneratedTitle: c.youtubeTitle?.replace(/\s*#shorts\s*/gi, '').trim() || c.title,
      autoGeneratedCaption: `${c.youtubeCaption} ${ytTags.join(' ')}`.trim(),
      ringkasanTeks: c.ringkasanTeks,
      poinKunci: (c.poinKunci ?? []).slice(0, 4),
      transcriptExcerpt: c.transcriptExcerpt,
      captionCues:
        Array.isArray(c.captionCues) && c.captionCues.length > 0
          ? c.captionCues.map((cue, cueIdx) => ({
              offsetSec: Math.max(0, Number(cue.offsetSec) ?? cueIdx * 4),
              durationSec: Math.max(1.5, Number(cue.durationSec) || 4),
              text: cue.text,
            }))
          : [
              {
                offsetSec: 0,
                durationSec: Math.min(5, clamped.durationSec),
                text: c.hookLine || c.title,
              },
            ],
      priorityLabel: c.priorityLabel === 'Klip Pendukung' ? 'Klip Pendukung' : 'Sorotan Utama',
      contentStyle: approach,
      suggestedPlatform: APPROACH_PLATFORM_HINT[approach],
      scoringModelVersion: 'aicliper-q7-v2.0',
      status: 'draft',
      publishedPlatforms: [],
      platformCopies: {
        youtube_shorts: normalizePlatform(
          ytTitle,
          c.youtubeCaption,
          c.youtubeHashtags,
          options.autoAddHashtagShorts ? '#Shorts' : undefined
        ),
        tiktok: normalizePlatform(c.tiktokTitle, c.tiktokCaption, c.tiktokHashtags),
        instagram_reels: normalizePlatform(
          c.instagramTitle,
          c.instagramCaption,
          c.instagramHashtags
        ),
        facebook_reels: normalizePlatform(
          c.facebookTitle || c.instagramTitle || c.title,
          c.facebookCaption || c.instagramCaption || c.ringkasanTeks,
          c.facebookHashtags?.length ? c.facebookHashtags : ['#FacebookReels', ...c.instagramHashtags]
        ),
        x_twitter: normalizePlatform(c.xTitle, c.xCaption, c.xHashtags),
        linkedin: normalizePlatform(c.linkedinTitle, c.linkedinCaption, c.linkedinHashtags),
      } satisfies Record<SocialPlatform, { title: string; caption: string; hashtags: string[] }>,
    };
  });

  // Save in-memory cache for repeated requests on same video
  analysisCache.set(cacheKey, {
    episode: structuredClone(episode),
    clips: structuredClone(clips),
    expiresAtMs: Date.now() + ANALYSIS_CACHE_TTL_MS,
  });
  if (analysisCache.size > 100) {
    const firstKey = analysisCache.keys().next().value;
    if (firstKey) analysisCache.delete(firstKey);
  }

  const usageMeta = (response as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }).usageMetadata;

  return {
    episode,
    clips,
    usage: {
      model: usedModel,
      promptTokens: Number(usageMeta?.promptTokenCount ?? 0),
      outputTokens: Number(usageMeta?.candidatesTokenCount ?? 0),
      cached: false,
    },
  };
}
