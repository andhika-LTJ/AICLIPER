/**
 * Optional Computer Vision Sidecar / Worker Contract (Phase 5)
 * Keeps the main Express API & React frontend container lean (zero OpenCV/MediaPipe binary bloat).
 * When `CV_WORKER_URL` is configured in production, ActiveSpeakerEngine can ingest dense
 * MediaPipe/OpenCV face tracks + lip openness signals using this exact JSON contract.
 */

export interface CvFaceDetectionFrame {
  timeSec: number;
  faces: Array<{
    trackId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    confidence: number;
    mouthAspectRatio: number; // 0..1 lip activity ratio
    headYawDeg?: number;
    occluded?: boolean;
  }>;
}

export interface CvAnalyzeRequest {
  sourceUri: string;
  startSec: number;
  endSec: number;
  sampleFps: number;
}

export interface CvAnalyzeResponse {
  engine: 'mediapipe_face_mesh' | 'opencv_yunet' | 'gemini_multiface_vad';
  fps: number;
  frames: CvFaceDetectionFrame[];
  processingMs: number;
}
