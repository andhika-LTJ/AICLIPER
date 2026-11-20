import type {
  CaptionCue,
  ClipRenderLayout,
  ClipRenderQuality,
  EmotionMoment,
} from '../src/types/clipper.ts';
import {
  buildEmotionAssEvents,
  findActiveEmotionAtTime,
  getEmotionTheme,
} from './emotionEffects.ts';

export interface SpeakerKeyframe {
  timeSec: number;
  /** Normalized horizontal center of active speaker (0.0 = left edge, 1.0 = right edge). */
  focusX: number;
  /** Normalized vertical center of speaker face/head (0.0 = top edge, 1.0 = bottom edge). */
  focusY: number;
  /** Zoom factor >= 1.0 applied to source video before cropping. */
  zoomScale: number;
  speakerLabel?: string;
  /** True when this keyframe begins right after a detected hard camera switch. */
  isSceneCut?: boolean;
  /** Optional Gemini 0..1000 bounding box [ymin, xmin, ymax, xmax] of active speaker's face. */
  faceBox?: [number, number, number, number];
}

export type CanonicalStudioLayout =
  | 'full_16_9_focus'
  | 'shorts_studio_focus'
  | 'shorts_full_bleed';

export type CanonicalRenderQuality = '1080p' | '4k';

export function normalizeRenderLayout(layout?: ClipRenderLayout): CanonicalStudioLayout {
  if (layout === 'full_16_9_focus' || layout === 'landscape_16_9') return 'full_16_9_focus';
  if (layout === 'shorts_studio_focus' || layout === 'vertical_9_16') return 'shorts_studio_focus';
  return 'shorts_full_bleed';
}

export function normalizeRenderQuality(
  quality?: ClipRenderQuality | string | null
): CanonicalRenderQuality {
  if (!quality) return '1080p';
  const normalized = String(quality).trim().toLowerCase();
  if (
    normalized === '4k' ||
    normalized === '2160p' ||
    normalized === 'ultra_hd' ||
    normalized === 'ultrahd' ||
    normalized === 'uhd'
  ) {
    return '4k';
  }
  return '1080p';
}

export function resolveEffectiveRenderQuality(params: {
  requestedQuality?: ClipRenderQuality | string | null;
  enableUltraHdRender?: boolean;
  defaultRenderQuality?: ClipRenderQuality | string | null;
}): CanonicalRenderQuality {
  if (params.requestedQuality) {
    return normalizeRenderQuality(params.requestedQuality);
  }
  if (params.enableUltraHdRender) {
    return '4k';
  }
  return normalizeRenderQuality(params.defaultRenderQuality);
}

export function getTargetCanvasDimensions(
  layout: CanonicalStudioLayout,
  quality: CanonicalRenderQuality
): { outW: number; outH: number } {
  const isLandscape = layout === 'full_16_9_focus';
  if (isLandscape) {
    return quality === '4k' ? { outW: 3840, outH: 2160 } : { outW: 1920, outH: 1080 };
  }
  return quality === '4k' ? { outW: 2160, outH: 3840 } : { outW: 1080, outH: 1920 };
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function roundEven(val: number): number {
  const n = Math.max(2, Math.round(val));
  return n % 2 === 0 ? n : n - 1;
}

/**
 * Converts Gemini's normalized 0..1000 face bounding box `[ymin, xmin, ymax, xmax]`
 * into precise horizontal/vertical focus coordinates and an adaptive zoom scale.
 */
export function computeFocusFromFaceBox(
  box: [number, number, number, number]
): { focusX: number; focusY: number; zoomScale: number } | null {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const [rawYmin, rawXmin, rawYmax, rawXmax] = box.map((n) => Number(n));
  if (![rawYmin, rawXmin, rawYmax, rawXmax].every(Number.isFinite)) return null;

  const ymin = clamp(Math.min(rawYmin, rawYmax), 0, 1000);
  const ymax = clamp(Math.max(rawYmin, rawYmax), 0, 1000);
  const xmin = clamp(Math.min(rawXmin, rawXmax), 0, 1000);
  const xmax = clamp(Math.max(rawXmin, rawXmax), 0, 1000);

  const faceW = (xmax - xmin) / 1000;
  const faceH = (ymax - ymin) / 1000;
  // Reject degenerate or full-frame boxes
  if (faceW < 0.02 || faceH < 0.03 || faceW > 0.85 || faceH > 0.92) {
    return null;
  }

  const focusX = clamp((xmin + xmax) / 2000, 0.08, 0.92);
  // Bias slightly below nose center so head has comfortable studio headroom below TitleCard
  const faceCenterY = (ymin + ymax) / 2000;
  const focusY = clamp(faceCenterY + Math.min(0.11, faceH * 0.35), 0.18, 0.72);

  // Adaptive zoom: closer framing for wide multi-person desks, relaxed for close-ups
  let zoomScale = 1.18;
  if (faceW < 0.11) {
    zoomScale = 1.36;
  } else if (faceW < 0.16) {
    zoomScale = 1.26;
  } else if (faceW < 0.24) {
    zoomScale = 1.14;
  } else {
    zoomScale = 1.04;
  }

  return {
    focusX: Number(focusX.toFixed(4)),
    focusY: Number(focusY.toFixed(4)),
    zoomScale: Number(zoomScale.toFixed(2)),
  };
}

/**
 * Computes exact even crop dimensions within sourceWidth x sourceHeight preserving target aspect ratio.
 */
export function computeCropWindow(
  sourceW: number,
  sourceH: number,
  targetAspectW: number,
  targetAspectH: number,
  zoomScale = 1.25
): { cropW: number; cropH: number } {
  const safeW = Math.max(64, Math.floor(sourceW));
  const safeH = Math.max(64, Math.floor(sourceH));
  const safeZoom = clamp(zoomScale, 1.0, 2.2);
  const targetRatio = targetAspectW / targetAspectH;
  const sourceRatio = safeW / safeH;

  let baseW: number;
  let baseH: number;
  if (sourceRatio >= targetRatio) {
    baseH = safeH;
    baseW = baseH * targetRatio;
  } else {
    baseW = safeW;
    baseH = baseW / targetRatio;
  }

  const cropW = Math.min(safeW, roundEven(baseW / safeZoom));
  const cropH = Math.min(safeH, roundEven(baseH / safeZoom));
  return { cropW, cropH };
}

/**
 * Normalizes, grounds via faceBox when available, suppresses single-frame tracking glitches
 * within the same camera shot, and spans keyframes cleanly across [0, durationSec].
 */
export function normalizeSpeakerKeyframes(
  raw: SpeakerKeyframe[],
  durationSec: number
): SpeakerKeyframe[] {
  const safeDur = Math.max(2, durationSec);
  if (!Array.isArray(raw) || raw.length === 0) {
    return [
      { timeSec: 0, focusX: 0.5, focusY: 0.38, zoomScale: 1.22 },
      { timeSec: safeDur, focusX: 0.5, focusY: 0.38, zoomScale: 1.22 },
    ];
  }

  const cleaned: SpeakerKeyframe[] = raw
    .map((k) => {
      const fromBox = k.faceBox ? computeFocusFromFaceBox(k.faceBox) : null;
      const focusX = fromBox
        ? fromBox.focusX
        : clamp(Number.isFinite(k.focusX) ? k.focusX : 0.5, 0.08, 0.92);
      const focusY = fromBox
        ? fromBox.focusY
        : clamp(Number.isFinite(k.focusY) ? k.focusY : 0.38, 0.18, 0.72);
      const zoomScale = fromBox
        ? fromBox.zoomScale
        : clamp(Number.isFinite(k.zoomScale) ? k.zoomScale : 1.22, 1.0, 1.65);

      return {
        timeSec: Number(clamp(Number(k.timeSec) || 0, 0, safeDur).toFixed(2)),
        focusX,
        focusY,
        zoomScale,
        speakerLabel: k.speakerLabel,
        isSceneCut: Boolean(k.isSceneCut),
        ...(k.faceBox ? { faceBox: k.faceBox } : {}),
      };
    })
    .sort((a, b) => a.timeSec - b.timeSec);

  // Deduplicate timestamps closer than 0.35s while preserving scene-cut flag
  const deduped: SpeakerKeyframe[] = [];
  for (const kf of cleaned) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(kf.timeSec - prev.timeSec) < 0.35) {
      deduped[deduped.length - 1] = {
        ...kf,
        isSceneCut: Boolean(prev.isSceneCut || kf.isSceneCut),
      };
    } else {
      deduped.push(kf);
    }
  }

  // Stabilize single-frame false-jump outliers inside the same continuous camera shot
  for (let i = 1; i < deduped.length - 1; i++) {
    const prev = deduped[i - 1];
    const cur = deduped[i];
    const next = deduped[i + 1];
    if (cur.isSceneCut || next.isSceneCut) continue;

    const spanSec = next.timeSec - prev.timeSec;
    const prevNextClose = Math.abs(prev.focusX - next.focusX) <= 0.11;
    const curOutlier =
      Math.abs(cur.focusX - prev.focusX) >= 0.24 &&
      Math.abs(cur.focusX - next.focusX) >= 0.24;

    if (spanSec <= 6.0 && prevNextClose && curOutlier) {
      deduped[i] = {
        ...cur,
        focusX: Number(((prev.focusX + next.focusX) / 2).toFixed(4)),
        focusY: Number(((prev.focusY + next.focusY) / 2).toFixed(4)),
      };
    }
  }

  if (deduped[0].timeSec > 0.05) {
    deduped.unshift({ ...deduped[0], timeSec: 0, isSceneCut: false });
  } else {
    deduped[0] = { ...deduped[0], timeSec: 0, isSceneCut: false };
  }

  const last = deduped[deduped.length - 1];
  if (last.timeSec < safeDur - 0.1) {
    deduped.push({ ...last, timeSec: safeDur, isSceneCut: false });
  }

  return deduped;
}

/**
 * Builds a hybrid piecewise-linear FFmpeg expression for dynamic crop X or Y tracking:
 * - Hard camera cuts (`isSceneCut: true`) snap cleanly in ~0.04s right on the cut frame
 *   so the frame never drags awkwardly across two unrelated camera angles.
 * - Within the same camera shot, speaker pans glide smoothly over `transitionSec` (0.36s).
 * - Micro-jitter (<= 10px movement) is held steady for tripod-like stability.
 */
export function buildSmoothCropAxisExpression(params: {
  keyframes: SpeakerKeyframe[];
  axis: 'x' | 'y';
  sourceSize: number;
  cropSize: number;
  transitionSec?: number;
  cutSnapSec?: number;
}): string {
  const {
    keyframes,
    axis,
    sourceSize,
    cropSize,
    transitionSec = 0.36,
    cutSnapSec = 0.04,
  } = params;
  const maxOffset = Math.max(0, Math.floor(sourceSize - cropSize));
  if (maxOffset === 0 || keyframes.length === 0) {
    return '0';
  }

  const toOffset = (kf: SpeakerKeyframe) => {
    const norm = axis === 'x' ? kf.focusX : kf.focusY;
    return Math.round(clamp(norm * sourceSize - cropSize / 2, 0, maxOffset));
  };

  // Expand keyframes into hold + snap/glide segments
  const nodes: Array<{ t: number; v: number }> = [];
  for (let i = 0; i < keyframes.length; i++) {
    const kf = keyframes[i];
    const rawVal = toOffset(kf);
    const curT = Number(kf.timeSec.toFixed(2));
    if (i === 0) {
      nodes.push({ t: curT, v: rawVal });
      continue;
    }

    const prevVal = nodes[nodes.length - 1].v;
    const prevT = nodes[nodes.length - 1].t;
    const gap = curT - prevT;

    // Suppress tiny sub-10px micro-jitter within the same shot
    const delta = Math.abs(rawVal - prevVal);
    if ((!kf.isSceneCut && delta <= 10) || delta <= 3 || gap <= 0.06) {
      nodes.push({ t: curT, v: delta <= 10 && !kf.isSceneCut ? prevVal : rawVal });
      continue;
    }

    const ramp = kf.isSceneCut
      ? Math.min(cutSnapSec, gap * 0.25)
      : Math.min(transitionSec, gap * 0.45);
    const holdUntil = Number((curT - ramp).toFixed(2));
    if (holdUntil > prevT + 0.03) {
      nodes.push({ t: holdUntil, v: prevVal });
    }
    nodes.push({ t: curT, v: rawVal });
  }

  // Collapse consecutive nodes into nested if(lt(t,...)) expression
  let expr = String(nodes[nodes.length - 1].v);
  for (let i = nodes.length - 2; i >= 0; i--) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const dt = Math.max(0.03, Number((b.t - a.t).toFixed(3)));
    const seg =
      a.v === b.v
        ? String(a.v)
        : `(${a.v}+(${b.v - a.v})*(t-${a.t.toFixed(2)})/${dt.toFixed(3)})`;
    expr = `if(lt(t,${b.t.toFixed(2)}),${seg},${expr})`;
  }

  return `min(max(0,${expr}),${maxOffset})`;
}

/**
 * Wraps a title cleanly into bounded lines for burned-in ASS overlays.
 */
export function wrapTitleLines(
  title: string,
  maxCharsPerLine = 32,
  maxLines = 2
): string[] {
  const words = title.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharsPerLine) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
      if (lines.length === maxLines - 1) {
        break;
      }
    }
  }

  if (lines.length < maxLines && current) {
    lines.push(current);
  }

  // If words remained beyond maxLines, ellipsis the last line cleanly
  const consumedCount = lines.join(' ').split(' ').length;
  if (consumedCount < words.length && lines.length > 0) {
    const lastIdx = lines.length - 1;
    const trimmed = lines[lastIdx].slice(0, Math.max(8, maxCharsPerLine - 1)).trimEnd();
    lines[lastIdx] = `${trimmed}…`;
  }

  return lines.slice(0, maxLines);
}

/**
 * Normalizes transcribed subtitle cues: monotonic, non-overlapping, clamped to clipDurationSec.
 * Preserves each cue's true audio onset time by trimming an earlier cue's tail on overlap
 * instead of pushing subsequent cues forward (which caused cumulative subtitle lag).
 */
export function normalizeTranscribedCues(
  rawCues: CaptionCue[],
  clipDurationSec: number
): CaptionCue[] {
  const safeDur = Math.max(3, clipDurationSec);
  const sorted = (rawCues ?? [])
    .filter((c) => c && typeof c.text === 'string' && c.text.trim().length > 0)
    .map((c) => ({
      offsetSec: Math.max(0, Number(c.offsetSec) || 0),
      durationSec: Math.max(0.45, Number(c.durationSec) || 2.2),
      text: c.text.replace(/\s+/g, ' ').trim(),
    }))
    .filter((c) => c.offsetSec < safeDur - 0.2)
    .sort((a, b) => a.offsetSec - b.offsetSec);

  const normalized: CaptionCue[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = { ...sorted[i] };
    const prev = normalized[normalized.length - 1];
    if (prev) {
      const prevEnd = prev.offsetSec + prev.durationSec;
      if (cur.offsetSec < prevEnd) {
        const gap = cur.offsetSec - prev.offsetSec;
        if (gap >= 0.35) {
          prev.durationSec = Number(gap.toFixed(2));
        } else {
          cur.offsetSec = Number((prev.offsetSec + 0.35).toFixed(2));
          prev.durationSec = 0.35;
        }
      }
    }
    if (cur.offsetSec >= safeDur - 0.2) break;

    const nextStart = i + 1 < sorted.length ? sorted[i + 1].offsetSec : safeDur;
    const maxAllowedDur = Math.max(
      0.35,
      Math.min(safeDur - cur.offsetSec, Math.max(0.45, nextStart - cur.offsetSec))
    );
    const dur = Math.min(cur.durationSec, maxAllowedDur);

    normalized.push({
      offsetSec: Number(cur.offsetSec.toFixed(2)),
      durationSec: Number(Math.max(0.35, dur).toFixed(2)),
      text: cur.text,
    });
  }

  return normalized;
}

function formatAssTime(totalSeconds: number): string {
  const safeCs = Math.max(0, Math.round(totalSeconds * 100));
  const hours = Math.floor(safeCs / 360000);
  const minutes = Math.floor((safeCs % 360000) / 6000);
  const seconds = Math.floor((safeCs % 6000) / 100);
  const cs = safeCs % 100;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${hours}:${p2(minutes)}:${p2(seconds)}.${p2(cs)}`;
}

function escapeAssText(text: string): string {
  return text.replace(/\{/g, '(').replace(/\}/g, ')').replace(/\r?\n/g, ' ').trim();
}

/**
 * Highlights the strongest keyword in a subtitle line with an emotion-synced accent color
 * and adds a subtle kinetic elastic pop-in when emotion effects are enabled.
 */
function styleSubtitleLineAss(
  text: string,
  accentColor = '&H0038BDF8&',
  enableKineticBounce = true
): string {
  const clean = escapeAssText(text);
  const words = clean.split(' ').filter(Boolean);
  const bouncePrefix = enableKineticBounce
    ? '{\\fscx93\\fscy93\\t(0,110,\\fscx103\\fscy103)\\t(110,180,\\fscx100\\fscy100)}'
    : '';

  if (words.length <= 2) {
    return `${bouncePrefix}${words.join(' ')}`;
  }

  // Pick the longest content word (>= 4 chars) to emphasize
  let bestIdx = -1;
  let bestLen = 3;
  words.forEach((w, idx) => {
    const stripped = w.replace(/[^a-zA-Z0-9]/g, '');
    if (stripped.length > bestLen) {
      bestLen = stripped.length;
      bestIdx = idx;
    }
  });
  if (bestIdx === -1) return `${bouncePrefix}${clean}`;

  const highlighted = words
    .map((w, idx) =>
      idx === bestIdx ? `{\\c${accentColor}}${w}{\\c&H00FFFFFF&}` : w
    )
    .join(' ');
  return `${bouncePrefix}${highlighted}`;
}

/**
 * Generates a studio-grade ASS subtitle + title + channel badge + caption footer
 * + kinetic AI Emotion Callout script (zero red borders).
 */
export function generateStudioAssScript(params: {
  layout: CanonicalStudioLayout;
  title: string;
  channelName: string;
  hookCaption: string;
  cues: CaptionCue[];
  durationSec: number;
  emotionMoments?: EmotionMoment[];
  enableEmotionEffects?: boolean;
}): string {
  const {
    layout,
    title,
    channelName,
    hookCaption,
    cues,
    durationSec,
    emotionMoments = [],
    enableEmotionEffects = true,
  } = params;
  const safeDur = Math.max(3, durationSec);
  const endTs = formatAssTime(safeDur);

  const isLandscape = layout === 'full_16_9_focus';
  const playResX = isLandscape ? 1920 : 1080;
  const playResY = isLandscape ? 1080 : 1920;

  const cleanChannel = escapeAssText(channelName || 'Podcast').slice(0, 28).toUpperCase();
  const titleLines = wrapTitleLines(
    escapeAssText(title),
    isLandscape ? 52 : 28,
    2
  ).join('\\N');
  const footerLine = wrapTitleLines(escapeAssText(hookCaption), isLandscape ? 96 : 44, 1)[0] ?? '';

  const styles = isLandscape
    ? `[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ChannelTag,DejaVu Sans,22,&H00E2E8F0,&H000000FF,&H00090D16,&HAA090D16,1,0,0,0,100,100,0.8,0,1,2,1,7,44,44,28,1
Style: TitleCard,DejaVu Sans,34,&H00FFFFFF,&H000000FF,&H00090D16,&HDD090D16,1,0,0,0,100,100,0,0,1,3,1.5,9,480,44,20,1
Style: EmotionCallout,DejaVu Sans,36,&H0024D4FF,&H000000FF,&H00090D16,&HBB090D16,1,0,0,0,100,100,1.2,0,1,4,2,5,44,44,24,1
Style: SubtitleBox,DejaVu Sans,48,&H00FFFFFF,&H0000D7FF,&H00090D16,&HBB090D16,1,0,0,0,100,100,0,0,1,4.2,2,2,180,180,108,1
Style: HookFooter,DejaVu Sans,24,&H00CBD5E1,&H000000FF,&H00090D16,&HAA090D16,0,0,0,0,100,100,0,0,1,2.2,1,2,60,60,24,1`
    : layout === 'shorts_studio_focus'
      ? `[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ChannelTag,DejaVu Sans,24,&H00E2E8F0,&H000000FF,&H00090D16,&HAA090D16,1,0,0,0,100,100,1.0,0,1,2.2,1.5,8,64,64,86,1
Style: TitleCard,DejaVu Sans,48,&H00FFFFFF,&H000000FF,&H00090D16,&HBB090D16,1,0,0,0,100,100,0,0,1,3.5,2,8,64,64,148,1
Style: EmotionCallout,DejaVu Sans,40,&H0024D4FF,&H000000FF,&H00090D16,&HBB090D16,1,0,0,0,100,100,1.4,0,1,4.2,2.2,5,64,64,48,1
Style: SubtitleBox,DejaVu Sans,54,&H00FFFFFF,&H0000D7FF,&H00090D16,&HBB090D16,1,0,0,0,100,100,0,0,1,4.5,2.5,2,68,68,285,1
Style: HookFooter,DejaVu Sans,25,&H00CBD5E1,&H000000FF,&H00090D16,&HAA090D16,0,0,0,0,100,100,0,0,1,2.2,1.5,2,68,68,128,1`
      : `[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ChannelTag,DejaVu Sans,24,&H00E2E8F0,&H000000FF,&H00090D16,&H99090D16,1,0,0,0,100,100,1.0,0,1,2.2,1.5,8,64,64,72,1
Style: TitleCard,DejaVu Sans,46,&H00FFFFFF,&H000000FF,&H00090D16,&HAA090D16,1,0,0,0,100,100,0,0,1,3.5,2,8,64,64,126,1
Style: EmotionCallout,DejaVu Sans,40,&H0024D4FF,&H000000FF,&H00090D16,&HAA090D16,1,0,0,0,100,100,1.4,0,1,4.2,2.2,5,64,64,48,1
Style: SubtitleBox,DejaVu Sans,54,&H00FFFFFF,&H0000D7FF,&H00090D16,&HAA090D16,1,0,0,0,100,100,0,0,1,4.5,2.5,2,72,72,272,1
Style: HookFooter,DejaVu Sans,25,&H00E2E8F0,&H000000FF,&H00090D16,&H99090D16,0,0,0,0,100,100,0,0,1,2.2,1.5,2,72,72,118,1`;

  const events: string[] = [
    `Dialogue: 1,0:00:00.00,${endTs},ChannelTag,,0,0,0,,${cleanChannel} · PODCAST CLIP`,
  ];

  if (titleLines) {
    events.push(`Dialogue: 1,0:00:00.00,${endTs},TitleCard,,0,0,0,,${titleLines}`);
  }

  if (footerLine) {
    events.push(`Dialogue: 1,0:00:00.00,${endTs},HookFooter,,0,0,0,,${footerLine}`);
  }

  const activeEmotions = enableEmotionEffects ? emotionMoments : [];
  const normalizedCues = normalizeTranscribedCues(cues, safeDur);
  for (const cue of normalizedCues) {
    const start = formatAssTime(cue.offsetSec);
    const end = formatAssTime(Math.min(safeDur, cue.offsetSec + cue.durationSec));
    const matchingEmotion =
      activeEmotions.length > 0
        ? findActiveEmotionAtTime(activeEmotions, cue.offsetSec)
        : null;
    const accentColor = matchingEmotion
      ? getEmotionTheme(matchingEmotion.emotion).assPrimaryColor
      : '&H0038BDF8&';
    const styled = styleSubtitleLineAss(cue.text, accentColor, enableEmotionEffects);
    events.push(`Dialogue: 2,${start},${end},SubtitleBox,,0,0,0,,${styled}`);
  }

  if (activeEmotions.length > 0) {
    events.push(
      ...buildEmotionAssEvents({
        moments: activeEmotions,
        layout,
        durationSec: safeDur,
      })
    );
  }

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
WrapStyle: 1

${styles}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`;
}

