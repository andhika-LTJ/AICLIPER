# AICLIPER Computer Vision Worker Boundary (`workers/cv_service`)

Untuk menjaga image Docker API (`Dockerfile.api`) dan frontend tetap ringan dan cepat di Cloud Run, dependensi Computer Vision berat (seperti Python MediaPipe FaceMesh / OpenCV YuNet) **dipisahkan** dari container API.

## Strategi Runtime Saat Ini (Node-Native + Hybrid)
1. **Audio VAD & RMS Speech Energy (Aktif 100% di Node/FFmpeg):** `server/services/activeSpeakerEngine.ts` menggunakan FFmpeg `silencedetect` + analisis energi audio untuk membedakan ucapan aktif dari hening, noise, atau musik.
2. **Multi-Face & Lip Activity Tracking (Aktif di Node + Gemini Multi-Face Vision):** `server/clipIntelligence.ts` mendeteksi seluruh kandidat wajah + skor aktivitas mulut + diarization cues per frame, lalu digabungkan secara deterministik dengan Audio VAD, Hysteresis, Minimum Shot Duration, Switching Threshold, Cooldown, dan Tracking Recovery.
3. **Optional Dense CV Sidecar (`CV_WORKER_URL`):** Jika diperlukan pelacakan 10–15 FPS menggunakan MediaPipe/OpenCV di production, deploy layanan Python terpisah yang memenuhi kontrak `workers/cv_service/contract.ts` (`POST /analyze`) tanpa menambah ukuran container utama.
