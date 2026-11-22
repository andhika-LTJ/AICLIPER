# Panduan Deployment & Optimasi Produksi (`DEPLOYMENT.md`)

KlipCast dirancang agar berjalan mulus di **Google Cloud Run**, VPS Linux, maupun container Docker standar dengan ukuran bundle produksi jauh di bawah batas **250 MB**.

## 1. Alur Build & Optimasi Ukuran Bundle

Perintah `npm run build` menjalankan dua langkah berurutan:
1. **Kompresi Aset Gambar Otomatis (`scripts/optimize-assets.mjs`)**: Mengompresi aset gambar statis di `public/` ke WebP/JPEG ringan secara otomatis sebelum bundling.
2. **Build Vite Produksi (`vite build`)**: Menghasilkan bundle statis bersih di `dist/` tanpa source map produksi yang membengkakkan ukuran container.

Cek ukuran hasil build:
```bash
npm run build
du -sh dist
```
Ukuran folder `dist/` berada di kisaran **< 1 MB** (jauh di bawah batas 250 MB).

## 2. Pengaturan CDN Opsional untuk Aset Besar

Jika Anda menyimpan gambar atau media besar di Google Cloud Storage / Cloudflare R2 / S3 CDN:
1. Unggah aset statis ke bucket publik Anda.
2. Setel variabel lingkungan saat build dan runtime:
   ```bash
   VITE_ASSET_CDN_BASE_URL=https://storage.googleapis.com/nama-bucket-anda
   ASSET_CDN_BASE_URL=https://storage.googleapis.com/nama-bucket-anda
   EXCLUDE_LOCAL_CDN_ASSETS=true
   ```
3. Helper `resolveAssetUrl()` akan otomatis mengarahkan jalur aset lokal ke URL CDN.

## 3. Menjalankan Server Produksi (`node server.ts`)

Konfigurasi `package.json`:
```json
{
  "scripts": {
    "build": "node scripts/optimize-assets.mjs && vite build",
    "start": "node server.ts"
  }
}
```

> **Catatan Penting Kompatibilitas Node v22 Native ESM**:
> Seluruh impor relatif yang diakses oleh `server.ts` wajib menyertakan ekstensi `.ts` eksplisit (mis. `./server/db.ts`, `../src/utils/assetUrl.ts`) agar `node server.ts` di Cloud Run dapat langsung menyala tanpa bundler backend tambahan.

Uji boot produksi secara lokal sebelum deploy:
```bash
npm run build
NODE_ENV=production PORT=3099 node server.ts
# Verifikasi di terminal lain:
curl -i http://127.0.0.1:3099/api/health       # Harus 200 OK
curl -i http://127.0.0.1:3099/api/state        # Harus 401 Unauthorized
```

## 4. Rekomendasi Konfigurasi Cloud Run

- **Port Container**: `3000` (server otomatis membaca `process.env.PORT || 3000` dan bind ke `0.0.0.0`).
- **Memory & CPU**: Minimal **2 GiB RAM / 2 vCPU** apabila menjalankan render video FFmpeg 1080p/4K secara aktif (`MAX_CONCURRENT_RENDERS=2`).
- **Request Timeout**: Setel minimal `300s`–`600s` agar streaming SSE render video dan unggahan MP4 besar tidak terputus lebih awal.
- **Persistent Volume / Database Produksi**:
  - Cloud Run bersifat stateless di disk lokal secara default. Untuk penyimpanan permanen lintas revisi, pasang **Cloud Storage FUSE / Persistent Volume** pada folder `data/`, atau migrasikan skema ke PostgreSQL terkelola menggunakan `/migrations/001_initial_postgres.sql`.
- **Variabel Lingkungan Produksi Wajib**:
  - `NODE_ENV=production`
  - `GEMINI_API_KEY` (melalui Secret Manager)
  - `STREAM_TOKEN_SECRET` (string acak 32+ karakter melalui Secret Manager)
  - `SUPER_ADMIN_EMAILS` (email pengelola utama)
  - `CORS_ALLOWED_ORIGINS` (domain publik aplikasi Anda)
  - `WEBHOOK_ALLOWED_DOMAINS` (opsional, batasi domain otomasi terpercaya)

## 5. Daftar Periksa Pra-Deploy

- [ ] `npx tsx --test scripts/*.test.ts server/*.test.ts src/utils/*.test.ts` lulus 100%.
- [ ] `npm run lint` dan `npm run build` bebas error.
- [ ] Domain produksi sudah ditambahkan ke Firebase Authentication -> **Authorized domains**.
- [ ] `GEMINI_API_KEY` dan `STREAM_TOKEN_SECRET` sudah dipasang di Secret Manager, tidak ada file `.env` di Git.
- [ ] Endpoint `/api/health` merespons `200 OK` dan `/api/state` tanpa token merespons `401`.
