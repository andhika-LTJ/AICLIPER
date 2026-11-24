# AICLIPER — GCP Infrastructure & Least-Privilege IAM Guide (Fase 0C)

Dokumen ini merinci seluruh resource Google Cloud yang wajib tersedia untuk AICLIPER produksi beserta peran IAM berprinsip least privilege. Tidak ada service account key JSON statis yang dibuat — seluruh layanan menggunakan **Application Default Credentials (ADC)** dan **OIDC**.

## 1. Enable Required Google Cloud APIs `[PRODUCTION-MUTATING]`

```bash
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  storage.googleapis.com \
  cloudtasks.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com \
  --project="${GCP_PROJECT_ID}"
```

## 2. Artifact Registry `[PRODUCTION-MUTATING]`

```bash
gcloud artifacts repositories create aicliper \
  --repository-format=docker \
  --location="${GCP_REGION}" \
  --description="AICLIPER API and Render Worker container images" \
  --project="${GCP_PROJECT_ID}"
```

## 3. Service Accounts (Least Privilege) `[PRODUCTION-MUTATING]`

| Service Account | Dipakai Oleh | Role Minimal |
|---|---|---|
| `aicliper-api-sa` | Cloud Run Service (`aicliper-api`) | `roles/cloudsql.client`, `roles/storage.objectAdmin` (bucket-scoped), `roles/cloudtasks.enqueuer`, `roles/run.invoker` (job-scoped), `roles/iam.serviceAccountUser` (pada `aicliper-tasks-invoker-sa`), `roles/secretmanager.secretAccessor` (secret-scoped), `roles/logging.logWriter` |
| `aicliper-render-worker-sa` | Cloud Run Job (`aicliper-render-worker`) | `roles/cloudsql.client`, `roles/storage.objectAdmin` (bucket-scoped), `roles/secretmanager.secretAccessor` (secret-scoped), `roles/logging.logWriter` |
| `aicliper-tasks-invoker-sa` | Cloud Tasks OIDC Token Generator | `roles/run.invoker` (hanya pada service `aicliper-api`) |

```bash
for SA in aicliper-api-sa aicliper-render-worker-sa aicliper-tasks-invoker-sa; do
  gcloud iam service-accounts create "${SA}" \
    --display-name="${SA}" \
    --project="${GCP_PROJECT_ID}"
done
```

## 4. Google Cloud Storage Bucket & Lifecycle `[PRODUCTION-MUTATING]`

- Bucket **private** dengan **Uniform Bucket-Level Access (UBLA)** dan **Public Access Prevention (`enforced`)**.
- Struktur path wajib di kode (`server/services/gcsStorageService.ts`):
  - `users/{uid}/projects/{projectId}/uploads/{filename}`
  - `users/{uid}/projects/{projectId}/renders/{filename}`
  - `users/{uid}/projects/{projectId}/thumbnails/{filename}`
  - `users/{uid}/projects/{projectId}/subtitles/{filename}`
  - `users/{uid}/projects/{projectId}/temp/{filename}`

```bash
gcloud storage buckets create "gs://${GCS_BUCKET_NAME}" \
  --project="${GCP_PROJECT_ID}" \
  --location="${GCP_REGION}" \
  --uniform-bucket-level-access \
  --public-access-prevention

# Bind IAM hanya pada bucket ini (bukan project-wide)
gcloud storage buckets add-iam-policy-binding "gs://${GCS_BUCKET_NAME}" \
  --member="serviceAccount:aicliper-api-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"

gcloud storage buckets add-iam-policy-binding "gs://${GCS_BUCKET_NAME}" \
  --member="serviceAccount:aicliper-render-worker-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
```

Rekomendasi lifecycle rule (hapus prefix `temp/` setelah 2 hari):
```json
{
  "lifecycle": {
    "rule": [
      {
        "action": { "type": "Delete" },
        "condition": { "age": 2, "matchesPrefix": ["users/"], "matchesSuffix": [".tmp"] }
      }
    ]
  }
}
```

## 5. Secret Manager `[PRODUCTION-MUTATING]`

Simpan secret hanya di Secret Manager (bukan `.env` commit atau env plaintext):
- `aicliper-sql-password` (`SQL_PASSWORD`)
- `aicliper-gemini-api-key` (`GEMINI_API_KEY`)
- `aicliper-stream-token-secret` (`STREAM_TOKEN_SECRET`)

```bash
for SECRET in aicliper-sql-password aicliper-gemini-api-key aicliper-stream-token-secret; do
  gcloud secrets create "${SECRET}" --replication-policy="automatic" --project="${GCP_PROJECT_ID}"
done
```

Berikan akses `roles/secretmanager.secretAccessor` per-secret hanya ke service account yang memerlukannya (`aicliper-api-sa` dan `aicliper-render-worker-sa`).

## 6. Cloud SQL PostgreSQL `[PRODUCTION-MUTATING]`

Lihat `docs/cloud-sql-migration.md` untuk konfigurasi instance, automated backups, PITR, connection pooling, dan migrasi schema.

## 7. Cloud Tasks Queues `[PRODUCTION-MUTATING]`

Lihat `docs/cloud-tasks-oidc.md` untuk pembuatan antrean (`media-ingestion`, `ai-analysis-queue`, `video-render-queue`, `publish-queue`), retry backoff, dan verifikasi OIDC.
