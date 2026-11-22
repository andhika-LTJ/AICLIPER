# Referensi REST API — KlipCast / AICLIPER (`API_DOCUMENTATION.md`)

Seluruh endpoint berada di bawah prefix `/api/*`.

## 1. Konvensi Autentikasi & Header

- **Endpoint Publik**: Hanya `GET /api/health`.
- **Endpoint Privat**: Wajib menyertakan header:
  ```http
  Authorization: Bearer <Firebase_ID_Token>
  X-Requested-With: XMLHttpRequest
  ```
- **Unggah Langsung ke YouTube**: Selain `Authorization`, kirim header tambahan:
  ```http
  X-YouTube-Access-Token: <Google_OAuth_Access_Token>
  ```
- **Streaming SSE Progres Render**: Gunakan query parameter token bertanda tangan `?st=<streamToken>` yang diperoleh dari `POST /api/clips/:clipId/render-jobs`.

### Kode Status Standar
- `200` / `201` / `202`: Permintaan berhasil / job antrean diterima.
- `400`: Validasi input gagal, URL diblokir proteksi SSRF, atau file bukan video valid.
- `401`: Token tidak ada, tidak valid, kedaluwarsa, atau sesi sudah dicabut via logout.
- `403`: Akses peran ditolak (`admin`/`super_admin`), akun ditangguhkan, atau kuota paket habis (`code: "QUOTA_EXCEEDED"`).
- `404`: Resource tidak ditemukan atau bukan milik pengguna yang sedang masuk.
- `429`: Rate limit terlampaui.

---

## 2. Kesehatan Server & Autentikasi

| Method | Endpoint | Akses | Deskripsi |
| --- | --- | --- | --- |
| `GET` | `/api/health` | Publik | Cek status server, ketersediaan `GEMINI_API_KEY`, dan kesiapan FFmpeg/yt-dlp. |
| `GET` | `/api/auth/me` | User | Verifikasi token, mengembalikan profil, peran (`user`/`admin`/`super_admin`), kuota bulanan, dan jumlah notifikasi belum dibaca. |
| `POST` | `/api/auth/logout` | User | Mencabut sesi aktif di server (`session_revoked_before = now`). |

## 3. Profil, Dashboard, Notifikasi & Privasi Data

| Method | Endpoint | Akses | Deskripsi |
| --- | --- | --- | --- |
| `GET` | `/api/state` | User | Memuat state studio terisolasi milik pengguna (episode, klip, otomasi tanpa secret, kuota, notifikasi). |
| `GET` | `/api/dashboard` | User | Ringkasan KPI nyata, riwayat render terakhir, dan kuota bulanan pengguna. |
| `PATCH` | `/api/me/profile` | User | Memperbarui nama tampilan, niche kreator, tema (`light`/`dark`), atau status onboarding. |
| `GET` | `/api/notifications` | User | Mengambil daftar notifikasi pengguna. |
| `POST` | `/api/notifications/:id/read` | User | Menandai satu notifikasi sebagai telah dibaca. |
| `POST` | `/api/notifications/read-all` | User | Menandai semua notifikasi pengguna telah dibaca. |
| `GET` | `/api/me/export` | User | Mengunduh ekspor JSON seluruh data milik pengguna. |
| `DELETE` | `/api/me/data` | User | Menghapus permanen seluruh episode, klip, log, dan riwayat milik pengguna sendiri. |

## 4. Episode, Analisis AI & Klip

| Method | Endpoint | Akses | Deskripsi |
| --- | --- | --- | --- |
| `POST` | `/api/episodes/analyze` | User | Menganalisis URL YouTube via Gemini API (menghasilkan klip, skor kualitas 7 dimensi, AI Intro, chapters, key quotes). |
| `POST` | `/api/episodes/:episodeId/upload-video` | User | Mengunggah berkas video sumber lokal (validasi magic-byte + batas ukuran & kuota). |
| `POST` | `/api/episodes/:episodeId/source-url` | User | Menyimpan URL video langsung (MP4/WebM) setelah validasi anti-SSRF. |
| `DELETE` | `/api/episodes/:episodeId` | User | Soft delete episode & klip terkait milik pengguna. |
| `PATCH` | `/api/clips/:clipId` | User | Memperbarui judul, rentang waktu (`startSec`/`endSec`), caption, subtitle, AI Intro, atau gaya overlay manual. |
| `DELETE` | `/api/clips/:clipId` | User | Soft delete satu klip milik pengguna. |

## 5. Mesin Render FFmpeg & Pengunduhan MP4

| Method | Endpoint | Akses | Deskripsi |
| --- | --- | --- | --- |
| `POST` | `/api/clips/:clipId/render-jobs` | User | Mendaftarkan render FFmpeg persisten (mendukung layout `9:16`, `4:5`, `1:1`, kualitas `1080p`/`4k`, `normalizeAudio`, `watermarkText`, overlay manual). Mengembalikan `{ job, streamToken }`. |
| `GET` | `/api/render-jobs` | User | Daftar riwayat render job milik pengguna. |
| `GET` | `/api/render-jobs/:jobId` | User | Status detail satu render job. |
| `GET` | `/api/render-jobs/:jobId/stream?st=...` | Token SSE | Aliran event real-time progres render (`queued` -> `preparing` -> `rendering` -> `completed`/`failed`). |
| `POST` | `/api/render-jobs/:jobId/cancel` | User | Membatalkan render job milik sendiri (menghentikan proses FFmpeg secara aman). |
| `GET` | `/api/clips/:clipId/download` | User | Mengunduh/streaming MP4 hasil render (mendukung HTTP `Range` capped 4 MiB untuk kompatibilitas Cloud Run). |

## 6. Distribusi, Penjadwalan & Otomasi

| Method | Endpoint | Akses | Deskripsi |
| --- | --- | --- | --- |
| `POST` | `/api/clips/:clipId/publish` | User | Memproses publikasi klip (dan dispatch webhook jika aktif) serta mencatat `distribution_logs`. |
| `POST` | `/api/clips/:clipId/schedule` | User | Menjadwalkan klip pada Kalender Konten (`scheduledFor` ISO datetime + `platforms`). |
| `POST` | `/api/clips/:clipId/youtube-upload` | User | Mengunggah MP4 hasil render langsung ke YouTube Shorts melalui YouTube Data API v3. |
| `PUT` | `/api/automation` | User | Menyimpan pengaturan otomasi per pengguna (validasi SSRF webhook; `webhookSecretHeader` disensor saat dikembalikan). |
| `POST` | `/api/automation/test-webhook` | User | Menguji pengiriman payload `bot.test` ke URL webhook setelah validasi anti-SSRF. |
| `GET` | `/api/youtube/cookies-status` | User | Mengecek status ketersediaan `cookies.txt` server (tanpa mengembalikan isi file). |
| `POST` / `DELETE` | `/api/youtube/cookies` | Admin / Super Admin | Mengunggah atau menghapus `cookies.txt` global server. |

## 7. AI Content Studio

| Method | Endpoint | Akses | Deskripsi |
| --- | --- | --- | --- |
| `POST` | `/api/ai/repurpose` | User | Menghasilkan konten siap tayang untuk 6 platform (YouTube Shorts, TikTok, Instagram, Facebook Reels, LinkedIn, X). |
| `POST` | `/api/ai/hooks` | User | Menghasilkan variasi hook dalam 6 gaya bahasa (Kontroversial, Edukatif, Emosional, Storytelling, Singkat, Profesional). |
| `POST` | `/api/ai/subtitle-polish` | User | Memoles tanda baca, kapitalisasi, dan keterbacaan subtitle tanpa mengubah makna maupun waktu bicara. |
| `POST` | `/api/ai/assistant` | User | Asisten tanya-jawab AI berbasis transkrip & ringkasan episode terkait. |

## 8. Admin Control Center (`/api/admin/*`)

| Method | Endpoint | Akses | Deskripsi |
| --- | --- | --- | --- |
| `GET` | `/api/admin/overview` | Admin / Super Admin | Metrik nyata sistem (CPU, RAM, uptime, total pengguna, episode, klip, render job, biaya estimasi Gemini). |
| `GET` | `/api/admin/users` | Admin / Super Admin | Daftar pengguna (mendukung `page`, `limit`, `search`, `role`, `status`). |
| `PATCH` | `/api/admin/users/:uid/status` | Admin / Super Admin | Mengaktifkan atau menangguhkan (`active` / `suspended`) akun pengguna biasa. |
| `PATCH` | `/api/admin/users/:uid/role` | Super Admin | Mengubah peran pengguna (`user` / `admin` / `super_admin`). |
| `PATCH` | `/api/admin/users/:uid/subscription` | Super Admin | Mengubah paket langganan (`free` / `starter` / `pro` / `business`) dan kuota pengguna. |
| `GET` | `/api/admin/ai-usage` | Admin / Super Admin | Statistik pemakaian token & estimasi biaya Gemini API per model dan operasi. |
| `GET` | `/api/admin/render-jobs` | Admin / Super Admin | Daftar seluruh antrean & riwayat render lintas pengguna. |
| `POST` | `/api/admin/render-jobs/:jobId/cancel` | Admin / Super Admin | Menghentikan paksa render job yang bermasalah. |
| `GET` | `/api/admin/audit-logs` | Admin / Super Admin | Riwayat log audit keamanan dan aktivitas administratif. |
| `POST` | `/api/admin/backup` | Super Admin | Membuat snapshot backup database SQLite ke `data/backups/` secara atomik. |

## 9. AICLIPER 2.0 Modular API (`/api/v2/*`)

Seluruh endpoint di bawah `/api/v2/*` dilindungi autentikasi Firebase ID Token, rate limit, dan validasi Zod.

| Method | Endpoint | Akses | Deskripsi |
| --- | --- | --- | --- |
| `GET` / `POST` | `/api/v2/workspaces` | User | Melihat daftar workspace pengguna atau membuat workspace baru (maks 10 per akun). |
| `GET` / `PUT` | `/api/v2/editor/:clipId` | User | Memuat atau menyimpan proyek Smart Video Editor non-destruktif (multi-track timeline, zoom, safe-area, preset ekspor FFmpeg, opsional `syncClipBounds`). |
| `GET` / `POST` | `/api/v2/templates` | User | Mengelola Pustaka Template (`subtitle`, `intro`, `thumbnail`, `export`). |
| `DELETE` | `/api/v2/templates/:templateId` | User | Menghapus template milik pengguna. |
| `GET` / `POST` | `/api/v2/content-studio/generations` | User | Melihat riwayat atau membuat konten AI Content Studio 2.0 kustom (bahasa, platform, tone, audiens, tujuan, panjang, gaya). |
| `DELETE` | `/api/v2/content-studio/generations/:id` | User | Menghapus satu riwayat generasi konten milik pengguna. |
| `GET` / `POST` / `DELETE` | `/api/v2/advisor/:episodeId/messages` | User | Memuat, mengirim pertanyaan, atau membersihkan riwayat chat persisten AI Content Advisor per episode. |
| `GET` | `/api/v2/analytics/overview` | User | Mengambil ringkasan metrik 100% nyata dari SQLite dan snapshot YouTube API tersinkron (tanpa data simulasi). |
| `POST` | `/api/v2/analytics/sync-youtube` | User (+ YouTube Token) | Menyinkronkan statistik views/likes/comments nyata dari YouTube Data API v3. |
| `POST` | `/api/v2/analytics/growth-recommendations` | User | Menghasilkan rekomendasi AI Growth tergrounding berdasarkan metrik nyata akun. |
| `GET` | `/api/v2/billing/summary` | User | Mengambil katalog 4 paket aktif, ringkasan kuota, riwayat billing, dan status kesiapan `PaymentProvider`. |
| `GET` | `/api/v2/admin/workspaces` | Admin / Super Admin | Melihat daftar seluruh workspace lintas pengguna. |
| `GET` | `/api/v2/admin/system-settings` | Admin / Super Admin | Melihat konfigurasi model AI, mode maintenance, katalog paket, dan status payment gateway. |
| `PATCH` | `/api/v2/admin/system-settings` | Super Admin | Memperbarui konfigurasi sistem, harga/kuota paket, tema default, dan mode maintenance (tercatat di audit log). |
