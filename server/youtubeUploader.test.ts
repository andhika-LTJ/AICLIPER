import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildYouTubeUploadMetadata,
  parseYouTubeApiError,
} from './youtubeUploader.ts';

test('buildYouTubeUploadMetadata ensures #Shorts in title/description and cleans hashtags', () => {
  const payload = buildYouTubeUploadMetadata({
    title: 'Dendam Kesumat Dokter Tirta ke Radit!',
    description: 'Podcast seru malam ini.',
    tags: ['#DokterTirta', '#RadityaDika', '#doktertirta', '#Shorts'],
    privacyStatus: 'unlisted',
  });

  assert.equal(payload.snippet.title, 'Dendam Kesumat Dokter Tirta ke Radit! #Shorts');
  assert.match(payload.snippet.description, /#Shorts/);
  assert.deepEqual(payload.snippet.tags, ['DokterTirta', 'RadityaDika', 'Shorts']);
  assert.equal(payload.status.privacyStatus, 'unlisted');
  assert.equal(payload.status.selfDeclaredMadeForKids, false);
});

test('buildYouTubeUploadMetadata truncates titles longer than 100 chars cleanly', () => {
  const longTitle = 'A'.repeat(120);
  const payload = buildYouTubeUploadMetadata({
    title: longTitle,
    description: '',
    privacyStatus: 'public',
    includeShortsTag: true,
  });

  assert.ok(payload.snippet.title.length <= 100);
  assert.ok(payload.snippet.title.endsWith('#Shorts'));
});

test('parseYouTubeApiError detects expired token and missing YouTube channel', () => {
  const authErr = parseYouTubeApiError(
    401,
    JSON.stringify({ error: { message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } })
  );
  assert.equal(authErr.needsReauth, true);
  assert.match(authErr.message, /kedaluwarsa|login/i);

  const channelErr = parseYouTubeApiError(
    401,
    JSON.stringify({
      error: { message: 'Unauthorized', errors: [{ reason: 'youtubeSignupRequired' }] },
    })
  );
  assert.equal(channelErr.needsReauth, false);
  assert.match(channelErr.message, /channel YouTube/i);
});
