/**
 * AICLIPER Fase 0C — Live Google Cloud Production Verification CLI
 *
 * Usage:
 *   node scripts/verify-live-gcp.ts [--json] [--skip-gcs-write] [--api-url=https://...]
 *
 * Strictly verifies live GCP readiness using real probes (Cloud SQL, GCS, Cloud Tasks + OIDC,
 * Cloud Run Jobs + ADC, FFmpeg/FFprobe, and optional live Cloud Run API `/api/health`).
 * Never fabricates pass results: exits with code 1 whenever required live GCP layers are
 * unconfigured, unauthenticated, unreachable, or fail round-trip verification.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { checkPgReadiness, closePgPool } from '../src/db/index.ts';
import {
  checkGcsReadiness,
  computeFileSha256,
  deleteStorageObject,
  downloadMediaToLocalPath,
  uploadLocalFileToStorage,
} from '../server/services/gcsStorageService.ts';
import { checkCloudTasksReadiness } from '../server/services/cloudTasksService.ts';
import {
  checkAdcReadiness,
  checkCloudRunJobsReadiness,
} from '../server/services/cloudRunJobsService.ts';
import { ensureFfmpegPath, ensureFfprobePath } from '../server/ffmpegBinaries.ts';

export interface LiveGcpVerificationReport {
  timestamp: string;
  phase: '0C';
  environment: string;
  overallReady: boolean;
  verdict: 'LIVE_GCP_VERIFIED' | 'INCOMPLETE_OR_UNCONFIGURED';
  checks: {
    database: Awaited<ReturnType<typeof checkPgReadiness>>;
    adc: Awaited<ReturnType<typeof checkAdcReadiness>>;
    storage: Awaited<ReturnType<typeof checkGcsReadiness>> & {
      roundTripTested: boolean;
      roundTripChecksumVerified: boolean;
      tenantIsolationBlocked: boolean;
      roundTripError?: string | null;
    };
    queue: Awaited<ReturnType<typeof checkCloudTasksReadiness>>;
    renderWorkerJob: Awaited<ReturnType<typeof checkCloudRunJobsReadiness>>;
    mediaBinaries: {
      ffmpegReady: boolean;
      ffprobeReady: boolean;
    };
    apiHealth: {
      checked: boolean;
      url: string | null;
      ok: boolean;
      statusCode: number | null;
      error: string | null;
    };
  };
  blockers: string[];
}

export interface RunLiveGcpVerificationOptions {
  skipGcsWrite?: boolean;
  apiUrl?: string;
}

export async function runLiveGcpVerification(
  options: RunLiveGcpVerificationOptions = {}
): Promise<LiveGcpVerificationReport> {
  const [database, adc, storageBase, queue, renderWorkerJob] = await Promise.all([
    checkPgReadiness(),
    checkAdcReadiness(),
    checkGcsReadiness(),
    checkCloudTasksReadiness(),
    checkCloudRunJobsReadiness(),
  ]);

  let ffmpegReady = false;
  let ffprobeReady = false;
  try {
    ffmpegReady = Boolean(await ensureFfmpegPath());
  } catch {
    ffmpegReady = false;
  }
  try {
    ffprobeReady = Boolean(await ensureFfprobePath());
  } catch {
    ffprobeReady = false;
  }

  let roundTripTested = false;
  let roundTripChecksumVerified = false;
  let tenantIsolationBlocked = false;
  let roundTripError: string | null = null;

  if (storageBase.operational && !options.skipGcsWrite) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicliper-gcp-verify-'));
    const probeUidA = 'verify_probe_user_a';
    const probeUidB = 'verify_probe_user_b';
    const probeProjectId = `verify_${Date.now()}`;
    const srcFile = path.join(tmpDir, 'probe.bin');
    const dstFile = path.join(tmpDir, 'probe_download.bin');
    const crossTenantFile = path.join(tmpDir, 'cross_tenant.bin');
    let uploadedKey: string | null = null;

    try {
      const randomPayload = crypto.randomBytes(4096);
      fs.writeFileSync(srcFile, randomPayload);
      const expectedSha256 = computeFileSha256(srcFile);

      const stored = await uploadLocalFileToStorage({
        localFilePath: srcFile,
        userUid: probeUidA,
        projectId: probeProjectId,
        category: 'temp',
        filename: 'phase0c-probe.bin',
        contentType: 'application/octet-stream',
        configOverride: { strictProduction: true },
      });
      uploadedKey = stored.objectKey;

      await downloadMediaToLocalPath({
        objectKey: stored.objectKey,
        requesterUid: probeUidA,
        destinationPath: dstFile,
        expectedSha256,
        configOverride: { strictProduction: true },
      });
      roundTripChecksumVerified = computeFileSha256(dstFile) === expectedSha256;

      // Confirm cross-tenant download is strictly rejected before hitting GCS
      try {
        await downloadMediaToLocalPath({
          objectKey: stored.objectKey,
          requesterUid: probeUidB,
          destinationPath: crossTenantFile,
          configOverride: { strictProduction: true },
        });
        tenantIsolationBlocked = false;
      } catch (isolationErr) {
        tenantIsolationBlocked =
          (isolationErr as { code?: string })?.code === 'UNAUTHORIZED_ACCESS';
      }

      roundTripTested = roundTripChecksumVerified && tenantIsolationBlocked;
    } catch (err) {
      roundTripError = err instanceof Error ? err.message : String(err);
    } finally {
      if (uploadedKey) {
        await deleteStorageObject({
          objectKey: uploadedKey,
          requesterUid: probeUidA,
          configOverride: { strictProduction: true },
        }).catch(() => undefined);
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  const targetApiBase = (options.apiUrl || process.env.WORKER_DISPATCH_BASE_URL || '').trim();
  const apiHealth: LiveGcpVerificationReport['checks']['apiHealth'] = {
    checked: false,
    url: targetApiBase ? `${targetApiBase.replace(/\/+$/, '')}/api/health` : null,
    ok: false,
    statusCode: null,
    error: null,
  };

  if (apiHealth.url) {
    apiHealth.checked = true;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(apiHealth.url, { signal: controller.signal });
      clearTimeout(timer);
      apiHealth.statusCode = resp.status;
      apiHealth.ok = resp.ok;
      if (!resp.ok) {
        apiHealth.error = `HTTP ${resp.status}`;
      }
    } catch (err) {
      apiHealth.error = err instanceof Error ? err.message : String(err);
    }
  }

  const blockers: string[] = [];
  if (!database.operational) {
    blockers.push(`Cloud SQL PostgreSQL not operational: ${database.error || 'not configured'}`);
  }
  if (!adc.authenticated) {
    blockers.push(`Google ADC not authenticated: ${adc.error || 'no active GCP credentials'}`);
  }
  if (!storageBase.operational) {
    blockers.push(`GCS bucket not operational: ${storageBase.error || 'not configured'}`);
  } else if (!options.skipGcsWrite && !roundTripTested) {
    blockers.push(
      `GCS round-trip/isolation check failed: ${roundTripError || 'checksum or tenant isolation check failed'}`
    );
  }
  if (!queue.operational) {
    blockers.push(`Cloud Tasks + OIDC not operational: ${queue.error || 'not configured'}`);
  }
  if (!renderWorkerJob.operational) {
    blockers.push(`Cloud Run Render Job not operational: ${renderWorkerJob.error || 'not configured'}`);
  }
  if (!ffmpegReady || !ffprobeReady) {
    blockers.push('FFmpeg/FFprobe binaries unavailable in current runtime');
  }
  if (apiHealth.checked && !apiHealth.ok) {
    blockers.push(`Live API health check failed (${apiHealth.url}): ${apiHealth.error || 'unhealthy'}`);
  }

  const overallReady = blockers.length === 0;

  return {
    timestamp: new Date().toISOString(),
    phase: '0C',
    environment: process.env.NODE_ENV || 'development',
    overallReady,
    verdict: overallReady ? 'LIVE_GCP_VERIFIED' : 'INCOMPLETE_OR_UNCONFIGURED',
    checks: {
      database,
      adc,
      storage: {
        ...storageBase,
        roundTripTested,
        roundTripChecksumVerified,
        tenantIsolationBlocked,
        roundTripError,
      },
      queue,
      renderWorkerJob,
      mediaBinaries: {
        ffmpegReady,
        ffprobeReady,
      },
      apiHealth,
    },
    blockers,
  };
}

function isDirectCliExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectCliExecution()) {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const skipGcsWrite = args.includes('--skip-gcs-write');
  const apiUrlArg = args.find((a) => a.startsWith('--api-url='));
  const apiUrl = apiUrlArg ? apiUrlArg.slice('--api-url='.length) : undefined;

  runLiveGcpVerification({ skipGcsWrite, apiUrl })
    .then(async (report) => {
      if (jsonOutput) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`AICLIPER Phase 0C Live GCP Verification — ${report.verdict}`);
        console.log(`  Cloud SQL PostgreSQL : operational=${report.checks.database.operational} (configured=${report.checks.database.configured})`);
        console.log(`  Google ADC           : authenticated=${report.checks.adc.authenticated}`);
        console.log(`  GCS Storage          : operational=${report.checks.storage.operational}, roundTrip=${report.checks.storage.roundTripTested}`);
        console.log(`  Cloud Tasks + OIDC   : operational=${report.checks.queue.operational}, oidc=${report.checks.queue.oidcConfigured}`);
        console.log(`  Cloud Run Render Job : operational=${report.checks.renderWorkerJob.operational}`);
        console.log(`  FFmpeg / FFprobe     : ffmpeg=${report.checks.mediaBinaries.ffmpegReady}, ffprobe=${report.checks.mediaBinaries.ffprobeReady}`);
        if (report.checks.apiHealth.checked) {
          console.log(`  API /api/health      : ok=${report.checks.apiHealth.ok} (${report.checks.apiHealth.url})`);
        }
        if (report.blockers.length > 0) {
          console.log('Blockers:');
          for (const b of report.blockers) {
            console.log(`  - ${b}`);
          }
        }
      }
      await closePgPool().catch(() => undefined);
      process.exit(report.overallReady ? 0 : 1);
    })
    .catch(async (err) => {
      console.error('Fatal verification error:', err instanceof Error ? err.message : String(err));
      await closePgPool().catch(() => undefined);
      process.exit(1);
    });
}
