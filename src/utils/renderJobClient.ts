import type {
  ClipOverlayStyle,
  ClipRenderLayout,
  ClipRenderQuality,
  StudioStoreState,
} from '../types/clipper';
import { apiFetch } from './apiClient';

export interface RenderJobCompletedPayload {
  videoUrl: string;
  sizeBytes: number;
  width: number;
  height: number;
  sourceWidth?: number;
  sourceHeight?: number;
  layout: ClipRenderLayout;
  quality: ClipRenderQuality;
  isUltraHd?: boolean;
  store?: StudioStoreState;
}

export interface RenderJobError extends Error {
  code?: string;
}

interface RenderJobPollResponse {
  jobId?: string;
  streamToken?: string;
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  stage?: string;
  progress?: number;
  result?: RenderJobCompletedPayload;
  error?: string;
  code?: string;
  videoUrl?: string;
  store?: StudioStoreState;
}

/**
 * Determines whether an HTTP status returned while starting or monitoring a render job
 * is transient/recoverable (e.g. Cloud Run proxy rate-limiting 429 or 5xx gateway blips).
 */
export function isTransientRenderHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * Computes a polite backoff delay (ms) for transient 429/5xx responses, respecting Retry-After
 * headers while keeping normal fallback polling gentle enough never to trigger proxy rate limits.
 */
export function computeRenderBackoffMs(params: {
  status: number;
  attempt: number;
  retryAfterHeader?: string | null;
}): number {
  const { status, attempt, retryAfterHeader } = params;
  if (retryAfterHeader) {
    const parsedSec = Number.parseInt(retryAfterHeader.trim(), 10);
    if (Number.isFinite(parsedSec) && parsedSec > 0) {
      return Math.min(20_000, Math.max(2_500, parsedSec * 1000));
    }
  }
  if (status === 429) {
    return Math.min(16_000, 4_500 + attempt * 2_500);
  }
  return Math.min(12_000, 3_000 + attempt * 2_000);
}

async function parseJsonSafely(res: Response): Promise<RenderJobPollResponse | null> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as RenderJobPollResponse;
  } catch {
    return null;
  }
}

function makeRenderError(message: string, code?: string): RenderJobError {
  const err = new Error(message) as RenderJobError;
  if (code) err.code = code;
  return err;
}

/**
 * Explicitly cancels a specific render job (or all active server render jobs when jobId is omitted)
 * so FFmpeg / yt-dlp child processes stop immediately and free container CPU/RAM.
 */
export async function cancelActiveServerRenders(jobId?: string | null): Promise<void> {
  const endpoint = jobId
    ? `/api/render-jobs/${encodeURIComponent(jobId)}/cancel`
    : '/api/render-jobs/cancel-active';
  try {
    await apiFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
    });
  } catch {
    // Ignore transient network errors during best-effort cancel
  }
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = globalThis.setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        globalThis.clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

type SseStreamOutcome =
  | { kind: 'completed'; payload: RenderJobCompletedPayload }
  | { kind: 'failed'; message: string; code?: string }
  | { kind: 'cancelled' }
  | { kind: 'missing' }
  | { kind: 'fallback' };

function listenViaEventSource(params: {
  jobId: string;
  streamToken?: string;
  signal?: AbortSignal;
  onUpdate: (stage?: string, progress?: number) => void;
}): Promise<SseStreamOutcome> {
  const { jobId, streamToken, signal, onUpdate } = params;
  if (typeof EventSource === 'undefined' || !streamToken) {
    return Promise.resolve({ kind: 'fallback' });
  }

  return new Promise<SseStreamOutcome>((resolve) => {
    if (signal?.aborted) {
      resolve({ kind: 'cancelled' });
      return;
    }

    let settled = false;
    const es = new EventSource(
      `/api/render-jobs/${encodeURIComponent(jobId)}/events?st=${encodeURIComponent(streamToken)}`
    );

    const finish = (outcome: SseStreamOutcome) => {
      if (settled) return;
      settled = true;
      es.close();
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    const onAbort = () => finish({ kind: 'cancelled' });
    signal?.addEventListener('abort', onAbort, { once: true });

    es.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data) as RenderJobPollResponse;
        onUpdate(data.stage, data.progress);
        if (data.status === 'completed' && data.result) {
          finish({ kind: 'completed', payload: data.result });
        } else if (data.status === 'cancelled') {
          finish({ kind: 'cancelled' });
        } else if (data.status === 'failed') {
          finish({
            kind: 'failed',
            message: data.error || 'Gagal merender video klip MP4.',
            code: data.code,
          });
        }
      } catch {
        // Ignore malformed SSE frame
      }
    };

    es.addEventListener('recycle', () => {
      // Server cleanly closed stream before proxy timeout; caller will reconnect smoothly
      finish({ kind: 'fallback' });
    });

    es.addEventListener('missing', () => {
      finish({ kind: 'missing' });
    });

    es.onerror = () => {
      finish({ kind: 'fallback' });
    };
  });
}

async function tryRecoverCompletedClipFromState(
  clipId: string,
  previousRenderedUrl?: string
): Promise<RenderJobCompletedPayload | null> {
  try {
    const res = await apiFetch('/api/state', { cache: 'no-store' });
    if (!res.ok) return null;
    const store = (await res.json()) as StudioStoreState;
    const clip = store.clips.find((c) => c.id === clipId);
    if (clip?.renderedClipUrl && clip.renderedClipUrl !== previousRenderedUrl) {
      return {
        videoUrl: clip.renderedClipUrl,
        sizeBytes: 0,
        width: clip.renderedQuality === '4k' ? 2160 : 1080,
        height: clip.renderedQuality === '4k' ? 3840 : 1920,
        layout: clip.renderedLayout ?? 'shorts_full_bleed',
        quality: clip.renderedQuality ?? '1080p',
        isUltraHd: clip.renderedQuality === '4k',
        store,
      };
    }
  } catch {
    // Ignore recovery lookup errors
  }
  return null;
}

/**
 * Starts an asynchronous server-side 1080p/4K render job and streams live progress via SSE
 * (with automatic 429-safe gentle polling fallback), ZERO artificial max-duration timeout,
 * smooth 1s elapsed timer updates, and optional user cancellation.
 */
export async function runRenderClipJob(params: {
  clipId: string;
  layout: ClipRenderLayout;
  quality: ClipRenderQuality;
  enableEmotionEffects?: boolean;
  enableAiIntro?: boolean;
  overlayStyle?: Partial<ClipOverlayStyle>;
  forceRestart?: boolean;
  signal?: AbortSignal;
  onJobStarted?: (jobId: string) => void;
  onProgress?: (stage: string, progress: number, elapsedSec: number) => void;
}): Promise<RenderJobCompletedPayload> {
  const {
    clipId,
    layout,
    quality,
    enableEmotionEffects,
    enableAiIntro,
    overlayStyle,
    forceRestart,
    signal,
    onJobStarted,
    onProgress,
  } = params;
  const startedAt = Date.now();
  const elapsed = () => Math.max(0, Math.floor((Date.now() - startedAt) / 1000));

  let latestStage = 'Mengirim antrean render ke server...';
  let latestProgress = 5;
  let activeJobId: string | null = null;
  let serverCancelSent = false;
  onProgress?.(latestStage, latestProgress, 0);

  const dispatchServerCancelOnce = () => {
    if (serverCancelSent) return;
    serverCancelSent = true;
    void cancelActiveServerRenders(activeJobId);
  };

  if (signal?.aborted) {
    dispatchServerCancelOnce();
    throw makeRenderError('Proses render dibatalkan oleh pengguna.', 'CANCELLED');
  }
  signal?.addEventListener('abort', dispatchServerCancelOnce, { once: true });

  // Keep elapsed clock ticking smoothly every second without extra HTTP requests
  const clockInterval = globalThis.setInterval(() => {
    if (!signal?.aborted) {
      onProgress?.(latestStage, latestProgress, elapsed());
    }
  }, 1000);

  try {
    // Step 1: Enqueue render job with automatic 429/5xx retry
    let startRes: Response | null = null;
    let startData: RenderJobPollResponse | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (signal?.aborted) {
        dispatchServerCancelOnce();
        throw makeRenderError('Proses render dibatalkan oleh pengguna.', 'CANCELLED');
      }
      try {
        startRes = await apiFetch('/api/render', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clipId,
            layout,
            quality,
            ...(typeof enableEmotionEffects === 'boolean' ? { enableEmotionEffects } : {}),
            ...(typeof enableAiIntro === 'boolean' ? { enableAiIntro } : {}),
            ...(overlayStyle ? { overlayStyle } : {}),
            ...(forceRestart ? { forceRestart: true } : {}),
          }),
          signal,
        });
        startData = await parseJsonSafely(startRes);
        if (startRes.ok) break;
        if (isTransientRenderHttpStatus(startRes.status) && attempt < 4) {
          const waitMs = computeRenderBackoffMs({
            status: startRes.status,
            attempt,
            retryAfterHeader: startRes.headers.get('Retry-After'),
          });
          latestStage = 'Server sedang sibuk, mengantrekan render ulang secara otomatis...';
          onProgress?.(latestStage, latestProgress, elapsed());
          await sleepWithAbort(waitMs, signal);
          continue;
        }
        if (startRes.status === 429) {
          throw makeRenderError(
            'Server render sedang penuh atau terkena batas sementara (HTTP 429). Klik "Kosongkan Antrean & Coba Lagi" untuk membebaskan proses lama.',
            'RATE_LIMITED'
          );
        }
        throw makeRenderError(
          startData?.error || `Server render menolak permintaan (HTTP ${startRes.status}).`,
          startData?.code
        );
      } catch (err) {
        if (signal?.aborted) {
          dispatchServerCancelOnce();
          throw makeRenderError('Proses render dibatalkan oleh pengguna.', 'CANCELLED');
        }
        if (err instanceof Error && (err as RenderJobError).code) {
          throw err;
        }
        if (attempt >= 4) {
          throw makeRenderError(
            err instanceof Error && err.message
              ? err.message
              : 'Gagal menghubungi server render. Periksa koneksi Anda.'
          );
        }
        await sleepWithAbort(2500 + attempt * 1500, signal);
      }
    }

    if (!startRes || !startRes.ok) {
      throw makeRenderError(startData?.error || 'Gagal memulai antrean render.');
    }

    if (startData?.videoUrl && startData.store) {
      onProgress?.('Render selesai!', 100, elapsed());
      return startData as unknown as RenderJobCompletedPayload;
    }

    const jobId = startData?.jobId;
    const streamToken = startData?.streamToken;
    if (!jobId) {
      throw makeRenderError('Server tidak mengembalikan ID antrean render.');
    }
    activeJobId = jobId;
    onJobStarted?.(jobId);

    // If user clicked Cancel right as POST /api/render resolved, make sure this new jobId is cancelled immediately
    if (signal?.aborted) {
      void cancelActiveServerRenders(jobId);
      throw makeRenderError('Proses render dibatalkan oleh pengguna.', 'CANCELLED');
    }

    latestStage = startData?.stage || 'Memproses video HD/4K...';
    latestProgress = startData?.progress ?? 8;
    onProgress?.(latestStage, latestProgress, elapsed());

    // Step 2: Primary live monitoring via Server-Sent Events (1 persistent connection = zero 429!)
    // Falls back seamlessly to polite backoff polling whenever a proxy closes/blocks SSE.
    let consecutiveSseFastFailures = 0;
    let transientErrors = 0;

    while (true) {
      if (signal?.aborted) {
        throw makeRenderError('Proses render dibatalkan oleh pengguna.', 'CANCELLED');
      }

      if (consecutiveSseFastFailures < 3 && streamToken) {
        const sseOpenedAt = Date.now();
        const outcome = await listenViaEventSource({
          jobId,
          streamToken,
          signal,
          onUpdate: (stage, progress) => {
            if (stage) latestStage = stage;
            if (typeof progress === 'number') latestProgress = progress;
            onProgress?.(latestStage, latestProgress, elapsed());
          },
        });

        if (outcome.kind === 'completed') {
          onProgress?.('Render video MP4 selesai!', 100, elapsed());
          return outcome.payload;
        }
        if (outcome.kind === 'failed') {
          throw makeRenderError(outcome.message, outcome.code);
        }
        if (outcome.kind === 'cancelled') {
          throw makeRenderError('Proses render dibatalkan oleh pengguna.', 'CANCELLED');
        }
        if (outcome.kind === 'missing') {
          const recovered = await tryRecoverCompletedClipFromState(clipId);
          if (recovered) {
            onProgress?.('Render video MP4 selesai!', 100, elapsed());
            return recovered;
          }
          throw makeRenderError(
            'Sesi antrean render berakhir karena server baru dimulai ulang. Klik tombol render kembali.'
          );
        }

        const sseAliveMs = Date.now() - sseOpenedAt;
        if (sseAliveMs > 12_000) {
          // Stream worked cleanly and just recycled before proxy timeout — pause briefly then re-attach SSE!
          consecutiveSseFastFailures = 0;
          await sleepWithAbort(1500, signal);
          continue;
        }
        consecutiveSseFastFailures += 1;
      }

      // Gentle single status check (3.5s base interval, exponential backoff on 429/5xx)
      await sleepWithAbort(3500, signal);
      if (signal?.aborted) {
        throw makeRenderError('Proses render dibatalkan oleh pengguna.', 'CANCELLED');
      }

      let pollRes: Response;
      try {
        pollRes = await apiFetch(`/api/render-jobs/${encodeURIComponent(jobId)}`, {
          cache: 'no-store',
          signal,
        });
      } catch (err) {
        if (signal?.aborted) {
          throw makeRenderError('Proses render dibatalkan oleh pengguna.', 'CANCELLED');
        }
        transientErrors += 1;
        if (transientErrors >= 25) {
          throw makeRenderError(
            err instanceof Error && err.message
              ? `Koneksi terputus berkepanjangan: ${err.message}`
              : 'Koneksi ke server terputus berkepanjangan saat memantau render.'
          );
        }
        await sleepWithAbort(Math.min(12_000, 3000 + transientErrors * 1500), signal);
        continue;
      }

      if (!pollRes.ok) {
        if (isTransientRenderHttpStatus(pollRes.status)) {
          transientErrors += 1;
          const waitMs = computeRenderBackoffMs({
            status: pollRes.status,
            attempt: transientErrors,
            retryAfterHeader: pollRes.headers.get('Retry-After'),
          });
          await sleepWithAbort(waitMs, signal);
          continue;
        }
        if (pollRes.status === 404) {
          const recovered = await tryRecoverCompletedClipFromState(clipId);
          if (recovered) {
            onProgress?.('Render video MP4 selesai!', 100, elapsed());
            return recovered;
          }
          throw makeRenderError(
            'Sesi antrean render berakhir karena server baru dimulai ulang. Klik tombol render kembali.'
          );
        }
        const pollErr = await parseJsonSafely(pollRes);
        throw makeRenderError(
          pollErr?.error || `Gagal memantau status render (HTTP ${pollRes.status}).`,
          pollErr?.code
        );
      }

      transientErrors = 0;
      const pollData = await parseJsonSafely(pollRes);
      if (!pollData) continue;

      if (pollData.stage) latestStage = pollData.stage;
      if (typeof pollData.progress === 'number') latestProgress = pollData.progress;
      onProgress?.(latestStage, latestProgress, elapsed());

      if (pollData.status === 'completed' && pollData.result) {
        onProgress?.('Render video MP4 selesai!', 100, elapsed());
        return pollData.result;
      }
      if (pollData.status === 'cancelled') {
        throw makeRenderError(pollData.error || 'Proses render dibatalkan oleh pengguna.', 'CANCELLED');
      }
      if (pollData.status === 'failed') {
        throw makeRenderError(pollData.error || 'Gagal merender video klip MP4.', pollData.code);
      }
    }
  } finally {
    signal?.removeEventListener('abort', dispatchServerCancelOnce);
    globalThis.clearInterval(clockInterval);
  }
}
