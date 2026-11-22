# Panduan Instalasi — KlipCast / AICLIPER

Dokumen ini menjelaskan langkah instalasi dan pengujian KlipCast secara lokal maupun di server Linux.

## 1. Prasyarat Sistem

| Komponen | Versi Minimum | Kegunaan |
| --- | --- | --- |
| **Node.js** | `v22.5+` (disarankan `v22.22+`) | Runtime server TypeScript ESM & modul built-in `node:sqlite` |
| **npm** | `v10+` | Manajemen paket dependensi |
| **FFmpeg & FFprobe** | `v5+` (tersedia via `ffmpeg-static` atau binary sistem) | Pemotongan video, pembakaran subtitle ASS, normalisasi audio `-14 LUFS` |
| **yt-dlp** (opsional) | Terbaru | Mengunduh stream video YouTube saat memotong langsung dari URL YouTube |

> **Catatan**: Jika `yt-dlp` tidak tersedia atau YouTube meminta verifikasi bot, pengguna tetap dapat menggunakan fitur **Unggah Video Lokal** atau **Direct MP4 URL** tanpa kendala.

## 2. Kloning & Instalasi Dependensi

```bash
git clone https://github.com/andhika-LTJ/AICLIPER.git
cd AICLIPER
npm install
```

## 3. Konfigurasi Lingkungan

Salin berkas templat konfigurasi:

```bash
cp .env.example .env
```

Minimal isi `GEMINI_API_KEY` di `.env` agar fitur Analisis Podcast AI dan AI Content Studio aktif. Lihat [`ENVIRONMENT.md`](./ENVIRONMENT.md) untuk daftar lengkap seluruh variabel.

### Konfigurasi Firebase Authentication (Publik Client)
Pastikan berkas `/firebase-applet-config.json` berisi konfigurasi proyek Firebase Web Anda (`apiKey`, `authDomain`, `projectId`, `appId`) dan aktifkan **Google Sign-In** pada konsol Firebase Authentication. Tambahkan domain lokal (`localhost`) dan domain produksi Anda ke *Authorized domains*.

## 4. Menjalankan Mode Pengembangan

```bash
npm run dev
```

Perintah ini menjalankan `tsx server.ts` pada port `3000` yang sekaligus melayani frontend Vite dan seluruh endpoint `/api/*`.

- URL Aplikasi: `http://localhost:3000`
- Health Check: `http://localhost:3000/api/health`
- Mode Pratinjau UI Tanpa Login (khusus eksplorasi demo): `http://localhost:3000/?autostart=1`

## 5. Verifikasi Pengujian & Build Produksi

```bash
# 1. Jalankan seluruh automated test (keamanan, RBAC, isolasi data, DB, AI, FFmpeg)
npx tsx --test scripts/*.test.ts server/*.test.ts src/utils/*.test.ts

# 2. Validasi TypeScript & lint
npm run lint

# 3. Build bundle produksi + optimasi aset gambar otomatis
npm run build

# 4. Uji server produksi persis seperti lingkungan Cloud Run
NODE_ENV=production PORT=3000 node server.ts
```

## 6. Pemecahan Masalah Umum

- **Error `node:sqlite` tidak ditemukan**: Pastikan versi Node.js Anda minimal `v22.5.0` (`node -v`).
- **Render video gagal mengunduh dari YouTube**: Gunakan tombol **Unggah Video Lokal** di Studio Klip, atau bagi Super Admin/Admin, unggah `cookies.txt` terautentikasi melalui tab Otomasi.
- **Error `401 Unauthorized` pada `/api/*`**: Semua endpoint privat memerlukan header `Authorization: Bearer <Firebase ID Token>`. Pastikan Anda telah masuk menggunakan akun Google di aplikasi.
