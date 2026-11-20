import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCdnBaseUrl, resolveAssetUrl } from './assetUrl';

test('normalizeCdnBaseUrl trims trailing slashes and rejects non-HTTP schemes', () => {
  assert.equal(
    normalizeCdnBaseUrl('https://storage.googleapis.com/klipcast-assets///'),
    'https://storage.googleapis.com/klipcast-assets'
  );
  assert.equal(normalizeCdnBaseUrl('  http://cdn.example.com/static/  '), 'http://cdn.example.com/static');
  assert.equal(normalizeCdnBaseUrl(''), null);
  assert.equal(normalizeCdnBaseUrl('ftp://cdn.example.com'), null);
  assert.equal(normalizeCdnBaseUrl('/relative/path'), null);
});

test('resolveAssetUrl keeps local paths intact when no CDN base URL is configured', () => {
  assert.equal(
    resolveAssetUrl('/src/assets/images/podcast_studio_tech_1794847026161.jpg', null),
    '/src/assets/images/podcast_studio_tech_1794847026161.jpg'
  );
});

test('resolveAssetUrl maps local src/public asset paths cleanly to Cloud Storage / CDN URLs', () => {
  const cdn = 'https://storage.googleapis.com/klipcast-cdn/';
  assert.equal(
    resolveAssetUrl('/src/assets/images/podcast_studio_tech_1794847026161.jpg', cdn),
    'https://storage.googleapis.com/klipcast-cdn/assets/images/podcast_studio_tech_1794847026161.jpg'
  );
  assert.equal(
    resolveAssetUrl('/public/assets/hero.webp', cdn),
    'https://storage.googleapis.com/klipcast-cdn/assets/hero.webp'
  );
  assert.equal(
    resolveAssetUrl('/favicon.ico', cdn),
    'https://storage.googleapis.com/klipcast-cdn/favicon.ico'
  );
});

test('resolveAssetUrl leaves external HTTP(S), data, and blob URLs untouched', () => {
  const cdn = 'https://cdn.klipcast.id';
  assert.equal(
    resolveAssetUrl('https://i.ytimg.com/vi/aircAruvnKk/hqdefault.jpg', cdn),
    'https://i.ytimg.com/vi/aircAruvnKk/hqdefault.jpg'
  );
  assert.equal(resolveAssetUrl('data:image/png;base64,AAAA', cdn), 'data:image/png;base64,AAAA');
  assert.equal(resolveAssetUrl('blob:https://example.com/123', cdn), 'blob:https://example.com/123');
});
