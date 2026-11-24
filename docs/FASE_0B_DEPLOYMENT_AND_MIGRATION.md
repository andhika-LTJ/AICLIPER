# AICLIPER Fase 0B — Panduan Deployment Production, Migrasi Bertahap & Rollback

Dokumen ini menjadi checklist operasional untuk membawa AICLIPER dari environment development lokal (SQLite + local fallback) ke infrastruktur production GCP:

```text
React/Vite Frontend
 -> Cloud Run Service (Express API + Authenticated OIDC Dispatcher)
 -> Cloud SQL PostgreSQL + Google Cloud Storage
 -> Google Cloud Tasks (OIDC Token)
 -> Authenticated Dispatcher (POST /api/internal/dispatch/render)
 -> Cloud Run Jobs (Google ADC, tanpa static access token)
 -> Standalone Render Worker (workers/renderWorker.ts -> existing renderClipMp4 FFmpeg/FFprobe)
 -> GCS Output (users/{uid}/projects/{clipId}/renders/...)
 -> PostgreSQL Job Status & Telemetry
```

---

## 1. Prasyarat GCP

1. Project GCP aktif dengan billing enabled (`GCP_PROJECT_ID`, `GCP_REGION=asia-southeast2`).
2. Aktifkan API:
   ```bash
   gcloud services enable \
     run.googleapis.com \
     cloudtasks.googleapis.com \
     sqladmin.googleapis.com \
     storage.googleapis.com \
     secretmanager.googleapis.com \
     artifactregistry.googleapis.com
   ```
3. Buat 3 Service Account least-privilege sesuai `infra/IAM_AND_SERVICE_ACCOUNTS.md`.

---

## 2. Provisioning Infrastruktur & Secrets

1. **Secret Manager** (jangan pernah menaruh secret di source code atau env plaintext):
   - `aicliper-gemini-api-key`
   - `aicliper-sql-password`
   - `aicliper-stream-token-secret`
2. **Cloud SQL PostgreSQL 16**:
   - Buat instance PostgreSQL + database `aicliper` + user `aicliper_app`.
   - Catat `SQL_INSTANCE_CONNECTION_NAME` (`project:region:instance`).
3. **Google Cloud Storage Bucket**:
   - Buat bucket private (`--uniform-bucket-level-access`, public access prevented).
   - Aktifkan lifecycle rule pembersihan folder `temp/` setelah 7 hari.
4. **Google Cloud Tasks Queues**:
   ```bash
   gcloud tasks queues create video-render-queue --location="${GCP_REGION}" \
     --max-attempts=3 --min-backoff=15s --max-backoff=120s --max-concurrent-dispatches=10
   gcloud tasks queues create ai-analysis-queue --location="${GCP_REGION}" \
     --max-attempts=3 --min-backoff=10s --max-backoff=60s
   gcloud tasks queues create publish-queue --location="${GCP_REGION}" \
     --max-attempts=3 --min-backoff=15s --max-backoff=120s
   ```

---

## 3. Build & Push Container Images

```bash
export IMAGE_TAG="$(git rev-parse --short HEAD)"
export REPO="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/aicliper"

docker build -f infra/Dockerfile.api -t "${REPO}/api:${IMAGE_TAG}" .
docker push "${REPO}/api:${IMAGE_TAG}"

docker build -f infra/Dockerfile.render-worker -t "${REPO}/render-worker:${IMAGE_TAG}" .
docker push "${REPO}/render-worker:${IMAGE_TAG}"
```

---

## 4. Deploy Cloud Run Job & Cloud Run Service

```bash
# Deploy Render Worker Cloud Run Job
envsubst < infra/cloud-run-render-job.yaml | gcloud run jobs replace - --region="${GCP_REGION}"

# Deploy Backend API + Authenticated OIDC Dispatcher
gcloud run deploy aicliper-api \
  --region="${GCP_REGION}" \
  --image="${REPO}/api:${IMAGE_TAG}" \
  --service-account="aicliper-api-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
  --add-cloudsql-instances="${SQL_INSTANCE_CONNECTION_NAME}" \
  --set-env-vars="NODE_ENV=production,GCS_REQUIRED=true,CLOUD_RENDER_DISPATCH_ENABLED=true,GCP_PROJECT_ID=${GCP_PROJECT_ID},GCP_REGION=${GCP_REGION},GCS_BUCKET_NAME=${GCS_BUCKET_NAME},CLOUD_RUN_RENDER_JOB_NAME=aicliper-render-worker,CLOUD_TASKS_LOCATION=${GCP_REGION},CLOUD_TASKS_OIDC_SA_EMAIL=aicliper-tasks-invoker-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com,WORKER_DISPATCH_BASE_URL=https://YOUR-API-URL.run.app,SQL_INSTANCE_CONNECTION_NAME=${SQL_INSTANCE_CONNECTION_NAME},SQL_DB_NAME=${SQL_DB_NAME},SQL_USER=${SQL_USER}" \
  --set-secrets="GEMINI_API_KEY=aicliper-gemini-api-key:latest,SQL_PASSWORD=aicliper-sql-password:latest,STREAM_TOKEN_SECRET=aicliper-stream-token-secret:latest"
```

---

## 5. Migrasi Database Bertahap (SQLite -> PostgreSQL)

SQLite **TIDAK DIHAPUS** selama masa transisi. Gunakan skrip migrasi terverifikasi:

```bash
# 1. Dry-run integritas & backup otomatis SQLite
node scripts/migrate-sqlite-to-postgres.ts --sqlite data/klipcast.sqlite --dry-run

# 2. Eksekusi migrasi schema (001..004) + impor data + verifikasi jumlah baris
SQL_HOST=127.0.0.1 SQL_DB_NAME=aicliper SQL_USER=aicliper_app SQL_PASSWORD=... \
  node scripts/migrate-sqlite-to-postgres.ts --sqlite data/klipcast.sqlite
```

---

## 6. Smoke Test Production Wajib Sebelum Menyatakan COMPLETE

1. Login dengan akun Admin -> buka `GET /api/v3/readiness` -> pastikan **seluruh** 5 kolom (`configured`, `authenticated`, `connected`, `operational`, `tested`) bernilai `true` untuk PostgreSQL, GCS, Cloud Tasks, Cloud Run Jobs, dan ADC.
2. Upload video sumber -> verifikasi tersimpan di `gs://${GCS_BUCKET_NAME}/users/{uid}/projects/{projectId}/sources/...`.
3. Trigger render 1080p dan 4K -> verifikasi:
   - API mengembalikan HTTP `202` (`executionMode: "cloud_tasks_dispatcher"`).
   - Cloud Tasks memanggil `POST /api/internal/dispatch/render` dengan OIDC JWT valid (tolak request tanpa OIDC dengan HTTP `401`).
   - Dispatcher memicu Cloud Run Job `aicliper-render-worker` via Google ADC dan mencatat `cloudRunExecution`.
   - Worker menjalankan `renderClipMp4`, memverifikasi output dengan `ffprobe`, mengunggah MP4 ke GCS, memperbarui status ke `completed`, dan membersihkan `/tmp`.
4. Uji coba trigger ulang job yang sudah selesai -> pastikan tidak merender ulang dan tidak mengurangi kuota dua kali.

---

## 7. Strategi Rollback Cepat

1. **Rollback Aplikasi**: `gcloud run services update-traffic aicliper-api --to-revisions=PREVIOUS_REVISION=100 --region=${GCP_REGION}`.
2. **Rollback Database**: Karena SQLite backup dibuat otomatis di `data/backups/pre-pg-migration-*.sqlite` dan file SQLite asli tetap utuh, mengosongkan `SQL_HOST` / `SQL_INSTANCE_CONNECTION_NAME` mengembalikan mode staged fallback tanpa kehilangan data sebelum migrasi.
3. **Rollback Queue**: Pause queue Cloud Tasks (`gcloud tasks queues pause video-render-queue --location=${GCP_REGION}`) jika worker mengalami kegagalan beruntun.
