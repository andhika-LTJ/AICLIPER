import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildCanonicalWatchUrl,
  extractNotubeDownloadUrl,
  extractNotubeServerIds,
  formatAmp4TrimArg,
  getQualityRank,
  normalizeThirdPartyMediaUrl,
  selectBestVideoStreamIndex,
  solveAltchaChallenge,
  solveSaveNowPow,
  validateNetscapeCookiesTxt,
} from './downloaderParsers';

test('extractNotubeServerIds parses inline server list and falls back cleanly', () => {
  const html = `<script>var a=[58,59,60,61,62],i=[80],s=null;</script>`;
  assert.deepEqual(extractNotubeServerIds(html), [58, 59, 60, 61, 62]);

  const fallback = extractNotubeServerIds('<html>no server list</html>');
  assert.ok(fallback.includes(60));
  assert.ok(fallback.length >= 5);
});

test('extractNotubeDownloadUrl finds downloadButton href and unescapes query params', () => {
  const html = `
    <div class="dl">
      <a id="downloadButton" class="btn btn-success" href="https://s60.notube.net/download.php?token=abc123&amp;key=xyz789" download>Download</a>
    </div>
  `;
  assert.equal(
    extractNotubeDownloadUrl(html),
    'https://s60.notube.net/download.php?token=abc123&key=xyz789'
  );
  assert.equal(extractNotubeDownloadUrl('<html>nothing</html>'), null);
});

test('formatAmp4TrimArg formats HH:MM:SS trim sections accurately', () => {
  assert.equal(formatAmp4TrimArg(215, 258), '*00:03:35-00:04:18');
  assert.equal(formatAmp4TrimArg(3665, 3720), '*01:01:05-01:02:00');
});

test('buildCanonicalWatchUrl normalizes 11-char IDs and preserves full URLs', () => {
  assert.equal(buildCanonicalWatchUrl('6QyRGE6Cg8E'), 'https://www.youtube.com/watch?v=6QyRGE6Cg8E');
  assert.equal(buildCanonicalWatchUrl('https://youtu.be/6QyRGE6Cg8E'), 'https://youtu.be/6QyRGE6Cg8E');
});

test('solveAltchaChallenge solves SHA-256 PoW challenge accurately', () => {
  const salt = 'test-salt-';
  const expectedNumber = 42;
  const challenge = createHash('sha256').update(`${salt}${expectedNumber}`).digest('hex');

  const token = solveAltchaChallenge({
    algorithm: 'SHA-256',
    challenge,
    salt,
    signature: 'sig-123',
    maxnumber: 1000,
  });

  const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  assert.equal(decoded.number, expectedNumber);
  assert.equal(decoded.challenge, challenge);
  assert.equal(decoded.signature, 'sig-123');
});

test('getQualityRank orders resolutions and selectBestVideoStreamIndex ignores png cover art', () => {
  assert.ok(getQualityRank('1080p') > getQualityRank('720p'));
  assert.ok(getQualityRank('720p') > getQualityRank('360p'));
  assert.equal(
    normalizeThirdPartyMediaUrl('https://cdn.example.com/file?name=/Hello World.mp4&amp;x=1'),
    'https://cdn.example.com/file?name=/Hello%20World.mp4&x=1'
  );
  const idx = selectBestVideoStreamIndex([
    { index: 0, codec_type: 'video', codec_name: 'h264', width: 640, height: 360 },
    { index: 1, codec_type: 'audio', codec_name: 'aac' },
    { index: 2, codec_type: 'video', codec_name: 'png', width: 1280, height: 720 },
    { index: 3, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
  ]);
  assert.equal(idx, 3);
});

test('solveSaveNowPow finds valid leading-zero SHA-256 nonce', () => {
  const salt = 'savenow-test-salt';
  const nonce = solveSaveNowPow(salt, 2);
  const hash = createHash('sha256').update(`${salt}:${nonce}`).digest('hex');
  assert.ok(hash.startsWith('00'));
});

test('validateNetscapeCookiesTxt accepts real YouTube cookies and rejects CLI commands', () => {
  const cliPaste = 'yt-dlp --download-sections "*13:20-14:10" "https://youtu.be/6QyRGE6Cg8E"';
  assert.equal(validateNetscapeCookiesTxt(cliPaste).valid, false);
  assert.equal(validateNetscapeCookiesTxt('random text without tabs').valid, false);

  const validCookies = [
    '# Netscape HTTP Cookie File',
    '.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tabc123xyz',
    '.youtube.com\tTRUE\t/\tTRUE\t1893456000\tHSID\tdef456uvw',
  ].join('\n');
  assert.equal(validateNetscapeCookiesTxt(validCookies).valid, true);
});

