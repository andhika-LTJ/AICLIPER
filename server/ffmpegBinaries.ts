import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

export type MediaBinaryName = 'ffmpeg' | 'ffprobe';

export class MissingMediaBinaryError extends Error {
  code = 'MISSING_MEDIA_BINARY' as const;
  binary: MediaBinaryName;

  constructor(binary: MediaBinaryName, attempted: string[]) {
    super(
      `Binary ${binary} tidak ditemukan atau tidak dapat dijalankan di server (dicoba: ${attempted.join(', ') || 'tidak ada'}).`
    );
    this.name = 'MissingMediaBinaryError';
    this.binary = binary;
  }
}

export interface BinaryResolverDeps {
  exists: (candidatePath: string) => boolean;
  ensureExecutable: (candidatePath: string) => boolean;
  canExecute: (candidatePath: string) => boolean;
}

/**
 * Pure, testable resolver: iterates candidates in priority order and returns
 * the first candidate that exists (for path-based entries), is executable, and
 * passes `-version` verification.
 */
export function resolveBinaryFromCandidates(
  binary: MediaBinaryName,
  candidates: Array<string | null | undefined>,
  deps: BinaryResolverDeps
): string {
  const seen = new Set<string>();
  const attempted: string[] = [];

  for (const raw of candidates) {
    const candidate = raw?.trim();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    attempted.push(candidate);

    const isBareCommand = !candidate.includes('/') && !candidate.includes('\\');
    if (!isBareCommand) {
      if (!deps.exists(candidate)) continue;
      if (!deps.ensureExecutable(candidate)) continue;
    }

    if (deps.canExecute(candidate)) {
      return candidate;
    }
  }

  throw new MissingMediaBinaryError(binary, attempted);
}

/**
 * Selects the official standalone yt-dlp GitHub release filename for the host OS/arch.
 */
export function selectYtDlpReleaseAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): { assetName: string; localFileName: string } {
  if (platform === 'win32') {
    return { assetName: 'yt-dlp.exe', localFileName: 'yt-dlp.exe' };
  }
  if (platform === 'darwin') {
    return { assetName: 'yt-dlp_macos', localFileName: 'yt-dlp' };
  }
  if (arch === 'arm64') {
    return { assetName: 'yt-dlp_linux_aarch64', localFileName: 'yt-dlp' };
  }
  return { assetName: 'yt-dlp_linux', localFileName: 'yt-dlp' };
}

/**
 * Detects spawn ENOENT or MissingMediaBinaryError so binary resolution bugs
 * are never misreported as YouTube cookies/bot-check rejections.
 */
export function isMissingBinaryError(err: unknown): boolean {
  if (err instanceof MissingMediaBinaryError) return true;
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  if (e.code === 'ENOENT' || e.code === 'MISSING_MEDIA_BINARY') return true;
  const msg = String(e.message ?? '');
  return /\bspawn\s+(?:ffmpeg|ffprobe|yt-dlp)\s+ENOENT\b/i.test(msg);
}

function defaultExists(candidatePath: string): boolean {
  try {
    return fs.statSync(candidatePath).isFile();
  } catch {
    return false;
  }
}

function defaultEnsureExecutable(candidatePath: string): boolean {
  if (process.platform === 'win32') {
    return defaultExists(candidatePath);
  }
  try {
    fs.accessSync(candidatePath, fs.constants.X_OK);
    return true;
  } catch {
    try {
      fs.chmodSync(candidatePath, 0o755);
      fs.accessSync(candidatePath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function defaultCanExecute(candidatePath: string): boolean {
  try {
    const result = spawnSync(candidatePath, ['-version'], {
      stdio: 'ignore',
      timeout: 5_000,
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

const DEFAULT_DEPS: BinaryResolverDeps = {
  exists: defaultExists,
  ensureExecutable: defaultEnsureExecutable,
  canExecute: defaultCanExecute,
};

let cachedFfmpegPath: string | null = null;
let cachedFfprobePath: string | null = null;
let cachedYtDlpBinDir: string | null = null;

function getBundledFfmpegStaticPath(): string | null {
  return typeof ffmpegStatic === 'string' && ffmpegStatic.trim() ? ffmpegStatic.trim() : null;
}

function getBundledFfprobeStaticPath(): string | null {
  const candidate = (ffprobeStatic as { path?: unknown } | undefined)?.path;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

/**
 * Resolves a verified, executable FFmpeg binary path.
 * Priority:
 *  1. `process.env.FFMPEG_PATH` (explicit override)
 *  2. Bundled `ffmpeg-static` (FFmpeg 7.0.2 static with libass/libx264/fontconfig — identical in dev & Cloud Run)
 *  3. System FFmpeg (`/usr/bin/ffmpeg`, `/usr/local/bin/ffmpeg`, `ffmpeg` on PATH)
 */
export function getFfmpegPath(): string {
  if (cachedFfmpegPath) {
    return cachedFfmpegPath;
  }

  const resolved = resolveBinaryFromCandidates(
    'ffmpeg',
    [
      process.env.FFMPEG_PATH,
      getBundledFfmpegStaticPath(),
      '/usr/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
      'ffmpeg',
    ],
    DEFAULT_DEPS
  );

  cachedFfmpegPath = resolved;
  return resolved;
}

/**
 * Resolves a verified, executable FFprobe binary path.
 * Priority:
 *  1. `process.env.FFPROBE_PATH` (explicit override)
 *  2. Bundled `ffprobe-static` (guaranteed present in slim Cloud Run containers)
 *  3. System FFprobe (`/usr/bin/ffprobe`, `/usr/local/bin/ffprobe`, `ffprobe` on PATH)
 */
export function getFfprobePath(): string {
  if (cachedFfprobePath) {
    return cachedFfprobePath;
  }

  const resolved = resolveBinaryFromCandidates(
    'ffprobe',
    [
      process.env.FFPROBE_PATH,
      getBundledFfprobeStaticPath(),
      '/usr/bin/ffprobe',
      '/usr/local/bin/ffprobe',
      'ffprobe',
    ],
    DEFAULT_DEPS
  );

  cachedFfprobePath = resolved;
  return resolved;
}

/**
 * Creates a small temp directory containing `ffmpeg` and `ffprobe` links pointing to
 * our resolved binaries so `yt-dlp --ffmpeg-location <dir>` always finds BOTH tools
 * even when system PATH has neither installed.
 */
export function getYtDlpFfmpegLocation(): string {
  const ffmpegPath = getFfmpegPath();
  const ffprobePath = getFfprobePath();

  if (
    cachedYtDlpBinDir &&
    fs.existsSync(cachedYtDlpBinDir) &&
    fs.existsSync(path.join(cachedYtDlpBinDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
  ) {
    return cachedYtDlpBinDir;
  }

  // If both are already absolute paths in the same directory with standard names, reuse it directly
  const ext = process.platform === 'win32' ? '.exe' : '';
  const ffmpegDir = path.dirname(ffmpegPath);
  const ffprobeDir = path.dirname(ffprobePath);
  if (
    path.isAbsolute(ffmpegPath) &&
    path.isAbsolute(ffprobePath) &&
    ffmpegDir === ffprobeDir &&
    path.basename(ffmpegPath) === `ffmpeg${ext}` &&
    path.basename(ffprobePath) === `ffprobe${ext}`
  ) {
    cachedYtDlpBinDir = ffmpegDir;
    return ffmpegDir;
  }

  const binDir = path.join(os.tmpdir(), 'klipcast-ffmpeg-bin');
  try {
    fs.mkdirSync(binDir, { recursive: true });
    const links: Array<{ name: string; target: string }> = [
      { name: `ffmpeg${ext}`, target: ffmpegPath },
      { name: `ffprobe${ext}`, target: ffprobePath },
    ];

    for (const item of links) {
      if (!path.isAbsolute(item.target)) continue;
      const linkPath = path.join(binDir, item.name);
      try {
        if (fs.lstatSync(linkPath)) {
          fs.unlinkSync(linkPath);
        }
      } catch {
        // Does not exist yet
      }
      fs.symlinkSync(item.target, linkPath);
    }

    if (fs.existsSync(path.join(binDir, `ffmpeg${ext}`))) {
      cachedYtDlpBinDir = binDir;
      return binDir;
    }
  } catch {
    // Fallback to direct ffmpeg binary path if symlinks are disallowed
  }

  return ffmpegPath;
}

export function resetBinaryCacheForTest(): void {
  cachedFfmpegPath = null;
  cachedFfprobePath = null;
  cachedYtDlpBinDir = null;
}
