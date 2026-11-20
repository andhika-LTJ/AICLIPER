import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRenderBackoffMs,
  isTransientRenderHttpStatus,
} from './renderJobClient';

test('isTransientRenderHttpStatus treats 429 and 5xx gateway statuses as recoverable', () => {
  assert.equal(isTransientRenderHttpStatus(429), true);
  assert.equal(isTransientRenderHttpStatus(502), true);
  assert.equal(isTransientRenderHttpStatus(503), true);
  assert.equal(isTransientRenderHttpStatus(504), true);
  assert.equal(isTransientRenderHttpStatus(408), true);
  assert.equal(isTransientRenderHttpStatus(400), false);
  assert.equal(isTransientRenderHttpStatus(404), false);
});

test('computeRenderBackoffMs respects Retry-After and scales smoothly on 429', () => {
  assert.equal(
    computeRenderBackoffMs({ status: 429, attempt: 1, retryAfterHeader: '7' }),
    7000
  );
  assert.equal(
    computeRenderBackoffMs({ status: 429, attempt: 1, retryAfterHeader: '99' }),
    20000
  );
  const first429 = computeRenderBackoffMs({ status: 429, attempt: 1 });
  const later429 = computeRenderBackoffMs({ status: 429, attempt: 4 });
  assert.ok(first429 >= 4500);
  assert.ok(later429 > first429 && later429 <= 16000);
});
