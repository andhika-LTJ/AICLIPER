/**
 * AICLIPER Fase 0B — Google Cloud Tasks Queue Service (OIDC-Enforced)
 *
 * Manages three dedicated queues:
 *   1. ai-analysis-queue    -> AI transcript, clip discovery & active speaker worker
 *   2. video-render-queue   -> Authenticated Internal Render Dispatcher (/api/internal/dispatch/render)
 *   3. publish-queue        -> YouTube / Multi-Platform publishing worker
 *
 * Production security:
 *   - Uses Google ADC via `CloudTasksClient` automatically.
 *   - Every dispatched task MUST carry an OIDC token (`serviceAccountEmail` + `audience`).
 *   - In `NODE_ENV === 'production'` (or `strictProduction: true`), missing Cloud Tasks
 *     or OIDC configuration throws a typed `CloudTasksError` — NEVER silently falls back.
 */

import crypto from 'node:crypto';
import { CloudTasksClient } from '@google-cloud/tasks';
import {
  logStructuredEvent,
  redactSensitiveString,
  sanitizeCorrelationId,
} from './structuredLogger.ts';

export type QueueNameKey = 'media_ingestion' | 'ai_analysis' | 'video_render' | 'publish';

export type CloudTasksErrorCode =
  | 'CLOUD_TASKS_NOT_CONFIGURED'
  | 'OIDC_CONFIG_MISSING'
  | 'PERMISSION_DENIED'
  | 'QUEUE_NOT_FOUND'
  | 'CLOUD_TASKS_UNAVAILABLE'
  | 'ENQUEUE_FAILED';

export class CloudTasksError extends Error {
  readonly code: CloudTasksErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;

  constructor(
    code: CloudTasksErrorCode,
    message: string,
    options: { httpStatus?: number; retryable?: boolean; cause?: unknown } = {}
  ) {
    super(redactSensitiveString(message), options.cause ? { cause: options.cause } : undefined);
    this.name = 'CloudTasksError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? 503;
    this.retryable = options.retryable ?? false;
  }
}

export interface CloudTasksConfig {
  projectId: string;
  location: string;
  workerBaseUrl: string;
  oidcServiceAccountEmail: string;
  oidcAudience: string;
  queues: Record<QueueNameKey, string>;
  strictProduction: boolean;
}

export interface EnqueueTaskInput {
  queue: QueueNameKey;
  targetPath: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  correlationId?: string;
  scheduleDelaySec?: number;
  dispatchDeadlineSec?: number;
}

export interface EnqueueTaskResult {
  enqueued: boolean;
  backend: 'cloud_tasks' | 'local_fallback';
  taskName: string;
  deduplicated: boolean;
  queueName: string;
  targetUrl: string;
  oidcAudience?: string;
  queueLatencyMs: number;
}

export interface CloudTasksClientAdapter {
  queuePath(project: string, location: string, queue: string): string;
  taskPath(project: string, location: string, queue: string, task: string): string;
  createTask(request: {
    parent: string;
    task: Record<string, unknown>;
  }): Promise<[{ name?: string | null }]>;
  getQueue?(request: { name: string }): Promise<[Record<string, unknown>]>;
}

export interface CloudTasksReadinessSnapshot {
  configured: boolean;
  authenticated: boolean;
  connected: boolean;
  operational: boolean;
  tested: boolean;
  oidcConfigured: boolean;
  projectId: string | null;
  location: string;
  queues: Record<QueueNameKey, string>;
  mode: 'cloud_tasks' | 'local_fallback' | 'cloud_tasks_misconfigured' | 'cloud_tasks_unreachable';
  error?: string;
}

let cachedClient: CloudTasksClient | null = null;

export function isProductionCloudTasksStrict(strictOverride?: boolean): boolean {
  if (typeof strictOverride === 'boolean') return strictOverride;
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.CLOUD_TASKS_REQUIRED === 'true' ||
    process.env.CLOUD_RENDER_DISPATCH_ENABLED === 'true'
  );
}

export function getCloudTasksConfig(override?: Partial<CloudTasksConfig>): CloudTasksConfig {
  const workerBaseUrl = (override?.workerBaseUrl ?? process.env.WORKER_DISPATCH_BASE_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  const explicitAudience = (override?.oidcAudience ?? process.env.CLOUD_TASKS_OIDC_AUDIENCE ?? '')
    .trim()
    .replace(/\/+$/, '');

  return {
    projectId: (override?.projectId ?? process.env.GCP_PROJECT_ID ?? '').trim(),
    location: (override?.location ?? process.env.CLOUD_TASKS_LOCATION ?? process.env.GCP_REGION ?? 'asia-southeast2').trim(),
    workerBaseUrl,
    oidcServiceAccountEmail: (
      override?.oidcServiceAccountEmail ??
      process.env.CLOUD_TASKS_OIDC_SA_EMAIL ??
      ''
    ).trim(),
    oidcAudience: explicitAudience || workerBaseUrl,
    queues: {
      media_ingestion: (
        override?.queues?.media_ingestion ??
        process.env.CLOUD_TASKS_MEDIA_QUEUE ??
        'media-ingestion'
      ).trim(),
      ai_analysis: (
        override?.queues?.ai_analysis ??
        process.env.CLOUD_TASKS_AI_QUEUE ??
        'ai-analysis-queue'
      ).trim(),
      video_render: (
        override?.queues?.video_render ??
        process.env.CLOUD_TASKS_RENDER_QUEUE ??
        'video-render-queue'
      ).trim(),
      publish: (
        override?.queues?.publish ??
        process.env.CLOUD_TASKS_PUBLISH_QUEUE ??
        'publish-queue'
      ).trim(),
    },
    strictProduction: isProductionCloudTasksStrict(override?.strictProduction),
  };
}

export function isCloudTasksConfigured(override?: Partial<CloudTasksConfig>): boolean {
  const cfg = getCloudTasksConfig(override);
  return Boolean(cfg.projectId && cfg.location && cfg.workerBaseUrl);
}

export function isCloudTasksOidcConfigured(override?: Partial<CloudTasksConfig>): boolean {
  const cfg = getCloudTasksConfig(override);
  return Boolean(cfg.oidcServiceAccountEmail && (cfg.oidcAudience || cfg.workerBaseUrl));
}

function getTasksClient(): CloudTasksClientAdapter {
  if (!cachedClient) {
    cachedClient = new CloudTasksClient();
  }
  return cachedClient as unknown as CloudTasksClientAdapter;
}

export function resetCloudTasksClientForTests(): void {
  cachedClient = null;
}

export function buildDeterministicTaskId(idempotencyKey: string): string {
  const hash = crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 36);
  return `task-${hash}`;
}

function classifyCloudTasksError(err: unknown, queueName: string): CloudTasksError {
  if (err instanceof CloudTasksError) return err;
  const anyErr = err as { code?: number | string; message?: string } | undefined;
  const code = anyErr?.code;
  const msg = redactSensitiveString(anyErr?.message || String(err));
  if (code === 7 || code === 403 || /PERMISSION_DENIED/i.test(msg)) {
    return new CloudTasksError(
      'PERMISSION_DENIED',
      `Service account tidak memiliki izin Cloud Tasks Enqueuer pada queue "${queueName}": ${msg}`,
      { httpStatus: 503, retryable: false, cause: err }
    );
  }
  if (code === 5 || code === 404 || /NOT_FOUND/i.test(msg)) {
    return new CloudTasksError(
      'QUEUE_NOT_FOUND',
      `Queue Cloud Tasks "${queueName}" tidak ditemukan: ${msg}`,
      { httpStatus: 503, retryable: false, cause: err }
    );
  }
  if (
    code === 14 ||
    code === 4 ||
    code === 503 ||
    /UNAVAILABLE|DEADLINE_EXCEEDED|ECONNREFUSED|ENOTFOUND/i.test(msg)
  ) {
    return new CloudTasksError(
      'CLOUD_TASKS_UNAVAILABLE',
      `Google Cloud Tasks sedang tidak tersedia: ${msg}`,
      { httpStatus: 503, retryable: true, cause: err }
    );
  }
  return new CloudTasksError('ENQUEUE_FAILED', `Gagal menambahkan task ke Cloud Tasks: ${msg}`, {
    httpStatus: 503,
    retryable: true,
    cause: err,
  });
}

/**
 * Enqueues an idempotent HTTP task with mandatory OIDC authentication in Cloud Tasks.
 */
export async function enqueueCloudTask(
  input: EnqueueTaskInput,
  deps: {
    configOverride?: Partial<CloudTasksConfig>;
    tasksClient?: CloudTasksClientAdapter;
  } = {}
): Promise<EnqueueTaskResult> {
  const startedAt = Date.now();
  const cfg = getCloudTasksConfig(deps.configOverride);
  const queueName = cfg.queues[input.queue];
  const normalizedPath = input.targetPath.startsWith('/')
    ? input.targetPath
    : `/${input.targetPath}`;

  if (!cfg.projectId || !cfg.location || !cfg.workerBaseUrl) {
    if (cfg.strictProduction) {
      throw new CloudTasksError(
        'CLOUD_TASKS_NOT_CONFIGURED',
        'Google Cloud Tasks belum dikonfigurasi (wajib set GCP_PROJECT_ID, CLOUD_TASKS_LOCATION, dan WORKER_DISPATCH_BASE_URL di production).',
        { httpStatus: 503, retryable: false }
      );
    }
    return {
      enqueued: false,
      backend: 'local_fallback',
      taskName: `local://${queueName}/${buildDeterministicTaskId(input.idempotencyKey)}`,
      deduplicated: false,
      queueName,
      targetUrl: normalizedPath,
      queueLatencyMs: Date.now() - startedAt,
    };
  }

  // OIDC authentication is MANDATORY whenever dispatching to Cloud Tasks
  if (!cfg.oidcServiceAccountEmail) {
    throw new CloudTasksError(
      'OIDC_CONFIG_MISSING',
      'CLOUD_TASKS_OIDC_SA_EMAIL wajib dikonfigurasi agar setiap task Cloud Tasks menyertakan token OIDC terautentikasi.',
      { httpStatus: 503, retryable: false }
    );
  }

  const targetUrl = `${cfg.workerBaseUrl}${normalizedPath}`;
  const oidcAudience = cfg.oidcAudience || targetUrl;
  const client = deps.tasksClient ?? getTasksClient();
  const parent = client.queuePath(cfg.projectId, cfg.location, queueName);
  const taskId = buildDeterministicTaskId(input.idempotencyKey);
  const fullTaskName = client.taskPath(cfg.projectId, cfg.location, queueName, taskId);

  const correlationId = sanitizeCorrelationId(
    input.correlationId ??
      (typeof input.payload.correlationId === 'string' ? input.payload.correlationId : undefined)
  );
  const httpRequest = {
    httpMethod: 'POST' as const,
    url: targetUrl,
    headers: {
      'Content-Type': 'application/json',
      'X-AICliper-Idempotency-Key': input.idempotencyKey,
      ...(correlationId ? { 'X-Correlation-Id': correlationId } : {}),
    },
    body: Buffer.from(
      JSON.stringify(correlationId ? { ...input.payload, correlationId } : input.payload),
      'utf-8'
    ).toString('base64'),
    oidcToken: {
      serviceAccountEmail: cfg.oidcServiceAccountEmail,
      audience: oidcAudience,
    },
  };

  const taskPayload: Record<string, unknown> = {
    name: fullTaskName,
    httpRequest,
  };

  if (input.dispatchDeadlineSec && input.dispatchDeadlineSec >= 15) {
    taskPayload.dispatchDeadline = {
      seconds: Math.min(1800, Math.round(input.dispatchDeadlineSec)),
    };
  }

  if (input.scheduleDelaySec && input.scheduleDelaySec > 0) {
    taskPayload.scheduleTime = {
      seconds: Math.floor(Date.now() / 1000) + Math.round(input.scheduleDelaySec),
    };
  }

  try {
    const [created] = await client.createTask({
      parent,
      task: taskPayload,
    });
    const queueLatencyMs = Date.now() - startedAt;
    logStructuredEvent({
      service: 'cloud-tasks-queue',
      event: 'cloud_task_enqueued',
      severity: 'INFO',
      correlationId,
      queueTaskName: created.name || fullTaskName,
      renderJobId: typeof input.payload.jobId === 'string' ? input.payload.jobId : undefined,
      userUid: typeof input.payload.userUid === 'string' ? input.payload.userUid : undefined,
      clipId: typeof input.payload.clipId === 'string' ? input.payload.clipId : undefined,
      stage: 'queued',
      durationMs: queueLatencyMs,
      queueName,
    });
    return {
      enqueued: true,
      backend: 'cloud_tasks',
      taskName: created.name || fullTaskName,
      deduplicated: false,
      queueName,
      targetUrl,
      oidcAudience,
      queueLatencyMs,
    };
  } catch (err: unknown) {
    // gRPC status 6 = ALREADY_EXISTS -> idempotent duplicate prevention
    const code = (err as { code?: number })?.code;
    if (code === 6) {
      return {
        enqueued: true,
        backend: 'cloud_tasks',
        taskName: fullTaskName,
        deduplicated: true,
        queueName,
        targetUrl,
        oidcAudience,
        queueLatencyMs: Date.now() - startedAt,
      };
    }
    const classified = classifyCloudTasksError(err, queueName);
    logStructuredEvent({
      service: 'cloud-tasks-queue',
      event: 'cloud_task_enqueue_failed',
      severity: 'ERROR',
      renderJobId: typeof input.payload.jobId === 'string' ? input.payload.jobId : undefined,
      userUid: typeof input.payload.userUid === 'string' ? input.payload.userUid : undefined,
      stage: 'queued',
      durationMs: Date.now() - startedAt,
      errorCode: classified.code,
      errorMessage: classified.message,
      queueName,
    });
    throw classified;
  }
}

/**
 * Performs honest 5-level Cloud Tasks readiness probe via `getQueue`.
 */
export async function checkCloudTasksReadiness(deps: {
  configOverride?: Partial<CloudTasksConfig>;
  tasksClient?: CloudTasksClientAdapter;
} = {}): Promise<CloudTasksReadinessSnapshot> {
  const cfg = getCloudTasksConfig(deps.configOverride);
  const configured = Boolean(cfg.projectId && cfg.location && cfg.workerBaseUrl);
  const oidcConfigured = Boolean(cfg.oidcServiceAccountEmail && cfg.oidcAudience);

  if (!configured) {
    return {
      configured: false,
      authenticated: false,
      connected: false,
      operational: false,
      tested: false,
      oidcConfigured,
      projectId: cfg.projectId || null,
      location: cfg.location,
      queues: cfg.queues,
      mode: cfg.strictProduction ? 'cloud_tasks_misconfigured' : 'local_fallback',
      error: cfg.strictProduction
        ? 'Cloud Tasks belum dikonfigurasi untuk mode production.'
        : 'Cloud Tasks belum dikonfigurasi (mode development lokal).',
    };
  }

  if (!oidcConfigured) {
    return {
      configured: true,
      authenticated: false,
      connected: false,
      operational: false,
      tested: false,
      oidcConfigured: false,
      projectId: cfg.projectId,
      location: cfg.location,
      queues: cfg.queues,
      mode: 'cloud_tasks_misconfigured',
      error: 'CLOUD_TASKS_OIDC_SA_EMAIL wajib diatur agar internal dispatcher terautentikasi OIDC.',
    };
  }

  try {
    const client = deps.tasksClient ?? getTasksClient();
    const renderQueuePath = client.queuePath(cfg.projectId, cfg.location, cfg.queues.video_render);
    if (client.getQueue) {
      await client.getQueue({ name: renderQueuePath });
    }
    return {
      configured: true,
      authenticated: true,
      connected: true,
      operational: true,
      tested: true,
      oidcConfigured: true,
      projectId: cfg.projectId,
      location: cfg.location,
      queues: cfg.queues,
      mode: 'cloud_tasks',
    };
  } catch (err) {
    const classified = classifyCloudTasksError(err, cfg.queues.video_render);
    return {
      configured: true,
      authenticated: classified.code !== 'PERMISSION_DENIED',
      connected: false,
      operational: false,
      tested: false,
      oidcConfigured: true,
      projectId: cfg.projectId,
      location: cfg.location,
      queues: cfg.queues,
      mode: 'cloud_tasks_unreachable',
      error: classified.message,
    };
  }
}

export function getCloudTasksStatusSummary(): {
  configured: boolean;
  oidcConfigured: boolean;
  projectId: string | null;
  location: string;
  queues: Record<QueueNameKey, string>;
  mode: 'cloud_tasks' | 'local_fallback' | 'cloud_tasks_misconfigured';
} {
  const cfg = getCloudTasksConfig();
  const configured = Boolean(cfg.projectId && cfg.location && cfg.workerBaseUrl);
  const oidcConfigured = Boolean(cfg.oidcServiceAccountEmail && cfg.oidcAudience);
  return {
    configured,
    oidcConfigured,
    projectId: cfg.projectId || null,
    location: cfg.location,
    queues: cfg.queues,
    mode:
      configured && oidcConfigured
        ? 'cloud_tasks'
        : cfg.strictProduction || configured
          ? 'cloud_tasks_misconfigured'
          : 'local_fallback',
  };
}
