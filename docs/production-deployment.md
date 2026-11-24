# AICLIPER — Production Deployment Guide (Staged Deployment — Fase 0C)

Dokumen ini menjelaskan alur deployment bertahap (Staged Deployment) untuk AICLIPER ke Google Cloud tanpa mengubah sistem autentikasi Firebase, Google Login, atau YouTube OAuth yang sudah berjalan.

## Arsitektur Produksi

```
Browser (React/Vite + Firebase Auth + YouTube OAuth)
  -> Cloud Run Service (`aicliper-api`, `infra/Dockerfile.api`, `infra/cloud-run-api-service.yaml`)
     -> Cloud SQL PostgreSQL (Drizzle ORM, `src/db/schema.ts`, `src/db/index.ts`)
     -> Google Cloud Storage (`users/{uid}/projects/{projectId}/...`, `server/services/gcsStorageService.ts`)
     -> Google Cloud Tasks (OIDC-authenticated, `server/services/cloudTasksService.ts`)
        -> `POST /internal/dispatch/render` (`server/routes/internalDispatchRoutes.ts`, OIDC token verification)
           -> Cloud Run Jobs (`aicliper-render-worker`, `infra/Dockerfile.render-worker`, `workers/renderWorker.ts`)
              -> FFmpeg + FFprobe (Balanced 1080p & 4K) -> GCS Upload + SHA-256 Checksum -> PostgreSQL Finalize
```

## Klasifikasi Perintah

- **[SAFE]**: Inspeksi lokal, build, lint, test, validasi dry-run.
- **[OPERATOR-CONFIGURED]**: Membutuhkan variabel proyek GCP operator (`GCP_PROJECT_ID`, `GCP_REGION`, dll.).
- **[PRODUCTION-MUTATING]**: Memodifikasi infrastruktur cloud, schema database, atau routing traffic produksi.
- **[DESTRUCTIVE]**: Menghapus resource atau mengembalikan state secara permanen (selalu butuh persetujuan eksplisit).

## Urutan Staged Deployment

### Tahap 0 — Persiapan Variabel Operator `[OPERATOR-CONFIGURED]`

```bash
export GCP_PROJECT_ID="<your-gcp-project-id>"
export GCP_REGION="asia-southeast2"
export IMAGE_TAG="$(git rev-parse --short HEAD)"
export GCS_BUCKET_NAME="${GCP_PROJECT_ID}-aicliper-media"
export SQL_INSTANCE_NAME="aicliper-pg-prod"
export SQL_INSTANCE_CONNECTION_NAME="${GCP_PROJECT_ID}:${GCP_REGION}:${SQL_INSTANCE_NAME}"
export SQL_DB_NAME="aicliper"
export SQL_USER="aicliper_app"
export CLOUD_TASKS_LOCATION="${GCP_REGION}"
export CLOUD_TASKS_MEDIA_QUEUE="media-ingestion"
export CLOUD_TASKS_AI_QUEUE="ai-analysis-queue"
export CLOUD_TASKS_RENDER_QUEUE="video-render-queue"
export CLOUD_TASKS_PUBLISH_QUEUE="publish-queue"
export FIREBASE_PROJECT_ID="<your-firebase-project-id>"
export CORS_ALLOWED_ORIGINS="https://<your-production-domain>"
```

### Tahap 1 — Validasi Lokal Sebelum Build `[SAFE]`

```bash
npm run build
npm run lint
npx tsx --test server/phase0bInfrastructure.test.ts server/phase0cVerification.test.ts
```

### Tahap 2 — Build & Push Container Images `[PRODUCTION-MUTATING]`

Pastikan Artifact Registry repository `aicliper` sudah dibuat (lihat `docs/gcp-infrastructure.md`).

```bash
gcloud builds submit --tag "${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/aicliper/api:${IMAGE_TAG}" \
  -f infra/Dockerfile.api .

gcloud builds submit --tag "${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/aicliper/render-worker:${IMAGE_TAG}" \
  -f infra/Dockerfile.render-worker .
```

### Tahap 3 — Provision & Migrasi Database Cloud SQL `[PRODUCTION-MUTATING]`

Lihat prosedur lengkap di `docs/cloud-sql-migration.md`:
1. Jalankan Drizzle migration terhadap PostgreSQL (`npx drizzle-kit push --config=src/db/drizzle.config.ts`).
2. Jalankan dry-run staged data migration dari SQLite (`node scripts/migrate-sqlite-to-postgres.ts --dry-run`), lalu eksekusi migrasi non-destruktif (`node scripts/migrate-sqlite-to-postgres.ts`) tanpa menghapus SQLite backup.

### Tahap 4 — Deploy Cloud Run Render Worker Job `[PRODUCTION-MUTATING]`

```bash
envsubst < infra/cloud-run-render-job.yaml | \
  gcloud run jobs replace - --region="${GCP_REGION}" --project="${GCP_PROJECT_ID}"
```

### Tahap 5 — Deploy Cloud Run API Service (Canary / No Traffic Dulu) `[PRODUCTION-MUTATING]`

```bash
export WORKER_DISPATCH_BASE_URL="https://aicliper-api-<hash>.a.run.app"
envsubst < infra/cloud-run-api-service.yaml | \
  gcloud run services replace - --region="${GCP_REGION}" --project="${GCP_PROJECT_ID}"
```

Untuk canary deployment bertahap:
```bash
gcloud run deploy aicliper-api \
  --image="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/aicliper/api:${IMAGE_TAG}" \
  --region="${GCP_REGION}" \
  --no-traffic \
  --tag=canary
```

### Tahap 6 — Verifikasi Live & Canary Traffic Shifting `[PRODUCTION-MUTATING]`

1. Jalankan verifikasi live terhadap canary URL (lihat `docs/production-verification.md`):
   ```bash
   node scripts/verify-live-gcp.ts --api-url="https://canary---aicliper-api-<hash>.a.run.app" --json
   ```
2. Jika seluruh komponen `operational: true`, geser traffic secara bertahap:
   ```bash
   gcloud run services update-traffic aicliper-api --region="${GCP_REGION}" --to-tags=canary=10
   # Pantau error rate & latency 15-30 menit
   gcloud run services update-traffic aicliper-api --region="${GCP_REGION}" --to-tags=canary=50
   # Pantau 30 menit, lalu 100%
   gcloud run services update-traffic aicliper-api --region="${GCP_REGION}" --to-latest
   ```

## Hal yang Dilarang Diubah Saat Deployment

- Jangan menonaktifkan atau mengganti Firebase Authentication, Google Login, atau YouTube OAuth.
- Jangan menaruh service account key JSON atau secret statis di repository, Docker image, atau frontend.
- Jangan mengaktifkan `GCS_REQUIRED=false` di lingkungan `NODE_ENV=production`.
