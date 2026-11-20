import type { CaptionCue } from '../src/types/clipper.ts';

export interface StreamSyncMeta {
  videoStartTime: number;
  audioStartTime: number;
  videoDurationSec: number;
  audioDurationSec: number;
}

export interface StreamSyncAssessment {
  isSynced: boolean;
  avStartOffsetSec: number;
  commonStartSec: number;
  durationDiffSec: number;
  reason?: string;
}

export interface AudioTranscriptionWindow {
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
}

/**
 * Verifies whether a trimmed MP4 segment has frame-accurate zero-anchored A/V alignment.
 * Catches the classic `-c:v copy` GOP keyframe shift where video starts at 0.03s while audio starts at 5.01s,
 * which otherwise causes burned-in subtitles and SFX to play seconds out of sync with the video.
 */
export function assessStreamSyncHealth(meta: StreamSyncMeta): StreamSyncAssessment {
  const vStart = Number.isFinite(meta.videoStartTime) ? Math.max(0, meta.videoStartTime) : 0;
  const aStart = Number.isFinite(meta.audioStartTime) ? Math.max(0, meta.audioStartTime) : 0;
  const vDur = Number.isFinite(meta.videoDurationSec) ? Math.max(0, meta.videoDurationSec) : 0;
  const aDur = Number.isFinite(meta.audioDurationSec) ? Math.max(0, meta.audioDurationSec) : 0;

  const avStartOffsetSec = Number(Math.abs(vStart - aStart).toFixed(3));
  const commonStartSec = Number(Math.max(vStart, aStart).toFixed(3));
  const durationDiffSec = Number(Math.abs(vDur - aDur).toFixed(3));

  if (avStartOffsetSec > 0.08) {
    return {
      isSynced: false,
      avStartOffsetSec,
      commonStartSec,
      durationDiffSec,
      reason: `Video/audio start_time offset terlalu besar (${avStartOffsetSec}s).`,
    };
  }

  if (vStart > 0.12 || aStart > 0.12) {
    return {
      isSynced: false,
      avStartOffsetSec,
      commonStartSec,
      durationDiffSec,
      reason: `Stream tidak dimulai dari 0.00s (video=${vStart.toFixed(2)}s, audio=${aStart.toFixed(2)}s).`,
    };
  }

  if (vDur > 0 && aDur > 0 && durationDiffSec > 1.0) {
    return {
      isSynced: false,
      avStartOffsetSec,
      commonStartSec,
      durationDiffSec,
      reason: `Durasi video (${vDur.toFixed(2)}s) dan audio (${aDur.toFixed(2)}s) selisih ${durationDiffSec}s.`,
    };
  }

  return {
    isSynced: true,
    avStartOffsetSec,
    commonStartSec,
    durationDiffSec,
  };
}

/**
 * Splits clip audio into short anchored windows (default 12s) so parallel Gemini transcription
 * has zero cumulative timestamp drift across 30–60s podcast clips.
 * Any short trailing fragment (< 4.5s) is folded into the previous window cleanly.
 */
export function planAudioTranscriptionWindows(
  totalDurationSec: number,
  windowSec = 12
): AudioTranscriptionWindow[] {
  const safeDur = Math.max(2, Number(totalDurationSec) || 10);
  const safeWin = Math.max(6, Math.min(18, windowSec));

  if (safeDur <= safeWin + 4.5) {
    return [
      {
        index: 0,
        startSec: 0,
        endSec: Number(safeDur.toFixed(3)),
        durationSec: Number(safeDur.toFixed(3)),
      },
    ];
  }

  const windows: AudioTranscriptionWindow[] = [];
  let cursor = 0;
  let index = 0;

  while (cursor < safeDur - 0.1) {
    const remaining = safeDur - cursor;
    const isLast = remaining <= safeWin + 4.5;
    const end = isLast ? safeDur : Math.min(safeDur, cursor + safeWin);
    windows.push({
      index,
      startSec: Number(cursor.toFixed(3)),
      endSec: Number(end.toFixed(3)),
      durationSec: Number((end - cursor).toFixed(3)),
    });
    cursor = end;
    index++;
  }

  return windows;
}

/**
 * Merges window-local transcription cues into clip-global timestamps while strictly preserving
 * every cue's true audio onset (trims an earlier cue's tail instead of pushing later cues late!).
 */
export function mergeAnchoredWindowCues(
  windowResults: Array<{
    windowStartSec: number;
    windowDurationSec: number;
    cues: CaptionCue[];
  }>,
  totalDurationSec: number
): CaptionCue[] {
  const safeTotal = Math.max(2, totalDurationSec);
  const globalRaw: CaptionCue[] = [];

  for (const win of windowResults) {
    const winStart = Math.max(0, Number(win.windowStartSec) || 0);
    const winDur = Math.max(0.5, Number(win.windowDurationSec) || 0);
    const winEnd = Math.min(safeTotal, winStart + winDur);

    for (const cue of win.cues ?? []) {
      if (!cue || typeof cue.text !== 'string') continue;
      const text = cue.text.replace(/\s+/g, ' ').trim();
      if (!text) continue;

      let localStart = Number(cue.offsetSec);
      if (!Number.isFinite(localStart) || localStart < 0) localStart = 0;

      // Guard against model accidentally outputting global timestamp instead of window-local timestamp
      if (winStart > 0 && localStart >= winStart - 0.4 && localStart <= winEnd + 0.5) {
        localStart = Math.max(0, localStart - winStart);
      }

      if (localStart >= winDur - 0.12) continue;

      const rawDur = Number(cue.durationSec);
      const localDur = Number.isFinite(rawDur) && rawDur > 0.25 ? rawDur : 1.8;
      const globalStart = Number(Math.min(winEnd - 0.2, winStart + localStart).toFixed(2));
      const globalEnd = Number(Math.min(winEnd + 0.15, safeTotal, globalStart + localDur).toFixed(2));
      const clampedDur = Number(Math.max(0.35, globalEnd - globalStart).toFixed(2));

      globalRaw.push({
        offsetSec: globalStart,
        durationSec: clampedDur,
        text,
      });
    }
  }

  globalRaw.sort((a, b) => a.offsetSec - b.offsetSec);

  const merged: CaptionCue[] = [];
  for (const cur of globalRaw) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const prevEnd = prev.offsetSec + prev.durationSec;
      if (cur.offsetSec < prevEnd) {
        const availableForPrev = cur.offsetSec - prev.offsetSec;
        if (availableForPrev >= 0.35) {
          // Trim previous cue cleanly so the incoming cue stays 100% locked to its true speech onset!
          prev.durationSec = Number(availableForPrev.toFixed(2));
        } else {
          // Two cues started virtually at the exact same instant -> shift current minimally by 0.35s
          const shiftedStart = Number(Math.min(safeTotal - 0.35, prev.offsetSec + 0.35).toFixed(2));
          prev.durationSec = Number(Math.max(0.3, shiftedStart - prev.offsetSec).toFixed(2));
          cur.offsetSec = shiftedStart;
        }
      }
    }

    if (cur.offsetSec >= safeTotal - 0.2) continue;
    const maxDur = Math.max(0.35, safeTotal - cur.offsetSec);
    merged.push({
      offsetSec: Number(cur.offsetSec.toFixed(2)),
      durationSec: Number(Math.min(cur.durationSec, maxDur).toFixed(2)),
      text: cur.text,
    });
  }

  return merged;
}
