import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChunkedDownloadPlan,
  DOWNLOAD_CHUNK_BYTES,
  formatMegabytes,
} from './chunkedDownload';

test('buildChunkedDownloadPlan splits a 90 MiB 4K master MP4 into exact 4 MiB inclusive ranges', () => {
  const totalBytes = 90 * 1024 * 1024 + 512;
  const plan = buildChunkedDownloadPlan(totalBytes, DOWNLOAD_CHUNK_BYTES);
  assert.equal(plan.length, 23);
  assert.equal(plan[0].start, 0);
  assert.equal(plan[0].end, DOWNLOAD_CHUNK_BYTES - 1);
  assert.equal(plan[plan.length - 1].end, totalBytes - 1);

  // Verify contiguous coverage with zero gaps or overlaps
  for (let i = 1; i < plan.length; i++) {
    assert.equal(plan[i].start, plan[i - 1].end + 1);
  }
});

test('formatMegabytes formats byte counts cleanly', () => {
  assert.equal(formatMegabytes(0), '0.0 MB');
  assert.equal(formatMegabytes(52_428_800), '50.0 MB');
});
