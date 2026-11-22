# Arsitektur & Praktik Keamanan — KlipCast / AICLIPER (`SECURITY.md`)

Dokumen ini menjelaskan lapisan perlindungan keamanan yang telah diterapkan pada KlipCast untuk melindungi akun pengguna, data multi-user, proses render server, serta kredensial API.

## 1. Autentikasi & Manajemen Sesi

- **Verifikasi Token Kriptografis di Server (`server/googleAuthVerifier.ts`, `server/authMiddleware.ts`)**:
  - Setiap endpoint privat (`/api/*` kecuali `/api/health`) mewajibkan header `Authorization: Bearer <Firebase ID Token>`.
  - Server memverifikasi tanda tangan RS256 token menggunakan kunci publik resmi Google (`securetoken@system.gserviceaccount.com`), serta memeriksa klaim `iss`, `aud` (sesuai `FIREBASE_PROJECT_ID`), `exp`, `iat`, `sub` (UID), dan `auth_time`.
  - Pemeriksaan login di antarmuka React hanya untuk kenyamanan UX; keputusan akses 100% ditegakkan oleh backend.
- **Pencabutan Sesi & Pembekuan Akun**:
  - Endpoint `POST /api/auth/logout` mencatat stempel waktu `session_revoked_before` pada tabel `users` sehingga token lama yang diterbitkan sebelum logout langsung ditolak (`401 Unauthorized`).
  - Akun dengan status `suspended` langsung diblokir oleh middleware autentikasi (`403 Forbidden`).
- **Token Streaming SSE Bertanda Tangan**:
  - Karena `EventSource` di browser tidak dapat mengirim header `Authorization`, endpoint streaming progres render (`GET /api/render-jobs/:jobId/stream`) menggunakan token HMAC-SHA256 berumur pendek (`?st=...`) yang terikat pada `(jobId, userUid)` dan diterbitkan hanya setelah endpoint terautentikasi memverifikasi kepemilikan job.

## 2. Kontrol Akses Berbasis Peran (RBAC) & Isolasi Multi-User

- **Tiga Peran Server-Side**: `super_admin`, `admin`, `user`.
- Peran dibaca dari database dan variabel lingkungan server (`SUPER_ADMIN_EMAILS`, `ADMIN_EMAILS`). Backend **tidak pernah** mempercayai nilai peran yang dikirim oleh frontend.
- **Isolasi Kepemilikan Data (`user_uid`)**:
  - Seluruh query episode, klip, render job, notifikasi, log distribusi, dan konfigurasi otomasi selalu memfilter berdasarkan `req.authUser.uid`.
  - Percobaan membaca, mengubah, merender, atau menghapus episode/klip milik pengguna lain ditolak dengan `404 Not Found` / `403 Forbidden`.
- **Pemisahan Wewenang Admin**:
  - Pengguna biasa (`user`) diblokir dari seluruh endpoint `/api/admin/*` (`403 Forbidden`).
  - `admin` dapat memantau ringkasan sistem, daftar pengguna, pemakaian AI, job render, audit log, dan menangguhkan pengguna biasa — tetapi **tidak dapat** mengubah peran pengguna atau membuat backup database.
  - Hanya `super_admin` yang dapat mengubah peran (`PATCH /api/admin/users/:uid/role`), mengubah paket langganan, mengelola `cookies.txt` global server, dan membuat snapshot backup database (`POST /api/admin/backup`).

## 3. Proteksi API, Header Keamanan & Rate Limiting

- **Security Headers (`server/security.ts`)**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, dan `Strict-Transport-Security` pada koneksi HTTPS/produksi.
- **CORS Allowlist**: Membatasi origin lintas domain sesuai `CORS_ALLOWED_ORIGINS` di produksi.
- **Rate Limiting Berlapis**: Batas permintaan terpisah untuk API umum, autentikasi, operasi AI Gemini, render FFmpeg, upload video, dan pengujian webhook guna mencegah brute-force dan penyalahgunaan resource.
- **Batas Ukuran Payload & Error Handling Aman**: Payload JSON dibatasi (`2mb`), dan seluruh respon error disaring lewat `sanitizePublicErrorMessage()` sehingga stack trace, path sistem file internal, atau kunci API tidak pernah bocor ke klien.

## 4. Proteksi SSRF (Webhook & Direct Video URL)

- Sebelum memanggil webhook atau mengunduh video dari URL langsung (`POST /api/automation/test-webhook`, `PUT /api/automation`, `POST /api/episodes/:id/source-url`, `dispatchWebhookIfConfigured`):
  - Hanya protokol `http:` / `https:` yang diizinkan (menolak `file:`, `javascript:`, `gopher:`, dll.) serta menolak kredensial tertanam (`user:pass@host`).
  - Memblokir hostname lokal dan internal (`localhost`, `*.local`, `*.internal`, `metadata.google.internal`).
  - Memblokir alamat IPv4, IPv6, dan IPv4-mapped IPv6 privat/loopback/link-local/metadata/CGNAT/multicast (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.169.254`, `::1`, `fc00::/7`, `fe80::/10`).
  - Melakukan verifikasi resolusi DNS sebelum request untuk mencegah serangan DNS rebinding.
  - Mendukung allowlist domain via `WEBHOOK_ALLOWED_DOMAINS`, menonaktifkan redirect otomatis (`redirect: 'error'`), dan menerapkan timeout eksternal ketat.
- **Redaksi Rahasia Webhook**: Nilai `webhookSecretHeader` disimpan hanya di server. Semua respons API (`GET /api/state`, `PUT /api/automation`) mengembalikan string kosong disertai penanda boolean `hasWebhookSecret: true/false`.

## 5. Keamanan Unggahan Video & File Sistem

- **Validasi Magic-Byte**: Setiap berkas video yang diunggah diperiksa header binernya (`ftyp`/`moov`/`mdat` untuk MP4/MOV, `1A 45 DF A3` untuk WebM/MKV, `RIFF....AVI ` untuk AVI) — file HTML, script, atau biner berbahaya langsung ditolak (`400 Bad Request`).
- **Pembatasan Resource**: Batas ukuran file (`MAX_UPLOAD_MB`), batas unggahan paralel (`MAX_CONCURRENT_UPLOADS`), dan batas kuota penyimpanan per paket.
- **Pencegahan Path Traversal**: Semua ID divalidasi dengan pola aman (`^[a-zA-Z0-9_-]{2,128}$`) dan setiap akses file melewati `resolveConfinedPath(baseDir, ...)` agar tidak bisa keluar dari direktori kerja yang diizinkan.
- **Penanganan `cookies.txt`**: Unggahan/penghapusan `cookies.txt` YouTube server dibatasi khusus untuk peran `admin` / `super_admin` dan tidak pernah dibaca balik ke klien.

## 6. Pemisahan Rahasia & Audit Log

- Semua API Key dan rahasia backend dikelola lewat variabel lingkungan (`GEMINI_API_KEY`, `STREAM_TOKEN_SECRET`). File `.env` terdaftar di `.gitignore`.
- `firebase-applet-config.json` hanya memuat konfigurasi publik Firebase Client SDK (tanpa private key service account).
- Seluruh aksi penting Admin/Super Admin dan perubahan sensitif dicatat pada tabel `admin_audit_logs`.
