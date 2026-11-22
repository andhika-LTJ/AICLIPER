/**
 * AICLIPER AI Processing Worker Entrypoint (Phase 4)
 * Separates heavy AI analysis (transcript, clip discovery, active speaker detection)
 * from synchronous Express HTTP requests when deployed as a dedicated Cloud Run Worker
 * triggered via Google Cloud Tasks (`ai-analysis` queue).
 */

import type { KlipCastDatabase } from '../server/db.ts';
import { computeSourceFingerprint } from '../server/services/renderFingerprint.ts';

export interface AiWorkerTaskPayload {
  jobId: string;
  userUid: string;
  projectId: string;
  clipId?: string;
  sourceUrl: string;
  videoId: string;
  startSec: number;
  endSec: number;
  forceReanalyze?: boolean;
}

export interface AiWorkerExecutionSummary {
  jobId: string;
  sourceFingerprint: string;
  cacheReused: boolean;
  durationMs: number;
  status: 'completed' | 'skipped_cached';
}

export async function runAiAnalysisWorkerTask(
  db: KlipCastDatabase,
  payload: AiWorkerTaskPayload,
  executor?: (fp: string) => Promise<void>
): Promise<AiWorkerExecutionSummary> {
  const startedAt = Date.now();
  const sourceFingerprint = computeSourceFingerprint({
    videoId: payload.videoId,
    sourceUrl: payload.sourceUrl,
    startSec: payload.startSec,
    endSec: payload.endSec,
  });

  db.recordJobEvent({
    jobId: payload.jobId,
    jobType: 'ai_analysis',
    userUid: payload.userUid,
    stage: 'fingerprint_check',
    status: 'started',
    message: `Memeriksa cache analisis AI untuk fingerprint ${sourceFingerprint.slice(0, 12)}`,
  });

  const existingAsset = !payload.forceReanalyze
    ? db.findSourceAssetByFingerprint(payload.userUid, sourceFingerprint)
    : null;

  if (existingAsset) {
    const durationMs = Date.now() - startedAt;
    db.recordPerformanceMetric({
      userUid: payload.userUid,
      category: 'ai_analysis',
      operation: 'worker_source_reuse',
      durationMs,
      success: true,
      cacheHit: true,
      metadata: { sourceFingerprint, projectId: payload.projectId },
    });
    db.recordJobEvent({
      jobId: payload.jobId,
      jobType: 'ai_analysis',
      userUid: payload.userUid,
      stage: 'completed',
      status: 'completed',
      message: 'Cache sumber & analisis AI ditemukan; melewati unduh & analisis ulang.',
      durationMs,
    });
    return {
      jobId: payload.jobId,
      sourceFingerprint,
      cacheReused: true,
      durationMs,
      status: 'skipped_cached',
    };
  }

  if (executor) {
    await executor(sourceFingerprint);
  }

  const durationMs = Date.now() - startedAt;
  db.recordPerformanceMetric({
    userUid: payload.userUid,
    category: 'ai_analysis',
    operation: 'worker_full_analysis',
    durationMs,
    success: true,
    cacheHit: false,
    metadata: { sourceFingerprint, projectId: payload.projectId },
  });
  db.recordJobEvent({
    jobId: payload.jobId,
    jobType: 'ai_analysis',
    userUid: payload.userUid,
    stage: 'completed',
    status: 'completed',
    message: 'Analisis AI selesai pada worker terpisah.',
    durationMs,
  });

  return {
    jobId: payload.jobId,
    sourceFingerprint,
    cacheReused: false,
    durationMs,
    status: 'completed',
  };
}
