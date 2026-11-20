import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  getFfmpegPath,
  getFfprobePath,
  getYtDlpFfmpegLocation,
  isMissingBinaryError,
  MissingMediaBinaryError,
  resetBinaryCacheForTest,
  resolveBinaryFromCandidates,
  selectYtDlpReleaseAsset,
} from './ffmpegBinaries';

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

test('bundled ffmpeg and ffprobe resolve and execute cleanly without system PATH', () => {
  resetBinaryCacheForTest();
  const prevPath = process.env.PATH;
  try {
    // Simulate a minimal Cloud Run container where system /usr/bin/ffmpeg is not on PATH
    process.env.PATH = '';
    const ffmpegBin = getFfmpegPath();
    const ffprobeBin = getFfprobePath();

    assert.ok(path.isAbsolute(ffmpegBin), `Expected absolute ffmpeg path, got ${ffmpegBin}`);
    assert.ok(path.isAbsolute(ffprobeBin), `Expected absolute ffprobe path, got ${ffprobeBin}`);
    assert.ok(fs.existsSync(ffmpegBin));
    assert.ok(fs.existsSync(ffprobeBin));

    const ffmpegVersion = execFileSync(ffmpegBin, ['-version'], { encoding: 'utf8' });
    const ffprobeVersion = execFileSync(ffprobeBin, ['-version'], { encoding: 'utf8' });
    assert.match(ffmpegVersion, /ffmpeg version/i);
    assert.match(ffprobeVersion, /ffprobe version/i);

    const ytDlpLoc = getYtDlpFfmpegLocation();
    assert.ok(fs.existsSync(ytDlpLoc));
    if (fs.statSync(ytDlpLoc).isDirectory()) {
      assert.ok(fs.existsSync(path.join(ytDlpLoc, 'ffmpeg')));
      assert.ok(fs.existsSync(path.join(ytDlpLoc, 'ffprobe')));
    }
  } finally {
    process.env.PATH = prevPath;
    resetBinaryCacheForTest();
  }
});

test('selectYtDlpReleaseAsset picks correct standalone asset per OS and architecture', () => {
  assert.equal(selectYtDlpReleaseAsset('linux', 'x64').assetName, 'yt-dlp_linux');
  assert.equal(selectYtDlpReleaseAsset('linux', 'arm64').assetName, 'yt-dlp_linux_aarch64');
  assert.equal(selectYtDlpReleaseAsset('darwin', 'arm64').assetName, 'yt-dlp_macos');
  assert.equal(selectYtDlpReleaseAsset('win32', 'x64').assetName, 'yt-dlp.exe');
});

test('isMissingBinaryError distinguishes ENOENT binary errors from YouTube bot-block errors', () => {
  assert.equal(isMissingBinaryError(new MissingMediaBinaryError('ffmpeg', ['ffmpeg'])), true);
  assert.equal(isMissingBinaryError(Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })), true);
  assert.equal(isMissingBinaryError(new Error('spawn ffprobe ENOENT')), true);
  assert.equal(isMissingBinaryError(new Error('Sign in to confirm you are not a bot')), false);
});
