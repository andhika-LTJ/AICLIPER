export type RenderJobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface ManagedRenderJob {
  jobId: string;
  clipId: string;
  dedupeKey: string;
  status: RenderJobStatus;
  stage: string;
  progress: number;
  createdAt: number;
  updatedAt: number;
  abortController: AbortController;
  result?: Record<string, unknown>;
  error?: string;
  code?: string;
}

export interface CreateOrReuseRenderJobResult {
  job: ManagedRenderJob;
  reused: boolean;
  preemptedJobIds: string[];
}

export class RenderJobManager {
  private readonly jobs = new Map<string, ManagedRenderJob>();
  private readonly retentionMs: number;

  constructor(retentionMs = 60 * 60 * 1000) {
    this.retentionMs = retentionMs;
  }

  get(jobId: string): ManagedRenderJob | undefined {
    return this.jobs.get(jobId);
  }

  listActive(): ManagedRenderJob[] {
    const active: ManagedRenderJob[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === 'running') {
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
   * Starts a new render job with single-slot concurrency safety:
   * - If an identical job (same dedupeKey) is already running and `forceRestart` is false, reuses it.
   * - Otherwise automatically cancels & aborts any other running render jobs so heavy FFmpeg processes
   *   never pile up, saturate container CPU, or cause proxy HTTP 429 rejections.
   */
  createOrReuse(params: {
    clipId: string;
    dedupeKey: string;
    initialStage: string;
    initialProgress?: number;
    forceRestart?: boolean;
  }): CreateOrReuseRenderJobResult {
    const now = Date.now();
    this.pruneOld(now);

    if (!params.forceRestart) {
      for (const existing of this.jobs.values()) {
        if (existing.status === 'running' && existing.dedupeKey === params.dedupeKey) {
          return { job: existing, reused: true, preemptedJobIds: [] };
        }
      }
    }

    const preemptedJobIds: string[] = [];
    for (const existing of this.jobs.values()) {
      if (existing.status === 'running') {
        this.markCancelled(
          existing,
          'Dibatalkan otomatis karena permintaan render baru dimulai.'
        );
        preemptedJobIds.push(existing.jobId);
      }
    }

    const jobId = `rjob-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const job: ManagedRenderJob = {
      jobId,
      clipId: params.clipId,
      dedupeKey: params.dedupeKey,
      status: 'running',
      stage: params.initialStage,
      progress: params.initialProgress ?? 8,
      createdAt: now,
      updatedAt: now,
      abortController: new AbortController(),
    };
    this.jobs.set(jobId, job);

    return { job, reused: false, preemptedJobIds };
  }

  updateProgress(jobId: string, stage: string, progress: number): void {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running') return;
    job.stage = stage;
    job.progress = progress;
    job.updatedAt = Date.now();
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
  }

  cancel(jobId: string, reason = 'Proses render dibatalkan oleh pengguna.'): {
    found: boolean;
    wasRunning: boolean;
    job?: ManagedRenderJob;
  } {
    const job = this.jobs.get(jobId);
    if (!job) {
      return { found: false, wasRunning: false };
    }
    const wasRunning = job.status === 'running';
    if (wasRunning) {
      this.markCancelled(job, reason);
    }
    return { found: true, wasRunning, job };
  }

  cancelAllRunning(reason = 'Semua antrean render aktif dibatalkan oleh pengguna.'): string[] {
    const cancelledIds: string[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === 'running') {
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
  }
}
