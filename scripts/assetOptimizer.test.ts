import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAssetCdnManifest,
  buildFfmpegOptimizeArgs,
  DEFAULT_IMAGE_OPTIMIZATION_OPTIONS,
  evaluateBundleBudget,
  shouldOptimizeImage,
} from './assetOptimizer';

test('shouldOptimizeImage filters by image extension, size threshold, and ignored paths', () => {
  assert.equal(shouldOptimizeImage('src/assets/images/cover.jpg', 500_000), true);
  assert.equal(shouldOptimizeImage('src/assets/images/small.jpg', 50_000), false);
  assert.equal(shouldOptimizeImage('src/assets/images/icon.svg', 500_000), false);
  assert.equal(shouldOptimizeImage('public/assets/aistudio/image_123.png', 500_000), false);
});

test('buildFfmpegOptimizeArgs builds format-aware compression args with downscale cap', () => {
  const jpgArgs = buildFfmpegOptimizeArgs('in.jpg', 'out.jpg', DEFAULT_IMAGE_OPTIMIZATION_OPTIONS);
  assert.ok(jpgArgs.includes("scale='min(1280,iw)':-2"));
  assert.ok(jpgArgs.includes('-q:v'));

  const webpArgs = buildFfmpegOptimizeArgs('in.webp', 'out.webp', DEFAULT_IMAGE_OPTIMIZATION_OPTIONS);
  assert.ok(webpArgs.includes('libwebp'));
  assert.ok(webpArgs.includes('-quality'));

  const pngArgs = buildFfmpegOptimizeArgs('in.png', 'out.png', DEFAULT_IMAGE_OPTIMIZATION_OPTIONS);
  assert.ok(pngArgs.includes('-compression_level'));
});

test('evaluateBundleBudget detects oversized single assets and total budget overruns', () => {
  const report = evaluateBundleBudget(
    [
      { relativePath: 'assets/index.js', sizeBytes: 1_100_000 },
      { relativePath: 'src/assets/images/huge.jpg', sizeBytes: 3_200_000 },
    ],
    {
      maxTotalBytes: 4_000_000,
      maxSingleFileBytes: 1_500_000,
    }
  );

  assert.equal(report.fileCount, 2);
  assert.equal(report.totalBytes, 4_300_000);
  assert.equal(report.exceedsTotalBudget, true);
  assert.equal(report.oversizedFiles.length, 1);
  assert.equal(report.oversizedFiles[0].relativePath, 'src/assets/images/huge.jpg');
});

test('buildAssetCdnManifest generates clean bucket keys and external CDN URLs', () => {
  const manifest = buildAssetCdnManifest(
    [
      { relativePath: 'src/assets/images/podcast_studio_tech_1794847026161.jpg', sizeBytes: 51200 },
      { relativePath: 'src/assets/images/podcast_creator_desk_1794847027324.jpg', sizeBytes: 43000 },
    ],
    'https://storage.googleapis.com/klipcast-media/'
  );

  assert.equal(manifest.length, 2);
  assert.equal(manifest[0].cdnKey, 'assets/images/podcast_creator_desk_1794847027324.jpg');
  assert.equal(
    manifest[0].cdnUrl,
    'https://storage.googleapis.com/klipcast-media/assets/images/podcast_creator_desk_1794847027324.jpg'
  );
});
