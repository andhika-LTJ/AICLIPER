import { execFile, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type {
  BalancedRenderProfile,
  CameraTrackingSettings,
  ClipOverlayStyle,
  ClipRenderLayout,
  ClipRenderQuality,
  IntroTemplateDefinition,
  MultiSpeakerLayoutMode,
  PodcastClip,
  PodcastEpisode,
} from '../src/types/clipper.ts';
import {
  computeIntroAnchorLayout,
  hexToFfmpegColor,
  normalizeClipOverlayStyle,
} from '../src/utils/clipOverlayStyle.ts';
import {
  analyzeTrimmedClipIntelligence,
  type ClipIntelligenceResult,
} from './clipIntelligence.ts';
import {
  compileIntroTemplateForFfmpeg,
  normalizeIntroTemplateDefinition,
  type CompiledIntroRenderPlan,
} from './services/introRenderCompiler.ts';
import {
  computeSourceFingerprint,
  resolveBalancedRenderProfile,
  type BalancedRenderProfileSpec,
} from './services/renderFingerprint.ts';
import { buildEmotionAudioFilterGraph } from './emotionEffects.ts';
import {
  buildSmoothCropAxisExpression,
  computeCropWindow,
  generateStudioAssScript,
  getTargetCanvasDimensions,
  normalizeRenderLayout,
  normalizeRenderQuality,
  resolveNonUpscaledTargetDimensions,
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
  assessSegmentDurationHealth,
  assessStreamSyncHealth,
  type StreamSyncAssessment,
} from './audioSyncMath.ts';
import {
  ensureFfmpegPath,
  ensureFfprobePath,
  ensureYtDlpFfmpegLocation,
  isMissingBinaryError,
  selectYtDlpReleaseAsset,
} from './ffmpegBinaries.ts';
import { ensureAssFontEnvironment } from './assFontEnv.ts';
import {
  buildIntroAudioExpr,
  computeExactIntroTiming,
  INTRO_FPS,
  normalizeAiClipIntro,
} from './videoIntroMath.ts';
import { assertSafeResourceId, resolveConfinedPath } from './security.ts';

const execFileAsync = promisify(execFile);

const DATA_DIR = path.resolve(process.cwd(), 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const RENDERS_DIR = path.join(DATA_DIR, 'renders');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const COOKIES_PATH = path.join(DATA_DIR, 'youtube-cookies.txt');
const ENV_COOKIES_PATH = path.join(DATA_DIR, 'youtube-env-cookies.txt');
const YTDLP_ASSET = selectYtDlpReleaseAsset();
const YTDLP_BIN = path.join(os.tmpdir(), YTDLP_ASSET.localFileName);

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
  const safeId = assertSafeResourceId(episodeId, 'Episode ID');
  const candidates = ['.mp4', '.webm', '.mov', '.mkv'].map((ext) =>
    resolveConfinedPath(UPLOADS_DIR, `${safeId}${ext}`)
  );
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export function getEpisodeSourceFingerprintTag(
  episode: Pick<PodcastEpisode, 'id' | 'directVideoUrl'>
): string {
  const uploaded = getUploadedVideoPath(episode.id);
  if (uploaded) {
    try {
      const st = fs.statSync(uploaded);
      return `uploaded:${episode.id}:${st.size}:${Math.floor(st.mtimeMs)}`;
    } catch {
      return `uploaded:${episode.id}`;
    }
  }
  const direct = episode.directVideoUrl?.trim();
  if (direct) {
    return `direct:${direct}`;
  }
  return '';
}

export function getUploadTargetPath(episodeId: string): string {
  ensureDirs();
  const safeId = assertSafeResourceId(episodeId, 'Episode ID');
  return resolveConfinedPath(UPLOADS_DIR, `${safeId}.mp4`);
}

export function getRenderedClipPath(clipId: string): string | null {
  ensureDirs();
  const safeId = assertSafeResourceId(clipId, 'Clip ID');
  const target = resolveConfinedPath(RENDERS_DIR, `${safeId}.mp4`);
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
      try {
        const st = fs.statSync(YTDLP_BIN);
        if (st.size > 500_000) {
          if (process.platform !== 'win32') {
            fs.chmodSync(YTDLP_BIN, 0o755);
          }
          resolvedYtDlpPath = YTDLP_BIN;
          return YTDLP_BIN;
        }
        fs.unlinkSync(YTDLP_BIN);
      } catch {
        // Re-download corrupted binary
      }
    }

    const res = await fetch(
      `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET.assetName}`,
      { signal: AbortSignal.timeout(25_000) }
    );
    if (!res.ok) {
      throw new Error('Gagal menyiapkan utilitas pengunduh video yt-dlp.');
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < 500_000) {
      throw new Error('File pengunduh yt-dlp tidak lengkap saat diunduh.');
    }
    const tmpBin = `${YTDLP_BIN}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpBin, buf, { mode: 0o755 });
    fs.renameSync(tmpBin, YTDLP_BIN);
    if (process.platform !== 'win32') {
      fs.chmodSync(YTDLP_BIN, 0o755);
    }
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

export class RenderTimeoutError extends Error {
  code = 'WORKER_TIMEOUT' as const;
  constructor(message = 'Worker render melewati batas waktu proses FFmpeg.') {
    super(message);
    this.name = 'RenderTimeoutError';
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

  const ffprobeBin = await ensureFfprobePath();
  const { stdout } = await execFileAsync(
    ffprobeBin,
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
async function runFfmpegWithProgress(params: {
  args: string[];
  durationSec: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  onPercent?: (ratio01: number) => void;
}): Promise<void> {
  const { args, durationSec, env, signal, onPercent } = params;
  const configuredTimeoutMs =
    typeof params.timeoutMs === 'number' && params.timeoutMs > 0
      ? params.timeoutMs
      : Number(process.env.RENDER_JOB_TIMEOUT_MS) > 0
        ? Number(process.env.RENDER_JOB_TIMEOUT_MS)
        : 0;
  throwIfAborted(signal);
  const ffmpegBin = await ensureFfmpegPath();

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RenderCancelledError());
      return;
    }

    const child = spawn(ffmpegBin, ['-progress', 'pipe:1', '-nostats', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    });

    let stderrTail = '';
    let stdoutBuf = '';
    let lastReportedPct = -1;
    let settled = false;
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let executionTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
      if (executionTimer) {
        clearTimeout(executionTimer);
        executionTimer = null;
      }
    };

    const killChildSafely = () => {
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
    };

    const onAbort = () => {
      killChildSafely();
      if (!settled) {
        settled = true;
        cleanup();
        reject(new RenderCancelledError());
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    if (configuredTimeoutMs > 0) {
      executionTimer = setTimeout(() => {
        timedOut = true;
        killChildSafely();
        if (!settled) {
          settled = true;
          cleanup();
          reject(
            new RenderTimeoutError(
              `Worker render FFmpeg melebihi batas waktu (${Math.ceil(configuredTimeoutMs / 1000)} detik).`
            )
          );
        }
      }, configuredTimeoutMs);
    }

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
      if (timedOut) {
        reject(new RenderTimeoutError());
      } else if (signal?.aborted) {
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
class TruncatedSegmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TruncatedSegmentError';
  }
}

async function extractRawTrimmedSegment(params: {
  inputSource: string;
  isRemoteUrl: boolean;
  extraHeaders?: Record<string, string>;
  startSec: number;
  durationSec: number;
  episodeDurationSec?: number;
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
    episodeDurationSec,
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
        const ffmpegBin = await ensureFfmpegPath();
        await execFileAsync(ffmpegBin, copyArgs, {
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
          signal,
        });
        throwIfAborted(signal);
        const meta = await probeVideoMeta(outputPath);
        const durationCheck = assessSegmentDurationHealth({
          requestedDurationSec: durationSec,
          actualDurationSec: meta.durationSec,
          startSec,
          episodeDurationSec,
        });
        if (!durationCheck.isComplete) {
          throw new TruncatedSegmentError(
            durationCheck.reason ||
              `Potongan video terpotong pendek (${meta.durationSec.toFixed(1)}d dari ${durationSec}d).`
          );
        }
        if (
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
      if (err instanceof TruncatedSegmentError) {
        throw err;
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
    const ffmpegBin = await ensureFfmpegPath();
    await execFileAsync(ffmpegBin, reencodeArgs, {
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
      signal,
    });
    throwIfAborted(signal);
    const finalRawMeta = await probeVideoMeta(outputPath);
    const finalDurationCheck = assessSegmentDurationHealth({
      requestedDurationSec: durationSec,
      actualDurationSec: finalRawMeta.durationSec,
      startSec,
      episodeDurationSec,
    });
    if (!finalDurationCheck.isComplete) {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      throw new TruncatedSegmentError(
        finalDurationCheck.reason ||
          `Potongan video terpotong pendek (${finalRawMeta.durationSec.toFixed(1)}d dari ${durationSec}d).`
      );
    }
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
  const [ytdlp, ffmpegLocation] = await Promise.all([
    ensureYtDlpBinary(),
    ensureYtDlpFfmpegLocation(),
  ]);
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--ffmpeg-location',
    ffmpegLocation,
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
 * directly to a local temp file with connect/header timeout, chunk inactivity watchdog,
 * total download ceiling, and instant abort support so stalled providers fail fast cleanly.
 */
export async function downloadChunkedStreamToFile(params: {
  streamUrl: string;
  destPath: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  headerTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  totalTimeoutMs?: number;
  onBytesProgress?: (downloadedBytes: number, totalBytes: number | null) => void;
}): Promise<{ bytesWritten: number }> {
  throwIfAborted(params.signal);

  const headerTimeoutMs = Math.max(150, params.headerTimeoutMs ?? 20_000);
  const inactivityTimeoutMs = Math.max(150, params.inactivityTimeoutMs ?? 18_000);
  const totalTimeoutMs = Math.max(headerTimeoutMs, params.totalTimeoutMs ?? 120_000);

  const requestController = new AbortController();
  let failureReason: Error | null = null;
  const getFailureReason = (): Error | null => failureReason;

  const onParentAbort = () => {
    failureReason = new RenderCancelledError();
    requestController.abort(failureReason);
  };
  params.signal?.addEventListener('abort', onParentAbort, { once: true });

  const headerTimer = setTimeout(() => {
    failureReason = new Error('Timeout menunggu respon awal stream video HD dari provider.');
    requestController.abort(failureReason);
  }, headerTimeoutMs);

  const totalTimer = setTimeout(() => {
    failureReason = new Error('Unduhan stream video HD melebihi batas waktu total.');
    requestController.abort(failureReason);
  }, totalTimeoutMs);

  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  const resetInactivityTimer = (reader?: ReadableStreamDefaultReader<Uint8Array>) => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      failureReason = new Error('Koneksi unduhan stream video HD terhenti (inactivity stall).');
      requestController.abort(failureReason);
      void reader?.cancel(failureReason).catch(() => {});
    }, inactivityTimeoutMs);
  };

  const cleanupTimers = () => {
    clearTimeout(headerTimer);
    clearTimeout(totalTimer);
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
    params.signal?.removeEventListener('abort', onParentAbort);
  };

  let res: Response;
  try {
    res = await fetch(params.streamUrl, {
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_UA,
        ...(params.headers ?? {}),
      },
      signal: requestController.signal,
    });
    clearTimeout(headerTimer);
  } catch (err) {
    cleanupTimers();
    const recordedFailure = getFailureReason();
    if (isAbortLikeError(err, params.signal) || recordedFailure instanceof RenderCancelledError) {
      throw new RenderCancelledError();
    }
    if (recordedFailure) {
      throw recordedFailure;
    }
    throw err;
  }

  if (!res.ok || !res.body) {
    cleanupTimers();
    throw new Error(`Unduhan stream HD gagal (HTTP ${res.status}).`);
  }

  const contentLengthHeader = Number(res.headers.get('content-length') ?? 0);
  const totalBytes = Number.isFinite(contentLengthHeader) && contentLengthHeader > 0
    ? contentLengthHeader
    : null;

  const out = fs.createWriteStream(params.destPath);
  const reader = res.body.getReader();
  let bytesWritten = 0;

  try {
    resetInactivityTimer(reader);
    while (true) {
      if (params.signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new RenderCancelledError();
      }
      if (failureReason) {
        await reader.cancel().catch(() => {});
        throw failureReason;
      }

      const { done, value } = await reader.read();
      if (done) break;

      resetInactivityTimer(reader);
      if (value && value.byteLength > 0) {
        bytesWritten += value.byteLength;
        params.onBytesProgress?.(bytesWritten, totalBytes);
        const canContinue = out.write(
          Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        );
        if (!canContinue) {
          await new Promise<void>((resolve, reject) => {
            const onDrain = () => {
              out.off('error', onErr);
              resolve();
            };
            const onErr = (e: Error) => {
              out.off('drain', onDrain);
              reject(e);
            };
            out.once('drain', onDrain);
            out.once('error', onErr);
          });
        }
      }
    }

    await new Promise<void>((resolve, reject) => {
      out.once('error', reject);
      out.end(() => resolve());
    });
    return { bytesWritten };
  } catch (err) {
    out.destroy();
    if (fs.existsSync(params.destPath)) {
      try {
        fs.unlinkSync(params.destPath);
      } catch {
        // Ignore cleanup failure
      }
    }
    const recordedFailure = getFailureReason();
    if (isAbortLikeError(err, params.signal) || recordedFailure instanceof RenderCancelledError) {
      throw new RenderCancelledError();
    }
    if (recordedFailure) {
      throw recordedFailure;
    }
    throw err;
  } finally {
    cleanupTimers();
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
        if (isMissingBinaryError(err)) throw err;
        // Fall through to parallel third-party HD downloader
      }
    }

    // 3. Single-pass parallel HD race (SaveNow + AMP4 + NoTube, capped ~25s worst-case)
    //    If a pre-trimmed provider returns a truncated clip (e.g. 15s instead of 50s),
    //    automatically retry once with an untrimmed full stream and seek locally via FFmpeg!
    let thirdPartyErr: unknown = null;
    for (const skipPreTrim of [false, true]) {
      throwIfAborted(signal);
      onProgress?.(
        skipPreTrim
          ? 'Potongan awal terpotong pendek, mengambil stream penuh agar durasi utuh...'
          : 'Mengunduh potongan video HD (SaveNow / AMP4 / NoTube)...',
        skipPreTrim ? 18 : 15
      );
      try {
        const stream = await resolveThirdPartyMp4Stream({
          sourceUrl: episode.sourceUrl,
          videoId: episode.videoId,
          startSec: clip.startSec,
          endSec: clip.endSec,
          preferredQuality,
          skipCache: skipPreTrim,
          skipPreTrim,
          signal,
        });
        throwIfAborted(signal);

        onProgress?.(`Menyiapkan stream ${stream.qualityTier ?? 'HD'} (${stream.provider})...`, 24);
        if (stream.isDirectChunkedDownload || stream.isPreTrimmed) {
          let lastPctEmit = 0;
          await downloadChunkedStreamToFile({
            streamUrl: stream.streamUrl,
            destPath: chunkedTempPath,
            headers: stream.headers,
            signal,
            onBytesProgress: (downloadedBytes, totalBytes) => {
              const now = Date.now();
              if (now - lastPctEmit < 900) return;
              lastPctEmit = now;
              const mb = (downloadedBytes / (1024 * 1024)).toFixed(1);
              if (totalBytes && totalBytes > 0) {
                const ratio = Math.min(0.99, downloadedBytes / totalBytes);
                onProgress?.(
                  `Mengunduh stream ${stream.qualityTier ?? 'HD'} (${mb} MB / ${(totalBytes / (1024 * 1024)).toFixed(1)} MB)...`,
                  24 + Math.round(ratio * 4)
                );
              } else {
                onProgress?.(
                  `Mengunduh stream ${stream.qualityTier ?? 'HD'} (${mb} MB)...`,
                  25
                );
              }
            },
          });
          await extractRawTrimmedSegment({
            inputSource: chunkedTempPath,
            isRemoteUrl: false,
            startSec: clip.startSec,
            durationSec,
            episodeDurationSec: episode.durationSec,
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
          episodeDurationSec: episode.durationSec,
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
        if (isMissingBinaryError(err)) {
          if (fs.existsSync(chunkedTempPath)) fs.unlinkSync(chunkedTempPath);
          if (fs.existsSync(rawSegmentPath)) fs.unlinkSync(rawSegmentPath);
          throw err;
        }
        thirdPartyErr = err;
        invalidateEpisodeStreamCache(episode.videoId || episode.sourceUrl);
        if (fs.existsSync(chunkedTempPath)) fs.unlinkSync(chunkedTempPath);
        if (fs.existsSync(rawSegmentPath)) fs.unlinkSync(rawSegmentPath);
        // Only run the second (untrimmed) pass when the first pass failed due to truncation!
        if (!(err instanceof TruncatedSegmentError)) {
          break;
        }
      }
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

function computeEvenDim(val: number): number {
  const n = Math.max(16, Math.round(val));
  return n % 2 === 0 ? n : n - 1;
}

function resolveProfileCanvasDimensions(
  layout: CanonicalStudioLayout,
  quality: CanonicalRenderQuality,
  profileSpec?: BalancedRenderProfileSpec,
  sourceWidth?: number,
  sourceHeight?: number
) {
  return resolveNonUpscaledTargetDimensions({
    layout,
    quality,
    profileId: profileSpec?.id,
    sourceWidth,
    sourceHeight,
  });
}

function buildMultiSpeakerCropExprForCenter(params: {
  centerX: number;
  centerY: number;
  sourceSize: number;
  cropSize: number;
  axis: 'x' | 'y';
}): string {
  const maxOffset = Math.max(0, Math.floor(params.sourceSize - params.cropSize));
  if (maxOffset <= 0) return '0';
  const norm = params.axis === 'x' ? params.centerX : params.centerY;
  const offset = Math.round(Math.max(0, Math.min(maxOffset, norm * params.sourceSize - params.cropSize / 2)));
  return String(offset);
}

export function buildStudioFilterComplex(params: {
  layout: CanonicalStudioLayout;
  quality: CanonicalRenderQuality;
  sourceW: number;
  sourceH: number;
  assPath: string;
  fontsDir: string;
  intelligence: ClipIntelligenceResult;
  overlayStyle?: Partial<ClipOverlayStyle> | null;
  introTiming?: {
    frameCount: number;
    loopExtraFrames: number;
    exactDurationSec: number;
  } | null;
  profileSpec?: BalancedRenderProfileSpec;
  compiledIntroPlan?: CompiledIntroRenderPlan | null;
  introAssPath?: string | null;
  introBackgroundMode?: IntroTemplateDefinition['background']['mode'] | null;
}): string {
  const {
    layout,
    quality,
    sourceW,
    sourceH,
    assPath,
    fontsDir,
    intelligence,
    overlayStyle,
    introTiming,
    profileSpec,
    compiledIntroPlan,
    introAssPath,
    introBackgroundMode,
  } = params;
  const targetFps = profileSpec?.fps ?? INTRO_FPS;
  const assEscaped = escapeFfmpegFilterPath(assPath);
  const fontsDirEscaped = escapeFfmpegFilterPath(fontsDir);
  const assFilter = `ass='${assEscaped}':fontsdir='${fontsDirEscaped}'`;
  const { outW, outH, effectiveQuality } = resolveProfileCanvasDimensions(
    layout,
    quality,
    profileSpec,
    sourceW,
    sourceH
  );
  const isLandscape = layout === 'full_16_9_focus';
  const normStyle = normalizeClipOverlayStyle(overlayStyle);
  const avgZoom =
    intelligence.keyframes.reduce((acc, k) => acc + k.zoomScale, 0) /
    Math.max(1, intelligence.keyframes.length);

  const customIntroNeedsSourceVideo = Boolean(
    introTiming &&
      compiledIntroPlan &&
      introBackgroundMode &&
      introBackgroundMode !== 'solid' &&
      introBackgroundMode !== 'gradient'
  );
  const usesLegacyIntroFromSource = Boolean(introTiming && !compiledIntroPlan);
  const introConsumesSourceVideo = usesLegacyIntroFromSource || customIntroNeedsSourceVideo;

  const buildIntroChain = (inputLabel: string): string => {
    if (!introTiming) return '';
    const fadeOutStart = Math.max(0.2, introTiming.exactDurationSec - 0.24).toFixed(4);

    if (compiledIntroPlan) {
      const hasIntroAss = Boolean(
        introAssPath &&
          compiledIntroPlan.hasTextBoxLayers + compiledIntroPlan.hasTextOnlyLayers > 0 &&
          compiledIntroPlan.assScript.includes('Dialogue:')
      );
      const introAssSuffix = hasIntroAss
        ? `,ass='${escapeFfmpegFilterPath(introAssPath!)}':fontsdir='${fontsDirEscaped}'`
        : '';

      if (introBackgroundMode === 'solid' || introBackgroundMode === 'gradient') {
        return `${compiledIntroPlan.backgroundFilter},trim=duration=${introTiming.exactDurationSec.toFixed(4)},setpts=PTS-STARTPTS,fps=${targetFps},setsar=1${introAssSuffix},format=yuv420p,fade=t=out:st=${fadeOutStart}:d=0.24[intro_v]`;
      }

      return `${inputLabel}trim=end_frame=1,setpts=PTS-STARTPTS,${compiledIntroPlan.backgroundFilter},loop=loop=${introTiming.loopExtraFrames}:size=1:start=0,setpts=N/${targetFps}/TB,fps=${targetFps},setsar=1${introAssSuffix},format=yuv420p,fade=t=out:st=${fadeOutStart}:d=0.24[intro_v]`;
    }

    const blurW = isLandscape ? 320 : 180;
    const blurH = isLandscape ? 180 : 320;
    const anchor = computeIntroAnchorLayout({ isLandscape, style: normStyle });
    const barW = Math.round(outW * anchor.barWRatio);
    const barH = Math.max(4, Math.round(outH * (isLandscape ? 0.005 : 0.0035)));
    const barX = Math.max(0, Math.min(outW - barW, Math.round(outW * anchor.barXRatio)));
    const barY = Math.max(0, Math.min(outH - barH, Math.round(outH * anchor.barYRatio)));
    const barColor = hexToFfmpegColor(normStyle.introAccentColor);
    return `${inputLabel}trim=end_frame=1,setpts=PTS-STARTPTS,scale=${blurW}:${blurH}:force_original_aspect_ratio=increase:flags=fast_bilinear,crop=${blurW}:${blurH},boxblur=8:2,eq=brightness=-0.30:contrast=1.14:saturation=1.18,scale=${outW}:${outH}:flags=fast_bilinear,setsar=1,format=yuv420p,drawbox=x=0:y=0:w=${outW}:h=${outH}:color=0x090D16@0.44:t=fill,drawbox=x=${barX}:y=${barY}:w=${barW}:h=${barH}:color=${barColor}@0.94:t=fill,loop=loop=${introTiming.loopExtraFrames}:size=1:start=0,setpts=N/${targetFps}/TB,fps=${targetFps},fade=t=out:st=${fadeOutStart}:d=0.24[intro_v]`;
  };

  const finalizeMainAndConcat = (
    mainBodyChain: string,
    extraSetupChains: string[] = []
  ): string => {
    const applyMainAssOnMain = Boolean(compiledIntroPlan);
    if (introTiming) {
      const chains: string[] = [...extraSetupChains];
      if (introConsumesSourceVideo) {
        chains.push(buildIntroChain('[introsrc]'));
      } else {
        chains.push(buildIntroChain(''));
      }

      if (applyMainAssOnMain) {
        chains.push(
          `${mainBodyChain},fps=${targetFps},setpts=PTS-STARTPTS,fade=t=in:st=0:d=0.20,${assFilter},format=yuv420p[main_v]`,
          '[intro_v][main_v]concat=n=2:v=1:a=0[out]'
        );
      } else {
        chains.push(
          `${mainBodyChain},fps=${targetFps},setpts=PTS-STARTPTS,fade=t=in:st=0:d=0.20[main_v]`,
          '[intro_v][main_v]concat=n=2:v=1:a=0[comp]',
          `[comp]${assFilter}[out]`
        );
      }
      return chains.join(';');
    }

    return [
      ...extraSetupChains,
      `${mainBodyChain},fps=${targetFps},setpts=PTS-STARTPTS[comp]`,
      `[comp]${assFilter}[out]`,
    ].join(';');
  };

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
    const mainBody = `crop=w=${cropW}:h=${cropH}:x='${xExpr}':y='${yExpr}',${clarity},setsar=1,format=yuv420p,drawbox=x=0:y=0:w=${outW}:h=${topScrimH}:color=0x000000@0.26:t=fill,drawbox=x=0:y=${outH - botScrimH}:w=${outW}:h=${botScrimH}:color=0x000000@0.30:t=fill`;

    if (introConsumesSourceVideo) {
      return finalizeMainAndConcat(`[mainsrc]${mainBody}`, [
        '[0:v]setpts=PTS-STARTPTS,split=2[introsrc][mainsrc]',
      ]);
    }
    return finalizeMainAndConcat(`[0:v]setpts=PTS-STARTPTS,${mainBody}`);
  }

  // Multi-speaker vertical layouts (split_screen, side_by_side, picture_in_picture, speaker_plus_context)
  const requestedMultiLayout: MultiSpeakerLayoutMode =
    intelligence.cameraAnalysis?.settings.multiSpeakerLayout ?? 'active_speaker_full';
  const isVerticalCanvas = layout === 'shorts_full_bleed' || layout === 'shorts_studio_focus';

  if (
    isVerticalCanvas &&
    (requestedMultiLayout === 'split_screen' ||
      requestedMultiLayout === 'side_by_side' ||
      requestedMultiLayout === 'picture_in_picture' ||
      requestedMultiLayout === 'speaker_plus_context')
  ) {
    const speakers = intelligence.cameraAnalysis?.speakers ?? [];
    const primarySpk = speakers[0] ?? { avgCenterX: 0.28, avgCenterY: 0.42 };
    const secondarySpk = speakers[1] ?? {
      avgCenterX: primarySpk.avgCenterX < 0.5 ? 0.72 : 0.28,
      avgCenterY: 0.42,
    };

    if (requestedMultiLayout === 'split_screen') {
      const halfH = computeEvenDim(outH / 2);
      const { cropW, cropH } = computeCropWindow(sourceW, sourceH, outW, halfH, 1.06);
      const topX = buildMultiSpeakerCropExprForCenter({
        centerX: primarySpk.avgCenterX,
        centerY: primarySpk.avgCenterY,
        sourceSize: sourceW,
        cropSize: cropW,
        axis: 'x',
      });
      const topY = buildMultiSpeakerCropExprForCenter({
        centerX: primarySpk.avgCenterX,
        centerY: primarySpk.avgCenterY,
        sourceSize: sourceH,
        cropSize: cropH,
        axis: 'y',
      });
      const botX = buildMultiSpeakerCropExprForCenter({
        centerX: secondarySpk.avgCenterX,
        centerY: secondarySpk.avgCenterY,
        sourceSize: sourceW,
        cropSize: cropW,
        axis: 'x',
      });
      const botY = buildMultiSpeakerCropExprForCenter({
        centerX: secondarySpk.avgCenterX,
        centerY: secondarySpk.avgCenterY,
        sourceSize: sourceH,
        cropSize: cropH,
        axis: 'y',
      });
      const clarityTop = buildFastClarityChain(sourceH, outW, halfH, quality);
      const clarityBot = buildFastClarityChain(sourceH, outW, outH - halfH, quality);
      const splitLabel = introConsumesSourceVideo
        ? '[0:v]setpts=PTS-STARTPTS,split=3[introsrc][topsrc][botsrc]'
        : '[0:v]setpts=PTS-STARTPTS,split=2[topsrc][botsrc]';
      return finalizeMainAndConcat(
        `[toppane][botpane]vstack=inputs=2,drawbox=x=0:y=${halfH - 2}:w=${outW}:h=4:color=0xFFFFFF@0.28:t=fill,setsar=1,format=yuv420p`,
        [
          splitLabel,
          `[topsrc]crop=w=${cropW}:h=${cropH}:x='${topX}':y='${topY}',${clarityTop},setsar=1[toppane]`,
          `[botsrc]crop=w=${cropW}:h=${cropH}:x='${botX}':y='${botY}',${clarityBot},setsar=1[botpane]`,
        ]
      );
    }

    if (requestedMultiLayout === 'side_by_side') {
      const halfW = computeEvenDim(outW / 2);
      const { cropW, cropH } = computeCropWindow(sourceW, sourceH, halfW, outH, 1.0);
      const leftX = buildMultiSpeakerCropExprForCenter({
        centerX: primarySpk.avgCenterX,
        centerY: primarySpk.avgCenterY,
        sourceSize: sourceW,
        cropSize: cropW,
        axis: 'x',
      });
      const leftY = buildMultiSpeakerCropExprForCenter({
        centerX: primarySpk.avgCenterX,
        centerY: primarySpk.avgCenterY,
        sourceSize: sourceH,
        cropSize: cropH,
        axis: 'y',
      });
      const rightX = buildMultiSpeakerCropExprForCenter({
        centerX: secondarySpk.avgCenterX,
        centerY: secondarySpk.avgCenterY,
        sourceSize: sourceW,
        cropSize: cropW,
        axis: 'x',
      });
      const rightY = buildMultiSpeakerCropExprForCenter({
        centerX: secondarySpk.avgCenterX,
        centerY: secondarySpk.avgCenterY,
        sourceSize: sourceH,
        cropSize: cropH,
        axis: 'y',
      });
      const clarityLeft = buildFastClarityChain(sourceH, halfW, outH, quality);
      const clarityRight = buildFastClarityChain(sourceH, outW - halfW, outH, quality);
      const splitLabel = introConsumesSourceVideo
        ? '[0:v]setpts=PTS-STARTPTS,split=3[introsrc][leftsrc][rightsrc]'
        : '[0:v]setpts=PTS-STARTPTS,split=2[leftsrc][rightsrc]';
      return finalizeMainAndConcat(
        `[leftpane][rightpane]hstack=inputs=2,drawbox=x=${halfW - 2}:y=0:w=4:h=${outH}:color=0xFFFFFF@0.28:t=fill,setsar=1,format=yuv420p`,
        [
          splitLabel,
          `[leftsrc]crop=w=${cropW}:h=${cropH}:x='${leftX}':y='${leftY}',${clarityLeft},setsar=1[leftpane]`,
          `[rightsrc]crop=w=${cropW}:h=${cropH}:x='${rightX}':y='${rightY}',${clarityRight},setsar=1[rightpane]`,
        ]
      );
    }

    if (requestedMultiLayout === 'picture_in_picture') {
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
      const clarityMain = buildFastClarityChain(sourceH, outW, outH, quality);
      const pipW = computeEvenDim(outW * 0.30);
      const pipH = computeEvenDim(pipW * 1.25);
      const { cropW: pipCropW, cropH: pipCropH } = computeCropWindow(
        sourceW,
        sourceH,
        pipW,
        pipH,
        1.12
      );
      const pipX = buildMultiSpeakerCropExprForCenter({
        centerX: secondarySpk.avgCenterX,
        centerY: secondarySpk.avgCenterY,
        sourceSize: sourceW,
        cropSize: pipCropW,
        axis: 'x',
      });
      const pipY = buildMultiSpeakerCropExprForCenter({
        centerX: secondarySpk.avgCenterX,
        centerY: secondarySpk.avgCenterY,
        sourceSize: sourceH,
        cropSize: pipCropH,
        axis: 'y',
      });
      const marginX = Math.round(outW * 0.045);
      const marginY = Math.round(outH * 0.16);
      const splitLabel = introConsumesSourceVideo
        ? '[0:v]setpts=PTS-STARTPTS,split=3[introsrc][basesrc][pipsrc]'
        : '[0:v]setpts=PTS-STARTPTS,split=2[basesrc][pipsrc]';
      return finalizeMainAndConcat(
        `[basepane][pippane]overlay=${outW - pipW - marginX}:${marginY},setsar=1,format=yuv420p`,
        [
          splitLabel,
          `[basesrc]crop=w=${cropW}:h=${cropH}:x='${xExpr}':y='${yExpr}',${clarityMain},setsar=1[basepane]`,
          `[pipsrc]crop=w=${pipCropW}:h=${pipCropH}:x='${pipX}':y='${pipY}',scale=${pipW}:${pipH}:flags=lanczos,drawbox=x=0:y=0:w=${pipW}:h=${pipH}:color=0xFFFFFF@0.75:t=3,setsar=1[pippane]`,
        ]
      );
    }

    // speaker_plus_context: top 65% tracks active speaker, bottom 35% shows wide context
    const topH = computeEvenDim(outH * 0.65);
    const botH = outH - topH;
    const { cropW: topCropW, cropH: topCropH } = computeCropWindow(
      sourceW,
      sourceH,
      outW,
      topH,
      1.12
    );
    const topX = buildSmoothCropAxisExpression({
      keyframes: intelligence.keyframes,
      axis: 'x',
      sourceSize: sourceW,
      cropSize: topCropW,
    });
    const topY = buildSmoothCropAxisExpression({
      keyframes: intelligence.keyframes,
      axis: 'y',
      sourceSize: sourceH,
      cropSize: topCropH,
    });
    const { cropW: wideCropW, cropH: wideCropH } = computeCropWindow(
      sourceW,
      sourceH,
      outW,
      botH,
      1.0
    );
    const wideX = buildMultiSpeakerCropExprForCenter({
      centerX: 0.5,
      centerY: 0.48,
      sourceSize: sourceW,
      cropSize: wideCropW,
      axis: 'x',
    });
    const wideY = buildMultiSpeakerCropExprForCenter({
      centerX: 0.5,
      centerY: 0.48,
      sourceSize: sourceH,
      cropSize: wideCropH,
      axis: 'y',
    });
    const clarityTop = buildFastClarityChain(sourceH, outW, topH, quality);
    const clarityBot = buildFastClarityChain(sourceH, outW, botH, quality);
    const splitLabel = introConsumesSourceVideo
      ? '[0:v]setpts=PTS-STARTPTS,split=3[introsrc][topsrc][widesrc]'
      : '[0:v]setpts=PTS-STARTPTS,split=2[topsrc][widesrc]';
    return finalizeMainAndConcat(
      `[toppane][widepane]vstack=inputs=2,drawbox=x=0:y=${topH - 2}:w=${outW}:h=4:color=0xFFFFFF@0.26:t=fill,setsar=1,format=yuv420p`,
      [
        splitLabel,
        `[topsrc]crop=w=${topCropW}:h=${topCropH}:x='${topX}':y='${topY}',${clarityTop},setsar=1[toppane]`,
        `[widesrc]crop=w=${wideCropW}:h=${wideCropH}:x='${wideX}':y='${wideY}',${clarityBot},setsar=1[widepane]`,
      ]
    );
  }

  if (layout === 'shorts_studio_focus' || (isVerticalCanvas && requestedMultiLayout === 'wide_shot')) {
    const isWide = requestedMultiLayout === 'wide_shot';
    const safeZoom = isWide
      ? 1.0
      : sourceH >= 720
        ? Math.max(1.06, Math.min(1.26, avgZoom * 0.85))
        : 1.02;
    const { cropW, cropH } = computeCropWindow(sourceW, sourceH, 8, 7, safeZoom);
    const xExpr = isWide
      ? buildMultiSpeakerCropExprForCenter({
          centerX: 0.5,
          centerY: 0.45,
          sourceSize: sourceW,
          cropSize: cropW,
          axis: 'x',
        })
      : buildSmoothCropAxisExpression({
          keyframes: intelligence.keyframes,
          axis: 'x',
          sourceSize: sourceW,
          cropSize: cropW,
        });
    const yExpr = isWide
      ? buildMultiSpeakerCropExprForCenter({
          centerX: 0.5,
          centerY: 0.45,
          sourceSize: sourceH,
          cropSize: cropH,
          axis: 'y',
        })
      : buildSmoothCropAxisExpression({
          keyframes: intelligence.keyframes,
          axis: 'y',
          sourceSize: sourceH,
          cropSize: cropH,
        });

    const fgW = Math.round(outW * 0.94);
    const fgH = computeEvenDim((fgW * 7) / 8);
    const fgY = Math.round(outH * 0.215);
    const fgClarity = buildFastClarityChain(sourceH, fgW, fgH, quality);
    const splitLabel = introConsumesSourceVideo
      ? '[0:v]setpts=PTS-STARTPTS,split=3[introsrc][bgsrc][fgsrc]'
      : '[0:v]setpts=PTS-STARTPTS,split=2[bgsrc][fgsrc]';
    return finalizeMainAndConcat(`[bg][fg]overlay=(W-w)/2:${fgY},setsar=1,format=yuv420p`, [
      splitLabel,
      `[bgsrc]scale=180:320:force_original_aspect_ratio=increase:flags=fast_bilinear,crop=180:320,boxblur=6:1,eq=brightness=-0.20:contrast=1.12:saturation=1.30,scale=${outW}:${outH}:flags=fast_bilinear,setsar=1[bg]`,
      `[fgsrc]crop=w=${cropW}:h=${cropH}:x='${xExpr}':y='${yExpr}',${fgClarity},setsar=1[fg]`,
    ]);
  }

  if (layout === 'square_1_1' || layout === 'portrait_4_5') {
    const aspectW = layout === 'square_1_1' ? 1 : 4;
    const aspectH = layout === 'square_1_1' ? 1 : 5;
    const safeZoom = sourceH >= 720 ? Math.max(1.02, Math.min(1.22, avgZoom * 0.9)) : 1.0;
    const { cropW, cropH } = computeCropWindow(sourceW, sourceH, aspectW, aspectH, safeZoom);
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
    const mainBody = `crop=w=${cropW}:h=${cropH}:x='${xExpr}':y='${yExpr}',${clarity},setsar=1,format=yuv420p,drawbox=x=0:y=0:w=${outW}:h=${topBand}:color=0x000000@0.24:t=fill,drawbox=x=0:y=${outH - botBand}:w=${outW}:h=${botBand}:color=0x000000@0.28:t=fill`;

    if (introConsumesSourceVideo) {
      return finalizeMainAndConcat(`[mainsrc]${mainBody}`, [
        '[0:v]setpts=PTS-STARTPTS,split=2[introsrc][mainsrc]',
      ]);
    }
    return finalizeMainAndConcat(`[0:v]setpts=PTS-STARTPTS,${mainBody}`);
  }

  // shorts_full_bleed (DEFAULT): Edge-to-edge Full Frame 9:16 with Smooth Active Speaker Pan/Crop
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
  const mainBody = `crop=w=${cropW}:h=${cropH}:x='${xExpr}':y='${yExpr}',${clarity},setsar=1,format=yuv420p,drawbox=x=0:y=0:w=${outW}:h=${topBand}:color=0x000000@0.24:t=fill,drawbox=x=0:y=${outH - botBand}:w=${outW}:h=${botBand}:color=0x000000@0.28:t=fill`;

  if (introConsumesSourceVideo) {
    return finalizeMainAndConcat(`[mainsrc]${mainBody}`, [
      '[0:v]setpts=PTS-STARTPTS,split=2[introsrc][mainsrc]',
    ]);
  }
  return finalizeMainAndConcat(`[0:v]setpts=PTS-STARTPTS,${mainBody}`);
}

export async function renderClipMp4(params: {
  episode: PodcastEpisode;
  clip: PodcastClip;
  layout?: ClipRenderLayout;
  quality?: ClipRenderQuality;
  renderProfile?: BalancedRenderProfile | string;
  cameraSettings?: Partial<CameraTrackingSettings> | null;
  introTemplateConfig?: Partial<IntroTemplateDefinition> | null;
  sourceFingerprint?: string;
  renderFingerprint?: string;
  enableEmotionEffects?: boolean;
  enableAiIntro?: boolean;
  overlayStyle?: Partial<ClipOverlayStyle> | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (stage: string, progress: number) => void;
}): Promise<{
  outputPath: string;
  sizeBytes: number;
  width: number;
  height: number;
  durationSec: number;
  sourceWidth: number;
  sourceHeight: number;
  sourceUsed: ClipRenderSource;
  layout: CanonicalStudioLayout;
  quality: CanonicalRenderQuality;
  requestedQuality: CanonicalRenderQuality;
  renderProfile: BalancedRenderProfile;
  sourceFingerprint: string;
  emotionEffectsEnabled: boolean;
  introEnabled: boolean;
  upscalePrevented: boolean;
  upscaleNote?: string;
  resolvedIntro: ClipIntelligenceResult['intro'];
  intelligence: ClipIntelligenceResult;
}> {
  ensureDirs();
  cleanupOldTempSegments();

  const { episode, clip } = params;
  const layout = normalizeRenderLayout(params.layout);
  const initialQuality = normalizeRenderQuality(params.quality);
  const hasExplicitProfile =
    typeof params.renderProfile === 'string' && params.renderProfile.trim() !== '';
  const profileSpec = resolveBalancedRenderProfile(
    hasExplicitProfile ? params.renderProfile : params.quality ? undefined : clip.renderProfile,
    initialQuality
  );
  const quality: CanonicalRenderQuality = profileSpec.quality;
  const enableEmotionEffects = params.enableEmotionEffects !== false;
  const enableAiIntro = params.enableAiIntro !== false;
  const effectiveOverlayStyle = normalizeClipOverlayStyle(params.overlayStyle ?? clip.overlayStyle);
  const effectiveCameraSettings = params.cameraSettings ?? clip.cameraTrackingSettings ?? null;
  const effectiveIntroConfig = params.introTemplateConfig ?? clip.introTemplateConfig ?? null;

  const sourceFingerprint =
    params.sourceFingerprint ||
    computeSourceFingerprint({
      videoId: episode.videoId,
      sourceUrl: episode.sourceUrl,
      uploadedFileHash: getEpisodeSourceFingerprintTag(episode),
      startSec: clip.startSec,
      endSec: clip.endSec,
    });

  const outputPath = path.join(RENDERS_DIR, `${clip.id}.mp4`);
  const tmpRenderPath = path.join(TMP_DIR, `render_${clip.id}_${Date.now()}.mp4`);
  const assPath = path.join(TMP_DIR, `${clip.id}_${Date.now()}.ass`);
  const introAssPath = path.join(TMP_DIR, `intro_${clip.id}_${Date.now()}.ass`);
  const workDir = path.join(TMP_DIR, `work_${clip.id}_${Date.now()}`);
  const fpSegmentCachePath = path.join(TMP_DIR, `seg_src_${sourceFingerprint}.mp4`);
  const legacySegmentCachePath = path.join(
    TMP_DIR,
    `seg_hd_${clip.id}_${clip.startSec}_${clip.endSec}.mp4`
  );
  const cachedRawSegmentPath = fpSegmentCachePath;
  const fpIntelCachePath = path.join(TMP_DIR, `intel_src_${sourceFingerprint}.json`);
  const legacyIntelCachePath = path.join(
    TMP_DIR,
    `intel_${clip.id}_${clip.startSec}_${clip.endSec}.json`
  );
  const intelCachePath =
    fs.existsSync(fpIntelCachePath) || !fs.existsSync(legacyIntelCachePath)
      ? fpIntelCachePath
      : legacyIntelCachePath;

  fs.mkdirSync(workDir, { recursive: true });

  try {
    let sourceUsed: ClipRenderSource = 'third_party_downloader';
    let rawReady = false;

    const candidateRawPath = fs.existsSync(fpSegmentCachePath)
      ? fpSegmentCachePath
      : fs.existsSync(legacySegmentCachePath)
        ? legacySegmentCachePath
        : null;

    if (candidateRawPath) {
      try {
        const cachedMeta = await probeVideoMeta(candidateRawPath);
        const requestedDurationSec = Math.max(5, clip.endSec - clip.startSec);
        const cachedDurationCheck = assessSegmentDurationHealth({
          requestedDurationSec,
          actualDurationSec: cachedMeta.durationSec,
          startSec: clip.startSec,
          episodeDurationSec: episode.durationSec,
        });
        if (
          cachedMeta.height < 720 ||
          !cachedMeta.syncHealth.isSynced ||
          !cachedDurationCheck.isComplete
        ) {
          fs.unlinkSync(candidateRawPath);
        } else {
          if (candidateRawPath !== fpSegmentCachePath && !fs.existsSync(fpSegmentCachePath)) {
            fs.copyFileSync(candidateRawPath, fpSegmentCachePath);
          }
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
        if (fs.existsSync(candidateRawPath)) fs.unlinkSync(candidateRawPath);
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
      params.onProgress?.('Memakai cache sumber HD (lewati unduh ulang)...', 28);
    }

    throwIfAborted(params.signal);
    const rawMeta = await probeVideoMeta(cachedRawSegmentPath);

    params.onProgress?.(
      fs.existsSync(intelCachePath)
        ? 'Memuat cache analisis AI & melacak pembicara aktif...'
        : 'Mentranskrip audio, melacak pembicara aktif & momen emosi AI...',
      38
    );
    const intelligence = await analyzeTrimmedClipIntelligence({
      rawVideoPath: cachedRawSegmentPath,
      durationSec: rawMeta.durationSec,
      workDir,
      cachePath: fpIntelCachePath,
      episode,
      clip,
      cameraSettings: effectiveCameraSettings,
      signal: params.signal,
    });
    throwIfAborted(params.signal);

    const fontEnv = ensureAssFontEnvironment();
    const dimResolution = resolveProfileCanvasDimensions(
      layout,
      quality,
      profileSpec,
      rawMeta.width,
      rawMeta.height
    );
    const { outW, outH } = dimResolution;
    if (dimResolution.wasCappedNoUpscale && dimResolution.reason) {
      params.onProgress?.(dimResolution.reason, 48);
    }

    let compiledIntroPlan: CompiledIntroRenderPlan | null = null;
    let introTiming: { frameCount: number; loopExtraFrames: number; exactDurationSec: number } | null =
      null;
    let resolvedIntro = normalizeAiClipIntro(
      {
        tag: effectiveOverlayStyle.customIntroTag || intelligence.intro.tag,
        headline: effectiveOverlayStyle.customIntroHeadline || intelligence.intro.headline,
        teaser: effectiveOverlayStyle.customIntroTeaser || intelligence.intro.teaser,
        durationSec: effectiveOverlayStyle.introDurationSec || intelligence.intro.durationSec,
      },
      {
        title: effectiveOverlayStyle.customTopTitle || intelligence.autoTitle,
        ringkasanTeks: clip.ringkasanTeks,
        hookLine: clip.hookLine,
        episodeTitle: episode.title,
      }
    );
    let introBackgroundMode: IntroTemplateDefinition['background']['mode'] | null = null;

    if (enableAiIntro && effectiveIntroConfig) {
      const normalizedTemplate = normalizeIntroTemplateDefinition(effectiveIntroConfig);
      introTiming = computeExactIntroTiming(normalizedTemplate.durationSec, profileSpec.fps, 0.5, 10.0);
      const exactDurTemplate: IntroTemplateDefinition = {
        ...normalizedTemplate,
        durationSec: introTiming.exactDurationSec,
      };
      compiledIntroPlan = compileIntroTemplateForFfmpeg({
        template: exactDurTemplate,
        width: outW,
        height: outH,
        fps: profileSpec.fps,
      });
      introBackgroundMode = exactDurTemplate.background.mode;
      fs.writeFileSync(introAssPath, compiledIntroPlan.assScript, 'utf-8');
      resolvedIntro = {
        ...resolvedIntro,
        durationSec: introTiming.exactDurationSec,
      };
    } else if (enableAiIntro) {
      introTiming = computeExactIntroTiming(resolvedIntro.durationSec, profileSpec.fps, 2.0, 4.5);
    }

    const assContent = generateStudioAssScript({
      layout,
      title: effectiveOverlayStyle.customTopTitle || intelligence.autoTitle,
      channelName: episode.channelName,
      hookCaption: intelligence.autoCaption,
      cues: intelligence.cues,
      durationSec: rawMeta.durationSec,
      emotionMoments: intelligence.emotionMoments,
      enableEmotionEffects,
      intro:
        introTiming && !compiledIntroPlan
          ? { ...resolvedIntro, durationSec: introTiming.exactDurationSec }
          : null,
      enableAiIntro: Boolean(introTiming && !compiledIntroPlan),
      fontName: fontEnv.fontName,
      overlayStyle: effectiveOverlayStyle,
    });
    fs.writeFileSync(assPath, assContent, 'utf-8');

    const videoFilterComplex = buildStudioFilterComplex({
      layout,
      quality,
      sourceW: rawMeta.width,
      sourceH: rawMeta.height,
      assPath,
      fontsDir: fontEnv.fontsDir,
      intelligence,
      overlayStyle: effectiveOverlayStyle,
      introTiming,
      profileSpec,
      compiledIntroPlan,
      introAssPath: compiledIntroPlan ? introAssPath : null,
      introBackgroundMode,
    });

    const hasAudioStream = Boolean(rawMeta.audioCodec);
    const emotionAudioGraph =
      hasAudioStream && enableEmotionEffects && intelligence.emotionMoments.length > 0
        ? buildEmotionAudioFilterGraph(intelligence.emotionMoments)
        : null;

    const audioFilterChains: string[] = [];
    let audioMapTarget = '0:a?';
    let audioArgs: string[] = [];
    const audioBitrate = `${profileSpec.audioBitrateKbps}k`;

    if (hasAudioStream) {
      const loudnormSuffix = effectiveOverlayStyle.normalizeAudio
        ? ',loudnorm=I=-14:TP=-1.5:LRA=11'
        : '';
      if (introTiming) {
        const exactDur = introTiming.exactDurationSec.toFixed(4);
        if (compiledIntroPlan) {
          if (compiledIntroPlan.audioFilter) {
            audioFilterChains.push(
              `${compiledIntroPlan.audioFilter},aresample=44100,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,apad,atrim=0:${exactDur}[intro_a]`
            );
          } else {
            audioFilterChains.push(
              `anullsrc=r=44100:cl=stereo:d=${exactDur},aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[intro_a]`
            );
          }
        } else {
          const introFadeOutStart = Math.max(0.2, introTiming.exactDurationSec - 0.34).toFixed(4);
          audioFilterChains.push(
            `aevalsrc=exprs='${buildIntroAudioExpr()}':s=44100:d=${exactDur}:c=stereo,volume=0.22,afade=t=in:st=0:d=0.16,afade=t=out:st=${introFadeOutStart}:d=0.34,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[intro_a]`
          );
        }

        if (emotionAudioGraph) {
          audioFilterChains.push(...emotionAudioGraph.filterChains);
          audioFilterChains.push(
            `${emotionAudioGraph.outputLabel}aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo${loudnormSuffix}[main_a]`,
            '[intro_a][main_a]concat=n=2:v=0:a=1[final_a]'
          );
        } else {
          audioFilterChains.push(
            `[0:a]asetpts=PTS-STARTPTS,aresample=44100:async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo${loudnormSuffix}[main_a]`,
            '[intro_a][main_a]concat=n=2:v=0:a=1[final_a]'
          );
        }
        audioMapTarget = '[final_a]';
        audioArgs = ['-c:a', 'aac', '-b:a', audioBitrate];
      } else if (emotionAudioGraph) {
        audioFilterChains.push(...emotionAudioGraph.filterChains);
        if (loudnormSuffix) {
          audioFilterChains.push(`${emotionAudioGraph.outputLabel}loudnorm=I=-14:TP=-1.5:LRA=11[aout_norm]`);
          audioMapTarget = '[aout_norm]';
        } else {
          audioMapTarget = emotionAudioGraph.outputLabel;
        }
        audioArgs = ['-c:a', 'aac', '-b:a', audioBitrate];
      } else if (loudnormSuffix) {
        audioMapTarget = '0:a';
        audioArgs = [
          '-af',
          'asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0,loudnorm=I=-14:TP=-1.5:LRA=11',
          '-c:a',
          'aac',
          '-b:a',
          audioBitrate,
        ];
      } else {
        audioMapTarget = '0:a';
        audioArgs =
          rawMeta.audioCodec === 'aac' && rawMeta.syncHealth.isSynced
            ? ['-c:a', 'copy']
            : ['-af', 'asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0', '-c:a', 'aac', '-b:a', audioBitrate];
      }
    }

    const filterComplex =
      audioFilterChains.length > 0
        ? [videoFilterComplex, ...audioFilterChains].join(';')
        : videoFilterComplex;

    const layoutLabel =
      layout === 'full_16_9_focus'
        ? 'Full 16:9'
        : layout === 'shorts_studio_focus'
          ? 'Shorts 9:16 Studio'
          : layout === 'square_1_1'
            ? 'Square 1:1'
            : layout === 'portrait_4_5'
              ? 'Portrait 4:5'
              : 'Full Frame 9:16';
    params.onProgress?.(
      `Merender ${layoutLabel} (${profileSpec.label}, 0%)...`,
      56
    );

    const effectivePreset =
      CPU_COUNT <= 2 && profileSpec.preset === 'slow'
        ? 'medium'
        : CPU_COUNT <= 2 && profileSpec.preset === 'medium'
          ? 'veryfast'
          : profileSpec.preset;

    await runFfmpegWithProgress({
      durationSec: rawMeta.durationSec + (introTiming?.exactDurationSec ?? 0),
      env: { FONTCONFIG_FILE: fontEnv.fontconfigFile },
      signal: params.signal,
      timeoutMs: params.timeoutMs,
      onPercent: (ratio) => {
        const pct = Math.min(99, Math.round(ratio * 100));
        const overall = Math.min(95, 56 + Math.round(ratio * 39));
        params.onProgress?.(`Merender ${layoutLabel} (${profileSpec.label}, ${pct}%)...`, overall);
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
        String(profileSpec.fps),
        '-c:v',
        profileSpec.videoCodec,
        '-preset',
        effectivePreset,
        '-crf',
        String(profileSpec.crf),
        '-maxrate',
        `${profileSpec.maxrateKbps}k`,
        '-bufsize',
        `${profileSpec.bufsizeKbps}k`,
        '-profile:v',
        profileSpec.profile,
        '-level:v',
        profileSpec.level,
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
      durationSec: finalMeta.durationSec,
      sourceWidth: rawMeta.width,
      sourceHeight: rawMeta.height,
      sourceUsed,
      layout,
      quality: dimResolution.effectiveQuality,
      requestedQuality: quality,
      renderProfile: profileSpec.id,
      sourceFingerprint,
      emotionEffectsEnabled: enableEmotionEffects,
      introEnabled: Boolean(introTiming),
      upscalePrevented: dimResolution.wasCappedNoUpscale,
      upscaleNote: dimResolution.reason,
      resolvedIntro: introTiming
        ? { ...resolvedIntro, durationSec: introTiming.exactDurationSec }
        : resolvedIntro,
      intelligence,
    };
  } finally {
    if (fs.existsSync(assPath)) fs.unlinkSync(assPath);
    if (fs.existsSync(introAssPath)) fs.unlinkSync(introAssPath);
    if (fs.existsSync(tmpRenderPath)) fs.unlinkSync(tmpRenderPath);
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
  }
}
