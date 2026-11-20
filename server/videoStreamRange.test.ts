import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_RANGE_CHUNK_BYTES,
  resolveCappedByteRange,
} from './videoStreamRange';

test('resolveCappedByteRange caps open-ended bytes=0- on 120MB MP4 to 4 MiB chunks', () => {
  const totalSize = 120_423_174;
  const resolved = resolveCappedByteRange('bytes=0-', totalSize);
  assert.ok(resolved);
  assert.equal(resolved.status, 206);
  assert.equal(resolved.start, 0);
  assert.equal(resolved.end, DEFAULT_MAX_RANGE_CHUNK_BYTES - 1);
  assert.equal(resolved.chunkLength, DEFAULT_MAX_RANGE_CHUNK_BYTES);
  assert.equal(
    resolved.contentRange,
    `bytes 0-${DEFAULT_MAX_RANGE_CHUNK_BYTES - 1}/${totalSize}`
  );
});

test('resolveCappedByteRange preserves smaller explicit byte ranges intact', () => {
  const resolved = resolveCappedByteRange('bytes=1024-65535', 20_000_000);
  assert.ok(resolved);
  assert.equal(resolved.status, 206);
  assert.equal(resolved.start, 1024);
  assert.equal(resolved.end, 65535);
  assert.equal(resolved.chunkLength, 64512);
});

test('resolveCappedByteRange supports suffix ranges and rejects out-of-bounds ranges', () => {
  const suffix = resolveCappedByteRange('bytes=-1000', 50_000);
  assert.ok(suffix);
  assert.equal(suffix.status, 206);
  assert.equal(suffix.start, 49_000);
  assert.equal(suffix.end, 49_999);
  assert.equal(suffix.chunkLength, 1000);

  const oob = resolveCappedByteRange('bytes=999999-', 50_000);
  assert.ok(oob);
  assert.equal(oob.status, 416);
  assert.equal(oob.contentRange, 'bytes */50000');
});
