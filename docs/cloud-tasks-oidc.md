# AICLIPER — Google Cloud Tasks & OIDC Authentication Guide (Fase 0C)

AICLIPER menggunakan **Google Cloud Tasks** sebagai antrean produksi asinkron untuk memisahkan request HTTP cepat dari beban rendering/AI. Semua pengiriman task ke internal dispatcher wajib menggunakan **OIDC Bearer JWT** yang diverifikasi oleh `server/services/oidcAuthService.ts` dan `server/routes/internalDispatchRoutes.ts`.

## 1. Pembuatan Antrean Cloud Tasks `[PRODUCTION-MUTATING]`

Antrean yang didukung oleh `server/services/cloudTasksService.ts`:
- `media-ingestion` (`CLOUD_TASKS_MEDIA_QUEUE`)
- `ai-analysis-queue` (`CLOUD_TASKS_AI_QUEUE`)
- `video-render-queue` (`CLOUD_TASKS_RENDER_QUEUE`)
- `publish-queue` (`CLOUD_TASKS_PUBLISH_QUEUE`)

```bash
# Antrean Render Video (retry backoff terkontrol, rate limit melindungi Cloud SQL & Cloud Run Jobs)
gcloud tasks queues create video-render-queue \
  --location="${CLOUD_TASKS_LOCATION}" \
  --max-dispatches-per-second=5 \
  --max-concurrent-dispatches=10 \
  --max-attempts=5 \
  --min-backoff=10s \
  --max-backoff=300s \
  --max-doublings=4 \
  --project="${GCP_PROJECT_ID}"

# Antrean Media Ingestion, AI Analysis, dan Publish
for Q in media-ingestion ai-analysis-queue publish-queue; do
  gcloud tasks queues create "${Q}" \
    --location="${CLOUD_TASKS_LOCATION}" \
    --max-dispatches-per-second=10 \
    --max-concurrent-dispatches=20 \
    --max-attempts=5 \
    --min-backoff=5s \
    --max-backoff=120s \
    --project="${GCP_PROJECT_ID}"
done
```

## 2. IAM Binding untuk OIDC Dispatcher `[PRODUCTION-MUTATING]`

1. Izinkan `aicliper-api-sa` melampirkan token OIDC milik `aicliper-tasks-invoker-sa` saat membuat task:
   ```bash
   gcloud iam service-accounts add-iam-policy-binding \
     "aicliper-tasks-invoker-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
     --member="serviceAccount:aicliper-api-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
     --role="roles/iam.serviceAccountUser" \
     --project="${GCP_PROJECT_ID}"
   ```
2. Izinkan `aicliper-tasks-invoker-sa` memanggil Cloud Run Service `aicliper-api`:
   ```bash
   gcloud run services add-iam-policy-binding aicliper-api \
     --region="${GCP_REGION}" \
     --member="serviceAccount:aicliper-tasks-invoker-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
     --role="roles/run.invoker" \
     --project="${GCP_PROJECT_ID}"
   ```

## 3. Verifikasi Keamanan Internal Dispatcher (`/internal/dispatch/render`)

- **Fail-Closed di Production**: Request tanpa `Authorization: Bearer <OIDC_JWT>` ditolak (`401`).
- **Validasi Klaim OIDC**: `verifyCloudTasksOidcRequest()` memverifikasi tanda tangan Google OIDC, `aud === CLOUD_TASKS_OIDC_AUDIENCE`, `iss`, masa berlaku token, dan `email === CLOUD_TASKS_OIDC_SA_EMAIL` (`email_verified === true`).
- **Stale / Expired Task Guard**: Jika payload membawa `expiresAt` yang sudah lewat, dispatcher mengembalikan HTTP `200` (`status: "expired"`, `code: "TASK_EXPIRED"`) sehingga Cloud Tasks berhenti me-retry task usang secara berulang.
- **Duplicate Dispatch Protection**: `claimRenderJobForDispatch()` mencegah task duplikat memicu dua Cloud Run Job untuk `renderJobId` yang sama.
- **Correlation ID End-to-End**: `X-Correlation-Id` diteruskan dari API -> Cloud Tasks header/payload -> internal dispatcher -> `AICLIPER_CORRELATION_ID` pada Cloud Run Job.
