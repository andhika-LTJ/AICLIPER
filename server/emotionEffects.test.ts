import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEmotionAssEvents,
  buildEmotionAudioFilterGraph,
  findActiveEmotionAtTime,
  normalizeEmotionMoments,
} from './emotionEffects';

test('normalizeEmotionMoments enforces valid enums, duration clamping, and minimum 4s spacing', () => {
  const normalized = normalizeEmotionMoments(
    [
      { timeSec: 0.1, durationSec: 2.0, emotion: 'funny', badgeText: 'Ngakak Parah!', sfxStyle: 'pop_spark', intensity: 0.9 },
      { timeSec: 2.2, durationSec: 1.8, emotion: 'shock', badgeText: 'Plot Twist', sfxStyle: 'vine_boom', intensity: 0.7 },
      { timeSec: 9.5, durationSec: 2.2, emotion: 'shock', badgeText: 'Fakta Mengejutkan', sfxStyle: 'vine_boom', intensity: 0.95 },
      { timeSec: 18.0, durationSec: 2.0, emotion: 'insight', badgeText: 'Poin Emas', sfxStyle: 'chime_insight', intensity: 0.85 },
    ],
    35
  );

  assert.equal(normalized.length, 3);
  assert.equal(normalized[0].timeSec, 1.0);
  assert.equal(normalized[0].badgeText, 'NGAKAK PARAH!');
  assert.equal(normalized[1].timeSec, 9.5);
  assert.equal(normalized[2].emotion, 'insight');
  assert.ok(normalized[1].timeSec - normalized[0].timeSec >= 4.0);
});

test('findActiveEmotionAtTime matches overlapping emotional beat cleanly', () => {
  const moments = normalizeEmotionMoments(
    [
      { timeSec: 6.0, durationSec: 2.0, emotion: 'funny', badgeText: 'NGAKAK!', sfxStyle: 'pop_spark', intensity: 0.85 },
      { timeSec: 16.0, durationSec: 2.0, emotion: 'shock', badgeText: 'PLOT TWIST!', sfxStyle: 'vine_boom', intensity: 0.9 },
    ],
    30
  );

  assert.equal(findActiveEmotionAtTime(moments, 6.5)?.emotion, 'funny');
  assert.equal(findActiveEmotionAtTime(moments, 11.0), null);
  assert.equal(findActiveEmotionAtTime(moments, 16.2)?.emotion, 'shock');
});

test('buildEmotionAssEvents outputs kinetic pop-in animated ASS callouts in safe zone', () => {
  const moments = normalizeEmotionMoments(
    [
      { timeSec: 5.0, durationSec: 2.0, emotion: 'shock', badgeText: 'PLOT TWIST!', sfxStyle: 'vine_boom', intensity: 0.92 },
    ],
    30
  );
  const lines = buildEmotionAssEvents({
    moments,
    layout: 'shorts_full_bleed',
    durationSec: 30,
  });

  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('EmotionCallout'));
  assert.ok(lines[0].includes('\\fscx64\\fscy64'));
  assert.ok(lines[0].includes('\\move(540,280,540,260,0,1400)'));
  assert.ok(lines[0].includes('PLOT TWIST!'));
});

test('buildEmotionAudioFilterGraph creates comma-safe aevalsrc SFX chains mixed with voice_base', () => {
  const moments = normalizeEmotionMoments(
    [
      { timeSec: 4.5, durationSec: 1.8, emotion: 'funny', badgeText: 'NGAKAK!', sfxStyle: 'pop_spark', intensity: 0.8 },
      { timeSec: 14.0, durationSec: 2.0, emotion: 'dramatic', badgeText: 'TEGANG!', sfxStyle: 'heartbeat_hit', intensity: 0.9 },
    ],
    30
  );
  const graph = buildEmotionAudioFilterGraph(moments);
  assert.ok(graph);
  assert.equal(graph.outputLabel, '[aout]');
  assert.equal(graph.filterChains.length, 4);
  assert.ok(graph.filterChains[1].includes('adelay=4500|4500[sfx_0]'));
  assert.ok(graph.filterChains[2].includes('adelay=14000|14000[sfx_1]'));
  assert.ok(graph.filterChains[3].includes('amix=inputs=3:duration=first'));
  assert.equal(buildEmotionAudioFilterGraph([]), null);
});
