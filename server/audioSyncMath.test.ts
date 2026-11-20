import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessStreamSyncHealth,
  mergeAnchoredWindowCues,
  planAudioTranscriptionWindows,
} from './audioSyncMath';

test('assessStreamSyncHealth detects 5-second GOP keyframe audio/video desync immediately', () => {
  const broken = assessStreamSyncHealth({
    videoStartTime: 0.033,
    audioStartTime: 5.015,
    videoDurationSec: 55.02,
    audioDurationSec: 49.97,
  });
  assert.equal(broken.isSynced, false);
  assert.ok(broken.avStartOffsetSec > 4.9);
  assert.equal(broken.commonStartSec, 5.015);

  const nonZeroStart = assessStreamSyncHealth({
    videoStartTime: 0.25,
    audioStartTime: 0.25,
    videoDurationSec: 40,
    audioDurationSec: 40,
  });
  assert.equal(nonZeroStart.isSynced, false);

  const healthy = assessStreamSyncHealth({
    videoStartTime: 0.0,
    audioStartTime: 0.0,
    videoDurationSec: 43.0,
    audioDurationSec: 42.98,
  });
  assert.equal(healthy.isSynced, true);
  assert.equal(healthy.avStartOffsetSec, 0);
});

test('planAudioTranscriptionWindows splits long clips into anchored 12s windows and folds short tails', () => {
  const w50 = planAudioTranscriptionWindows(50, 12);
  assert.equal(w50.length, 4);
  assert.deepEqual(
    w50.map((w) => [w.startSec, w.endSec]),
    [
      [0, 12],
      [12, 24],
      [24, 36],
      [36, 50],
    ]
  );

  const w15 = planAudioTranscriptionWindows(15, 12);
  assert.equal(w15.length, 1);
  assert.equal(w15[0].durationSec, 15);
});

test('mergeAnchoredWindowCues anchors cues without pushing later cues forward on overlap', () => {
  const merged = mergeAnchoredWindowCues(
    [
      {
        windowStartSec: 0,
        windowDurationSec: 12,
        cues: [
          { offsetSec: 0.4, durationSec: 4.5, text: 'Kalimat pertama agak kepanjangan' },
          // Overlaps cue 0 (starts at 3.2 while cue 0 would end at 4.9) -> cue 0 must be trimmed to 2.8s, cue 1 MUST stay at 3.2!
          { offsetSec: 3.2, durationSec: 2.0, text: 'Kalimat kedua tepat waktu' },
        ],
      },
      {
        windowStartSec: 12,
        windowDurationSec: 12,
        cues: [
          { offsetSec: 0.5, durationSec: 2.2, text: 'Kalimat di jendela kedua' },
          // Model accidentally returned global timestamp 16.0 inside window [12..24] -> handled gracefully!
          { offsetSec: 16.0, durationSec: 2.0, text: 'Kalimat timestamp global' },
        ],
      },
    ],
    24
  );

  assert.equal(merged.length, 4);
  assert.equal(merged[0].offsetSec, 0.4);
  assert.equal(merged[0].durationSec, 2.8);
  assert.equal(merged[1].offsetSec, 3.2);
  assert.equal(merged[2].offsetSec, 12.5);
  assert.equal(merged[3].offsetSec, 16.0);
});
