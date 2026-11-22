import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import { z } from 'zod';
import type {
  CaptionCue,
  HookGeneratorVariant,
  HookStyleTone,
  PlatformCopy,
  PodcastClip,
  PodcastEpisode,
  RepurposedContentBundle,
  SocialPlatform,
} from '../src/types/clipper.ts';
import { formatGeminiErrorMessage } from '../src/utils/youtube.ts';

export interface AiStudioUsage {
  model: string;
  promptTokens: number;
  outputTokens: number;
}

function getGenAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY belum tersedia di environment server.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function generateStructuredJsonWithFallback<T>(params: {
  prompt: string;
  responseSchema: Record<string, unknown>;
  zodSchema: z.ZodType<T>;
}): Promise<{ data: T; usage: AiStudioUsage }> {
  const ai = getGenAiClient();
  const attempts = [
    { model: 'gemini-4-hydrogen', thinking: true },
    { model: 'gemini-3.1-flash-lite', thinking: false },
  ];

  let lastErr: unknown = null;
  for (const attempt of attempts) {
    try {
      const response = await ai.models.generateContent({
        model: attempt.model,
        contents: params.prompt,
        config: {
          ...(attempt.thinking ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
          responseMimeType: 'application/json',
          responseSchema: params.responseSchema,
          abortSignal: AbortSignal.timeout(25_000),
        },
      });
      const text = (response.text ?? '').trim();
      if (!text) throw new Error('Model AI mengembalikan respons kosong.');
      const parsed = JSON.parse(text);
      const validated = params.zodSchema.safeParse(parsed);
      if (!validated.success) {
        throw new Error('Format output AI tidak sesuai skema.');
      }
      const usageMeta = (
        response as {
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
        }
      ).usageMetadata;
      return {
        data: validated.data,
        usage: {
          model: attempt.model,
          promptTokens: Number(usageMeta?.promptTokenCount ?? 0),
          outputTokens: Number(usageMeta?.candidatesTokenCount ?? 0),
        },
      };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(formatGeminiErrorMessage(lastErr));
}

const ALL_HOOK_TONES: readonly HookStyleTone[] = [
  'profesional',
  'edukatif',
  'storytelling',
  'emosional',
  'santai',
  'provokatif_etis',
];

const HookVariantsZodSchema = z.object({
  variants: z
    .array(
      z.object({
        tone: z.enum([
          'profesional',
          'edukatif',
          'storytelling',
          'emosional',
          'santai',
          'provokatif_etis',
        ]),
        openingHook: z.string().min(4),
        videoTitle: z.string().min(4),
        caption: z.string().min(8),
        cta: z.string().min(3),
        hashtags: z.array(z.string()).default([]),
        thumbnailText: z.string().min(2),
      })
    )
    .min(1),
});

export async function generateViralHooksForClip(params: {
  clip: PodcastClip;
  episode: PodcastEpisode;
  tones?: HookStyleTone[];
}): Promise<{ variants: HookGeneratorVariant[]; usage: AiStudioUsage }> {
  const requestedTones =
    Array.isArray(params.tones) && params.tones.length > 0
      ? params.tones.filter((t) => ALL_HOOK_TONES.includes(t))
      : [...ALL_HOOK_TONES];

  const prompt = `Kamu adalah AI Viral Hook & Copywriting Strategist untuk kreator podcast Indonesia.
Buatkan variasi hook, judul video, caption, CTA, hashtag, dan teks thumbnail singkat (2–5 kata punchy) untuk klip berikut dalam gaya: ${requestedTones.join(', ')}.

Konteks Episode:
- Judul Episode: ${params.episode.title}
- Channel: ${params.episode.channelName}

Konteks Klip:
- Judul Klip: ${params.clip.title}
- Ringkasan: ${params.clip.ringkasanTeks}
- Kutipan Transkrip: ${params.clip.transcriptExcerpt}
- Poin Kunci: ${params.clip.poinKunci.join('; ')}

Aturan:
- Seluruh output WAJIB berbasis isi klip di atas (jangan mengarang fakta).
- Gaya "provokatif_etis" harus memancing diskusi kritis yang sehat, tanpa hoaks, ujaran kebencian, atau clickbait menipu.
- Kembalikan 1 objek per tone di array \`variants\`.`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      variants: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            tone: { type: Type.STRING },
            openingHook: { type: Type.STRING },
            videoTitle: { type: Type.STRING },
            caption: { type: Type.STRING },
            cta: { type: Type.STRING },
            hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
            thumbnailText: { type: Type.STRING },
          },
          required: [
            'tone',
            'openingHook',
            'videoTitle',
            'caption',
            'cta',
            'hashtags',
            'thumbnailText',
          ],
        },
      },
    },
    required: ['variants'],
  };

  const { data, usage } = await generateStructuredJsonWithFallback({
    prompt,
    responseSchema,
    zodSchema: HookVariantsZodSchema,
  });

  const normalized: HookGeneratorVariant[] = data.variants.map((v) => ({
    ...v,
    hashtags: v.hashtags
      .map((h) => (h.startsWith('#') ? h : `#${h.replace(/\s+/g, '')}`))
      .slice(0, 6),
  }));

  return { variants: normalized, usage };
}

const RepurposeZodSchema = z.object({
  teaserScript: z.string().min(10),
  quoteCardText: z.string().min(6),
  quoteCardAuthor: z.string().min(2),
  articleSummary: z.string().min(20),
  facebookReelsCaption: z.string().min(8),
  platformCopies: z
    .object({
      youtube_shorts: z.object({
        title: z.string(),
        caption: z.string(),
        hashtags: z.array(z.string()),
      }),
      tiktok: z.object({
        title: z.string(),
        caption: z.string(),
        hashtags: z.array(z.string()),
      }),
      instagram_reels: z.object({
        title: z.string(),
        caption: z.string(),
        hashtags: z.array(z.string()),
      }),
      facebook_reels: z.object({
        title: z.string(),
        caption: z.string(),
        hashtags: z.array(z.string()),
      }),
      x_twitter: z.object({
        title: z.string(),
        caption: z.string(),
        hashtags: z.array(z.string()),
      }),
      linkedin: z.object({
        title: z.string(),
        caption: z.string(),
        hashtags: z.array(z.string()),
      }),
    })
    .optional(),
});

export async function generateRepurposedContentForClip(params: {
  clip: PodcastClip;
  episode: PodcastEpisode;
}): Promise<{
  bundle: RepurposedContentBundle;
  platformCopies?: Record<SocialPlatform, PlatformCopy>;
  usage: AiStudioUsage;
}> {
  const prompt = `Kamu adalah AI Content Repurposing Editor untuk podcaster dan brand media Indonesia.
Ubah 1 klip podcast berikut menjadi paket konten multi-platform yang siap pakai dan 100% setia pada isi transkrip:

Episode: ${params.episode.title} (${params.episode.channelName})
Judul Klip: ${params.clip.title}
Ringkasan Klip: ${params.clip.ringkasanTeks}
Transkrip Klip: ${params.clip.transcriptExcerpt}
Poin Kunci: ${params.clip.poinKunci.join(' | ')}

Hasilkan:
1. teaserScript: Naskah teaser video pendek 15 detik (Hook -> Masalah -> Poin Inti -> CTA).
2. quoteCardText & quoteCardAuthor: 1 kutipan tajam siap desain kartu kutipan.
3. articleSummary: Ringkasan artikel blog/newsletter 2–3 paragraf rapi.
4. facebookReelsCaption: Caption ramah diskusi untuk Facebook Reels.
5. platformCopies: Judul, caption, dan 4–5 hashtag spesifik untuk youtube_shorts, tiktok, instagram_reels, facebook_reels, x_twitter, dan linkedin.`;

  const copySchema = {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING },
      caption: { type: Type.STRING },
      hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
    },
    required: ['title', 'caption', 'hashtags'],
  };

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      teaserScript: { type: Type.STRING },
      quoteCardText: { type: Type.STRING },
      quoteCardAuthor: { type: Type.STRING },
      articleSummary: { type: Type.STRING },
      facebookReelsCaption: { type: Type.STRING },
      platformCopies: {
        type: Type.OBJECT,
        properties: {
          youtube_shorts: copySchema,
          tiktok: copySchema,
          instagram_reels: copySchema,
          facebook_reels: copySchema,
          x_twitter: copySchema,
          linkedin: copySchema,
        },
        required: [
          'youtube_shorts',
          'tiktok',
          'instagram_reels',
          'facebook_reels',
          'x_twitter',
          'linkedin',
        ],
      },
    },
    required: [
      'teaserScript',
      'quoteCardText',
      'quoteCardAuthor',
      'articleSummary',
      'facebookReelsCaption',
      'platformCopies',
    ],
  };

  const { data, usage } = await generateStructuredJsonWithFallback({
    prompt,
    responseSchema,
    zodSchema: RepurposeZodSchema,
  });

  return {
    bundle: {
      teaserScript: data.teaserScript,
      quoteCardText: data.quoteCardText,
      quoteCardAuthor: data.quoteCardAuthor,
      articleSummary: data.articleSummary,
      facebookReelsCaption: data.facebookReelsCaption,
      generatedAt: new Date().toISOString(),
    },
    platformCopies: data.platformCopies,
    usage,
  };
}

const SubtitlePolishZodSchema = z.object({
  cues: z.array(
    z.object({
      offsetSec: z.number(),
      durationSec: z.number(),
      text: z.string(),
      speaker: z.string().optional(),
    })
  ),
});

export async function polishSubtitlesMeaningSafe(
  cues: CaptionCue[]
): Promise<{ cues: CaptionCue[]; usage: AiStudioUsage }> {
  if (!Array.isArray(cues) || cues.length === 0) {
    return {
      cues: [],
      usage: { model: 'none', promptTokens: 0, outputTokens: 0 },
    };
  }

  const prompt = `Kamu adalah Editor Subtitle Bahasa Indonesia & Inggris profesional.
Perbaiki HANYA tanda baca, kapitalisasi, dan typo ringan pada daftar cue subtitle berikut.
ATURAN KETAT:
- DILARANG mengubah makna ucapan pembicara atau menambah informasi baru.
- Pertahankan jumlah cue, \`offsetSec\`, dan \`durationSec\` persis sama dengan input.

Input JSON cues:
${JSON.stringify(cues.slice(0, 80))}`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      cues: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            offsetSec: { type: Type.NUMBER },
            durationSec: { type: Type.NUMBER },
            text: { type: Type.STRING },
            speaker: { type: Type.STRING },
          },
          required: ['offsetSec', 'durationSec', 'text'],
        },
      },
    },
    required: ['cues'],
  };

  const { data, usage } = await generateStructuredJsonWithFallback({
    prompt,
    responseSchema,
    zodSchema: SubtitlePolishZodSchema,
  });

  // Preserve original timing strictly even if model drifted slightly
  const safeCues: CaptionCue[] = cues.map((orig, idx) => ({
    offsetSec: orig.offsetSec,
    durationSec: orig.durationSec,
    speaker: data.cues[idx]?.speaker || orig.speaker,
    text: data.cues[idx]?.text?.trim() || orig.text,
  }));

  return { cues: safeCues, usage };
}

export async function askGroundedEpisodeAssistant(params: {
  episode: PodcastEpisode;
  clips: PodcastClip[];
  question: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}): Promise<{ answer: string; usage: AiStudioUsage }> {
  const ai = getGenAiClient();

  const clipsSummary = params.clips
    .slice(0, 10)
    .map(
      (c, i) =>
        `Klip ${i + 1} (${c.startSec}s–${c.endSec}s): "${c.title}"\nRingkasan: ${c.ringkasanTeks}\nTranskrip: ${c.transcriptExcerpt}\nPoin: ${c.poinKunci.join('; ')}`
    )
    .join('\n\n');

  const historyText = (params.history ?? [])
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'Pengguna' : 'Asisten'}: ${m.content}`)
    .join('\n');

  const prompt = `Kamu adalah Asisten Strategi Konten AI untuk episode podcast di bawah ini.
ATURAN KEJUJURAN KETAT:
- Jawab HANYA berdasarkan data episode dan klip yang diberikan di bawah.
- Jika pertanyaan meminta data, angka, atau fakta yang TIDAK ada di data episode/klip, nyatakan dengan jujur bahwa informasi tersebut tidak tersedia di data episode ini dan sarankan cara mengeceknya.
- Jawab dalam Bahasa Indonesia yang terstruktur, singkat, dan langsung bisa dipraktikkan kreator.

DATA EPISODE:
- Judul: ${params.episode.title}
- Channel: ${params.episode.channelName}
- Ringkasan: ${params.episode.episodeSummary}
- Topik Utama: ${params.episode.keyTopics.join(', ')}
- Kutipan Kunci: ${(params.episode.keyQuotes ?? []).join(' | ') || '(belum diekstrak)'}

DATA KLIP:
${clipsSummary || '(belum ada klip)'}

${historyText ? `RIWAYAT PERCAKAPAN:\n${historyText}\n` : ''}
PERTANYAAN PENGGUNA:
${params.question.trim()}`;

  const attempts = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
  let lastErr: unknown = null;

  for (const model of attempts) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          ...(model.startsWith('gemini-4')
            ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
            : {}),
          abortSignal: AbortSignal.timeout(25_000),
        },
      });
      const answer = (response.text ?? '').trim();
      if (!answer) throw new Error('Asisten AI tidak mengembalikan jawaban.');
      const usageMeta = (
        response as {
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
        }
      ).usageMetadata;
      return {
        answer,
        usage: {
          model,
          promptTokens: Number(usageMeta?.promptTokenCount ?? 0),
          outputTokens: Number(usageMeta?.candidatesTokenCount ?? 0),
        },
      };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  throw new Error(formatGeminiErrorMessage(lastErr));
}

const CustomContentResultZodSchema = z.object({
  title: z.string().min(3),
  hook: z.string().min(3),
  script: z.string().min(10),
  caption: z.string().min(6),
  description: z.string().min(6),
  cta: z.string().min(3),
  hashtags: z.array(z.string()).default([]),
});

export async function generateCustomContentStudioAsset(params: {
  episode?: PodcastEpisode | null;
  clip?: PodcastClip | null;
  options: import('../src/types/clipper.ts').ContentStudioCustomParams;
}): Promise<{
  output: import('../src/types/clipper.ts').ContentGenerationResult;
  usage: AiStudioUsage;
}> {
  const { options, episode, clip } = params;
  const languageDirective =
    options.language === 'en'
      ? 'Write ALL outputs in natural, fluent English.'
      : options.language === 'bilingual'
        ? 'Write primarily in Indonesian with crisp, natural English creator terms where appropriate.'
        : 'Tulis SELURUH output dalam Bahasa Indonesia yang alami dan siap pakai.';

  const lengthDirective =
    options.textLength === 'short'
      ? 'Ringkas, padat, maksimal 45–80 kata untuk naskah dan 2 kalimat untuk caption.'
      : options.textLength === 'long'
        ? 'Mendalam dan terstruktur, 150–260 kata untuk naskah lengkap dengan pembuka, isi, dan penutup.'
        : 'Seimbang dan mudah dibaca, 90–140 kata untuk naskah.';

  const contextBlock = [
    episode ? `Judul Episode: ${episode.title} (Channel: ${episode.channelName})` : '',
    episode ? `Ringkasan Episode: ${episode.episodeSummary}` : '',
    clip ? `Judul Klip: ${clip.title}` : '',
    clip ? `Hook Klip: ${clip.hookLine}` : '',
    clip ? `Ringkasan Klip: ${clip.ringkasanTeks}` : '',
    clip ? `Kutipan Transkrip: ${clip.transcriptExcerpt}` : '',
    clip && clip.poinKunci.length > 0 ? `Poin Kunci: ${clip.poinKunci.join(' | ')}` : '',
    options.topicFocus ? `Fokus Tambahan Kreator: ${options.topicFocus}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const prompt = `Kamu adalah AI Content Studio Strategist & Copywriter senior.
Hasilkan paket materi konten kustom untuk kreator berdasarkan konteks nyata berikut (DILARANG mengarang fakta di luar konteks):

${contextBlock || 'Konteks: Konten kreator video pendek & podcast.'}

PARAMETER KUSTOMISASI WAJIB:
- Jenis Fokus Output: ${options.kind}
- Bahasa: ${languageDirective}
- Platform Target: ${options.platform}
- Tone / Nada: ${options.tone}
- Target Audiens: ${options.audience}
- Tujuan Konten: ${options.objective}
- Panjang Teks: ${lengthDirective}
- Gaya Penulisan: ${options.writingStyle}

Kembalikan JSON dengan field: title, hook, script, caption, description, cta, hashtags (4–6 tagar relevan).`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING },
      hook: { type: Type.STRING },
      script: { type: Type.STRING },
      caption: { type: Type.STRING },
      description: { type: Type.STRING },
      cta: { type: Type.STRING },
      hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
    },
    required: ['title', 'hook', 'script', 'caption', 'description', 'cta', 'hashtags'],
  };

  const { data, usage } = await generateStructuredJsonWithFallback({
    prompt,
    responseSchema,
    zodSchema: CustomContentResultZodSchema,
  });

  return {
    output: {
      ...data,
      hashtags: data.hashtags
        .map((h) => (h.startsWith('#') ? h : `#${h.replace(/\s+/g, '')}`))
        .slice(0, 8),
    },
    usage,
  };
}

const GrowthRecommendationsZodSchema = z.object({
  recommendations: z
    .array(
      z.object({
        title: z.string().min(4),
        rationale: z.string().min(8),
        actionStep: z.string().min(6),
        priority: z.enum(['high', 'medium', 'low']),
        basedOnMetric: z.string().min(3),
      })
    )
    .min(1)
    .max(5),
});

export async function generateGroundedGrowthRecommendations(
  overview: import('../src/types/clipper.ts').AnalyticsOverviewData
): Promise<{
  recommendations: import('../src/types/clipper.ts').GrowthRecommendation[];
  usage: AiStudioUsage;
}> {
  const prompt = `Kamu adalah AI Content Growth Advisor yang SANGAT JUJUR dan berbasis data nyata.
Analisis ringkasan metrik REAL akun kreator di bawah ini dan berikan 3–4 rekomendasi pertumbuhan konten yang konkret dalam Bahasa Indonesia.

ATURAN KETAT:
- DILARANG mengarang angka views, CTR, atau retention yang tidak ada pada data di bawah.
- Jika youtubeViews bernilai null, sebutkan secara eksplisit bahwa data YouTube belum disinkronkan dan dasarkan rekomendasi pada metrik internal yang tersedia (jumlah klip, rasio render/publish, skor kualitas konten, distribusi pendekatan).
- Setiap rekomendasi wajib mencantumkan \`basedOnMetric\` yang merujuk langsung ke angka pada JSON di bawah.

DATA METRIK REAL PENGGUNA:
${JSON.stringify({
    sourceSummary: overview.sourceSummary,
    totals: overview.totals,
    byApproach: overview.byApproach,
    byPlatform: overview.byPlatform,
  })}`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      recommendations: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            rationale: { type: Type.STRING },
            actionStep: { type: Type.STRING },
            priority: { type: Type.STRING },
            basedOnMetric: { type: Type.STRING },
          },
          required: ['title', 'rationale', 'actionStep', 'priority', 'basedOnMetric'],
        },
      },
    },
    required: ['recommendations'],
  };

  const { data, usage } = await generateStructuredJsonWithFallback({
    prompt,
    responseSchema,
    zodSchema: GrowthRecommendationsZodSchema,
  });

  return { recommendations: data.recommendations, usage };
}

