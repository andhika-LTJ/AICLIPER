import { useEffect, useMemo, useState } from 'react';
import {
  BookmarkPlus,
  Film,
  Grid,
  Loader2,
  MoveLeft,
  MoveRight,
  Play,
  Redo2,
  Save,
  Scissors,
  Trash2,
  Undo2,
  Volume2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  ClipOverlayStyle,
  ClipRenderLayout,
  EditingProjectData,
  PodcastClip,
  PodcastEpisode,
  TimelineElement,
  TimelineTrackType,
} from '../types/clipper';
import { apiFetch } from '../utils/apiClient';
import { DEFAULT_CLIP_OVERLAY_STYLE } from '../utils/clipOverlayStyle';
import {
  clampPlayhead,
  clampZoom,
  createDefaultEditingProject,
  deleteTimelineElement,
  moveTimelineElement,
  splitTimelineElement,
  trimTimelineElement,
} from '../../server/utils/timelineMath';

interface SmartVideoEditorViewProps {
  episodes: PodcastEpisode[];
  clips: PodcastClip[];
  activeEpisodeId: string;
  activeClipId: string;
  isAuthenticated: boolean;
  onSelectClip: (episodeId: string, clipId: string) => void;
  onUpdateClip: (clipId: string, patch: Partial<PodcastClip>) => Promise<void>;
  onJumpToRenderStudio: () => void;
}

const TRACK_LABELS: Record<TimelineTrackType, { label: string; color: string }> = {
  video: { label: 'Video Track', color: 'bg-red-600' },
  audio: { label: 'Audio Track', color: 'bg-sky-600' },
  text: { label: 'Intro & Text', color: 'bg-amber-500' },
  subtitle: { label: 'Subtitle Cues', color: 'bg-emerald-600' },
};

const SUBTITLE_STYLE_PRESETS: Array<{
  id: string;
  label: string;
  patch: Partial<ClipOverlayStyle>;
}> = [
  {
    id: 'viral_bold',
    label: 'Viral Shorts Kuning',
    patch: {
      fontFamily: 'condensed_viral',
      subtitleTextColor: '#FFFFFF',
      subtitleHighlightColor: '#FACC15',
      subtitleBoxStyle: 'outline',
      subtitleFontScale: 1.08,
    },
  },
  {
    id: 'studio_clean',
    label: 'Editorial Kotak Gelap',
    patch: {
      fontFamily: 'modern_sans',
      subtitleTextColor: '#F8FAFC',
      subtitleHighlightColor: '#38BDF8',
      subtitleBoxStyle: 'box',
      subtitleFontScale: 1.0,
    },
  },
  {
    id: 'podcast_serif',
    label: 'Podcast Klasik Serif',
    patch: {
      fontFamily: 'editorial_serif',
      subtitleTextColor: '#FFFFFF',
      subtitleHighlightColor: '#F59E0B',
      subtitleBoxStyle: 'shadow',
      subtitleFontScale: 1.02,
    },
  },
  {
    id: 'tech_mono',
    label: 'Tech Studio Mono',
    patch: {
      fontFamily: 'studio_mono',
      subtitleTextColor: '#E2E8F0',
      subtitleHighlightColor: '#34D399',
      subtitleBoxStyle: 'box',
      subtitleFontScale: 0.96,
    },
  },
];

function formatSec(sec: number): string {
  const safe = Math.max(0, sec);
  const m = Math.floor(safe / 60);
  const s = (safe % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

export function SmartVideoEditorView({
  episodes,
  clips,
  activeEpisodeId,
  activeClipId,
  isAuthenticated,
  onSelectClip,
  onUpdateClip,
  onJumpToRenderStudio,
}: SmartVideoEditorViewProps) {
  const selectedClip = clips.find((c) => c.id === activeClipId) ?? clips[0];
  const selectedEpisode =
    episodes.find((e) => e.id === (selectedClip?.episodeId ?? activeEpisodeId)) ?? episodes[0];

  const [project, setProject] = useState<EditingProjectData | null>(() =>
    selectedClip ? createDefaultEditingProject(selectedClip, 'local-preview') : null
  );
  const [undoStack, setUndoStack] = useState<TimelineElement[][]>([]);
  const [redoStack, setRedoStack] = useState<TimelineElement[][]>([]);
  const [playheadSec, setPlayheadSec] = useState<number>(6);
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [isLoadingProject, setIsLoadingProject] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingTemplate, setIsSavingTemplate] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedClip) return;
    let active = true;
    const fallbackProject = createDefaultEditingProject(selectedClip, 'local-preview');
    setProject(fallbackProject);
    setUndoStack([]);
    setRedoStack([]);
    setPlayheadSec(Math.min(6, Math.round(fallbackProject.durationSec / 2)));
    setSelectedElementId(fallbackProject.elements[0]?.id ?? null);
    setStatusMessage(null);
    setErrorMessage(null);

    if (!isAuthenticated) return;

    setIsLoadingProject(true);
    apiFetch(`/api/v2/editor/${encodeURIComponent(selectedClip.id)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { project?: EditingProjectData } | null) => {
        if (!active || !data?.project) return;
        setProject(data.project);
        setSelectedElementId(data.project.elements[0]?.id ?? null);
        setPlayheadSec((prev) => clampPlayhead(prev, data.project!.durationSec));
      })
      .catch(() => {})
      .finally(() => {
        if (active) setIsLoadingProject(false);
      });

    return () => {
      active = false;
    };
  }, [selectedClip?.id, isAuthenticated]);

  const selectedElement = useMemo(
    () => project?.elements.find((el) => el.id === selectedElementId) ?? null,
    [project, selectedElementId]
  );

  const activeSubtitleAtPlayhead = useMemo(() => {
    if (!project) return '';
    const hit = project.elements.find(
      (el) =>
        el.trackType === 'subtitle' &&
        playheadSec >= el.startSec &&
        playheadSec <= el.endSec
    );
    return hit?.label ?? selectedClip?.hookLine ?? '';
  }, [project, playheadSec, selectedClip?.hookLine]);

  const activeIntroAtPlayhead = useMemo(() => {
    if (!project || !project.exportPreset.includeIntro) return null;
    return (
      project.elements.find(
        (el) =>
          el.trackType === 'text' &&
          playheadSec >= el.startSec &&
          playheadSec <= el.endSec
      ) ?? null
    );
  }, [project, playheadSec]);

  if (!selectedClip || !selectedEpisode || !project) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-10 text-center">
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Pilih atau analisis minimal satu klip podcast di Studio Klip untuk membuka Smart Video Editor.
        </p>
      </div>
    );
  }

  const commitElements = (nextElements: TimelineElement[], feedback?: string) => {
    setUndoStack((prev) => [...prev.slice(-24), project.elements]);
    setRedoStack([]);
    setProject((prev) => (prev ? { ...prev, elements: nextElements } : prev));
    if (feedback) setStatusMessage(feedback);
  };

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const previous = undoStack[undoStack.length - 1];
    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev, project.elements]);
    setProject((prev) => (prev ? { ...prev, elements: previous } : prev));
    setStatusMessage('Perubahan timeline dibatalkan (Undo).');
  };

  const handleRedo = () => {
    if (redoStack.length === 0) return;
    const restored = redoStack[redoStack.length - 1];
    setRedoStack((prev) => prev.slice(0, -1));
    setUndoStack((prev) => [...prev, project.elements]);
    setProject((prev) => (prev ? { ...prev, elements: restored } : prev));
    setStatusMessage('Perubahan timeline dikembalikan (Redo).');
  };

  const handleSplitSelected = () => {
    if (!selectedElement) {
      setErrorMessage('Pilih elemen pada timeline terlebih dahulu sebelum memotong (Split).');
      return;
    }
    const result = splitTimelineElement(project.elements, selectedElement.id, playheadSec);
    if (!result.didSplit) {
      setErrorMessage(
        `Posisi playhead (${formatSec(playheadSec)}) harus berada di dalam segmen "${selectedElement.label}" (${formatSec(selectedElement.startSec)} – ${formatSec(selectedElement.endSec)}).`
      );
      return;
    }
    setErrorMessage(null);
    commitElements(result.elements, `Segmen "${selectedElement.label}" dipotong pada ${formatSec(playheadSec)}.`);
    if (result.rightElementId) setSelectedElementId(result.rightElementId);
  };

  const handleMoveSelected = (deltaSec: number) => {
    if (!selectedElement) return;
    setErrorMessage(null);
    const next = moveTimelineElement(
      project.elements,
      selectedElement.id,
      deltaSec,
      project.durationSec
    );
    commitElements(next, `Elemen digeser ${deltaSec > 0 ? `+${deltaSec}` : deltaSec} detik.`);
  };

  const handleDeleteSelected = () => {
    if (!selectedElement) return;
    const next = deleteTimelineElement(project.elements, selectedElement.id);
    if (next.length === project.elements.length) {
      setErrorMessage('Minimal 1 segmen Video Track utama harus tetap ada pada timeline.');
      return;
    }
    setErrorMessage(null);
    commitElements(next, `Elemen "${selectedElement.label}" dihapus dari timeline.`);
    setSelectedElementId(next[0]?.id ?? null);
  };

  const handleApplySubtitlePreset = async (preset: (typeof SUBTITLE_STYLE_PRESETS)[number]) => {
    const merged: ClipOverlayStyle = {
      ...DEFAULT_CLIP_OVERLAY_STYLE,
      ...(selectedClip.overlayStyle ?? {}),
      ...preset.patch,
    };
    await onUpdateClip(selectedClip.id, { overlayStyle: merged });
    setStatusMessage(`Preset subtitle "${preset.label}" diterapkan ke klip aktif.`);
  };

  const handleSaveProject = async () => {
    setErrorMessage(null);
    setStatusMessage(null);
    if (!isAuthenticated) {
      setStatusMessage('Perubahan timeline disimpan di sesi pratinjau lokal. Login Google untuk menyimpan ke database cloud.');
      return;
    }
    setIsSaving(true);
    try {
      const res = await apiFetch(`/api/v2/editor/${encodeURIComponent(selectedClip.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: project.title,
          durationSec: project.durationSec,
          zoomLevel: project.zoomLevel,
          safeAreaEnabled: project.safeAreaEnabled,
          elements: project.elements,
          exportPreset: project.exportPreset,
          syncClipBounds: true,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        project?: EditingProjectData;
        error?: string;
      };
      if (!res.ok) {
        setErrorMessage(data.error || 'Gagal menyimpan proyek editor.');
        return;
      }
      if (data.project) setProject(data.project);
      setStatusMessage(`Proyek editor v${data.project?.version ?? project.version} tersimpan & disinkronkan ke pipeline render FFmpeg.`);
    } catch {
      setErrorMessage('Gagal menghubungi server saat menyimpan timeline.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveExportTemplate = async () => {
    if (!isAuthenticated) {
      setErrorMessage('Masuk dengan Google terlebih dahulu untuk menyimpan template ke Pustaka Template.');
      return;
    }
    setIsSavingTemplate(true);
    setErrorMessage(null);
    try {
      const res = await apiFetch('/api/v2/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Preset Export ${project.exportPreset.resolution.toUpperCase()} ${project.exportPreset.fps}fps`,
          category: 'export',
          description: `Layout ${project.exportPreset.layout}, audio ${project.exportPreset.normalizeAudio ? '-14 LUFS' : 'original'}.`,
          isPublic: false,
          config: project.exportPreset as unknown as Record<string, unknown>,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setErrorMessage(err.error || 'Gagal menyimpan template export.');
        return;
      }
      setStatusMessage('Preset export berhasil disimpan ke Pustaka Template.');
    } finally {
      setIsSavingTemplate(false);
    }
  };

  const trackTypes: TimelineTrackType[] = ['video', 'audio', 'text', 'subtitle'];
  const isVerticalPreview =
    project.exportPreset.layout === 'shorts_full_bleed' ||
    project.exportPreset.layout === 'shorts_studio_focus' ||
    project.exportPreset.layout === 'vertical_9_16';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
            Smart Video Editor (Multi-Track Non-Destruktif)
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Atur segmen video, audio, intro AI, subtitle, safe-area overlay, dan preset ekspor FFmpeg tanpa merusak file sumber.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="editor-clip-select" className="sr-only">
            Pilih klip untuk diedit
          </label>
          <select
            id="editor-clip-select"
            value={selectedClip.id}
            onChange={(e) => {
              const next = clips.find((c) => c.id === e.target.value);
              if (next) onSelectClip(next.episodeId, next.id);
            }}
            className="h-9 px-3 text-xs font-medium bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg max-w-[260px]"
          >
            {clips.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.orderIndex} · {c.title.slice(0, 42)}
              </option>
            ))}
          </select>

          <button
            type="button"
            disabled={isSaving}
            onClick={() => void handleSaveProject()}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 text-xs font-semibold text-white bg-slate-900 dark:bg-red-600 hover:bg-slate-800 dark:hover:bg-red-700 rounded-lg cursor-pointer disabled:opacity-60"
          >
            {isSaving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Save className="w-3.5 h-3.5" aria-hidden="true" />
            )}
            <span>Simpan Timeline</span>
          </button>

          <button
            type="button"
            onClick={onJumpToRenderStudio}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 text-xs font-semibold text-slate-800 dark:text-slate-100 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-red-500 rounded-lg cursor-pointer"
          >
            <Film className="w-3.5 h-3.5 text-red-600" aria-hidden="true" />
            <span>Render MP4 di Studio</span>
          </button>
        </div>
      </div>

      {statusMessage && (
        <div
          role="status"
          className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200 rounded-lg px-4 py-2.5 text-xs font-medium"
        >
          {statusMessage}
        </div>
      )}

      {errorMessage && (
        <div
          role="alert"
          className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-200 rounded-lg px-4 py-2.5 text-xs font-medium"
        >
          {errorMessage}
        </div>
      )}

      {/* Main Editor Workspace: Preview Stage + Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-6 items-start">
        {/* Stage Preview + Safe Area */}
        <section
          aria-label="Pratinjau kanvas editor"
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="font-mono tabular-nums text-slate-600 dark:text-slate-400">
              Playhead {formatSec(playheadSec)} / {formatSec(project.durationSec)} ·{' '}
              {project.exportPreset.resolution.toUpperCase()} · {project.exportPreset.fps} FPS
            </div>
            <button
              type="button"
              aria-pressed={project.safeAreaEnabled}
              onClick={() =>
                setProject((prev) =>
                  prev ? { ...prev, safeAreaEnabled: !prev.safeAreaEnabled } : prev
                )
              }
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-medium cursor-pointer ${
                project.safeAreaEnabled
                  ? 'border-red-600 text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
              }`}
            >
              <Grid className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Safe Area {project.safeAreaEnabled ? 'Aktif' : 'Nonaktif'}</span>
            </button>
          </div>

          <div className="flex justify-center bg-slate-950 rounded-xl p-4 sm:p-6 overflow-hidden">
            <div
              className={`relative rounded-lg overflow-hidden bg-slate-900 border border-slate-700 flex flex-col justify-between ${
                isVerticalPreview
                  ? 'w-[220px] sm:w-[250px] aspect-[9/16]'
                  : project.exportPreset.layout === 'square_1_1'
                    ? 'w-[280px] aspect-square'
                    : 'w-full max-w-[460px] aspect-video'
              }`}
            >
              <img
                src={selectedEpisode.thumbnailUrl || selectedEpisode.fallbackImageUrl}
                alt={selectedClip.title}
                className="absolute inset-0 w-full h-full object-cover opacity-55"
              />
              <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black/75" />

              {project.safeAreaEnabled && (
                <div
                  aria-label="Garis panduan Safe Area"
                  className="pointer-events-none absolute inset-x-3 top-10 bottom-14 border border-dashed border-amber-400/70 rounded"
                >
                  <span className="absolute -top-4 left-1 text-[9px] font-mono text-amber-300 uppercase">
                    Safe Zone UI Shorts/Reels
                  </span>
                </div>
              )}

              <div className="relative z-10 p-3 flex items-center justify-between text-[10px] font-mono text-white/90">
                <span>{selectedEpisode.channelName.slice(0, 20)}</span>
                <span>{formatSec(playheadSec)}</span>
              </div>

              {activeIntroAtPlayhead && (
                <div className="relative z-10 mx-4 my-auto text-center bg-black/70 border border-white/15 rounded-lg p-3 space-y-1">
                  <p className="text-[10px] font-mono uppercase tracking-wider text-amber-400">
                    {selectedClip.overlayStyle?.customIntroTag || selectedClip.introTag || 'HIGHLIGHT'}
                  </p>
                  <p className="font-display text-xs sm:text-sm font-bold text-white leading-snug">
                    {activeIntroAtPlayhead.label}
                  </p>
                </div>
              )}

              {project.exportPreset.includeSubtitles && (
                <div className="relative z-10 px-4 pb-6 text-center">
                  <p className="inline-block px-2.5 py-1 rounded bg-black/75 text-white text-xs font-semibold leading-snug">
                    {activeSubtitleAtPlayhead || selectedClip.title}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Playhead Scrubber */}
          <div className="flex items-center gap-3">
            <Play className="w-4 h-4 text-slate-500 shrink-0" aria-hidden="true" />
            <label htmlFor="editor-playhead-slider" className="sr-only">
              Geser posisi playhead timeline
            </label>
            <input
              id="editor-playhead-slider"
              type="range"
              min={0}
              max={project.durationSec}
              step={0.5}
              value={playheadSec}
              onChange={(e) => setPlayheadSec(clampPlayhead(Number(e.target.value), project.durationSec))}
              className="flex-1 accent-red-600 cursor-pointer"
            />
            <span className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300 w-16 text-right">
              {formatSec(playheadSec)}
            </span>
          </div>
        </section>

        {/* Right Inspector: Selected Segment + Subtitle Presets + Export Preset */}
        <aside className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-5">
          {/* Selected Element Inspector */}
          <div className="space-y-3">
            <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white">
              Inspektor Elemen Terpilih
            </h2>
            {selectedElement ? (
              <div className="space-y-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                <div className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                  {selectedElement.label}
                </div>
                <div className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                  Track: {selectedElement.trackType} · {formatSec(selectedElement.startSec)} –{' '}
                  {formatSec(selectedElement.endSec)}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label
                      htmlFor="seg-start-input"
                      className="block text-[11px] text-slate-600 dark:text-slate-400 mb-1"
                    >
                      Mulai (detik)
                    </label>
                    <input
                      id="seg-start-input"
                      type="number"
                      step={0.5}
                      min={0}
                      max={project.durationSec}
                      value={selectedElement.startSec}
                      onChange={(e) => {
                        const next = trimTimelineElement(
                          project.elements,
                          selectedElement.id,
                          Number(e.target.value),
                          selectedElement.endSec,
                          project.durationSec
                        );
                        commitElements(next);
                      }}
                      className="w-full h-8 px-2 text-xs font-mono bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="seg-end-input"
                      className="block text-[11px] text-slate-600 dark:text-slate-400 mb-1"
                    >
                      Akhir (detik)
                    </label>
                    <input
                      id="seg-end-input"
                      type="number"
                      step={0.5}
                      min={0.5}
                      max={project.durationSec}
                      value={selectedElement.endSec}
                      onChange={(e) => {
                        const next = trimTimelineElement(
                          project.elements,
                          selectedElement.id,
                          selectedElement.startSec,
                          Number(e.target.value),
                          project.durationSec
                        );
                        commitElements(next);
                      }}
                      className="w-full h-8 px-2 text-xs font-mono bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded"
                    />
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-500">Klik segmen di timeline untuk mengedit waktu mulai/akhir.</p>
            )}
          </div>

          {/* Subtitle Style Presets */}
          <div className="space-y-2.5 pt-3 border-t border-slate-100 dark:border-slate-800">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Preset Gaya Subtitle
            </h3>
            <div className="grid grid-cols-2 gap-2">
              {SUBTITLE_STYLE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => void handleApplySubtitlePreset(preset)}
                  className="px-2.5 py-2 text-left text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 hover:border-red-500 rounded-lg cursor-pointer"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Export Preset (Resolution, FPS, Format, Aspect Ratio, Audio) */}
          <div className="space-y-3 pt-3 border-t border-slate-100 dark:border-slate-800">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Preset Ekspor FFmpeg
              </h3>
              <button
                type="button"
                disabled={isSavingTemplate}
                onClick={() => void handleSaveExportTemplate()}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-600 dark:text-red-400 hover:underline cursor-pointer"
              >
                <BookmarkPlus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Simpan Template</span>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label htmlFor="export-res" className="block text-[11px] text-slate-600 dark:text-slate-400 mb-1">
                  Resolusi
                </label>
                <select
                  id="export-res"
                  value={project.exportPreset.resolution}
                  onChange={(e) =>
                    setProject((prev) =>
                      prev
                        ? {
                            ...prev,
                            exportPreset: {
                              ...prev.exportPreset,
                              resolution: e.target.value as '1080p' | '4k',
                            },
                          }
                        : prev
                    )
                  }
                  className="w-full h-9 px-2.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"
                >
                  <option value="1080p">1080p Full HD</option>
                  <option value="4k">4K Ultra HD</option>
                </select>
              </div>
              <div>
                <label htmlFor="export-fps" className="block text-[11px] text-slate-600 dark:text-slate-400 mb-1">
                  Frame Rate (FPS)
                </label>
                <select
                  id="export-fps"
                  value={project.exportPreset.fps}
                  onChange={(e) =>
                    setProject((prev) =>
                      prev
                        ? {
                            ...prev,
                            exportPreset: {
                              ...prev.exportPreset,
                              fps: Number(e.target.value) as 24 | 30 | 60,
                            },
                          }
                        : prev
                    )
                  }
                  className="w-full h-9 px-2.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"
                >
                  <option value={24}>24 FPS (Sinematik)</option>
                  <option value={30}>30 FPS (Standar)</option>
                  <option value={60}>60 FPS (Halus)</option>
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="export-layout" className="block text-[11px] text-slate-600 dark:text-slate-400 mb-1">
                Rasio Aspek & Layout
              </label>
              <select
                id="export-layout"
                value={project.exportPreset.layout}
                onChange={(e) =>
                  setProject((prev) =>
                    prev
                      ? {
                          ...prev,
                          exportPreset: {
                            ...prev.exportPreset,
                            layout: e.target.value as ClipRenderLayout,
                          },
                        }
                      : prev
                  )
                }
                className="w-full h-9 px-2.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"
              >
                <option value="shorts_full_bleed">9:16 Vertical Full Frame (Shorts / Reels / TikTok)</option>
                <option value="shorts_studio_focus">9:16 Studio Focus Split</option>
                <option value="portrait_4_5">4:5 Portrait Feed</option>
                <option value="square_1_1">1:1 Square Feed</option>
                <option value="full_16_9_focus">16:9 Landscape YouTube</option>
              </select>
            </div>

            <div className="space-y-1.5 text-xs text-slate-700 dark:text-slate-300">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={project.exportPreset.includeSubtitles}
                  onChange={(e) =>
                    setProject((prev) =>
                      prev
                        ? {
                            ...prev,
                            exportPreset: {
                              ...prev.exportPreset,
                              includeSubtitles: e.target.checked,
                            },
                          }
                        : prev
                    )
                  }
                  className="accent-red-600"
                />
                <span>Sertakan Burn-In Subtitle</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={project.exportPreset.includeIntro}
                  onChange={(e) =>
                    setProject((prev) =>
                      prev
                        ? {
                            ...prev,
                            exportPreset: {
                              ...prev.exportPreset,
                              includeIntro: e.target.checked,
                            },
                          }
                        : prev
                    )
                  }
                  className="accent-red-600"
                />
                <span>Sertakan Kartu Intro AI</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={project.exportPreset.normalizeAudio}
                  onChange={(e) =>
                    setProject((prev) =>
                      prev
                        ? {
                            ...prev,
                            exportPreset: {
                              ...prev.exportPreset,
                              normalizeAudio: e.target.checked,
                            },
                          }
                        : prev
                    )
                  }
                  className="accent-red-600"
                />
                <Volume2 className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                <span>Normalisasi Audio Loudness (-14 LUFS)</span>
              </label>
            </div>
          </div>
        </aside>
      </div>

      {/* Multi-Track Timeline Toolbar & Tracks */}
      <section
        aria-label="Multi-track timeline editor"
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-slate-800">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={handleSplitSelected}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer"
            >
              <Scissors className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Split di Playhead</span>
            </button>
            <button
              type="button"
              onClick={() => handleMoveSelected(-1)}
              aria-label="Geser elemen ke kiri 1 detik"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg cursor-pointer"
            >
              <MoveLeft className="w-3.5 h-3.5" aria-hidden="true" />
              <span>-1d</span>
            </button>
            <button
              type="button"
              onClick={() => handleMoveSelected(1)}
              aria-label="Geser elemen ke kanan 1 detik"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg cursor-pointer"
            >
              <span>+1d</span>
              <MoveRight className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={handleDeleteSelected}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 hover:bg-red-100 rounded-lg cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Hapus Elemen</span>
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={undoStack.length === 0}
              onClick={handleUndo}
              aria-label="Undo perubahan timeline"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 rounded-lg cursor-pointer disabled:opacity-40"
            >
              <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Undo</span>
            </button>
            <button
              type="button"
              disabled={redoStack.length === 0}
              onClick={handleRedo}
              aria-label="Redo perubahan timeline"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 rounded-lg cursor-pointer disabled:opacity-40"
            >
              <Redo2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Redo</span>
            </button>
            <span className="h-4 w-px bg-slate-200 dark:bg-slate-700 mx-1" aria-hidden="true" />
            <button
              type="button"
              aria-label="Perkecil zoom timeline"
              onClick={() =>
                setProject((prev) =>
                  prev ? { ...prev, zoomLevel: clampZoom(prev.zoomLevel - 0.5) } : prev
                )
              }
              className="p-1.5 text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 rounded-lg cursor-pointer"
            >
              <ZoomOut className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <span className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300 w-10 text-center">
              {project.zoomLevel.toFixed(1)}x
            </span>
            <button
              type="button"
              aria-label="Perbesar zoom timeline"
              onClick={() =>
                setProject((prev) =>
                  prev ? { ...prev, zoomLevel: clampZoom(prev.zoomLevel + 0.5) } : prev
                )
              }
              className="p-1.5 text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 rounded-lg cursor-pointer"
            >
              <ZoomIn className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {isLoadingProject && (
          <p className="text-xs text-slate-500">Memuat state timeline terakhir dari database...</p>
        )}

        {/* Scrollable Multi-Track Canvas */}
        <div className="overflow-x-auto pb-2">
          <div
            style={{ width: `${Math.max(100, Math.round(project.zoomLevel * 100))}%` }}
            className="min-w-[640px] space-y-2.5 relative"
          >
            {trackTypes.map((trackType) => {
              const items = project.elements.filter((el) => el.trackType === trackType);
              const meta = TRACK_LABELS[trackType];
              return (
                <div
                  key={trackType}
                  className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 items-center"
                >
                  <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 truncate">
                    {meta.label}
                  </div>
                  <div className="relative h-10 rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 overflow-hidden">
                    {/* Playhead Marker Line */}
                    <div
                      aria-hidden="true"
                      style={{
                        left: `${(playheadSec / Math.max(1, project.durationSec)) * 100}%`,
                      }}
                      className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-red-500 z-20"
                    />
                    {items.map((el) => {
                      const leftPct = (el.startSec / Math.max(1, project.durationSec)) * 100;
                      const widthPct = Math.max(
                        3,
                        ((el.endSec - el.startSec) / Math.max(1, project.durationSec)) * 100
                      );
                      const isSelected = el.id === selectedElementId;
                      return (
                        <button
                          key={el.id}
                          type="button"
                          onClick={() => setSelectedElementId(el.id)}
                          style={{
                            left: `${leftPct}%`,
                            width: `${widthPct}%`,
                          }}
                          className={`absolute top-1 bottom-1 px-2 rounded text-left text-[11px] font-medium text-white truncate cursor-pointer ${
                            meta.color
                          } ${isSelected ? 'ring-2 ring-slate-900 dark:ring-white z-10' : 'opacity-85 hover:opacity-100'}`}
                        >
                          {el.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}
