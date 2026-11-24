import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSmoothCropAxisExpression,
  computeCropWindow,
  computeFocusFromFaceBox,
  generateStudioAssScript,
  getTargetCanvasDimensions,
  isValidRenderLayoutInput,
  isValidRenderProfileInput,
  isValidRenderQualityInput,
  normalizeRenderLayout,
  normalizeRenderQuality,
  normalizeSpeakerKeyframes,
  normalizeTranscribedCues,
  resolveEffectiveRenderQuality,
  resolveNonUpscaledTargetDimensions,
  wrapTitleLines,
} from './speakerFocusMath';

test('normalizeRenderLayout maps legacy and studio layout values cleanly with 9:16 full frame default', () => {
  assert.equal(normalizeRenderLayout(undefined), 'shorts_full_bleed');
  assert.equal(normalizeRenderLayout('shorts_full_bleed'), 'shorts_full_bleed');
  assert.equal(normalizeRenderLayout('full_16_9_focus'), 'full_16_9_focus');
  assert.equal(normalizeRenderLayout('landscape_16_9'), 'full_16_9_focus');
  assert.equal(normalizeRenderLayout('vertical_9_16'), 'shorts_studio_focus');
  assert.equal(normalizeRenderLayout('shorts_studio_focus'), 'shorts_studio_focus');
});

test('normalizeRenderQuality, resolveEffectiveRenderQuality, and getTargetCanvasDimensions support crisp 1080p and 4K Ultra HD', () => {
  assert.equal(normalizeRenderQuality(undefined), '1080p');
  assert.equal(normalizeRenderQuality('4k'), '4k');
  assert.equal(normalizeRenderQuality('ultra_hd'), '4k');
  assert.equal(normalizeRenderQuality('2160p'), '4k');
  assert.equal(
    resolveEffectiveRenderQuality({ enableUltraHdRender: true, defaultRenderQuality: '1080p' }),
    '4k'
  );
  assert.equal(
    resolveEffectiveRenderQuality({ enableUltraHdRender: false, defaultRenderQuality: '1080p' }),
    '1080p'
  );
  assert.equal(
    resolveEffectiveRenderQuality({
      requestedQuality: '1080p',
      enableUltraHdRender: true,
      defaultRenderQuality: '4k',
    }),
    '1080p'
  );
  assert.deepEqual(getTargetCanvasDimensions('shorts_full_bleed', '1080p'), { outW: 1080, outH: 1920 });
  assert.deepEqual(getTargetCanvasDimensions('shorts_full_bleed', '4k'), { outW: 2160, outH: 3840 });
  assert.deepEqual(getTargetCanvasDimensions('full_16_9_focus', '1080p'), { outW: 1920, outH: 1080 });
  assert.deepEqual(getTargetCanvasDimensions('full_16_9_focus', '4k'), { outW: 3840, outH: 2160 });
});

test('computeFocusFromFaceBox converts 0..1000 Gemini face bounding box to accurate focus and adaptive zoom', () => {
  // Wide multi-speaker shot: speaker on far right edge
  const farRight = computeFocusFromFaceBox([220, 790, 440, 880]);
  assert.ok(farRight);
  assert.ok(Math.abs(farRight.focusX - 0.835) < 0.01);
  assert.ok(farRight.focusY > 0.32 && farRight.focusY < 0.5);
  assert.ok(farRight.zoomScale >= 1.25);

  // Close-up single speaker centered
  const closeUp = computeFocusFromFaceBox([180, 350, 560, 650]);
  assert.ok(closeUp);
  assert.ok(Math.abs(closeUp.focusX - 0.5) < 0.01);
  assert.ok(closeUp.zoomScale <= 1.12);

  // Degenerate box rejected
  assert.equal(computeFocusFromFaceBox([0, 0, 1000, 1000]), null);
});

test('computeCropWindow produces even bounded dimensions matching target aspect ratio', () => {
  const landscape = computeCropWindow(1280, 720, 16, 9, 1.35);
  assert.equal(landscape.cropW % 2, 0);
  assert.equal(landscape.cropH % 2, 0);
  assert.ok(landscape.cropW < 1280 && landscape.cropH < 720);
  assert.ok(Math.abs(landscape.cropW / landscape.cropH - 16 / 9) < 0.03);

  const vertical = computeCropWindow(1280, 720, 9, 16, 1.0);
  assert.equal(vertical.cropW, 404);
  assert.equal(vertical.cropH, 720);
});

test('normalizeSpeakerKeyframes grounds faceBox, widens bounds, and suppresses single-frame glitches', () => {
  const normalized = normalizeSpeakerKeyframes(
    [
      { timeSec: 0, focusX: 0.2, focusY: 0.35, zoomScale: 1.2 },
      // Single-frame glitch inside same shot (no scene cut)
      { timeSec: 2, focusX: 0.82, focusY: 0.35, zoomScale: 1.2 },
      { timeSec: 4, focusX: 0.22, focusY: 0.35, zoomScale: 1.2 },
      // Real hard camera cut to far-right speaker grounded via faceBox
      { timeSec: 8, focusX: 0.5, focusY: 0.4, zoomScale: 1.1, isSceneCut: true, faceBox: [220, 820, 460, 940] },
    ],
    15
  );
  assert.equal(normalized[0].timeSec, 0);
  assert.equal(normalized[normalized.length - 1].timeSec, 15);
  // Glitch at t=2 should be damped back near 0.21
  assert.ok(normalized[1].focusX < 0.3);
  // Cut at t=8 should preserve faceBox horizontal center (~0.88) and isSceneCut flag
  const cutKf = normalized.find((k) => k.timeSec === 8);
  assert.ok(cutKf);
  assert.equal(cutKf.isSceneCut, true);
  assert.ok(cutKf.focusX >= 0.86 && cutKf.focusX <= 0.92);
});

test('buildSmoothCropAxisExpression uses instant snap on hard scene cuts and smooth glide within shots', () => {
  const kfs = normalizeSpeakerKeyframes(
    [
      { timeSec: 0, focusX: 0.2, focusY: 0.38, zoomScale: 1.2 },
      { timeSec: 5, focusX: 0.8, focusY: 0.38, zoomScale: 1.2, isSceneCut: true },
      { timeSec: 10, focusX: 0.2, focusY: 0.38, zoomScale: 1.2, isSceneCut: false },
    ],
    12
  );
  const expr = buildSmoothCropAxisExpression({
    keyframes: kfs,
    axis: 'x',
    sourceSize: 1920,
    cropSize: 608,
  });
  assert.ok(expr.startsWith('min(max(0,'));
  assert.ok(expr.endsWith(',1312)'));
  // Hard cut at 5.00 should hold until 4.96 (0.04s snap)
  assert.ok(expr.includes('4.96'));
  // Smooth in-shot pan at 10.00 should start gliding at 9.64 (0.36s glide)
  assert.ok(expr.includes('9.64'));
});

test('normalizeTranscribedCues prevents overlaps and clamps within clip duration', () => {
  const cues = normalizeTranscribedCues(
    [
      { offsetSec: 4, durationSec: 5, text: 'Kalimat kedua lebih dulu' },
      { offsetSec: 0, durationSec: 6, text: 'Kalimat pertama' },
      { offsetSec: 25, durationSec: 4, text: 'Melewati batas durasi' },
    ],
    10
  );
  assert.equal(cues.length, 2);
  assert.equal(cues[0].offsetSec, 0);
  assert.ok(cues[0].offsetSec + cues[0].durationSec <= cues[1].offsetSec + 0.01);
  assert.ok(cues[1].offsetSec + cues[1].durationSec <= 10);
});

test('wrapTitleLines wraps long Indonesian titles cleanly', () => {
  const lines = wrapTitleLines('Reaksi Kocak Dokter Tirta Lihat Kebiasaan Begadang Aloy Setiap Hari', 28, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].length <= 28);
  assert.ok(lines[1].length <= 29);
});

test('generateStudioAssScript renders natural 9:16 Full Frame ASS with kinetic EmotionCallout and zero red borders', () => {
  const assVertical = generateStudioAssScript({
    layout: 'shorts_full_bleed',
    title: 'Aloy Kena Roasting Dokter Tirta',
    channelName: 'Raditya Dika',
    hookCaption: 'Setuju sama Dokter Tirta? Tulis di komentar!',
    cues: [{ offsetSec: 4.5, durationSec: 3.2, text: 'Jam tidur kamu berantakan banget' }],
    durationSec: 15,
    enableEmotionEffects: true,
    emotionMoments: [
      {
        timeSec: 4.4,
        durationSec: 2.0,
        emotion: 'funny',
        badgeText: 'NGAKAK!',
        sfxStyle: 'pop_spark',
        intensity: 0.9,
      },
    ],
  });
  assert.ok(assVertical.includes('PlayResX: 1080'));
  assert.ok(assVertical.includes('PlayResY: 1920'));
  assert.ok(assVertical.includes('RADITYA DIKA · PODCAST CLIP'));
  assert.ok(assVertical.replace(/\\N/g, ' ').includes('Aloy Kena Roasting Dokter Tirta'));
  assert.ok(assVertical.includes('Style: EmotionCallout'));
  assert.ok(assVertical.includes('NGAKAK!'));
  assert.ok(assVertical.includes('\\fscx93\\fscy93'));
  assert.ok(assVertical.includes('berantakan'));
  assert.ok(!assVertical.includes('1C1CDC'));

  const assNoEmotion = generateStudioAssScript({
    layout: 'full_16_9_focus',
    title: 'Aloy Kena Roasting Dokter Tirta',
    channelName: 'Raditya Dika',
    hookCaption: 'Setuju sama Dokter Tirta?',
    cues: [{ offsetSec: 0.5, durationSec: 3.2, text: 'Jam tidur kamu berantakan banget' }],
    durationSec: 15,
    enableEmotionEffects: false,
    emotionMoments: [
      {
        timeSec: 4.4,
        durationSec: 2.0,
        emotion: 'funny',
        badgeText: 'NGAKAK!',
        sfxStyle: 'pop_spark',
        intensity: 0.9,
      },
    ],
  });
  assert.ok(assNoEmotion.includes('PlayResX: 1920'));
  assert.ok(!assNoEmotion.includes('Dialogue: 3,'));
  assert.ok(!assNoEmotion.includes('\\fscx93\\fscy93'));
  assert.ok(!assNoEmotion.includes('1C1CDC'));
});

test('resolveNonUpscaledTargetDimensions enforces exact 4K dimensions for 4K sources and prevents upscaling on lower sources', () => {
  const portrait4kFromLandscape4k = resolveNonUpscaledTargetDimensions({
    layout: 'shorts_full_bleed',
    quality: '4k',
    profileId: 'balanced_4k',
    sourceWidth: 3840,
    sourceHeight: 2160,
  });
  assert.equal(portrait4kFromLandscape4k.outW, 2160);
  assert.equal(portrait4kFromLandscape4k.outH, 3840);
  assert.equal(portrait4kFromLandscape4k.effectiveQuality, '4k');
  assert.equal(portrait4kFromLandscape4k.wasCappedNoUpscale, false);

  const landscape4k = resolveNonUpscaledTargetDimensions({
    layout: 'full_16_9_focus',
    quality: '4k',
    profileId: 'balanced_4k',
    sourceWidth: 3840,
    sourceHeight: 2160,
  });
  assert.equal(landscape4k.outW, 3840);
  assert.equal(landscape4k.outH, 2160);
  assert.equal(landscape4k.effectiveQuality, '4k');
  assert.equal(landscape4k.wasCappedNoUpscale, false);

  const cappedFrom1080 = resolveNonUpscaledTargetDimensions({
    layout: 'shorts_full_bleed',
    quality: '4k',
    profileId: 'balanced_4k',
    sourceWidth: 1920,
    sourceHeight: 1080,
  });
  assert.equal(cappedFrom1080.outW, 1080);
  assert.equal(cappedFrom1080.outH, 1920);
  assert.equal(cappedFrom1080.effectiveQuality, '1080p');
  assert.equal(cappedFrom1080.wasCappedNoUpscale, true);

  const cappedLandscapeFrom720 = resolveNonUpscaledTargetDimensions({
    layout: 'full_16_9_focus',
    quality: '4k',
    profileId: 'balanced_4k',
    sourceWidth: 1280,
    sourceHeight: 720,
  });
  assert.equal(cappedLandscapeFrom720.outW, 1280);
  assert.equal(cappedLandscapeFrom720.outH, 720);
  assert.equal(cappedLandscapeFrom720.effectiveQuality, '1080p');
  assert.equal(cappedLandscapeFrom720.wasCappedNoUpscale, true);

  const preview720 = resolveNonUpscaledTargetDimensions({
    layout: 'shorts_full_bleed',
    quality: '4k',
    profileId: 'fast_preview',
    sourceWidth: 3840,
    sourceHeight: 2160,
  });
  assert.equal(preview720.outW, 720);
  assert.equal(preview720.outH, 1280);
  assert.equal(preview720.effectiveQuality, '1080p');
});

test('render input validators accept known values and reject invalid payloads', () => {
  assert.equal(isValidRenderLayoutInput('shorts_full_bleed'), true);
  assert.equal(isValidRenderLayoutInput('full_16_9_focus'), true);
  assert.equal(isValidRenderLayoutInput('invalid_ratio'), false);

  assert.equal(isValidRenderQualityInput('1080p'), true);
  assert.equal(isValidRenderQualityInput('4k'), true);
  assert.equal(isValidRenderQualityInput('2160p'), true);
  assert.equal(isValidRenderQualityInput('8k_experimental'), false);

  assert.equal(isValidRenderProfileInput('balanced_4k'), true);
  assert.equal(isValidRenderProfileInput('fast_preview'), true);
  assert.equal(isValidRenderProfileInput('ultra_magic'), false);
});


