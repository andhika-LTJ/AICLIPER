import type { KlipCastDatabase } from './db.ts';

export type RenderJobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface ManagedRenderJob {
  jobId: string;
  clipId: string;
  userUid: string;
  layout: string;
  quality: string;
  dedupeKey: string;
  status: RenderJobStatus;
  stage: string;
  progress: number;
  retryCount: number;
  createdAt: number;
  updatedAt: number;
  abortController: AbortController;
  result?: Record<string, unknown>;
  error?: string;
  code?: string;
  externalWorker?: boolean;
}

export interface CreateOrReuseRenderJobResult {
  job: ManagedRenderJob;
  reused: boolean;
  preemptedJobIds: string[];
}

export class RenderJobManager {
  private readonly jobs = new Map<string, ManagedRenderJob>();
  private readonly retentionMs: number;
  private readonly db?: KlipCastDatabase;

  constructor(retentionMs = 60 * 60 * 1000, db?: KlipCastDatabase) {
    this.retentionMs = retentionMs;
    this.db = db;
  }

  private persist(job: ManagedRenderJob): void {
    if (!this.db || !job.userUid || job.userUid === 'anonymous') return;
    try {
      const isTerminal =
        job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
      const outputSizeBytes =
        typeof job.result?.sizeBytes === 'number' ? job.result.sizeBytes : null;
      this.db.upsertRenderJob({
        jobId: job.jobId,
        clipId: job.clipId,
        userUid: job.userUid,
        layout: job.layout,
        quality: job.quality,
        status: job.status,
        stage: job.stage,
        progress: job.progress,
        retryCount: job.retryCount,
        durationMs: isTerminal ? Math.max(0, job.updatedAt - job.createdAt) : null,
        outputSizeBytes,
        errorMessage: job.error ?? null,
        errorCode: job.code ?? null,
        resultJson: job.result
          ? JSON.stringify({
              videoUrl: job.result.videoUrl,
              sizeBytes: job.result.sizeBytes,
              width: job.result.width,
              height: job.result.height,
              layout: job.result.layout,
              quality: job.result.quality,
            })
          : null,
        createdAt: new Date(job.createdAt).toISOString(),
        completedAt: isTerminal ? new Date(job.updatedAt).toISOString() : null,
      });
    } catch {
      // Non-fatal persistence safeguard
    }
  }

  get(jobId: string): ManagedRenderJob | undefined {
    return this.jobs.get(jobId);
  }

  listActive(userUid?: string): ManagedRenderJob[] {
    const active: ManagedRenderJob[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === 'running' && (!userUid || job.userUid === userUid)) {
        active.push(job);
      }
    }
    return active;
  }

  pruneOld(now = Date.now()): void {
    const cutoff = now - this.retentionMs;
    for (const [id, job] of this.jobs.entries()) {
      if (job.status !== 'running' && job.createdAt < cutoff) {
        this.jobs.delete(id);
      }
    }
  }

  /**
   * Starts a new render job with per-user isolation & single-slot concurrency safety:
   * - If an identical job for the same user is already running and `forceRestart` is false, reuses it.
   * - For local in-process jobs, cancels only THIS user's other local running jobs (User B can never cancel User A's render!).
   * - Externally dispatched Cloud Tasks / Cloud Run Worker jobs are managed by the DB + worker lifecycle and are NOT preempted.
   */
  createOrReuse(params: {
    clipId: string;
    userUid?: string;
    layout?: string;
    quality?: string;
    dedupeKey: string;
    initialStage: string;
    initialProgress?: number;
    forceRestart?: boolean;
    externalWorker?: boolean;
  }): CreateOrReuseRenderJobResult {
    const now = Date.now();
    const userUid = params.userUid ?? 'system';
    this.pruneOld(now);

    if (!params.forceRestart) {
      for (const existing of this.jobs.values()) {
        if (
          existing.status === 'running' &&
          existing.userUid === userUid &&
          existing.dedupeKey === params.dedupeKey
        ) {
          if (existing.externalWorker && this.db) {
            const dbRow = this.db.getRenderJobById(existing.jobId);
            if (dbRow && dbRow.status !== 'running') {
              existing.status = dbRow.status;
              continue;
            }
          }
          return { job: existing, reused: true, preemptedJobIds: [] };
        }
      }
    }

    const preemptedJobIds: string[] = [];
    if (!params.externalWorker) {
      for (const existing of this.jobs.values()) {
        if (existing.status === 'running' && existing.userUid === userUid && !existing.externalWorker) {
          if (this.db) {
            const dbRow = this.db.getRenderJobById(existing.jobId);
            if (dbRow && dbRow.status !== 'running') {
              existing.status = dbRow.status;
              continue;
            }
          }
          this.markCancelled(
            existing,
            'Dibatalkan otomatis karena permintaan render baru dimulai.'
          );
          preemptedJobIds.push(existing.jobId);
        }
      }
    }

    const jobId = `rjob-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const job: ManagedRenderJob = {
      jobId,
      clipId: params.clipId,
      userUid,
      layout: params.layout ?? 'shorts_full_bleed',
      quality: params.quality ?? '1080p',
      dedupeKey: params.dedupeKey,
      status: 'running',
      stage: params.initialStage,
      progress: params.initialProgress ?? 8,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
      abortController: new AbortController(),
      externalWorker: Boolean(params.externalWorker),
    };
    this.jobs.set(jobId, job);
    this.persist(job);

    return { job, reused: false, preemptedJobIds };
  }

  updateProgress(jobId: string, stage: string, progress: number): void {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running') return;
    job.stage = stage;
    job.progress = progress;
    job.updatedAt = Date.now();
    this.persist(job);
  }

  complete(jobId: string, result: Record<string, unknown>): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running' || job.abortController.signal.aborted) {
      return false;
    }
    job.status = 'completed';
    job.stage = 'Render video MP4 selesai!';
    job.progress = 100;
    job.result = result;
    job.updatedAt = Date.now();
    this.persist(job);
    return true;
  }

  fail(jobId: string, errorMessage: string, code?: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (job.status === 'cancelled' || job.abortController.signal.aborted) {
      return;
    }
    job.status = 'failed';
    job.stage = 'Render gagal.';
    job.error = errorMessage;
    job.code = code;
    job.updatedAt = Date.now();
    this.persist(job);
  }

  cancel(
    jobId: string,
    reason = 'Proses render dibatalkan oleh pengguna.',
    requester?: { uid: string; isAdmin?: boolean }
  ): {
    found: boolean;
    forbidden?: boolean;
    wasRunning: boolean;
    job?: ManagedRenderJob;
  } {
    const job = this.jobs.get(jobId);
    if (!job) {
      return { found: false, wasRunning: false };
    }
    if (requester && !requester.isAdmin && job.userUid !== requester.uid) {
      return { found: true, forbidden: true, wasRunning: job.status === 'running' };
    }
    const wasRunning = job.status === 'running';
    if (wasRunning) {
      this.markCancelled(job, reason);
    }
    return { found: true, wasRunning, job };
  }

  cancelAllRunning(
    reason = 'Semua antrean render aktif dibatalkan oleh pengguna.',
    userUid?: string
  ): string[] {
    const cancelledIds: string[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === 'running' && (!userUid || job.userUid === userUid)) {
        this.markCancelled(job, reason);
        cancelledIds.push(job.jobId);
      }
    }
    return cancelledIds;
  }

  private markCancelled(job: ManagedRenderJob, reason: string): void {
    job.status = 'cancelled';
    job.stage = 'Render dibatalkan.';
    job.code = 'CANCELLED';
    job.error = reason;
    job.updatedAt = Date.now();
    if (!job.abortController.signal.aborted) {
      job.abortController.abort(new Error(reason));
    }
    this.persist(job);
  }
}
