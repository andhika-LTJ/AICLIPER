import type {
  ClipOverlayStyle,
  OverlayFontFamilyId,
  OverlayTextAlign,
  SubtitleBoxStyle,
} from '../types/clipper.ts';

export interface BundledFontPreset {
  id: OverlayFontFamilyId;
  label: string;
  description: string;
  assFontName: string;
  previewClassName: string;
}

export const BUNDLED_FONT_PRESETS: readonly BundledFontPreset[] = [
  {
    id: 'modern_sans',
    label: 'Modern Sans',
    description: 'Bersih & serbaguna (Default)',
    assFontName: 'Liberation Sans',
    previewClassName: 'font-sans tracking-normal',
  },
  {
    id: 'condensed_viral',
    label: 'Condensed Viral',
    description: 'Padat & tegas ala Shorts/TikTok',
    assFontName: 'Liberation Sans Narrow',
    previewClassName: 'font-sans tracking-tight scale-x-90 origin-center',
  },
  {
    id: 'editorial_serif',
    label: 'Editorial Serif',
    description: 'Elegan & sinematik dokumenter',
    assFontName: 'Liberation Serif',
    previewClassName: 'font-serif tracking-normal',
  },
  {
    id: 'studio_mono',
    label: 'Studio Mono',
    description: 'Gaya teknologi & berita studio',
    assFontName: 'Liberation Mono',
    previewClassName: 'font-mono tracking-tight',
  },
] as const;

export const DEFAULT_CLIP_OVERLAY_STYLE: ClipOverlayStyle = {
  fontFamily: 'modern_sans',
  textAlign: 'center',
  introDurationSec: 2.8,
  introPositionY: 50,
  introFontScale: 1.0,
  introAccentColor: '#EF4444',
  showTopTitle: true,
  showHookFooter: true,
  topTitlePositionY: 7,
  subtitlePositionY: 82,
  subtitleFontScale: 1.0,
  subtitleTextColor: '#FFFFFF',
  subtitleHighlightColor: '#FACC15',
  subtitleBoxStyle: 'outline',
};

export const SUBTITLE_TEXT_COLOR_PRESETS = [
  { label: 'Putih Bersih', hex: '#FFFFFF' },
  { label: 'Kuning Cerah', hex: '#FEF08A' },
  { label: 'Biru Langit', hex: '#BAE6FD' },
  { label: 'Mint Lembut', hex: '#BBF7D0' },
] as const;

export const HIGHLIGHT_COLOR_PRESETS = [
  { label: 'Emas Viral', hex: '#FACC15' },
  { label: 'Merah Studio', hex: '#EF4444' },
  { label: 'Cyan Terang', hex: '#38BDF8' },
  { label: 'Hijau Neon', hex: '#22C55E' },
  { label: 'Oranye Hangat', hex: '#FB923C' },
  { label: 'Putih Polos', hex: '#FFFFFF' },
] as const;

const VALID_FONTS = new Set<OverlayFontFamilyId>([
  'modern_sans',
  'condensed_viral',
  'editorial_serif',
  'studio_mono',
]);

const VALID_ALIGNS = new Set<OverlayTextAlign>(['left', 'center', 'right']);
const VALID_BOX_STYLES = new Set<SubtitleBoxStyle>(['outline', 'box', 'shadow']);

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function sanitizeHexColor(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim().toUpperCase();
  if (/^#[0-9A-F]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9A-F]{3}$/.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
  }
  return fallback;
}

export function normalizeClipOverlayStyle(
  raw?: Partial<ClipOverlayStyle> | null
): ClipOverlayStyle {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_CLIP_OVERLAY_STYLE };
  }

  const fontFamily: OverlayFontFamilyId = VALID_FONTS.has(raw.fontFamily as OverlayFontFamilyId)
    ? (raw.fontFamily as OverlayFontFamilyId)
    : DEFAULT_CLIP_OVERLAY_STYLE.fontFamily;

  const textAlign: OverlayTextAlign = VALID_ALIGNS.has(raw.textAlign as OverlayTextAlign)
    ? (raw.textAlign as OverlayTextAlign)
    : DEFAULT_CLIP_OVERLAY_STYLE.textAlign;

  const subtitleBoxStyle: SubtitleBoxStyle = VALID_BOX_STYLES.has(
    raw.subtitleBoxStyle as SubtitleBoxStyle
  )
    ? (raw.subtitleBoxStyle as SubtitleBoxStyle)
    : DEFAULT_CLIP_OVERLAY_STYLE.subtitleBoxStyle;

  const cleanText = (val: unknown, maxLen: number): string | undefined => {
    if (typeof val !== 'string') return undefined;
    const cleaned = val.replace(/\s+/g, ' ').trim().slice(0, maxLen);
    return cleaned.length > 0 ? cleaned : undefined;
  };

  return {
    fontFamily,
    textAlign,
    customIntroTag: cleanText(raw.customIntroTag, 28),
    customIntroHeadline: cleanText(raw.customIntroHeadline, 72),
    customIntroTeaser: cleanText(raw.customIntroTeaser, 140),
    introDurationSec: Number(
      clamp(
        Number.isFinite(Number(raw.introDurationSec))
          ? Number(raw.introDurationSec)
          : DEFAULT_CLIP_OVERLAY_STYLE.introDurationSec,
        2.0,
        4.5
      ).toFixed(1)
    ),
    introPositionY: Math.round(
      clamp(
        Number.isFinite(Number(raw.introPositionY))
          ? Number(raw.introPositionY)
          : DEFAULT_CLIP_OVERLAY_STYLE.introPositionY,
        22,
        76
      )
    ),
    introFontScale: Number(
      clamp(
        Number.isFinite(Number(raw.introFontScale))
          ? Number(raw.introFontScale)
          : DEFAULT_CLIP_OVERLAY_STYLE.introFontScale,
        0.75,
        1.35
      ).toFixed(2)
    ),
    introAccentColor: sanitizeHexColor(
      raw.introAccentColor,
      DEFAULT_CLIP_OVERLAY_STYLE.introAccentColor
    ),
    customTopTitle: cleanText(raw.customTopTitle, 72),
    showTopTitle:
      typeof raw.showTopTitle === 'boolean'
        ? raw.showTopTitle
        : DEFAULT_CLIP_OVERLAY_STYLE.showTopTitle,
    showHookFooter:
      typeof raw.showHookFooter === 'boolean'
        ? raw.showHookFooter
        : DEFAULT_CLIP_OVERLAY_STYLE.showHookFooter,
    topTitlePositionY: Math.round(
      clamp(
        Number.isFinite(Number(raw.topTitlePositionY))
          ? Number(raw.topTitlePositionY)
          : DEFAULT_CLIP_OVERLAY_STYLE.topTitlePositionY,
        4,
        28
      )
    ),
    subtitlePositionY: Math.round(
      clamp(
        Number.isFinite(Number(raw.subtitlePositionY))
          ? Number(raw.subtitlePositionY)
          : DEFAULT_CLIP_OVERLAY_STYLE.subtitlePositionY,
        15,
        90
      )
    ),
    subtitleFontScale: Number(
      clamp(
        Number.isFinite(Number(raw.subtitleFontScale))
          ? Number(raw.subtitleFontScale)
          : DEFAULT_CLIP_OVERLAY_STYLE.subtitleFontScale,
        0.75,
        1.45
      ).toFixed(2)
    ),
    subtitleTextColor: sanitizeHexColor(
      raw.subtitleTextColor,
      DEFAULT_CLIP_OVERLAY_STYLE.subtitleTextColor
    ),
    subtitleHighlightColor: sanitizeHexColor(
      raw.subtitleHighlightColor,
      DEFAULT_CLIP_OVERLAY_STYLE.subtitleHighlightColor
    ),
    subtitleBoxStyle,
  };
}

export function resolveAssFontName(fontFamily?: OverlayFontFamilyId): string {
  const found = BUNDLED_FONT_PRESETS.find((p) => p.id === fontFamily);
  return found?.assFontName ?? 'Liberation Sans';
}

/**
 * Converts a standard `#RRGGBB` hex color into ASS `&HAABBGGRR&` BGR format.
 * Notice ASS reverses RGB -> BGR!
 */
export function hexToAssColor(hex: string, alphaHex = '00'): string {
  const safe = sanitizeHexColor(hex, '#FFFFFF');
  const r = safe.slice(1, 3);
  const g = safe.slice(3, 5);
  const b = safe.slice(5, 7);
  const aa = /^[0-9A-Fa-f]{2}$/.test(alphaHex) ? alphaHex.toUpperCase() : '00';
  return `&H${aa}${b}${g}${r}&`;
}

/**
 * Converts a standard `#RRGGBB` hex color into FFmpeg `0xRRGGBB` format for `drawbox`.
 */
export function hexToFfmpegColor(hex: string): string {
  const safe = sanitizeHexColor(hex, '#EF4444');
  return `0x${safe.slice(1)}`;
}

/**
 * Computes exact, shared PlayRes + normalized coordinates for the AI Intro block and accent bar
 * so both libass text positioning and FFmpeg drawbox accent bar stay locked together at any Y/align.
 */
export function computeIntroAnchorLayout(params: {
  isLandscape: boolean;
  style?: Partial<ClipOverlayStyle> | null;
}): {
  playResX: number;
  playResY: number;
  anchorX: number;
  assAlign: 4 | 5 | 6;
  badgeY: number;
  barYRatio: number;
  barXRatio: number;
  barWRatio: number;
  headlineY: number;
  teaserY: number;
  channelY: number;
} {
  const { isLandscape } = params;
  const s = normalizeClipOverlayStyle(params.style);
  const playResX = isLandscape ? 1920 : 1080;
  const playResY = isLandscape ? 1080 : 1920;
  const sideMargin = isLandscape ? 130 : 76;

  const anchorX =
    s.textAlign === 'left'
      ? sideMargin
      : s.textAlign === 'right'
        ? playResX - sideMargin
        : Math.round(playResX / 2);
  const assAlign: 4 | 5 | 6 =
    s.textAlign === 'left' ? 4 : s.textAlign === 'right' ? 6 : 5;

  // Center of the intro visual stack shifts linearly with introPositionY (22..76%, default 50%)
  const centerY = Math.round((playResY * s.introPositionY) / 100);
  const scale = s.introFontScale;

  const badgeOffset = Math.round((isLandscape ? -200 : -260) * scale);
  const barOffset = Math.round((isLandscape ? -145 : -190) * scale);
  const headlineOffset = Math.round((isLandscape ? -15 : -30) * scale);
  const teaserOffset = Math.round((isLandscape ? 165 : 210) * scale);
  const channelOffset = Math.round((isLandscape ? 295 : 390) * scale);

  const clampY = (y: number) => Math.round(clamp(y, 60, playResY - 60));
  const barY = clampY(centerY + barOffset);
  const barWRatio = isLandscape ? 0.1 : 0.14;
  const sideMarginRatio = sideMargin / playResX;
  const barXRatio =
    s.textAlign === 'left'
      ? sideMarginRatio
      : s.textAlign === 'right'
        ? 1 - sideMarginRatio - barWRatio
        : (1 - barWRatio) / 2;

  return {
    playResX,
    playResY,
    anchorX,
    assAlign,
    badgeY: clampY(centerY + badgeOffset),
    barYRatio: Number((barY / playResY).toFixed(4)),
    barXRatio: Number(barXRatio.toFixed(4)),
    barWRatio,
    headlineY: clampY(centerY + headlineOffset),
    teaserY: clampY(centerY + teaserOffset),
    channelY: clampY(centerY + channelOffset),
  };
}

export function isCustomOverlayStyleActive(style?: Partial<ClipOverlayStyle> | null): boolean {
  if (!style) return false;
  const norm = normalizeClipOverlayStyle(style);
  return (
    norm.fontFamily !== DEFAULT_CLIP_OVERLAY_STYLE.fontFamily ||
    norm.textAlign !== DEFAULT_CLIP_OVERLAY_STYLE.textAlign ||
    Boolean(norm.customIntroTag) ||
    Boolean(norm.customIntroHeadline) ||
    Boolean(norm.customIntroTeaser) ||
    Boolean(norm.customTopTitle) ||
    norm.introDurationSec !== DEFAULT_CLIP_OVERLAY_STYLE.introDurationSec ||
    norm.introPositionY !== DEFAULT_CLIP_OVERLAY_STYLE.introPositionY ||
    norm.introFontScale !== DEFAULT_CLIP_OVERLAY_STYLE.introFontScale ||
    norm.introAccentColor !== DEFAULT_CLIP_OVERLAY_STYLE.introAccentColor ||
    norm.showTopTitle !== DEFAULT_CLIP_OVERLAY_STYLE.showTopTitle ||
    norm.showHookFooter !== DEFAULT_CLIP_OVERLAY_STYLE.showHookFooter ||
    norm.topTitlePositionY !== DEFAULT_CLIP_OVERLAY_STYLE.topTitlePositionY ||
    norm.subtitlePositionY !== DEFAULT_CLIP_OVERLAY_STYLE.subtitlePositionY ||
    norm.subtitleFontScale !== DEFAULT_CLIP_OVERLAY_STYLE.subtitleFontScale ||
    norm.subtitleTextColor !== DEFAULT_CLIP_OVERLAY_STYLE.subtitleTextColor ||
    norm.subtitleHighlightColor !== DEFAULT_CLIP_OVERLAY_STYLE.subtitleHighlightColor ||
    norm.subtitleBoxStyle !== DEFAULT_CLIP_OVERLAY_STYLE.subtitleBoxStyle
  );
}

/**
 * Deterministic compact fingerprint string for render-job deduplication so any manual change
 * to font, position, color, or intro text immediately triggers a fresh render job.
 */
export function computeOverlayStyleFingerprint(style?: Partial<ClipOverlayStyle> | null): string {
  const s = normalizeClipOverlayStyle(style);
  const raw = JSON.stringify(s);
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `sty_${(hash >>> 0).toString(36)}`;
}
