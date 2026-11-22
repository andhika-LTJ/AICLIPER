import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeWeightedContentQualityScore,
  deduplicateOverlappingClips,
} from './youtubeAnalyzer.ts';
import { estimateGeminiCostUsd } from './quotaService.ts';
import { generateSrtFromClip, generateVttFromClip } from '../src/utils/youtube.ts';
import { INITIAL_STUDIO_STATE } from '../src/data/seedPodcasts.ts';

test('computeWeightedContentQualityScore calculates bounded weighted average across 7 dimensions', () => {
  const high = computeWeightedContentQualityScore({
    hookStrength: 95,
    emotionalImpact: 90,
    informationValue: 92,
    entertainmentValue: 88,
    contextCompleteness: 94,
    engagementPotential: 90,
    shareabilityPotential: 91,
  });
  assert.ok(high.overallScore >= 88 && high.overallScore <= 96, `Expected high score near 91, got ${high.overallScore}`);

  const clamped = computeWeightedContentQualityScore({
    hookStrength: 150,
    emotionalImpact: -20,
    informationValue: 50,
    entertainmentValue: 50,
    contextCompleteness: 50,
    engagementPotential: 50,
    shareabilityPotential: 50,
  });
  assert.ok(clamped.overallScore >= 40 && clamped.overallScore <= 99);
});

test('deduplicateOverlappingClips drops heavily overlapping duplicates while keeping higher-scored clip', () => {
  const deduped = deduplicateOverlappingClips(
    [
      { id: 'c1', startSec: 100, endSec: 160, viralScore: 82 },
      { id: 'c2', startSec: 105, endSec: 158, viralScore: 93 }, // >85% overlap with c1 -> c2 should win
      { id: 'c3', startSec: 300, endSec: 365, viralScore: 87 }, // distinct segment -> kept
    ],
    0.5
  );
  assert.equal(deduped.length, 2);
  assert.deepEqual(
    deduped.map((c) => c.id),
    ['c2', 'c3']
  );
});

test('generateVttFromClip and generateSrtFromClip produce valid subtitle tracks', () => {
  const sampleClip = INITIAL_STUDIO_STATE.clips[0];
  const srt = generateSrtFromClip(sampleClip);
  const vtt = generateVttFromClip(sampleClip);

  assert.ok(srt.includes('-->'), 'SRT must contain timestamp arrows');
  assert.ok(srt.includes(','), 'SRT uses comma millisecond separator');
  assert.ok(vtt.startsWith('WEBVTT'), 'VTT must start with WEBVTT header');
  assert.ok(vtt.includes('-->'), 'VTT must contain timestamp arrows');
});

test('estimateGeminiCostUsd returns positive cost for non-zero tokens and 0 for empty usage', () => {
  assert.equal(estimateGeminiCostUsd('gemini-4-hydrogen', 0, 0), 0);
  const cost = estimateGeminiCostUsd('gemini-4-hydrogen', 2000, 1000);
  assert.ok(cost > 0 && cost < 1, `Expected small positive USD cost, got ${cost}`);
});
