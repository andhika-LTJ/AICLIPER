import { execFile, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type {
  ClipRenderLayout,
  ClipRenderQuality,
  PodcastClip,
  PodcastEpisode,
} from '../src/types/clipper.ts';
import {
  analyzeTrimmedClipIntelligence,
  type ClipIntelligenceResult,
} from './clipIntelligence.ts';
import { buildEmotionAudioFilterGraph } from './emotionEffects.ts';
import {
  buildSmoothCropAxisExpression,
  computeCropWindow,
  generateStudioAssScript,
  getTargetCanvasDimensions,
  normalizeRenderLayout,
  normalizeRenderQuality,
  type CanonicalRenderQuality,
  type CanonicalStudioLayout,
} from './speakerFocusMath.ts';
import {
  invalidateEpisodeStreamCache,
  resolveThirdPartyMp4Stream,
} from './thirdPartyDownloader.ts';
import {
  isBotBlockErrorText,
  resolveEnvYoutubeCookies,
  validateNetscapeCookiesTxt,
} from './downloaderParsers.ts';
import {
  assessStreamSyncHealth,
  type StreamSyncAssessment,
} from './audioSyncMath.ts';

const execFileAsync = promisify(execFile);

const DATA_DIR = path.resolve(process.cwd(), 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const RENDERS_DIR = path.join(DATA_DIR, 'renders');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const COOKIES_PATH = path.join(DATA_DIR, 'youtube-cookies.txt');
const ENV_COOKIES_PATH = path.join(DATA_DIR, 'youtube-env-cookies.txt');
const YTDLP_BIN = '/tmp/yt-dlp';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CPU_COUNT = os.cpus()?.length || 2;
const FFMPEG_THREADS = String(Math.max(2, Math.min(4, CPU_COUNT)));

export type ClipRenderSource =
  | 'uploaded_video'
  | 'direct_video_url'
  | 'youtube_stream'
  | 'third_party_downloader';

function ensureDirs() {
  for (const dir of [DATA_DIR, UPLOADS_DIR, RENDERS_DIR, TMP_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

export function getUploadedVideoPath(episodeId: string): string | null {
  ensureDirs();
  const candidates = ['.mp4', '.webm', '.mov', '.mkv'].map((ext) =>
    path.join(UPLOADS_DIR, `${episodeId}${ext}`)
  );
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export function getUploadTargetPath(episodeId: string): string {
  ensureDirs();
  return path.join(UPLOADS_DIR, `${episodeId}.mp4`);
}

export function getRenderedClipPath(clipId: string): string | null {
  ensureDirs();
  const target = path.join(RENDERS_DIR, `${clipId}.mp4`);
  return fs.existsSync(target) ? target : null;
}

function getActiveCookiesFilePath(): string | null {
  if (fs.existsSync(COOKIES_PATH)) {
    try {
      const content = fs.readFileSync(COOKIES_PATH, 'utf-8');
      if (validateNetscapeCookiesTxt(content).valid) {
        return COOKIES_PATH;
      }
    } catch {
      // Fall through to env cookies
    }
  }

  const envCookies = resolveEnvYoutubeCookies(process.env.YOUTUBE_COOKIES_TXT);
  if (envCookies) {
    ensureDirs();
    fs.writeFileSync(ENV_COOKIES_PATH, envCookies, 'utf-8');
    return ENV_COOKIES_PATH;
  }

  return null;
}

export function hasYoutubeCookies(): boolean {
  return Boolean(getActiveCookiesFilePath());
}

export function saveYoutubeCookies(rawCookies: string): {
  saved: boolean;
  error?: string;
} {
  ensureDirs();
  const trimmed = rawCookies.trim();
  if (!trimmed) {
    if (fs.existsSync(COOKIES_PATH)) fs.unlinkSync(COOKIES_PATH);
    return { saved: hasYoutubeCookies() };
  }
  const check = validateNetscapeCookiesTxt(trimmed);
  if (!check.valid) {
    return { saved: hasYoutubeCookies(), error: check.reason };
  }
  fs.writeFileSync(COOKIES_PATH, trimmed, 'utf-8');
  invalidateLowResSegmentCache();
  return { saved: true };
}

/**
 * Removes cached segment files in data/tmp/ so upgrading to native 1080p/4K via
 * YouTube cookies.txt or an uploaded MP4 source immediately pulls fresh HD frames.
 */
export function invalidateLowResSegmentCache(episodeId?: string): void {
  try {
    ensureDirs();
    for (const entry of fs.readdirSync(TMP_DIR)) {
      if (!entry.startsWith('seg_')) continue;
      if (episodeId && !entry.includes(episodeId)) continue;
      const full = path.join(TMP_DIR, entry);
      if (fs.existsSync(full)) fs.unlinkSync(full);
    }
  } catch {
    // Ignore cache invalidation errors
  }
}

let resolvedYtDlpPath: string | null = null;
let ytDlpInstallPromise: Promise<string> | null = null;

async function ensureYtDlpBinary(): Promise<string> {
  if (resolvedYtDlpPath && (resolvedYtDlpPath === 'yt-dlp' || fs.existsSync(resolvedYtDlpPath))) {
    return resolvedYtDlpPath;
  }
  if (ytDlpInstallPromise) {
    return ytDlpInstallPromise;
  }

  ytDlpInstallPromise = (async (): Promise<string> => {
    try {
      await execFileAsync('yt-dlp', ['--version'], { timeout: 3_000 });
      resolvedYtDlpPath = 'yt-dlp';
      return 'yt-dlp';
    } catch {
      // Not on PATH; check /tmp/yt-dlp
    }

    if (fs.existsSync(YTDLP_BIN)) {
      resolvedYtDlpPath = YTDLP_BIN;
      return YTDLP_BIN;
    }

    const res = await fetch(
      'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux',
      { signal: AbortSignal.timeout(25_000) }
    );
    if (!res.ok) {
      throw new Error('Gagal menyiapkan utilitas pengunduh video yt-dlp.');
    }
    const arrayBuffer = await res.arrayBuffer();
    fs.writeFileSync(YTDLP_BIN, Buffer.from(arrayBuffer), { mode: 0o755 });
    resolvedYtDlpPath = YTDLP_BIN;
    return YTDLP_BIN;
  })();

  try {
    return await ytDlpInstallPromise;
  } finally {
    ytDlpInstallPromise = null;
  }
}

export async function prewarmYtDlpBinary(): Promise<void> {
  try {
    await ensureYtDlpBinary();
  } catch {
    // Silent background warmup; on-demand render retries if needed
  }
}

export class YoutubeBotCheckError extends Error {
  code = 'YOUTUBE_BOT_CHECK' as const;
  constructor(message: string) {
    super(message);
    this.name = 'YoutubeBotCheckError';
  }
}

export class RenderCancelledError extends Error {
  code = 'CANCELLED' as const;
  constructor(message = 'Proses render dibatalkan oleh pengguna.') {
    super(message);
    this.name = 'RenderCancelledError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new RenderCancelledError();
  }
}

function isAbortLikeError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted || err instanceof RenderCancelledError) return true;
  if (err && typeof err === 'object') {
    const e = err as { name?: string; code?: string };
    if (e.name === 'AbortError' || e.code === 'ABORT_ERR' || e.code === 'CANCELLED') {
      return true;
    }
  }
  return false;
}

function escapeFfmpegFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

async function probeVideoMeta(videoPath: string): Promise<{
  width: number;
  height: number;
  durationSec: number;
  sizeBytes: number;
  audioCodec?: string;
  videoStartTime: number;
  audioStartTime: number;
  videoDurationSec: number;
  audioDurationSec: number;
  syncHealth: StreamSyncAssessment;
}> {
  if (!fs.existsSync(videoPath)) {
    throw new Error('File video tidak ditemukan.');
  }
  const stat = fs.statSync(videoPath);
  if (stat.size < 10_000) {
    throw new Error('File video tidak valid atau terlalu kecil.');
  }

  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration,start_time:stream=codec_type,codec_name,width,height,start_time,duration',
      '-of',
      'json',
      videoPath,
    ],
    { timeout: 15_000 }
  );

  const parsed = JSON.parse(stdout) as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      start_time?: string;
      duration?: string;
    }>;
    format?: { duration?: string; start_time?: string };
  };

  const videoStream = (parsed.streams ?? []).find(
    (s) =>
      s.codec_type === 'video' &&
      !['png', 'mjpeg', 'webp'].includes((s.codec_name ?? '').toLowerCase()) &&
      (s.width ?? 0) > 0 &&
      (s.height ?? 0) > 0
  );
  const audioStream = (parsed.streams ?? []).find((s) => s.codec_type === 'audio');
  const formatDurationSec = Number(parsed.format?.duration ?? 0);
  const videoDurationSec = Number(videoStream?.duration ?? formatDurationSec);
  const audioDurationSec = Number(audioStream?.duration ?? formatDurationSec);
  const durationSec = Number.isFinite(videoDurationSec) && videoDurationSec > 0
    ? videoDurationSec
    : formatDurationSec;
  const videoStartTime = Number(videoStream?.start_time ?? 0) || 0;
  const audioStartTime = Number(audioStream?.start_time ?? 0) || 0;

  if (!videoStream || !Number.isFinite(durationSec) || durationSec < 1) {
    throw new Error('Stream video/durasi hasil potong tidak valid.');
  }

  const syncHealth = assessStreamSyncHealth({
    videoStartTime,
    audioStartTime,
    videoDurationSec: Number.isFinite(videoDurationSec) ? videoDurationSec : durationSec,
    audioDurationSec: Number.isFinite(audioDurationSec) ? audioDurationSec : durationSec,
  });

  return {
    width: videoStream.width!,
    height: videoStream.height!,
    durationSec,
    sizeBytes: stat.size,
    audioCodec: audioStream?.codec_name,
    videoStartTime,
    audioStartTime,
    videoDurationSec: Number.isFinite(videoDurationSec) ? videoDurationSec : durationSec,
    audioDurationSec: Number.isFinite(audioDurationSec) ? audioDurationSec : durationSec,
    syncHealth,
  };
}

/**
 * Runs ffmpeg with `-progress pipe:1`, NO artificial timeout limit, and instant
 * SIGTERM/SIGKILL child termination when `signal` is aborted so cancelled renders
 * free 100% of CPU & RAM immediately.
 */
function runFfmpegWithProgress(params: {
  args: string[];
  durationSec: number;
  signal?: AbortSignal;
  onPercent?: (ratio01: number) => void;
}): Promise<void> {
  const { args, durationSec, signal, onPercent } = params;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RenderCancelledError());
      return;
    }

    const child = spawn('ffmpeg', ['-progress', 'pipe:1', '-nostats', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderrTail = '';
    let stdoutBuf = '';
    let lastReportedPct = -1;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
    };

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore if already exited
      }
      forceKillTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore
        }
      }, 400);
      if (!settled) {
        settled = true;
        cleanup();
        reject(new RenderCancelledError());
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('out_time_us=') || line.startsWith('out_time_ms=')) {
          const val = Number(line.split('=')[1]);
          if (Number.isFinite(val) && val > 0 && durationSec > 0) {
            // ffmpeg reports out_time_ms in microseconds in newer builds
            const elapsedSec = val / 1_000_000;
            const ratio = Math.max(0, Math.min(0.99, elapsedSec / durationSec));
            const pctBucket = Math.floor(ratio * 100);
            if (pctBucket > lastReportedPct) {
              lastReportedPct = pctBucket;
              onPercent?.(ratio);
            }
          }
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal?.aborted ? new RenderCancelledError() : err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (signal?.aborted) {
        reject(new RenderCancelledError());
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg keluar dengan kode ${code}: ${stderrTail.slice(-300)}`));
      }
    });
  });
}

/**
 * Extracts only the trimmed clip window using ultra-fast stream-copy first (~1-2s),
 * avoiding double video encoding before the studio render pass.
 */
async function extractRawTrimmedSegment(params: {
  inputSource: string;
  isRemoteUrl: boolean;
  extraHeaders?: Record<string, string>;
  startSec: number;
  durationSec: number;
  needSeekTrim: boolean;
  outputPath: string;
  signal?: AbortSignal;
}): Promise<void> {
  const {
    inputSource,
    isRemoteUrl,
    extraHeaders,
    startSec,
    durationSec,
    needSeekTrim,
    outputPath,
    signal,
  } = params;

  throwIfAborted(signal);

  const buildInputPrefixArgs = (source: string, remote: boolean, withSeek: boolean) => {
    const args: string[] = ['-y', '-threads', FFMPEG_THREADS];
    if (remote) {
      args.push(
        '-user_agent',
        BROWSER_UA,
        '-reconnect',
        '1',
        '-reconnect_streamed',
        '1',
        '-reconnect_delay_max',
        '5'
      );
      if (extraHeaders && Object.keys(extraHeaders).length > 0) {
        const headerStr = Object.entries(extraHeaders)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n');
        args.push('-headers', `${headerStr}\r\n`);
      }
    }
    if (withSeek) {
      args.push('-ss', String(startSec));
    }
    args.push('-i', source);
    return args;
  };

  let reencodeInputSource = inputSource;
  let reencodeIsRemote = isRemoteUrl;
  let preRollCommonTrimSec = 0;
  let tempUnsyncedLocalPath: string | null = null;

  // Pass 1: Fast stream-copy ONLY for pre-trimmed sources (no -ss GOP keyframe drift!)
  // AND strictly verified via probeVideoMeta().syncHealth.isSynced (zero A/V start_time gap).
  if (!needSeekTrim) {
    try {
      // If the pre-trimmed source is already local (e.g. SaveNow chunked download or yt-dlp),
      // inspect its stream start_time offsets BEFORE copying so any 1–5s GOP pre-roll is caught immediately.
      let skipCopyDueToLocalDesync = false;
      if (!isRemoteUrl && fs.existsSync(inputSource)) {
        const srcMeta = await probeVideoMeta(inputSource);
        if (!srcMeta.syncHealth.isSynced) {
          skipCopyDueToLocalDesync = true;
          if (
            srcMeta.syncHealth.avStartOffsetSec > 0.08 &&
            srcMeta.syncHealth.avStartOffsetSec < srcMeta.durationSec - 3
          ) {
            preRollCommonTrimSec = Number(srcMeta.syncHealth.avStartOffsetSec.toFixed(4));
          }
        }
      }

      if (!skipCopyDueToLocalDesync) {
        const copyArgs = [
          ...buildInputPrefixArgs(inputSource, isRemoteUrl, false),
          '-t',
          String(durationSec + 10),
          '-map',
          '0:v:0',
          '-map',
          '0:a:0',
          '-dn',
          '-sn',
          '-map_chapters',
          '-1',
          '-map_metadata',
          '-1',
          '-c:v',
          'copy',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-avoid_negative_ts',
          'make_zero',
          '-shortest',
          outputPath,
        ];
        await execFileAsync('ffmpeg', copyArgs, {
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
          signal,
        });
        throwIfAborted(signal);
        const meta = await probeVideoMeta(outputPath);
        if (
          meta.durationSec >= Math.max(3, durationSec * 0.5) &&
          meta.durationSec <= durationSec + 2.5 &&
          meta.syncHealth.isSynced
        ) {
          return;
        }
        // Keep the downloaded file locally so Pass 2 trims its exact measured pre-roll without re-downloading.
        if (
          meta.syncHealth.avStartOffsetSec > 0.08 &&
          meta.syncHealth.avStartOffsetSec < meta.durationSec - 3
        ) {
          preRollCommonTrimSec = Number(meta.syncHealth.avStartOffsetSec.toFixed(4));
        }
        tempUnsyncedLocalPath = `${outputPath}.unsynced_${Date.now()}.mp4`;
        fs.renameSync(outputPath, tempUnsyncedLocalPath);
        reencodeInputSource = tempUnsyncedLocalPath;
        reencodeIsRemote = false;
      }
    } catch (err) {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      if (tempUnsyncedLocalPath && fs.existsSync(tempUnsyncedLocalPath)) {
        fs.unlinkSync(tempUnsyncedLocalPath);
        tempUnsyncedLocalPath = null;
      }
      if (isAbortLikeError(err, signal)) {
        throw new RenderCancelledError();
      }
    }
  }

  // Frame-accurate zero-anchored extraction:
  // - Guarantees video.start_time === 0.000s AND audio.start_time === 0.000s
  // - When a pre-trimmed source has silent video/audio pre-roll (e.g. SaveNow keyframe cut at -5s),
  //   trim=start=preRollCommonTrimSec + atrim=start=preRollCommonTrimSec cuts BOTH streams at the exact
  //   same shared PTS before resetting to 0.000s, preserving 0ms lip-to-voice AND subtitle-to-voice sync.
  const vfChain =
    preRollCommonTrimSec > 0
      ? `trim=start=${preRollCommonTrimSec},setpts=PTS-STARTPTS,scale=trunc(iw/2)*2:trunc(ih/2)*2`
      : 'scale=trunc(iw/2)*2:trunc(ih/2)*2,setpts=PTS-STARTPTS';
  const afChain =
    preRollCommonTrimSec > 0
      ? `atrim=start=${preRollCommonTrimSec},asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0`
      : 'asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0';

  try {
    const reencodeArgs = [
      ...buildInputPrefixArgs(reencodeInputSource, reencodeIsRemote, needSeekTrim),
      '-t',
      String(durationSec),
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-dn',
      '-sn',
      '-map_chapters',
      '-1',
      '-map_metadata',
      '-1',
      '-vf',
      vfChain,
      '-af',
      afChain,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '16',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-avoid_negative_ts',
      'make_zero',
      '-shortest',
      outputPath,
    ];
    await execFileAsync('ffmpeg', reencodeArgs, {
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
      signal,
    });
    throwIfAborted(signal);
    await probeVideoMeta(outputPath);
  } catch (err) {
    if (isAbortLikeError(err, signal)) {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      throw new RenderCancelledError();
    }
    throw err;
  } finally {
    if (tempUnsyncedLocalPath && fs.existsSync(tempUnsyncedLocalPath)) {
      fs.unlinkSync(tempUnsyncedLocalPath);
    }
  }
}

async function tryYtDlpDownloadSection(params: {
  sourceUrl: string;
  startSec: number;
  endSec: number;
  downloadedRawPath: string;
  cookiesFile?: string | null;
  signal?: AbortSignal;
}): Promise<void> {
  throwIfAborted(params.signal);
  const ytdlp = await ensureYtDlpBinary();
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--socket-timeout',
    '15',
    '--retries',
    '2',
    '--fragment-retries',
    '2',
    '--js-runtimes',
    'node',
    '--download-sections',
    `*${params.startSec}-${params.endSec}`,
    '--force-keyframes-at-cuts',
    '-f',
    'bv*[height<=2160][ext=mp4]+ba[ext=m4a]/bv*[height<=2160]+ba/b[ext=mp4]/b',
    '--merge-output-format',
    'mp4',
    '-o',
    params.downloadedRawPath,
  ];

  const cookiesFile = params.cookiesFile ?? getActiveCookiesFilePath();
  if (cookiesFile) {
    args.push('--cookies', cookiesFile);
  }
  const proxyUrl = process.env.YTDLP_PROXY_URL?.trim();
  if (proxyUrl) {
    args.push('--proxy', proxyUrl);
  }

  args.push(params.sourceUrl);

  await new Promise<void>((resolve, reject) => {
    if (params.signal?.aborted) {
      reject(new RenderCancelledError());
      return;
    }

    const child = spawn(ytdlp, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderrTail = '';
    let settled = false;
    let botCheckDetected = false;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      params.signal?.removeEventListener('abort', onAbort);
    };

    const killChild = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore
        }
      }, 300);
    };

    const onAbort = () => {
      killChild();
      if (!settled) {
        settled = true;
        cleanup();
        reject(new RenderCancelledError());
      }
    };

    const timeoutTimer = setTimeout(() => {
      killChild();
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error('yt-dlp timeout menunggu unduhan dari YouTube.'));
      }
    }, 75_000);

    params.signal?.addEventListener('abort', onAbort, { once: true });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
      if (!botCheckDetected && isBotBlockErrorText(stderrTail)) {
        botCheckDetected = true;
        killChild();
        if (!settled) {
          settled = true;
          cleanup();
          reject(
            new YoutubeBotCheckError(
              'YouTube memblokir unduhan langsung dari IP server cloud tanpa cookies. Unggah file .mp4, tempel link .mp4 langsung, atau pasang cookies.txt YouTube.'
            )
          );
        }
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(params.signal?.aborted ? new RenderCancelledError() : err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (params.signal?.aborted) {
        reject(new RenderCancelledError());
      } else if (code === 0) {
        resolve();
      } else if (isBotBlockErrorText(stderrTail)) {
        reject(
          new YoutubeBotCheckError(
            'YouTube memblokir unduhan langsung dari IP server cloud tanpa cookies. Unggah file .mp4, tempel link .mp4 langsung, atau pasang cookies.txt YouTube.'
          )
        );
      } else {
        reject(new Error(`yt-dlp gagal (kode ${code}): ${stderrTail.slice(-260)}`));
      }
    });
  });

  if (!fs.existsSync(params.downloadedRawPath)) {
    throw new Error('File potongan video dari YouTube tidak ditemukan setelah unduhan.');
  }
}

/**
 * Downloads a live chunked HTTP MP4 stream (such as SaveNow v2 pre-trimmed 1080p/4K)
 * directly to a local temp file with instant abort support and no Range probe.
 */
async function downloadChunkedStreamToFile(params: {
  streamUrl: string;
  destPath: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<void> {
  throwIfAborted(params.signal);
  let res: Response;
  try {
    res = await fetch(params.streamUrl, {
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_UA,
        ...(params.headers ?? {}),
      },
      signal: params.signal,
    });
  } catch (err) {
    if (isAbortLikeError(err, params.signal)) {
      throw new RenderCancelledError();
    }
    throw err;
  }
  if (!res.ok || !res.body) {
    throw new Error(`Unduhan stream HD gagal (HTTP ${res.status}).`);
  }

  const out = fs.createWriteStream(params.destPath);
  const reader = res.body.getReader();
  try {
    while (true) {
      if (params.signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new RenderCancelledError();
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        const canContinue = out.write(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        if (!canContinue) {
          await new Promise<void>((resolve) => out.once('drain', resolve));
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.once('error', reject);
      out.end(() => resolve());
    });
  } catch (err) {
    out.destroy();
    if (fs.existsSync(params.destPath)) fs.unlinkSync(params.destPath);
    if (isAbortLikeError(err, params.signal)) {
      throw new RenderCancelledError();
    }
    throw err;
  }
}

async function acquireRawClipSegment(params: {
  episode: PodcastEpisode;
  clip: PodcastClip;
  rawSegmentPath: string;
  preferredQuality: CanonicalRenderQuality;
  signal?: AbortSignal;
  onProgress?: (stage: string, progress: number) => void;
}): Promise<ClipRenderSource> {
  const { episode, clip, rawSegmentPath, preferredQuality, signal, onProgress } = params;
  const durationSec = Math.max(5, clip.endSec - clip.startSec);
  const ytdlpTempPath = path.join(TMP_DIR, `ytdl_${clip.id}_${Date.now()}.mp4`);
  const chunkedTempPath = path.join(TMP_DIR, `chunked_${clip.id}_${Date.now()}.mp4`);

  try {
    throwIfAborted(signal);
    // 1. Uploaded / cached local source video
    const uploadedPath = getUploadedVideoPath(episode.id);
    if (uploadedPath) {
      onProgress?.('Memotong segmen dari file video lokal...', 16);
      await extractRawTrimmedSegment({
        inputSource: uploadedPath,
        isRemoteUrl: false,
        startSec: clip.startSec,
        durationSec,
        needSeekTrim: true,
        outputPath: rawSegmentPath,
        signal,
      });
      return 'uploaded_video';
    }

    // 1B. Direct MP4 / media URL provided by user (bypasses YouTube entirely)
    if (episode.directVideoUrl?.trim()) {
      onProgress?.('Mengambil potongan langsung dari URL video sumber...', 16);
      await extractRawTrimmedSegment({
        inputSource: episode.directVideoUrl.trim(),
        isRemoteUrl: true,
        startSec: clip.startSec,
        durationSec,
        needSeekTrim: true,
        outputPath: rawSegmentPath,
        signal,
      });
      return 'direct_video_url';
    }

    // 2. Saved/Env valid cookies.txt with yt-dlp (direct native 1080p/4K)
    const activeCookiesFile = getActiveCookiesFilePath();
    if (activeCookiesFile) {
      try {
        throwIfAborted(signal);
        onProgress?.('Mengunduh video HD asli via cookies YouTube...', 16);
        await tryYtDlpDownloadSection({
          sourceUrl: episode.sourceUrl,
          startSec: clip.startSec,
          endSec: clip.endSec,
          downloadedRawPath: ytdlpTempPath,
          cookiesFile: activeCookiesFile,
          signal,
        });
        await extractRawTrimmedSegment({
          inputSource: ytdlpTempPath,
          isRemoteUrl: false,
          startSec: clip.startSec,
          durationSec,
          needSeekTrim: false,
          outputPath: rawSegmentPath,
          signal,
        });
        return 'youtube_stream';
      } catch (err) {
        if (isAbortLikeError(err, signal)) throw new RenderCancelledError();
        // Fall through to parallel third-party HD downloader
      }
    }

    // 3. Single-pass parallel HD race (SaveNow + AMP4 + NoTube, capped ~25s worst-case)
    let thirdPartyErr: unknown = null;
    throwIfAborted(signal);
    onProgress?.('Mengunduh potongan video HD (SaveNow / AMP4 / NoTube)...', 15);
    try {
      const stream = await resolveThirdPartyMp4Stream({
        sourceUrl: episode.sourceUrl,
        videoId: episode.videoId,
        startSec: clip.startSec,
        endSec: clip.endSec,
        preferredQuality,
        signal,
      });
      throwIfAborted(signal);

      onProgress?.(`Menyiapkan stream ${stream.qualityTier ?? 'HD'} (${stream.provider})...`, 24);
      if (stream.isDirectChunkedDownload || stream.isPreTrimmed) {
        await downloadChunkedStreamToFile({
          streamUrl: stream.streamUrl,
          destPath: chunkedTempPath,
          headers: stream.headers,
          signal,
        });
        await extractRawTrimmedSegment({
          inputSource: chunkedTempPath,
          isRemoteUrl: false,
          startSec: clip.startSec,
          durationSec,
          needSeekTrim: !stream.isPreTrimmed,
          outputPath: rawSegmentPath,
          signal,
        });
        return 'third_party_downloader';
      }

      await extractRawTrimmedSegment({
        inputSource: stream.streamUrl,
        isRemoteUrl: true,
        extraHeaders: stream.headers,
        startSec: clip.startSec,
        durationSec,
        needSeekTrim: !stream.isPreTrimmed,
        outputPath: rawSegmentPath,
        signal,
      });
      return 'third_party_downloader';
    } catch (err) {
      if (isAbortLikeError(err, signal)) {
        if (fs.existsSync(chunkedTempPath)) fs.unlinkSync(chunkedTempPath);
        if (fs.existsSync(rawSegmentPath)) fs.unlinkSync(rawSegmentPath);
        throw new RenderCancelledError();
      }
      thirdPartyErr = err;
      invalidateEpisodeStreamCache(episode.videoId || episode.sourceUrl);
      if (fs.existsSync(chunkedTempPath)) fs.unlinkSync(chunkedTempPath);
      if (fs.existsSync(rawSegmentPath)) fs.unlinkSync(rawSegmentPath);
    }

    // 4. Final fail-fast yt-dlp attempt (only if cookies path wasn't already tried)
    const thirdMsg =
      thirdPartyErr instanceof Error ? thirdPartyErr.message : String(thirdPartyErr ?? '');
    if (activeCookiesFile) {
      throw new YoutubeBotCheckError(
        `Pengunduh otomatis gagal (${thirdMsg}) dan unduhan yt-dlp dengan cookies juga ditolak. Unggah file .mp4 atau perbarui cookies.txt YouTube.`
      );
    }

    throwIfAborted(signal);
    onProgress?.('Mencoba jalur unduhan langsung YouTube...', 22);
    try {
      await tryYtDlpDownloadSection({
        sourceUrl: episode.sourceUrl,
        startSec: clip.startSec,
        endSec: clip.endSec,
        downloadedRawPath: ytdlpTempPath,
        cookiesFile: null,
        signal,
      });
      await extractRawTrimmedSegment({
        inputSource: ytdlpTempPath,
        isRemoteUrl: false,
        startSec: clip.startSec,
        durationSec,
        needSeekTrim: false,
        outputPath: rawSegmentPath,
        signal,
      });
      return 'youtube_stream';
    } catch (ytErr) {
      if (isAbortLikeError(ytErr, signal)) throw new RenderCancelledError();
      if (ytErr instanceof YoutubeBotCheckError) {
        throw new YoutubeBotCheckError(
          `Pengunduh otomatis gagal (${thirdMsg}) dan YouTube memblokir IP server cloud tanpa cookies. Unggah file .mp4, tempel link .mp4 langsung, atau pasang cookies.txt YouTube.`
        );
      }
      const stderr = (ytErr as { stderr?: string; message?: string })?.stderr ?? String(ytErr);
      if (isBotBlockErrorText(stderr)) {
        throw new YoutubeBotCheckError(
          `Pengunduh otomatis gagal (${thirdMsg}) dan YouTube memblokir unduhan langsung tanpa cookies. Unggah file .mp4, tempel link .mp4 langsung, atau pasang cookies.txt YouTube.`
        );
      }
      throw new Error(
        `Gagal memotong video klip secara otomatis: ${thirdMsg || stderr.slice(0, 180)}`
      );
    }
  } finally {
    if (fs.existsSync(ytdlpTempPath)) fs.unlinkSync(ytdlpTempPath);
    if (fs.existsSync(chunkedTempPath)) fs.unlinkSync(chunkedTempPath);
  }
}

function cleanupOldTempSegments() {
  try {
    const cutoff = Date.now() - 45 * 60 * 1000;
    for (const entry of fs.readdirSync(TMP_DIR)) {
      if (
        !entry.startsWith('seg_') &&
        !entry.startsWith('intel_') &&
        !entry.startsWith('render_') &&
        !entry.startsWith('ytdl_') &&
        !entry.startsWith('chunked_') &&
        !entry.startsWith('work_')
      ) {
        continue;
      }
      const full = path.join(TMP_DIR, entry);
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) {
        if (st.isDirectory()) {
          fs.rmSync(full, { recursive: true, force: true });
        } else {
          fs.unlinkSync(full);
        }
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Studio restoration & upscaling filter chain:
 * - For low-res (<720p) fallback sources: applies strong H.264 deblocking + hqdn3d mosquito-noise
 *   removal BEFORE scaling (fast on tiny cropped pixels, eliminates square compression blocks),
 *   high-precision Lanczos resampling, and AMD FidelityFX Contrast Adaptive Sharpening (`cas`)
 *   to restore crisp facial edges without ringing/halos.
 * - For native HD/4K (>=720p) sources: preserves native crispness with accurate Lanczos + subtle CAS.
 */
function buildFastClarityChain(
  sourceH: number,
  targetW: number,
  targetH: number,
  _quality: CanonicalRenderQuality
): string {
  if (sourceH < 700) {
    return [
      'deblock=filter=strong:block=8:alpha=0.12:beta=0.08',
      'hqdn3d=1.5:1.5:3:3',
      `scale=${targetW}:${targetH}:flags=lanczos+accurate_rnd+full_chroma_int`,
      'cas=strength=0.45',
      'eq=contrast=1.04:saturation=1.06',
    ].join(',');
  }
  return [
    `scale=${targetW}:${targetH}:flags=lanczos+accurate_rnd+full_chroma_int`,
    'cas=strength=0.28',
    'eq=contrast=1.02:saturation=1.03',
  ].join(',');
}

function buildStudioFilterComplex(params: {
  layout: CanonicalStudioLayout;
  quality: CanonicalRenderQuality;
  sourceW: number;
  sourceH: number;
  assPath: string;
  intelligence: ClipIntelligenceResult;
}): string {
  const { layout, quality, sourceW, sourceH, assPath, intelligence } = params;
  const assEscaped = escapeFfmpegFilterPath(assPath);
  const { outW, outH } = getTargetCanvasDimensions(layout, quality);
  const avgZoom =
    intelligence.keyframes.reduce((acc, k) => acc + k.zoomScale, 0) /
    Math.max(1, intelligence.keyframes.length);

  if (layout === 'full_16_9_focus') {
    const safeZoom = sourceH >= 720 ? Math.max(1.14, Math.min(1.36, avgZoom)) : 1.1;
    const { cropW, cropH } = computeCropWindow(sourceW, sourceH, 16, 9, safeZoom);
    const xExpr = buildSmoothCropAxisExpression({
      keyframes: intelligence.keyframes,
      axis: 'x',
      sourceSize: sourceW,
      cropSize: cropW,
    });
    const yExpr = buildSmoothCropAxisExpression({
      keyframes: intelligence.keyframes,
      axis: 'y',
      sourceSize: sourceH,
      cropSize: cropH,
    });

    const topScrimH = Math.round(outH * 0.13);
    const botScrimH = Math.round(outH * 0.21);
    const clarity = buildFastClarityChain(sourceH, outW, outH, quality);

    return [
      `[0:v]setpts=PTS-STARTPTS,crop=w=${cropW}:h=${cropH}:x='${xExpr}':y='${yExpr}',${clarity},drawbox=x=0:y=0:w=${outW}:h=${topScrimH}:color=0x000000@0.26:t=fill,drawbox=x=0:y=${outH - botScrimH}:w=${outW}:h=${botScrimH}:color=0x000000@0.30:t=fill[comp]`,
      `[comp]ass='${assEscaped}'[out]`,
    ].join(';');
  }

  if (layout === 'shorts_studio_focus') {
    const safeZoom = sourceH >= 720 ? Math.max(1.06, Math.min(1.26, avgZoom * 0.85)) : 1.02;
    const { cropW, cropH } = computeCropWindow(sourceW, sourceH, 8, 7, safeZoom);
    const xExpr = buildSmoothCropAxisExpression({
      keyframes: intelligence.keyframes,
      axis: 'x',
      sourceSize: sourceW,
      cropSize: cropW,
    });
    const yExpr = buildSmoothCropAxisExpression({
      keyframes: intelligence.keyframes,
      axis: 'y',
      sourceSize: sourceH,
      cropSize: cropH,
    });

    const fgW = Math.round(outW * 0.94);
    const fgH = Math.round((fgW * 7) / 8);
    const fgY = Math.round(outH * 0.215);
    const fgClarity = buildFastClarityChain(sourceH, fgW, fgH, quality);

    // Fast low-res blur trick: blur at 180x320 then upscale cleanly (20x faster than blurring 4K!)
    return [
      '[0:v]setpts=PTS-STARTPTS,split=2[bgsrc][fgsrc]',
      `[bgsrc]scale=180:320:force_original_aspect_ratio=increase:flags=fast_bilinear,crop=180:320,boxblur=6:1,eq=brightness=-0.20:contrast=1.12:saturation=1.30,scale=${outW}:${outH}:flags=fast_bilinear[bg]`,
      `[fgsrc]crop=w=${cropW}:h=${cropH}:x='${xExpr}':y='${yExpr}',${fgClarity}[fg]`,
      `[bg][fg]overlay=(W-w)/2:${fgY}[comp]`,
      `[comp]ass='${assEscaped}'[out]`,
    ].join(';');
  }

  // shorts_full_bleed (DEFAULT): Edge-to-edge Full Frame 9:16 (1080x1920 or 2160x3840 4K)
  // Smooth active-speaker auto-focus on BOTH X and Y, zero red lines, 6x faster encoding
  const verticalZoom = sourceH >= 720 ? Math.max(1.0, Math.min(1.15, avgZoom * 0.84)) : 1.0;
  const { cropW, cropH } = computeCropWindow(sourceW, sourceH, 9, 16, verticalZoom);
  const xExpr = buildSmoothCropAxisExpression({
    keyframes: intelligence.keyframes,
    axis: 'x',
    sourceSize: sourceW,
    cropSize: cropW,
  });
  const yExpr = buildSmoothCropAxisExpression({
    keyframes: intelligence.keyframes,
    axis: 'y',
    sourceSize: sourceH,
    cropSize: cropH,
  });

  const clarity = buildFastClarityChain(sourceH, outW, outH, quality);
  const topBand = Math.round(outH * 0.14);
  const botBand = Math.round(outH * 0.20);

  return [
    `[0:v]setpts=PTS-STARTPTS,crop=w=${cropW}:h=${cropH}:x='${xExpr}':y='${yExpr}',${clarity},drawbox=x=0:y=0:w=${outW}:h=${topBand}:color=0x000000@0.24:t=fill,drawbox=x=0:y=${outH - botBand}:w=${outW}:h=${botBand}:color=0x000000@0.28:t=fill[comp]`,
    `[comp]ass='${assEscaped}'[out]`,
  ].join(';');
}

export async function renderClipMp4(params: {
  episode: PodcastEpisode;
  clip: PodcastClip;
  layout?: ClipRenderLayout;
  quality?: ClipRenderQuality;
  enableEmotionEffects?: boolean;
  signal?: AbortSignal;
  onProgress?: (stage: string, progress: number) => void;
}): Promise<{
  outputPath: string;
  sizeBytes: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  sourceUsed: ClipRenderSource;
  layout: CanonicalStudioLayout;
  quality: CanonicalRenderQuality;
  emotionEffectsEnabled: boolean;
  intelligence: ClipIntelligenceResult;
}> {
  ensureDirs();
  cleanupOldTempSegments();

  const { episode, clip } = params;
  const layout = normalizeRenderLayout(params.layout);
  const quality = normalizeRenderQuality(params.quality);
  const enableEmotionEffects = params.enableEmotionEffects !== false;
  const outputPath = path.join(RENDERS_DIR, `${clip.id}.mp4`);
  const tmpRenderPath = path.join(TMP_DIR, `render_${clip.id}_${Date.now()}.mp4`);
  const assPath = path.join(TMP_DIR, `${clip.id}_${Date.now()}.ass`);
  const workDir = path.join(TMP_DIR, `work_${clip.id}_${Date.now()}`);
  const cachedRawSegmentPath = path.join(
    TMP_DIR,
    `seg_hd_${clip.id}_${clip.startSec}_${clip.endSec}.mp4`
  );
  const intelCachePath = path.join(
    TMP_DIR,
    `intel_${clip.id}_${clip.startSec}_${clip.endSec}.json`
  );

  fs.mkdirSync(workDir, { recursive: true });

  try {
    let sourceUsed: ClipRenderSource = 'third_party_downloader';
    let rawReady = false;

    if (fs.existsSync(cachedRawSegmentPath)) {
      try {
        const cachedMeta = await probeVideoMeta(cachedRawSegmentPath);
        // Always discard legacy <720p OR A/V-desynced cached segments (e.g. old -c:v copy GOP shift)
        if (cachedMeta.height < 720 || !cachedMeta.syncHealth.isSynced) {
          fs.unlinkSync(cachedRawSegmentPath);
        } else {
          rawReady = true;
          sourceUsed = getUploadedVideoPath(episode.id)
            ? 'uploaded_video'
            : episode.directVideoUrl?.trim()
              ? 'direct_video_url'
              : hasYoutubeCookies() && cachedMeta.height >= 720
                ? 'youtube_stream'
                : 'third_party_downloader';
        }
      } catch {
        fs.unlinkSync(cachedRawSegmentPath);
      }
    }

    if (!rawReady) {
      throwIfAborted(params.signal);
      params.onProgress?.(
        quality === '4k'
          ? 'Mengunduh potongan video asli 4K / 1080p Full HD jernih...'
          : 'Mengunduh potongan video asli 1080p Full HD jernih...',
        12
      );
      sourceUsed = await acquireRawClipSegment({
        episode,
        clip,
        rawSegmentPath: cachedRawSegmentPath,
        preferredQuality: quality,
        signal: params.signal,
        onProgress: params.onProgress,
      });
    } else {
      params.onProgress?.('Memakai cache potongan video HD asli...', 28);
    }

    throwIfAborted(params.signal);
    const rawMeta = await probeVideoMeta(cachedRawSegmentPath);

    // Run parallel verbatim transcription + emotion detection + cut-aligned faceBox speaker tracking
    params.onProgress?.(
      fs.existsSync(intelCachePath)
        ? 'Memuat analisis subtitle, auto-fokus pembicara & momen emosi AI...'
        : 'Mentranskrip audio, melacak wajah pembicara & momen emosi AI...',
      38
    );
    const intelligence = await analyzeTrimmedClipIntelligence({
      rawVideoPath: cachedRawSegmentPath,
      durationSec: rawMeta.durationSec,
      workDir,
      cachePath: intelCachePath,
      episode,
      clip,
      signal: params.signal,
    });
    throwIfAborted(params.signal);

    const assContent = generateStudioAssScript({
      layout,
      title: intelligence.autoTitle,
      channelName: episode.channelName,
      hookCaption: intelligence.autoCaption,
      cues: intelligence.cues,
      durationSec: rawMeta.durationSec,
      emotionMoments: intelligence.emotionMoments,
      enableEmotionEffects,
    });
    fs.writeFileSync(assPath, assContent, 'utf-8');

    const videoFilterComplex = buildStudioFilterComplex({
      layout,
      quality,
      sourceW: rawMeta.width,
      sourceH: rawMeta.height,
      assPath,
      intelligence,
    });

    const hasAudioStream = Boolean(rawMeta.audioCodec);
    const emotionAudioGraph =
      hasAudioStream && enableEmotionEffects && intelligence.emotionMoments.length > 0
        ? buildEmotionAudioFilterGraph(intelligence.emotionMoments)
        : null;

    const filterComplex = emotionAudioGraph
      ? [videoFilterComplex, ...emotionAudioGraph.filterChains].join(';')
      : videoFilterComplex;

    const qualityLabel = quality === '4k' ? '4K Ultra HD' : '1080p Full HD';
    const layoutLabel =
      layout === 'full_16_9_focus'
        ? 'Full 16:9'
        : layout === 'shorts_studio_focus'
          ? 'Shorts 9:16 Studio'
          : 'Full Frame 9:16';
    params.onProgress?.(
      `Merender ${layoutLabel} ${qualityLabel} (0%)...`,
      56
    );

    // High-bitrate YouTube Shorts mastering (CRF 18 High Profile):
    // Both <video> streaming AND browser downloads use 4 MiB chunked HTTP Range requests,
    // so large crisp master files (10 Mbps 1080p / 22 Mbps 4K) stream & download cleanly without any 32MB cap!
    const encodePreset = CPU_COUNT <= 2 || quality === '4k' ? 'ultrafast' : 'veryfast';
    const encodeCrf = '18';
    const encodeMaxrate = quality === '4k' ? '22000k' : '10000k';
    const encodeBufsize = quality === '4k' ? '44000k' : '20000k';
    const encodeLevel = quality === '4k' ? '5.1' : '4.2';
    const audioMapTarget = !hasAudioStream
      ? '0:a?'
      : emotionAudioGraph
        ? emotionAudioGraph.outputLabel
        : '0:a';
    const audioArgs = !hasAudioStream
      ? []
      : !emotionAudioGraph && rawMeta.audioCodec === 'aac' && rawMeta.syncHealth.isSynced
        ? ['-c:a', 'copy']
        : !emotionAudioGraph
          ? ['-af', 'asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0', '-c:a', 'aac', '-b:a', '192k']
          : ['-c:a', 'aac', '-b:a', '192k'];

    await runFfmpegWithProgress({
      durationSec: rawMeta.durationSec,
      signal: params.signal,
      onPercent: (ratio) => {
        const pct = Math.min(99, Math.round(ratio * 100));
        const overall = Math.min(95, 56 + Math.round(ratio * 39));
        params.onProgress?.(`Merender ${layoutLabel} ${qualityLabel} (${pct}%)...`, overall);
      },
      args: [
        '-y',
        '-threads',
        FFMPEG_THREADS,
        '-i',
        cachedRawSegmentPath,
        '-filter_complex',
        filterComplex,
        '-map',
        '[out]',
        '-map',
        audioMapTarget,
        '-r',
        '30',
        '-c:v',
        'libx264',
        '-preset',
        encodePreset,
        '-crf',
        encodeCrf,
        '-maxrate',
        encodeMaxrate,
        '-bufsize',
        encodeBufsize,
        '-profile:v',
        'high',
        '-level:v',
        encodeLevel,
        '-pix_fmt',
        'yuv420p',
        ...audioArgs,
        '-movflags',
        '+faststart',
        tmpRenderPath,
      ],
    });

    throwIfAborted(params.signal);
    params.onProgress?.('Memverifikasi video & audio hasil akhir...', 97);
    const finalMeta = await probeVideoMeta(tmpRenderPath);
    throwIfAborted(params.signal);
    fs.renameSync(tmpRenderPath, outputPath);

    return {
      outputPath,
      sizeBytes: finalMeta.sizeBytes,
      width: finalMeta.width,
      height: finalMeta.height,
      sourceWidth: rawMeta.width,
      sourceHeight: rawMeta.height,
      sourceUsed,
      layout,
      quality,
      emotionEffectsEnabled: enableEmotionEffects,
      intelligence,
    };
  } finally {
    if (fs.existsSync(assPath)) fs.unlinkSync(assPath);
    if (fs.existsSync(tmpRenderPath)) fs.unlinkSync(tmpRenderPath);
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
  }
}
