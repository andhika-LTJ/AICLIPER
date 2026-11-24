# AICLIPER — Production Verification Checklist (Fase 0C)

Gunakan checklist ini setiap kali melakukan deployment ke staging atau production sebelum menggeser 100% traffic pengguna.

## 1. Automated Live GCP Verification CLI `[SAFE / OPERATOR-CONFIGURED]`

Jalankan dari lingkungan yang memiliki ADC aktif dan konfigurasi env produksi/staging:

```bash
node scripts/verify-live-gcp.ts --api-url="https://<your-cloud-run-api-url>" --json
```

Verifikasi keluaran JSON harus memenuhi:
- `overallReady: true` dan `verdict: "LIVE_GCP_VERIFIED"`
- `checks.database.operational === true` (Cloud SQL PostgreSQL terkoneksi + tabel Drizzle terverifikasi)
- `checks.adc.authenticated === true`
- `checks.storage.operational === true`, `roundTripChecksumVerified === true`, `tenantIsolationBlocked === true`
- `checks.queue.operational === true` dan `oidcConfigured === true`
- `checks.renderWorkerJob.operational === true`
- `checks.mediaBinaries.ffmpegReady === true` dan `ffprobeReady === true`
- `checks.apiHealth.ok === true` (HTTP `200`)

## 2. Verifikasi Readiness & Observability Endpoint `[SAFE]`

Login sebagai akun admin/super-admin dan panggil:
```bash
curl -sS -H "Authorization: Bearer <FIREBASE_ID_TOKEN>" \
  "https://<your-cloud-run-api-url>/api/v3/readiness" | jq .
```
Pastikan:
- `allCloudResourcesProvisioned === true`
- `database.backend === "postgresql"`
- `storage.mode === "gcs"`
- `queue.mode === "cloud_tasks"` dan `queue.oidcConfigured === true`
- `renderWorker.mode === "cloud_run_jobs"`
- `runtimeResources` menampilkan RSS/Heap/CPU aktual dan `telemetry.recentErrors` kosong.

## 3. Verifikasi Security & Auth Regression (Wajib Tidak Rusak) `[SAFE]`

1. **Firebase Auth & Google Login**: Login pengguna baru & pengguna lama berhasil, token divalidasi di server, tidak ada secret bocor di response frontend.
2. **YouTube OAuth**: Alur OAuth YouTube yang sudah ada tetap berfungsi normal.
3. **Internal Dispatcher Protection**: Request langsung tanpa token OIDC harus ditolak (`401`):
   ```bash
   curl -i -X POST "https://<your-cloud-run-api-url>/internal/dispatch/render" \
     -H "Content-Type: application/json" \
     -d '{"renderJobId":"probe","userUid":"probe","clipId":"probe"}'
   # Harus menghasilkan HTTP 401
   ```
4. **Multi-User Isolation**: Pengguna A tidak dapat mengakses episode, klip, status render, atau object storage milik Pengguna B (`403`/`404`).

## 4. End-to-End Live Render Smoke Test (1080p & 4K) `[PRODUCTION-MUTATING]`

1. Upload video sumber -> pastikan tersimpan di GCS `users/{uid}/projects/{projectId}/uploads/...`.
2. Jalankan analisis AI + active speaker tracking -> pilih klip + intro template -> klik Render 1080p (`balanced_1080p`) dan 4K (`balanced_4k`).
3. Verifikasi transisi lifecycle di DB & Admin Control Center: `queued -> dispatching -> running -> uploading -> completed`.
4. Verifikasi video output dapat diputar & diunduh via Signed URL GCS, durasi/resolusi sesuai FFprobe, dan log Cloud Logging memuat `correlationId` yang sama dari API sampai Worker.
