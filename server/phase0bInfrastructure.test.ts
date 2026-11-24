import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server.ts';
import { KlipCastDatabase } from './db.ts';
import { getAvailableFfmpegPathSync } from './ffmpegBinaries.ts';
import {
  acquireAdcAccessToken,
  checkCloudRunJobsReadiness,
  CloudRunJobsError,
  dispatchCloudRunRenderJob,
} from './services/cloudRunJobsService.ts';
import {
  checkCloudTasksReadiness,
  CloudTasksError,
  enqueueCloudTask,
  type CloudTasksClientAdapter,
} from './services/cloudTasksService.ts';
import {
  assertUserOwnsObjectKey,
  buildUserMediaObjectKey,
  checkGcsReadiness,
  deleteStorageObject,
  downloadMediaToLocalPath,
  GcsStorageError,
  generateSignedReadUrl,
  RESUMABLE_UPLOAD_THRESHOLD_BYTES,
  uploadLocalFileToStorage,
  validateObjectKey,
  validateUploadPolicy,
  type GcsClientAdapter,
} from './services/gcsStorageService.ts';
import {
  OidcVerificationError,
  verifyCloudTasksOidcToken,
  type OidcTokenClaims,
} from './services/oidcVerifier.ts';
import { PgRenderJobStore, type PgQueryable } from './services/pgJobStore.ts';
import { formatStructuredLog } from './services/structuredLogger.ts';
import { getUploadTargetPath, probeVideoMeta } from './videoClipper.ts';
import { resolvePgPoolConfig, sanitizePgErrorMessage, withPgTransaction } from '../src/db/index.ts';
import { runStagedSqliteToPostgresMigration } from '../scripts/migrate-sqlite-to-postgres.ts';
import { executeRenderWorkerJob } from '../workers/renderWorker.ts';
import type { PodcastClip, PodcastEpisode } from '../src/types/clipper.ts';

process.env.AICLIPER_SILENCE_INFO_LOGS = 'true';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeFixtureEpisodeAndClip(params: {
  userUid: string;
  episodeId: string;
  clipId: string;
  startSec: number;
  endSec: number;
  durationSec: number;
}): { episode: PodcastEpisode; clip: PodcastClip } {
  const now = new Date().toISOString();
  const episode: PodcastEpisode = {
    id: params.episodeId,
    userUid: params.userUid,
    title: 'Phase 0B Test Podcast',
    channelName: 'AICLIPER QA',
    sourceUrl: `https://www.youtube.com/watch?v=${params.episodeId}`,
    videoId: params.episodeId,
    durationSec: params.durationSec,
    thumbnailUrl: `https://i.ytimg.com/vi/${params.episodeId}/hqdefault.jpg`,
    fallbackImageUrl: '/assets/placeholder-podcast.jpg',
    hasUploadedSourceVideo: true,
    transcriptSource: 'manual_transcript',
    episodeSummary: 'Ringkasan pengujian pipeline production Phase 0B.',
    keyTopics: ['Cloud Run Jobs', 'FFmpeg', 'FFprobe'],
    createdAt: now,
  };

  const clip: PodcastClip = {
    id: params.clipId,
    episodeId: params.episodeId,
    userUid: params.userUid,
    orderIndex: 1,
    title: 'Phase 0B Verification Clip',
    startSec: params.startSec,
    endSec: params.endSec,
    hookLine: 'Uji pipeline worker Cloud Run Jobs secara menyeluruh.',
    ringkasanTeks: 'Verifikasi output video MP4 melalui FFprobe dan penyimpanan terisolasi.',
    poinKunci: ['Verifikasi FFprobe', 'Isolasi GCS', 'Idempotensi worker'],
    transcriptExcerpt: 'Pengujian pipeline production Phase 0B dengan kualitas tinggi.',
    priorityLabel: 'Sorotan Utama',
    viralScore: 91,
    status: 'draft',
    publishedPlatforms: [],
    captionCues: [
      {
        offsetSec: 0,
        durationSec: Math.max(1, params.endSec - params.startSec),
        text: 'Pengujian pipeline production Phase 0B.',
      },
    ],
    platformCopies: {
      youtube_shorts: {
        title: 'Phase 0B Verification #Shorts',
        caption: 'Verifikasi pipeline Phase 0B',
        hashtags: ['#Shorts', '#AICLIPER'],
      },
      tiktok: {
        title: 'Phase 0B Verification',
        caption: 'Verifikasi pipeline Phase 0B',
        hashtags: ['#AICLIPER'],
      },
      instagram_reels: {
        title: 'Phase 0B Verification',
        caption: 'Verifikasi pipeline Phase 0B',
        hashtags: ['#AICLIPER'],
      },
      facebook_reels: {
        title: 'Phase 0B Verification',
        caption: 'Verifikasi pipeline Phase 0B',
        hashtags: ['#AICLIPER'],
      },
      linkedin: {
        title: 'Phase 0B Verification',
        caption: 'Verifikasi pipeline Phase 0B',
        hashtags: ['#AICLIPER'],
      },
      x_twitter: {
        title: 'Phase 0B Verification',
        caption: 'Verifikasi pipeline Phase 0B',
        hashtags: ['#AICLIPER'],
      },
    },
  };

  return { episode, clip };
}

function generateSyntheticMp4(params: {
  targetPath: string;
  width: number;
  height: number;
  durationSec: number;
  withAudio: boolean;
}): void {
  const ffmpeg = getAvailableFfmpegPathSync() || 'ffmpeg';
  fs.mkdirSync(path.dirname(params.targetPath), { recursive: true });
  const args = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${params.width}x${params.height}:rate=30:duration=${params.durationSec}`,
  ];
  if (params.withAudio) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${params.durationSec}`);
  }
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (params.withAudio) {
    args.push('-c:a', 'aac', '-b:a', '128k', '-shortest');
  } else {
    args.push('-an');
  }
  args.push('-movflags', '+faststart', params.targetPath);
  execFileSync(ffmpeg, args, { stdio: 'pipe' });
}

function createMemoryGcsAdapter(): {
  adapter: GcsClientAdapter;
  objects: Map<string, { data: Buffer; contentType: string; resumable: boolean }>;
} {
  const objects = new Map<string, { data: Buffer; contentType: string; resumable: boolean }>();
  const adapter: GcsClientAdapter = {
    async uploadFile(localFilePath, objectKey, contentType, resumable) {
      const data = fs.readFileSync(localFilePath);
      objects.set(objectKey, { data, contentType, resumable });
    },
    async downloadFile(objectKey, destinationPath) {
      const entry = objects.get(objectKey);
      if (!entry) {
        const err = new Error('No such object') as Error & { code: number };
        err.code = 404;
        throw err;
      }
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.writeFileSync(destinationPath, entry.data);
    },
    async getSignedReadUrl(objectKey, ttlSec) {
      return `https://storage.googleapis.com/test-bucket/${encodeURIComponent(objectKey)}?X-Goog-Expires=${ttlSec}`;
    },
    async deleteFile(objectKey) {
      if (!objects.has(objectKey)) {
        const err = new Error('No such object') as Error & { code: number };
        err.code = 404;
        throw err;
      }
      objects.delete(objectKey);
    },
    async exists(objectKey) {
      return objects.has(objectKey);
    },
    async checkBucketAccess() {
      return true;
    },
  };
  return { adapter, objects };
}

function httpJsonRequest(
  baseUrl: string,
  method: string,
  urlPath: string,
  headers: Record<string, string>,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      `${baseUrl}${urlPath}`,
      {
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(text) as Record<string, unknown>;
          } catch {
            parsed = { raw: text };
          }
          resolve({ status: res.statusCode ?? 0, json: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// =============================================================================
// 12.1 AUTHENTICATION, GOOGLE ADC, CLOUD TASKS OIDC & CLOUD RUN JOBS
// =============================================================================

test('12.1 Structured logger redacts tokens, passwords, JWTs, and API keys', () => {
  const jsonLine = formatStructuredLog({
    service: 'test-service',
    event: 'audit_check',
    renderJobId: 'rjob-123',
    accessToken: 'ya29.super-secret-oauth-token',
    sqlPassword: 'my-prod-password-999',
    authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue1234567890',
    message: 'Call failed with AIzaSyA123456789012345678901234567890 and Bearer secretTokenValue',
  });
  assert.ok(!jsonLine.includes('ya29.super-secret'));
  assert.ok(!jsonLine.includes('my-prod-password-999'));
  assert.ok(!jsonLine.includes('eyJhbGciOiJSUzI1NiJ9'));
  assert.ok(!jsonLine.includes('AIzaSyA123456789012345678901234567890'));
  assert.ok(jsonLine.includes('[REDACTED]'));
});

test('12.1 Cloud Run Jobs ADC: valid dispatch, 401 auto-refresh, 403/404/400/429/503/timeout, and strict production enforcement', async () => {
  const cfgOverride = {
    projectId: 'aicliper-prod-test',
    region: 'asia-southeast2',
    renderJobName: 'aicliper-render-worker',
    requestTimeoutMs: 2500,
  };

  // 1. ADC available + valid dispatch
  let capturedAuth = '';
  let capturedBody = '';
  const okResult = await dispatchCloudRunRenderJob(
    {
      renderJobId: 'rjob-adc-1',
      userUid: 'user-a',
      clipId: 'clip-1',
      renderProfile: 'balanced_1080p',
      renderFingerprint: 'fp-123456',
    },
    {
      configOverride: cfgOverride,
      strictProduction: true,
      authProvider: { getAccessToken: async () => 'adc-fresh-token-1' },
      fetchFn: (async (_url, init) => {
        capturedAuth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
        capturedBody = String(init?.body ?? '');
        return new Response(
          JSON.stringify({
            metadata: { name: 'projects/aicliper-prod-test/locations/asia-southeast2/jobs/aicliper-render-worker/executions/exec-001' },
          }),
          { status: 200 }
        );
      }) as typeof fetch,
    }
  );
  assert.equal(okResult.dispatched, true);
  assert.equal(okResult.backend, 'cloud_run_jobs');
  assert.equal(okResult.authMode, 'google_adc');
  assert.equal(capturedAuth, 'Bearer adc-fresh-token-1');
  assert.ok(capturedBody.includes('AICLIPER_RENDER_JOB_ID'));
  assert.ok(okResult.executionName.includes('exec-001'));

  // 2. Token refresh automatically retries once on HTTP 401
  let tokenCallCount = 0;
  const refreshed = await dispatchCloudRunRenderJob(
    {
      renderJobId: 'rjob-adc-refresh',
      userUid: 'user-a',
      clipId: 'clip-1',
      renderProfile: 'balanced_1080p',
      renderFingerprint: 'fp-refresh',
    },
    {
      configOverride: cfgOverride,
      strictProduction: true,
      authProvider: {
        getAccessToken: async () => {
          tokenCallCount += 1;
          return tokenCallCount === 1 ? 'expired-token' : 'refreshed-token-2';
        },
      },
      fetchFn: (async (_url, init) => {
        const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
        if (auth === 'Bearer expired-token') {
          return new Response('Unauthorized', { status: 401 });
        }
        return new Response(JSON.stringify({ name: 'exec-refreshed-2' }), { status: 200 });
      }) as typeof fetch,
    }
  );
  assert.equal(tokenCallCount, 2);
  assert.equal(refreshed.executionName, 'exec-refreshed-2');

  // 3. ADC unavailable -> ADC_AUTH_FAILED
  await assert.rejects(
    () =>
      acquireAdcAccessToken({
        getAccessToken: async () => {
          throw new Error('Could not load the default credentials');
        },
      }),
    (err: unknown) => err instanceof CloudRunJobsError && err.code === 'ADC_AUTH_FAILED'
  );

  // 4. Error taxonomy: 403, 404, 400, 429, 503
  const statusCases: Array<[number, string, boolean]> = [
    [403, 'PERMISSION_DENIED', false],
    [404, 'JOB_NOT_FOUND', false],
    [400, 'INVALID_CONFIG', false],
    [429, 'QUOTA_EXCEEDED', true],
    [503, 'API_UNAVAILABLE', true],
  ];
  for (const [httpStatus, expectedCode, expectedRetryable] of statusCases) {
    await assert.rejects(
      () =>
        dispatchCloudRunRenderJob(
          {
            renderJobId: `rjob-err-${httpStatus}`,
            userUid: 'user-a',
            clipId: 'clip-1',
            renderProfile: 'balanced_1080p',
            renderFingerprint: 'fp-err',
          },
          {
            configOverride: cfgOverride,
            strictProduction: true,
            authProvider: { getAccessToken: async () => 'adc-token' },
            fetchFn: (async () => new Response(`Err ${httpStatus}`, { status: httpStatus })) as typeof fetch,
          }
        ),
      (err: unknown) =>
        err instanceof CloudRunJobsError &&
        err.code === expectedCode &&
        err.retryable === expectedRetryable
    );
  }

  // 5. Network timeout -> NETWORK_TIMEOUT
  await assert.rejects(
    () =>
      dispatchCloudRunRenderJob(
        {
          renderJobId: 'rjob-timeout',
          userUid: 'user-a',
          clipId: 'clip-1',
          renderProfile: 'balanced_1080p',
          renderFingerprint: 'fp-timeout',
        },
        {
          configOverride: { ...cfgOverride, requestTimeoutMs: 50 },
          strictProduction: true,
          authProvider: { getAccessToken: async () => 'adc-token' },
          fetchFn: ((_url, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                const abortErr = new Error('The operation was aborted');
                abortErr.name = 'AbortError';
                reject(abortErr);
              });
            })) as typeof fetch,
        }
      ),
    (err: unknown) => err instanceof CloudRunJobsError && err.code === 'NETWORK_TIMEOUT'
  );

  // 6. Strict production rejects unconfigured Cloud Run Jobs (no silent fallback)
  await assert.rejects(
    () =>
      dispatchCloudRunRenderJob(
        {
          renderJobId: 'rjob-unconf',
          userUid: 'user-a',
          clipId: 'clip-1',
          renderProfile: 'balanced_1080p',
          renderFingerprint: 'fp-unconf',
        },
        {
          configOverride: { projectId: '', renderJobName: '', region: 'asia-southeast2' },
          strictProduction: true,
        }
      ),
    (err: unknown) => err instanceof CloudRunJobsError && err.code === 'CLOUD_RUN_NOT_CONFIGURED'
  );

  // 7. Honest 5-level readiness probe
  const readySnap = await checkCloudRunJobsReadiness({
    configOverride: cfgOverride,
    authProvider: { getAccessToken: async () => 'adc-ok' },
    fetchFn: (async () => new Response(JSON.stringify({ name: 'ok' }), { status: 200 })) as typeof fetch,
  });
  assert.equal(readySnap.configured, true);
  assert.equal(readySnap.authenticated, true);
  assert.equal(readySnap.connected, true);
  assert.equal(readySnap.operational, true);
  assert.equal(readySnap.tested, true);
});

test('12.1 Cloud Tasks OIDC enforcement, idempotent deduplication, and OIDC JWT verifier checks', async () => {
  const createdTasks: Array<Record<string, unknown>> = [];
  const fakeClient: CloudTasksClientAdapter = {
    queuePath: (p, l, q) => `projects/${p}/locations/${l}/queues/${q}`,
    taskPath: (p, l, q, t) => `projects/${p}/locations/${l}/queues/${q}/tasks/${t}`,
    async createTask(req) {
      const existing = createdTasks.find((t) => t.name === req.task.name);
      if (existing) {
        const err = new Error('ALREADY_EXISTS') as Error & { code: number };
        err.code = 6;
        throw err;
      }
      createdTasks.push(req.task);
      return [{ name: String(req.task.name) }];
    },
    async getQueue() {
      return [{ state: 'RUNNING' }];
    },
  };

  // Missing OIDC SA must fail explicitly even when project/baseUrl are configured
  await assert.rejects(
    () =>
      enqueueCloudTask(
        {
          queue: 'video_render',
          targetPath: '/api/internal/dispatch/render',
          payload: { jobId: 'rjob-1' },
          idempotencyKey: 'key-1',
        },
        {
          configOverride: {
            projectId: 'proj-1',
            location: 'asia-southeast2',
            workerBaseUrl: 'https://api.aicliper.test',
            oidcServiceAccountEmail: '',
            strictProduction: true,
          },
          tasksClient: fakeClient,
        }
      ),
    (err: unknown) => err instanceof CloudTasksError && err.code === 'OIDC_CONFIG_MISSING'
  );

  // Production unconfigured throws CLOUD_TASKS_NOT_CONFIGURED
  await assert.rejects(
    () =>
      enqueueCloudTask(
        {
          queue: 'video_render',
          targetPath: '/api/internal/dispatch/render',
          payload: { jobId: 'rjob-1' },
          idempotencyKey: 'key-1',
        },
        {
          configOverride: {
            projectId: '',
            location: 'asia-southeast2',
            workerBaseUrl: '',
            oidcServiceAccountEmail: '',
            strictProduction: true,
          },
        }
      ),
    (err: unknown) => err instanceof CloudTasksError && err.code === 'CLOUD_TASKS_NOT_CONFIGURED'
  );

  // Valid OIDC enqueue + duplicate idempotency
  const first = await enqueueCloudTask(
    {
      queue: 'video_render',
      targetPath: '/api/internal/dispatch/render',
      payload: { jobId: 'rjob-1', userUid: 'u1', clipId: 'c1' },
      idempotencyKey: 'idem-abc',
    },
    {
      configOverride: {
        projectId: 'proj-1',
        location: 'asia-southeast2',
        workerBaseUrl: 'https://api.aicliper.test',
        oidcServiceAccountEmail: 'tasks-invoker@proj-1.iam.gserviceaccount.com',
        strictProduction: true,
      },
      tasksClient: fakeClient,
    }
  );
  assert.equal(first.enqueued, true);
  assert.equal(first.deduplicated, false);
  const httpReq = createdTasks[0].httpRequest as { oidcToken?: { serviceAccountEmail?: string; audience?: string } };
  assert.equal(httpReq.oidcToken?.serviceAccountEmail, 'tasks-invoker@proj-1.iam.gserviceaccount.com');
  assert.equal(httpReq.oidcToken?.audience, 'https://api.aicliper.test');

  const second = await enqueueCloudTask(
    {
      queue: 'video_render',
      targetPath: '/api/internal/dispatch/render',
      payload: { jobId: 'rjob-1', userUid: 'u1', clipId: 'c1' },
      idempotencyKey: 'idem-abc',
    },
    {
      configOverride: {
        projectId: 'proj-1',
        location: 'asia-southeast2',
        workerBaseUrl: 'https://api.aicliper.test',
        oidcServiceAccountEmail: 'tasks-invoker@proj-1.iam.gserviceaccount.com',
        strictProduction: true,
      },
      tasksClient: fakeClient,
    }
  );
  assert.equal(second.deduplicated, true);

  // Readiness probe
  const tasksReady = await checkCloudTasksReadiness({
    configOverride: {
      projectId: 'proj-1',
      location: 'asia-southeast2',
      workerBaseUrl: 'https://api.aicliper.test',
      oidcServiceAccountEmail: 'tasks-invoker@proj-1.iam.gserviceaccount.com',
      strictProduction: true,
    },
    tasksClient: fakeClient,
  });
  assert.equal(tasksReady.operational, true);

  // OIDC JWT Verifier tests: missing, invalid, wrong audience, wrong SA, valid
  const oidcCfg = {
    expectedServiceAccountEmail: 'tasks-invoker@proj-1.iam.gserviceaccount.com',
    allowedAudiences: ['https://api.aicliper.test', 'https://api.aicliper.test/api/internal/dispatch/render'],
  };

  await assert.rejects(
    () => verifyCloudTasksOidcToken({ authorizationHeader: '', configOverride: oidcCfg }),
    (e: unknown) => e instanceof OidcVerificationError && e.code === 'OIDC_MISSING'
  );

  await assert.rejects(
    () =>
      verifyCloudTasksOidcToken({
        authorizationHeader: 'Bearer bad.jwt',
        configOverride: oidcCfg,
        verifyIdTokenFn: async () => {
          throw new Error('Invalid token signature');
        },
      }),
    (e: unknown) => e instanceof OidcVerificationError && e.code === 'OIDC_INVALID'
  );

  await assert.rejects(
    () =>
      verifyCloudTasksOidcToken({
        authorizationHeader: 'Bearer wrong-aud.jwt',
        configOverride: oidcCfg,
        verifyIdTokenFn: async (): Promise<OidcTokenClaims> => ({
          iss: 'https://accounts.google.com',
          aud: 'https://evil.example.com',
          email: 'tasks-invoker@proj-1.iam.gserviceaccount.com',
          email_verified: true,
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      }),
    (e: unknown) => e instanceof OidcVerificationError && e.code === 'OIDC_AUDIENCE_MISMATCH'
  );

  await assert.rejects(
    () =>
      verifyCloudTasksOidcToken({
        authorizationHeader: 'Bearer wrong-sa.jwt',
        configOverride: oidcCfg,
        verifyIdTokenFn: async (): Promise<OidcTokenClaims> => ({
          iss: 'https://accounts.google.com',
          aud: 'https://api.aicliper.test',
          email: 'other-account@proj-1.iam.gserviceaccount.com',
          email_verified: true,
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      }),
    (e: unknown) => e instanceof OidcVerificationError && e.code === 'OIDC_SA_MISMATCH'
  );

  const verified = await verifyCloudTasksOidcToken({
    authorizationHeader: 'Bearer valid-oidc-token',
    configOverride: oidcCfg,
    verifyIdTokenFn: async (): Promise<OidcTokenClaims> => ({
      iss: 'https://accounts.google.com',
      sub: 'sa-subject-1',
      aud: 'https://api.aicliper.test',
      email: 'tasks-invoker@proj-1.iam.gserviceaccount.com',
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
  });
  assert.equal(verified.email, 'tasks-invoker@proj-1.iam.gserviceaccount.com');
});

// =============================================================================
// 12.2 STANDALONE RENDER WORKER LIFECYCLE, ERRORS, RETRY & IDEMPOTENCY
// =============================================================================

test('12.2 Standalone Render Worker handles missing job, ownership mismatch, missing source, GCS/FFmpeg/FFprobe/DB failures, retry, lock, cancel, and completed idempotency', async () => {
  const tmpDir = createTempDir('aicliper-worker-unit-');
  const db = new KlipCastDatabase({
    dbPath: path.join(tmpDir, 'test.sqlite'),
    dataDir: tmpDir,
  });
  try {
    db.upsertAuthenticatedUser({
      uid: 'worker-user-1',
      email: 'worker1@aicliper.test',
      displayName: 'Worker User 1',
      photoUrl: null,
      resolvedRole: 'user',
    });
    db.updateUserPlan('worker-user-1', 'pro');
    const { episode, clip } = makeFixtureEpisodeAndClip({
      userUid: 'worker-user-1',
      episodeId: 'ep-w-1',
      clipId: 'clip-w-1',
      startSec: 0,
      endSec: 4,
      durationSec: 12,
    });
    db.upsertEpisode('worker-user-1', episode);
    db.upsertClip('worker-user-1', clip);

    // 1. Missing job ID
    const missingIdRes = await executeRenderWorkerJob({ renderJobId: '', db });
    assert.equal(missingIdRes.status, 'failed');
    assert.equal(missingIdRes.errorCode, 'MISSING_JOB_ID');

    // 2. Missing job in DB
    const missingDbRes = await executeRenderWorkerJob({ renderJobId: 'rjob-does-not-exist', db });
    assert.equal(missingDbRes.status, 'failed');
    assert.equal(missingDbRes.errorCode, 'RENDER_JOB_NOT_FOUND');

    // Helper to seed a render job
    const seedJob = (jobId: string, clipId = 'clip-w-1', status: 'running' | 'completed' | 'cancelled' | 'failed' = 'running', lifecycle: 'queued' | 'dispatching' | 'running' | 'completed' | 'cancelled' | 'failed' = 'queued', payloadJson: Record<string, unknown> = {}) => {
      db.upsertRenderJob({
        jobId,
        clipId,
        userUid: 'worker-user-1',
        layout: 'shorts_full_bleed',
        quality: '1080p',
        status,
        stage: 'Queued',
        progress: 5,
      });
      db.upsertRenderJobCloudState({
        jobId,
        userUid: 'worker-user-1',
        clipId,
        lifecycleStatus: lifecycle,
        renderProfile: 'balanced_1080p',
        sourceFingerprint: `sfp-${jobId}`,
        renderFingerprint: `rfp-${jobId}`,
        payloadJson,
      });
    };

    // 3. Ownership mismatch
    seedJob('rjob-own-1');
    const ownRes = await executeRenderWorkerJob({
      renderJobId: 'rjob-own-1',
      expectedUserUid: 'other-user-999',
      db,
    });
    assert.equal(ownRes.status, 'failed');
    assert.equal(ownRes.errorCode, 'OWNERSHIP_MISMATCH');

    // 4. Invalid clip
    seedJob('rjob-bad-clip', 'clip-nonexistent');
    const badClipRes = await executeRenderWorkerJob({ renderJobId: 'rjob-bad-clip', db });
    assert.equal(badClipRes.status, 'failed');
    assert.equal(badClipRes.errorCode, 'CLIP_NOT_FOUND');

    // 5. Missing source asset (episode with no local file, no GCS URI, no URL)
    const epNoSrc: PodcastEpisode = { ...episode, id: 'ep-no-src', sourceUrl: '', directVideoUrl: '' };
    const clipNoSrc: PodcastClip = { ...clip, id: 'clip-no-src', episodeId: 'ep-no-src' };
    db.upsertEpisode('worker-user-1', epNoSrc);
    db.upsertClip('worker-user-1', clipNoSrc);
    seedJob('rjob-no-src', 'clip-no-src');
    const noSrcRes = await executeRenderWorkerJob({ renderJobId: 'rjob-no-src', db });
    assert.equal(noSrcRes.status, 'failed');
    assert.equal(noSrcRes.errorCode, 'SOURCE_ASSET_MISSING');

    // 6. GCS source download failure
    const { adapter: failDlGcs } = createMemoryGcsAdapter();
    seedJob('rjob-dl-fail', 'clip-no-src', 'running', 'queued', {
      sourceObjectKey: 'users/worker-user-1/projects/ep-no-src/sources/missing.mp4',
    });
    const dlFailRes = await executeRenderWorkerJob({
      renderJobId: 'rjob-dl-fail',
      db,
      gcsConfigOverride: { bucketName: 'test-bucket', strictProduction: true },
      gcsAdapter: failDlGcs,
    });
    assert.equal(dlFailRes.status, 'failed');
    assert.equal(dlFailRes.failedStage, 'source_download');

    // 7. FFmpeg render failure
    seedJob('rjob-ffmpeg-fail');
    const ffFailRes = await executeRenderWorkerJob({
      renderJobId: 'rjob-ffmpeg-fail',
      db,
      renderClipFn: async () => {
        throw new Error('FFmpeg exited with code 1');
      },
    });
    assert.equal(ffFailRes.status, 'failed');
    assert.equal(ffFailRes.errorCode, 'FFMPEG_RENDER_FAILED');

    // 8. FFprobe validation failure (corrupt/empty file)
    const corruptMp4 = path.join(tmpDir, 'corrupt.mp4');
    fs.writeFileSync(corruptMp4, Buffer.from('not-a-valid-mp4'));
    seedJob('rjob-probe-fail');
    const probeFailRes = await executeRenderWorkerJob({
      renderJobId: 'rjob-probe-fail',
      db,
      renderClipFn: async () => ({
        outputPath: corruptMp4,
        sizeBytes: 15,
        width: 1080,
        height: 1920,
        durationSec: 4,
        sourceWidth: 1920,
        sourceHeight: 1080,
        sourceUsed: 'uploaded_video',
        layout: 'shorts_full_bleed',
        quality: '1080p',
        requestedQuality: '1080p',
        renderProfile: 'balanced_1080p',
        sourceFingerprint: 'sfp',
        emotionEffectsEnabled: false,
        introEnabled: false,
        upscalePrevented: false,
        resolvedIntro: { tag: '', headline: '', teaser: '', durationSec: 0 },
        intelligence: {
          keyframes: [],
          cues: [],
          verbatimTranscript: '',
          autoTitle: 'Test',
          autoCaption: '',
          hashtags: [],
          subtitleSource: 'existing_fallback' as const,
          speakerFocusSummary: '',
          emotionSummary: '',
          emotionMoments: [],
          intro: { tag: '', headline: '', teaser: '', durationSec: 0 },
        },
      }),
    });
    assert.equal(probeFailRes.status, 'failed');
    assert.equal(probeFailRes.errorCode, 'FFPROBE_VALIDATION_FAILED');

    // 9. GCS upload failure -> MUST remain failed (never falsely marked completed)
    const validMp4 = path.join(tmpDir, 'valid.mp4');
    generateSyntheticMp4({ targetPath: validMp4, width: 1080, height: 1920, durationSec: 2, withAudio: true });
    const mockRenderOk = async () => ({
      outputPath: validMp4,
      sizeBytes: fs.statSync(validMp4).size,
      width: 1080,
      height: 1920,
      durationSec: 2,
      sourceWidth: 1920,
      sourceHeight: 1080,
      sourceUsed: 'uploaded_video' as const,
      layout: 'shorts_full_bleed' as const,
      quality: '1080p' as const,
      requestedQuality: '1080p' as const,
      renderProfile: 'balanced_1080p' as const,
      sourceFingerprint: 'sfp',
      emotionEffectsEnabled: false,
      introEnabled: false,
      upscalePrevented: false,
      resolvedIntro: { tag: '', headline: '', teaser: '', durationSec: 0 },
      intelligence: {
        keyframes: [],
        cues: [],
        verbatimTranscript: '',
        autoTitle: 'Test',
        autoCaption: '',
        hashtags: [],
        subtitleSource: 'existing_fallback' as const,
        speakerFocusSummary: '',
        emotionSummary: '',
        emotionMoments: [],
        intro: { tag: '', headline: '', teaser: '', durationSec: 0 },
      },
    });
    const { adapter: okGcs } = createMemoryGcsAdapter();
    const brokenUploadGcs: GcsClientAdapter = {
      ...okGcs,
      async uploadFile() {
        throw new Error('GCS 503 Service Unavailable');
      },
    };
    seedJob('rjob-upload-fail');
    const upFailRes = await executeRenderWorkerJob({
      renderJobId: 'rjob-upload-fail',
      db,
      renderClipFn: mockRenderOk,
      gcsConfigOverride: { bucketName: 'test-bucket', strictProduction: true },
      gcsAdapter: brokenUploadGcs,
    });
    assert.equal(upFailRes.status, 'failed');
    assert.equal(upFailRes.failedStage, 'uploading');
    assert.equal(db.getRenderJobById('rjob-upload-fail')?.status, 'failed');

    // 10. Worker retry on previously failed job -> increments retryCount & completes cleanly
    const retryRes = await executeRenderWorkerJob({
      renderJobId: 'rjob-upload-fail',
      db,
      renderClipFn: mockRenderOk,
      gcsConfigOverride: { bucketName: 'test-bucket', strictProduction: true },
      gcsAdapter: okGcs,
    });
    assert.equal(retryRes.status, 'completed');
    assert.equal(retryRes.retryCount, 1);
    assert.equal(retryRes.output?.quotaCharged, true);

    // 11. Already completed job -> skipped idempotently, NO double quota consumption!
    const usageBefore = db.getOrCreateUsageRecord('worker-user-1').renders_used;
    const secondRun = await executeRenderWorkerJob({
      renderJobId: 'rjob-upload-fail',
      db,
      renderClipFn: mockRenderOk,
      gcsConfigOverride: { bucketName: 'test-bucket', strictProduction: true },
      gcsAdapter: okGcs,
    });
    assert.equal(secondRun.status, 'skipped_completed');
    assert.equal(secondRun.skipped, true);
    assert.equal(db.getOrCreateUsageRecord('worker-user-1').renders_used, usageBefore);

    // 12. Duplicate concurrent worker lock test
    seedJob('rjob-locked', 'clip-w-1', 'running', 'running');
    const lockedRes = await executeRenderWorkerJob({
      renderJobId: 'rjob-locked',
      db,
      renderClipFn: mockRenderOk,
    });
    assert.equal(lockedRes.status, 'skipped_locked');
    assert.equal(lockedRes.skipped, true);

    // 13. Cancelled job exits cleanly without rendering
    seedJob('rjob-cancelled', 'clip-w-1', 'cancelled', 'cancelled');
    let renderCalledOnCancel = false;
    const cancelRes = await executeRenderWorkerJob({
      renderJobId: 'rjob-cancelled',
      db,
      renderClipFn: async () => {
        renderCalledOnCancel = true;
        return mockRenderOk();
      },
    });
    assert.equal(cancelRes.status, 'cancelled');
    assert.equal(renderCalledOnCancel, false);

    // 14. DB update failure after upload marks job failed with DB_UPDATE_FAILED
    seedJob('rjob-db-fail');
    const dbFailRes = await executeRenderWorkerJob({
      renderJobId: 'rjob-db-fail',
      db,
      renderClipFn: mockRenderOk,
      gcsConfigOverride: { bucketName: 'test-bucket', strictProduction: true },
      gcsAdapter: okGcs,
      persistJobCompletionFn: async () => {
        throw new Error('PostgreSQL connection reset during commit');
      },
    });
    assert.equal(dbFailRes.status, 'failed');
    assert.equal(dbFailRes.errorCode, 'DB_UPDATE_FAILED');
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// =============================================================================
// 12.3 POSTGRESQL / CLOUD SQL RUNTIME, TRANSACTIONS & STAGED MIGRATION
// =============================================================================

test('12.3 PostgreSQL connection config, transactions (commit/rollback), PgRenderJobStore atomic claim, and staged SQLite->PG migration', async () => {
  // Cloud SQL Unix socket resolution
  const unixResolved = resolvePgPoolConfig({
    instanceConnectionName: 'my-proj:asia-southeast2:aicliper-db',
    user: 'aicliper_app',
    password: 'pw',
    database: 'aicliper',
    maxPoolSize: 12,
  });
  assert.equal(unixResolved.configured, true);
  assert.equal(unixResolved.connectionMode, 'cloud_sql_unix_socket');
  assert.equal(unixResolved.poolConfig?.host, '/cloudsql/my-proj:asia-southeast2:aicliper-db');
  assert.equal(unixResolved.poolConfig?.max, 12);

  // TCP + TLS resolution
  const tlsResolved = resolvePgPoolConfig({
    host: '10.0.0.5',
    port: 5432,
    user: 'aicliper_app',
    password: 'pw',
    database: 'aicliper',
    ssl: true,
  });
  assert.equal(tlsResolved.connectionMode, 'tcp_tls');
  assert.ok(tlsResolved.poolConfig?.ssl);

  // Error sanitization never leaks password
  const sanitized = sanitizePgErrorMessage(
    new Error('connect postgresql://admin:SuperSecretPass99@10.0.0.5/aicliper password=SuperSecretPass99 failed')
  );
  assert.ok(!sanitized.includes('SuperSecretPass99'));

  // Explicit transaction commit & rollback behavior
  const txLog: string[] = [];
  const fakePoolForTx = {
    async connect() {
      return {
        async query(sql: string) {
          txLog.push(sql);
          return { rows: [], rowCount: 0 };
        },
        release() {
          txLog.push('RELEASE');
        },
      } as never;
    },
  };
  await withPgTransaction(async (client) => {
    await client.query('INSERT INTO test VALUES ($1)');
    return 'ok';
  }, fakePoolForTx);
  assert.deepEqual(txLog, ['BEGIN', 'INSERT INTO test VALUES ($1)', 'COMMIT', 'RELEASE']);

  txLog.length = 0;
  await assert.rejects(() =>
    withPgTransaction(async () => {
      throw new Error('simulated failure');
    }, fakePoolForTx)
  );
  assert.deepEqual(txLog, ['BEGIN', 'ROLLBACK', 'RELEASE']);

  // PgRenderJobStore parameterized queries & atomic worker claim
  const jobRows = new Map<string, Record<string, unknown>>();
  const queriesRecorded: Array<{ sql: string; values?: unknown[] }> = [];
  const mockPgPool: PgQueryable = {
    async query(sql: string, values?: unknown[]) {
      queriesRecorded.push({ sql, values });
      if (/INSERT INTO render_jobs/i.test(sql)) {
        const id = String(values?.[0]);
        const row = {
          id,
          user_uid: values?.[1],
          project_id: values?.[2],
          clip_id: values?.[3],
          status: values?.[4],
          stage: values?.[5],
          progress: values?.[6],
          render_profile: values?.[7],
          source_fingerprint: values?.[8],
          render_fingerprint: values?.[9],
          cloud_task_name: values?.[10],
          cloud_run_execution: values?.[11],
          retry_count: 0,
          quota_consumed: false,
          payload_json: JSON.parse(String(values?.[12] ?? '{}')),
          created_at: new Date(),
          updated_at: new Date(),
        };
        jobRows.set(id, row);
        return { rows: [row], rowCount: 1 } as never;
      }
      if (/SET status = 'running'/i.test(sql)) {
        const id = String(values?.[0]);
        const existing = jobRows.get(id);
        if (existing && ['queued', 'dispatching', 'failed'].includes(String(existing.status))) {
          existing.status = 'running';
          existing.worker_claim_token = values?.[1];
          return { rows: [existing], rowCount: 1 } as never;
        }
        return { rows: [], rowCount: 0 } as never;
      }
      if (/SELECT \* FROM render_jobs WHERE id = \$1/i.test(sql)) {
        const existing = jobRows.get(String(values?.[0]));
        if (existing && values && values.length === 2 && existing.user_uid !== values[1]) {
          return { rows: [], rowCount: 0 } as never;
        }
        return { rows: existing ? [existing] : [], rowCount: existing ? 1 : 0 } as never;
      }
      return { rows: [{ c: jobRows.size }], rowCount: 1 } as never;
    },
  };

  const pgStore = new PgRenderJobStore(mockPgPool);
  await pgStore.createOrUpsertRenderJob({
    id: 'pg-job-1',
    userUid: 'uid-alpha',
    projectId: 'ep-1',
    clipId: 'clip-1',
    status: 'queued',
    stage: 'Queued',
    renderProfile: 'balanced_1080p',
    sourceFingerprint: 'sfp',
    renderFingerprint: 'rfp',
  });
  // Ownership isolation check
  assert.equal(await pgStore.getRenderJobById('pg-job-1', 'uid-other'), null);
  assert.ok(await pgStore.getRenderJobById('pg-job-1', 'uid-alpha'));
  // Atomic claim succeeds once, blocks second concurrent claim
  const claim1 = await pgStore.claimJobForWorker({ jobId: 'pg-job-1', claimToken: 'tok-1' });
  const claim2 = await pgStore.claimJobForWorker({ jobId: 'pg-job-1', claimToken: 'tok-2' });
  assert.equal(claim1.claimed, true);
  assert.equal(claim2.claimed, false);

  // Staged SQLite -> PostgreSQL migration creates backup, preserves SQLite, validates integrity & imports
  const tmpDir = createTempDir('aicliper-mig-');
  const sqlitePath = path.join(tmpDir, 'source.sqlite');
  const sqliteDb = new KlipCastDatabase({ dbPath: sqlitePath, dataDir: tmpDir });
  try {
    sqliteDb.upsertAuthenticatedUser({
      uid: 'mig-u1',
      email: 'mig1@test.dev',
      displayName: 'Mig 1',
      photoUrl: null,
      resolvedRole: 'user',
    });
    sqliteDb.upsertRenderJob({
      jobId: 'mig-rj-1',
      clipId: 'mig-clip-1',
      userUid: 'mig-u1',
      layout: 'shorts_full_bleed',
      quality: '1080p',
      status: 'completed',
      stage: 'Done',
      progress: 100,
      resultJson: JSON.stringify({ width: 1080, height: 1920 }),
    });
    sqliteDb.close();

    const pgCounts: Record<string, number> = {
      users: 0,
      render_jobs: 0,
      render_assets: 0,
      job_events: 0,
      performance_metrics: 0,
    };
    const migPgPool: PgQueryable = {
      async query(sql: string) {
        const insMatch = sql.match(/INSERT INTO (\w+)/i);
        if (insMatch && pgCounts[insMatch[1]] !== undefined) {
          pgCounts[insMatch[1]] += 1;
          return { rows: [], rowCount: 1 } as never;
        }
        const cntMatch = sql.match(/SELECT COUNT\(\*\)::int AS c FROM (\w+)/i);
        if (cntMatch) {
          return { rows: [{ c: pgCounts[cntMatch[1]] ?? 0 }], rowCount: 1 } as never;
        }
        return { rows: [], rowCount: 0 } as never;
      },
    };

    const report = await runStagedSqliteToPostgresMigration({
      sqlitePath,
      backupDir: path.join(tmpDir, 'backups'),
      pgPool: migPgPool,
    });
    assert.equal(report.overallSuccess, true);
    assert.ok(report.backupPath && fs.existsSync(report.backupPath));
    assert.ok(fs.existsSync(sqlitePath), 'Original SQLite must NOT be deleted');
    assert.equal(report.migrationsApplied.length, 4);
    assert.equal(report.tables.find((t) => t.table === 'users')?.matched, true);
    assert.equal(report.tables.find((t) => t.table === 'render_jobs')?.matched, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// =============================================================================
// 12.4 GOOGLE CLOUD STORAGE PRODUCTION ENFORCEMENT & TENANT ISOLATION
// =============================================================================

test('12.4 GCS production enforcement, tenant ownership isolation, key validation, signed URLs, upload policy, and resumable threshold', async () => {
  const tmpDir = createTempDir('aicliper-gcs-');
  try {
    const sampleFile = path.join(tmpDir, 'sample.mp4');
    fs.writeFileSync(sampleFile, Buffer.alloc(1024, 0x42));

    // 1. Strict production mode MUST throw GCS_NOT_CONFIGURED (never silent local fallback)
    await assert.rejects(
      () =>
        uploadLocalFileToStorage({
          localFilePath: sampleFile,
          userUid: 'user-a',
          projectId: 'proj-1',
          category: 'renders',
          filename: 'clip.mp4',
          configOverride: { bucketName: '', strictProduction: true },
        }),
      (err: unknown) => err instanceof GcsStorageError && err.code === 'GCS_NOT_CONFIGURED'
    );

    // 2. Object key validation & path traversal blocking
    assert.throws(
      () => validateObjectKey('users/user-a/../../etc/passwd'),
      (err: unknown) => err instanceof GcsStorageError && err.code === 'INVALID_OBJECT_KEY'
    );
    assert.throws(
      () => assertUserOwnsObjectKey('user-b', 'users/user-a/projects/p1/renders/clip.mp4'),
      (err: unknown) => err instanceof GcsStorageError && err.code === 'UNAUTHORIZED_ACCESS'
    );

    // 3. Upload policy rejects bad MIME type & oversized file
    assert.throws(
      () => validateUploadPolicy({ contentType: 'application/x-msdownload', sizeBytes: 1000 }),
      (err: unknown) => err instanceof GcsStorageError && err.code === 'INVALID_CONTENT_TYPE'
    );
    assert.throws(
      () => validateUploadPolicy({ contentType: 'video/mp4', sizeBytes: 10_000, maxUploadBytes: 5_000 }),
      (err: unknown) => err instanceof GcsStorageError && err.code === 'FILE_TOO_LARGE'
    );

    // 4. Upload, signed URL, cross-user block, download, delete, missing object
    const { adapter, objects } = createMemoryGcsAdapter();
    const gcsCfg = { bucketName: 'aicliper-prod-bucket', strictProduction: true };
    const uploaded = await uploadLocalFileToStorage({
      localFilePath: sampleFile,
      userUid: 'user-a',
      projectId: 'proj-1',
      category: 'renders',
      filename: 'out.mp4',
      configOverride: gcsCfg,
      gcsAdapter: adapter,
    });
    assert.equal(uploaded.backend, 'gcs');
    assert.equal(uploaded.gcsUri, 'gs://aicliper-prod-bucket/users/user-a/projects/proj-1/renders/out.mp4');
    assert.equal(uploaded.resumableUsed, false);

    // Large file triggers resumable upload (> 5 MiB)
    const largeFile = path.join(tmpDir, 'large.mp4');
    fs.writeFileSync(largeFile, Buffer.alloc(RESUMABLE_UPLOAD_THRESHOLD_BYTES + 4096, 0x11));
    const largeRes = await uploadLocalFileToStorage({
      localFilePath: largeFile,
      userUid: 'user-a',
      projectId: 'proj-1',
      category: 'sources',
      filename: 'master.mp4',
      configOverride: gcsCfg,
      gcsAdapter: adapter,
    });
    assert.equal(largeRes.resumableUsed, true);

    // Valid signed URL for owner
    const signed = await generateSignedReadUrl({
      objectKey: uploaded.objectKey,
      requesterUid: 'user-a',
      ttlSec: 300,
      configOverride: gcsCfg,
      gcsAdapter: adapter,
    });
    assert.ok(signed?.url.includes('X-Goog-Expires=300'));

    // Invalid TTL rejected
    await assert.rejects(
      () =>
        generateSignedReadUrl({
          objectKey: uploaded.objectKey,
          requesterUid: 'user-a',
          ttlSec: 5,
          configOverride: gcsCfg,
          gcsAdapter: adapter,
        }),
      (err: unknown) => err instanceof GcsStorageError && err.code === 'INVALID_SIGNED_URL_TTL'
    );

    // Unauthorized cross-user signed URL & download blocked
    await assert.rejects(
      () =>
        generateSignedReadUrl({
          objectKey: uploaded.objectKey,
          requesterUid: 'user-b',
          configOverride: gcsCfg,
          gcsAdapter: adapter,
        }),
      (err: unknown) => err instanceof GcsStorageError && err.code === 'UNAUTHORIZED_ACCESS'
    );
    await assert.rejects(
      () =>
        downloadMediaToLocalPath({
          objectKey: uploaded.gcsUri,
          requesterUid: 'user-b',
          destinationPath: path.join(tmpDir, 'stolen.mp4'),
          configOverride: gcsCfg,
          gcsAdapter: adapter,
        }),
      (err: unknown) => err instanceof GcsStorageError && err.code === 'UNAUTHORIZED_ACCESS'
    );

    // Owner download succeeds
    const dlPath = path.join(tmpDir, 'downloaded.mp4');
    const dl = await downloadMediaToLocalPath({
      objectKey: uploaded.gcsUri,
      requesterUid: 'user-a',
      destinationPath: dlPath,
      configOverride: gcsCfg,
      gcsAdapter: adapter,
    });
    assert.equal(dl.sizeBytes, 1024);

    // Owner delete succeeds, second delete returns OBJECT_NOT_FOUND
    const del = await deleteStorageObject({
      objectKey: uploaded.objectKey,
      requesterUid: 'user-a',
      configOverride: gcsCfg,
      gcsAdapter: adapter,
    });
    assert.equal(del.deleted, true);
    assert.equal(objects.has(uploaded.objectKey), false);
    await assert.rejects(
      () =>
        deleteStorageObject({
          objectKey: uploaded.objectKey,
          requesterUid: 'user-a',
          configOverride: gcsCfg,
          gcsAdapter: adapter,
        }),
      (err: unknown) => err instanceof GcsStorageError && err.code === 'OBJECT_NOT_FOUND'
    );

    // Readiness check
    const gcsReady = await checkGcsReadiness({ configOverride: gcsCfg, gcsAdapter: adapter });
    assert.equal(gcsReady.operational, true);
    const gcsUnconf = await checkGcsReadiness({
      configOverride: { bucketName: '', strictProduction: true },
    });
    assert.equal(gcsUnconf.operational, false);
    assert.equal(gcsUnconf.mode, 'gcs_misconfigured');

    // Sanity on object key builder
    assert.equal(
      buildUserMediaObjectKey({ userUid: 'u1', projectId: 'p1', category: 'thumbnails', filename: 'thumb.jpg' }),
      'users/u1/projects/p1/thumbnails/thumb.jpg'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// =============================================================================
// 12.5 END-TO-END FLOW: API -> DB -> CLOUD TASKS -> OIDC DISPATCHER ->
//      CLOUD RUN JOB -> STANDALONE RENDER WORKER -> REAL FFMPEG/FFPROBE -> GCS -> DB
// =============================================================================

test('12.5 Full E2E Phase 0B Flow with real FFmpeg & FFprobe: 1080p, 4K, sub-1080p no-upscaling, audio/no-audio, short & longer clips, and /api/v3/readiness', async () => {
  const tmpDir = createTempDir('aicliper-e2e-0b-');
  const db = new KlipCastDatabase({
    dbPath: path.join(tmpDir, 'e2e.sqlite'),
    dataDir: tmpDir,
  });
  const createdUploadFiles: string[] = [];

  const capturedQueuePayloads: Array<Record<string, unknown>> = [];
  const capturedRunJobDispatches: Array<{ renderJobId: string; userUid: string; clipId: string }> = [];
  const { adapter: gcsAdapter, objects: gcsObjects } = createMemoryGcsAdapter();
  const gcsCfg = { bucketName: 'aicliper-e2e-bucket', strictProduction: true };
  const oidcCfg = {
    expectedServiceAccountEmail: 'aicliper-tasks-invoker-sa@e2e-proj.iam.gserviceaccount.com',
    allowedAudiences: ['https://aicliper-api.run.app'],
  };

  db.upsertAuthenticatedUser({
    uid: 'e2e-pro-user',
    email: 'e2e-pro@aicliper.test',
    displayName: 'E2E Pro User',
    photoUrl: null,
    resolvedRole: 'admin',
  });
  db.updateUserPlan('e2e-pro-user', 'pro');

  const { app } = createApp({
    db,
    disableRateLimit: true,
    requireCloudTasksDispatch: true,
    verifyToken: async (token) => {
      if (token === 'valid-user-token') {
        return {
          uid: 'e2e-pro-user',
          email: 'e2e-pro@aicliper.test',
          emailVerified: true,
          name: 'E2E Pro User',
          picture: null,
          signInProvider: 'google.com',
          authTime: Math.floor(Date.now() / 1000),
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        };
      }
      throw new Error('Unauthorized');
    },
    enqueueCloudTaskFn: async (input) => {
      capturedQueuePayloads.push(input.payload);
      return {
        enqueued: true,
        backend: 'cloud_tasks',
        taskName: `projects/e2e-proj/locations/asia-southeast2/queues/video-render-queue/tasks/${input.idempotencyKey.slice(0, 16)}`,
        deduplicated: false,
        queueName: 'video-render-queue',
        targetUrl: `https://aicliper-api.run.app${input.targetPath}`,
        oidcAudience: 'https://aicliper-api.run.app',
        queueLatencyMs: 4,
      };
    },
    oidcConfigOverride: oidcCfg,
    verifyOidcIdTokenFn: async ({ idToken }) => {
      if (idToken === 'valid-cloud-tasks-oidc') {
        return {
          iss: 'https://accounts.google.com',
          sub: 'tasks-sa-sub',
          aud: 'https://aicliper-api.run.app',
          email: oidcCfg.expectedServiceAccountEmail,
          email_verified: true,
          exp: Math.floor(Date.now() / 1000) + 300,
        };
      }
      throw new Error('Invalid OIDC JWT');
    },
    dispatchCloudRunJobFn: async (input) => {
      capturedRunJobDispatches.push({
        renderJobId: input.renderJobId,
        userUid: input.userUid,
        clipId: input.clipId,
      });
      return {
        dispatched: true,
        backend: 'cloud_run_jobs',
        executionName: `projects/e2e-proj/locations/asia-southeast2/jobs/aicliper-render-worker/executions/exec-${input.renderJobId}`,
        jobName: 'aicliper-render-worker',
        authMode: 'google_adc',
        dispatchLatencyMs: 7,
        message: 'Dispatched via ADC',
      };
    },
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // Verify unauthenticated request to internal dispatcher is REJECTED (401)
    const unauthDispatch = await httpJsonRequest(
      baseUrl,
      'POST',
      '/api/internal/dispatch/render',
      {},
      { jobId: 'x', userUid: 'y', clipId: 'z', renderProfile: 'balanced_1080p', renderFingerprint: 'abcd' }
    );
    assert.equal(unauthDispatch.status, 401);
    assert.equal(unauthDispatch.json.code, 'OIDC_MISSING');

    const scenarios: Array<{
      name: string;
      episodeId: string;
      clipId: string;
      srcW: number;
      srcH: number;
      durationSec: number;
      withAudio: boolean;
      requestedProfile: 'balanced_1080p' | 'balanced_4k';
      requestedQuality: '1080p' | '4k';
      layout: 'shorts_full_bleed' | 'full_16_9_focus';
      expectUpscalePrevented: boolean;
      minOutW: number;
      minOutH: number;
    }> = [
      {
        name: '1080p source + Balanced 1080p + audio (short 5s clip)',
        episodeId: 'ep-0b-1080p',
        clipId: 'clip-0b-1080p',
        srcW: 1920,
        srcH: 1080,
        durationSec: 5,
        withAudio: true,
        requestedProfile: 'balanced_1080p',
        requestedQuality: '1080p',
        layout: 'shorts_full_bleed',
        expectUpscalePrevented: false,
        minOutW: 1080,
        minOutH: 1920,
      },
      {
        name: 'Sub-1080p (720p) source + 4K requested -> NO upscaling',
        episodeId: 'ep-0b-720p',
        clipId: 'clip-0b-720p',
        srcW: 1280,
        srcH: 720,
        durationSec: 5,
        withAudio: true,
        requestedProfile: 'balanced_4k',
        requestedQuality: '4k',
        layout: 'full_16_9_focus',
        expectUpscalePrevented: true,
        minOutW: 1280,
        minOutH: 720,
      },
      {
        name: '4K (3840x2160) source + Balanced 4K -> genuine 4K output',
        episodeId: 'ep-0b-4k',
        clipId: 'clip-0b-4k',
        srcW: 3840,
        srcH: 2160,
        durationSec: 5,
        withAudio: true,
        requestedProfile: 'balanced_4k',
        requestedQuality: '4k',
        layout: 'full_16_9_focus',
        expectUpscalePrevented: false,
        minOutW: 3840,
        minOutH: 2160,
      },
      {
        name: 'Video WITHOUT audio stream -> clean render & FFprobe validation',
        episodeId: 'ep-0b-noaudio',
        clipId: 'clip-0b-noaudio',
        srcW: 1920,
        srcH: 1080,
        durationSec: 5,
        withAudio: false,
        requestedProfile: 'balanced_1080p',
        requestedQuality: '1080p',
        layout: 'shorts_full_bleed',
        expectUpscalePrevented: false,
        minOutW: 1080,
        minOutH: 1920,
      },
      {
        name: 'Longer clip (12s) with audio -> verified duration & audio',
        episodeId: 'ep-0b-long',
        clipId: 'clip-0b-long',
        srcW: 1920,
        srcH: 1080,
        durationSec: 12,
        withAudio: true,
        requestedProfile: 'balanced_1080p',
        requestedQuality: '1080p',
        layout: 'shorts_full_bleed',
        expectUpscalePrevented: false,
        minOutW: 1080,
        minOutH: 1920,
      },
    ];

    for (const sc of scenarios) {
      const uploadPath = getUploadTargetPath(sc.episodeId);
      generateSyntheticMp4({
        targetPath: uploadPath,
        width: sc.srcW,
        height: sc.srcH,
        durationSec: sc.durationSec,
        withAudio: sc.withAudio,
      });
      createdUploadFiles.push(uploadPath);

      const { episode, clip } = makeFixtureEpisodeAndClip({
        userUid: 'e2e-pro-user',
        episodeId: sc.episodeId,
        clipId: sc.clipId,
        startSec: 0,
        endSec: sc.durationSec,
        durationSec: sc.durationSec,
      });
      db.upsertEpisode('e2e-pro-user', episode);
      db.upsertClip('e2e-pro-user', clip);

      // Step 1: API enqueue -> Cloud Tasks
      const enqueueRes = await httpJsonRequest(
        baseUrl,
        'POST',
        '/api/v3/renders/enqueue',
        { Authorization: 'Bearer valid-user-token' },
        {
          clipId: sc.clipId,
          layout: sc.layout,
          quality: sc.requestedQuality,
          renderProfile: sc.requestedProfile,
          enableAiIntro: false,
          enableEmotionEffects: false,
          forceRestart: true,
        }
      );
      assert.equal(enqueueRes.status, 202, `Scenario "${sc.name}" enqueue failed`);
      assert.equal(enqueueRes.json.executionMode, 'cloud_tasks_dispatcher');
      assert.equal(enqueueRes.json.status, 'queued');

      const queuedPayload = capturedQueuePayloads[capturedQueuePayloads.length - 1];
      assert.equal(queuedPayload.jobId, enqueueRes.json.jobId);

      // Step 2: Cloud Tasks calls Authenticated OIDC Dispatcher
      const dispatchRes = await httpJsonRequest(
        baseUrl,
        'POST',
        '/api/internal/dispatch/render',
        {
          Authorization: 'Bearer valid-cloud-tasks-oidc',
          'X-CloudTasks-TaskName': String(enqueueRes.json.cloudTaskName ?? ''),
        },
        queuedPayload
      );
      assert.equal(dispatchRes.status, 200, `Scenario "${sc.name}" dispatcher failed`);
      assert.equal(dispatchRes.json.dispatched, true);
      assert.equal(dispatchRes.json.deduplicated, false);
      assert.equal(dispatchRes.json.authMode, 'google_adc');

      // Verify duplicate Cloud Tasks delivery is idempotently deduplicated
      const dupDispatch = await httpJsonRequest(
        baseUrl,
        'POST',
        '/api/internal/dispatch/render',
        { Authorization: 'Bearer valid-cloud-tasks-oidc' },
        queuedPayload
      );
      assert.equal(dupDispatch.status, 200);
      assert.equal(dupDispatch.json.deduplicated, true);

      // Step 3: Standalone Cloud Run Render Worker executes real FFmpeg + FFprobe + GCS upload + DB update
      const workerResult = await executeRenderWorkerJob({
        renderJobId: String(enqueueRes.json.jobId),
        expectedUserUid: 'e2e-pro-user',
        expectedClipId: sc.clipId,
        executionName: String(dispatchRes.json.executionName),
        db,
        gcsConfigOverride: gcsCfg,
        gcsAdapter,
      });

      assert.equal(
        workerResult.status,
        'completed',
        `Scenario "${sc.name}" worker failed: ${workerResult.errorCode} ${workerResult.errorMessage}`
      );
      assert.ok(workerResult.output, `Scenario "${sc.name}" missing output metadata`);
      assert.equal(workerResult.output.storageBackend, 'gcs');
      assert.ok(workerResult.output.gcsUri.startsWith('gs://aicliper-e2e-bucket/users/e2e-pro-user/'));
      assert.equal(workerResult.output.upscalePrevented, sc.expectUpscalePrevented);
      assert.ok(workerResult.output.width >= sc.minOutW, `Expected width >= ${sc.minOutW}, got ${workerResult.output.width}`);
      assert.ok(workerResult.output.height >= sc.minOutH, `Expected height >= ${sc.minOutH}, got ${workerResult.output.height}`);
      if (sc.expectUpscalePrevented) {
        assert.ok(workerResult.output.width <= sc.srcW, 'Must NOT upscale sub-1080p video above source width');
      }
      if (sc.withAudio) {
        assert.ok(workerResult.output.audioCodec, `Expected audio stream in "${sc.name}"`);
      } else {
        assert.equal(workerResult.output.audioCodec, null, `Expected no audio stream in "${sc.name}"`);
      }

      // Independent FFprobe verification on the uploaded GCS object bytes
      const gcsKey = workerResult.output.gcsUri.replace('gs://aicliper-e2e-bucket/', '');
      const storedObj = gcsObjects.get(gcsKey);
      assert.ok(storedObj && storedObj.data.length > 5_000, `Uploaded GCS MP4 missing for "${sc.name}"`);
      const probeCopy = path.join(tmpDir, `verify_${sc.clipId}.mp4`);
      fs.writeFileSync(probeCopy, storedObj.data);
      const independentProbe = await probeVideoMeta(probeCopy);
      assert.equal(independentProbe.videoCodec, 'h264');
      assert.ok(independentProbe.durationSec >= sc.durationSec - 0.6);

      // Verify DB finalized to completed
      assert.equal(db.getRenderJobById(String(enqueueRes.json.jobId))?.status, 'completed');
      assert.equal(db.getRenderJobCloudState(String(enqueueRes.json.jobId))?.lifecycleStatus, 'completed');
    }

    // Verify /api/v3/readiness returns honest 5-level schema & real telemetry from the 5 completed renders
    const readinessRes = await httpJsonRequest(
      baseUrl,
      'GET',
      '/api/v3/readiness',
      { Authorization: 'Bearer valid-user-token' }
    );
    assert.equal(readinessRes.status, 200);
    assert.equal(readinessRes.json.phase, '0B');
    const authSection = readinessRes.json.auth as { staticGcpAccessTokenForbidden: boolean };
    assert.equal(authSection.staticGcpAccessTokenForbidden, true);
    const telemetry = readinessRes.json.telemetry as {
      completedRenderCount: number;
      lastSuccessfulRenderAt: string | null;
      avgRenderDurationMs: number | null;
      avgUploadDurationMs: number | null;
    };
    assert.equal(telemetry.completedRenderCount, scenarios.length);
    assert.ok(telemetry.lastSuccessfulRenderAt);
    assert.ok(typeof telemetry.avgRenderDurationMs === 'number' && telemetry.avgRenderDurationMs > 0);
    assert.ok(typeof telemetry.avgUploadDurationMs === 'number');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const f of createdUploadFiles) {
      if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    }
    for (const cid of ['clip-0b-1080p', 'clip-0b-720p', 'clip-0b-4k', 'clip-0b-noaudio', 'clip-0b-long']) {
      const rendered = path.resolve(process.cwd(), 'data', 'renders', `${cid}.mp4`);
      if (fs.existsSync(rendered)) fs.rmSync(rendered, { force: true });
    }
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
