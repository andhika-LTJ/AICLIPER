import type { EmotionMoment, EmotionSfxStyle, EmotionType } from '../src/types/clipper.ts';
import type { CanonicalStudioLayout } from './speakerFocusMath.ts';

export interface EmotionVisualTheme {
  emotion: EmotionType;
  labelId: string;
  symbol: string;
  /** ASS BGR hex color (&H00BBGGRR&) for primary callout accent & subtitle emphasis. */
  assPrimaryColor: string;
  /** ASS BGR hex color for callout border glow. */
  assOutlineColor: string;
  defaultSfx: EmotionSfxStyle;
}

const VALID_EMOTIONS: readonly EmotionType[] = [
  'funny',
  'shock',
  'hype',
  'dramatic',
  'warm',
  'insight',
];

const VALID_SFX: readonly EmotionSfxStyle[] = [
  'pop_spark',
  'vine_boom',
  'whoosh_riser',
  'chime_insight',
  'chuckle_pop',
  'heartbeat_hit',
];

export const EMOTION_THEMES: Record<EmotionType, EmotionVisualTheme> = {
  funny: {
    emotion: 'funny',
    labelId: 'Lucu / Ngakak',
    symbol: '★',
    assPrimaryColor: '&H0024D4FF&', // Warm bright gold
    assOutlineColor: '&H00121826&',
    defaultSfx: 'pop_spark',
  },
  shock: {
    emotion: 'shock',
    labelId: 'Plot Twist / Kaget',
    symbol: '⚡',
    assPrimaryColor: '&H003B82FF&', // Vibrant amber-orange
    assOutlineColor: '&H00090D16&',
    defaultSfx: 'vine_boom',
  },
  hype: {
    emotion: 'hype',
    labelId: 'Semangat / Hype',
    symbol: '▲',
    assPrimaryColor: '&H0022E6F5&', // Electric yellow-gold
    assOutlineColor: '&H00090D16&',
    defaultSfx: 'whoosh_riser',
  },
  dramatic: {
    emotion: 'dramatic',
    labelId: 'Tegang / Serius',
    symbol: '◆',
    assPrimaryColor: '&H007185FF&', // Warm coral-amber (not harsh red box)
    assOutlineColor: '&H00090D16&',
    defaultSfx: 'heartbeat_hit',
  },
  warm: {
    emotion: 'warm',
    labelId: 'Hangat / Relate',
    symbol: '✦',
    assPrimaryColor: '&H0099F36E&', // Soft studio mint green
    assOutlineColor: '&H00090D16&',
    defaultSfx: 'chuckle_pop',
  },
  insight: {
    emotion: 'insight',
    labelId: 'Poin Emas / Insight',
    symbol: '✦',
    assPrimaryColor: '&H00F8BD38&', // Crisp sky cyan
    assOutlineColor: '&H00090D16&',
    defaultSfx: 'chime_insight',
  },
};

export function getEmotionTheme(emotion: EmotionType): EmotionVisualTheme {
  return EMOTION_THEMES[emotion] ?? EMOTION_THEMES.insight;
}

export function getSfxIndonesianLabel(sfx: EmotionSfxStyle): string {
  switch (sfx) {
    case 'vine_boom':
      return 'Bass Drop';
    case 'pop_spark':
      return 'Pop Komedi';
    case 'whoosh_riser':
      return 'Whoosh Riser';
    case 'chime_insight':
      return 'Ding Insight';
    case 'chuckle_pop':
      return 'Chime Hangat';
    case 'heartbeat_hit':
      return 'Pulse Dramatis';
  }
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function sanitizeBadgeText(raw: string, emotion: EmotionType): string {
  const cleaned = raw
    .replace(/[{}\r\n\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 26);
  if (cleaned.length >= 2) return cleaned.toUpperCase();
  switch (emotion) {
    case 'funny':
      return 'NGAKAK!';
    case 'shock':
      return 'PLOT TWIST!';
    case 'hype':
      return 'PECAH BANGET!';
    case 'dramatic':
      return 'FAKTA KERAS!';
    case 'warm':
      return 'RELATE BANGET';
    case 'insight':
      return 'POIN EMAS';
  }
}

/**
 * Normalizes AI-detected emotion moments: validates enums, clamps within clip duration,
 * enforces minimum spacing (>= 4.0s apart) so audio SFX & animations feel tasteful and punchy,
 * and caps to at most 6 beats per clip.
 */
export function normalizeEmotionMoments(
  raw: Partial<EmotionMoment>[],
  clipDurationSec: number
): EmotionMoment[] {
  const safeDur = Math.max(4, clipDurationSec);
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const parsed = raw
    .map((m) => {
      const emotion: EmotionType = VALID_EMOTIONS.includes(m.emotion as EmotionType)
        ? (m.emotion as EmotionType)
        : 'insight';
      const theme = getEmotionTheme(emotion);
      const sfxStyle: EmotionSfxStyle = VALID_SFX.includes(m.sfxStyle as EmotionSfxStyle)
        ? (m.sfxStyle as EmotionSfxStyle)
        : theme.defaultSfx;
      const timeSec = clamp(Number(m.timeSec) || 0, 1.0, Math.max(1.2, safeDur - 1.6));
      const durationSec = clamp(Number(m.durationSec) || 2.0, 1.3, 2.8);
      const intensity = clamp(Number(m.intensity) || 0.78, 0.45, 1.0);
      return {
        timeSec: Number(timeSec.toFixed(2)),
        durationSec: Number(Math.min(durationSec, safeDur - timeSec).toFixed(2)),
        emotion,
        badgeText: sanitizeBadgeText(String(m.badgeText ?? ''), emotion),
        sfxStyle,
        intensity: Number(intensity.toFixed(2)),
      };
    })
    .filter((m) => m.durationSec >= 0.8)
    .sort((a, b) => a.timeSec - b.timeSec);

  const spaced: EmotionMoment[] = [];
  for (const moment of parsed) {
    const prev = spaced[spaced.length - 1];
    if (prev && moment.timeSec - prev.timeSec < 4.0) {
      // Keep the higher-intensity moment when two beats collide
      if (moment.intensity > prev.intensity) {
        spaced[spaced.length - 1] = moment;
      }
      continue;
    }
    spaced.push(moment);
    if (spaced.length >= 6) break;
  }

  return spaced;
}

/**
 * Finds the active emotion moment overlapping a subtitle timestamp (if any),
 * so subtitle keyword highlighting automatically shifts color to match the emotional beat.
 */
export function findActiveEmotionAtTime(
  moments: EmotionMoment[],
  timeSec: number
): EmotionMoment | null {
  for (const m of moments) {
    if (timeSec >= m.timeSec - 0.35 && timeSec <= m.timeSec + m.durationSec + 0.35) {
      return m;
    }
  }
  return null;
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
 * Generates kinetic animated ASS emotion callout dialogue events (`EmotionCallout` style).
 * Uses elastic pop-in scale animation, subtle upward float, and smooth fade-out in the safe upper zone
 * (below TitleCard and above the speaker's eyes) so the face is never obstructed.
 */
export function buildEmotionAssEvents(params: {
  moments: EmotionMoment[];
  layout: CanonicalStudioLayout;
  durationSec: number;
}): string[] {
  const { moments, layout, durationSec } = params;
  if (!Array.isArray(moments) || moments.length === 0) return [];

  const isLandscape = layout === 'full_16_9_focus';
  // Safe coordinates in PlayRes space (1920x1080 landscape or 1080x1920 vertical)
  const centerX = isLandscape ? 960 : 540;
  const startY = isLandscape ? 195 : layout === 'shorts_studio_focus' ? 320 : 280;
  const endY = startY - (isLandscape ? 14 : 20);

  return moments.map((m) => {
    const theme = getEmotionTheme(m.emotion);
    const startTs = formatAssTime(m.timeSec);
    const endTs = formatAssTime(Math.min(durationSec, m.timeSec + m.durationSec));
    const displayText = `${theme.symbol} ${m.badgeText} ${theme.symbol}`;
    // Kinetic elastic scale-in + subtle float + clean fade
    const animTags = [
      '\\an5',
      `\\move(${centerX},${startY},${centerX},${endY},0,1400)`,
      `\\c${theme.assPrimaryColor}`,
      `\\3c${theme.assOutlineColor}`,
      '\\fad(120,260)',
      '\\fscx64\\fscy64',
      '\\t(0,140,\\fscx108\\fscy108)',
      '\\t(140,240,\\fscx100\\fscy100)',
    ].join('');

    return `Dialogue: 3,${startTs},${endTs},EmotionCallout,,0,0,0,,{${animTags}}${displayText}`;
  });
}

interface ProceduralSfxSpec {
  expr: string;
  durationSec: number;
  baseGain: number;
}

/**
 * Pure procedural audio synthesis expressions (zero commas so FFmpeg filtergraph never misparses)
 * for subtle broadcast-safe retention SFX accents.
 */
function getProceduralSfxSpec(style: EmotionSfxStyle): ProceduralSfxSpec {
  switch (style) {
    case 'vine_boom':
      return {
        // Punchy cinematic sub-bass drop (92Hz -> 44Hz)
        expr: '0.58*sin(2*PI*(92*t-34*t*t))*exp(-5.4*t)+0.28*sin(2*PI*46*t)*exp(-4.2*t)',
        durationSec: 0.62,
        baseGain: 0.32,
      };
    case 'pop_spark':
      return {
        // Playful upward comedic pop (520Hz -> 1040Hz)
        expr: '0.46*sin(2*PI*(520*t+960*t*t))*exp(-14.5*t)+0.24*sin(2*PI*1040*t)*exp(-18*t)',
        durationSec: 0.26,
        baseGain: 0.26,
      };
    case 'whoosh_riser':
      return {
        // Smooth airy rising swell
        expr: '(0.32*sin(2*PI*(240*t+640*t*t))+0.18*sin(2*PI*(480*t+920*t*t)))*sin(PI*t/0.40)*exp(-1.2*t)',
        durationSec: 0.40,
        baseGain: 0.24,
      };
    case 'chime_insight':
      return {
        // Warm shimmering A-major insight bell
        expr: '(0.28*sin(2*PI*880*t)+0.18*sin(2*PI*1318.5*t)+0.12*sin(2*PI*1760*t))*exp(-6.0*t)',
        durationSec: 0.52,
        baseGain: 0.22,
      };
    case 'chuckle_pop':
      return {
        // Friendly warm C-major sparkle chime
        expr: '(0.30*sin(2*PI*523.25*t)+0.22*sin(2*PI*659.25*t)+0.12*sin(2*PI*783.99*t))*exp(-8.5*t)',
        durationSec: 0.36,
        baseGain: 0.22,
      };
    case 'heartbeat_hit':
      return {
        // Double low cinematic pulse (no commas, Gaussian second hit)
        expr: '0.50*sin(2*PI*65*t)*exp(-14*t)+0.46*sin(2*PI*58*t)*exp(-120*(t-0.23)*(t-0.23))',
        durationSec: 0.54,
        baseGain: 0.30,
      };
  }
}

/**
 * Builds an FFmpeg audio filter_complex fragment that synthesizes subtle procedural retention SFX
 * at each AI-detected emotion moment and mixes them cleanly underneath the original podcast voice
 * (`[0:a]` -> `[aout]`) without ever clipping or ducking speech loudness.
 */
export function buildEmotionAudioFilterGraph(moments: EmotionMoment[]): {
  filterChains: string[];
  outputLabel: string;
} | null {
  if (!Array.isArray(moments) || moments.length === 0) {
    return null;
  }

  const chains: string[] = [
    '[0:a]asetpts=PTS-STARTPTS,aresample=44100:async=1:first_pts=0,aformat=channel_layouts=stereo,volume=1.0[voice_base]',
  ];
  const mixInputs: string[] = ['[voice_base]'];

  moments.forEach((moment, idx) => {
    const spec = getProceduralSfxSpec(moment.sfxStyle);
    const delayMs = Math.max(0, Math.round(moment.timeSec * 1000));
    const gain = Number((spec.baseGain * clamp(moment.intensity, 0.5, 1.0)).toFixed(3));
    const label = `sfx_${idx}`;
    chains.push(
      `aevalsrc=exprs='${spec.expr}':s=44100:d=${spec.durationSec.toFixed(2)}:c=stereo,volume=${gain},adelay=${delayMs}|${delayMs}[${label}]`
    );
    mixInputs.push(`[${label}]`);
  });

  // Use amix with normalize=0 (or volume compensation) + alimiter so voice stays at full studio level
  chains.push(
    `${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`
  );

  return {
    filterChains: chains,
    outputLabel: '[aout]',
  };
}
