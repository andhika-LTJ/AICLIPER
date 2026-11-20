import type { PodcastClip, SocialPlatform } from '../types/clipper.ts';

/**
 * Extracts an 11-character YouTube video ID from standard watch, short, live, embed, or youtu.be URLs.
 */
export function extractYouTubeVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Accept direct 11-character ID if valid
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  let normalized = trimmed;
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }

  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();

    if (host === 'youtu.be') {
      const candidate = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
      return /^[a-zA-Z0-9_-]{11}$/.test(candidate) ? candidate : null;
    }

    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      const vParam = parsed.searchParams.get('v');
      if (vParam && /^[a-zA-Z0-9_-]{11}$/.test(vParam)) {
        return vParam;
      }
      const segments = parsed.pathname.split('/').filter(Boolean);
      if (segments.length >= 2 && ['shorts', 'live', 'embed', 'v'].includes(segments[0])) {
        const candidate = segments[1];
        return /^[a-zA-Z0-9_-]{11}$/.test(candidate) ? candidate : null;
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Formats seconds into MM:SS or HH:MM:SS.
 */
export function formatTimestamp(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;

  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Parses a MM:SS or HH:MM:SS string into total seconds. Returns null if invalid.
 */
export function parseTimestamp(label: string): number | null {
  const cleaned = label.trim();
  if (!/^\d{1,2}(:\d{1,2}){1,2}$/.test(cleaned)) {
    return null;
  }
  const parts = cleaned.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n) || n < 0)) return null;

  if (parts.length === 2) {
    const [m, s] = parts;
    if (s >= 60) return null;
    return m * 60 + s;
  }
  const [h, m, s] = parts;
  if (m >= 60 || s >= 60) return null;
  return h * 3600 + m * 60 + s;
}

/**
 * Clamps and normalizes clip start/end bounds to stay within episode length and Shorts limits.
 */
export function clampClipRange(
  startSec: number,
  endSec: number,
  episodeDurationSec: number,
  minClipSec = 10,
  maxClipSec = 60
): { startSec: number; endSec: number; durationSec: number } {
  const safeMaxEpisode = Math.max(minClipSec, Math.floor(episodeDurationSec));
  let start = Math.max(0, Math.min(Math.floor(startSec), safeMaxEpisode - minClipSec));
  let end = Math.max(start + minClipSec, Math.min(Math.floor(endSec), safeMaxEpisode));

  if (end - start > maxClipSec) {
    end = start + maxClipSec;
  }

  return {
    startSec: start,
    endSec: end,
    durationSec: end - start,
  };
}

function formatSrtTime(totalSeconds: number): string {
  const safeMs = Math.max(0, Math.round(totalSeconds * 1000));
  const hours = Math.floor(safeMs / 3600000);
  const minutes = Math.floor((safeMs % 3600000) / 60000);
  const seconds = Math.floor((safeMs % 60000) / 1000);
  const ms = safeMs % 1000;
  const p2 = (n: number) => String(n).padStart(2, '0');
  const p3 = (n: number) => String(n).padStart(3, '0');
  return `${p2(hours)}:${p2(minutes)}:${p2(seconds)},${p3(ms)}`;
}

/**
 * Generates an SRT subtitle file string for a trimmed clip starting from 00:00:00,000.
 */
export function generateSrtFromClip(clip: PodcastClip): string {
  const clipDuration = Math.max(1, clip.endSec - clip.startSec);
  const cues =
    clip.captionCues.length > 0
      ? clip.captionCues
      : [
          {
            offsetSec: 0,
            durationSec: Math.min(5, clipDuration),
            text: clip.hookLine || clip.title,
          },
        ];

  return cues
    .filter((cue) => cue.offsetSec < clipDuration)
    .map((cue, idx) => {
      const start = Math.max(0, cue.offsetSec);
      const end = Math.min(clipDuration, start + Math.max(1, cue.durationSec));
      return `${idx + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${cue.text.trim()}`;
    })
    .join('\n\n');
}

/**
 * Builds an ffmpeg CLI command for local lossless/re-encoded 9:16 vertical crop export.
 */
export function buildFfmpegCommand(clip: PodcastClip, sourceFile = 'podcast.mp4'): string {
  const start = formatTimestamp(clip.startSec);
  const duration = Math.max(5, clip.endSec - clip.startSec);
  return `ffmpeg -ss ${start} -i "${sourceFile}" -t ${duration} -vf "crop=ih*9/16:ih,scale=1080:1920" -c:v libx264 -c:a aac -preset fast "short_${clip.id}.mp4"`;
}

/**
 * Builds direct social share / upload intent URLs for supported platforms.
 */
export function buildSocialShareUrl(
  platform: SocialPlatform,
  clip: PodcastClip,
  sourceUrl: string
): string {
  const copy = clip.platformCopies[platform];
  const tags = copy.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ');
  const fullText = `${copy.title}\n\n${copy.caption}\n\n${tags}`.trim();

  switch (platform) {
    case 'youtube_shorts':
      return 'https://studio.youtube.com/';
    case 'x_twitter':
      return `https://twitter.com/intent/tweet?text=${encodeURIComponent(
        `${fullText.slice(0, 230)}\n${sourceUrl}`
      )}`;
    case 'linkedin':
      return `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(
        `${fullText}\n\nSumber Podcast: ${sourceUrl}`
      )}`;
    case 'tiktok':
      return 'https://www.tiktok.com/creator-center/upload';
    case 'instagram_reels':
      return 'https://www.instagram.com/';
  }
}

export const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  youtube_shorts: 'YouTube Shorts',
  tiktok: 'TikTok',
  instagram_reels: 'Instagram Reels',
  x_twitter: 'X / Twitter',
  linkedin: 'LinkedIn',
};

/**
 * Converts raw Gemini API error objects/JSON strings into clean, actionable Indonesian user messages.
 */
export function formatGeminiErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : JSON.stringify(error ?? '');

  const normalized = raw.toUpperCase();

  if (normalized.includes('429') || normalized.includes('RESOURCE_EXHAUSTED') || normalized.includes('QUOTA')) {
    return 'Kuota atau batas permintaan (rate limit) Gemini API pada kunci Anda saat ini habis (429 RESOURCE_EXHAUSTED). Tunggu beberapa saat atau pilih/perbarui API key berbayar di panel Settings > Secrets.';
  }

  if (normalized.includes('503') || normalized.includes('UNAVAILABLE') || normalized.includes('HIGH DEMAND')) {
    return 'Server model AI sedang sibuk sementara (503 UNAVAILABLE). Silakan klik "Analisis & Potong Klip" kembali dalam beberapa detik.';
  }

  if (normalized.includes('PERMISSION_DENIED') || normalized.includes('403') || normalized.includes('API_KEY_INVALID') || normalized.includes('400')) {
    return 'API key Gemini tidak valid atau tidak memiliki izin (400/403). Periksa kembali konfigurasi kunci Anda di panel Settings > Secrets.';
  }

  if (normalized.includes('404') || normalized.includes('NOT_FOUND')) {
    return 'Model AI yang diminta tidak tersedia untuk API key Anda saat ini (404).';
  }

  return raw || 'Terjadi kesalahan saat memproses analisis AI.';
}

function formatAssTime(totalSeconds: number): string {
  const safeCs = Math.max(0, Math.round(totalSeconds * 100));
  const hours = Math.floor(safeCs / 360000);
  const minutes = Math.floor((safeCs % 360000) / 6000);
  const seconds = Math.floor((safeCs % 6000) / 100);
  const cs = safeCs % 100;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${hours}:${p2(minutes)}:${p2(seconds)}.${p2(cs)}`;
}

/**
 * Generates an ASS subtitle file styled for 720x1280 vertical podcast Shorts.
 */
export function generateAssFromClip(clip: PodcastClip): string {
  const clipDuration = Math.max(1, clip.endSec - clip.startSec);
  const cues =
    clip.captionCues.length > 0
      ? clip.captionCues
      : [
          {
            offsetSec: 0,
            durationSec: Math.min(5, clipDuration),
            text: clip.hookLine || clip.title,
          },
        ];

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,34,&H00FFFFFF,&H000000FF,&H000F172A,&H80000000,1,0,0,0,100,100,0,0,1,3,0,2,48,48,210,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const events = cues
    .filter((cue) => cue.offsetSec < clipDuration)
    .map((cue) => {
      const start = Math.max(0, cue.offsetSec);
      const end = Math.min(clipDuration, start + Math.max(1, cue.durationSec));
      const cleanText = cue.text.replace(/\r?\n/g, '\\N').trim();
      return `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,${cleanText}`;
    });

  return `${header}\n${events.join('\n')}\n`;
}

/**
 * Builds a complete yt-dlp + ffmpeg command to clip original video + audio locally into 9:16 MP4.
 */
export function buildYtDlpFfmpegCommand(clip: PodcastClip, sourceUrl: string): string {
  const start = formatTimestamp(clip.startSec);
  const end = formatTimestamp(clip.endSec);
  return `yt-dlp --download-sections "*${start}-${end}" -f "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]" --force-keyframes-at-cuts "${sourceUrl}" -o "raw_${clip.id}.mp4" && ffmpeg -i "raw_${clip.id}.mp4" -vf "scale=1080:-2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:#0F172A" -c:v libx264 -c:a aac -preset fast "short_${clip.id}.mp4"`;
}


