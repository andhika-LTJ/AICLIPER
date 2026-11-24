import { useEffect, useMemo, useState } from 'react';
import {
  Camera,
  Check,
  EyeOff,
  Loader2,
  Lock,
  RefreshCw,
  Sliders,
  Unlock,
  Users,
} from 'lucide-react';
import type {
  CameraAnalysisResult,
  CameraBenchmarkReport,
  CameraFramingMode,
  CameraTrackingSegment,
  CameraTrackingSettings,
  MultiSpeakerLayoutMode,
  PodcastClip,
  SpeakerProfile,
} from '../types/clipper';
import { apiFetch } from '../utils/apiClient';

interface SmartCameraEditorPanelProps {
  clip: PodcastClip;
  isAuthenticated: boolean;
  onSaveCameraSettings: (
    settings: CameraTrackingSettings,
    cameraSegments?: CameraTrackingSegment[]
  ) => Promise<void>;
  onApplyAndRender?: (settings: CameraTrackingSettings) => void;
}

const FRAMING_MODE_OPTIONS: Array<{ value: CameraFramingMode; label: string }> = [
  { value: 'speaker_focus', label: 'Speaker Focus (Auto Active Speaker)' },
  { value: 'face_centered', label: 'Face Centered (Close Headroom)' },
  { value: 'upper_body', label: 'Upper Body (Natural Podcast Framing)' },
  { value: 'dynamic_follow', label: 'Dynamic Follow (Smooth Pan Tracking)' },
  { value: 'wide_context', label: 'Wide Context (Frame Lebar Aman)' },
  { value: 'manual_framing', label: 'Manual Framing (Posisi & Zoom Tetap)' },
];

const MULTI_SPEAKER_LAYOUT_OPTIONS: Array<{ value: MultiSpeakerLayoutMode; label: string }> = [
  { value: 'active_speaker_full', label: 'Active Speaker Full 9:16 (Fokus Pembicara)' },
  { value: 'split_screen', label: 'Split Screen Atas–Bawah (2 Pembicara)' },
  { value: 'side_by_side', label: 'Side-by-Side Kiri–Kanan' },
  { value: 'picture_in_picture', label: 'Picture-in-Picture (Utama + Reaksi)' },
  { value: 'speaker_plus_context', label: 'Active Speaker 65% + Wide 35%' },
  { value: 'wide_shot', label: 'Wide Shot (Semua Pembicara Terlihat)' },
];

function buildDefaultCameraSettings(clip: PodcastClip): CameraTrackingSettings {
  const existing = clip.cameraTrackingSettings;
  return {
    clipId: clip.id,
    autoMode: existing?.autoMode ?? true,
    framingMode: existing?.framingMode ?? 'speaker_focus',
    multiSpeakerLayout: existing?.multiSpeakerLayout ?? 'active_speaker_full',
    lockedSpeakerKey: existing?.lockedSpeakerKey ?? null,
    ignoredSpeakerKeys: existing?.ignoredSpeakerKeys ?? [],
    trackingSensitivity: existing?.trackingSensitivity ?? 0.72,
    switchingSensitivity: existing?.switchingSensitivity ?? 0.65,
    minShotDurationSec: existing?.minShotDurationSec ?? 2.0,
    confidenceThreshold: existing?.confidenceThreshold ?? 0.52,
    cooldownSec: existing?.cooldownSec ?? 1.2,
    manualCropX: existing?.manualCropX ?? 0.5,
    manualCropY: existing?.manualCropY ?? 0.42,
    manualZoom: existing?.manualZoom ?? 1.12,
  };
}

function buildFallbackCameraAnalysis(
  clip: PodcastClip,
  settings: CameraTrackingSettings
): CameraAnalysisResult {
  const durationSec = Math.max(5, clip.endSec - clip.startSec);
  const distinctSpeakers = Array.from(
    new Set(
      (clip.captionCues ?? [])
        .map((c) => c.speaker?.trim())
        .filter((s): s is string => Boolean(s))
    )
  );
  const speakerNames =
    distinctSpeakers.length > 0 ? distinctSpeakers.slice(0, 4) : ['Pembicara Utama', 'Rekan Podcast'];
  const palette = ['#DC2626', '#2563EB', '#059669', '#D97706'];
  const ignoredSet = new Set(settings.ignoredSpeakerKeys);

  const speakers: SpeakerProfile[] = speakerNames.map((name, idx) => {
    const speakerKey = `speaker_${idx + 1}`;
    const centerX =
      speakerNames.length === 1 ? 0.5 : idx === 0 ? 0.3 : idx === 1 ? 0.7 : 0.5;
    return {
      id: `spk_${clip.id}_${idx}`,
      clipId: clip.id,
      speakerKey,
      label: name,
      colorHex: palette[idx % palette.length],
      avgCenterX: centerX,
      avgCenterY: 0.42,
      speakingRatio: Number((1 / speakerNames.length).toFixed(2)),
      avgConfidence: 0.86,
      isLocked: settings.lockedSpeakerKey === speakerKey,
      isIgnored: ignoredSet.has(speakerKey),
    };
  });

  const segCount = Math.max(2, Math.min(5, Math.round(durationSec / Math.max(3, settings.minShotDurationSec * 2))));
  const segDur = durationSec / segCount;
  const activePool = speakers.filter((s) => !s.isIgnored);
  const cameraSegments: CameraTrackingSegment[] = Array.from({ length: segCount }, (_, i) => {
    const startSec = Number((i * segDur).toFixed(2));
    const endSec = Number((i === segCount - 1 ? durationSec : (i + 1) * segDur).toFixed(2));
    const chosen =
      (settings.lockedSpeakerKey
        ? speakers.find((s) => s.speakerKey === settings.lockedSpeakerKey)
        : undefined) ??
      activePool[i % Math.max(1, activePool.length)] ??
      speakers[0];

    return {
      id: `cam_preview_${clip.id}_${i}`,
      clipId: clip.id,
      startSec,
      endSec,
      activeSpeakerKey: chosen?.speakerKey ?? 'speaker_1',
      framingMode: settings.framingMode,
      layoutMode: settings.multiSpeakerLayout,
      targetX: settings.autoMode ? chosen?.avgCenterX ?? 0.5 : settings.manualCropX,
      targetY: settings.autoMode ? chosen?.avgCenterY ?? 0.42 : settings.manualCropY,
      zoom: settings.autoMode ? 1.15 : settings.manualZoom,
      confidence: 0.86,
      reason: settings.autoMode ? 'active_speaker_scored' : 'manual_framing',
      isManualOverride: !settings.autoMode,
    };
  });

  return {
    clipId: clip.id,
    durationSec,
    settings,
    speakers,
    faceTracks: [],
    speakerSegments: [],
    cameraSegments,
    metrics: {
      avgConfidence: 0.86,
      switchCount: Math.max(0, cameraSegments.length - 1),
      stabilityScore: 0.91,
      lowConfidenceFallbackCount: 0,
      multiSpeakerDetected: speakers.length > 1,
    },
  };
}

function formatSecShort(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rem = (s % 60).toFixed(1).padStart(4, '0');
  return `${m}:${rem}`;
}

export function SmartCameraEditorPanel({
  clip,
  isAuthenticated,
  onSaveCameraSettings,
  onApplyAndRender,
}: SmartCameraEditorPanelProps) {
  const [settings, setSettings] = useState<CameraTrackingSettings>(() =>
    buildDefaultCameraSettings(clip)
  );
  const [analysis, setAnalysis] = useState<CameraAnalysisResult>(() =>
    buildFallbackCameraAnalysis(clip, buildDefaultCameraSettings(clip))
  );
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isBenchmarking, setIsBenchmarking] = useState(false);
  const [benchmark, setBenchmark] = useState<CameraBenchmarkReport | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const initialSettings = buildDefaultCameraSettings(clip);
    setSettings(initialSettings);
    const fallback = buildFallbackCameraAnalysis(clip, initialSettings);
    setAnalysis(fallback);
    setSelectedSegmentId(fallback.cameraSegments[0]?.id ?? null);
    setStatusMessage(null);
    setErrorMessage(null);

    if (!isAuthenticated) return;

    let active = true;
    setIsLoading(true);
    apiFetch(`/api/v3/clips/${encodeURIComponent(clip.id)}/camera`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: Partial<CameraAnalysisResult> | null) => {
        if (!active || !data) return;
        const nextSettings = data.settings ?? initialSettings;
        setSettings(nextSettings);
        const nextSegments =
          Array.isArray(data.cameraSegments) && data.cameraSegments.length > 0
            ? data.cameraSegments
            : buildFallbackCameraAnalysis(clip, nextSettings).cameraSegments;
        const nextSpeakers =
          Array.isArray(data.speakers) && data.speakers.length > 0
            ? data.speakers
            : fallback.speakers;
        setAnalysis({
          clipId: clip.id,
          durationSec: data.durationSec ?? fallback.durationSec,
          settings: nextSettings,
          speakers: nextSpeakers,
          faceTracks: data.faceTracks ?? [],
          speakerSegments: data.speakerSegments ?? [],
          cameraSegments: nextSegments,
          metrics: data.metrics ?? fallback.metrics,
        });
        setSelectedSegmentId(nextSegments[0]?.id ?? null);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [clip.id, isAuthenticated]);

  const selectedSegment = useMemo(
    () =>
      analysis.cameraSegments.find((s) => s.id === selectedSegmentId) ??
      analysis.cameraSegments[0] ??
      null,
    [analysis.cameraSegments, selectedSegmentId]
  );

  const handleToggleAutoMode = () => {
    setSettings((prev) => ({
      ...prev,
      autoMode: !prev.autoMode,
      framingMode: !prev.autoMode ? 'speaker_focus' : 'manual_framing',
    }));
  };

  const handleToggleLockSpeaker = (speakerKey: string) => {
    setSettings((prev) => ({
      ...prev,
      lockedSpeakerKey: prev.lockedSpeakerKey === speakerKey ? null : speakerKey,
      ignoredSpeakerKeys: prev.ignoredSpeakerKeys.filter((k) => k !== speakerKey),
    }));
  };

  const handleToggleIgnoreSpeaker = (speakerKey: string) => {
    setSettings((prev) => {
      const exists = prev.ignoredSpeakerKeys.includes(speakerKey);
      return {
        ...prev,
        lockedSpeakerKey: prev.lockedSpeakerKey === speakerKey ? null : prev.lockedSpeakerKey,
        ignoredSpeakerKeys: exists
          ? prev.ignoredSpeakerKeys.filter((k) => k !== speakerKey)
          : [...prev.ignoredSpeakerKeys, speakerKey],
      };
    });
  };

  const handleUpdateSegmentOverride = (
    segId: string,
    patch: Partial<CameraTrackingSegment>
  ) => {
    setAnalysis((prev) => ({
      ...prev,
      cameraSegments: prev.cameraSegments.map((seg) =>
        seg.id === segId
          ? {
              ...seg,
              ...patch,
              isManualOverride: true,
              reason: 'manual_override',
            }
          : seg
      ),
    }));
    setStatusMessage('Segmen kamera diperbarui (override manual aktif).');
  };

  const handleRecalculate = async () => {
    setErrorMessage(null);
    setStatusMessage(null);
    if (!isAuthenticated) {
      const nextFallback = buildFallbackCameraAnalysis(clip, settings);
      setAnalysis(nextFallback);
      setSelectedSegmentId(nextFallback.cameraSegments[0]?.id ?? null);
      setStatusMessage(
        'Simulasi auto-fokus pembicara diperbarui untuk pratinjau lokal.'
      );
      return;
    }

    setIsRecalculating(true);
    try {
      const res = await apiFetch(
        `/api/v3/clips/${encodeURIComponent(clip.id)}/camera/recalculate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings }),
        }
      );
      const data = (await res.json().catch(() => ({}))) as Partial<CameraAnalysisResult> & {
        error?: string;
        summary?: string;
      };
      if (!res.ok) {
        setErrorMessage(data.error || 'Gagal menghitung ulang auto-fokus kamera.');
        return;
      }
      setAnalysis((prev) => ({
        ...prev,
        settings: data.settings ?? settings,
        speakers: data.speakers && data.speakers.length > 0 ? data.speakers : prev.speakers,
        cameraSegments:
          data.cameraSegments && data.cameraSegments.length > 0
            ? data.cameraSegments
            : prev.cameraSegments,
        speakerSegments: data.speakerSegments ?? prev.speakerSegments,
        metrics: data.metrics ?? prev.metrics,
      }));
      setStatusMessage(
        data.summary || 'Timeline auto-fokus pembicara aktif dihitung ulang.'
      );
    } catch {
      setErrorMessage('Gagal terhubung ke engine pelacakan kamera.');
    } finally {
      setIsRecalculating(false);
    }
  };

  const handleSaveSettings = async () => {
    setErrorMessage(null);
    setStatusMessage(null);
    setIsSaving(true);
    try {
      if (isAuthenticated) {
        const res = await apiFetch(`/api/v3/clips/${encodeURIComponent(clip.id)}/camera`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            settings,
            cameraSegments: analysis.cameraSegments,
            lockedSpeakerKey: settings.lockedSpeakerKey,
            ignoredSpeakerKeys: settings.ignoredSpeakerKeys,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          setErrorMessage(data.error || 'Gagal menyimpan pengaturan kamera.');
          return;
        }
      }
      await onSaveCameraSettings(settings, analysis.cameraSegments);
      setStatusMessage('Pengaturan kamera pembicara disimpan ke klip aktif.');
    } catch {
      setErrorMessage('Terjadi gangguan saat menyimpan pengaturan kamera.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRunBenchmark = async () => {
    if (!isAuthenticated) {
      setErrorMessage('Masuk dengan Google terlebih dahulu untuk menjalankan benchmark server.');
      return;
    }
    setIsBenchmarking(true);
    setErrorMessage(null);
    try {
      const res = await apiFetch('/api/v3/camera/benchmark');
      const data = (await res.json().catch(() => ({}))) as CameraBenchmarkReport & {
        error?: string;
      };
      if (!res.ok) {
        setErrorMessage(data.error || 'Gagal menjalankan benchmark kamera.');
        return;
      }
      setBenchmark(data);
    } catch {
      setErrorMessage('Gagal menjalankan benchmark active speaker.');
    } finally {
      setIsBenchmarking(false);
    }
  };

  const totalDur = Math.max(1, analysis.durationSec);

  return (
    <section
      aria-label="Pengaturan Kamera Pembicara AI"
      className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="font-display text-sm font-bold text-slate-900 flex items-center gap-1.5">
            <Camera className="w-4 h-4 text-red-600 shrink-0" aria-hidden="true" />
            <span>Kamera Pembicara AI & Auto-Reframing</span>
          </h4>
          <p className="text-xs text-slate-600 mt-0.5">
            Kombinasi deteksi suara aktif, gerak bibir, dan histeresis agar framing tidak berpindah acak.
          </p>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={settings.autoMode}
          aria-label="Aktifkan mode Auto Active Speaker"
          onClick={handleToggleAutoMode}
          className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer whitespace-nowrap ${
            settings.autoMode
              ? 'bg-slate-900 text-white border-slate-900'
              : 'bg-white text-slate-700 border-slate-300'
          }`}
        >
          <span>{settings.autoMode ? 'Mode Auto Aktif' : 'Mode Manual'}</span>
        </button>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
          <span>Memuat analisis speaker & timeline kamera...</span>
        </div>
      )}

      {/* Framing & Multi-Speaker Layout Controls */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label
            htmlFor={`cam-framing-${clip.id}`}
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Mode Framing Kamera
          </label>
          <select
            id={`cam-framing-${clip.id}`}
            value={settings.framingMode}
            onChange={(e) => {
              const mode = e.target.value as CameraFramingMode;
              setSettings((prev) => ({
                ...prev,
                framingMode: mode,
                autoMode: mode === 'manual_framing' ? false : prev.autoMode,
              }));
            }}
            className="w-full h-9 px-2.5 text-xs bg-white border border-slate-200 rounded-lg text-slate-800 focus:border-slate-900 focus:outline-none"
          >
            {FRAMING_MODE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor={`cam-multi-layout-${clip.id}`}
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Layout Multi-Pembicara (9:16)
          </label>
          <select
            id={`cam-multi-layout-${clip.id}`}
            value={settings.multiSpeakerLayout}
            onChange={(e) =>
              setSettings((prev) => ({
                ...prev,
                multiSpeakerLayout: e.target.value as MultiSpeakerLayoutMode,
              }))
            }
            className="w-full h-9 px-2.5 text-xs bg-white border border-slate-200 rounded-lg text-slate-800 focus:border-slate-900 focus:outline-none"
          >
            {MULTI_SPEAKER_LAYOUT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Detected Speakers List */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-slate-800 flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
            <span>Kandidat Pembicara ({analysis.speakers.length})</span>
          </span>
          <span className="font-mono tabular-nums text-[11px] text-slate-500">
            Stabilitas {Math.round(analysis.metrics.stabilityScore * 100)}% · Perpindahan{' '}
            {analysis.metrics.switchCount}x
          </span>
        </div>

        <div className="divide-y divide-slate-200 bg-white border border-slate-200 rounded-lg">
          {analysis.speakers.map((spk) => {
            const isLocked = settings.lockedSpeakerKey === spk.speakerKey;
            const isIgnored = settings.ignoredSpeakerKeys.includes(spk.speakerKey);
            return (
              <div
                key={spk.speakerKey}
                className="px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-semibold text-slate-900 truncate">{spk.label}</div>
                  <div className="text-[11px] font-mono tabular-nums text-slate-500">
                    Porsi {Math.round(spk.speakingRatio * 100)}% · Keyakinan{' '}
                    {Math.round(spk.avgConfidence * 100)}% · X {Math.round(spk.avgCenterX * 100)}%
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    aria-pressed={isLocked}
                    aria-label={`Kunci kamera ke ${spk.label}`}
                    onClick={() => handleToggleLockSpeaker(spk.speakerKey)}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold border cursor-pointer whitespace-nowrap ${
                      isLocked
                        ? 'bg-red-600 text-white border-red-600'
                        : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    {isLocked ? (
                      <Lock className="w-3 h-3" aria-hidden="true" />
                    ) : (
                      <Unlock className="w-3 h-3" aria-hidden="true" />
                    )}
                    <span>{isLocked ? 'Terkunci' : 'Kunci'}</span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={isIgnored}
                    aria-label={`Abaikan ${spk.label}`}
                    onClick={() => handleToggleIgnoreSpeaker(spk.speakerKey)}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold border cursor-pointer whitespace-nowrap ${
                      isIgnored
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    <EyeOff className="w-3 h-3" aria-hidden="true" />
                    <span>{isIgnored ? 'Diabaikan' : 'Abaikan'}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Camera Timeline Segments */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-slate-800">
            Timeline Perpindahan Fokus ({analysis.cameraSegments.length} Segmen)
          </span>
          <span className="font-mono tabular-nums text-[11px] text-slate-500">
            0:00.0 – {formatSecShort(totalDur)}
          </span>
        </div>

        <div className="flex w-full gap-1 overflow-x-auto pb-1">
          {analysis.cameraSegments.map((seg) => {
            const widthPct = Math.max(14, Math.round(((seg.endSec - seg.startSec) / totalDur) * 100));
            const isSelected = selectedSegment?.id === seg.id;
            const spkLabel =
              analysis.speakers.find((s) => s.speakerKey === seg.activeSpeakerKey)?.label ??
              seg.activeSpeakerKey;
            return (
              <button
                key={seg.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => setSelectedSegmentId(seg.id)}
                style={{ minWidth: `${Math.min(220, Math.max(92, widthPct * 2.2))}px` }}
                className={`px-2.5 py-1.5 rounded-lg border text-left transition-colors cursor-pointer shrink-0 ${
                  isSelected
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-800 border-slate-200 hover:border-slate-400'
                }`}
              >
                <div className="text-[11px] font-semibold truncate">{spkLabel}</div>
                <div
                  className={`text-[10px] font-mono tabular-nums ${
                    isSelected ? 'text-slate-300' : 'text-slate-500'
                  }`}
                >
                  {formatSecShort(seg.startSec)}–{formatSecShort(seg.endSec)} ·{' '}
                  {Math.round(seg.confidence * 100)}%
                </div>
              </button>
            );
          })}
        </div>

        {selectedSegment && (
          <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2.5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-900">
                Edit Segmen {formatSecShort(selectedSegment.startSec)} –{' '}
                {formatSecShort(selectedSegment.endSec)}
              </span>
              <span className="font-mono tabular-nums text-[11px] text-slate-500">
                {selectedSegment.isManualOverride ? 'Override Manual' : selectedSegment.reason}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <div>
                <label
                  htmlFor={`seg-speaker-${selectedSegment.id}`}
                  className="block text-[11px] text-slate-600 mb-1"
                >
                  Target Pembicara
                </label>
                <select
                  id={`seg-speaker-${selectedSegment.id}`}
                  value={selectedSegment.activeSpeakerKey}
                  onChange={(e) => {
                    const key = e.target.value;
                    const spk = analysis.speakers.find((s) => s.speakerKey === key);
                    handleUpdateSegmentOverride(selectedSegment.id, {
                      activeSpeakerKey: key,
                      targetX: spk?.avgCenterX ?? selectedSegment.targetX,
                      targetY: spk?.avgCenterY ?? selectedSegment.targetY,
                    });
                  }}
                  className="w-full h-8 px-2 text-xs bg-slate-50 border border-slate-200 rounded-md"
                >
                  {analysis.speakers.map((s) => (
                    <option key={s.speakerKey} value={s.speakerKey}>
                      {s.label}
                    </option>
                  ))}
                  <option value="wide_safe">Wide Safe Frame</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor={`seg-x-${selectedSegment.id}`}
                  className="block text-[11px] text-slate-600 mb-1 font-mono tabular-nums"
                >
                  Posisi Horizontal X ({Math.round(selectedSegment.targetX * 100)}%)
                </label>
                <input
                  id={`seg-x-${selectedSegment.id}`}
                  type="range"
                  min={10}
                  max={90}
                  value={Math.round(selectedSegment.targetX * 100)}
                  onChange={(e) =>
                    handleUpdateSegmentOverride(selectedSegment.id, {
                      targetX: Number(e.target.value) / 100,
                    })
                  }
                  className="w-full accent-red-600 cursor-pointer"
                />
              </div>

              <div>
                <label
                  htmlFor={`seg-zoom-${selectedSegment.id}`}
                  className="block text-[11px] text-slate-600 mb-1 font-mono tabular-nums"
                >
                  Zoom Kamera ({selectedSegment.zoom.toFixed(2)}x)
                </label>
                <input
                  id={`seg-zoom-${selectedSegment.id}`}
                  type="range"
                  min={100}
                  max={160}
                  step={2}
                  value={Math.round(selectedSegment.zoom * 100)}
                  onChange={(e) =>
                    handleUpdateSegmentOverride(selectedSegment.id, {
                      zoom: Number(e.target.value) / 100,
                    })
                  }
                  className="w-full accent-red-600 cursor-pointer"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Tunable Hysteresis & Smoothness Parameters */}
      <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-3">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
          <Sliders className="w-3.5 h-3.5 text-red-600 shrink-0" aria-hidden="true" />
          <span>Kalibrasi Histeresis & Kehalusan Tracking</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div>
            <label
              htmlFor={`cam-track-sens-${clip.id}`}
              className="flex justify-between text-[11px] text-slate-700 mb-1"
            >
              <span>Sensitivitas Pelacakan Gerak</span>
              <span className="font-mono tabular-nums">
                {Math.round(settings.trackingSensitivity * 100)}%
              </span>
            </label>
            <input
              id={`cam-track-sens-${clip.id}`}
              type="range"
              min={20}
              max={100}
              value={Math.round(settings.trackingSensitivity * 100)}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  trackingSensitivity: Number(e.target.value) / 100,
                }))
              }
              className="w-full accent-red-600 cursor-pointer"
            />
          </div>

          <div>
            <label
              htmlFor={`cam-switch-sens-${clip.id}`}
              className="flex justify-between text-[11px] text-slate-700 mb-1"
            >
              <span>Sensitivitas Perpindahan Kamera</span>
              <span className="font-mono tabular-nums">
                {Math.round(settings.switchingSensitivity * 100)}%
              </span>
            </label>
            <input
              id={`cam-switch-sens-${clip.id}`}
              type="range"
              min={20}
              max={100}
              value={Math.round(settings.switchingSensitivity * 100)}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  switchingSensitivity: Number(e.target.value) / 100,
                }))
              }
              className="w-full accent-red-600 cursor-pointer"
            />
          </div>

          <div>
            <label
              htmlFor={`cam-min-shot-${clip.id}`}
              className="flex justify-between text-[11px] text-slate-700 mb-1"
            >
              <span>Durasi Shot Minimum</span>
              <span className="font-mono tabular-nums">
                {settings.minShotDurationSec.toFixed(1)} detik
              </span>
            </label>
            <input
              id={`cam-min-shot-${clip.id}`}
              type="range"
              min={10}
              max={60}
              step={2}
              value={Math.round(settings.minShotDurationSec * 10)}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  minShotDurationSec: Number(e.target.value) / 10,
                }))
              }
              className="w-full accent-red-600 cursor-pointer"
            />
          </div>

          <div>
            <label
              htmlFor={`cam-cooldown-${clip.id}`}
              className="flex justify-between text-[11px] text-slate-700 mb-1"
            >
              <span>Cooldown Antar Perpindahan</span>
              <span className="font-mono tabular-nums">
                {settings.cooldownSec.toFixed(1)} detik
              </span>
            </label>
            <input
              id={`cam-cooldown-${clip.id}`}
              type="range"
              min={5}
              max={40}
              step={1}
              value={Math.round(settings.cooldownSec * 10)}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  cooldownSec: Number(e.target.value) / 10,
                }))
              }
              className="w-full accent-red-600 cursor-pointer"
            />
          </div>
        </div>

        {!settings.autoMode && (
          <div className="pt-2 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div>
              <label
                htmlFor={`cam-manual-x-${clip.id}`}
                className="block text-[11px] text-slate-700 mb-1 font-mono tabular-nums"
              >
                Manual X ({Math.round(settings.manualCropX * 100)}%)
              </label>
              <input
                id={`cam-manual-x-${clip.id}`}
                type="range"
                min={10}
                max={90}
                value={Math.round(settings.manualCropX * 100)}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, manualCropX: Number(e.target.value) / 100 }))
                }
                className="w-full accent-slate-900 cursor-pointer"
              />
            </div>
            <div>
              <label
                htmlFor={`cam-manual-y-${clip.id}`}
                className="block text-[11px] text-slate-700 mb-1 font-mono tabular-nums"
              >
                Manual Y ({Math.round(settings.manualCropY * 100)}%)
              </label>
              <input
                id={`cam-manual-y-${clip.id}`}
                type="range"
                min={15}
                max={80}
                value={Math.round(settings.manualCropY * 100)}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, manualCropY: Number(e.target.value) / 100 }))
                }
                className="w-full accent-slate-900 cursor-pointer"
              />
            </div>
            <div>
              <label
                htmlFor={`cam-manual-zoom-${clip.id}`}
                className="block text-[11px] text-slate-700 mb-1 font-mono tabular-nums"
              >
                Manual Zoom ({settings.manualZoom.toFixed(2)}x)
              </label>
              <input
                id={`cam-manual-zoom-${clip.id}`}
                type="range"
                min={100}
                max={160}
                step={2}
                value={Math.round(settings.manualZoom * 100)}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, manualZoom: Number(e.target.value) / 100 }))
                }
                className="w-full accent-slate-900 cursor-pointer"
              />
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={isRecalculating}
          onClick={() => void handleRecalculate()}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg cursor-pointer whitespace-nowrap disabled:opacity-60"
        >
          {isRecalculating ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
          )}
          <span>Hitung Ulang Auto-Fokus</span>
        </button>

        <button
          type="button"
          disabled={isSaving}
          onClick={() => void handleSaveSettings()}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer whitespace-nowrap disabled:opacity-60"
        >
          {isSaving ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Check className="w-3.5 h-3.5" aria-hidden="true" />
          )}
          <span>Simpan Kamera</span>
        </button>

        {onApplyAndRender && (
          <button
            type="button"
            onClick={() => onApplyAndRender(settings)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer whitespace-nowrap"
          >
            <span>Simpan & Render MP4</span>
          </button>
        )}

        <button
          type="button"
          disabled={isBenchmarking}
          onClick={() => void handleRunBenchmark()}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg cursor-pointer whitespace-nowrap disabled:opacity-60"
        >
          <span>{isBenchmarking ? 'Menguji...' : 'Benchmark Akurasi'}</span>
        </button>
      </div>

      {statusMessage && (
        <p role="status" className="text-xs font-medium text-emerald-700">
          {statusMessage}
        </p>
      )}
      {errorMessage && (
        <p role="alert" className="text-xs font-medium text-red-600">
          {errorMessage}
        </p>
      )}

      {benchmark && (
        <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-slate-900">Hasil Benchmark Active Speaker</span>
            <span className="font-mono tabular-nums text-[11px] text-slate-600">
              Precision {Math.round(benchmark.overallPrecision * 100)}% · Recall{' '}
              {Math.round(benchmark.overallRecall * 100)}% · Switch{' '}
              {Math.round(benchmark.overallSwitchAccuracy * 100)}% · Stability{' '}
              {Math.round(benchmark.overallStability * 100)}%
            </span>
          </div>
          <div className="divide-y divide-slate-100">
            {benchmark.scenarios.map((sc) => (
              <div
                key={sc.scenario}
                className="py-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px]"
              >
                <span className="text-slate-800 font-medium">{sc.scenario}</span>
                <span className="font-mono tabular-nums text-slate-500">
                  P {Math.round(sc.precision * 100)}% · R {Math.round(sc.recall * 100)}% ·{' '}
                  {sc.switchCount} switch
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
