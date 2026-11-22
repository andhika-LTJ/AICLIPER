import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import type { PodcastClip, PodcastEpisode, SocialPlatform } from '../src/types/clipper.ts';
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

  // Prefer crisp maxresdefault thumbnail if available, alongside fast oEmbed metadata
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

  // 2. If user provided a manual transcript, parse or preserve it directly
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
    // 3. Try extracting lengthSeconds, shortDescription, and captionTracks from YouTube watch page
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
}

export async function analyzePodcastWithGemini(
  options: AnalyzeOptions
): Promise<{ episode: PodcastEpisode; clips: PodcastClip[] }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY belum tersedia di environment server.');
  }

  const ctx = await fetchYouTubeContext(options.videoId, options.manualTranscript);

  // Format transcript chunk with timestamps (cap to ~18,000 chars for fast Gemini processing)
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

  const normalizedBounds = normalizeAutomationDurationBounds(
    options.minDurationSec,
    options.maxDurationSec
  );
  const targetMinSec = Math.min(normalizedBounds.minClipSec, Math.max(15, ctx.durationSec));
  const targetMaxSec = Math.min(
    SHORTS_MAX_CLIP_SEC,
    Math.max(targetMinSec, normalizedBounds.maxClipSec, Math.min(ctx.durationSec, targetMinSec + 15))
  );

  const prompt = `Kamu adalah AI Viral Video Strategist & Produser Podcast Shorts kelas atas.
Analisis link video podcast YouTube berikut untuk menemukan ${options.targetClipCount} momen PALING BERPOTENSI VIRAL dengan durasi UTUH ${targetMinSec}–${targetMaxSec} detik per klip.

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
    : `Transkrip langsung belum tersedia. WAJIB gunakan pencarian web untuk menelusuri topik episode "${ctx.title}" (${ctx.channelName}), pembicara/bintang tamu, kutipan viral, pembahasan hangat netizen, atau chapter video ini, lalu petakan momen paling berpotensi viral beserta rentang timestamp yang paling logis di dalam 0 sampai ${ctx.durationSec} detik.`
}

Kriteria Pemilihan Momen Viral & Output WAJIB:
1. **ALUR CERITA UTUH & DETAIL (ANTI-TERPOTONG 15 DETIK)**: Setiap klip WAJIB berdurasi ${targetMinSec}–${targetMaxSec} detik (JANGAN pernah memilih potongan pendek 10–25 detik yang menggantung!). Setiap rentang \`startSec\` sampai \`endSec\` HARUS memuat 3 bagian lengkap:
   - (a) **Hook Pembuka (0–5 detik)** yang langsung memancing rasa penasaran,
   - (b) **Isi / Penjelasan / Cerita Detail** yang benar-benar menjawab dan mengupas tuntas topik judul Short,
   - (c) **Klimaks / Punchline / Kesimpulan Tuntas** hingga akhir kalimat (tidak terpotong di tengah argumen).
2. **KESESUAIAN JUDUL 100%**: Judul Short (\`title\`, \`youtubeTitle\`, \`tiktokTitle\`, \`instagramTitle\`) WAJIB sesuai dengan penjelasan detail yang benar-benar dibahas di rentang \`startSec..endSec\` (singkat, high-CTR, natural Bahasa Indonesia, tanpa clickbait kosong).${options.autoAddHashtagShorts ? ' Sertakan #Shorts pada \`youtubeTitle\`.' : ''}
3. Beri nilai \`viralScore\` (angka bulat 70–99) dan \`viralReason\` (1 kalimat tegas mengapa potongan ini berpotensi viral/FYP). Urutkan dari \`viralScore\` tertinggi ke terendah.
4. Buat **Caption & Deskripsi Otomatis** (\`youtubeCaption\`, \`tiktokCaption\`, \`instagramCaption\`, \`xCaption\`, \`linkedinCaption\`) yang lengkap, relevan 100% dengan isi klip, ada kalimat pembuka pancing diskusi, dan 4–6 hashtag tertarget.
5. Pastikan \`startSec\` dan \`endSec\` berada di rentang 0..${ctx.durationSec} dengan selisih \`endSec - startSec\` WAJIB minimal ${targetMinSec} detik dan maksimal ${targetMaxSec} detik, serta sertakan 6–10 \`captionCues\` yang tersebar merata dari awal sampai akhir klip.`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      episodeSummary: {
        type: Type.STRING,
        description: 'Ringkasan komprehensif isi podcast dalam 2-3 kalimat Bahasa Indonesia.',
      },
      keyTopics: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: '3 topik utama yang dibahas dalam episode podcast.',
      },
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
            priorityLabel: {
              type: Type.STRING,
              description: 'Harus bernilai "Sorotan Utama" atau "Klip Pendukung".',
            },
            ringkasanTeks: {
              type: Type.STRING,
              description: 'Ringkasan padat makna dari potongan klip ini dalam 2 kalimat.',
            },
            poinKunci: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
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
  let lastErr: unknown = null;

  for (const attempt of attempts) {
    try {
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
          abortSignal: AbortSignal.timeout(attempt.useSearch ? 22_000 : 35_000),
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

  let parsed: {
    episodeSummary: string;
    keyTopics: string[];
    clips: Array<{
      title: string;
      hookLine: string;
      startSec: number;
      endSec: number;
      viralScore?: number;
      viralReason?: string;
      priorityLabel?: string;
      ringkasanTeks: string;
      poinKunci: string[];
      transcriptExcerpt: string;
      captionCues: Array<{ offsetSec: number; durationSec: number; text: string }>;
      youtubeTitle: string;
      youtubeCaption: string;
      youtubeHashtags: string[];
      tiktokTitle: string;
      tiktokCaption: string;
      tiktokHashtags: string[];
      instagramTitle: string;
      instagramCaption: string;
      instagramHashtags: string[];
      xTitle: string;
      xCaption: string;
      xHashtags: string[];
      linkedinTitle: string;
      linkedinCaption: string;
      linkedinHashtags: string[];
    }>;
  };

  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('Format respons analisis AI tidak valid. Silakan ulangi proses.');
  }

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

  const sortedRawClips = [...(parsed.clips ?? [])]
    .sort((a, b) => (Number(b.viralScore) || 0) - (Number(a.viralScore) || 0))
    .slice(0, options.targetClipCount);

  const clips: PodcastClip[] = sortedRawClips.map((c, idx) => {
    const rawStart = Number.isFinite(Number(c.startSec)) ? Number(c.startSec) : idx * 120;
    const rawEnd = Number.isFinite(Number(c.endSec)) ? Number(c.endSec) : rawStart + targetMinSec;
    const clamped = clampClipRange(
      rawStart,
      rawEnd,
      ctx.durationSec,
      targetMinSec,
      targetMaxSec
    );

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
        ? `${c.youtubeTitle} #Shorts`
        : c.youtubeTitle;
    const viralScore = Math.max(65, Math.min(99, Math.round(Number(c.viralScore) || (92 - idx * 4))));
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
      viralScore,
      viralReason:
        c.viralReason?.trim() ||
        'Memiliki hook pembuka tajam di 3 detik pertama dengan potensi diskusi tinggi.',
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
        instagram_reels: normalizePlatform(c.instagramTitle, c.instagramCaption, c.instagramHashtags),
        x_twitter: normalizePlatform(c.xTitle, c.xCaption, c.xHashtags),
        linkedin: normalizePlatform(c.linkedinTitle, c.linkedinCaption, c.linkedinHashtags),
      } satisfies Record<SocialPlatform, { title: string; caption: string; hashtags: string[] }>,
    };
  });

  return { episode, clips };
}
