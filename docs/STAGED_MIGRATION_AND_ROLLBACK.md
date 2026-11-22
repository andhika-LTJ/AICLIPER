# AICLIPER — Staged Production Migration & Rollback Runbook (PHASE 13)

Dokumen ini mendefinisikan langkah migrasi bertahap (**Staged Migration**) dari runtime lokal (`node:sqlite` + local storage + in-process async queue) menuju arsitektur produksi Google Cloud (**Cloud SQL PostgreSQL + Drizzle ORM + Google Cloud Storage + Google Cloud Tasks + Cloud Run Service + Cloud Run Jobs**) **tanpa menghapus data pengguna** dan **tanpa mengubah autentikasi eksisting** (Firebase Auth / Google Login / YouTube OAuth).

---

## 1. Prinsip Keselamatan Migrasi
1. **Zero Auth Rewrite:** Konfigurasi Firebase Auth, verifikasi token Google, dan OAuth YouTube tidak diubah pada tahap mana pun.
2. **Additive Schema Only:** Seluruh migrasi (`001`, `002`, `003`) bersifat non-destruktif (`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN`).
3. **Feature-Flagged Cutover:** Setiap lapisan infrastruktur aktif otomatis hanya jika environment variable produksinya terisi; jika belum terisi, sistem bekerja aman pada fallback lokal secara transparan.

---

## 2. Tahapan Staged Migration

### Stage 1 — Provision & Schema Sync (Cloud SQL PostgreSQL + Drizzle)
1. Provision instance Google Cloud SQL PostgreSQL (rekomendasi region `asia-southeast1` atau `us-central1`).
2. Jalankan migrasi SQL aditif:
   ```bash
   psql -h "$SQL_HOST" -U "$SQL_ADMIN_USER" -d "$SQL_DB_NAME" -f migrations/003_production_readiness_postgres.sql
   ```
   atau sinkronisasi Drizzle Kit:
   ```bash
   npx drizzle-kit push --config=src/db/drizzle.config.ts
   ```
3. Verifikasi seluruh **19 tabel produksi** tersedia (`users`, `projects`, `source_assets`, `transcripts`, `video_analyses`, `clip_candidates`, `speaker_profiles`, `speaker_segments`, `face_tracks`, `camera_tracking_segments`, `camera_tracking_settings`, `intro_templates`, `user_intro_templates`, `intro_template_versions`, `render_jobs`, `render_assets`, `job_events`, `performance_metrics`, `usage_records`).
4. Set environment variables Cloud Run Service (`SQL_HOST`, `SQL_PORT`, `SQL_DB_NAME`, `SQL_USER`, `SQL_PASSWORD`).

### Stage 2 — Permanent Media Storage (Google Cloud Storage)
1. Buat bucket GCS privat (Uniform Bucket-Level Access) dengan lifecycle rule auto-delete untuk prefix `users/*/projects/*/temp/` (mis. 7 hari).
2. Berikan peran `roles/storage.objectAdmin` dan `roles/iam.serviceAccountTokenCreator` (untuk Signed URL v4) ke Service Account Cloud Run.
3. Set `GCS_BUCKET_NAME` dan `GCS_SIGNED_URL_TTL_SEC=3600`.
4. Verifikasi unggahan render baru menulis ke `gs://<bucket>/users/<uid>/projects/<projectId>/renders/...`.

### Stage 3 — Decoupled Queue (Google Cloud Tasks)
1. Buat 3 queue pada region yang sama:
   - `media-ingestion`
   - `ai-analysis`
   - `video-render-dispatch`
2. Set `GCP_PROJECT_ID`, `CLOUD_TASKS_LOCATION`, `WORKER_DISPATCH_BASE_URL`, dan `CLOUD_TASKS_OIDC_SA_EMAIL`.
3. Verifikasi deduplikasi idempotensi aktif (task dengan `idempotencyKey` identik mengembalikan `deduplicated: true`).

### Stage 4 — Dedicated Render Execution (Cloud Run Jobs)
1. Build & push container worker:
   ```bash
   docker build -f infra/Dockerfile.render-worker -t gcr.io/$GCP_PROJECT_ID/aicliper-render-worker:latest .
   docker push gcr.io/$GCP_PROJECT_ID/aicliper-render-worker:latest
   ```
2. Deploy job manifest `infra/cloud-run-render-job.yaml`.
3. Aktifkan `CLOUD_RUN_JOBS_ENABLED=true` dan `CLOUD_RUN_RENDER_JOB_NAME=aicliper-render-worker`.

### Stage 5 — Canary Validation & Full Traffic Cutover
1. Uji 1 klip 1080p Balanced dan 1 klip 4K Balanced end-to-end.
2. Cek endpoint `/api/v3/observability/metrics` (admin) untuk memverifikasi metrik nyata: durasi AI, active speaker scoring, intro compile, FFmpeg render, dan cache hit rate.
3. Pastikan edit intro-only atau camera-only tidak mengunduh ulang sumber (`sourceFingerprint` sama, `renderFingerprint` baru).

---

## 3. Prosedur Rollback Cepat (< 5 Menit)

| Lapisan | Aksi Rollback | Dampak Data |
|---|---|---|
| **Cloud Run Jobs** | Set `CLOUD_RUN_JOBS_ENABLED=false` | Tidak ada kehilangan data; render kembali ke worker API lokal |
| **Cloud Tasks** | Kosongkan `WORKER_DISPATCH_BASE_URL` | Tidak ada kehilangan data; antrean kembali ke async in-process dengan idempotensi lokal |
| **Google Cloud Storage** | Kosongkan `GCS_BUCKET_NAME` | File lama di GCS tetap utuh; aset baru ditulis ke `data/storage/` |
| **Cloud SQL PostgreSQL** | Kosongkan `SQL_HOST` dan arahkan ke revisi Cloud Run sebelumnya | Tidak ada penghapusan tabel/baris (migrasi bersifat aditif) |
| **Database Backup** | Aktifkan Automated Backups + Point-in-Time Recovery (PITR) sebelum cutover | Restore presisi per detik bila terjadi anomali data |
