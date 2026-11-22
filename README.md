# KlipCast / AICLIPER — Platform AI Podcast & Video Content Creation Studio

KlipCast (AICLIPER) adalah platform pembuatan konten pendek berbasis AI untuk kreator podcast dan video Indonesia. Aplikasi ini mengubah video YouTube berdurasi panjang maupun rekaman video lokal menjadi klip vertikal/persegi siap tayang (`9:16`, `4:5`, `1:1`) lengkap dengan pemotongan FFmpeg nyata, AI Intro/Hook Overlay yang bisa diedit manual, subtitle `.SRT`/`.VTT`, studio repurposing multi-platform, serta pusat kontrol admin multi-user yang aman.

## Fitur Utama

- **Keamanan & Multi-User (RBAC)**:
  - Autentikasi Google melalui Firebase Auth dengan verifikasi kriptografis RS256 ID Token di server (`Authorization: Bearer <token>`), validasi `iss`, `aud`, `exp`, `auth_time`, serta pencabutan sesi (`POST /api/auth/logout`).
  - Tiga tingkat peran yang diverifikasi sepenuhnya di backend: `super_admin`, `admin`, dan `user`.
  - Isolasi data ketat per pengguna (`user_uid`), proteksi SSRF untuk webhook & direct URL, validasi magic-byte upload video, proteksi path traversal, rate limiting, security headers, dan redaksi rahasia (`webhookSecretHeader` tidak pernah dikirim kembali ke frontend).
- **Database Relasional Multi-User & Migrasi Aman**:
  - Database relasional ACID menggunakan SQLite native Node.js (`node:sqlite`, WAL mode, foreign keys, 13 tabel lengkap) disertai skema DDL PostgreSQL produksi (`/migrations/001_initial_postgres.sql`).
  - Migrasi otomatis dan idempoten dari file legacy `data/clipper-store.json` tanpa mereset atau menghapus data lama.
  - Mendukung ekspor data pribadi (JSON), soft delete, penghapusan data akun oleh pengguna sendiri, dan snapshot backup database oleh Super Admin.
- **Mesin Render FFmpeg Persisten & Anti-Drift**:
  - Antrean render persisten (`render_jobs`) dengan status pemulihan saat server restart, batas konkurensi, timeout proses, dan pembersihan file sementara otomatis.
  - Dukungan rasio `9:16` (Full Frame, Split 2 Speaker, 16:9 Fit), `4:5` (Instagram/Facebook Feed), dan `1:1` (Square), normalisasi audio `-14 LUFS`, watermark kustom, serta AI Intro Card + editor posisi/font manual.
  - Streaming SSE ber-token (`?st=...`) dan unduhan MP4 chunked `4 MiB` kompatibel proxy Cloud Run.
- **Analisis Gemini AI & AI Content Studio**:
  - Ekstraksi momen potensial lengkap dengan **Estimasi Kualitas Konten** 7 dimensi berbobot transparan, bab episode (*chapters*), dan kutipan utama (*key quotes*).
  - **AI Content Studio**: Repurposing 6 platform (YouTube Shorts, TikTok, Instagram Reels, Facebook Reels, LinkedIn, X/Twitter), Generator Hook 6 gaya, **Thumbnail Studio** berbasis HTML5 `<canvas>` (`16:9`, `9:16`, `1:1` dengan ekspor `.PNG`/`.JPG`), Subtitle Studio (poles AI + editor inline + `.SRT`/`.VTT`), dan Asisten AI berbasis konteks episode.
- **AICLIPER 2.0 — Ekosistem Produksi Konten Lengkap**:
  - **6 Pendekatan Klip AI**: `Edukatif`, `Storytelling`, `Motivasi`, `Informatif`, `Hiburan`, `Promosi` dengan skor kualitas 7 dimensi tersimpan.
  - **Smart Video Editor Non-Destruktif**: Timeline multi-track (`Video`, `Audio`, `Intro & Text`, `Subtitle Cues`), zoom `1x–4x`, scrub playhead, Trim/Split/Move/Delete, Undo/Redo, overlay Safe-Area Shorts/Reels, 4 preset gaya subtitle, dan preset ekspor FFmpeg (`1080p`/`4K`, `24`/`30`/`60` FPS, `-14 LUFS`) tersimpan di database.
  - **AI Content Studio 2.0 & Persistent AI Content Advisor**: Generator konten kustom penuh (Bahasa, Platform, Tone, Audiens, Tujuan, Panjang Teks, Gaya Penulisan) dengan riwayat persisten, serta chat AI Content Advisor tersimpan per episode.
  - **Analitik Konten Real & Pustaka Template**: Metrik 100% nyata dari SQLite + sinkronisasi statistik YouTube Data API v3 + rekomendasi AI Growth tergrounding (tanpa angka fiktif), serta Pustaka Template (`subtitle`, `intro`, `thumbnail`, `export`).
  - **4 Tema UI & Admin Control Center 2.0**: Tema `Minimal Light`, `Dark Studio`, `Creator Neon`, dan `Professional`; manajemen Multi-Workspace, Pengaturan Sistem & Paket Langganan dinamis (khusus Super Admin), serta abstraksi `PaymentProvider` siap integrasi Midtrans/Xendit/Stripe.

## Arsitektur Singkat

```text
React 19 + Vite + Tailwind CSS (src/)
   │  Authorization: Bearer <Firebase ID Token>
   │  X-YouTube-Access-Token (unggah YouTube Direct & sinkronisasi analitik)
   ▼
Express + TypeScript Server (server.ts)
   ├── server/authMiddleware.ts      (Verifikasi JWT Google/Firebase + RBAC)
   ├── server/security.ts            (SSRF guard, rate limit, headers, magic-byte)
   ├── server/db.ts                  (SQLite ACID 22 tabel + migrasi 001/002 + backup)
   ├── server/routes/v2Routes.ts     (Workspaces, Editor, Templates, Studio 2.0, Advisor, Analytics, Billing, Admin 2.0)
   ├── server/repositories/          (v2Repository.ts — CRUD terisolasi per user_uid)
   ├── server/services/              (analyticsService.ts, paymentProvider.ts)
   ├── server/validators/            (schemas.ts — validasi Zod terpusat)
   ├── server/utils/                 (timelineMath.ts — logika timeline non-destruktif murni)
   ├── server/quotaService.ts        (Kuota paket + estimasi biaya Gemini)
   ├── server/renderJobManager.ts    (Antrean render persisten + SSE bertoken)
   ├── server/videoClipper.ts        (Pipeline FFmpeg + ASS subtitle + normalisasi LUFS)
   ├── server/youtubeAnalyzer.ts     (Analisis Gemini + 6 pendekatan klip + skor 7 dimensi)
   ├── server/aiStudio.ts            (Custom Studio 2.0, Repurpose, Hooks, Subtitle Polish, Advisor, Growth)
   └── server/systemMonitor.ts       (Metrik sistem & kesehatan server nyata)
```

## Dokumentasi Lengkap

| Dokumen | Deskripsi |
| --- | --- |
| [`docs/AICLIPER_2_0_AUDIT_AND_ROADMAP.md`](./docs/AICLIPER_2_0_AUDIT_AND_ROADMAP.md) | Audit lengkap Phase 0 dan peta jalan arsitektur AICLIPER 2.0 |
| [`INSTALLATION.md`](./INSTALLATION.md) | Panduan instalasi lokal, prasyarat FFmpeg/yt-dlp/Node.js, dan verifikasi tes |
| [`ENVIRONMENT.md`](./ENVIRONMENT.md) | Daftar lengkap variabel lingkungan (rahasia backend vs konfigurasi publik) |
| [`DATABASE_MIGRATION.md`](./DATABASE_MIGRATION.md) | Skema 22 tabel, migrasi non-destruktif 001 & 002, backup, dan transisi PostgreSQL |
| [`SECURITY.md`](./SECURITY.md) | Arsitektur keamanan, RBAC, SSRF, validasi upload, dan penanganan sesi |
| [`API_DOCUMENTATION.md`](./API_DOCUMENTATION.md) | Referensi endpoint REST API (`/api/*` & `/api/v2/*`), autentikasi, dan kode error |
| [`DEPLOYMENT.md`](./DEPLOYMENT.md) | Panduan build produksi, kontrol ukuran bundle (<250 MB), dan Cloud Run |
| [`ADMIN_GUIDE.md`](./ADMIN_GUIDE.md) | Panduan operasional Admin & Super Admin (peran, paket, sistem, audit log, backup) |

## Menjalankan Secara Cepat

```bash
npm install
cp .env.example .env
# Isi GEMINI_API_KEY di file .env
npm run dev
```

Aplikasi berjalan di `http://localhost:3000`.

## Pengujian & Verifikasi

```bash
# Jalankan seluruh 100 unit, security, RBAC, DB & AICLIPER 2.0 API tests
npx tsx --test scripts/*.test.ts server/*.test.ts src/utils/*.test.ts

# Typecheck / lint & production build
npm run lint
npm run build
```
