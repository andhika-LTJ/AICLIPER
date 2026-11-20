import path from 'path';
import { resolveAssetUrl } from '../src/utils/assetUrl.ts';

export const OPTIMIZABLE_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export interface ImageOptimizationOptions {
  /** Only compress files larger than this byte threshold (default: 120 KiB) */
  minBytesToOptimize: number;
  /** Resize images wider than this pixel width while preserving aspect ratio (default: 1280) */
  maxWidthPx: number;
  /** FFmpeg MJPEG quality scale 2..31 (lower = higher quality; default: 5) */
  jpegQuality: number;
  /** FFmpeg WebP quality 0..100 (default: 80) */
  webpQuality: number;
  /** Subpath fragments to skip (e.g., AI Studio chat attachments) */
  ignorePathFragments: string[];
}

export const DEFAULT_IMAGE_OPTIMIZATION_OPTIONS: ImageOptimizationOptions = {
  minBytesToOptimize: 120 * 1024,
  maxWidthPx: 1280,
  jpegQuality: 5,
  webpQuality: 80,
  ignorePathFragments: ['public/assets/aistudio', 'public\\assets\\aistudio'],
};

export interface BundleAssetEntry {
  relativePath: string;
  sizeBytes: number;
}

export interface BundleBudgetOptions {
  /** Maximum total dist/ size in bytes (default: 25 MiB) */
  maxTotalBytes: number;
  /** Warn/flag individual files larger than this size for CDN offloading (default: 1.5 MiB) */
  maxSingleFileBytes: number;
}

export const DEFAULT_BUNDLE_BUDGET_OPTIONS: BundleBudgetOptions = {
  maxTotalBytes: 25 * 1024 * 1024,
  maxSingleFileBytes: 1.5 * 1024 * 1024,
};

export interface BundleBudgetReport {
  totalBytes: number;
  fileCount: number;
  oversizedFiles: BundleAssetEntry[];
  exceedsTotalBudget: boolean;
}

export interface AssetCdnManifestEntry {
  localPath: string;
  cdnKey: string;
  cdnUrl: string;
  sizeBytes: number;
}

export function shouldOptimizeImage(
  filePath: string,
  sizeBytes: number,
  options: ImageOptimizationOptions = DEFAULT_IMAGE_OPTIMIZATION_OPTIONS
): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  for (const frag of options.ignorePathFragments) {
    if (normalized.includes(frag.replace(/\\/g, '/'))) {
      return false;
    }
  }
  const ext = path.extname(normalized).toLowerCase();
  if (!OPTIMIZABLE_IMAGE_EXTENSIONS.has(ext)) {
    return false;
  }
  return sizeBytes >= options.minBytesToOptimize;
}

/**
 * Builds deterministic FFmpeg arguments for lossless-like web image optimization
 * (downscales images wider than `maxWidthPx` and compresses according to format).
 */
export function buildFfmpegOptimizeArgs(
  inputPath: string,
  outputPath: string,
  options: ImageOptimizationOptions = DEFAULT_IMAGE_OPTIMIZATION_OPTIONS
): string[] {
  const ext = path.extname(inputPath).toLowerCase();
  // Downscale only if iw > maxWidthPx; preserve aspect ratio with even height
  const scaleFilter = `scale='min(${options.maxWidthPx},iw)':-2`;

  if (ext === '.jpg' || ext === '.jpeg') {
    return [
      '-y',
      '-v',
      'error',
      '-i',
      inputPath,
      '-vf',
      scaleFilter,
      '-frames:v',
      '1',
      '-q:v',
      String(options.jpegQuality),
      outputPath,
    ];
  }

  if (ext === '.webp') {
    return [
      '-y',
      '-v',
      'error',
      '-i',
      inputPath,
      '-vf',
      scaleFilter,
      '-frames:v',
      '1',
      '-c:v',
      'libwebp',
      '-quality',
      String(options.webpQuality),
      outputPath,
    ];
  }

  // PNG optimization
  return [
    '-y',
    '-v',
    'error',
    '-i',
    inputPath,
    '-vf',
    scaleFilter,
    '-frames:v',
    '1',
    '-compression_level',
    '9',
    outputPath,
  ];
}

export function evaluateBundleBudget(
  files: BundleAssetEntry[],
  options: BundleBudgetOptions = DEFAULT_BUNDLE_BUDGET_OPTIONS
): BundleBudgetReport {
  let totalBytes = 0;
  const oversizedFiles: BundleAssetEntry[] = [];

  for (const file of files) {
    totalBytes += file.sizeBytes;
    if (file.sizeBytes > options.maxSingleFileBytes) {
      oversizedFiles.push(file);
    }
  }

  oversizedFiles.sort((a, b) => b.sizeBytes - a.sizeBytes);

  return {
    totalBytes,
    fileCount: files.length,
    oversizedFiles,
    exceedsTotalBudget: totalBytes > options.maxTotalBytes,
  };
}

export function buildAssetCdnManifest(
  files: BundleAssetEntry[],
  cdnBaseUrl: string
): AssetCdnManifestEntry[] {
  return files
    .map((file) => {
      const normalizedLocal = `/${file.relativePath.replace(/^\/+/, '').replace(/\\/g, '/')}`;
      const cdnKey = normalizedLocal.replace(/^\/+/, '').replace(/^src\//i, '').replace(/^public\//i, '');
      return {
        localPath: normalizedLocal,
        cdnKey,
        cdnUrl: resolveAssetUrl(normalizedLocal, cdnBaseUrl),
        sizeBytes: file.sizeBytes,
      };
    })
    .sort((a, b) => a.cdnKey.localeCompare(b.cdnKey));
}

export function formatKilobytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}
