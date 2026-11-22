import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIntroAssEvents,
  buildIntroAudioExpr,
  computeExactIntroTiming,
  normalizeAiClipIntro,
  synthesizeFallbackCaptionCues,
} from './videoIntroMath';
import { generateStudioAssScript } from './speakerFocusMath';

test('normalizeAiClipIntro sanitizes AI fields and falls back gracefully when empty', () => {
  const normalized = normalizeAiClipIntro(
    {
      tag: 'fakta mengejutkan!!',
      headline: 'Kenapa Banyak Orang Menunda Tugas Penting? #Shorts',
      teaser: 'Tim Urban membongkar peran Monyet Kepuasan Instan di dalam otak kita.',
      durationSec: 2.8,
    },
    { title: 'Fallback Title' }
  );
  assert.equal(normalized.tag, 'FAKTA MENGEJUTKAN');
  assert.equal(normalized.headline, 'Kenapa Banyak Orang Menunda Tugas Penting?');
  assert.equal(normalized.durationSec, 2.8);

  const fallback = normalizeAiClipIntro(null, {
    title: 'Rahasia Sukses Podcast',
    ringkasanTeks: 'Pembahasan lengkap tentang cara menjaga retensi penonton dari detik pertama.',
  });
  assert.equal(fallback.tag, 'TOPIK PILIHAN');
  assert.equal(fallback.headline, 'Rahasia Sukses Podcast');
  assert.ok(fallback.teaser.includes('retensi penonton'));
});

test('computeExactIntroTiming produces exact 30fps integer frame count for zero A/V drift', () => {
  const t = computeExactIntroTiming(2.8);
  assert.equal(t.frameCount, 84);
  assert.equal(t.loopExtraFrames, 83);
  assert.equal(t.exactDurationSec, 2.8);
});

test('buildIntroAudioExpr contains zero commas so FFmpeg filtergraph never misparses', () => {
  const expr = buildIntroAudioExpr();
  assert.ok(expr.length > 20);
  assert.equal(expr.includes(','), false);
});

test('buildIntroAssEvents creates complete intro headline, badge, teaser, and channel layers', () => {
  const intro = normalizeAiClipIntro(
    {
      tag: 'INSIGHT UTAMA',
      headline: 'Rahasia Otak Orang yang Suka Menunda',
      teaser: 'Penjelasan lengkap bagaimana otak rasional kalah melawan dorongan hiburan instan.',
      durationSec: 2.8,
    },
    { title: 'Fallback' }
  );
  const events = buildIntroAssEvents({
    intro,
    channelName: 'TED',
    layout: 'shorts_full_bleed',
  });
  assert.equal(events.length, 4);
  assert.ok(events.some((e) => e.includes('IntroBadge') && e.includes('INSIGHT UTAMA')));
  assert.ok(events.some((e) => e.includes('IntroHeadline') && e.includes('Rahasia Otak')));
  assert.ok(
    events.some(
      (e) => e.includes('IntroTeaser') && e.replace(/\\N/g, ' ').includes('otak rasional')
    )
  );
  assert.ok(events.some((e) => e.includes('IntroChannel') && e.includes('TED')));
});

test('synthesizeFallbackCaptionCues guarantees non-empty timed subtitles when STT cues are empty', () => {
  const cues = synthesizeFallbackCaptionCues(
    'Ini adalah pembahasan lengkap tentang cara membuat podcast viral yang disukai penonton Indonesia setiap hari.',
    20
  );
  assert.ok(cues.length >= 2);
  assert.equal(cues[0].offsetSec, 0);
  const last = cues[cues.length - 1];
  assert.ok(last.offsetSec + last.durationSec <= 20.05);
});

test('generateStudioAssScript shifts subtitles & emotion callouts by exact intro offset when AI intro is enabled', () => {
  const intro = normalizeAiClipIntro(
    {
      tag: 'CERITA NYATA',
      headline: 'Kenapa Bisnis Pertama Sering Gagal?',
      teaser: 'Dokter Tirta membongkar kesalahan fatal saat baru memulai usaha dari nol.',
      durationSec: 2.8,
    },
    { title: 'Bisnis Pertama' }
  );
  const ass = generateStudioAssScript({
    layout: 'shorts_full_bleed',
    title: 'Kenapa Bisnis Pertama Gagal?',
    channelName: 'Raditya Dika',
    hookCaption: 'Simak pengalaman nyata membangun bisnis dari nol.',
    cues: [
      { offsetSec: 0.5, durationSec: 3.0, text: 'Banyak orang salah kaprah soal modal' },
      { offsetSec: 4.0, durationSec: 3.5, text: 'Padahal yang paling penting itu eksekusi' },
    ],
    durationSec: 30,
    emotionMoments: [
      {
        timeSec: 4.2,
        durationSec: 2.0,
        emotion: 'insight',
        badgeText: 'POIN EMAS',
        sfxStyle: 'chime_insight',
        intensity: 0.9,
      },
    ],
    enableEmotionEffects: true,
    intro,
    enableAiIntro: true,
    fontName: 'Liberation Sans',
  });

  // Uses bundled Liberation Sans font
  assert.ok(ass.includes('Style: SubtitleBox,Liberation Sans,'));
  assert.ok(ass.includes('Style: IntroHeadline,Liberation Sans,'));
  // Intro card runs 0:00:00.00 -> 0:00:02.80
  assert.ok(ass.includes('Dialogue: 4,0:00:00.00,0:00:02.80,IntroBadge'));
  // First subtitle shifted from 0.5s -> 3.30s (0.5 + 2.8 = 3.30)
  assert.ok(ass.includes('Dialogue: 2,0:00:03.30,0:00:06.30,SubtitleBox'));
  // Emotion callout shifted from 4.2s -> 7.00s (4.2 + 2.8 = 7.00)
  assert.ok(ass.includes('Dialogue: 3,0:00:07.00,0:00:09.00,EmotionCallout'));
});
