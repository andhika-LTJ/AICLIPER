/**
 * AICLIPER Fase 0B — Google Cloud Run Jobs Dispatcher with Google ADC
 *
 * Authentication:
 *   - Uses Google Application Default Credentials (ADC) via `google-auth-library` (`GoogleAuth`).
 *   - Automatically retrieves short-lived tokens from the Cloud Run Metadata Server in production
 *     or local ADC (`gcloud auth application-default login` / `GOOGLE_APPLICATION_CREDENTIALS`).
 *   - Automatically refreshes expired tokens via GoogleAuth.
 *   - NEVER relies on static `GCP_ACCESS_TOKEN` in production.
 *
 * Production safety:
 *   - When `NODE_ENV === 'production'` (or `strictProduction: true`), missing config or failed ADC
 *     throws a typed `CloudRunJobsError` — NEVER silently falls back to local execution.
 */

import { GoogleAuth } from 'google-auth-library';
import { logStructuredEvent, redactSensitiveString } from './structuredLogger.ts';

export type CloudRunJobErrorCode =
  | 'CLOUD_RUN_NOT_CONFIGURED'
  | 'ADC_AUTH_FAILED'
  | 'PERMISSION_DENIED'
  | 'INVALID_CONFIG'
  | 'JOB_NOT_FOUND'
  | 'QUOTA_EXCEEDED'
  | 'API_UNAVAILABLE'
  | 'NETWORK_TIMEOUT'
  | 'DISPATCH_FAILED';

export class CloudRunJobsError extends Error {
  readonly code: CloudRunJobErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;

  constructor(
    code: CloudRunJobErrorCode,
    message: string,
    options: { httpStatus?: number; retryable?: boolean; cause?: unknown } = {}
  ) {
    super(redactSensitiveString(message), options.cause ? { cause: options.cause } : undefined);
    this.name = 'CloudRunJobsError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? 503;
    this.retryable = options.retryable ?? false;
  }
}

export interface CloudRunJobConfig {
  projectId: string;
  region: string;
  renderJobName: string;
  aiJobName: string;
  requestTimeoutMs: number;
}

export interface CloudRunJobDispatchInput {
  renderJobId: string;
  userUid: string;
  clipId: string;
  renderProfile: string;
  renderFingerprint: string;
  sourceFingerprint?: string;
  queueTaskName?: string;
  correlationId?: string;
}

export interface CloudRunJobDispatchResult {
  dispatched: boolean;
  backend: 'cloud_run_jobs' | 'local_worker_fallback';
  executionName: string;
  jobName: string;
  authMode: 'google_adc' | 'local_fallback';
  dispatchLatencyMs: number;
  message: string;
}

export interface AdcTokenProvider {
  getAccessToken(): Promise<string>;
  getProjectId?(): Promise<string | null | undefined>;
}

export interface CloudRunDispatchDependencies {
  authProvider?: AdcTokenProvider;
  fetchFn?: typeof fetch;
  strictProduction?: boolean;
  configOverride?: Partial<CloudRunJobConfig>;
}

export interface ServiceReadinessSnapshot {
  configured: boolean;
  authenticated: boolean;
  connected: boolean;
  operational: boolean;
  tested: boolean;
  mode: string;
  error?: string;
  details?: Record<string, unknown>;
}

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

let cachedGoogleAuth: GoogleAuth | null = null;

function getGoogleAuth(): GoogleAuth {
  if (!cachedGoogleAuth) {
    cachedGoogleAuth = new GoogleAuth({
      scopes: [CLOUD_PLATFORM_SCOPE],
    });
  }
  return cachedGoogleAuth;
}

export function resetCachedGoogleAuthForTests(): void {
  cachedGoogleAuth = null;
}

export function getCloudRunJobConfig(override?: Partial<CloudRunJobConfig>): CloudRunJobConfig {
  const timeoutRaw = Number(process.env.CLOUD_RUN_API_TIMEOUT_MS ?? 15_000);
  return {
    projectId: (override?.projectId ?? process.env.GCP_PROJECT_ID ?? '').trim(),
    region: (override?.region ?? process.env.GCP_REGION ?? 'asia-southeast2').trim(),
    renderJobName: (
      override?.renderJobName ??
      process.env.CLOUD_RUN_RENDER_JOB_NAME ??
      process.env.CLOUD_RUN_JOB_NAME ??
      ''
    ).trim(),
    aiJobName: (override?.aiJobName ?? process.env.CLOUD_RUN_AI_JOB_NAME ?? '').trim(),
    requestTimeoutMs:
      override?.requestTimeoutMs ??
      (Number.isFinite(timeoutRaw) && timeoutRaw >= 1000 ? Math.min(timeoutRaw, 60_000) : 15_000),
  };
}

export function isCloudRunJobsConfigured(override?: Partial<CloudRunJobConfig>): boolean {
  const cfg = getCloudRunJobConfig(override);
  return Boolean(cfg.projectId && cfg.renderJobName && cfg.region);
}

export function isProductionCloudRunStrict(strictOverride?: boolean): boolean {
  if (typeof strictOverride === 'boolean') return strictOverride;
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.CLOUD_RUN_JOBS_REQUIRED === 'true' ||
    process.env.CLOUD_RENDER_DISPATCH_ENABLED === 'true'
  );
}

export async function acquireAdcAccessToken(
  authProvider?: AdcTokenProvider
): Promise<{ token: string; authMode: 'google_adc' }> {
  try {
    if (authProvider) {
      const token = (await authProvider.getAccessToken())?.trim();
      if (!token) {
        throw new CloudRunJobsError(
          'ADC_AUTH_FAILED',
          'Google ADC gagal menghasilkan access token yang valid.',
          { httpStatus: 503, retryable: true }
        );
      }
      return { token, authMode: 'google_adc' };
    }

    const auth = getGoogleAuth();
    const client = await auth.getClient();
    const tokenRes = await client.getAccessToken();
    const token = typeof tokenRes === 'string' ? tokenRes : tokenRes?.token ?? '';
    if (!token || !token.trim()) {
      throw new CloudRunJobsError(
        'ADC_AUTH_FAILED',
        'Google Application Default Credentials (ADC) tidak mengembalikan access token. Pastikan Service Account Cloud Run atau ADC lokal telah terkonfigurasi.',
        { httpStatus: 503, retryable: true }
      );
    }
    return { token: token.trim(), authMode: 'google_adc' };
  } catch (err) {
    if (err instanceof CloudRunJobsError) throw err;
    const rawMsg = err instanceof Error ? err.message : String(err);
    throw new CloudRunJobsError(
      'ADC_AUTH_FAILED',
      `Gagal mengautentikasi dengan Google ADC: ${redactSensitiveString(rawMsg)}`,
      { httpStatus: 503, retryable: true, cause: err }
    );
  }
}

export function classifyCloudRunHttpFailure(
  status: number,
  bodyText: string,
  jobName: string
): CloudRunJobsError {
  const cleanSnippet = redactSensitiveString(bodyText).slice(0, 260);
  if (status === 401) {
    return new CloudRunJobsError(
      'ADC_AUTH_FAILED',
      `Google Cloud Run Jobs menolak kredensial ADC (HTTP 401): ${cleanSnippet}`,
      { httpStatus: 503, retryable: true }
    );
  }
  if (status === 403) {
    return new CloudRunJobsError(
      'PERMISSION_DENIED',
      `Service account tidak memiliki izin roles/run.invoker atau roles/run.developer pada Cloud Run Job "${jobName}" (HTTP 403): ${cleanSnippet}`,
      { httpStatus: 503, retryable: false }
    );
  }
  if (status === 404) {
    return new CloudRunJobsError(
      'JOB_NOT_FOUND',
      `Cloud Run Job "${jobName}" tidak ditemukan di project/region yang dikonfigurasi (HTTP 404): ${cleanSnippet}`,
      { httpStatus: 503, retryable: false }
    );
  }
  if (status === 400) {
    return new CloudRunJobsError(
      'INVALID_CONFIG',
      `Konfigurasi parameter Cloud Run Job tidak valid (HTTP 400): ${cleanSnippet}`,
      { httpStatus: 500, retryable: false }
    );
  }
  if (status === 429) {
    return new CloudRunJobsError(
      'QUOTA_EXCEEDED',
      `Kuota atau rate limit Cloud Run Jobs API tercapai (HTTP 429): ${cleanSnippet}`,
      { httpStatus: 503, retryable: true }
    );
  }
  if (status >= 500) {
    return new CloudRunJobsError(
      'API_UNAVAILABLE',
      `Cloud Run Jobs API sedang tidak tersedia (HTTP ${status}): ${cleanSnippet}`,
      { httpStatus: 503, retryable: true }
    );
  }
  return new CloudRunJobsError(
    'DISPATCH_FAILED',
    `Cloud Run Jobs API gagal memicu eksekusi (HTTP ${status}): ${cleanSnippet}`,
    { httpStatus: 503, retryable: status >= 500 }
  );
}

/**
 * Triggers a Cloud Run Job execution via Cloud Run Admin API v2 using Google ADC.
 * Automatically refreshes tokens via `google-auth-library` (and retries once on HTTP 401).
 */
export async function dispatchCloudRunRenderJob(
  input: CloudRunJobDispatchInput,
  deps: CloudRunDispatchDependencies = {}
): Promise<CloudRunJobDispatchResult> {
  const startedAt = Date.now();
  const cfg = getCloudRunJobConfig(deps.configOverride);
  const strict = isProductionCloudRunStrict(deps.strictProduction);

  if (!cfg.projectId || !cfg.renderJobName || !cfg.region) {
    if (strict) {
      throw new CloudRunJobsError(
        'CLOUD_RUN_NOT_CONFIGURED',
        'Cloud Run Jobs belum dikonfigurasi (wajib set GCP_PROJECT_ID, GCP_REGION, dan CLOUD_RUN_RENDER_JOB_NAME di production).',
        { httpStatus: 503, retryable: false }
      );
    }
    return {
      dispatched: false,
      backend: 'local_worker_fallback',
      executionName: `local-exec-${input.renderJobId}`,
      jobName: cfg.renderJobName || 'local-render-worker',
      authMode: 'local_fallback',
      dispatchLatencyMs: Date.now() - startedAt,
      message:
        'Cloud Run Jobs belum dikonfigurasi (mode development); memakai fallback worker lokal.',
    };
  }

  const endpoint = `https://run.googleapis.com/v2/projects/${encodeURIComponent(cfg.projectId)}/locations/${encodeURIComponent(cfg.region)}/jobs/${encodeURIComponent(cfg.renderJobName)}:run`;
  const fetchImpl = deps.fetchFn ?? fetch;
  const envPayload = [
    { name: 'AICLIPER_RENDER_JOB_ID', value: input.renderJobId },
    { name: 'AICLIPER_USER_UID', value: input.userUid },
    { name: 'AICLIPER_CLIP_ID', value: input.clipId },
    { name: 'AICLIPER_RENDER_PROFILE', value: input.renderProfile },
    { name: 'AICLIPER_RENDER_FINGERPRINT', value: input.renderFingerprint },
    ...(input.sourceFingerprint
      ? [{ name: 'AICLIPER_SOURCE_FINGERPRINT', value: input.sourceFingerprint }]
      : []),
    ...(input.queueTaskName
      ? [{ name: 'AICLIPER_QUEUE_TASK_NAME', value: input.queueTaskName }]
      : []),
    ...(input.correlationId
      ? [{ name: 'AICLIPER_CORRELATION_ID', value: input.correlationId }]
      : []),
  ];

  const executeOnce = async (attempt: number): Promise<CloudRunJobDispatchResult> => {
    const { token } = await acquireAdcAccessToken(deps.authProvider);
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), cfg.requestTimeoutMs);

    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: abortController.signal,
        body: JSON.stringify({
          overrides: {
            containerOverrides: [{ env: envPayload }],
            taskCount: 1,
          },
        }),
      });

      if (response.status === 401 && attempt === 1) {
        // Retry once to exercise fresh token acquisition on transient expiry
        return executeOnce(2);
      }

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw classifyCloudRunHttpFailure(response.status, errBody, cfg.renderJobName);
      }

      const data = (await response.json().catch(() => ({}))) as {
        name?: string;
        metadata?: { name?: string };
      };
      const executionName =
        data.metadata?.name || data.name || `${cfg.renderJobName}-exec-${Date.now()}`;
      const dispatchLatencyMs = Date.now() - startedAt;

      logStructuredEvent({
        service: 'cloud-run-jobs-dispatcher',
        event: 'cloud_run_job_dispatched',
        severity: 'INFO',
        correlationId: input.correlationId,
        renderJobId: input.renderJobId,
        userUid: input.userUid,
        clipId: input.clipId,
        executionName,
        renderProfile: input.renderProfile,
        renderFingerprint: input.renderFingerprint,
        sourceFingerprint: input.sourceFingerprint,
        queueTaskName: input.queueTaskName,
        stage: 'dispatching',
        durationMs: dispatchLatencyMs,
      });

      return {
        dispatched: true,
        backend: 'cloud_run_jobs',
        executionName,
        jobName: cfg.renderJobName,
        authMode: 'google_adc',
        dispatchLatencyMs,
        message: `Cloud Run Job "${cfg.renderJobName}" berhasil dipicu via Google ADC.`,
      };
    } catch (err) {
      if (err instanceof CloudRunJobsError) throw err;
      const isAbort =
        err instanceof Error &&
        (err.name === 'AbortError' || /aborted|timeout/i.test(err.message));
      if (isAbort) {
        throw new CloudRunJobsError(
          'NETWORK_TIMEOUT',
          `Permintaan Cloud Run Jobs API melewati batas waktu (${cfg.requestTimeoutMs}ms).`,
          { httpStatus: 504, retryable: true, cause: err }
        );
      }
      const rawMsg = err instanceof Error ? err.message : String(err);
      throw new CloudRunJobsError(
        'API_UNAVAILABLE',
        `Gagal menghubungi Cloud Run Jobs API: ${redactSensitiveString(rawMsg)}`,
        { httpStatus: 503, retryable: true, cause: err }
      );
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await executeOnce(1);
  } catch (err) {
    const cloudErr =
      err instanceof CloudRunJobsError
        ? err
        : new CloudRunJobsError('DISPATCH_FAILED', String(err), { retryable: false, cause: err });
    logStructuredEvent({
      service: 'cloud-run-jobs-dispatcher',
      event: 'cloud_run_job_dispatch_failed',
      severity: 'ERROR',
      renderJobId: input.renderJobId,
      userUid: input.userUid,
      clipId: input.clipId,
      renderProfile: input.renderProfile,
      renderFingerprint: input.renderFingerprint,
      queueTaskName: input.queueTaskName,
      stage: 'dispatching',
      durationMs: Date.now() - startedAt,
      errorCode: cloudErr.code,
      errorMessage: cloudErr.message,
    });
    throw cloudErr;
  }
}

/**
 * Checks real Google ADC readiness without using static env access tokens.
 */
export async function checkAdcReadiness(
  authProvider?: AdcTokenProvider
): Promise<ServiceReadinessSnapshot> {
  const projectId = (process.env.GCP_PROJECT_ID ?? '').trim();
  const hasExplicitCredFile = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim());
  const isCloudRunEnv = Boolean(process.env.K_SERVICE || process.env.CLOUD_RUN_JOB);
  const configured = Boolean(projectId || hasExplicitCredFile || isCloudRunEnv || authProvider);

  try {
    await acquireAdcAccessToken(authProvider);
    return {
      configured,
      authenticated: true,
      connected: true,
      operational: true,
      tested: true,
      mode: isCloudRunEnv
        ? 'cloud_run_metadata_adc'
        : hasExplicitCredFile
          ? 'service_account_key_adc'
          : 'google_adc',
      details: {
        projectId: projectId || null,
        staticTokenForbidden: true,
      },
    };
  } catch (err) {
    return {
      configured,
      authenticated: false,
      connected: false,
      operational: false,
      tested: false,
      mode: 'adc_unavailable',
      error: err instanceof Error ? redactSensitiveString(err.message) : 'ADC unavailable',
      details: {
        projectId: projectId || null,
        staticTokenForbidden: true,
      },
    };
  }
}

/**
 * Checks honest 5-level readiness for Google Cloud Run Jobs (configured, authenticated,
 * connected via GET job metadata, operational, tested).
 */
export async function checkCloudRunJobsReadiness(
  deps: CloudRunDispatchDependencies = {}
): Promise<ServiceReadinessSnapshot> {
  const cfg = getCloudRunJobConfig(deps.configOverride);
  const configured = Boolean(cfg.projectId && cfg.region && cfg.renderJobName);

  if (!configured) {
    return {
      configured: false,
      authenticated: false,
      connected: false,
      operational: false,
      tested: false,
      mode: 'local_worker_fallback',
      error: 'GCP_PROJECT_ID atau CLOUD_RUN_RENDER_JOB_NAME belum dikonfigurasi.',
      details: {
        projectId: cfg.projectId || null,
        region: cfg.region,
        renderJobName: cfg.renderJobName || null,
      },
    };
  }

  let token: string;
  try {
    const acquired = await acquireAdcAccessToken(deps.authProvider);
    token = acquired.token;
  } catch (err) {
    return {
      configured: true,
      authenticated: false,
      connected: false,
      operational: false,
      tested: false,
      mode: 'cloud_run_jobs_auth_failed',
      error: err instanceof Error ? redactSensitiveString(err.message) : 'ADC authentication failed',
      details: {
        projectId: cfg.projectId,
        region: cfg.region,
        renderJobName: cfg.renderJobName,
      },
    };
  }

  const fetchImpl = deps.fetchFn ?? fetch;
  const jobUrl = `https://run.googleapis.com/v2/projects/${encodeURIComponent(cfg.projectId)}/locations/${encodeURIComponent(cfg.region)}/jobs/${encodeURIComponent(cfg.renderJobName)}`;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), Math.min(cfg.requestTimeoutMs, 6000));
  try {
    const res = await fetchImpl(jobUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: abortController.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const classified = classifyCloudRunHttpFailure(res.status, body, cfg.renderJobName);
      return {
        configured: true,
        authenticated: res.status !== 401,
        connected: false,
        operational: false,
        tested: false,
        mode: 'cloud_run_jobs_unreachable',
        error: classified.message,
        details: {
          projectId: cfg.projectId,
          region: cfg.region,
          renderJobName: cfg.renderJobName,
          errorCode: classified.code,
        },
      };
    }
    return {
      configured: true,
      authenticated: true,
      connected: true,
      operational: true,
      tested: true,
      mode: 'cloud_run_jobs',
      details: {
        projectId: cfg.projectId,
        region: cfg.region,
        renderJobName: cfg.renderJobName,
      },
    };
  } catch (err) {
    return {
      configured: true,
      authenticated: true,
      connected: false,
      operational: false,
      tested: false,
      mode: 'cloud_run_jobs_network_error',
      error: err instanceof Error ? redactSensitiveString(err.message) : 'Network failure',
      details: {
        projectId: cfg.projectId,
        region: cfg.region,
        renderJobName: cfg.renderJobName,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
