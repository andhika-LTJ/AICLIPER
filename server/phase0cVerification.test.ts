import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import express from 'express';
import { KlipCastDatabase } from './db.ts';
import {
  isTransientPgError,
  resolvePgPoolConfig,
  withPgRetry,
} from '../src/db/index.ts';
import {
  computeFileSha256,
  downloadMediaToLocalPath,
  uploadLocalFileToStorage,
  type GcsClientAdapter,
  type GcsConfig,
} from './services/gcsStorageService.ts';
import {
  enqueueCloudTask,
  getCloudTasksConfig,
  type CloudTasksClientAdapter,
} from './services/cloudTasksService.ts';
import { createInternalDispatchRouter } from './routes/internalDispatchRoutes.ts';
import { V3Repository } from './repositories/v3Repository.ts';
import { createV3Router } from './routes/v3ProductionRoutes.ts';
import {
  executeRenderWorkerJob,
  type ExecuteRenderWorkerOptions,
} from '../workers/renderWorker.ts';
import type { AuthenticatedRequest } from './authMiddleware.ts';
import { runLiveGcpVerification } from '../scripts/verify-live-gcp.ts';
import type { PodcastClip } from '../src/types/clipper.ts';

const testTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicliper-phase0c-test-'));
const testDbPath = path.join(testTempRoot, 'phase0c.sqlite');
const db = new KlipCastDatabase({ dbPath: testDbPath, dataDir: testTempRoot });

after(() => {
  try {
    db.close();
  } catch {
    // Ignore close errors
  }
  try {
    fs.rmSync(testTempRoot, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

function seedUserEpisodeClip(uid: string, suffix: string): {
  episodeId: string;
  clipId: string;
  sourceFilePath: string;
  sourceObjectKey: string;
} {
  db.upsertAuthenticatedUser({
    uid,
    email: `${uid}@example.test`,
    displayName: `User ${suffix}`,
    photoUrl: null,
    resolvedRole: 'user',
  });
  db.updateUserPlan(uid, 'pro');
  const episodeId = `ep_0c_${suffix}`;
  const clipId = `clip_0c_${suffix}`;
  const sourceFilePath = path.join(testTempRoot, `src_${suffix}.mp4`);
  fs.writeFileSync(sourceFilePath, Buffer.from(`fake-mp4-source-${suffix}-payload-1234567890`));
  const sourceObjectKey = `users/${uid}/projects/${episodeId}/sources/source_${suffix}.mp4`;

  const now = new Date().toISOString();
  db.upsertEpisode(uid, {
    id: episodeId,
    userUid: uid,
    videoId: `vid_${suffix}`,
    sourceUrl: `https://youtube.com/watch?v=${suffix}`,
    title: `Episode ${suffix}`,
    channelName: 'Test Channel',
    durationSec: 120,
    thumbnailUrl: '',
    fallbackImageUrl: '/assets/placeholder-podcast.jpg',
    hasUploadedSourceVideo: true,
    transcriptSource: 'manual_transcript',
    episodeSummary: 'Ringkasan episode test Phase 0C.',
    keyTopics: ['Cloud SQL', 'GCS', 'Cloud Run'],
    createdAt: now,
  });

  const clip: PodcastClip = {
    id: clipId,
    episodeId,
    userUid: uid,
    orderIndex: 1,
    title: `Clip ${suffix}`,
    startSec: 0,
    endSec: 15,
    hookLine: 'Hook test Phase 0C',
    ringkasanTeks: 'Ringkasan klip test Phase 0C',
    poinKunci: ['Stale lock', 'SIGTERM', 'SHA-256'],
    transcriptExcerpt: 'Halo dunia test Phase 0C.',
    priorityLabel: 'Sorotan Utama',
    viralScore: 90,
    status: 'draft',
    publishedPlatforms: [],
    captionCues: [
      { offsetSec: 0, durationSec: 5, text: 'Halo dunia' },
    ],
    platformCopies: {
      youtube_shorts: { title: 'Clip 0C #Shorts', caption: 'Caption', hashtags: ['#Shorts'] },
      tiktok: { title: 'Clip 0C', caption: 'Caption', hashtags: ['#AICLIPER'] },
      instagram_reels: { title: 'Clip 0C', caption: 'Caption', hashtags: ['#AICLIPER'] },
      facebook_reels: { title: 'Clip 0C', caption: 'Caption', hashtags: ['#AICLIPER'] },
      linkedin: { title: 'Clip 0C', caption: 'Caption', hashtags: ['#AICLIPER'] },
      x_twitter: { title: 'Clip 0C', caption: 'Caption', hashtags: ['#AICLIPER'] },
    },
  };
  db.upsertClip(uid, clip);

  return { episodeId, clipId, sourceFilePath, sourceObjectKey };
}

async function sendExpressRequest(
  app: express.Express,
  method: 'GET' | 'POST',
  urlPath: string,
  options: {
    headers?: Record<string, string>;
    body?: unknown;
  } = {}
): Promise<{ status: number; json: Record<string, unknown> }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', async () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Failed to bind ephemeral port'));
        return;
      }
      try {
        const resp = await fetch(`http://127.0.0.1:${addr.port}${urlPath}`, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(options.headers ?? {}),
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        });
        const text = await resp.text();
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          parsed = { raw: text };
        }
        resolve({ status: resp.status, json: parsed });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

describe('Fase 0C — Production Deployment Hardening & Verification', () => {
  it('1. PostgreSQL resolves CLOUD_SQL_* aliases and retries transient errors without retrying permanent SQL errors', async () => {
    const prevEnv = {
      SQL_INSTANCE_CONNECTION_NAME: process.env.SQL_INSTANCE_CONNECTION_NAME,
      CLOUD_SQL_CONNECTION_NAME: process.env.CLOUD_SQL_CONNECTION_NAME,
      SQL_DB_NAME: process.env.SQL_DB_NAME,
      CLOUD_SQL_DATABASE: process.env.CLOUD_SQL_DATABASE,
      SQL_USER: process.env.SQL_USER,
      CLOUD_SQL_USER: process.env.CLOUD_SQL_USER,
      SQL_PASSWORD: process.env.SQL_PASSWORD,
      SQL_HOST: process.env.SQL_HOST,
    };

    try {
      delete process.env.SQL_INSTANCE_CONNECTION_NAME;
      delete process.env.SQL_DB_NAME;
      delete process.env.SQL_USER;
      delete process.env.SQL_HOST;
      process.env.CLOUD_SQL_CONNECTION_NAME = 'proj:asia-southeast2:aicliper-pg';
      process.env.CLOUD_SQL_DATABASE = 'aicliper_prod';
      process.env.CLOUD_SQL_USER = 'aicliper_app';
      process.env.SQL_PASSWORD = 'test-secret-value';

      const cfg = resolvePgPoolConfig();
      assert.equal(cfg.configured, true);
      assert.equal(cfg.connectionMode, 'cloud_sql_unix_socket');
      assert.equal(cfg.poolConfig?.database, 'aicliper_prod');
      assert.equal(cfg.poolConfig?.user, 'aicliper_app');
      assert.equal(cfg.poolConfig?.host, '/cloudsql/proj:asia-southeast2:aicliper-pg');
    } finally {
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    assert.equal(isTransientPgError({ code: '57P01' }), true);
    assert.equal(isTransientPgError({ code: 'ECONNRESET' }), true);
    assert.equal(isTransientPgError({ code: '23505' }), false);

    let transientAttempts = 0;
    const recovered = await withPgRetry(
      async () => {
        transientAttempts += 1;
        if (transientAttempts < 2) {
          const err = new Error('admin shutdown') as Error & { code?: string };
          err.code = '57P01';
          throw err;
        }
        return 'ok-after-retry';
      },
      { maxAttempts: 3, baseDelayMs: 5 }
    );
    assert.equal(recovered, 'ok-after-retry');
    assert.equal(transientAttempts, 2);

    let permanentAttempts = 0;
    await assert.rejects(
      () =>
        withPgRetry(
          async () => {
            permanentAttempts += 1;
            const err = new Error('duplicate key') as Error & { code?: string };
            err.code = '23505';
            throw err;
          },
          { maxAttempts: 3, baseDelayMs: 5 }
        ),
      /duplicate key/
    );
    assert.equal(permanentAttempts, 1);
  });

  it('2. GCS upload retries transient 503 errors, returns SHA-256 checksum, enforces checksum verification, and refuses local fallback in production', async () => {
    const srcPath = path.join(testTempRoot, 'gcs_retry_sample.mp4');
    fs.writeFileSync(srcPath, Buffer.from('phase-0c-gcs-integrity-payload-abcdef'));
    const expectedHash = computeFileSha256(srcPath);

    let uploadAttempts = 0;
    const gcsPayloadStore = new Map<string, Buffer>();
    const mockAdapter: GcsClientAdapter = {
      checkBucketAccess: async () => true,
      uploadFile: async (localPath, objectKey) => {
        uploadAttempts += 1;
        if (uploadAttempts === 1) {
          const err = new Error('503 Service Unavailable') as Error & { code?: number };
          err.code = 503;
          throw err;
        }
        gcsPayloadStore.set(objectKey, fs.readFileSync(localPath));
      },
      downloadFile: async (objectKey, destPath) => {
        const content = gcsPayloadStore.get(objectKey);
        if (!content) throw new Error('Not found');
        fs.writeFileSync(destPath, content);
      },
      getSignedReadUrl: async (objectKey) =>
        `https://storage.googleapis.com/mock-signed/${encodeURIComponent(objectKey)}`,
      deleteFile: async (objectKey) => {
        gcsPayloadStore.delete(objectKey);
      },
      exists: async (objectKey) => gcsPayloadStore.has(objectKey),
    };

    const gcsOverride: Partial<GcsConfig> = {
      bucketName: 'aicliper-test-bucket',
      strictProduction: true,
    };

    const stored = await uploadLocalFileToStorage({
      localFilePath: srcPath,
      userUid: 'uid_gcs_a',
      projectId: 'proj_1',
      category: 'renders',
      filename: 'clip_retry.mp4',
      contentType: 'video/mp4',
      retryBaseDelayMs: 1,
      sleepFn: async () => undefined,
      configOverride: gcsOverride,
      gcsAdapter: mockAdapter,
    });

    assert.equal(stored.backend, 'gcs');
    assert.equal(stored.sha256, expectedHash);
    assert.equal(stored.attemptsUsed, 2);
    assert.equal(uploadAttempts, 2);

    // Verified download with matching SHA-256 succeeds
    const dlOk = path.join(testTempRoot, 'gcs_dl_ok.mp4');
    await downloadMediaToLocalPath({
      objectKey: stored.objectKey,
      requesterUid: 'uid_gcs_a',
      destinationPath: dlOk,
      expectedSha256: expectedHash,
      configOverride: gcsOverride,
      gcsAdapter: mockAdapter,
    });
    assert.equal(computeFileSha256(dlOk), expectedHash);

    // Mismatched SHA-256 fails with CHECKSUM_MISMATCH and deletes corrupted destination
    const dlBad = path.join(testTempRoot, 'gcs_dl_bad.mp4');
    await assert.rejects(
      () =>
        downloadMediaToLocalPath({
          objectKey: stored.objectKey,
          requesterUid: 'uid_gcs_a',
          destinationPath: dlBad,
          expectedSha256: '0'.repeat(64),
          configOverride: gcsOverride,
          gcsAdapter: mockAdapter,
        }),
      (err: unknown) => (err as { code?: string })?.code === 'CHECKSUM_MISMATCH'
    );
    assert.equal(fs.existsSync(dlBad), false);

    // Production enforcement without bucket throws GCS_NOT_CONFIGURED (zero silent local fallback)
    await assert.rejects(
      () =>
        uploadLocalFileToStorage({
          localFilePath: srcPath,
          userUid: 'uid_gcs_a',
          projectId: 'proj_1',
          category: 'renders',
          filename: 'no_fallback.mp4',
          configOverride: { bucketName: '', strictProduction: true },
        }),
      (err: unknown) => (err as { code?: string })?.code === 'GCS_NOT_CONFIGURED'
    );
  });

  it('3. Cloud Tasks supports media_ingestion queue, propagates correlationId + dispatchDeadline, and dispatcher drops expired tasks safely', async () => {
    const cfg = getCloudTasksConfig({
      projectId: 'proj-0c',
      location: 'asia-southeast2',
      workerBaseUrl: 'https://aicliper-api.example.run.app',
      oidcServiceAccountEmail: 'tasks-sa@proj-0c.iam.gserviceaccount.com',
      oidcAudience: 'https://aicliper-api.example.run.app',
      queues: {
        media_ingestion: 'media-ingestion',
        ai_analysis: 'ai-analysis-queue',
        video_render: 'video-render-queue',
        publish: 'publish-queue',
      },
      strictProduction: true,
    });
    assert.equal(cfg.queues.media_ingestion, 'media-ingestion');

    const capturedList: Array<{ parent: string; task: Record<string, unknown> }> = [];
    const mockTasksClient: CloudTasksClientAdapter = {
      queuePath: (p, l, q) => `projects/${p}/locations/${l}/queues/${q}`,
      taskPath: (p, l, q, t) => `projects/${p}/locations/${l}/queues/${q}/tasks/${t}`,
      createTask: async (req) => {
        capturedList.push(req);
        return [{ name: `${req.parent}/tasks/task_media_1` }];
      },
    };

    const enq = await enqueueCloudTask(
      {
        queue: 'media_ingestion',
        targetPath: '/internal/dispatch/render',
        idempotencyKey: 'media_src_1',
        correlationId: 'corr_media_001',
        dispatchDeadlineSec: 45,
        payload: { sourceId: 'src_1' },
      },
      {
        configOverride: cfg,
        tasksClient: mockTasksClient,
      }
    );
    assert.equal(enq.enqueued, true);
    assert.equal(enq.backend, 'cloud_tasks');
    assert.equal(enq.queueName, 'media-ingestion');
    const capturedTaskReq = capturedList[0];
    assert.ok(capturedTaskReq);
    const httpReq = (capturedTaskReq.task as { httpRequest?: { headers?: Record<string, string>; body?: string } })
      .httpRequest;
    assert.equal(httpReq?.headers?.['X-Correlation-Id'], 'corr_media_001');
    assert.equal(
      (capturedTaskReq.task as { dispatchDeadline?: { seconds?: number } }).dispatchDeadline?.seconds,
      45
    );

    // Dispatcher rejects expired task with 200 TASK_EXPIRED (so Cloud Tasks stops infinite retries)
    const seeded = seedUserEpisodeClip('uid_disp_exp', 'exp1');
    const expiredJobId = 'rjob_expired_0c';
    db.upsertRenderJob({
      jobId: expiredJobId,
      userUid: 'uid_disp_exp',
      clipId: seeded.clipId,
      layout: 'shorts_full_bleed',
      quality: '1080p',
      status: 'running',
      stage: 'Queued',
      progress: 5,
    });
    db.upsertRenderJobCloudState({
      jobId: expiredJobId,
      userUid: 'uid_disp_exp',
      clipId: seeded.clipId,
      lifecycleStatus: 'queued',
      renderProfile: 'balanced_1080p',
    });

    const app = express();
    app.use(express.json());
    app.use(
      '/internal/dispatch',
      createInternalDispatchRouter({
        db,
        v3Repo: new V3Repository(db),
        oidcConfigOverride: {
          allowedAudiences: ['https://aicliper-api.example.run.app'],
          expectedServiceAccountEmail: 'tasks-sa@proj-0c.iam.gserviceaccount.com',
        },
        verifyIdTokenFn: async () => ({
          email: 'tasks-sa@proj-0c.iam.gserviceaccount.com',
          email_verified: true,
          aud: 'https://aicliper-api.example.run.app',
          iss: 'https://accounts.google.com',
          sub: '100001',
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
        dispatchCloudRunJobFn: async () => {
          throw new Error('Should not trigger worker for expired task');
        },
      })
    );

    const expiredRes = await sendExpressRequest(app, 'POST', '/internal/dispatch/render', {
      headers: {
        Authorization: 'Bearer mock.oidc.jwt.token',
        'X-Correlation-Id': 'corr_expired_test',
        'X-CloudTasks-TaskRetryCount': '2',
      },
      body: {
        jobId: expiredJobId,
        userUid: 'uid_disp_exp',
        clipId: seeded.clipId,
        renderProfile: 'balanced_1080p',
        renderFingerprint: 'rfp_expired_0c',
        correlationId: 'corr_expired_test',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    assert.equal(expiredRes.status, 200);
    assert.equal(expiredRes.json.ok, true);
    assert.equal(expiredRes.json.expired, true);
    assert.equal(expiredRes.json.deduplicated, true);
    assert.equal(expiredRes.json.correlationId, 'corr_expired_test');
  });

  it('4. Worker skips fresh active locks but atomically recovers stale locks after worker crash and charges quota once', async () => {
    const seeded = seedUserEpisodeClip('uid_stale_rec', 'stale1');
    const jobId = 'rjob_stale_lock_0c';
    db.upsertRenderJob({
      jobId,
      userUid: 'uid_stale_rec',
      clipId: seeded.clipId,
      layout: 'shorts_full_bleed',
      quality: '1080p',
      status: 'running',
      stage: 'Queued',
      progress: 5,
    });
    db.upsertRenderJobCloudState({
      jobId,
      userUid: 'uid_stale_rec',
      clipId: seeded.clipId,
      lifecycleStatus: 'queued',
      renderProfile: 'balanced_1080p',
      payloadJson: { sourceObjectKey: seeded.sourceObjectKey },
    });

    // First worker claims the job (lock is fresh)
    const firstClaim = db.claimRenderJobForWorker(jobId, 'claim_worker_1', { staleLockTtlSec: 600 });
    assert.equal(firstClaim.claimed, true);
    assert.equal(firstClaim.recoveredStaleLock, false);

    // Concurrent second worker sees fresh lock -> skipped_locked
    const skipped = await executeRenderWorkerJob({
      db,
      renderJobId: jobId,
      expectedUserUid: 'uid_stale_rec',
      expectedClipId: seeded.clipId,
      correlationId: 'corr_stale_test',
      staleLockTtlSec: 600,
    });
    assert.equal(skipped.status, 'skipped_locked');
    assert.equal(skipped.skipped, true);

    // Simulate hard worker crash (SIGKILL) leaving worker_claimed_at 2 hours in the past
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    db.db
      .prepare(`UPDATE render_job_cloud_state SET worker_claimed_at = ? WHERE job_id = ?`)
      .run(twoHoursAgo, jobId);

    // Recovery worker takes over stale lock and completes render
    const fakeRenderedOut = path.join(testTempRoot, 'stale_recovered_out.mp4');
    fs.writeFileSync(fakeRenderedOut, Buffer.from('rendered-mp4-binary-content-0c'));

    const mockHydrateAdapter: GcsClientAdapter = {
      checkBucketAccess: async () => true,
      uploadFile: async () => undefined,
      downloadFile: async (_key, destPath) => {
        fs.copyFileSync(seeded.sourceFilePath, destPath);
      },
      getSignedReadUrl: async () => 'https://storage.googleapis.com/mock-signed/stale_recovered_out.mp4',
      deleteFile: async () => undefined,
      exists: async () => true,
    };

    const mockRenderStale = (async () => ({
      outputPath: fakeRenderedOut,
      sizeBytes: fs.statSync(fakeRenderedOut).size,
      width: 1080,
      height: 1920,
      durationSec: 15,
      sourceWidth: 1920,
      sourceHeight: 1080,
      sourceUsed: 'upload',
      layout: 'shorts_full_bleed',
      requestedQuality: '1080p',
      quality: '1080p',
      renderProfile: 'balanced_1080p',
      upscalePrevented: false,
      intelligence: {} as never,
    })) as unknown as NonNullable<ExecuteRenderWorkerOptions['renderClipFn']>;

    const mockProbeStale = (async () => ({
      width: 1080,
      height: 1920,
      durationSec: 15,
      sizeBytes: fs.statSync(fakeRenderedOut).size,
      videoCodec: 'h264',
      audioCodec: 'aac',
      audioChannels: 2,
      videoStartTime: 0,
      audioStartTime: 0,
      videoDurationSec: 15,
      audioDurationSec: 15,
      syncHealth: { healthy: true, offsetDriftSec: 0, durationDriftSec: 0, note: 'ok' },
    })) as unknown as NonNullable<ExecuteRenderWorkerOptions['probeVideoFn']>;

    const recovered = await executeRenderWorkerJob({
      db,
      renderJobId: jobId,
      expectedUserUid: 'uid_stale_rec',
      expectedClipId: seeded.clipId,
      correlationId: 'corr_stale_test',
      staleLockTtlSec: 600,
      gcsConfigOverride: { bucketName: 'aicliper-stale-bucket', strictProduction: true },
      gcsAdapter: mockHydrateAdapter,
      renderClipFn: mockRenderStale,
      probeVideoFn: mockProbeStale,
    });

    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.recoveredStaleLock, true);
    assert.equal(recovered.retryCount, 1);
    assert.equal(recovered.output?.quotaCharged, true);
    assert.equal(recovered.correlationId, 'corr_stale_test');
  });

  it('5. Worker handles SIGTERM AbortSignal cleanly and preserves uploaded GCS URI if DB finalization fails', async () => {
    // Part A: SIGTERM abort before/during render
    const seededSig = seedUserEpisodeClip('uid_sigterm', 'sig1');
    const sigJobId = 'rjob_sigterm_0c';
    db.upsertRenderJob({
      jobId: sigJobId,
      userUid: 'uid_sigterm',
      clipId: seededSig.clipId,
      layout: 'shorts_full_bleed',
      quality: '1080p',
      status: 'running',
      stage: 'Queued',
      progress: 5,
    });
    db.upsertRenderJobCloudState({
      jobId: sigJobId,
      userUid: 'uid_sigterm',
      clipId: seededSig.clipId,
      lifecycleStatus: 'queued',
      renderProfile: 'balanced_1080p',
      payloadJson: { sourceObjectKey: seededSig.sourceObjectKey },
    });

    const sigAdapter: GcsClientAdapter = {
      checkBucketAccess: async () => true,
      uploadFile: async () => undefined,
      downloadFile: async (_key, destPath) => {
        fs.copyFileSync(seededSig.sourceFilePath, destPath);
      },
      getSignedReadUrl: async () => 'https://storage.googleapis.com/mock-signed/sig.mp4',
      deleteFile: async () => undefined,
      exists: async () => true,
    };

    const ac = new AbortController();
    const sigResult = await executeRenderWorkerJob({
      db,
      renderJobId: sigJobId,
      expectedUserUid: 'uid_sigterm',
      expectedClipId: seededSig.clipId,
      correlationId: 'corr_sigterm_0c',
      signal: ac.signal,
      gcsConfigOverride: { bucketName: 'aicliper-sig-bucket', strictProduction: true },
      gcsAdapter: sigAdapter,
      renderClipFn: async () => {
        ac.abort();
        throw new Error('FFmpeg terminated by SIGTERM');
      },
    });
    assert.equal(sigResult.status, 'failed');
    assert.equal(sigResult.errorCode, 'WORKER_SIGTERM_INTERRUPTED');
    assert.equal(db.getRenderJobById(sigJobId)?.status, 'failed');

    // Part B: DB finalization fails AFTER GCS upload succeeds -> preservedOutputGcsUri recorded
    const seededPres = seedUserEpisodeClip('uid_preserve', 'pres1');
    const presJobId = 'rjob_preserve_0c';
    db.upsertRenderJob({
      jobId: presJobId,
      userUid: 'uid_preserve',
      clipId: seededPres.clipId,
      layout: 'shorts_full_bleed',
      quality: '1080p',
      status: 'running',
      stage: 'Queued',
      progress: 5,
    });
    db.upsertRenderJobCloudState({
      jobId: presJobId,
      userUid: 'uid_preserve',
      clipId: seededPres.clipId,
      lifecycleStatus: 'queued',
      renderProfile: 'balanced_1080p',
      payloadJson: { sourceObjectKey: seededPres.sourceObjectKey },
    });

    const outPath = path.join(testTempRoot, 'preserve_out.mp4');
    fs.writeFileSync(outPath, Buffer.from('preserve-me-in-gcs-12345'));

    const mockAdapter: GcsClientAdapter = {
      checkBucketAccess: async () => true,
      uploadFile: async () => undefined,
      downloadFile: async (_key, destPath) => {
        fs.copyFileSync(seededPres.sourceFilePath, destPath);
      },
      getSignedReadUrl: async () => 'https://storage.googleapis.com/mock-signed/preserve_out.mp4',
      deleteFile: async () => undefined,
      exists: async () => true,
    };

    const mockRenderPres = (async () => ({
      outputPath: outPath,
      sizeBytes: fs.statSync(outPath).size,
      width: 1080,
      height: 1920,
      durationSec: 12,
      sourceWidth: 1920,
      sourceHeight: 1080,
      sourceUsed: 'upload',
      layout: 'shorts_full_bleed',
      requestedQuality: '1080p',
      quality: '1080p',
      renderProfile: 'balanced_1080p',
      upscalePrevented: false,
      intelligence: {} as never,
    })) as unknown as NonNullable<ExecuteRenderWorkerOptions['renderClipFn']>;

    const mockProbePres = (async () => ({
      width: 1080,
      height: 1920,
      durationSec: 12,
      sizeBytes: fs.statSync(outPath).size,
      videoCodec: 'h264',
      audioCodec: 'aac',
      audioChannels: 2,
      videoStartTime: 0,
      audioStartTime: 0,
      videoDurationSec: 12,
      audioDurationSec: 12,
      syncHealth: { healthy: true, offsetDriftSec: 0, durationDriftSec: 0, note: 'ok' },
    })) as unknown as NonNullable<ExecuteRenderWorkerOptions['probeVideoFn']>;

    const presResult = await executeRenderWorkerJob({
      db,
      renderJobId: presJobId,
      expectedUserUid: 'uid_preserve',
      expectedClipId: seededPres.clipId,
      correlationId: 'corr_preserve_0c',
      gcsConfigOverride: {
        bucketName: 'aicliper-preserve-bucket',
        strictProduction: true,
      },
      gcsAdapter: mockAdapter,
      persistJobCompletionFn: async () => {
        throw new Error('Simulated DB transient outage on finalize');
      },
      renderClipFn: mockRenderPres,
      probeVideoFn: mockProbePres,
    });
    assert.equal(presResult.status, 'failed');
    assert.ok(
      presResult.preservedOutputGcsUri?.startsWith('gs://aicliper-preserve-bucket/users/uid_preserve/'),
      `Expected preservedOutputGcsUri, got ${presResult.preservedOutputGcsUri}`
    );
  });

  it('6. Multi-user isolation blocks cross-tenant access to episodes, clips, render jobs, and GCS objects', async () => {
    const userA = seedUserEpisodeClip('uid_tenant_a', 'tA');
    const userB = seedUserEpisodeClip('uid_tenant_b', 'tB');

    assert.equal(db.getEpisodeForUser('uid_tenant_b', userA.episodeId), null);
    assert.equal(db.getClipForUser('uid_tenant_b', userA.clipId), null);
    assert.equal(db.getEpisodeForUser('uid_tenant_a', userB.episodeId), null);

    await assert.rejects(
      () =>
        downloadMediaToLocalPath({
          objectKey: 'users/uid_tenant_a/projects/ep_1/renders/secret.mp4',
          requesterUid: 'uid_tenant_b',
          destinationPath: path.join(testTempRoot, 'cross_tenant_blocked.mp4'),
          configOverride: { bucketName: '', strictProduction: false },
        }),
      (err: unknown) => (err as { code?: string })?.code === 'UNAUTHORIZED_ACCESS'
    );
  });

  it('7. /api/v3/readiness exposes Phase 0C deployment metadata, runtimeResources, queue depth, and sanitized recentErrors', async () => {
    const app = express();
    app.use(express.json());
    const authAsAdmin: express.RequestHandler = (req, _res, next) => {
      (req as AuthenticatedRequest).authUser = {
        uid: 'uid_admin_0c',
        email: 'admin@example.test',
        emailVerified: true,
        name: 'Admin 0C',
        picture: null,
        role: 'super_admin',
        status: 'active',
        authTime: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
      next();
    };
    const passThrough: express.RequestHandler = (_req, _res, next) => next();

    app.use(
      '/api/v3',
      createV3Router({
        db,
        requireAuth: authAsAdmin,
        apiRateLimit: passThrough,
        renderRateLimit: passThrough,
        onEnqueueRender: (_req, res) => res.status(202).json({ ok: true }),
      })
    );

    const res = await sendExpressRequest(app, 'GET', '/api/v3/readiness');
    assert.equal(res.status, 200);
    assert.equal(res.json.phase, '0B'); // backward compatibility with Phase 0B tests
    assert.equal(res.json.deploymentPhase, '0C');
    const rt = res.json.runtimeResources as Record<string, unknown>;
    assert.equal(typeof rt.memoryRssMb, 'number');
    assert.equal(typeof rt.cpuCount, 'number');
    assert.equal(typeof rt.nodeVersion, 'string');

    const telemetry = res.json.telemetry as Record<string, unknown>;
    assert.equal(typeof telemetry.queuedRenderCount, 'number');
    assert.equal(typeof telemetry.processingRenderCount, 'number');
    assert.ok(Array.isArray(telemetry.recentErrors));
    assert.ok((telemetry.recentErrors as unknown[]).length >= 1);
  });

  it('8. verify-live-gcp CLI reports honest INCOMPLETE_OR_UNCONFIGURED status when GCP env is absent', async () => {
    const report = await runLiveGcpVerification({ skipGcsWrite: true });
    assert.equal(report.phase, '0C');
    assert.equal(report.overallReady, false);
    assert.equal(report.verdict, 'INCOMPLETE_OR_UNCONFIGURED');
    assert.ok(report.blockers.length >= 3);
    assert.equal(report.checks.mediaBinaries.ffmpegReady, true);
    assert.equal(report.checks.mediaBinaries.ffprobeReady, true);
  });
});
