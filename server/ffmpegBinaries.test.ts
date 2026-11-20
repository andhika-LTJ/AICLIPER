import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { execFileSync } from 'child_process';
import {
  buildFfmpegDownloadSpecs,
  buildFfprobeDownloadSpecs,
  ensureFfmpegPath,
  ensureFfprobePath,
  ensureYtDlpFfmpegLocation,
  extractSingleFileFromZipBuffer,
  isMissingBinaryError,
  MissingMediaBinaryError,
  resetBinaryCacheForTest,
  resolveBinaryFromCandidates,
  selectYtDlpReleaseAsset,
} from './ffmpegBinaries';

/**
 * Helper: builds a minimal valid ZIP archive containing a single Deflate-compressed file.
 */
function buildSingleEntryDeflateZip(fileName: string, content: Buffer): Buffer {
  const nameBuf = Buffer.from(fileName, 'utf8');
  const compressed = zlib.deflateRawSync(content);

  // Local file header (30 bytes + name)
  const lfh = Buffer.alloc(30 + nameBuf.length);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(8, 8); // Deflate
  lfh.writeUInt32LE(compressed.length, 18);
  lfh.writeUInt32LE(content.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(lfh, 30);

  const cdOffset = lfh.length + compressed.length;

  // Central directory header (46 bytes + name)
  const cdh = Buffer.alloc(46 + nameBuf.length);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4);
  cdh.writeUInt16LE(20, 6);
  cdh.writeUInt16LE(8, 10); // Deflate
  cdh.writeUInt32LE(compressed.length, 20);
  cdh.writeUInt32LE(content.length, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt32LE(0, 42); // localHeaderOffset
  nameBuf.copy(cdh, 46);

  // End of central directory (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdh.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([lfh, compressed, cdh, eocd]);
}

test('resolveBinaryFromCandidates respects priority order and skips broken candidates', () => {
  const existing = new Set(['/bad/ffmpeg', '/good/ffmpeg', '/fallback/ffmpeg']);
  const working = new Set(['/good/ffmpeg', '/fallback/ffmpeg']);

  const picked = resolveBinaryFromCandidates(
    'ffmpeg',
    ['/missing/ffmpeg', '/bad/ffmpeg', '/good/ffmpeg', '/fallback/ffmpeg'],
    {
      exists: (p) => existing.has(p),
      ensureExecutable: (p) => existing.has(p),
      canExecute: (p) => working.has(p),
    }
  );

  assert.equal(picked, '/good/ffmpeg');
});

test('resolveBinaryFromCandidates falls back to bare PATH command when absolute binaries unavailable', () => {
  const picked = resolveBinaryFromCandidates('ffprobe', ['/nope/ffprobe', 'ffprobe'], {
    exists: () => false,
    ensureExecutable: () => false,
    canExecute: (p) => p === 'ffprobe',
  });

  assert.equal(picked, 'ffprobe');
});

test('resolveBinaryFromCandidates throws MissingMediaBinaryError when no binary works', () => {
  assert.throws(
    () =>
      resolveBinaryFromCandidates('ffmpeg', ['/missing/a', 'ffmpeg'], {
        exists: () => false,
        ensureExecutable: () => false,
        canExecute: () => false,
      }),
    (err: unknown) =>
      err instanceof MissingMediaBinaryError &&
      err.binary === 'ffmpeg' &&
      err.code === 'MISSING_MEDIA_BINARY'
  );
});

test('extractSingleFileFromZipBuffer inflates Deflate-compressed binary entry accurately', () => {
  const payload = Buffer.from('ELF_TEST_FFPROBE_BINARY_PAYLOAD_1234567890');
  const zip = buildSingleEntryDeflateZip('ffprobe', payload);
  const extracted = extractSingleFileFromZipBuffer(zip, 'ffprobe');
  assert.deepEqual(extracted, payload);
});

test('buildFfmpegDownloadSpecs & buildFfprobeDownloadSpecs pick single-arch URLs per OS', () => {
  const linuxFfmpeg = buildFfmpegDownloadSpecs('linux', 'x64');
  assert.ok(linuxFfmpeg[0].url.endsWith('ffmpeg-linux-x64.gz'));
  assert.equal(linuxFfmpeg[0].archiveType, 'gzip');

  const linuxFfprobe = buildFfprobeDownloadSpecs('linux', 'x64');
  assert.ok(linuxFfprobe[0].url.endsWith('ffprobe-6.1-linux-64.zip'));
  assert.equal(linuxFfprobe[0].archiveType, 'zip');
});

test('ensureFfmpegPath, ensureFfprobePath, and ensureYtDlpFfmpegLocation resolve working binaries', async () => {
  resetBinaryCacheForTest();
  const ffmpegBin = await ensureFfmpegPath();
  const ffprobeBin = await ensureFfprobePath();

  assert.ok(ffmpegBin.length > 0);
  assert.ok(ffprobeBin.length > 0);

  const ffmpegVersion = execFileSync(ffmpegBin, ['-version'], { encoding: 'utf8' });
  const ffprobeVersion = execFileSync(ffprobeBin, ['-version'], { encoding: 'utf8' });
  assert.match(ffmpegVersion, /ffmpeg version/i);
  assert.match(ffprobeVersion, /ffprobe version/i);

  const ytDlpLoc = await ensureYtDlpFfmpegLocation();
  assert.ok(fs.existsSync(ytDlpLoc));
  if (fs.statSync(ytDlpLoc).isDirectory()) {
    assert.ok(fs.existsSync(path.join(ytDlpLoc, 'ffmpeg')));
    assert.ok(fs.existsSync(path.join(ytDlpLoc, 'ffprobe')));
  }
  resetBinaryCacheForTest();
});

test('selectYtDlpReleaseAsset picks correct standalone asset per OS and architecture', () => {
  assert.equal(selectYtDlpReleaseAsset('linux', 'x64').assetName, 'yt-dlp_linux');
  assert.equal(selectYtDlpReleaseAsset('linux', 'arm64').assetName, 'yt-dlp_linux_aarch64');
  assert.equal(selectYtDlpReleaseAsset('darwin', 'arm64').assetName, 'yt-dlp_macos');
  assert.equal(selectYtDlpReleaseAsset('win32', 'x64').assetName, 'yt-dlp.exe');
});

test('isMissingBinaryError distinguishes ENOENT binary errors from YouTube bot-block errors', () => {
  assert.equal(isMissingBinaryError(new MissingMediaBinaryError('ffmpeg', ['ffmpeg'])), true);
  assert.equal(
    isMissingBinaryError(Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })),
    true
  );
  assert.equal(isMissingBinaryError(new Error('spawn ffprobe ENOENT')), true);
  assert.equal(isMissingBinaryError(new Error('Sign in to confirm you are not a bot')), false);
});
