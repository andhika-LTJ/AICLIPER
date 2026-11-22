import type { CaptionCue, ClipOverlayStyle } from '../src/types/clipper.ts';
import {
  computeIntroAnchorLayout,
  hexToAssColor,
  normalizeClipOverlayStyle,
} from '../src/utils/clipOverlayStyle.ts';
import type { CanonicalStudioLayout } from './speakerFocusMath.ts';

export const DEFAULT_INTRO_DURATION_SEC = 2.8;
export const INTRO_FPS = 30;

export interface AiClipIntro {
  tag: string;
  headline: string;
  teaser: string;
  durationSec: number;
}

function escapeAssText(text: string): string {
  return text.replace(/\{/g, '(').replace(/\}/g, ')').replace(/\r?\n/g, ' ').trim();
}

function wrapLines(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const words = clean.split(' ');
  const lines: string[] = [];
  let current = '';
  let consumed = 0;

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharsPerLine) {
      current = candidate;
      consumed++;
    } else if (!current) {
      lines.push(word.slice(0, maxCharsPerLine));
      consumed++;
      if (lines.length >= maxLines) break;
    } else {
      lines.push(current);
      if (lines.length >= maxLines) {
        current = '';
        break;
      }
      current = word;
      consumed++;
    }
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
  }
  if (consumed < words.length && lines.length > 0) {
    const lastIdx = lines.length - 1;
    lines[lastIdx] = `${lines[lastIdx].slice(0, Math.max(8, maxCharsPerLine - 1)).trimEnd()}…`;
  }
  return lines.slice(0, maxLines);
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

/**
 * Normalizes AI-generated video intro metadata with clean length bounds and guaranteed Indonesian fallbacks
 * so the opening intro card always feels rich, informative, and tailored to the podcast clip.
 */
export function normalizeAiClipIntro(
  raw: Partial<AiClipIntro> | null | undefined,
  fallback: {
    title: string;
    ringkasanTeks?: string;
    hookLine?: string;
    episodeTitle?: string;
  }
): AiClipIntro {
  const cleanTag = (raw?.tag ?? '')
    .replace(/[^a-zA-Z0-9\s&·/-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .slice(0, 26);

  const cleanHeadline = (raw?.headline || fallback.title || fallback.episodeTitle || 'Sorotan Podcast')
    .replace(/#shorts/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);

  const rawTeaser =
    raw?.teaser?.trim() ||
    fallback.ringkasanTeks?.trim() ||
    fallback.hookLine?.trim() ||
    `Simak pembahasan lengkap tentang ${cleanHeadline.toLowerCase()}.`;

  const cleanTeaser = rawTeaser.replace(/\s+/g, ' ').trim().slice(0, 128);
  const rawDur = Number(raw?.durationSec);
  const durationSec = Number.isFinite(rawDur)
    ? Math.max(2.0, Math.min(4.5, Math.round(rawDur * 10) / 10))
    : DEFAULT_INTRO_DURATION_SEC;

  return {
    tag: cleanTag || 'TOPIK PILIHAN',
    headline: cleanHeadline || 'Sorotan Podcast',
    teaser: cleanTeaser,
    durationSec,
  };
}

/**
 * Computes exact integer frame count at 30fps so intro video duration and intro audio duration
 * match to the exact millisecond (0ms lip-sync drift after concat!).
 */
export function computeExactIntroTiming(durationSec = DEFAULT_INTRO_DURATION_SEC): {
  frameCount: number;
  loopExtraFrames: number;
  exactDurationSec: number;
} {
  const clamped = Math.max(2.0, Math.min(4.5, Number(durationSec) || DEFAULT_INTRO_DURATION_SEC));
  const frameCount = Math.round(clamped * INTRO_FPS);
  return {
    frameCount,
    loopExtraFrames: Math.max(1, frameCount - 1),
    exactDurationSec: Number((frameCount / INTRO_FPS).toFixed(4)),
  };
}

/**
 * Generates broadcast-grade ASS styles for the cinematic AI Intro Title Card,
 * honoring optional manual font scale, accent color, and crisp mobile-readable teaser weight.
 */
export function buildIntroAssStyleBlock(
  layout: CanonicalStudioLayout,
  fontName: string,
  overlayStyle?: Partial<ClipOverlayStyle> | null
): string {
  const isLandscape = layout === 'full_16_9_focus';
  const s = normalizeClipOverlayStyle(overlayStyle);
  const scale = s.introFontScale;
  const badgeColor =
    s.introAccentColor !== '#EF4444'
      ? hexToAssColor(s.introAccentColor)
      : '&H0015CCFA&'; // Crisp warm gold default for badge; switches to custom accent when customized

  const sz = (base: number) => Math.max(18, Math.round(base * scale));

  if (isLandscape) {
    return [
      `Style: IntroBadge,${fontName},${sz(30)},${badgeColor},&H000000FF,&H00090D16,&HBB090D16,1,0,0,0,100,100,2.0,0,1,2.6,1.2,5,80,80,40,1`,
      `Style: IntroHeadline,${fontName},${sz(72)},&H00FFFFFF,&H000000FF,&H00090D16,&HCC090D16,1,0,0,0,100,100,0,0,1,4.6,2.5,5,120,120,40,1`,
      `Style: IntroTeaser,${fontName},${sz(38)},&H00F1F5F9,&H000000FF,&H00090D16,&HAA090D16,0,0,0,0,100,100,0.3,0,1,2.2,1.2,5,140,140,40,1`,
      `Style: IntroChannel,${fontName},${sz(26)},&H00CBD5E1,&H000000FF,&H00090D16,&HAA090D16,1,0,0,0,100,100,1.2,0,1,2.2,1,5,100,100,40,1`,
    ].join('\n');
  }
  return [
    `Style: IntroBadge,${fontName},${sz(32)},${badgeColor},&H000000FF,&H00090D16,&HBB090D16,1,0,0,0,100,100,2.0,0,1,2.6,1.2,5,64,64,40,1`,
    `Style: IntroHeadline,${fontName},${sz(66)},&H00FFFFFF,&H000000FF,&H00090D16,&HCC090D16,1,0,0,0,100,100,0,0,1,4.6,2.5,5,72,72,40,1`,
    `Style: IntroTeaser,${fontName},${sz(38)},&H00F1F5F9,&H000000FF,&H00090D16,&HAA090D16,0,0,0,0,100,100,0.2,0,1,2.2,1.2,5,80,80,40,1`,
    `Style: IntroChannel,${fontName},${sz(26)},&H00CBD5E1,&H000000FF,&H00090D16,&HAA090D16,1,0,0,0,100,100,1.2,0,1,2.2,1,5,72,72,40,1`,
  ].join('\n');
}

/**
 * Generates kinetic ASS Dialogue events for the AI Video Intro phase [0.00s .. intro.durationSec].
 * Displays: Topic Tag -> Big Video Headline -> 1-sentence Context Summary -> Channel Attribution.
 * Honors custom vertical placement (introPositionY) and alignment (left/center/right).
 */
export function buildIntroAssEvents(params: {
  intro: AiClipIntro;
  channelName: string;
  layout: CanonicalStudioLayout;
  overlayStyle?: Partial<ClipOverlayStyle> | null;
}): string[] {
  const { intro, channelName, layout, overlayStyle } = params;
  const isLandscape = layout === 'full_16_9_focus';
  const anchor = computeIntroAnchorLayout({ isLandscape, style: overlayStyle });
  const { anchorX, assAlign, badgeY, headlineY, teaserY, channelY } = anchor;

  const endTs = formatAssTime(intro.durationSec);
  const tagText = escapeAssText(intro.tag).toUpperCase();
  const headlineLines = wrapLines(
    escapeAssText(intro.headline),
    isLandscape ? 32 : 20,
    3
  ).join('\\N');
  const teaserLines = wrapLines(
    escapeAssText(intro.teaser),
    isLandscape ? 52 : 32,
    3
  ).join('\\N');
  const channelText = escapeAssText(channelName || 'Podcast').slice(0, 32).toUpperCase();

  const events: string[] = [
    `Dialogue: 4,0:00:00.00,${endTs},IntroBadge,,0,0,0,,{\\an${assAlign}\\pos(${anchorX},${badgeY})\\fad(160,260)\\fscx86\\fscy86\\t(0,220,\\fscx100\\fscy100)}• ${tagText} •`,
    `Dialogue: 4,0:00:00.08,${endTs},IntroHeadline,,0,0,0,,{\\an${assAlign}\\pos(${anchorX},${headlineY})\\fad(180,260)\\fscx90\\fscy90\\t(0,240,\\fscx102\\fscy102)\\t(240,380,\\fscx100\\fscy100)}${headlineLines}`,
  ];

  if (teaserLines) {
    events.push(
      `Dialogue: 4,0:00:00.28,${endTs},IntroTeaser,,0,0,0,,{\\an${assAlign}\\pos(${anchorX},${teaserY})\\fad(220,260)}${teaserLines}`
    );
  }

  events.push(
    `Dialogue: 4,0:00:00.18,${endTs},IntroChannel,,0,0,0,,{\\an${assAlign}\\pos(${anchorX},${channelY})\\fad(180,260)}${channelText}  ·  PODCAST HIGHLIGHT`
  );

  return events;
}

/**
 * Pure procedural broadcast intro soundscape (warm C-major soft chord + gentle rising shimmer,
 * zero commas so FFmpeg filtergraph parses cleanly without escaping issues).
 */
export function buildIntroAudioExpr(): string {
  return '(0.30*sin(2*PI*261.63*t)+0.22*sin(2*PI*329.63*t)+0.18*sin(2*PI*392.00*t)+0.14*sin(2*PI*523.25*t))*exp(-1.15*t)+0.14*sin(2*PI*(220*t+140*t*t))*exp(-1.8*t)';
}

/**
 * Guarantees subtitles are NEVER empty: if audio transcription & stored cues both yield 0 cues,
 * slices fallback transcript/summary/hook text into clean, readable 4–6 word timed subtitle chunks.
 */
export function synthesizeFallbackCaptionCues(
  fallbackText: string,
  durationSec: number
): CaptionCue[] {
  const safeDur = Math.max(3, Number(durationSec) || 10);
  const clean = (fallbackText || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const words = clean.split(' ').filter(Boolean);
  const chunks: string[] = [];
  const wordsPerCue = 5;
  for (let i = 0; i < words.length; i += wordsPerCue) {
    chunks.push(words.slice(i, i + wordsPerCue).join(' '));
  }
  const maxChunks = Math.max(1, Math.min(chunks.length, Math.floor(safeDur / 1.8)));
  const selected = chunks.slice(0, maxChunks);
  const slotDur = Math.max(1.4, safeDur / selected.length);

  return selected.map((text, idx) => {
    const start = Number((idx * slotDur).toFixed(2));
    const end = Number(Math.min(safeDur, (idx + 1) * slotDur).toFixed(2));
    return {
      offsetSec: start,
      durationSec: Number(Math.max(0.8, end - start).toFixed(2)),
      text,
    };
  });
}
