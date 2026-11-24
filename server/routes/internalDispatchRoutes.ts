/**
 * AICLIPER Fase 0B — Authenticated Internal Cloud Tasks Render Dispatcher
 *
 * Endpoints:
 *   - POST /api/internal/dispatch/render
 *   - POST /workers/render/execute  (alias mounted in server.ts)
 *
 * Security & Lifecycle:
 *   1. Strictly protected by Google Cloud Tasks OIDC JWT verification middleware.
 *   2. Validates request payload (jobId, userUid, clipId, renderProfile, renderFingerprint).
 *   3. Verifies job existence & user ownership against DB (PostgreSQL when configured + SQLite).
 *   4. Prevents duplicate execution if job is already dispatching/running/uploading/completed/cancelled.
 *   5. Triggers Cloud Run Job via Google ADC (`dispatchCloudRunRenderJob`).
 *   6. Persists `cloudRunExecution` & `cloudTaskName`, records latency metrics & job_events.
 *   7. Returns explicit HTTP 503 on transient cloud errors so Cloud Tasks can retry safely.
 */

import { Router, type Response } from 'express';
import { z } from 'zod';
import type { KlipCastDatabase } from '../db.ts';
import type { V3Repository } from '../repositories/v3Repository.ts';
import {
  CloudRunJobsError,
  dispatchCloudRunRenderJob,
  type CloudRunDispatchDependencies,
  type CloudRunJobDispatchInput,
  type CloudRunJobDispatchResult,
} from '../services/cloudRunJobsService.ts';
import {
  createCloudTasksOidcMiddleware,
  type OidcAuthenticatedRequest,
  type OidcVerifierConfig,
  type VerifyIdTokenFn,
} from '../services/oidcVerifier.ts';
import { PgRenderJobStore } from '../services/pgJobStore.ts';
import {
  logStructuredEvent,
  redactSensitiveString,
  sanitizeCorrelationId,
} from '../services/structuredLogger.ts';

const DispatchRenderPayloadSchema = z.object({
  jobId: z.string().min(3).max(160),
  userUid: z.string().min(1).max(160),
  clipId: z.string().min(1).max(160),
  renderProfile: z.string().min(1).max(80).default('balanced_1080p'),
  renderFingerprint: z.string().min(4).max(160),
  sourceFingerprint: z.string().max(160).optional(),
  queueTaskName: z.string().max(500).optional(),
  correlationId: z.string().max(128).optional(),
  expiresAt: z.string().max(64).optional(),
});

export interface InternalDispatchRouterOptions {
  db: KlipCastDatabase;
  v3Repo: V3Repository;
  pgJobStore?: PgRenderJobStore;
  oidcConfigOverride?: Partial<OidcVerifierConfig>;
  verifyIdTokenFn?: VerifyIdTokenFn;
  dispatchCloudRunJobFn?: (
    input: CloudRunJobDispatchInput,
    deps?: CloudRunDispatchDependencies
  ) => Promise<CloudRunJobDispatchResult>;
  cloudRunDeps?: CloudRunDispatchDependencies;
  strictProduction?: boolean;
}

export function createInternalDispatchRouter(options: InternalDispatchRouterOptions): Router {
  const router = Router();
  const pgStore = options.pgJobStore ?? new PgRenderJobStore();
  const dispatchExec = options.dispatchCloudRunJobFn ?? dispatchCloudRunRenderJob;

  const oidcMiddleware = createCloudTasksOidcMiddleware({
    configOverride: options.oidcConfigOverride,
    verifyIdTokenFn: options.verifyIdTokenFn,
  });

  const handleDispatch = async (req: OidcAuthenticatedRequest, res: Response) => {
    const startedAt = Date.now();
    const parsed = DispatchRenderPayloadSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: 'Payload dispatcher render tidak valid.',
        code: 'INVALID_DISPATCH_PAYLOAD',
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      return;
    }

    const payload = parsed.data;
    const cloudTaskName =
      payload.queueTaskName ||
      String(req.headers['x-cloudtasks-taskname'] ?? '').trim() ||
      '';
    const correlationId =
      sanitizeCorrelationId(payload.correlationId) ??
      sanitizeCorrelationId(String(req.headers['x-correlation-id'] ?? '')) ??
      `corr_${payload.jobId}`;
    const taskRetryCountRaw = Number(req.headers['x-cloudtasks-taskretrycount'] ?? 0);
    const taskRetryCount = Number.isFinite(taskRetryCountRaw) && taskRetryCountRaw > 0 ? taskRetryCountRaw : 0;

    // Guard against expired stale tasks delivered after SLA window
    if (payload.expiresAt) {
      const expiresMs = Date.parse(payload.expiresAt);
      if (Number.isFinite(expiresMs) && expiresMs < Date.now()) {
        logStructuredEvent({
          service: 'internal-render-dispatcher',
          event: 'dispatch_task_expired',
          severity: 'WARNING',
          correlationId,
          renderJobId: payload.jobId,
          userUid: payload.userUid,
          clipId: payload.clipId,
          queueTaskName: cloudTaskName,
          retryCount: taskRetryCount,
          stage: 'dispatching',
          errorCode: 'TASK_EXPIRED',
        });
        res.status(200).json({
          ok: true,
          expired: true,
          deduplicated: true,
          jobId: payload.jobId,
          correlationId,
          message: 'Task Cloud Tasks telah kedaluwarsa dan dilewati tanpa eksekusi ulang.',
        });
        return;
      }
    }

    const jobRow = options.db.getRenderJobById(payload.jobId);
    const cloudState = options.db.getRenderJobCloudState(payload.jobId);
    const pgJob = pgStore.isAvailable()
      ? await pgStore.getRenderJobById(payload.jobId).catch(() => null)
      : null;

    if (!jobRow && !pgJob) {
      res.status(404).json({
        error: `Render job "${payload.jobId}" tidak ditemukan di database.`,
        code: 'RENDER_JOB_NOT_FOUND',
      });
      return;
    }

    const ownerUid = jobRow?.userUid ?? pgJob?.userUid ?? '';
    const recordClipId = jobRow?.clipId ?? pgJob?.clipId ?? '';
    if (ownerUid !== payload.userUid || recordClipId !== payload.clipId) {
      logStructuredEvent({
        service: 'internal-render-dispatcher',
        event: 'dispatch_ownership_mismatch',
        severity: 'WARNING',
        renderJobId: payload.jobId,
        userUid: payload.userUid,
        clipId: payload.clipId,
        stage: 'dispatching',
        errorCode: 'OWNERSHIP_MISMATCH',
      });
      res.status(403).json({
        error: 'Kepemilikan render job atau clipId tidak cocok dengan data database.',
        code: 'OWNERSHIP_MISMATCH',
      });
      return;
    }

    // Idempotency & terminal-state guard
    const currentLifecycle = cloudState?.lifecycleStatus ?? pgJob?.status ?? jobRow?.status ?? 'queued';
    const existingExecution = cloudState?.cloudRunExecution || pgJob?.cloudRunExecution || '';
    if (
      currentLifecycle === 'completed' ||
      currentLifecycle === 'cancelled' ||
      currentLifecycle === 'running' ||
      currentLifecycle === 'uploading' ||
      (currentLifecycle === 'dispatching' && existingExecution)
    ) {
      res.status(200).json({
        ok: true,
        deduplicated: true,
        jobId: payload.jobId,
        status: currentLifecycle,
        executionName: existingExecution || null,
        message: `Job sudah berstatus ${currentLifecycle}; pemicuan ganda dilewati secara idempoten.`,
      });
      return;
    }

    // Atomically transition queued/failed -> dispatching
    let claimedForDispatch = true;
    if (jobRow) {
      if (!cloudState) {
        options.db.upsertRenderJobCloudState({
          jobId: payload.jobId,
          userUid: payload.userUid,
          clipId: payload.clipId,
          lifecycleStatus: 'queued',
          renderProfile: payload.renderProfile,
          sourceFingerprint: payload.sourceFingerprint ?? '',
          renderFingerprint: payload.renderFingerprint,
          cloudTaskName,
        });
      }
      const claimRes = options.db.markRenderJobDispatching(payload.jobId, cloudTaskName);
      claimedForDispatch = claimRes.claimed;
    }
    if (pgStore.isAvailable()) {
      const pgClaim = await pgStore
        .markDispatching({ jobId: payload.jobId, cloudTaskName })
        .catch(() => ({ claimed: claimedForDispatch, job: null }));
      if (!jobRow) claimedForDispatch = pgClaim.claimed;
    }

    if (!claimedForDispatch) {
      const latestCloud = options.db.getRenderJobCloudState(payload.jobId);
      res.status(200).json({
        ok: true,
        deduplicated: true,
        jobId: payload.jobId,
        status: latestCloud?.lifecycleStatus ?? 'dispatching',
        executionName: latestCloud?.cloudRunExecution || null,
        message: 'Render job sudah sedang didispatch oleh delivery Cloud Tasks lain.',
      });
      return;
    }

    await options.v3Repo.recordJobEvent({
      jobId: payload.jobId,
      jobType: 'render',
      userUid: payload.userUid,
      stage: 'dispatching',
      status: 'started',
      message: 'Dispatcher terautentikasi OIDC memicu Cloud Run Job via Google ADC.',
      metadata: {
        correlationId,
        oidcServiceAccount: req.oidcCaller?.email ?? 'verified',
        queueTaskName: cloudTaskName,
        taskRetryCount,
        renderProfile: payload.renderProfile,
        renderFingerprint: payload.renderFingerprint,
      },
    });

    try {
      const dispatchResult = await dispatchExec(
        {
          renderJobId: payload.jobId,
          userUid: payload.userUid,
          clipId: payload.clipId,
          renderProfile: payload.renderProfile,
          renderFingerprint: payload.renderFingerprint,
          sourceFingerprint: payload.sourceFingerprint,
          queueTaskName: cloudTaskName,
          correlationId,
        },
        {
          ...options.cloudRunDeps,
          strictProduction: options.strictProduction ?? options.cloudRunDeps?.strictProduction,
        }
      );

      if (jobRow) {
        options.db.attachCloudRunExecution(
          payload.jobId,
          dispatchResult.executionName,
          cloudTaskName
        );
        options.db.upsertRenderJob({
          jobId: jobRow.jobId,
          clipId: jobRow.clipId,
          userUid: jobRow.userUid,
          layout: jobRow.layout,
          quality: jobRow.quality,
          status: 'running',
          stage: 'Cloud Run Job dipicu, menunggu render worker...',
          progress: Math.max(jobRow.progress, 10),
          retryCount: jobRow.retryCount,
          createdAt: jobRow.createdAt,
        });
      }
      if (pgStore.isAvailable()) {
        await pgStore
          .attachCloudRunExecution({
            jobId: payload.jobId,
            executionName: dispatchResult.executionName,
            cloudTaskName,
          })
          .catch(() => undefined);
      }

      const dispatchDurationMs = Date.now() - startedAt;
      await options.v3Repo.recordJobEvent({
        jobId: payload.jobId,
        jobType: 'render',
        userUid: payload.userUid,
        stage: 'dispatched',
        status: 'completed',
        message: dispatchResult.message,
        durationMs: dispatchDurationMs,
        metadata: {
          executionName: dispatchResult.executionName,
          backend: dispatchResult.backend,
          authMode: dispatchResult.authMode,
          queueTaskName: cloudTaskName,
        },
      });
      await options.v3Repo.recordPerformanceMetric({
        userUid: payload.userUid,
        category: 'render',
        operation: 'cloud_run_dispatch',
        durationMs: dispatchDurationMs,
        success: true,
        cacheHit: false,
        metadata: {
          jobId: payload.jobId,
          executionName: dispatchResult.executionName,
          backend: dispatchResult.backend,
        },
      });

      res.status(200).json({
        ok: true,
        deduplicated: false,
        jobId: payload.jobId,
        correlationId,
        status: 'dispatching',
        dispatched: dispatchResult.dispatched,
        backend: dispatchResult.backend,
        executionName: dispatchResult.executionName,
        authMode: dispatchResult.authMode,
        dispatchLatencyMs: dispatchDurationMs,
      });
    } catch (err) {
      const cloudErr =
        err instanceof CloudRunJobsError
          ? err
          : new CloudRunJobsError(
              'DISPATCH_FAILED',
              err instanceof Error ? redactSensitiveString(err.message) : 'Dispatch gagal.',
              { httpStatus: 503, retryable: true }
            );
      const elapsedMs = Date.now() - startedAt;

      if (jobRow) {
        options.db.upsertRenderJobCloudState({
          jobId: payload.jobId,
          userUid: payload.userUid,
          clipId: payload.clipId,
          lifecycleStatus: 'failed',
          failedStage: 'dispatching',
          cloudTaskName,
        });
        options.db.upsertRenderJob({
          jobId: jobRow.jobId,
          clipId: jobRow.clipId,
          userUid: jobRow.userUid,
          layout: jobRow.layout,
          quality: jobRow.quality,
          status: 'failed',
          stage: 'Gagal memicu Cloud Run Job.',
          progress: jobRow.progress,
          retryCount: jobRow.retryCount,
          durationMs: elapsedMs,
          errorCode: cloudErr.code,
          errorMessage: cloudErr.message,
          createdAt: jobRow.createdAt,
          completedAt: new Date().toISOString(),
        });
      }
      if (pgStore.isAvailable()) {
        await pgStore
          .updateJobLifecycle({
            jobId: payload.jobId,
            status: 'failed',
            stage: 'Gagal memicu Cloud Run Job.',
            durationMs: elapsedMs,
            errorCode: cloudErr.code,
            errorMessage: cloudErr.message,
            failedStage: 'dispatching',
          })
          .catch(() => undefined);
      }

      await options.v3Repo.recordJobEvent({
        jobId: payload.jobId,
        jobType: 'render',
        userUid: payload.userUid,
        stage: 'dispatching',
        status: 'failed',
        message: cloudErr.message,
        durationMs: elapsedMs,
        metadata: { errorCode: cloudErr.code, retryable: cloudErr.retryable },
      });
      await options.v3Repo.recordPerformanceMetric({
        userUid: payload.userUid,
        category: 'render',
        operation: 'cloud_run_dispatch',
        durationMs: elapsedMs,
        success: false,
        cacheHit: false,
        metadata: { jobId: payload.jobId, errorCode: cloudErr.code },
      });

      res.status(cloudErr.httpStatus).json({
        ok: false,
        error: cloudErr.message,
        code: cloudErr.code,
        retryable: cloudErr.retryable,
      });
    }
  };

  router.post('/render', oidcMiddleware, handleDispatch);
  router.post('/execute', oidcMiddleware, handleDispatch);

  return router;
}
