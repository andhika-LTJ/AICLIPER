import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import type {
  CaptionCue,
  EmotionMoment,
  PodcastClip,
  PodcastEpisode,
} from '../src/types/clipper.ts';
import {
  mergeAnchoredWindowCues,
  planAudioTranscriptionWindows,
  type AudioTranscriptionWindow,
} from './audioSyncMath.ts';
import { normalizeEmotionMoments } from './emotionEffects.ts';
import { getFfmpegPath } from './ffmpegBinaries.ts';
import {
  normalizeSpeakerKeyframes,
  normalizeTranscribedCues,
  type SpeakerKeyframe,
} from './speakerFocusMath.ts';

const execFileAsync = promisify(execFile);

const INTELLIGENCE_CACHE_VERSION = 4;

export interface ClipIntelligenceResult {
  version?: number;
  cues: CaptionCue[];
  verbatimTranscript: string;
  autoTitle: string;
  autoCaption: string;
  hashtags: string[];
  subtitleSource: 'audio_transcribed' | 'existing_fallback';
  keyframes: SpeakerKeyframe[];
  speakerFocusSummary: string;
  emotionMoments: EmotionMoment[];
  emotionSummary: string;
}

export interface PlannedSamplePoint {
  timeSec: number;
  isSceneCut: boolean;
}

function getAiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function combineAbortSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([t, signal]) : t;
}

/**
 * Pure helper: combines FFmpeg-detected camera cuts with dense uniform sampling (up to `maxFrames`)
 * so active-speaker tracking captures every hard camera switch plus within-shot speaker turns.
 */
export function planSmartSampleTimestamps(
  sceneCuts: number[],
  durationSec: number,
  maxFrames = 16
): PlannedSamplePoint[] {
  const safeDur = Math.max(2, durationSec);
  const points: PlannedSamplePoint[] = [{ timeSec: 0.15, isSceneCut: false }];

  // Keep scene cuts spaced >= 1.1s apart and away from clip edges
  const filteredCuts = [...sceneCuts]
    .filter((t) => Number.isFinite(t) && t >= 0.7 && t <= safeDur - 0.5)
    .sort((a, b) => a - b);

  for (const cutT of filteredCuts) {
    const sampleT = Number(Math.min(safeDur - 0.2, cutT + 0.15).toFixed(2));
    const prev = points[points.length - 1];
    if (sampleT - prev.timeSec >= 1.05) {
      points.push({ timeSec: sampleT, isSceneCut: true });
    }
    if (points.length >= maxFrames - 2) break;
  }

  // Fill long continuous shots (> 3.4s gap) with intermediate frames so multi-speaker wide shots track smoothly
  const maxGap = Math.max(2.6, safeDur / Math.max(6, maxFrames - 2));
  let guard = 0;
  while (points.length < maxFrames && guard < 30) {
    guard++;
    points.sort((a, b) => a.timeSec - b.timeSec);
    let largestGap = 0;
    let insertAt = -1;

    for (let i = 0; i < points.length; i++) {
      const start = points[i].timeSec;
      const end = i + 1 < points.length ? points[i + 1].timeSec : safeDur - 0.25;
      const gap = end - start;
      if (gap > largestGap) {
        largestGap = gap;
        insertAt = Number(((start + end) / 2).toFixed(2));
      }
    }

    if (largestGap < maxGap || insertAt <= 0.2 || insertAt >= safeDur - 0.2) {
      break;
    }
    points.push({ timeSec: insertAt, isSceneCut: false });
  }

  return points
    .sort((a, b) => a.timeSec - b.timeSec)
    .slice(0, maxFrames);
}

/**
 * Runs a fast FFmpeg scene-change scan (`select='gt(scene,0.24)'`) to pinpoint exact podcast camera switches.
 */
async function detectSceneCutTimestamps(rawVideoPath: string): Promise<number[]> {
  try {
    const { stderr } = await execFileAsync(
      getFfmpegPath(),
      [
        '-threads',
        '0',
        '-i',
        rawVideoPath,
        '-vf',
        "scale=320:-2,select='gt(scene,0.24)',showinfo",
        '-an',
        '-f',
        'null',
        '-',
      ],
      { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }
    );
    const cuts: number[] = [];
    const regex = /pts_time:(\d+(?:\.\d+)?)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(stderr)) !== null) {
      const val = Number(match[1]);
      if (Number.isFinite(val) && val > 0.4) {
        cuts.push(Number(val.toFixed(2)));
      }
    }
    return cuts;
  } catch {
    return [];
  }
}

interface AudioWindowPayload {
  window: AudioTranscriptionWindow;
  base64: string;
}

/**
 * Extracts compressed mono speech audio (zero-anchored via asetpts=PTS-STARTPTS), slices it into
 * 12-second anchored windows for drift-free parallel subtitle transcription, detects camera cuts,
 * and extracts up to 16 crisp 480px timestamp-exact frames.
 */
async function extractClipAudioAndSmartFrames(params: {
  rawVideoPath: string;
  durationSec: number;
  workDir: string;
  signal?: AbortSignal;
}): Promise<{
  audioBase64: string;
  audioWindows: AudioWindowPayload[];
  frames: Array<{ timeSec: number; isSceneCut: boolean; base64: string }>;
}> {
  const { rawVideoPath, durationSec, workDir, signal } = params;
  const audioPath = path.join(workDir, 'clip_audio.mp3');

  // Step 1: Run zero-anchored audio extraction & scene-cut detection concurrently (~1.0–1.5s total)
  const [, sceneCuts] = await Promise.all([
    execFileAsync(
      getFfmpegPath(),
      [
        '-y',
        '-threads',
        '0',
        '-i',
        rawVideoPath,
        '-vn',
        '-af',
        'asetpts=PTS-STARTPTS,aresample=16000:async=1:first_pts=0',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-b:a',
        '32k',
        audioPath,
      ],
      { timeout: 30_000, signal }
    ),
    detectSceneCutTimestamps(rawVideoPath),
  ]);

  const audioBase64 = fs.readFileSync(audioPath).toString('base64');
  const plannedWindows = planAudioTranscriptionWindows(durationSec, 15);
  const maxSampleFrames = durationSec <= 35 ? 10 : 12;
  const samplePoints = planSmartSampleTimestamps(sceneCuts, durationSec, maxSampleFrames);

  // Step 2: Slice 12s anchored audio windows + extract 480px video frames in parallel
  const audioWindowsPromise: Promise<AudioWindowPayload[]> =
    plannedWindows.length <= 1
      ? Promise.resolve([{ window: plannedWindows[0], base64: audioBase64 }])
      : Promise.all(
          plannedWindows.map(async (win) => {
            const winPath = path.join(workDir, `win_${String(win.index).padStart(2, '0')}.mp3`);
            await execFileAsync(
              getFfmpegPath(),
              [
                '-y',
                '-ss',
                String(win.startSec),
                '-t',
                String(win.durationSec),
                '-i',
                audioPath,
                '-ac',
                '1',
                '-ar',
                '16000',
                '-b:a',
                '32k',
                winPath,
              ],
              { timeout: 15_000 }
            );
            return {
              window: win,
              base64: fs.readFileSync(winPath).toString('base64'),
            };
          })
        ).catch(() => [{ window: { index: 0, startSec: 0, endSec: durationSec, durationSec }, base64: audioBase64 }]);

  const framesPromise = (async () => {
    const frames: Array<{ timeSec: number; isSceneCut: boolean; base64: string }> = [];
    const batchSize = 4;
    for (let start = 0; start < samplePoints.length; start += batchSize) {
      const batch = samplePoints.slice(start, start + batchSize);
      const extracted = await Promise.all(
        batch.map(async (pt, offset) => {
          const idx = start + offset;
          const outPath = path.join(workDir, `kf_${String(idx).padStart(2, '0')}.jpg`);
          try {
            await execFileAsync(
              getFfmpegPath(),
              [
                '-y',
                '-ss',
                String(pt.timeSec),
                '-i',
                rawVideoPath,
                '-frames:v',
                '1',
                '-vf',
                'scale=480:-2',
                '-q:v',
                '5',
                outPath,
              ],
              { timeout: 10_000 }
            );
            if (fs.existsSync(outPath)) {
              return {
                timeSec: pt.timeSec,
                isSceneCut: pt.isSceneCut,
                base64: fs.readFileSync(outPath).toString('base64'),
              };
            }
          } catch {
            // Skip unreadable timestamp
          }
          return null;
        })
      );
      for (const item of extracted) {
        if (item) frames.push(item);
      }
    }
    return frames;
  })();

  const [audioWindows, frames] = await Promise.all([audioWindowsPromise, framesPromise]);
  return { audioBase64, audioWindows, frames };
}

/**
 * Transcribes a single short (~12s) audio window with tight local timestamps [0.0..windowDurationSec].
 * Running short windows concurrently eliminates LLM cumulative timestamp drift across 40–60s clips.
 */
async function transcribeSingleAudioWindow(params: {
  ai: GoogleGenAI;
  payload: AudioWindowPayload;
  episode: PodcastEpisode;
  signal?: AbortSignal;
}): Promise<CaptionCue[]> {
  const { ai, payload, episode, signal } = params;
  const dur = payload.window.durationSec;

  const audioPart = {
    inlineData: {
      mimeType: 'audio/mp3',
      data: payload.base64,
    },
  };

  const prompt = `Kamu adalah ahli sinkronisasi subtitle podcast Indonesia dengan presisi sub-detik.
Audio potongan ini berdurasi TEPAT ${dur.toFixed(2)} detik (mulai 0.00 sampai ${dur.toFixed(2)} detik).
Konteks episode: "${episode.title}" (${episode.channelName}).

Aturan KETAT:
1. Transkrip 100% VERBATIM semua kata yang terdengar di audio ini (Bahasa Indonesia/campuran apa adanya, JANGAN lewati kalimat dan JANGAN mengarang).
2. Pecah menjadi potongan subtitle ringkas 3–6 kata per baris agar enak dibaca di 9:16.
3. \`offsetSec\` WAJIB berupa detik LOKAL di dalam audio potongan ini (0.00 sampai ${dur.toFixed(2)}) tepat pada SAAT KATA PERTAMA mulai terucap!
4. \`durationSec\` WAJIB tepat sampai kata terakhir baris itu selesai terucap (jangan terlalu panjang menabrak kalimat berikutnya).
5. Jika ada jeda diam (silence) di awal/tengah audio, jangan paksa subtitle muncul saat tidak ada suara.`;

  const schema = {
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
          },
          required: ['offsetSec', 'durationSec', 'text'],
        },
      },
    },
    required: ['cues'],
  };

  for (const model of ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'] as const) {
    if (signal?.aborted) break;
    try {
      const res = await ai.models.generateContent({
        model,
        contents: { parts: [audioPart, { text: prompt }] },
        config: {
          ...(model === 'gemini-4-hydrogen'
            ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
            : {}),
          responseMimeType: 'application/json',
          responseSchema: schema,
          abortSignal: combineAbortSignal(24_000, signal),
        },
      });
      const raw = (res.text ?? '').trim();
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { cues?: CaptionCue[] };
      if (Array.isArray(parsed.cues)) {
        return parsed.cues;
      }
    } catch {
      if (signal?.aborted) break;
      // Try next fallback model
    }
  }

  return [];
}

/**
 * Runs 12s anchored parallel window transcription and synthesizes title/caption/hashtags/emotionMoments
 * locked directly to the exact anchored subtitle timeline.
 */
async function transcribeVerbatimAndAnalyzeEmotions(params: {
  ai: GoogleGenAI;
  audioBase64: string;
  audioWindows: AudioWindowPayload[];
  durationSec: number;
  episode: PodcastEpisode;
  clip: PodcastClip;
  signal?: AbortSignal;
}): Promise<{
  verbatimTranscript: string;
  cues: CaptionCue[];
  autoTitle: string;
  autoCaption: string;
  hashtags: string[];
  emotionMoments: EmotionMoment[];
  emotionSummary: string;
} | null> {
  const { ai, audioBase64, audioWindows, durationSec, episode, clip, signal } = params;

  // Step A: Transcribe all 15-second anchored windows concurrently -> zero cumulative drift!
  const windowCuesList = await Promise.all(
    audioWindows.map(async (payload) => ({
      windowStartSec: payload.window.startSec,
      windowDurationSec: payload.window.durationSec,
      cues: await transcribeSingleAudioWindow({ ai, payload, episode, signal }),
    }))
  );

  const anchoredCues = mergeAnchoredWindowCues(windowCuesList, durationSec);
  if (anchoredCues.length === 0) {
    return null;
  }

  const verbatimTranscript = anchoredCues.map((c) => c.text).join(' ').trim();
  const cueTimelineText = anchoredCues
    .map((c) => `[${c.offsetSec.toFixed(1)}s–${(c.offsetSec + c.durationSec).toFixed(1)}s] ${c.text}`)
    .join('\n');

  // Step B: Generate viral title, caption, hashtags & emotion moments anchored to the exact cue timestamps!
  const audioPart = {
    inlineData: {
      mimeType: 'audio/mp3',
      data: audioBase64,
    },
  };

  const prompt = `Kamu adalah editor video Shorts viral profesional & sound designer podcast Indonesia.
Konteks episode: "${episode.title}" oleh ${episode.channelName} (durasi klip ${durationSec.toFixed(1)} detik).

Berikut adalah transkrip verbatim yang SUDAH TERSINKRONISASI tepat dengan audio & video:
${cueTimelineText}

Tugas WAJIB:
1. Buat \`autoTitle\`: judul viral yang menarik, natural, tajam, dan relevan 100% dengan pembicaraan nyata di klip ini (**maksimal 38 karakter**, tanpa kata berulang agar tidak terpotong di layar 9:16).
2. Buat \`autoCaption\`: caption & deskripsi siap unggah sesuai isi nyata klip + ajakan diskusi di komentar beserta 4–5 \`hashtags\` relevan (sertakan #Shorts).
3. Deteksi 3 hingga 5 \`emotionMoments\` (momen emosi paling menarik/punchline/plot twist/insight penting yang membuat penonton betah menonton sampai habis!):
   - \`timeSec\`: WAJIB mengacu pada detik tepat dari timeline transkrip di atas saat punchline/emosi terucap (jarak antar momen minimal 4.5 detik).
   - \`durationSec\`: 1.6 hingga 2.4 detik.
   - \`emotion\`: salah satu dari \`"funny"\`, \`"shock"\`, \`"hype"\`, \`"dramatic"\`, \`"warm"\`, \`"insight"\`.
   - \`badgeText\`: teks reaksi singkat 2–3 kata Bahasa Indonesia yang super engaging & natural (contoh: "NGAKAK PARAH!", "PLOT TWIST!", "RELATE BANGET", "POIN EMAS").
   - \`sfxStyle\`: efek suara paling cocok: \`"pop_spark"\` (lucu), \`"vine_boom"\` (shock/roasting telak), \`"whoosh_riser"\` (hype/naik), \`"chime_insight"\` (insight/ilmu), \`"chuckle_pop"\` (hangat), \`"heartbeat_hit"\` (dramatis/serius).
   - \`intensity\`: 0.6 sampai 1.0 sesuai kekuatan emosi suara.
4. Buat \`emotionSummary\`: 1 kalimat ringkas Bahasa Indonesia tentang nuansa emosi & efek retensi yang dipilih AI.`;

  const schema = {
    type: Type.OBJECT,
    properties: {
      autoTitle: { type: Type.STRING },
      autoCaption: { type: Type.STRING },
      hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
      emotionSummary: { type: Type.STRING },
      emotionMoments: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            timeSec: { type: Type.NUMBER },
            durationSec: { type: Type.NUMBER },
            emotion: {
              type: Type.STRING,
              enum: ['funny', 'shock', 'hype', 'dramatic', 'warm', 'insight'],
            },
            badgeText: { type: Type.STRING },
            sfxStyle: {
              type: Type.STRING,
              enum: [
                'pop_spark',
                'vine_boom',
                'whoosh_riser',
                'chime_insight',
                'chuckle_pop',
                'heartbeat_hit',
              ],
            },
            intensity: { type: Type.NUMBER },
          },
          required: ['timeSec', 'durationSec', 'emotion', 'badgeText', 'sfxStyle', 'intensity'],
        },
      },
    },
    required: ['autoTitle', 'autoCaption', 'hashtags', 'emotionSummary', 'emotionMoments'],
  };

  for (const model of ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'] as const) {
    if (signal?.aborted) break;
    try {
      const res = await ai.models.generateContent({
        model,
        contents: { parts: [audioPart, { text: prompt }] },
        config: {
          ...(model === 'gemini-4-hydrogen'
            ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
            : {}),
          responseMimeType: 'application/json',
          responseSchema: schema,
          abortSignal: combineAbortSignal(25_000, signal),
        },
      });
      const raw = (res.text ?? '').trim();
      if (!raw) continue;
      const parsed = JSON.parse(raw) as {
        autoTitle?: string;
        autoCaption?: string;
        hashtags?: string[];
        emotionSummary?: string;
        emotionMoments?: Partial<EmotionMoment>[];
      };

      const cleanTags = (parsed.hashtags ?? [])
        .map((t) => (t.startsWith('#') ? t : `#${t.replace(/\s+/g, '')}`))
        .filter(Boolean)
        .slice(0, 6);
      if (!cleanTags.some((t) => t.toLowerCase() === '#shorts')) {
        cleanTags.unshift('#Shorts');
      }

      const normalizedEmotions = normalizeEmotionMoments(
        parsed.emotionMoments ?? [],
        durationSec
      );

      return {
        verbatimTranscript: verbatimTranscript || clip.transcriptExcerpt,
        cues: anchoredCues,
        autoTitle: parsed.autoTitle?.trim() || clip.title,
        autoCaption: parsed.autoCaption?.trim() || clip.platformCopies.youtube_shorts.caption,
        hashtags: cleanTags,
        emotionMoments: normalizedEmotions,
        emotionSummary:
          parsed.emotionSummary?.trim() ||
          (normalizedEmotions.length > 0
            ? `AI menambahkan ${normalizedEmotions.length} momen emosi otomatis (animasi & efek suara retensi) mengikuti intonasi pembicara.`
            : 'Nuansa percakapan natural tanpa efek berlebih.'),
      };
    } catch {
      // Try next fallback
    }
  }

  // Even if metadata generation fails, return the accurately synchronized verbatim cues!
  return {
    verbatimTranscript: verbatimTranscript || clip.transcriptExcerpt,
    cues: anchoredCues,
    autoTitle: clip.autoGeneratedTitle || clip.title,
    autoCaption:
      clip.autoGeneratedCaption ||
      `${clip.platformCopies.youtube_shorts.caption} ${clip.platformCopies.youtube_shorts.hashtags.join(' ')}`.trim(),
    hashtags: clip.platformCopies.youtube_shorts.hashtags,
    emotionMoments: [],
    emotionSummary: 'Transkrip audio tersinkronisasi presisi.',
  };
}

function getSpokenContextNearTime(cues: CaptionCue[], timeSec: number): string {
  const nearby = cues
    .filter((c) => c.offsetSec <= timeSec + 1.5 && c.offsetSec + c.durationSec >= timeSec - 1.5)
    .map((c) => c.text)
    .join(' ')
    .trim();
  return nearby ? nearby.slice(0, 120) : '';
}

async function detectSpeakerBatchWithGemini(params: {
  ai: GoogleGenAI;
  audioBase64: string;
  batchFrames: Array<{ timeSec: number; isSceneCut: boolean; base64: string; spokenHint?: string }>;
  durationSec: number;
  signal?: AbortSignal;
}): Promise<{ keyframes: SpeakerKeyframe[]; summary: string } | null> {
  const { ai, audioBase64, batchFrames, durationSec, signal } = params;
  if (batchFrames.length === 0 || signal?.aborted) return null;

  const parts: Array<
    | { inlineData: { mimeType: string; data: string } }
    | { text: string }
  > = [
    {
      inlineData: {
        mimeType: 'audio/mp3',
        data: audioBase64,
      },
    },
  ];

  batchFrames.forEach((frame, idx) => {
    const cutTag = frame.isSceneCut ? ' [CAMERA CUT]' : '';
    const speechTag = frame.spokenHint ? ` | Ucapan: "${frame.spokenHint}"` : '';
    parts.push({ text: `[Frame #${idx + 1} t=${frame.timeSec}s${cutTag}${speechTag}]` });
    parts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: frame.base64,
      },
    });
  });

  parts.push({
    text: `Kamu adalah sistem active-speaker face tracking presisi tinggi untuk podcast 16:9 -> Full Frame 9:16 (durasi total ${durationSec.toFixed(1)}s).

Periksa setiap ${batchFrames.length} frame DI ATAS SECARA INDEPENDEN (JANGAN menyalin koordinat dari frame lain jika kameranya berbeda!).
Keluarkan tepat ${batchFrames.length} objek keyframe yang cocok 1-ke-1 dengan timestamp setiap frame:
1. Hitung \`visiblePeopleCount\`: berapa jumlah orang yang BENAR-BENAR TERLIHAT wajahnya pada frame tersebut (misalnya 1, 2, atau 3).
2. ATURAN MUTLAK:
   - Jika \`visiblePeopleCount === 1\` (kamera close-up 1 orang): WAJIB kunci kotak wajah (\`faceBox\`) orang tunggal yang terlihat di frame itu dengan akurat! JANGAN PERNAH menggeser fokus ke area dinding kosong atau orang yang tidak ada di gambar!
   - Jika \`visiblePeopleCount >= 2\` (kamera 2 orang / wide shot): cocokkan audio & teks ucapan pada detik tersebut dengan ekspresi wajah (mulut terbuka, gestur tangan, menoleh/menghadap mikrofon) lalu kunci \`faceBox\` orang yang SEDANG BERBICARA AKTIF!
3. Format \`faceBox\`: \`[ymin, xmin, ymax, xmax]\` dalam skala integer 0 sampai 1000 (0 = tepi atas/kiri gambar ini, 1000 = tepi bawah/kanan gambar ini) tepat melingkupi kepala & wajah target pada frame ini.
4. Isi \`focusX\` = (xmin + xmax) / 2000 (0.08–0.92), \`focusY\` = (ymin + ymax) / 2000 (0.18–0.72), \`zoomScale\` (1.04 untuk close-up 1 orang, 1.24–1.34 untuk wide shot banyak orang), \`isSceneCut\`, dan \`speakerLabel\`.
5. Tambahkan \`summary\` 1 kalimat singkat Bahasa Indonesia.`,
  });

  const schema = {
    type: Type.OBJECT,
    properties: {
      summary: { type: Type.STRING },
      keyframes: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            timeSec: { type: Type.NUMBER },
            visiblePeopleCount: { type: Type.INTEGER },
            faceBox: {
              type: Type.ARRAY,
              items: { type: Type.INTEGER },
            },
            focusX: { type: Type.NUMBER },
            focusY: { type: Type.NUMBER },
            zoomScale: { type: Type.NUMBER },
            isSceneCut: { type: Type.BOOLEAN },
            speakerLabel: { type: Type.STRING },
          },
          required: [
            'timeSec',
            'visiblePeopleCount',
            'faceBox',
            'focusX',
            'focusY',
            'zoomScale',
            'isSceneCut',
          ],
        },
      },
    },
    required: ['summary', 'keyframes'],
  };

  for (const model of ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'] as const) {
    if (signal?.aborted) break;
    try {
      const res = await ai.models.generateContent({
        model,
        contents: { parts },
        config: {
          ...(model === 'gemini-4-hydrogen'
            ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
            : {}),
          responseMimeType: 'application/json',
          responseSchema: schema,
          abortSignal: combineAbortSignal(26_000, signal),
        },
      });
      const raw = (res.text ?? '').trim();
      if (!raw) continue;
      const parsed = JSON.parse(raw) as {
        summary: string;
        keyframes: Array<
          SpeakerKeyframe & {
            visiblePeopleCount?: number;
            faceBox?: number[];
          }
        >;
      };
      if (Array.isArray(parsed.keyframes) && parsed.keyframes.length > 0) {
        const mapped: SpeakerKeyframe[] = parsed.keyframes.map((k, idx) => {
          const refFrame = batchFrames[Math.min(idx, batchFrames.length - 1)];
          const validBox =
            Array.isArray(k.faceBox) && k.faceBox.length === 4
              ? ([k.faceBox[0], k.faceBox[1], k.faceBox[2], k.faceBox[3]] as [
                  number,
                  number,
                  number,
                  number,
                ])
              : undefined;
          const timeSec =
            Number.isFinite(Number(k.timeSec)) &&
            Math.abs(Number(k.timeSec) - refFrame.timeSec) <= 1.2
              ? Number(k.timeSec)
              : refFrame.timeSec;
          return {
            timeSec,
            focusX: k.focusX,
            focusY: k.focusY,
            zoomScale: k.zoomScale,
            speakerLabel: k.speakerLabel,
            isSceneCut: Boolean(k.isSceneCut || refFrame.isSceneCut),
            ...(validBox ? { faceBox: validBox } : {}),
          };
        });
        return {
          keyframes: mapped,
          summary: parsed.summary?.trim() || '',
        };
      }
    } catch {
      // Try next fallback
    }
  }

  return null;
}

/**
 * Splits cut-aligned frames into small focused batches of 4 frames processed in parallel.
 * This eliminates multi-frame vision attention drift / coordinate copy-pasting across camera cuts
 * while keeping total latency fast (~4–6s).
 */
async function detectActiveSpeakerWithGemini(params: {
  ai: GoogleGenAI;
  audioBase64: string;
  frames: Array<{ timeSec: number; isSceneCut: boolean; base64: string }>;
  cues: CaptionCue[];
  durationSec: number;
  signal?: AbortSignal;
}): Promise<{ keyframes: SpeakerKeyframe[]; summary: string } | null> {
  const { ai, audioBase64, frames, cues, durationSec, signal } = params;
  if (frames.length === 0 || signal?.aborted) return null;

  const enrichedFrames = frames.map((f) => ({
    ...f,
    spokenHint: getSpokenContextNearTime(cues, f.timeSec),
  }));

  const batchSize = 6;
  const batches: Array<typeof enrichedFrames> = [];
  for (let i = 0; i < enrichedFrames.length; i += batchSize) {
    batches.push(enrichedFrames.slice(i, i + batchSize));
  }

  const batchResults = await Promise.all(
    batches.map((batchFrames) =>
      detectSpeakerBatchWithGemini({
        ai,
        audioBase64,
        batchFrames,
        durationSec,
        signal,
      })
    )
  );

  const combinedKeyframes: SpeakerKeyframe[] = [];
  let summary = '';
  for (const res of batchResults) {
    if (!res) continue;
    combinedKeyframes.push(...res.keyframes);
    if (!summary && res.summary) summary = res.summary;
  }

  if (combinedKeyframes.length === 0) return null;

  return {
    keyframes: normalizeSpeakerKeyframes(combinedKeyframes, durationSec),
    summary:
      summary ||
      'Auto-fokus presisi melacak wajah pembicara aktif di setiap pergantian sudut kamera.',
  };
}

/**
 * Analyzes the trimmed source clip's real audio & cut-aligned frames (with disk cache v2 per clip segment)
 * to produce 100% verbatim subtitles, auto title/caption, precision faceBox active-speaker tracking,
 * and automatic AI emotion retention moments (audio SFX + kinetic animations).
 */
export async function analyzeTrimmedClipIntelligence(params: {
  rawVideoPath: string;
  durationSec: number;
  workDir: string;
  cachePath?: string;
  episode: PodcastEpisode;
  clip: PodcastClip;
  signal?: AbortSignal;
}): Promise<ClipIntelligenceResult> {
  const { rawVideoPath, durationSec, workDir, cachePath, episode, clip, signal } = params;
  const checkAborted = () => {
    if (signal?.aborted) {
      const err = new Error('Proses analisis klip dibatalkan oleh pengguna.');
      err.name = 'AbortError';
      throw err;
    }
  };
  checkAborted();

  if (cachePath && fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as ClipIntelligenceResult;
      if (
        cached &&
        cached.version === INTELLIGENCE_CACHE_VERSION &&
        cached.subtitleSource === 'audio_transcribed' &&
        Array.isArray(cached.cues) &&
        cached.cues.length > 0 &&
        Array.isArray(cached.keyframes) &&
        cached.keyframes.length > 0 &&
        Array.isArray(cached.emotionMoments)
      ) {
        return cached;
      }
    } catch {
      // Ignore corrupt/legacy cache and recompute cleanly
    }
  }

  const fallbackResult: ClipIntelligenceResult = {
    version: INTELLIGENCE_CACHE_VERSION,
    cues: normalizeTranscribedCues(clip.captionCues, durationSec),
    verbatimTranscript: clip.transcriptExcerpt,
    autoTitle: clip.autoGeneratedTitle || clip.title,
    autoCaption:
      clip.autoGeneratedCaption ||
      `${clip.platformCopies.youtube_shorts.caption} ${clip.platformCopies.youtube_shorts.hashtags.join(' ')}`.trim(),
    hashtags: clip.platformCopies.youtube_shorts.hashtags,
    subtitleSource: 'existing_fallback',
    keyframes: normalizeSpeakerKeyframes([], durationSec),
    speakerFocusSummary: 'Fokus kamera otomatis di tengah pembicara.',
    emotionMoments: [],
    emotionSummary: 'Efek emosi otomatis siap saat analisis AI aktif.',
  };

  const ai = getAiClient();
  if (!ai) {
    return fallbackResult;
  }

  try {
    checkAborted();
    const { audioBase64, audioWindows, frames } = await extractClipAudioAndSmartFrames({
      rawVideoPath,
      durationSec,
      workDir,
      signal,
    });

    checkAborted();
    const sttAndEmotion = await transcribeVerbatimAndAnalyzeEmotions({
      ai,
      audioBase64,
      audioWindows,
      durationSec,
      episode,
      clip,
      signal,
    });

    checkAborted();
    const speakerResult = await detectActiveSpeakerWithGemini({
      ai,
      audioBase64,
      frames,
      cues: sttAndEmotion?.cues ?? fallbackResult.cues,
      durationSec,
      signal,
    });

    checkAborted();
    const finalResult: ClipIntelligenceResult = {
      version: INTELLIGENCE_CACHE_VERSION,
      cues: sttAndEmotion?.cues ?? fallbackResult.cues,
      verbatimTranscript: sttAndEmotion?.verbatimTranscript ?? fallbackResult.verbatimTranscript,
      autoTitle: sttAndEmotion?.autoTitle ?? fallbackResult.autoTitle,
      autoCaption: sttAndEmotion?.autoCaption ?? fallbackResult.autoCaption,
      hashtags: sttAndEmotion?.hashtags ?? fallbackResult.hashtags,
      subtitleSource: sttAndEmotion ? 'audio_transcribed' : 'existing_fallback',
      keyframes: speakerResult?.keyframes ?? fallbackResult.keyframes,
      speakerFocusSummary: speakerResult?.summary ?? fallbackResult.speakerFocusSummary,
      emotionMoments: sttAndEmotion?.emotionMoments ?? fallbackResult.emotionMoments,
      emotionSummary: sttAndEmotion?.emotionSummary ?? fallbackResult.emotionSummary,
    };

    if (cachePath && finalResult.subtitleSource === 'audio_transcribed') {
      try {
        fs.writeFileSync(cachePath, JSON.stringify(finalResult), 'utf-8');
      } catch {
        // Ignore cache write errors
      }
    }

    return finalResult;
  } catch (err) {
    if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw err;
    }
    return fallbackResult;
  }
}

