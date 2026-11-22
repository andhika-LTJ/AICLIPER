# AICLIPER — Production Readiness & Architecture Audit Report (PHASE 0)

> **Tanggal Audit:** 2026  
> **Lingkup:** Seluruh codebase AICLIPER / KlipCast 2.0 (`src/`, `server/`, `scripts/`, `migrations/`, `package.json`, `vite.config.ts`)  
> **Status Baseline Sebelum Upgrade:** 100/100 automated tests pass, `tsc --noEmit` 0 errors, `npm run build` 972 KB.

---

## 1. Pemetaan Arsitektur Saat Ini (As-Is)

| Lapisan | Implementasi Eksisting | Status |
|---|---|---|
| **Frontend** | React 19 + Vite + TypeScript + Tailwind CSS v4 (`src/App.tsx`, `src/components/*`, `src/data/*`, `src/utils/*`) | Berfungsi, modular, 7 workspace utama |
| **Backend API** | Express (`server.ts`) dengan route modular (`server/routes/v2PlatformRoutes.ts`) | Berfungsi, namun sebagian proses berat masih berada dalam proses yang sama |
| **Database** | `node:sqlite` lokal (`server/db.ts`, 22 tabel, migrasi `001` & `002`) | Berfungsi untuk dev/single-node, belum terhubung ke PostgreSQL/Drizzle untuk skala multi-user Cloud Run |
| **Authentication** | Firebase Auth + `server/authMiddleware.ts` + `server/googleAuthVerifier.ts` + YouTube OAuth | **Dilarang diubah** (tetap dipertahankan penuh) |
| **Media Storage** | Direktori lokal `.cache/` / `tmp` (`server/videoClipper.ts`) | Ephemeral di Cloud Run; butuh lapisan permanen Google Cloud Storage (`gcsStorageService`) |
| **Queue & Worker** | `server/renderJobManager.ts` (in-process async queue dengan batas concurrency lokal) | Tidak tahan restart container; butuh Google Cloud Tasks + Cloud Run Jobs |
| **AI Intelligence** | `server/clipIntelligence.ts` (`@google/genai` Gemini 2.5 Flash) | Berfungsi, namun hanya mengambil 1 `faceBox` per frame tanpa multi-face tracking & tanpa audio VAD |
| **Video Rendering** | `server/videoClipper.ts` + `server/speakerFocusMath.ts` + `server/videoIntroMath.ts` (FFmpeg + ASS) | Berfungsi untuk single-crop 9:16 & 1 gaya intro statis |

---

## 2. Analisis Akar Masalah — Kamera Pembicara Aktif (Feature 1)

Hasil inspeksi langsung pada `server/clipIntelligence.ts` (baris 1–990) dan `server/speakerFocusMath.ts` (baris 1–735):

1. **Single-Candidate Detection:** Gemini hanya diminta mengembalikan 1 `faceBox` per frame (`10–18` frame pada resolusi `480px`). Tidak ada pelacakan multi-wajah (`face_tracks`) maupun identitas pembicara (`speaker_profiles`).
2. **Tidak Ada Audio VAD / Speech Energy Signal:** Sistem tidak mengekstrak aktivitas suara aktual (FFmpeg `silencedetect` / RMS energy envelope). Akibatnya, orang diam di samping pembicara, gerakan tangan, atau jeda hening/musik dapat memicu perpindahan fokus kamera palsu.
3. **Tidak Ada Stabilisasi Keputusan Kamera:** Hanya ada deadband micro-jitter `10px` dan pengecekan 1-frame outlier. Belum ada:
   - **Hysteresis**
   - **Minimum Shot Duration** (pencegahan kamera berkedip / ping-pong)
   - **Switching Threshold & Cooldown**
   - **Confidence Threshold** + fallback ke safe framing
   - **Target Lock** & **Tracking Recovery** saat wajah tertutup sementara
4. **Keterbatasan Mode Framing & Multi-Speaker:** Belum mendukung 6 mode framing (`speaker_focus`, `face_centered`, `upper_body`, `dynamic_follow`, `wide_context`, `manual_framing`) dan 6 layout multi-speaker (`active_speaker_full`, `split_screen`, `side_by_side`, `picture_in_picture`, `speaker_plus_context`, `wide_shot`).
5. **Tidak Ada Smart Camera Editor UI:** Pengguna tidak dapat melihat timeline perpindahan kamera, mengunci/mengabaikan pembicara tertentu, melihat indikator confidence/crop boundary, atau melakukan override manual per segmen.

---

## 3. Analisis Akar Masalah — Intro Shorts Profesional (Feature 2)

Hasil inspeksi langsung pada `server/videoIntroMath.ts` (baris 1–257) dan `server/videoClipper.ts` (`buildIntroChain`, baris 1253–1265):

1. **Hanya 1 Gaya Hardcoded:** `buildIntroChain` selalu membuat frame blur gelap + 1 garis aksen horizontal + 4 style ASS tetap (`IntroBadge`, `IntroHeadline`, `IntroTeaser`, `IntroChannel`).
2. **Durasi Terbatas:** Durasi dikunci `2.0–4.5 detik`; tidak mendukung `0.5s`, `1.0s`, `1.5s`, `2.0s`, `3.0s`, atau `custom`.
3. **Tidak Ada Katalog Template (0/22 Kategori):** Belum tersedia template untuk 22 kategori Shorts (Viral Hook, Podcast Highlight, Cinematic, Breaking News, Minimalist, Bold Typography, Meme & Fun, Question Hook, Storytelling, Motivation, Educational, Sports, Gaming, Documentary, Luxury/Elegant, Top 3/Listicle, Dramatic Quote, Reaction, Business & Finance, Lifestyle, Technology, Tutorial).
4. **Tidak Ada Kontrol Kotak Teks Opsional:** Tidak ada opsi `enableTextBox: false` (teks langsung di atas background/video) vs `enableTextBox: true` (dengan padding, radius, border, opacity, shadow).
5. **Tidak Ada Interactive Visual Editor & Personal Templates:** Belum ada kanvas 9:16 drag-and-drop dengan safe area guide, snap-to-center, panel layers, 10 animasi terkalibrasi, audio/SFX intro opsional, undo/redo, serta penyimpanan `user_intro_templates` & `intro_template_versions`.

---

## 4. Analisis Akar Masalah — Skalabilitas, Caching & Observabilitas

1. **Render Fingerprinting Belum Lengkap:** Cache saat ini hanya menyimpan `seg_hd_*` dan `intel_*`, belum menggunakan deterministic `renderFingerprint` (14 parameter: source, range, resolution, codec, bitrate, aspect ratio, caption, intro, camera, speaker, layout, overlay, audio, pipelineVersion) maupun profil kualitas `Balanced` (`fast_preview`, `balanced_1080p`, `balanced_4k`, `high_quality`).
2. **Observabilitas Terbatas:** Belum ada tabel `performance_metrics` dan `job_events` untuk mencatat durasi nyata per tahap (AI analysis, active speaker tracking, intro compilation, FFmpeg rendering, cache hit rate).
3. **Kesiapan Cloud Infrastructure:** Belum tersedia definisi Drizzle ORM PostgreSQL (19 tabel produksi), migrasi non-destruktif, layanan GCS, layanan Cloud Tasks (3 queue), worker terpisah (`workers/aiWorker.ts`, `workers/renderWorker.ts`), serta manifest Cloud Run Jobs + strategi Staged Migration & Rollback.

---

## 5. Rencana Implementasi Terstruktur (Fase 1–14)

- **Fase 1:** Skema Drizzle ORM PostgreSQL 19 tabel (`src/db/schema.ts`, `src/db/drizzle.config.ts`, `src/db/index.ts`, `migrations/003_production_readiness_postgres.sql`) + migrasi SQLite non-destruktif `003_production_readiness` (total 34 tabel runtime).
- **Fase 2–4:** `gcsStorageService.ts`, `cloudTasksService.ts`, `cloudRunJobsService.ts`, `workers/aiWorker.ts`, `workers/renderWorker.ts`.
- **Fase 5–7:** `activeSpeakerEngine.ts` (multi-signal audio VAD + lip/face + diarization + hysteresis + min shot duration + recovery + 6 modes + 6 multi-speaker layouts + benchmark suite) & `SmartCameraEditorPanel.tsx`.
- **Fase 8–9:** Katalog 22 kategori (`src/data/introTemplatesCatalog.ts`), compiler FFmpeg+ASS (`server/services/introRenderCompiler.ts`), & `ProfessionalIntroStudioPanel.tsx` (kanvas 9:16 interaktif, drag-and-drop, text box toggle, 10 animasi, layers, undo/redo, personal templates + versioning).
- **Fase 10–14:** `renderFingerprint.ts`, profil Balanced rendering, API v3 (`server/routes/v3ProductionRoutes.ts`), real monitoring (`performance_metrics`, `job_events`), Dockerfiles + Cloud Run Job YAML + Staged Migration & Rollback docs, serta pengujian menyeluruh (Active Speaker 12 skenario, Intro 11 skenario, System 10 skenario, Playwright desktop & mobile).
