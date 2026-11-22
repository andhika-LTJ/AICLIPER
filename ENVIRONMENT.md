# Panduan Konfigurasi Variabel Lingkungan (`ENVIRONMENT.md`)

Seluruh kredensial sensitif wajib disimpan di variabel lingkungan server (`.env` di lokal atau Secret Manager / Environment Variables di Cloud Run) dan **tidak pernah** dimasukkan ke repository Git atau dikirim ke frontend.

## 1. Variabel Wajib (Server-Side)

| Variabel | Contoh / Default | Wajib? | Deskripsi |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | *(rahasia)* | Ya (untuk fitur AI) | Kunci API Gemini untuk analisis podcast, AI Intro, Repurposing, Hook Generator, Subtitle Polish, dan Asisten Episode. Hanya dibaca di backend. |
| `PORT` | `3000` | Opsional | Port HTTP yang didengarkan oleh Express (`0.0.0.0:$PORT`). Cloud Run mengisi variabel ini secara otomatis. |
| `NODE_ENV` | `development` / `production` | Opsional | Saat `production`, server menyajikan berkas statis hasil build `dist/` tanpa Vite dev middleware. |

## 2. Keamanan, Autentikasi & RBAC

| Variabel | Default | Deskripsi |
| --- | --- | --- |
| `FIREBASE_PROJECT_ID` | Diambil dari `firebase-applet-config.json` | Project ID Firebase untuk memverifikasi klaim `aud` dan `iss` pada Firebase ID Token di backend. |
| `SUPER_ADMIN_EMAILS` | `yogandhika2132@gmail.com` | Daftar email (dipisahkan koma) yang otomatis dipromosikan menjadi `super_admin` saat login Google terverifikasi. |
| `ADMIN_EMAILS` | *(kosong)* | Daftar email (dipisahkan koma) yang otomatis diberi peran `admin` saat login Google terverifikasi. |
| `CORS_ALLOWED_ORIGINS` | *(same-origin / dev localhost)* | Daftar origin yang diizinkan (dipisahkan koma), misalnya `https://klipcast.example.com,https://app.example.com`. |
| `WEBHOOK_ALLOWED_DOMAINS` | *(kosong = semua domain publik aman)* | Allowlist domain tujuan webhook (dipisahkan koma), misalnya `hooks.zapier.com,hook.eu1.make.com`. Alamat lokal, IP privat, dan metadata cloud selalu diblokir secara otomatis. |
| `STREAM_TOKEN_SECRET` | *(acak per-boot jika kosong)* | Rahasia HMAC-SHA256 untuk menandatangani token streaming SSE render (`?st=...`). Disarankan diisi string acak 32+ karakter di produksi agar token tetap konsisten saat restart. |

## 3. Database, Storage & Batas Resource

| Variabel | Default | Deskripsi |
| --- | --- | --- |
| `KLIPCAST_DB_PATH` | `data/klipcast.sqlite` | Path file database SQLite relasional ACID (mode WAL). |
| `DATABASE_URL` | *(opsional, untuk migrasi PostgreSQL)* | Connection string PostgreSQL apabila Anda memigrasikan deployment ke server PostgreSQL eksternal menggunakan `/migrations/001_initial_postgres.sql`. |
| `MAX_UPLOAD_MB` | `250` | Batas ukuran maksimal unggahan video per file (dalam MB). |
| `MAX_CONCURRENT_UPLOADS` | `2` | Batas maksimal unggahan video paralel pada server (1–5). |
| `MAX_CONCURRENT_RENDERS` | `2` | Batas jumlah proses render FFmpeg bersamaan pada worker server. |
| `RENDER_JOB_TIMEOUT_MS` | `600000` (10 menit) | Batas waktu eksekusi maksimal per render FFmpeg sebelum dibatalkan otomatis demi mencegah proses menggantung. |

## 4. Aset CDN & Optimasi Build (Opsional)

| Variabel | Default | Deskripsi |
| --- | --- | --- |
| `VITE_ASSET_CDN_BASE_URL` | *(kosong = aset lokal terkompresi)* | Base URL CDN/Cloud Storage (contoh: `https://storage.googleapis.com/bucket-anda`) untuk memuat aset gambar dari CDN saat runtime. |
| `ASSET_CDN_BASE_URL` | *(kosong)* | Alias server-side dari base URL CDN di atas. |
| `EXCLUDE_LOCAL_CDN_ASSETS` | `false` | Jika `true` (bersama `VITE_ASSET_CDN_BASE_URL`), aset gambar lokal yang sudah diunggah ke CDN tidak disalin ulang ke `dist/`. |

## 5. Kredensial Publik vs Rahasia (Penting!)

- **Aman di Frontend (Publik)**:
  - `firebase-applet-config.json` (`apiKey`, `authDomain`, `projectId`, `appId`) adalah *public client config* resmi Firebase Web SDK untuk menampilkan popup Google Sign-In. Keamanan tetap ditegakkan oleh verifikasi kriptografis token di backend.
  - Variabel berawalan `VITE_*` akan tertanam pada bundle browser—**JANGAN PERNAH** menaruh rahasia API Key, password database, atau service account pada variabel `VITE_*`.
- **Wajib Rahasia (Hanya Backend)**:
  - `GEMINI_API_KEY`, `STREAM_TOKEN_SECRET`, `DATABASE_URL`, `webhookSecretHeader` milik pengguna (disimpan di database dan selalu disensor dari respons API), serta `cookies.txt` server (hanya dikelola Admin/Super Admin).

## 6. Prasyarat Manual untuk Integrasi Pihak Ketiga Eksternal

Beberapa integrasi lanjutan memerlukan pendaftaran aplikasi resmi di luar aplikasi ini:
- **YouTube Direct Upload (Sudah Berfungsi Penuh)**: Menggunakan Google OAuth scope `youtube.upload` melalui Firebase Google Sign-In. Pengguna hanya perlu mengaktifkan *YouTube Data API v3* di Google Cloud Console milik proyek Firebase terkait.
- **Auto-Publish TikTok / Instagram Reels / Facebook Reels / LinkedIn / X**: Memerlukan persetujuan aplikasi bisnis (*App Review*) dan kredensial OAuth resmi dari masing-masing platform (TikTok Content Posting API, Meta Graph API, LinkedIn Marketing API, X API v2). Sebelum kredensial tersebut dipasang, KlipCast menyediakan alur **Webhook n8n/Make/Zapier**, **Unduh MP4 + .SRT/.VTT**, **Salin Caption & Hashtag**, dan **Kalender Konten**.
- **Pembayaran Otomatis Langganan (Midtrans / Xendit / Stripe)**: Paket langganan (`free`, `starter`, `pro`, `business`) dan penegakan kuota sudah aktif sepenuhnya di database dan backend; integrasi gerbang pembayaran otomatis memerlukan API key dan webhook pembayaran resmi dari penyedia payment gateway pilihan Anda.
