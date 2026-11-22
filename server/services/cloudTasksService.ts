import crypto from 'crypto';
import { CloudTasksClient } from '@google-cloud/tasks';

export type CloudTaskQueueName = 'media-ingestion' | 'ai-analysis' | 'video-render-dispatch';

export interface CloudTasksReadinessStatus {
  configured: boolean;
  projectId: string;
  location: string;
  queues: Record<CloudTaskQueueName, string>;
  mode: 'google_cloud_tasks' | 'local_async_fallback';
}

export interface EnqueueTaskParams {
  queue: CloudTaskQueueName;
  idempotencyKey: string;
  targetPath: string;
  payload: Record<string, unknown>;
  scheduleDelaySec?: number;
  dispatchDeadlineSec?: number;
}

export interface EnqueueTaskResult {
  dispatched: boolean;
  deduplicated: boolean;
  backend: 'cloud_tasks' | 'local_fallback';
  taskName: string;
  queue: CloudTaskQueueName;
}

let tasksClient: CloudTasksClient | null = null;
const localDedupeRegistry = new Map<string, { taskName: string; expiresAt: number }>();

function getProjectId(): string {
  return (process.env.GCP_PROJECT_ID || '').trim();
}

function getLocation(): string {
  return (process.env.CLOUD_TASKS_LOCATION || process.env.GCP_REGION || 'asia-southeast1').trim();
}

function getWorkerBaseUrl(): string {
  return (process.env.WORKER_DISPATCH_BASE_URL || '').trim().replace(/\/+$/, '');
}

export function getQueueConfigMap(): Record<CloudTaskQueueName, string> {
  return {
    'media-ingestion': process.env.CLOUD_TASKS_QUEUE_MEDIA || 'media-ingestion',
    'ai-analysis': process.env.CLOUD_TASKS_QUEUE_AI || 'ai-analysis',
    'video-render-dispatch': process.env.CLOUD_TASKS_QUEUE_RENDER || 'video-render-dispatch',
  };
}

export function isCloudTasksConfigured(): boolean {
  return Boolean(getProjectId() && getWorkerBaseUrl());
}

export function getCloudTasksReadinessStatus(): CloudTasksReadinessStatus {
  const configured = isCloudTasksConfigured();
  return {
    configured,
    projectId: getProjectId(),
    location: getLocation(),
    queues: getQueueConfigMap(),
    mode: configured ? 'google_cloud_tasks' : 'local_async_fallback',
  };
}

function buildDeterministicTaskId(queue: CloudTaskQueueName, idempotencyKey: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${queue}:${idempotencyKey}`)
    .digest('hex')
    .slice(0, 32);
  return `${queue.replace(/[^a-z0-9]/gi, '-')}-${hash}`;
}

export function clearLocalTaskDedupeRegistry(): void {
  localDedupeRegistry.clear();
}

export async function enqueueCloudTask(params: EnqueueTaskParams): Promise<EnqueueTaskResult> {
  const taskId = buildDeterministicTaskId(params.queue, params.idempotencyKey);
  const now = Date.now();

  // Prune expired local dedupe entries
  for (const [key, entry] of localDedupeRegistry.entries()) {
    if (entry.expiresAt < now) localDedupeRegistry.delete(key);
  }

  const queueMap = getQueueConfigMap();
  const queueId = queueMap[params.queue];

  if (isCloudTasksConfigured()) {
    if (!tasksClient) {
      tasksClient = new CloudTasksClient();
    }
    const projectId = getProjectId();
    const location = getLocation();
    const parent = tasksClient.queuePath(projectId, location, queueId);
    const fullTaskName = `${parent}/tasks/${taskId}`;
    const url = `${getWorkerBaseUrl()}${params.targetPath.startsWith('/') ? '' : '/'}${params.targetPath}`;
    const serviceAccountEmail = (process.env.CLOUD_TASKS_OIDC_SA_EMAIL || '').trim();

    try {
      const [response] = await tasksClient.createTask({
        parent,
        task: {
          name: fullTaskName,
          dispatchDeadline: {
            seconds: Math.max(30, Math.min(1800, params.dispatchDeadlineSec ?? 600)),
          },
          ...(params.scheduleDelaySec && params.scheduleDelaySec > 0
            ? {
                scheduleTime: {
                  seconds: Math.floor(Date.now() / 1000) + params.scheduleDelaySec,
                },
              }
            : {}),
          httpRequest: {
            httpMethod: 'POST',
            url,
            headers: {
              'Content-Type': 'application/json',
              'X-AICLIPER-Idempotency-Key': params.idempotencyKey,
            },
            body: Buffer.from(JSON.stringify(params.payload)).toString('base64'),
            ...(serviceAccountEmail
              ? {
                  oidcToken: {
                    serviceAccountEmail,
                    audience: getWorkerBaseUrl(),
                  },
                }
              : {}),
          },
        },
      });
      return {
        dispatched: true,
        deduplicated: false,
        backend: 'cloud_tasks',
        taskName: response.name || fullTaskName,
        queue: params.queue,
      };
    } catch (err) {
      const code = (err as { code?: number })?.code;
      // gRPC ALREADY_EXISTS (code 6) means deterministic task idempotency prevented duplicate execution
      if (code === 6) {
        return {
          dispatched: false,
          deduplicated: true,
          backend: 'cloud_tasks',
          taskName: fullTaskName,
          queue: params.queue,
        };
      }
      throw err;
    }
  }

  // Honest local fallback with idempotency deduplication
  const existing = localDedupeRegistry.get(taskId);
  if (existing && existing.expiresAt > now) {
    return {
      dispatched: false,
      deduplicated: true,
      backend: 'local_fallback',
      taskName: existing.taskName,
      queue: params.queue,
    };
  }

  const localTaskName = `local/${queueId}/tasks/${taskId}`;
  localDedupeRegistry.set(taskId, {
    taskName: localTaskName,
    expiresAt: now + 5 * 60 * 1000,
  });

  return {
    dispatched: true,
    deduplicated: false,
    backend: 'local_fallback',
    taskName: localTaskName,
    queue: params.queue,
  };
}
