# AICLIPER — Production Operations Runbook (Fase 0C)

Runbook operasional untuk memantau kesehatan AICLIPER, menelusuri insiden menggunakan `correlationId`, dan menangani gangguan umum di produksi.

## 1. Monitoring & Key Metrics

Pantau melalui **Admin Control Center (`/api/v3/readiness`)** dan **Google Cloud Logging / Monitoring**:

| Sinyal | Sumber | Ambang Peringatan (Alerting) |
|---|---|---|
| API Error Rate (5xx) | Cloud Run `aicliper-api` | > 2% selama 5 menit |
| Render Failure Rate | `telemetry.renderFailureCount` & log `worker_job_failed` | > 10% dalam 15 menit |
| Queue Backlog | Cloud Tasks `video-render-queue` & `telemetry.queuedRenderCount` | > 25 task tertahan > 10 menit |
| Worker Memory / OOM | Cloud Run Jobs `aicliper-render-worker` | Memory > 85% limit (naikkan 8Gi -> 16Gi untuk 4K) |
| DB Connection Pool | Cloud SQL PostgreSQL (`PG_POOL_MAX`) & `database.latencyMs` | Latency > 500ms atau `53300` too_many_connections |

## 2. Log Correlation Query (Cloud Logging) `[SAFE]`

Semua log terstruktur berformat JSON (`server/services/structuredLogger.ts`) dengan field `correlationId`, `renderJobId`, `userUid`, `stage`, `durationMs`, `errorCode`:

```
resource.type=("cloud_run_revision" OR "cloud_run_job")
jsonPayload.correlationId="corr_<render_job_id>"
```

Untuk melihat seluruh kegagalan render terbaru:
```
resource.type="cloud_run_job"
jsonPayload.service="aicliper-render-worker"
severity>=ERROR
```

## 3. Troubleshooting Skenario Umum

### A. `GCS_STORAGE_REQUIRED` atau Gagal Upload GCS
- **Penyebab**: `GCS_BUCKET_NAME` kosong, IAM `roles/storage.objectAdmin` belum diberikan ke `aicliper-api-sa`/`aicliper-render-worker-sa`, atau gangguan jaringan sementara.
- **Tindakan**: Worker sudah melakukan retry eksponensial (maks 3 kali) + verifikasi SHA-256. Periksa IAM bucket dan jalankan `node scripts/verify-live-gcp.ts --json`.

### B. `401 Unauthorized` pada `/internal/dispatch/render`
- **Penyebab**: `CLOUD_TASKS_OIDC_AUDIENCE` tidak sama dengan URL service `WORKER_DISPATCH_BASE_URL`, atau `CLOUD_TASKS_OIDC_SA_EMAIL` berbeda dari token OIDC yang dikirim Cloud Tasks.
- **Tindakan**: Samakan `CLOUD_TASKS_OIDC_AUDIENCE` dengan URL HTTPS persis milik `aicliper-api` (tanpa trailing slash).

### C. Job Render Terhenti (`WORKER_SIGTERM_INTERRUPTED` atau OOM)
- **Penyebab**: Cloud Run Job menerima `SIGTERM` (timeout 1800s terlampaui) atau video 4K kehabisan memori di 8Gi.
- **Tindakan**: Worker otomatis menandai job `failed` agar retryable; jika sebelumnya hard crash (`SIGKILL`), stale lock otomatis diambil alih setelah `WORKER_LOCK_TTL_SECONDS`. Untuk beban 4K, naikkan alokasi manifest ke `cpu: "8"`, `memory: "16Gi"`, `timeoutSeconds: 3600`.

### D. `preservedOutputGcsUri` Tercatat di Log Error
- **Penyebab**: File MP4 berhasil diunggah ke GCS, namun koneksi PostgreSQL terputus saat finalisasi status `completed`.
- **Tindakan**: File output di GCS tetap aman (tidak hilang). Retry job akan memproses ulang atau operator dapat memeriksa objek pada URI GCS tersebut di bucket produksi.
