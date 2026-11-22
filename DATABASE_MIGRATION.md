# Arsitektur Database & Panduan Migrasi (`DATABASE_MIGRATION.md`)

KlipCast telah dimigrasikan dari penyimpanan satu file JSON (`data/clipper-store.json`) menuju arsitektur **database relasional multi-user ACID** yang mendukung isolasi kepemilikan per pengguna, transaksi atomik, indexing, pagination, soft delete, dan snapshot backup.

## 1. Catatan Jujur Tentang Infrastruktur Database

Selama proses audit dan provisioning pada lingkungan Google AI Studio ini:
1. Provisioning **Cloud SQL (PostgreSQL)** pada region `asia-east1` ditolak oleh platform (`FEATURE_NOT_SUPPORTED`).
2. Provisioning **Firebase Firestore** pada proyek `gen-lang-client-0564579246` ditolak karena izin caller (`The caller does not have permission`).

Untuk menjamin aplikasi **100% berjalan stabil, aman, multi-user, dan ACID** tanpa menunggu provisioning manual yang terblokir, kami menerapkan:
- **Runtime Database Aktif**: SQLite relasional ACID menggunakan modul standar Node.js v22 (`node:sqlite`, `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`, transaksi bersarang berbasis `SAVEPOINT`) tersimpan di `data/klipcast.sqlite`.
- **Skema Migrasi PostgreSQL Produksi**: Skema SQL setara untuk 13 tabel yang sama tersedia di `/migrations/001_initial_postgres.sql`, siap dijalankan langsung pada PostgreSQL / Cloud SQL / Neon / Supabase saat Anda men-deploy ke infrastruktur database terkelola.

## 2. Daftar 13 Tabel Relasional

Semua entitas pengguna terikat langsung ke `users.uid` dengan `FOREIGN KEY` dan indeks komposit `(user_uid, created_at)`:

1. `users` — Identitas terverifikasi Firebase (`uid`, `email`, `role`, `status`, `session_revoked_before`, `last_login_at`).
2. `user_profiles` — Profil kreator (`display_name`, `brand_name`, `avatar_url`, `preferred_language`, `theme`, `onboarding_completed`).
3. `user_settings` — Konfigurasi otomasi per pengguna (`webhook_url`, `webhook_secret_header` yang disensor saat dibaca klien, durasi default, platform, preset layout).
4. `episodes` — Proyek podcast/video per pengguna (`id`, `user_uid`, `youtube_url`, `video_id`, `chapters_json`, `key_quotes_json`, `deleted_at` untuk soft delete).
5. `clips` — Klip hasil ekstraksi AI per pengguna (`id`, `episode_id`, `user_uid`, `start_sec`, `end_sec`, `quality_scores_json`, `overlay_style_json`, `ai_intro_json`, `scheduled_for`, `deleted_at`).
6. `render_jobs` — Antrean & riwayat render FFmpeg persisten (`id`, `user_uid`, `clip_id`, `status`, `stage`, `progress`, `output_file_path`, `error_message`).
7. `upload_jobs` — Riwayat unggahan video sumber lokal & validasi file (`id`, `user_uid`, `episode_id`, `original_filename`, `mime_type`, `size_bytes`, `status`).
8. `distribution_logs` — Log publikasi/penjadwalan/webhook per klip dan platform (`id`, `user_uid`, `clip_id`, `platform`, `action`, `status`, `external_url`).
9. `subscriptions` — Paket langganan & batas kuota tiap pengguna (`user_uid`, `plan_tier`, `monthly_ai_limit`, `monthly_render_limit`, `monthly_upload_limit`, `max_storage_mb`, `max_export_quality`).
10. `usage_records` — Pencatatan pemakaian bulanan per periode `YYYY-MM` (`ai_analyses_used`, `renders_used`, `uploads_used`, `storage_bytes_used`).
11. `api_usage` — Log token & estimasi biaya Gemini API per operasi (`user_uid`, `operation`, `model`, `prompt_tokens`, `output_tokens`, `estimated_cost_usd`, `cached`).
12. `notifications` — Notifikasi aplikasi (render selesai, peringatan kuota >= 80%, publikasi berhasil, pengumuman sistem).
13. `admin_audit_logs` — Jejak audit seluruh aksi sensitif Admin & Super Admin (`actor_uid`, `action`, `target_type`, `target_id`, `metadata_json`, `ip_address`).

### Migrasi Non-Destruktif `002_aicliper_2_0_schema` (+9 Tabel -> Total 22 Tabel)

Dijalankan otomatis secara idempoten saat boot (`server/db.ts`), menambah kolom `theme_preset` pada `user_profiles` tanpa mereset data lama, serta menambahkan 9 tabel baru:

14. `workspaces` — Ruang kerja proyek per kreator/tim (`id`, `owner_uid`, `name`, `description`).
15. `workspace_members` — Keanggotaan peran per workspace (`workspace_id`, `user_uid`, `role`).
16. `editing_projects` — State proyek Smart Video Editor non-destruktif (`clip_id`, `user_uid`, `elements_json`, `export_preset_json`, `zoom_level`, `safe_area_enabled`).
17. `templates` — Pustaka Template lintas kategori (`subtitle`, `intro`, `thumbnail`, `export`).
18. `content_generations` — Riwayat hasil AI Content Studio 2.0 kustom beserta parameter & model AI yang digunakan.
19. `ai_advisor_messages` — Riwayat percakapan persisten AI Content Advisor per episode & pengguna.
20. `analytics_snapshots` — Snapshot statistik nyata hasil sinkronisasi YouTube Data API v3 (`views`, `likes`, `comments`, `last_synced_at`).
21. `system_settings` — Konfigurasi dinamis platform, model AI default/fallback, mode maintenance, dan katalog paket (dikelola Super Admin).
22. `billing_records` — Riwayat pencatatan perubahan paket dan transaksi billing per pengguna.

## 3. Mekanisme Migrasi Otomatis dari `clipper-store.json` (Tanpa Kehilangan Data)

Saat server pertama kali dijalankan (`server/db.ts -> migrateLegacyJsonStore()`):
1. Server memeriksa apakah `data/clipper-store.json` ada dan belum tercatat di tabel `schema_migrations` sebagai `legacy_json_v1`.
2. Di dalam satu **transaksi atomik**, seluruh episode, klip, dan konfigurasi otomasi lama disalin ke pemilik sistem sementara (`legacy-owner`).
3. File `data/clipper-store.json` **tidak dihapus**; migrasi bersifat idempoten sehingga restart berikutnya tidak menggandakan data.
4. Saat Super Admin pertama kali masuk dengan akun Google (`claimLegacyDataIfPresent()`), data proyek lama milik `legacy-owner` otomatis dialihkan ke `uid` Super Admin sehingga proyek lama langsung muncul kembali tanpa kehilangan satu pun klip.

## 4. Backup & Restore

### Backup Otomatis via Panel Super Admin
- Super Admin dapat mengklik tombol **Buat Backup Database** pada tab **Admin -> Ringkasan & Sistem** (memanggil `POST /api/admin/backup`).
- Server menyalin snapshot SQLite yang konsisten (`VACUUM INTO` / salinan aman) ke direktori `data/backups/klipcast-backup-<timestamp>.sqlite` dan mencatat aktivitas tersebut di `admin_audit_logs`.

### Restore Manual
1. Hentikan proses server KlipCast.
2. Cadangkan file saat ini: `cp data/klipcast.sqlite data/klipcast.sqlite.before-restore`.
3. Salin file backup: `cp data/backups/klipcast-backup-<timestamp>.sqlite data/klipcast.sqlite`.
4. Hapus file WAL lama jika ada (`rm -f data/klipcast.sqlite-wal data/klipcast.sqlite-shm`) lalu jalankan kembali server.

## 5. Migrasi ke PostgreSQL Produksi

Jika Anda men-deploy dengan database PostgreSQL terkelola (Cloud SQL / RDS / Neon / Supabase):
1. Jalankan kedua skrip DDL berurutan secara non-destruktif:
   ```bash
   psql "$DATABASE_URL" -f migrations/001_initial_postgres.sql
   psql "$DATABASE_URL" -f migrations/002_aicliper_2_0_postgres.sql
   ```
2. Kedua skema sudah dilengkapi seluruh `PRIMARY KEY`, `FOREIGN KEY`, constraint `CHECK`, dan indeks performa identik dengan 22 tabel SQLite aktif.
3. Ekspor data dari SQLite menggunakan `sqlite3 data/klipcast.sqlite .dump` atau endpoint `GET /api/me/export` per pengguna sebelum mengalihkan adapter database.
