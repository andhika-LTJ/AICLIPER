# AICLIPER — Cloud Run Render Worker Architecture & Operations (Fase 0C)

Rendering video panjang, FFmpeg filter graph, active speaker framing, intro studio, subtitle burn-in, serta output **1080p dan 4K** dijalankan secara terisolasi pada **Cloud Run Jobs** (`workers/renderWorker.ts`), bukan di proses request HTTP utama API.

## 1. Container Minimal & Signal Handling

- Dockerfile: `infra/Dockerfile.render-worker`
  - Base image `node:22-slim` + `ffmpeg`, `ffprobe`, `fontconfig`, `fonts-dejavu-core`, `fonts-liberation`, `fonts-noto-core`.
  - Lockfile-safe install: `npm install --omit=dev --no-audit --no-fund` (tidak bergantung pada `package-lock.json` yang tidak ada di repo).
  - Hanya menyalin modul runtime backend/worker (`workers/`, `server/`, `src/db/`, `src/types/`, `src/utils/`, `src/data/`). Kode React/UI dan aset statis frontend dikecualikan.
  - Berjalan sebagai non-root user `node` dengan `STOPSIGNAL SIGTERM`.
- Manifest: `infra/cloud-run-render-job.yaml`

## 2. Alokasi Resource Balanced Strategy (CPU-Only)

| Profil Render | Resolusi Target | CPU | Memori | Timeout Job | Catatan |
|---|---|---|---|---|---|
| `balanced_1080p` (default) | 1080x1920 (9:16) | 4 vCPU | 8 GiB | 1800s (30m) | Preset `veryfast`, CRF 20, anti-upscale aktif |
| `balanced_4k` | 2160x3840 (9:16) | 8 vCPU | 16 GiB | 3600s (60m) | Untuk workload 4K berat, naikkan `limits` di manifest |

## 3. Siklus Eksekusi Worker & Perlindungan Kegagalan

1. **Bootstrap & Validasi Identitas**: Membaca `AICLIPER_RENDER_JOB_ID`, `AICLIPER_USER_UID`, `AICLIPER_CLIP_ID`, `AICLIPER_CORRELATION_ID` yang disuntikkan via Cloud Run Jobs API `containerOverrides.env`.
2. **Idempotent Atomic Claim Lock + Stale Lock Recovery**:
   - Mencegah dua eksekusi worker memproses `renderJobId` yang sama secara bersamaan.
   - Jika worker sebelumnya mengalami hard crash (`SIGKILL`/OOM) dan meninggalkan status `running`/`uploading` melebihi `WORKER_LOCK_TTL_SECONDS` (default `2100` detik = 35 menit, di atas job timeout 30 menit), worker baru otomatis mengambil alih lock secara atomik (`recoveredStaleLock: true`) dan menaikkan `retry_count`.
3. **Hydration dari GCS + Verifikasi Integritas**: Mengunduh video sumber dari `users/{uid}/projects/{projectId}/...` ke `/tmp/aicliper-worker-*` dengan retry terkontrol dan verifikasi tenant prefix.
4. **FFmpeg Render + FFprobe Verification**: Menjalankan `renderClipMp4()` lalu memverifikasi output memakai `probeVideoMeta()` (resolusi, durasi > 0, codec video H.264, stream audio).
5. **Upload GCS + SHA-256 Checksum**: Mengunggah MP4 ke GCS dengan exponential backoff retry (maks 3 percobaan untuk error 429/5xx/network) dan menghitung SHA-256.
6. **Atomic DB Finalization & Output Preservation**:
   - Menandai job `completed` di PostgreSQL/SQLite dan memotong kuota tepat sekali (`markRenderJobQuotaConsumed`).
   - Jika upload GCS sudah berhasil namun penulisan akhir ke DB gagal, URI GCS dicatat (`preservedOutputGcsUri`) pada structured log agar tidak terjadi kehilangan aset diam-diam.
7. **Graceful `SIGTERM` / `SIGINT` Shutdown**:
   - Worker memasang `AbortController` pada sinyal `SIGTERM`/`SIGINT`, meneruskan abort ke FFmpeg, menandai job `failed` (`WORKER_SIGTERM_INTERRUPTED`) agar aman untuk retry, membersihkan `/tmp/aicliper-worker-*`, dan menutup pool PostgreSQL sebelum exit.

## 4. Uji Eksekusi Manual Cloud Run Job `[PRODUCTION-MUTATING]`

```bash
gcloud run jobs execute aicliper-render-worker \
  --region="${GCP_REGION}" \
  --update-env-vars="AICLIPER_RENDER_JOB_ID=<existing-job-id>,AICLIPER_USER_UID=<uid>,AICLIPER_CLIP_ID=<clip-id>,AICLIPER_CORRELATION_ID=corr_manual_smoke" \
  --wait
```
