import { createHash } from 'crypto';

export interface AltchaChallengePayload {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  maxnumber?: number;
}

const DEFAULT_NOTUBE_SERVERS = [60, 61, 59, 62, 63, 64, 58, 65, 57, 66];

/**
 * Extracts active NoTube worker server IDs (e.g. s40..s76) from the notube.net page script.
 */
export function extractNotubeServerIds(html: string): number[] {
  const match = html.match(/\ba\s*=\s*\[([\d,\s]+)\]/);
  if (match?.[1]) {
    const parsed = match[1]
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 10 && n <= 200);
    if (parsed.length > 0) {
      return parsed;
    }
  }

  const fallbackMatches = [...html.matchAll(/https?:\/\/s(\d+)\.notube\.net/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isInteger(n) && n >= 10 && n <= 200);

  if (fallbackMatches.length > 0) {
    return Array.from(new Set(fallbackMatches));
  }

  return [...DEFAULT_NOTUBE_SERVERS];
}

/**
 * Extracts the direct MP4 download URL from the NoTube download result page HTML.
 */
export function extractNotubeDownloadUrl(html: string): string | null {
  const buttonMatch = html.match(
    /<a[^>]*\bid=["']downloadButton["'][^>]*\bhref=["'](https?:\/\/[^"']+)["'][^>]*>/i
  ) ??
    html.match(
      /<a[^>]*\bhref=["'](https?:\/\/[^"']+)["'][^>]*\bid=["']downloadButton["'][^>]*>/i
    );

  if (buttonMatch?.[1]) {
    return buttonMatch[1].replace(/&amp;/g, '&');
  }

  const directMatch = html.match(/https?:\/\/s\d+\.notube\.net\/download\.php\?[^"'\s<>]+/i);
  if (directMatch?.[0]) {
    return directMatch[0].replace(/&amp;/g, '&');
  }

  return null;
}

/**
 * Normalizes a YouTube URL or 11-character video ID into a canonical watch URL.
 */
export function buildCanonicalWatchUrl(videoIdOrUrl: string): string {
  const trimmed = videoIdOrUrl.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return `https://www.youtube.com/watch?v=${trimmed}`;
  }
  return trimmed;
}

/**
 * Formats a trim range as *HH:MM:SS-HH:MM:SS for third-party trimmers like amp4.cc.
 */
export function formatAmp4TrimArg(startSec: number, endSec: number): string {
  const toHms = (sec: number) => {
    const safe = Math.max(0, Math.floor(sec));
    const h = Math.floor(safe / 3600);
    const m = Math.floor((safe % 3600) / 60);
    const s = safe % 60;
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(h)}:${p(m)}:${p(s)}`;
  };
  const safeStart = Math.max(0, Math.floor(startSec));
  const safeEnd = Math.max(safeStart + 5, Math.floor(endSec));
  return `*${toHms(safeStart)}-${toHms(safeEnd)}`;
}

/**
 * Solves an ALTCHA SHA-256 proof-of-work challenge and returns the base64 token.
 */
export function solveAltchaChallenge(challenge: AltchaChallengePayload): string {
  const t0 = Date.now();
  const max = Math.min(2_000_000, Math.max(10_000, challenge.maxnumber ?? 500_000));
  let solution: number | null = null;

  for (let n = 0; n <= max; n++) {
    const digest = createHash('sha256')
      .update(`${challenge.salt}${n}`)
      .digest('hex');
    if (digest === challenge.challenge) {
      solution = n;
      break;
    }
  }

  if (solution === null) {
    throw new Error('Gagal menyelesaikan tantangan ALTCHA PoW.');
  }

  return Buffer.from(
    JSON.stringify({
      algorithm: challenge.algorithm || 'SHA-256',
      challenge: challenge.challenge,
      number: solution,
      salt: challenge.salt,
      signature: challenge.signature,
      took: Math.max(1, Date.now() - t0),
    })
  ).toString('base64');
}

export type StreamQualityTier = '2160p' | '1440p' | '1080p' | '720p' | '480p' | '360p';

const QUALITY_RANK: Record<StreamQualityTier, number> = {
  '2160p': 6,
  '1440p': 5,
  '1080p': 4,
  '720p': 3,
  '480p': 2,
  '360p': 1,
};

export function getQualityRank(tier?: StreamQualityTier): number {
  return tier ? (QUALITY_RANK[tier] ?? 0) : 0;
}

/**
 * Normalizes direct download URLs returned by third-party services (encodes unescaped spaces).
 */
export function normalizeThirdPartyMediaUrl(rawUrl: string): string {
  const cleaned = rawUrl.replace(/&amp;/g, '&').trim();
  return cleaned.replace(/ /g, '%20');
}

/**
 * Selects the highest-resolution real video stream index (ignoring embedded png/mjpeg cover art).
 */
export function selectBestVideoStreamIndex(
  streams: Array<{
    index: number;
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
  }>
): number {
  const realVideos = streams.filter(
    (s) =>
      s.codec_type === 'video' &&
      !['png', 'mjpeg', 'webp', 'bmp'].includes((s.codec_name ?? '').toLowerCase()) &&
      (s.width ?? 0) > 0 &&
      (s.height ?? 0) > 0
  );
  if (realVideos.length === 0) return 0;
  realVideos.sort(
    (a, b) => (b.height ?? 0) * (b.width ?? 0) - (a.height ?? 0) * (a.width ?? 0)
  );
  return realVideos[0].index;
}

/**
 * Solves SaveNow's SHA-256 leading-zero proof-of-work challenge (`sha256("${salt}:${nonce}")`).
 */
export function solveSaveNowPow(salt: string, difficulty: number, maxIterations = 2_000_000): number {
  const safeDiff = Math.max(0, Math.min(8, Math.floor(difficulty)));
  const prefix = '0'.repeat(safeDiff);
  for (let nonce = 0; nonce <= maxIterations; nonce++) {
    const hex = createHash('sha256').update(`${salt}:${nonce}`).digest('hex');
    if (hex.startsWith(prefix)) {
      return nonce;
    }
  }
  throw new Error('Gagal menyelesaikan tantangan PoW SaveNow.');
}

/**
 * Validates that raw text is a real Netscape HTTP Cookie File containing at least one YouTube cookie entry.
 * Rejects accidental pastes such as `yt-dlp ...` CLI commands or plain URLs.
 */
export function validateNetscapeCookiesTxt(raw: string): { valid: boolean; reason?: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: false, reason: 'Isi cookies.txt kosong.' };
  }
  if (/^\s*(yt-dlp|ffmpeg|https?:\/\/)/i.test(trimmed)) {
    return {
      valid: false,
      reason:
        'Teks yang ditempel bukan file cookies.txt (terlihat seperti perintah yt-dlp atau link). Ekspor cookies YouTube dari ekstensi "Get cookies.txt LOCALLY" dalam format Netscape.',
    };
  }

  const lines = trimmed.split(/\r?\n/);
  let youtubeCookieCount = 0;
  for (const line of lines) {
    const clean = line.trim();
    if (!clean || clean.startsWith('#')) continue;
    const cols = clean.split('\t');
    if (cols.length >= 7 && /(^|\.)youtube\.com$/i.test(cols[0])) {
      youtubeCookieCount += 1;
    }
  }

  if (youtubeCookieCount === 0) {
    return {
      valid: false,
      reason:
        'Format cookies.txt tidak valid: tidak ditemukan baris cookie domain .youtube.com (7 kolom dipisah Tab).',
    };
  }

  return { valid: true };
}

