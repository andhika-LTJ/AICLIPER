# AICLIPER Fase 0B — Least-Privilege IAM & Service Account Matrix

Untuk mencegah eskalasi hak akses di GCP, **jangan** menggunakan satu service account yang sama untuk API, Cloud Tasks, dan Render Worker. Pisahkan menjadi **3 service account** dengan izin minimum:

| Service Account | Dipakai Oleh | Role IAM Wajib (Minimum Privilege) | Tidak Boleh Memiliki |
|---|---|---|---|
| `aicliper-api-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com` | Cloud Run Service (Express API + Internal OIDC Dispatcher) | - `roles/cloudsql.client`<br>- `roles/cloudtasks.enqueuer` (di queue `video-render-queue`, `ai-analysis-queue`, `publish-queue`)<br>- `roles/iam.serviceAccountUser` (HANYA pada `aicliper-tasks-invoker-sa`)<br>- `roles/run.invoker` + `roles/run.developer` (HANYA pada Cloud Run Job `aicliper-render-worker`)<br>- `roles/storage.objectAdmin` (HANYA pada bucket `${GCS_BUCKET_NAME}`)<br>- `roles/secretmanager.secretAccessor` (HANYA pada secret API/DB)<br>- `roles/logging.logWriter` | `roles/owner`, `roles/editor`, `roles/iam.securityAdmin`, atau static access token env |
| `aicliper-tasks-invoker-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com` | Identitas OIDC yang dilampirkan Google Cloud Tasks saat memanggil `POST /api/internal/dispatch/render` | - `roles/run.invoker` (HANYA pada Cloud Run Service `aicliper-api`) | Akses Cloud SQL, GCS, Secret Manager, atau Cloud Run Jobs |
| `aicliper-render-worker-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com` | Cloud Run Job (`aicliper-render-worker` / `workers/renderWorker.ts`) | - `roles/cloudsql.client`<br>- `roles/storage.objectAdmin` (HANYA pada bucket `${GCS_BUCKET_NAME}`)<br>- `roles/secretmanager.secretAccessor` (HANYA pada secret SQL/Gemini)<br>- `roles/logging.logWriter` | `roles/cloudtasks.*`, `roles/run.developer`, `roles/iam.*` |

## Perintah Provisioning IAM (gcloud)

```bash
export GCP_PROJECT_ID="your-gcp-project-id"
export GCP_REGION="asia-southeast2"
export GCS_BUCKET_NAME="aicliper-media-prod"
export API_SERVICE_NAME="aicliper-api"
export RENDER_JOB_NAME="aicliper-render-worker"

# 1. Buat 3 Service Account terpisah
gcloud iam service-accounts create aicliper-api-sa --display-name="AICLIPER API & Dispatcher"
gcloud iam service-accounts create aicliper-tasks-invoker-sa --display-name="AICLIPER Cloud Tasks OIDC Invoker"
gcloud iam service-accounts create aicliper-render-worker-sa --display-name="AICLIPER Render Worker Job"

# 2. Izinkan API SA melampirkan OIDC SA saat membuat Cloud Task
gcloud iam service-accounts add-iam-policy-binding \
  "aicliper-tasks-invoker-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
  --member="serviceAccount:aicliper-api-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"

# 3. Izinkan Cloud Tasks OIDC SA memanggil Cloud Run Service API
gcloud run services add-iam-policy-binding "${API_SERVICE_NAME}" \
  --region="${GCP_REGION}" \
  --member="serviceAccount:aicliper-tasks-invoker-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

# 4. Izinkan API SA memicu eksekusi Cloud Run Job Render Worker (ADC, tanpa static token)
gcloud run jobs add-iam-policy-binding "${RENDER_JOB_NAME}" \
  --region="${GCP_REGION}" \
  --member="serviceAccount:aicliper-api-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/run.developer"

# 5. Scoped GCS bucket access untuk API SA & Render Worker SA
for SA in aicliper-api-sa aicliper-render-worker-sa; do
  gcloud storage buckets add-iam-policy-binding "gs://${GCS_BUCKET_NAME}" \
    --member="serviceAccount:${SA}@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
    --role="roles/storage.objectAdmin"
  gcloud projects add-iam-policy-binding "${GCP_PROJECT_ID}" \
    --member="serviceAccount:${SA}@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
    --role="roles/cloudsql.client"
done
```
