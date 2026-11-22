export interface CloudRunJobsReadinessStatus {
  configured: boolean;
  projectId: string;
  region: string;
  renderJobName: string;
  mode: 'cloud_run_jobs' | 'local_worker_fallback';
}

export interface DispatchRenderJobParams {
  renderJobId: string;
  userUid: string;
  clipId: string;
  renderProfile: string;
  renderFingerprint: string;
}

export interface DispatchRenderJobResult {
  dispatched: boolean;
  backend: 'cloud_run_jobs' | 'local_worker_fallback';
  executionName: string;
}

export function isCloudRunJobsConfigured(): boolean {
  return Boolean(
    process.env.GCP_PROJECT_ID &&
      process.env.CLOUD_RUN_RENDER_JOB_NAME &&
      process.env.CLOUD_RUN_JOBS_ENABLED === 'true'
  );
}

export function getCloudRunJobsReadinessStatus(): CloudRunJobsReadinessStatus {
  const configured = isCloudRunJobsConfigured();
  return {
    configured,
    projectId: (process.env.GCP_PROJECT_ID || '').trim(),
    region: (process.env.GCP_REGION || 'asia-southeast1').trim(),
    renderJobName: (process.env.CLOUD_RUN_RENDER_JOB_NAME || 'aicliper-render-worker').trim(),
    mode: configured ? 'cloud_run_jobs' : 'local_worker_fallback',
  };
}

/**
 * Triggers a Cloud Run Job execution via Cloud Run Admin API v2 when enabled in GCP.
 * Falls back honestly to local worker execution in sandbox/dev environments.
 */
export async function dispatchCloudRunRenderJob(
  params: DispatchRenderJobParams
): Promise<DispatchRenderJobResult> {
  if (!isCloudRunJobsConfigured()) {
    return {
      dispatched: false,
      backend: 'local_worker_fallback',
      executionName: `local-exec-${params.renderJobId}`,
    };
  }

  const projectId = process.env.GCP_PROJECT_ID!;
  const region = process.env.GCP_REGION || 'asia-southeast1';
  const jobName = process.env.CLOUD_RUN_RENDER_JOB_NAME!;
  const accessToken = process.env.GCP_ACCESS_TOKEN || '';

  const endpoint = `https://run.googleapis.com/v2/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}/jobs/${encodeURIComponent(jobName)}:run`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({
      overrides: {
        containerOverrides: [
          {
            env: [
              { name: 'AICLIPER_RENDER_JOB_ID', value: params.renderJobId },
              { name: 'AICLIPER_USER_UID', value: params.userUid },
              { name: 'AICLIPER_CLIP_ID', value: params.clipId },
              { name: 'AICLIPER_RENDER_PROFILE', value: params.renderProfile },
              { name: 'AICLIPER_RENDER_FINGERPRINT', value: params.renderFingerprint },
            ],
          },
        ],
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Cloud Run Job trigger gagal (${response.status}): ${errText.slice(0, 160)}`);
  }

  const payload = (await response.json().catch(() => ({}))) as { name?: string };
  return {
    dispatched: true,
    backend: 'cloud_run_jobs',
    executionName: payload.name || `projects/${projectId}/locations/${region}/jobs/${jobName}`,
  };
}
