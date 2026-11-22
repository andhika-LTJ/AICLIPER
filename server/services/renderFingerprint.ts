import crypto from 'crypto';
import type {
  BalancedRenderProfile,
  CameraTrackingSettings,
  IntroTemplateDefinition,
} from '../../src/types/clipper.ts';

export const RENDER_PIPELINE_VERSION = 'v3.0-balanced';

export interface BalancedRenderProfileSpec {
  id: BalancedRenderProfile;
  label: string;
  description: string;
  quality: '1080p' | '4k';
  width9x16: number;
  height9x16: number;
  fps: 24 | 30 | 60;
  videoCodec: 'libx264';
  preset: 'veryfast' | 'medium' | 'slow';
  crf: number;
  maxrateKbps: number;
  bufsizeKbps: number;
  audioBitrateKbps: number;
  profile: 'main' | 'high';
  level: string;
}

export const BALANCED_RENDER_PROFILES: Record<BalancedRenderProfile, BalancedRenderProfileSpec> = {
  fast_preview: {
    id: 'fast_preview',
    label: 'Fast Preview (720p)',
    description: 'Cepat untuk pratinjau layout kamera & intro sebelum export akhir.',
    quality: '1080p',
    width9x16: 720,
    height9x16: 1280,
    fps: 30,
    videoCodec: 'libx264',
    preset: 'veryfast',
    crf: 24,
    maxrateKbps: 3500,
    bufsizeKbps: 7000,
    audioBitrateKbps: 128,
    profile: 'main',
    level: '4.0',
  },
  balanced_1080p: {
    id: 'balanced_1080p',
    label: 'Balanced 1080p (Direkomendasikan)',
    description: 'Keseimbangan terbaik kecepatan render & ketajaman untuk YouTube Shorts / Reels / TikTok.',
    quality: '1080p',
    width9x16: 1080,
    height9x16: 1920,
    fps: 30,
    videoCodec: 'libx264',
    preset: 'medium',
    crf: 20,
    maxrateKbps: 8000,
    bufsizeKbps: 16000,
    audioBitrateKbps: 192,
    profile: 'high',
    level: '4.2',
  },
  balanced_4k: {
    id: 'balanced_4k',
    label: 'Balanced 4K Ultra HD',
    description: 'Resolusi 2160x3840 tajam dengan kontrol bitrate stabil untuk Cloud Run Jobs.',
    quality: '4k',
    width9x16: 2160,
    height9x16: 3840,
    fps: 30,
    videoCodec: 'libx264',
    preset: 'medium',
    crf: 19,
    maxrateKbps: 22000,
    bufsizeKbps: 44000,
    audioBitrateKbps: 256,
    profile: 'high',
    level: '5.1',
  },
  high_quality: {
    id: 'high_quality',
    label: 'High Quality 1080p 60fps',
    description: 'Encoding lambat dengan CRF rendah dan 60fps untuk visual ultra halus.',
    quality: '1080p',
    width9x16: 1080,
    height9x16: 1920,
    fps: 60,
    videoCodec: 'libx264',
    preset: 'slow',
    crf: 17,
    maxrateKbps: 12000,
    bufsizeKbps: 24000,
    audioBitrateKbps: 256,
    profile: 'high',
    level: '4.2',
  },
};

export function resolveBalancedRenderProfile(
  profile?: string | null,
  fallbackQuality?: '1080p' | '4k'
): BalancedRenderProfileSpec {
  if (profile && profile in BALANCED_RENDER_PROFILES) {
    return BALANCED_RENDER_PROFILES[profile as BalancedRenderProfile];
  }
  return fallbackQuality === '4k'
    ? BALANCED_RENDER_PROFILES.balanced_4k
    : BALANCED_RENDER_PROFILES.balanced_1080p;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export interface SourceFingerprintInput {
  videoId?: string;
  sourceUrl?: string;
  uploadedFileHash?: string;
  startSec: number;
  endSec: number;
}

/**
 * Source fingerprint depends ONLY on the media source and clip time bounds.
 * Editing intro templates, subtitle styling, or camera framing preserves this fingerprint,
 * allowing full reuse of downloaded source footage and AI analysis without re-downloading or re-running AI.
 */
export function computeSourceFingerprint(input: SourceFingerprintInput): string {
  const payload = {
    videoId: input.videoId || '',
    sourceUrl: input.sourceUrl || '',
    uploadedFileHash: input.uploadedFileHash || '',
    startSec: Math.round(input.startSec * 100) / 100,
    endSec: Math.round(input.endSec * 100) / 100,
  };
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex').slice(0, 32);
}

export interface RenderFingerprintInput {
  sourceFingerprint: string;
  startSec: number;
  endSec: number;
  renderProfile: BalancedRenderProfile;
  resolution: string;
  codec: string;
  bitrateKbps: number;
  aspectRatio: string;
  captionConfig: unknown;
  introConfig: IntroTemplateDefinition | Record<string, unknown> | null;
  cameraSettings: Partial<CameraTrackingSettings> | null;
  speakerOverrides: unknown;
  layoutConfig: string;
  overlayStyle: unknown;
  audioSettings: unknown;
  pipelineVersion?: string;
}

/**
 * Deterministic 14-parameter Render Fingerprint.
 * Any change to resolution, codec, bitrate, caption, intro, camera, speaker, layout, overlay, audio,
 * or pipelineVersion produces a distinct fingerprint; identical renders hit cache immediately.
 */
export function computeRenderFingerprint(input: RenderFingerprintInput): string {
  const normalized = {
    sourceFingerprint: input.sourceFingerprint,
    range: `${Math.round(input.startSec * 100)}-${Math.round(input.endSec * 100)}`,
    renderProfile: input.renderProfile,
    resolution: input.resolution,
    codec: input.codec,
    bitrateKbps: input.bitrateKbps,
    aspectRatio: input.aspectRatio,
    captionConfig: input.captionConfig ?? null,
    introConfig: input.introConfig ?? null,
    cameraSettings: input.cameraSettings ?? null,
    speakerOverrides: input.speakerOverrides ?? null,
    layoutConfig: input.layoutConfig,
    overlayStyle: input.overlayStyle ?? null,
    audioSettings: input.audioSettings ?? null,
    pipelineVersion: input.pipelineVersion || RENDER_PIPELINE_VERSION,
  };
  return crypto.createHash('sha256').update(stableStringify(normalized)).digest('hex');
}
