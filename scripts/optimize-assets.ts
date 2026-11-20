import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getAvailableFfmpegPathSync } from '../server/ffmpegBinaries.ts';
import { getConfiguredAssetCdnBaseUrl } from '../src/utils/assetUrl.ts';
import {
  buildAssetCdnManifest,
  buildFfmpegOptimizeArgs,
  DEFAULT_BUNDLE_BUDGET_OPTIONS,
  DEFAULT_IMAGE_OPTIMIZATION_OPTIONS,
  evaluateBundleBudget,
  formatKilobytes,
  shouldOptimizeImage,
  type BundleAssetEntry,
} from './assetOptimizer.ts';

const ROOT_DIR = process.cwd();
const SCAN_SOURCE_DIRS = [
  path.join(ROOT_DIR, 'src', 'assets'),
  path.join(ROOT_DIR, 'public'),
];
const DIST_DIR = path.join(ROOT_DIR, 'dist');

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function optimizeSourceImages(): void {
  const candidates: Array<{ fullPath: string; relPath: string; sizeBytes: number }> = [];

  for (const dir of SCAN_SOURCE_DIRS) {
    for (const fullPath of walkFiles(dir)) {
      const relPath = path.relative(ROOT_DIR, fullPath);
      const sizeBytes = fs.statSync(fullPath).size;
      if (shouldOptimizeImage(relPath, sizeBytes, DEFAULT_IMAGE_OPTIMIZATION_OPTIONS)) {
        candidates.push({ fullPath, relPath, sizeBytes });
      }
    }
  }

  if (candidates.length === 0) {
    console.log('[optimize-assets] Semua gambar aset sudah ringkas (< 120 KB).');
    return;
  }

  const ffmpegBin = getAvailableFfmpegPathSync();
  if (!ffmpegBin) {
    console.log(
      `[optimize-assets] FFmpeg belum tersedia saat build — melewati kompresi otomatis untuk ${candidates.length} gambar.`
    );
    return;
  }

  let optimizedCount = 0;
  let savedBytes = 0;

  for (const item of candidates) {
    const ext = path.extname(item.fullPath);
    const tmpOut = `${item.fullPath}.opt_${Date.now()}${ext}`;
    try {
      const args = buildFfmpegOptimizeArgs(
        item.fullPath,
        tmpOut,
        DEFAULT_IMAGE_OPTIMIZATION_OPTIONS
      );
      execFileSync(ffmpegBin, args, { stdio: 'ignore', timeout: 20_000 });
      if (fs.existsSync(tmpOut)) {
        const newSize = fs.statSync(tmpOut).size;
        if (newSize > 0 && newSize < item.sizeBytes * 0.95) {
          fs.renameSync(tmpOut, item.fullPath);
          optimizedCount++;
          savedBytes += item.sizeBytes - newSize;
          console.log(
            `[optimize-assets] ${item.relPath}: ${formatKilobytes(item.sizeBytes)} -> ${formatKilobytes(newSize)}`
          );
        } else {
          fs.unlinkSync(tmpOut);
        }
      }
    } catch {
      if (fs.existsSync(tmpOut)) {
        try {
          fs.unlinkSync(tmpOut);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  if (optimizedCount > 0) {
    console.log(
      `[optimize-assets] Selesai mengompresi ${optimizedCount} gambar (hemat ${formatKilobytes(savedBytes)}).`
    );
  } else {
    console.log('[optimize-assets] Semua gambar sudah optimal.');
  }
}

function checkDistBudgetAndGenerateCdnManifest(): void {
  if (!fs.existsSync(DIST_DIR)) {
    console.warn('[optimize-assets] Folder dist/ tidak ditemukan.');
    return;
  }

  // Remove unreferenced AI Studio chat upload screenshots copied from public/assets/aistudio
  const distAiStudioDir = path.join(DIST_DIR, 'assets', 'aistudio');
  if (fs.existsSync(distAiStudioDir)) {
    fs.rmSync(distAiStudioDir, { recursive: true, force: true });
  }

  const distFiles: BundleAssetEntry[] = walkFiles(DIST_DIR).map((fullPath) => ({
    relativePath: path.relative(DIST_DIR, fullPath).replace(/\\/g, '/'),
    sizeBytes: fs.statSync(fullPath).size,
  }));

  const report = evaluateBundleBudget(distFiles, DEFAULT_BUNDLE_BUDGET_OPTIONS);
  console.log(
    `[optimize-assets] Audit dist/: ${report.fileCount} file, total ${formatKilobytes(report.totalBytes)} (batas ${formatKilobytes(DEFAULT_BUNDLE_BUDGET_OPTIONS.maxTotalBytes)}).`
  );

  if (report.oversizedFiles.length > 0) {
    console.warn(
      '[optimize-assets] Peringatan: ditemukan file besar yang disarankan dipindah ke Cloud Storage / CDN (VITE_ASSET_CDN_BASE_URL):'
    );
    for (const f of report.oversizedFiles) {
      console.warn(`  - ${f.relativePath} (${formatKilobytes(f.sizeBytes)})`);
    }
  }

  const cdnBase = getConfiguredAssetCdnBaseUrl();
  if (cdnBase) {
    const srcAssetsDir = path.join(ROOT_DIR, 'src', 'assets');
    const sourceAssets: BundleAssetEntry[] = walkFiles(srcAssetsDir).map((fullPath) => ({
      relativePath: path.relative(ROOT_DIR, fullPath).replace(/\\/g, '/'),
      sizeBytes: fs.statSync(fullPath).size,
    }));
    const manifest = buildAssetCdnManifest(sourceAssets, cdnBase);
    fs.writeFileSync(
      path.join(DIST_DIR, 'asset-cdn-manifest.json'),
      JSON.stringify({ cdnBaseUrl: cdnBase, assets: manifest }, null, 2),
      'utf-8'
    );
    console.log(
      `[optimize-assets] Manifest CDN (${manifest.length} aset) ditulis ke dist/asset-cdn-manifest.json untuk ${cdnBase}`
    );
  }
}

const args = new Set(process.argv.slice(2));
if (args.has('--check-dist')) {
  checkDistBudgetAndGenerateCdnManifest();
} else {
  optimizeSourceImages();
}
