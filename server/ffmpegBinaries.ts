import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

export type MediaBinaryName = 'ffmpeg' | 'ffprobe';

export class MissingMediaBinaryError extends Error {
  code = 'MISSING_MEDIA_BINARY' as const;
  binary: MediaBinaryName;

  constructor(binary: MediaBinaryName, attempted: string[]) {
    super(
      `Binary ${binary} tidak ditemukan atau gagal disiapkan di server (dicoba: ${attempted.join(', ') || 'tidak ada'}).`
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

export interface BinaryDownloadSpec {
  url: string;
  archiveType: 'gzip' | 'zip' | 'raw';
  entryName?: string;
}

const RUNTIME_BIN_DIR = path.join(os.tmpdir(), 'klipcast-bin');
const FFMPEG_STATIC_RELEASE = 'b6.1.1';
const FFBINARIES_RELEASE = 'v6.1';

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
 * Builds the official single-architecture FFmpeg static download URL (gzipped, ~29 MB)
 * so production containers stay lightweight (< 250 MB) while still having full FFmpeg + libass.
 */
export function buildFfmpegDownloadSpecs(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): BinaryDownloadSpec[] {
  const specs: BinaryDownloadSpec[] = [];
  const supported =
    (platform === 'linux' && (arch === 'x64' || arch === 'arm64' || arch === 'ia32')) ||
    (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) ||
    (platform === 'win32' && (arch === 'x64' || arch === 'ia32'));

  if (supported) {
    specs.push({
      url: `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_STATIC_RELEASE}/ffmpeg-${platform}-${arch}.gz`,
      archiveType: 'gzip',
    });
  }

  const ffbinTarget = mapPlatformToFfbinariesTarget(platform, arch);
  if (ffbinTarget) {
    specs.push({
      url: `https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/${FFBINARIES_RELEASE}/ffmpeg-6.1-${ffbinTarget}.zip`,
      archiveType: 'zip',
      entryName: platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
    });
  }

  return specs;
}

/**
 * Builds single-architecture FFprobe static download URLs (~29 MB zipped)
 * avoiding the 336 MB multi-platform npm package.
 */
export function buildFfprobeDownloadSpecs(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): BinaryDownloadSpec[] {
  const specs: BinaryDownloadSpec[] = [];
  const ffbinTarget = mapPlatformToFfbinariesTarget(platform, arch);
  if (ffbinTarget) {
    specs.push({
      url: `https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/${FFBINARIES_RELEASE}/ffprobe-6.1-${ffbinTarget}.zip`,
      archiveType: 'zip',
      entryName: platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
    });
  }

  const rawSupported =
    (platform === 'linux' && (arch === 'x64' || arch === 'ia32')) ||
    (platform === 'darwin' && arch === 'x64') ||
    (platform === 'win32' && (arch === 'x64' || arch === 'ia32'));
  if (rawSupported) {
    const ext = platform === 'win32' ? '.exe' : '';
    specs.push({
      url: `https://raw.githubusercontent.com/joshwnj/ffprobe-static/master/bin/${platform}/${arch}/ffprobe${ext}`,
      archiveType: 'raw',
    });
  }

  return specs;
}

function mapPlatformToFfbinariesTarget(
  platform: NodeJS.Platform,
  arch: string
): string | null {
  if (platform === 'linux') {
    if (arch === 'x64') return 'linux-64';
    if (arch === 'arm64') return 'linux-arm-64';
    if (arch === 'ia32') return 'linux-32';
  }
  if (platform === 'darwin') {
    return 'macos-64';
  }
  if (platform === 'win32') {
    return arch === 'ia32' ? 'win-32' : 'win-64';
  }
  return null;
}

/**
 * Minimal pure-Node ZIP single-entry extractor (supports Store method 0 and Deflate method 8)
 * using central directory headers so data-descriptor archives extract accurately with zero extra deps.
 */
export function extractSingleFileFromZipBuffer(
  zipBuffer: Buffer,
  expectedFileName: string
): Buffer {
  const EOCD_SIG = 0x06054b50;
  const CD_SIG = 0x02014b50;
  const LFH_SIG = 0x04034b50;

  // Locate End of Central Directory (EOCD) record from end of buffer
  const minEocdOffset = Math.max(0, zipBuffer.length - 65557);
  let eocdOffset = -1;
  for (let i = zipBuffer.length - 22; i >= minEocdOffset; i--) {
    if (zipBuffer.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Arsip ZIP tidak valid (EOCD tidak ditemukan).');
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
  const targetLower = expectedFileName.toLowerCase();

  let cursor = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (cursor + 46 > zipBuffer.length || zipBuffer.readUInt32LE(cursor) !== CD_SIG) {
      break;
    }
    const compressionMethod = zipBuffer.readUInt16LE(cursor + 10);
    const compressedSize = zipBuffer.readUInt32LE(cursor + 20);
    const nameLen = zipBuffer.readUInt16LE(cursor + 28);
    const extraLen = zipBuffer.readUInt16LE(cursor + 30);
    const commentLen = zipBuffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(cursor + 42);
    const entryName = zipBuffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    cursor += 46 + nameLen + extraLen + commentLen;

    const baseName = path.posix.basename(entryName.replace(/\\/g, '/')).toLowerCase();
    if (baseName !== targetLower && entryName.toLowerCase() !== targetLower) {
      continue;
    }

    if (
      localHeaderOffset + 30 > zipBuffer.length ||
      zipBuffer.readUInt32LE(localHeaderOffset) !== LFH_SIG
    ) {
      throw new Error('Header file lokal ZIP tidak valid.');
    }

    const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compressedSlice = zipBuffer.subarray(dataStart, dataStart + compressedSize);

    if (compressionMethod === 0) {
      return Buffer.from(compressedSlice);
    }
    if (compressionMethod === 8) {
      return zlib.inflateRawSync(compressedSlice);
    }
    throw new Error(`Metode kompresi ZIP tidak didukung (${compressionMethod}).`);
  }

  throw new Error(`File "${expectedFileName}" tidak ditemukan di dalam arsip ZIP.`);
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
let ffmpegDownloadPromise: Promise<string> | null = null;
let ffprobeDownloadPromise: Promise<string> | null = null;

function getRuntimeCachedBinaryPath(binary: MediaBinaryName): string {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(RUNTIME_BIN_DIR, `${binary}${ext}`);
}

function tryResolveLocalBinary(binary: MediaBinaryName): string | null {
  const envVar = binary === 'ffmpeg' ? process.env.FFMPEG_PATH : process.env.FFPROBE_PATH;
  const candidates = [
    envVar,
    getRuntimeCachedBinaryPath(binary),
    `/usr/bin/${binary}`,
    `/usr/local/bin/${binary}`,
    binary,
  ];
  try {
    return resolveBinaryFromCandidates(binary, candidates, DEFAULT_DEPS);
  } catch {
    return null;
  }
}

async function downloadAndInstallStaticBinary(
  binary: MediaBinaryName,
  specs: BinaryDownloadSpec[]
): Promise<string> {
  fs.mkdirSync(RUNTIME_BIN_DIR, { recursive: true });
  const targetPath = getRuntimeCachedBinaryPath(binary);
  const attempted: string[] = [];

  for (const spec of specs) {
    attempted.push(spec.url);
    const tmpPath = `${targetPath}.${Date.now()}.tmp`;
    try {
      const res = await fetch(spec.url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) continue;

      const rawBuf = Buffer.from(await res.arrayBuffer());
      if (rawBuf.byteLength < 1_000_000) continue;

      let binaryBuf: Buffer;
      if (spec.archiveType === 'gzip') {
        binaryBuf = zlib.gunzipSync(rawBuf);
      } else if (spec.archiveType === 'zip') {
        binaryBuf = extractSingleFileFromZipBuffer(
          rawBuf,
          spec.entryName ?? (process.platform === 'win32' ? `${binary}.exe` : binary)
        );
      } else {
        binaryBuf = rawBuf;
      }

      if (binaryBuf.byteLength < 1_000_000) continue;

      fs.writeFileSync(tmpPath, binaryBuf, { mode: 0o755 });
      fs.renameSync(tmpPath, targetPath);
      if (process.platform !== 'win32') {
        fs.chmodSync(targetPath, 0o755);
      }

      if (defaultCanExecute(targetPath)) {
        return targetPath;
      }
      if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    } catch {
      if (fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  throw new MissingMediaBinaryError(binary, attempted);
}

/**
 * Non-blocking synchronous check for health probes: returns an already-available
 * local or cached binary path, or null if runtime download hasn't finished yet.
 */
export function getAvailableFfmpegPathSync(): string | null {
  if (cachedFfmpegPath) return cachedFfmpegPath;
  const local = tryResolveLocalBinary('ffmpeg');
  if (local) cachedFfmpegPath = local;
  return local;
}

export function getAvailableFfprobePathSync(): string | null {
  if (cachedFfprobePath) return cachedFfprobePath;
  const local = tryResolveLocalBinary('ffprobe');
  if (local) cachedFfprobePath = local;
  return local;
}

/**
 * Guarantees an executable FFmpeg binary path.
 * Priority:
 *  1. `process.env.FFMPEG_PATH`
 *  2. Runtime cached static binary (`os.tmpdir()/klipcast-bin/ffmpeg`)
 *  3. System FFmpeg (`/usr/bin/ffmpeg`, `/usr/local/bin/ffmpeg`, `ffmpeg` on PATH)
 *  4. On-demand single-architecture static binary download from GitHub Releases (~29 MB gz)
 */
export async function ensureFfmpegPath(): Promise<string> {
  const existing = getAvailableFfmpegPathSync();
  if (existing) return existing;

  if (!ffmpegDownloadPromise) {
    ffmpegDownloadPromise = downloadAndInstallStaticBinary(
      'ffmpeg',
      buildFfmpegDownloadSpecs()
    )
      .then((resolved) => {
        cachedFfmpegPath = resolved;
        return resolved;
      })
      .finally(() => {
        ffmpegDownloadPromise = null;
      });
  }

  return ffmpegDownloadPromise;
}

/**
 * Guarantees an executable FFprobe binary path.
 * Priority:
 *  1. `process.env.FFPROBE_PATH`
 *  2. Runtime cached static binary (`os.tmpdir()/klipcast-bin/ffprobe`)
 *  3. System FFprobe (`/usr/bin/ffprobe`, `/usr/local/bin/ffprobe`, `ffprobe` on PATH)
 *  4. On-demand single-architecture static binary download from GitHub Releases (~29 MB zip)
 */
export async function ensureFfprobePath(): Promise<string> {
  const existing = getAvailableFfprobePathSync();
  if (existing) return existing;

  if (!ffprobeDownloadPromise) {
    ffprobeDownloadPromise = downloadAndInstallStaticBinary(
      'ffprobe',
      buildFfprobeDownloadSpecs()
    )
      .then((resolved) => {
        cachedFfprobePath = resolved;
        return resolved;
      })
      .finally(() => {
        ffprobeDownloadPromise = null;
      });
  }

  return ffprobeDownloadPromise;
}

/**
 * Creates a directory containing `ffmpeg` and `ffprobe` links pointing to our
 * resolved binaries so `yt-dlp --ffmpeg-location <dir>` always finds BOTH tools
 * even in minimal Cloud Run containers where neither is installed on system PATH.
 */
export async function ensureYtDlpFfmpegLocation(): Promise<string> {
  const [ffmpegPath, ffprobePath] = await Promise.all([
    ensureFfmpegPath(),
    ensureFfprobePath(),
  ]);

  const ext = process.platform === 'win32' ? '.exe' : '';
  if (
    cachedYtDlpBinDir &&
    fs.existsSync(cachedYtDlpBinDir) &&
    fs.existsSync(path.join(cachedYtDlpBinDir, `ffmpeg${ext}`))
  ) {
    return cachedYtDlpBinDir;
  }

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
    for (const item of [
      { name: `ffmpeg${ext}`, target: ffmpegPath },
      { name: `ffprobe${ext}`, target: ffprobePath },
    ]) {
      if (!path.isAbsolute(item.target)) continue;
      const linkPath = path.join(binDir, item.name);
      try {
        if (fs.lstatSync(linkPath)) fs.unlinkSync(linkPath);
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
    // Fallback to direct ffmpeg binary path
  }

  return ffmpegPath;
}

/**
 * Background startup prewarm: resolves system binaries immediately or downloads
 * single-arch static binaries into `/tmp/klipcast-bin/` on minimal Cloud Run containers.
 */
export async function prewarmMediaBinaries(): Promise<void> {
  try {
    await ensureYtDlpFfmpegLocation();
  } catch {
    // Silent background prewarm; render flow retries on demand if needed
  }
}

export function resetBinaryCacheForTest(): void {
  cachedFfmpegPath = null;
  cachedFfprobePath = null;
  cachedYtDlpBinDir = null;
  ffmpegDownloadPromise = null;
  ffprobeDownloadPromise = null;
}
