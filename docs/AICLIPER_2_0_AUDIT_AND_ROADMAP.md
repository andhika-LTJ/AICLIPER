# AICLIPER 2.0 — Phase 0 Complete Repository Audit & Implementation Roadmap

Dokumen ini menyajikan hasil audit menyeluruh terhadap repository **KlipCast / AICLIPER** sebelum pengembangan **AICLIPER 2.0**, lengkap dengan inventaris fitur, pemetaan arsitektur, evaluasi keamanan, rancangan database 22 tabel, dan rencana implementasi bertahap (Phase 1–9).

---

## 1. Architecture Report (Kondisi Baseline v1.5)

- **Frontend**: React 19 + TypeScript + Vite 8.3 + Tailwind CSS v4.3 (`@import "tailwindcss"`), 17 komponen modular di `src/components/`, routing state berbasis `NavSection` di `src/App.tsx`.
- **Backend**: Express 4.21 pada `server.ts` (2.340 baris, 51 endpoint) + modul domain terpisah di `server/` (`db.ts`, `authMiddleware.ts`, `googleAuthVerifier.ts`, `security.ts`, `quotaService.ts`, `renderJobManager.ts`, `videoClipper.ts`, `youtubeAnalyzer.ts`, `aiStudio.ts`, `systemMonitor.ts`, `youtubeUploader.ts`, `store.ts`).
- **Database**: `node:sqlite` (WAL mode, `foreign_keys = ON`, transaksi re-entrant dengan `SAVEPOINT`) — 13 tabel relasional multi-user (`users`, `user_profiles`, `user_settings`, `episodes`, `clips`, `render_jobs`, `upload_jobs`, `distribution_logs`, `subscriptions`, `usage_records`, `api_usage`, `notifications`, `admin_audit_logs`) dengan padanan PostgreSQL di `migrations/001_initial_postgres.sql`.
- **AI Engine**: `@google/genai` server-side only (`gemini-4-hydrogen` primary dengan `ThinkingLevel.LOW` + `gemini-3.1-flash-lite` fallback), validasi JSON via Zod, caching 20 menit, dan pencatatan token/estimasi biaya ke `api_usage`.
- **Video Processing**: FFmpeg + ffprobe native (`server/videoClipper.ts`) dengan dukungan aspect ratio `9:16`, `4:5`, `1:1`, `16:9`, resolusi `1080p` & `4K`, subtitle burn-in SRT/ASS, AI Intro overlay, manual overlay positioning, dan audio loudness normalization (`-14 LUFS`).
- **Auth & Security**: Verifikasi signature JWT RS256 Firebase ID Token via Google JWKS (`server/googleAuthVerifier.ts`), RBAC (`super_admin`, `admin`, `user`), isolasi data per `user_uid`, HMAC signed media URLs (`/api/rendered-clips/*`, `/api/episodes/*/source-video`), proteksi SSRF, rate limiting per-IP & per-user, dan sanitasi webhook secret.

---

## 2. Feature Inventory (Faktual)

| Area | Status Baseline | Catatan Audit |
|---|---|---|
| Firebase Google Login & JWT Verification | **Working** | RS256 JWKS verification + session revocation (`revoked_before_sec`) + RBAC |
| YouTube Analysis & Smart Clip Discovery | **Working (Upgradeable)** | 7-dimensi `ClipQualityScores` + deduplikasi overlap; belum ada pilihan 6 *Clipping Approaches* (`educational`, `storytelling`, `motivational`, `informative`, `entertainment`, `promotional`) |
| FFmpeg Video Rendering & Manual Overlay | **Working** | Multi-aspect ratio, 1080p/4K, SRT/ASS subtitle burn-in, intro AI, manual positioning |
| Smart Video Editor (Multi-Track Timeline) | **Missing** | Belum tersedia timeline non-destruktif (Video/Audio/Text/Subtitle tracks, Zoom, Split, Move, Undo/Redo, Safe Area overlay, Export FPS preset) |
| AI Content Studio (Hooks, Repurpose, Subtitle, Thumbnail) | **Partial** | Ada Hook 6 tone, Repurpose, Subtitle Polish, Thumbnail SVG/PNG, Episode Assistant (stateless); belum ada Custom Content Generator (Language/Platform/Tone/Audience/Objective/Length/Style), belum ada riwayat `content_generations`, belum ada chat persisten AI Advisor, belum ada Save-as-Template |
| Multi-Platform Publishing | **Working (Honest)** | Direct upload ke YouTube Shorts (OAuth `youtube.upload` real) + Webhook/Manual Kit jujur untuk TikTok/Instagram/Facebook/X/LinkedIn |
| Content Analytics & Growth Advisor | **Missing** | Belum ada agregasi performa real dari DB, sinkronisasi statistik real YouTube Data API v3 (`videos?part=statistics`), maupun AI Growth Recommendations berbasis data nyata |
| Template Library | **Missing** | Belum ada penyimpanan & penggunaan ulang template Subtitle/Intro/Thumbnail lintas proyek |
| Multi-Theme System (4 Themes) | **Partial + Bug** | Hanya `light`/`dark`, dan ditemukan bug payload di `src/App.tsx:103` (`preferredTheme` vs `themePreference`) |
| Workspaces & Team Model | **Missing** | User hanya memiliki proyek datar tanpa entitas `workspaces` / `workspace_members` |
| Admin Control Center & Configurable Plans | **Working (Upgradeable)** | Monitoring user, job, audit log, storage berjalan; belum ada manajemen Workspace, pengaturan harga/kuota paket dinamis (`system_settings`), dan ringkasan billing/payment readiness |
| Payment Gateway Integration | **Not Configured** | Belum ada abstraksi `PaymentProvider` & tabel `billing_records`; memerlukan API key gateway (Midtrans/Xendit/Stripe) untuk live checkout |

---

## 3. Security & Bug Findings (Audit Phase 0)

1. **[Medium — Bug] Ketidakcocokan Payload Tema (`src/App.tsx:103`)**: Frontend mengirim `{ preferredTheme }`, sementara `PATCH /api/me/profile` di `server.ts:355` membaca `themePreference`. Diperbaiki pada Phase 1 & 7.
2. **[Low — Architecture] Monolithic Route File (`server.ts` 2.340 baris)**: Seluruh fitur baru AICLIPER 2.0 akan dipisahkan secara modular ke `server/routes/v2Routes.ts`, `server/repositories/v2Repository.ts`, `server/validators/schemas.ts`, `server/services/analyticsService.ts`, `server/services/paymentProvider.ts`, dan `server/utils/timelineMath.ts` tanpa merusak 51 route eksisting.
3. **[Info — Infrastructure Readiness]**: Cloud SQL (`asia-east1`) dan Firebase Firestore provisioning tidak tersedia di container ini (platform/IAM restriction). Oleh karena itu, persistence menggunakan `node:sqlite` ACID + migrasi non-destruktif `002_aicliper_2_0_schema` lengkap dengan mirror SQL PostgreSQL di `migrations/002_aicliper_2_0_postgres.sql`.

---

## 4. Database Extension Proposal (13 -> 22 Tabel Relasional)

Migrasi **non-destruktif** `002_aicliper_2_0_schema` menambahkan kolom `theme_preset` pada `user_profiles` (menjaga kompatibilitas penuh dengan `theme_preference`) serta 9 tabel baru:

1. `workspaces` — Ruang kerja kreator/tim (`owner_uid`, `name`, `slug`, `description`).
2. `workspace_members` — Keanggotaan & peran workspace (`owner`, `editor`, `viewer`).
3. `editing_projects` — State non-destruktif Smart Video Editor per klip (`timeline_json`, `export_preset_json`, `safe_area_enabled`, `zoom_level`, `version`).
4. `templates` — Pustaka template Subtitle, Intro, Thumbnail, dan Export (`category`, `config_json`, `is_public`).
5. `content_generations` — Riwayat hasil AI Content Studio kustom (Script, Title, Hook, Caption, Hashtags, Description, CTA + seluruh parameter kustomisasi).
6. `ai_advisor_messages` — Riwayat percakapan persisten AI Content Advisor per user & episode.
7. `analytics_snapshots` — Snapshot performa real (`source: 'youtube_api' | 'internal_db'`, `views`, `likes`, `comments`, `last_synced_at`).
8. `system_settings` — Pengaturan platform & katalog harga/kuota paket yang dapat dikonfigurasi Super Admin (diaudit di `admin_audit_logs`).
9. `billing_records` — Catatan perubahan paket, transaksi manual admin, atau referensi invoice payment provider di masa depan.

---

## 5. Phased Implementation Plan (Phase 1–9)

- **Phase 1 & 2**: Modular backend (`validators`, `repositories`, `services`, `routes`), migrasi DB `002_aicliper_2_0_schema` + `migrations/002_aicliper_2_0_postgres.sql`, `PaymentProvider` abstraction, dan perbaikan bug `themePreference`.
- **Phase 3**: Upgrade AI Video Intelligence dengan 6 *Clipping Approaches* (`educational`, `storytelling`, `motivational`, `informative`, `entertainment`, `promotional`) dan metadata `contentStyle` / `suggestedPlatform` / `scoringModelVersion`.
- **Phase 4**: Smart Video Editor (`SmartVideoEditorView.tsx`) + pure `timelineMath.ts` (multi-track Timeline, Zoom 1x–4x, Playhead, Trim, Split, Move, Delete, Undo/Redo, Safe-Area overlay, Subtitle presets, Export FPS/Resolution presets, FFmpeg render integration).
- **Phase 5**: AI Content Studio 2.0 (Custom Generator lengkap + riwayat `content_generations`, Persistent AI Content Advisor chat, Save-as-Template).
- **Phase 6**: Content Analytics real (DB metrics + YouTube Data API v3 sync + grounded AI Growth Recommendations) & Template Library CRUD.
- **Phase 7 & 8**: 4-Theme System (`minimal_light`, `dark_studio`, `creator_neon`, `professional`) + Expanded Admin Control Center (Workspaces, Configurable Plans & System Settings, Billing Readiness).
- **Phase 9**: Automated unit & HTTP integration tests (`server/v2Platform.test.ts`), `compile_applet` + `lint_applet`, production boot check, Playwright desktop & mobile verification, dan laporan akhir jujur.
