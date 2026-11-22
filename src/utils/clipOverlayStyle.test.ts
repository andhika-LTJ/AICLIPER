import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeIntroAnchorLayout,
  computeOverlayStyleFingerprint,
  DEFAULT_CLIP_OVERLAY_STYLE,
  hexToAssColor,
  hexToFfmpegColor,
  isCustomOverlayStyleActive,
  normalizeClipOverlayStyle,
  resolveAssFontName,
} from './clipOverlayStyle';

test('hexToAssColor converts RGB hex to ASS BGR hex accurately', () => {
  // #EF4444 (red) -> R=EF, G=44, B=44 -> BGR = 4444EF
  assert.equal(hexToAssColor('#EF4444'), '&H004444EF&');
  // #38BDF8 (sky blue) -> R=38, G=BD, B=F8 -> BGR = F8BD38
  assert.equal(hexToAssColor('#38BDF8'), '&H00F8BD38&');
  // #FACC15 (yellow) with alpha 66 -> R=FA, G=CC, B=15 -> BGR = 15CCFA
  assert.equal(hexToAssColor('#FACC15', '66'), '&H6615CCFA&');
  assert.equal(hexToFfmpegColor('#38bdf8'), '0x38BDF8');
});

test('normalizeClipOverlayStyle clamps out-of-range values and sanitizes invalid enums/colors', () => {
  const norm = normalizeClipOverlayStyle({
    fontFamily: 'unknown_font' as never,
    textAlign: 'left',
    introPositionY: 5,
    subtitlePositionY: 120,
    introFontScale: 4.0,
    subtitleFontScale: 0.2,
    introDurationSec: 9,
    subtitleTextColor: 'not-a-color',
    subtitleHighlightColor: '#22c55e',
    subtitleBoxStyle: 'box',
    customIntroHeadline: '   Judul   Manual   Saya  ',
  });

  assert.equal(norm.fontFamily, 'modern_sans');
  assert.equal(norm.textAlign, 'left');
  assert.equal(norm.introPositionY, 22);
  assert.equal(norm.subtitlePositionY, 90);
  assert.equal(norm.introFontScale, 1.35);
  assert.equal(norm.subtitleFontScale, 0.75);
  assert.equal(norm.introDurationSec, 4.5);
  assert.equal(norm.subtitleTextColor, '#FFFFFF');
  assert.equal(norm.subtitleHighlightColor, '#22C55E');
  assert.equal(norm.subtitleBoxStyle, 'box');
  assert.equal(norm.customIntroHeadline, 'Judul Manual Saya');
});

test('resolveAssFontName maps all 4 bundled font presets to exact Liberation TrueType names', () => {
  assert.equal(resolveAssFontName('modern_sans'), 'Liberation Sans');
  assert.equal(resolveAssFontName('condensed_viral'), 'Liberation Sans Narrow');
  assert.equal(resolveAssFontName('editorial_serif'), 'Liberation Serif');
  assert.equal(resolveAssFontName('studio_mono'), 'Liberation Mono');
});

test('computeIntroAnchorLayout shifts vertical stack and alignment coherently for text & accent bar', () => {
  const topLeft = computeIntroAnchorLayout({
    isLandscape: false,
    style: { introPositionY: 30, textAlign: 'left' },
  });
  const bottomRight = computeIntroAnchorLayout({
    isLandscape: false,
    style: { introPositionY: 70, textAlign: 'right' },
  });

  assert.equal(topLeft.assAlign, 4);
  assert.equal(bottomRight.assAlign, 6);
  assert.ok(topLeft.headlineY < bottomRight.headlineY);
  assert.ok(topLeft.barYRatio < bottomRight.barYRatio);
  assert.ok(topLeft.barXRatio < bottomRight.barXRatio);
});

test('isCustomOverlayStyleActive and computeOverlayStyleFingerprint detect any style edit', () => {
  assert.equal(isCustomOverlayStyleActive(null), false);
  assert.equal(isCustomOverlayStyleActive(DEFAULT_CLIP_OVERLAY_STYLE), false);
  assert.equal(isCustomOverlayStyleActive({ subtitlePositionY: 65 }), true);

  const fpDefault = computeOverlayStyleFingerprint(null);
  const fpFont = computeOverlayStyleFingerprint({ fontFamily: 'editorial_serif' });
  const fpPos = computeOverlayStyleFingerprint({ subtitlePositionY: 60 });
  assert.notEqual(fpDefault, fpFont);
  assert.notEqual(fpDefault, fpPos);
  assert.notEqual(fpFont, fpPos);
});
