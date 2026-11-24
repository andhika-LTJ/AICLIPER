# AICLIPER — Rollback Procedure (Fase 0C)

Dokumen ini menjelaskan langkah rollback cepat dan aman apabila terjadi insiden pada tahap canary atau pasca-cutover tanpa menghilangkan data pengguna.

## 1. Rollback Cloud Run API Service (Instan, Tanpa Rebuild) `[PRODUCTION-MUTATING]`

1. Daftar revisi stabil terakhir `[SAFE]`:
   ```bash
   gcloud run revisions list --service=aicliper-api --region="${GCP_REGION}" --project="${GCP_PROJECT_ID}"
   ```
2. Alihkan 100% traffic kembali ke revisi stabil `<PREVIOUS_STABLE_REVISION>` `[PRODUCTION-MUTATING]`:
   ```bash
   gcloud run services update-traffic aicliper-api \
     --region="${GCP_REGION}" \
     --to-revisions="<PREVIOUS_STABLE_REVISION>=100" \
     --project="${GCP_PROJECT_ID}"
   ```

## 2. Pause Antrean Cloud Tasks Saat Gangguan Render Worker `[PRODUCTION-MUTATING]`

Jika render worker mengalami error massal atau lonjakan biaya:
```bash
gcloud tasks queues pause video-render-queue \
  --location="${CLOUD_TASKS_LOCATION}" \
  --project="${GCP_PROJECT_ID}"
```
Setelah worker diperbaiki dan di-deploy ulang ke image stabil:
```bash
gcloud tasks queues resume video-render-queue \
  --location="${CLOUD_TASKS_LOCATION}" \
  --project="${GCP_PROJECT_ID}"
```

## 3. Rollback Cloud Run Render Worker Job Image `[PRODUCTION-MUTATING]`

Deploy ulang manifest `infra/cloud-run-render-job.yaml` dengan `IMAGE_TAG="<PREVIOUS_STABLE_TAG>"`:
```bash
IMAGE_TAG="<PREVIOUS_STABLE_TAG>" envsubst < infra/cloud-run-render-job.yaml | \
  gcloud run jobs replace - --region="${GCP_REGION}" --project="${GCP_PROJECT_ID}"
```

## 4. Database Rollback (Cloud SQL PITR & SQLite Fallback Safety)

- **Jangan pernah** menjalankan `DROP TABLE` atau `TRUNCATE` pada database produksi.
- Selama masa staged migration, salinan SQLite pra-migrasi (`data/klipcast.pre-migration.*.sqlite`) tetap disimpan sebagai arsip read-only.
- Jika terjadi korupsi data serius di Cloud SQL PostgreSQL, gunakan **Point-in-Time Recovery (PITR)** ke instance clone baru terlebih dahulu sebelum memindahkan koneksi `[DESTRUCTIVE / HIGH-IMPACT]`:
  ```bash
  gcloud sql instances clone "${SQL_INSTANCE_NAME}" "${SQL_INSTANCE_NAME}-pitr-recovery" \
    --point-in-time="<YYYY-MM-DDTHH:MM:SSZ>" \
    --project="${GCP_PROJECT_ID}"
  ```
- Verifikasi data pada instance clone, lalu arahkan `SQL_INSTANCE_CONNECTION_NAME` ke instance recovery jika diperlukan.

## 5. Penanganan Stuck Render Job

- Worker otomatis memulihkan job yang terjebak di `running`/`uploading` setelah `WORKER_LOCK_TTL_SECONDS` (default 2100 detik).
- Admin juga dapat membatalkan job bermasalah melalui Admin Control Center (`POST /api/admin/render-jobs/:jobId/cancel`).
