import type {
  EditingProjectData,
  EditorExportPreset,
  PodcastClip,
  TimelineElement,
} from '../../src/types/clipper.ts';

export const MIN_TIMELINE_SEGMENT_SEC = 0.5;
export const MAX_TIMELINE_ZOOM = 4;
export const MIN_TIMELINE_ZOOM = 1;

export function roundTime(sec: number): number {
  return Math.round(sec * 100) / 100;
}

export function clampPlayhead(timeSec: number, durationSec: number): number {
  const safeDuration = Math.max(1, durationSec);
  if (!Number.isFinite(timeSec)) return 0;
  return roundTime(Math.max(0, Math.min(safeDuration, timeSec)));
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return roundTime(Math.max(MIN_TIMELINE_ZOOM, Math.min(MAX_TIMELINE_ZOOM, zoom)));
}

export function buildDefaultExportPreset(clip: PodcastClip): EditorExportPreset {
  return {
    resolution: clip.renderedQuality ?? '1080p',
    fps: 30,
    format: 'mp4_h264',
    layout: clip.renderedLayout ?? 'shorts_full_bleed',
    normalizeAudio: clip.overlayStyle?.normalizeAudio ?? true,
    includeSubtitles: true,
    includeIntro: clip.introEnabled ?? true,
  };
}

export function createDefaultEditingProject(
  clip: PodcastClip,
  userUid: string,
  workspaceId: string | null = null
): EditingProjectData {
  const clipDuration = Math.max(5, roundTime((clip.endSec ?? 45) - (clip.startSec ?? 0)));
  const introDur = Math.min(
    Math.max(1.5, clip.overlayStyle?.introDurationSec ?? clip.introDurationSec ?? 3.2),
    Math.min(6, clipDuration * 0.4)
  );

  const elements: TimelineElement[] = [
    {
      id: `vid-${clip.id}-1`,
      trackType: 'video',
      label: clip.title.slice(0, 42) || 'Klip Video Utama',
      startSec: 0,
      endSec: clipDuration,
      sourceOffsetSec: clip.startSec ?? 0,
      color: '#dc2626',
    },
    {
      id: `aud-${clip.id}-1`,
      trackType: 'audio',
      label: 'Audio Podcast (-14 LUFS)',
      startSec: 0,
      endSec: clipDuration,
      sourceOffsetSec: clip.startSec ?? 0,
      muted: false,
      color: '#0ea5e9',
    },
    {
      id: `txt-${clip.id}-intro`,
      trackType: 'text',
      label: clip.overlayStyle?.customIntroHeadline || clip.introHeadline || 'Intro Judul AI',
      startSec: 0,
      endSec: roundTime(introDur),
      color: '#f59e0b',
      meta: { role: 'intro_card' },
    },
  ];

  const cues = Array.isArray(clip.captionCues) ? clip.captionCues : [];
  if (cues.length > 0) {
    cues.slice(0, 24).forEach((cue, idx) => {
      const start = Math.max(0, Math.min(clipDuration - MIN_TIMELINE_SEGMENT_SEC, cue.offsetSec));
      const end = Math.min(clipDuration, Math.max(start + MIN_TIMELINE_SEGMENT_SEC, start + cue.durationSec));
      elements.push({
        id: `sub-${clip.id}-${idx + 1}`,
        trackType: 'subtitle',
        label: cue.text.slice(0, 48),
        startSec: roundTime(start),
        endSec: roundTime(end),
        color: '#10b981',
        meta: { cueIndex: idx },
      });
    });
  } else {
    elements.push({
      id: `sub-${clip.id}-1`,
      trackType: 'subtitle',
      label: clip.hookLine || clip.title,
      startSec: 0,
      endSec: Math.min(clipDuration, 5),
      color: '#10b981',
      meta: { cueIndex: 0 },
    });
  }

  return {
    id: `edproj-${clip.id}`,
    clipId: clip.id,
    userUid,
    workspaceId,
    title: clip.title,
    durationSec: clipDuration,
    zoomLevel: 1,
    safeAreaEnabled: true,
    elements,
    exportPreset: buildDefaultExportPreset(clip),
    version: 1,
    updatedAt: new Date().toISOString(),
  };
}

export function trimTimelineElement(
  elements: TimelineElement[],
  elementId: string,
  nextStartSec: number,
  nextEndSec: number,
  totalDurationSec: number
): TimelineElement[] {
  const maxDur = Math.max(MIN_TIMELINE_SEGMENT_SEC, totalDurationSec);
  return elements.map((el) => {
    if (el.id !== elementId || el.locked) return el;
    const clampedStart = roundTime(
      Math.max(0, Math.min(maxDur - MIN_TIMELINE_SEGMENT_SEC, nextStartSec))
    );
    const clampedEnd = roundTime(
      Math.max(clampedStart + MIN_TIMELINE_SEGMENT_SEC, Math.min(maxDur, nextEndSec))
    );
    const deltaStart = clampedStart - el.startSec;
    return {
      ...el,
      startSec: clampedStart,
      endSec: clampedEnd,
      sourceOffsetSec:
        typeof el.sourceOffsetSec === 'number'
          ? roundTime(Math.max(0, el.sourceOffsetSec + deltaStart))
          : el.sourceOffsetSec,
    };
  });
}

export function moveTimelineElement(
  elements: TimelineElement[],
  elementId: string,
  deltaSec: number,
  totalDurationSec: number
): TimelineElement[] {
  const maxDur = Math.max(MIN_TIMELINE_SEGMENT_SEC, totalDurationSec);
  return elements.map((el) => {
    if (el.id !== elementId || el.locked) return el;
    const segDur = Math.max(MIN_TIMELINE_SEGMENT_SEC, el.endSec - el.startSec);
    const clampedStart = roundTime(Math.max(0, Math.min(maxDur - segDur, el.startSec + deltaSec)));
    return {
      ...el,
      startSec: clampedStart,
      endSec: roundTime(Math.min(maxDur, clampedStart + segDur)),
    };
  });
}

export function splitTimelineElement(
  elements: TimelineElement[],
  elementId: string,
  splitAtSec: number
): { elements: TimelineElement[]; didSplit: boolean; rightElementId?: string } {
  const idx = elements.findIndex((el) => el.id === elementId);
  if (idx === -1) return { elements, didSplit: false };
  const target = elements[idx];
  if (target.locked) return { elements, didSplit: false };

  const cut = roundTime(splitAtSec);
  if (
    cut <= target.startSec + MIN_TIMELINE_SEGMENT_SEC ||
    cut >= target.endSec - MIN_TIMELINE_SEGMENT_SEC
  ) {
    return { elements, didSplit: false };
  }

  const left: TimelineElement = {
    ...target,
    endSec: cut,
  };
  const rightId = `${target.id}-b-${Math.round(cut * 10)}`;
  const leftDur = cut - target.startSec;
  const right: TimelineElement = {
    ...target,
    id: rightId,
    label: `${target.label} (Bagian 2)`,
    startSec: cut,
    endSec: target.endSec,
    sourceOffsetSec:
      typeof target.sourceOffsetSec === 'number'
        ? roundTime(target.sourceOffsetSec + leftDur)
        : target.sourceOffsetSec,
  };

  const next = [...elements.slice(0, idx), left, right, ...elements.slice(idx + 1)];
  return { elements: next, didSplit: true, rightElementId: rightId };
}

export function deleteTimelineElement(
  elements: TimelineElement[],
  elementId: string
): TimelineElement[] {
  const target = elements.find((el) => el.id === elementId);
  if (!target || target.locked) return elements;
  // Never leave zero video tracks — keep at least 1 primary video segment
  if (target.trackType === 'video') {
    const videoCount = elements.filter((el) => el.trackType === 'video').length;
    if (videoCount <= 1) return elements;
  }
  return elements.filter((el) => el.id !== elementId);
}

/**
 * Computes effective trim bounds (startSec, endSec relative to source video)
 * from the active video track segments so Smart Video Editor changes flow into FFmpeg renders.
 */
export function deriveClipBoundsFromTimeline(
  project: EditingProjectData,
  fallbackStartSec: number,
  fallbackEndSec: number
): { startSec: number; endSec: number } {
  const videos = project.elements
    .filter((el) => el.trackType === 'video')
    .sort((a, b) => a.startSec - b.startSec);
  if (videos.length === 0) {
    return { startSec: fallbackStartSec, endSec: fallbackEndSec };
  }
  const first = videos[0];
  const last = videos[videos.length - 1];
  const baseSourceStart =
    typeof first.sourceOffsetSec === 'number' ? first.sourceOffsetSec : fallbackStartSec;
  const spanSec = Math.max(5, Math.round(last.endSec - first.startSec));
  return {
    startSec: Math.max(0, Math.round(baseSourceStart)),
    endSec: Math.max(5, Math.round(baseSourceStart + spanSec)),
  };
}
