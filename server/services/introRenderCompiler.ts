import type {
  IntroAnimationType,
  IntroElementLayer,
  IntroTemplateDefinition,
} from '../../src/types/clipper.ts';
import { GLOBAL_INTRO_TEMPLATES } from '../../src/data/introTemplatesCatalog.ts';

export interface CompiledIntroRenderPlan {
  durationSec: number;
  width: number;
  height: number;
  backgroundFilter: string;
  assScript: string;
  audioFilter: string | null;
  hasTextBoxLayers: number;
  hasTextOnlyLayers: number;
  layerCount: number;
  animationTypes: IntroAnimationType[];
}

const FONT_NAME_MAP: Record<IntroElementLayer['fontFamily'], string> = {
  modern_sans: 'DejaVu Sans',
  condensed_viral: 'DejaVu Sans Condensed',
  editorial_serif: 'DejaVu Serif',
  studio_mono: 'DejaVu Sans Mono',
};

function clamp(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, val));
}

function hexToAssColor(hex: string, opacity = 1): string {
  const clean = (hex || '#FFFFFF').replace('#', '').trim();
  const safe = /^[0-9a-fA-F]{6}$/.test(clean) ? clean : 'FFFFFF';
  const r = safe.slice(0, 2);
  const g = safe.slice(2, 4);
  const b = safe.slice(4, 6);
  const alphaByte = Math.round((1 - clamp(opacity, 0, 1)) * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();
  return `&H${alphaByte}${b}${g}${r}`;
}

function hexToFfmpegColor(hex: string): string {
  const clean = (hex || '#09090B').replace('#', '').trim();
  return /^[0-9a-fA-F]{6}$/.test(clean) ? `0x${clean}` : '0x09090B';
}

function formatAssTime(sec: number): string {
  const safe = Math.max(0, sec);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const cs = Math.min(99, Math.round((safe - Math.floor(safe)) * 100));
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N')
    .trim();
}

function wrapTextForWidth(text: string, maxChars: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if ((current + ' ' + word).length <= maxChars) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 4).join('\n');
}

function buildAnimationOverrideTag(params: {
  layer: IntroElementLayer;
  posX: number;
  posY: number;
  width: number;
  height: number;
  introDurationSec: number;
}): { tag: string; transformedText?: string } {
  const { layer, posX, posY, width, height, introDurationSec } = params;
  const anim = layer.animation;
  const durMs = Math.round(clamp(anim.durationSec, 0.12, introDurationSec) * 1000);
  const delayMs = Math.round(clamp(anim.delaySec, 0, Math.max(0, introDurationSec - 0.15)) * 1000);
  const endMs = delayMs + durMs;
  const intensity = clamp(anim.intensity, 0.2, 1.5);
  const offsetPx = Math.round(Math.min(width, height) * 0.08 * intensity);
  const outFadeMs = Math.min(220, Math.round(introDurationSec * 150));

  switch (anim.type) {
    case 'slide_up':
      return {
        tag: `\\move(${posX},${posY + offsetPx},${posX},${posY},${delayMs},${endMs})\\fad(${Math.min(220, durMs)},${outFadeMs})`,
      };
    case 'slide_down':
      return {
        tag: `\\move(${posX},${posY - offsetPx},${posX},${posY},${delayMs},${endMs})\\fad(${Math.min(220, durMs)},${outFadeMs})`,
      };
    case 'slide_left':
      return {
        tag: `\\move(${posX + offsetPx},${posY},${posX},${posY},${delayMs},${endMs})\\fad(${Math.min(220, durMs)},${outFadeMs})`,
      };
    case 'slide_right':
      return {
        tag: `\\move(${posX - offsetPx},${posY},${posX},${posY},${delayMs},${endMs})\\fad(${Math.min(220, durMs)},${outFadeMs})`,
      };
    case 'pop_in':
      return {
        tag: `\\pos(${posX},${posY})\\fscx72\\fscy72\\t(${delayMs},${Math.round(delayMs + durMs * 0.65)},\\fscx108\\fscy108)\\t(${Math.round(delayMs + durMs * 0.65)},${endMs},\\fscx100\\fscy100)\\fad(90,${outFadeMs})`,
      };
    case 'zoom_in':
      return {
        tag: `\\pos(${posX},${posY})\\fscx82\\fscy82\\t(${delayMs},${endMs},\\fscx100\\fscy100)\\fad(${Math.min(250, durMs)},${outFadeMs})`,
      };
    case 'zoom_out':
      return {
        tag: `\\pos(${posX},${posY})\\fscx124\\fscy124\\t(${delayMs},${endMs},\\fscx100\\fscy100)\\fad(${Math.min(250, durMs)},${outFadeMs})`,
      };
    case 'blur_reveal':
      return {
        tag: `\\pos(${posX},${posY})\\blur14\\t(${delayMs},${endMs},\\blur0)\\fad(${Math.min(350, durMs)},${outFadeMs})`,
      };
    case 'typewriter': {
      const clean = escapeAssText(layer.text);
      const stepCs = Math.max(2, Math.round((durMs / Math.max(1, clean.length)) / 10));
      return {
        tag: `\\pos(${posX},${posY})\\fad(60,${outFadeMs})`,
        transformedText: `{\\k${stepCs}}${clean}`,
      };
    }
    case 'fade_in':
    default:
      return {
        tag: `\\pos(${posX},${posY})\\fad(${Math.min(450, durMs)},${outFadeMs})`,
      };
  }
}

export function normalizeIntroTemplateDefinition(
  input?: Partial<IntroTemplateDefinition> | null
): IntroTemplateDefinition {
  const fallback = structuredClone(GLOBAL_INTRO_TEMPLATES[0]);
  if (!input) return fallback;

  const durationSec = Number(clamp(input.durationSec ?? fallback.durationSec, 0.5, 10.0).toFixed(2));
  const layers =
    Array.isArray(input.layers) && input.layers.length > 0
      ? input.layers.slice(0, 12).map((l, idx) => ({
          ...fallback.layers[0],
          ...l,
          id: l.id || `layer-${idx + 1}`,
          x: clamp(l.x ?? 50, 4, 96),
          y: clamp(l.y ?? 50, 6, 94),
          widthPct: clamp(l.widthPct ?? 80, 10, 96),
          heightPct: clamp(l.heightPct ?? 12, 1, 80),
          fontSizePx: clamp(l.fontSizePx ?? 52, 14, 140),
          opacity: clamp(l.opacity ?? 1, 0.05, 1),
          rotationDeg: clamp(l.rotationDeg ?? 0, -45, 45),
          textBox: {
            enabled: Boolean(l.textBox?.enabled),
            backgroundColor: l.textBox?.backgroundColor || '#09090B',
            opacity: clamp(l.textBox?.opacity ?? 0.82, 0.05, 1),
            paddingX: clamp(l.textBox?.paddingX ?? 20, 0, 80),
            paddingY: clamp(l.textBox?.paddingY ?? 14, 0, 60),
            borderRadiusPx: clamp(l.textBox?.borderRadiusPx ?? 12, 0, 64),
            borderWidthPx: clamp(l.textBox?.borderWidthPx ?? 0, 0, 12),
            borderColor: l.textBox?.borderColor || '#FFFFFF',
            shadowEnabled: Boolean(l.textBox?.shadowEnabled),
          },
          animation: {
            type: l.animation?.type ?? 'fade_in',
            durationSec: clamp(l.animation?.durationSec ?? 0.4, 0.1, durationSec),
            delaySec: clamp(l.animation?.delaySec ?? 0, 0, Math.max(0, durationSec - 0.1)),
            direction: l.animation?.direction ?? 'up',
            easing: l.animation?.easing ?? 'ease_out',
            intensity: clamp(l.animation?.intensity ?? 0.8, 0.1, 1.5),
          },
        }))
      : fallback.layers;

  return {
    ...fallback,
    ...input,
    durationSec,
    background: {
      ...fallback.background,
      ...(input.background ?? {}),
      blurStrength: clamp(input.background?.blurStrength ?? fallback.background.blurStrength, 0, 40),
      dimOpacity: clamp(input.background?.dimOpacity ?? fallback.background.dimOpacity, 0, 0.92),
    },
    audio: {
      ...fallback.audio,
      ...(input.audio ?? {}),
      volume: clamp(input.audio?.volume ?? fallback.audio.volume, 0, 1),
    },
    layers,
  };
}

/**
 * Compiles any IntroTemplateDefinition into an exact FFmpeg video background filter,
 * ASS motion-graphics overlay script (scaling cleanly across 720p, 1080p, and 4K),
 * and optional audio/SFX filtergraph.
 */
export function compileIntroTemplateForFfmpeg(params: {
  template: IntroTemplateDefinition;
  width: number;
  height: number;
  fps?: number;
}): CompiledIntroRenderPlan {
  const tpl = normalizeIntroTemplateDefinition(params.template);
  const width = Math.max(360, Math.round(params.width));
  const height = Math.max(640, Math.round(params.height));
  const fps = params.fps ?? 30;
  const scaleFactor = width / 1080;

  // 1. Background FFmpeg filtergraph (supports solid, gradient, blur_footage, footage, image)
  const bg = tpl.background;
  const primaryHex = hexToFfmpegColor(bg.primaryColor);
  const dimAlpha = clamp(bg.dimOpacity, 0, 0.9).toFixed(2);
  let backgroundFilter: string;

  if (bg.mode === 'solid') {
    backgroundFilter = `color=c=${primaryHex}:s=${width}x${height}:d=${tpl.durationSec.toFixed(2)}:r=${fps},format=yuv420p`;
  } else if (bg.mode === 'gradient') {
    // Rich dark vertical vignette + colored base compatible across every FFmpeg build
    backgroundFilter = `color=c=${primaryHex}:s=${width}x${height}:d=${tpl.durationSec.toFixed(2)}:r=${fps},drawbox=x=0:y=0:w=${width}:h=${Math.round(height * 0.45)}:color=${hexToFfmpegColor(bg.secondaryColor)}@0.55:t=fill,vignette=PI/4,format=yuv420p`;
  } else if (bg.mode === 'footage') {
    backgroundFilter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},drawbox=x=0:y=0:w=${width}:h=${height}:color=black@${dimAlpha}:t=fill,setsar=1,format=yuv420p`;
  } else {
    // blur_footage or image fallback
    const sigma = Math.max(2, Math.round(bg.blurStrength * scaleFactor));
    backgroundFilter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=${sigma}:steps=2,drawbox=x=0:y=0:w=${width}:h=${height}:color=black@${dimAlpha}:t=fill,setsar=1,format=yuv420p`;
  }

  // 2. Decorative boxes & text boxes drawn directly on video for sharp rounded/solid panels
  const drawBoxes: string[] = [];
  let hasTextBoxLayers = 0;
  let hasTextOnlyLayers = 0;

  const visibleLayers = tpl.layers.filter((l) => l.visible);
  for (const layer of visibleLayers) {
    if (layer.type === 'shape') {
      const boxW = Math.max(12, Math.round((layer.widthPct / 100) * width));
      const boxH = Math.max(4, Math.round((layer.heightPct / 100) * height));
      const cx = Math.round((layer.x / 100) * width);
      const cy = Math.round((layer.y / 100) * height);
      const bx = clamp(Math.round(cx - boxW / 2), 0, width - 4);
      const by = clamp(Math.round(cy - boxH / 2), 0, height - 4);
      const thickness = layer.textBox.borderWidthPx > 0 ? Math.max(2, Math.round(layer.textBox.borderWidthPx * scaleFactor)) : 'fill';
      const color = hexToFfmpegColor(layer.textBox.borderWidthPx > 0 ? layer.textBox.borderColor : layer.textBox.backgroundColor);
      drawBoxes.push(
        `drawbox=x=${bx}:y=${by}:w=${boxW}:h=${boxH}:color=${color}@${clamp(layer.textBox.opacity, 0.1, 1).toFixed(2)}:t=${thickness}`
      );
    } else if (layer.textBox.enabled) {
      hasTextBoxLayers += 1;
    } else {
      hasTextOnlyLayers += 1;
    }
  }

  if (drawBoxes.length > 0) {
    backgroundFilter = `${backgroundFilter},${drawBoxes.join(',')}`;
  }

  // 3. ASS Script Generation (distinct styles per layer; supports BorderStyle=3 boxed vs BorderStyle=1 clean text-only)
  const styles: string[] = [];
  const events: string[] = [];
  const animationTypes: IntroAnimationType[] = [];

  visibleLayers.forEach((layer, idx) => {
    if (layer.type === 'shape' || !layer.text.trim()) return;
    animationTypes.push(layer.animation.type);

    const styleName = `IntroLayer${idx + 1}`;
    const fontName = FONT_NAME_MAP[layer.fontFamily] || 'DejaVu Sans';
    const fontSize = Math.max(16, Math.round(layer.fontSizePx * scaleFactor));
    const bold = layer.fontWeight >= 700 ? -1 : 0;
    const primaryColor = hexToAssColor(layer.textColor, layer.opacity);
    const useBox = layer.textBox.enabled;
    const borderStyle = useBox ? 3 : 1;
    const outlineColor = useBox
      ? hexToAssColor(layer.textBox.backgroundColor, layer.textBox.opacity)
      : hexToAssColor(layer.outlineColor, layer.outlineEnabled ? 0.95 : 0);
    const backColor = hexToAssColor(layer.shadowColor, layer.shadowEnabled ? 0.65 : 0);
    const outlineWidth = useBox
      ? Math.max(6, Math.round(((layer.textBox.paddingX + layer.textBox.paddingY) / 2) * scaleFactor * 0.55))
      : layer.outlineEnabled
        ? Math.max(1, Math.round(layer.outlineWidthPx * scaleFactor))
        : 0;
    const shadowDepth = layer.shadowEnabled ? Math.max(1, Math.round(2.5 * scaleFactor)) : 0;
    const alignment = layer.textAlign === 'left' ? 4 : layer.textAlign === 'right' ? 6 : 5;
    const spacing = Number((layer.letterSpacingPx * scaleFactor).toFixed(1));

    styles.push(
      `Style: ${styleName},${fontName},${fontSize},${primaryColor},&H00FFFFFF,${outlineColor},${backColor},${bold},0,0,0,100,100,${spacing},0,${borderStyle},${outlineWidth},${shadowDepth},${alignment},60,60,60,1`
    );

    const posX =
      layer.textAlign === 'left'
        ? Math.round(clamp(layer.x / 100, 0.08, 0.4) * width)
        : layer.textAlign === 'right'
          ? Math.round(clamp(layer.x / 100, 0.6, 0.92) * width)
          : Math.round((layer.x / 100) * width);
    const posY = Math.round((layer.y / 100) * height);

    const anim = buildAnimationOverrideTag({
      layer,
      posX,
      posY,
      width,
      height,
      introDurationSec: tpl.durationSec,
    });
    const rotTag = layer.rotationDeg !== 0 ? `\\frz${(-layer.rotationDeg).toFixed(1)}` : '';
    const maxChars = Math.max(14, Math.round((layer.widthPct / 100) * (1080 / Math.max(24, layer.fontSizePx)) * 1.45));
    const wrapped = wrapTextForWidth(layer.text, maxChars);
    const bodyText = anim.transformedText ?? escapeAssText(wrapped);

    const startTime = formatAssTime(Math.max(0, layer.animation.delaySec * 0.5));
    const endTime = formatAssTime(tpl.durationSec);
    events.push(
      `Dialogue: ${idx + 1},${startTime},${endTime},${styleName},,0,0,0,,{${anim.tag}${rotTag}}${bodyText}`
    );
  });

  const assScript = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');

  // 4. Optional Intro Audio / SFX synthesis filter
  let audioFilter: string | null = null;
  if (tpl.audio.enabled && !tpl.audio.muted && tpl.audio.sfxType !== 'none') {
    const vol = clamp(tpl.audio.volume, 0.05, 1.0).toFixed(2);
    const dur = tpl.durationSec.toFixed(2);
    const fadeOutStart = Math.max(0.05, tpl.durationSec - clamp(tpl.audio.fadeOutSec, 0.05, 0.8)).toFixed(2);
    const freqMap: Record<string, string> = {
      whoosh: `anoisesrc=color=pink:duration=${dur}:sample_rate=48000,bandpass=f=700:width_type=h:w=900`,
      pop: `sine=frequency=520:duration=${Math.min(0.25, tpl.durationSec).toFixed(2)}:sample_rate=48000`,
      boom: `sine=frequency=65:duration=${Math.min(0.9, tpl.durationSec).toFixed(2)}:sample_rate=48000`,
      chime: `sine=frequency=880:duration=${Math.min(0.65, tpl.durationSec).toFixed(2)}:sample_rate=48000`,
      riser: `sine=frequency=340:duration=${dur}:sample_rate=48000`,
    };
    const srcExpr = freqMap[tpl.audio.sfxType] || freqMap.whoosh;
    audioFilter = `${srcExpr},afade=t=in:st=0:d=${clamp(tpl.audio.fadeInSec, 0.02, 0.5).toFixed(2)},afade=t=out:st=${fadeOutStart}:d=${clamp(tpl.audio.fadeOutSec, 0.05, 0.8).toFixed(2)},volume=${vol}`;
  }

  return {
    durationSec: tpl.durationSec,
    width,
    height,
    backgroundFilter,
    assScript,
    audioFilter,
    hasTextBoxLayers,
    hasTextOnlyLayers,
    layerCount: visibleLayers.length,
    animationTypes,
  };
}
