import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderJobManager } from './renderJobManager';

test('RenderJobManager reuses identical running job and preempts different running jobs', () => {
  const manager = new RenderJobManager();

  const first = manager.createOrReuse({
    clipId: 'clip-1',
    dedupeKey: 'clip-1:shorts_full_bleed:1080p:emo1:0-45',
    initialStage: 'Starting 1',
  });
  assert.equal(first.reused, false);
  assert.equal(first.preemptedJobIds.length, 0);
  assert.equal(manager.listActive().length, 1);

  const same = manager.createOrReuse({
    clipId: 'clip-1',
    dedupeKey: 'clip-1:shorts_full_bleed:1080p:emo1:0-45',
    initialStage: 'Starting 1 again',
  });
  assert.equal(same.reused, true);
  assert.equal(same.job.jobId, first.job.jobId);
  assert.equal(first.job.abortController.signal.aborted, false);

  const second = manager.createOrReuse({
    clipId: 'clip-1',
    dedupeKey: 'clip-1:shorts_full_bleed:1080p:emo0:0-45',
    initialStage: 'Starting 2',
  });
  assert.equal(second.reused, false);
  assert.deepEqual(second.preemptedJobIds, [first.job.jobId]);
  assert.equal(first.job.status, 'cancelled');
  assert.equal(first.job.abortController.signal.aborted, true);
  assert.equal(manager.listActive().length, 1);
  assert.equal(manager.listActive()[0].jobId, second.job.jobId);
});

test('RenderJobManager cancel & cancelAllRunning abort signals and ignore late completion/failure', () => {
  const manager = new RenderJobManager();
  const { job } = manager.createOrReuse({
    clipId: 'clip-2',
    dedupeKey: 'clip-2:1080p',
    initialStage: 'Running',
  });

  const cancelled = manager.cancel(job.jobId);
  assert.equal(cancelled.found, true);
  assert.equal(cancelled.wasRunning, true);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.code, 'CANCELLED');
  assert.equal(job.abortController.signal.aborted, true);
  assert.equal(manager.listActive().length, 0);

  // Late progress/complete/fail callbacks from dying worker must NOT overwrite cancelled status
  manager.updateProgress(job.jobId, 'Late progress', 80);
  assert.equal(job.progress, 8);
  assert.equal(manager.complete(job.jobId, { videoUrl: '/late.mp4' }), false);
  assert.equal(job.status, 'cancelled');
  manager.fail(job.jobId, 'SIGKILL');
  assert.equal(job.status, 'cancelled');
});

test('RenderJobManager cancelAllRunning clears active queue completely', () => {
  const manager = new RenderJobManager();
  const { job } = manager.createOrReuse({
    clipId: 'clip-3',
    dedupeKey: 'clip-3:4k',
    initialStage: 'Rendering 4K',
  });

  const ids = manager.cancelAllRunning();
  assert.deepEqual(ids, [job.jobId]);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.abortController.signal.aborted, true);
  assert.equal(manager.listActive().length, 0);
});
