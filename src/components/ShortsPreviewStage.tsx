import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import {
  Check,
  Copy,
  Download,
  Film,
  KeyRound,
  Loader2,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  Upload,
  Youtube,
} from 'lucide-react';
import type {
  ClipOverlayStyle,
  ClipRenderLayout,
  ClipRenderQuality,
  EmotionSfxStyle,
  PodcastClip,
  PodcastEpisode,
  StudioStoreState,
} from '../types/clipper';
import { buildYtDlpFfmpegCommand, formatTimestamp, parseTimestamp } from '../utils/youtube';
import {
  cancelActiveServerRenders,
  runRenderClipJob,
  type RenderJobError,
} from '../utils/renderJobClient';
import { downloadVideoInChunks, formatMegabytes } from '../utils/chunkedDownload';
import {
  BUNDLED_FONT_PRESETS,
  isCustomOverlayStyleActive,
  normalizeClipOverlayStyle,
} from '../utils/clipOverlayStyle';
import { ClipOverlayEditorModal } from './ClipOverlayEditorModal';
import { apiFetch } from '../utils/apiClient';

type UiRenderLayout =
  | 'shorts_full_bleed'
  | 'shorts_studio_focus'
  | 'full_16_9_focus'
  | 'square_1_1'
  | 'portrait_4_5';

function normalizeUiLayout(layout?: ClipRenderLayout): UiRenderLayout {
  if (layout === 'full_16_9_focus' || layout === 'landscape_16_9') return 'full_16_9_focus';
  if (layout === 'shorts_studio_focus' || layout === 'vertical_9_16') return 'shorts_studio_focus';
  if (layout === 'square_1_1') return 'square_1_1';
  if (layout === 'portrait_4_5') return 'portrait_4_5';
  return 'shorts_full_bleed';
}

function getSfxShortLabel(sfx: EmotionSfxStyle): string {
  switch (sfx) {
    case 'vine_boom':
      return 'Bass Drop';
    case 'pop_spark':
      return 'Pop Komedi';
    case 'whoosh_riser':
      return 'Whoosh Riser';
    case 'chime_insight':
      return 'Ding Insight';
    case 'chuckle_pop':
      return 'Chime Hangat';
    case 'heartbeat_hit':
      return 'Pulse Dramatis';
  }
}

interface ShortsPreviewStageProps {
  clip: PodcastClip;
  episode: PodcastEpisode;
  defaultRenderQuality: ClipRenderQuality;
  defaultRenderLayout: UiRenderLayout;
  defaultEmotionEffectsEnabled: boolean;
  defaultAiIntroEnabled: boolean;
  ultraHdEnabled: boolean;
  isAuthenticated?: boolean;
  canManageCookies?: boolean;
  onSaveTrim: (clipId: string, startSec: number, endSec: number) => Promise<void>;
  onSaveOverlayStyle: (clipId: string, overlayStyle: ClipOverlayStyle) => Promise<void>;
  onStoreUpdate: (nextStore: StudioStoreState) => void;
}

export function ShortsPreviewStage({
  clip,
  episode,
  defaultRenderQuality,
  defaultRenderLayout,
  defaultEmotionEffectsEnabled,
  defaultAiIntroEnabled,
  ultraHdEnabled,
  isAuthenticated = false,
  canManageCookies = false,
  onSaveTrim,
  onSaveOverlayStyle,
  onStoreUpdate,
}: ShortsPreviewStageProps) {
  const [previewMode, setPreviewMode] = useState<'vertical' | 'youtube'>('vertical');
  const [isOverlayEditorOpen, setIsOverlayEditorOpen] = useState(false);
  const [startInput, setStartInput] = useState(formatTimestamp(clip.startSec));
  const [endInput, setEndInput] = useState(formatTimestamp(clip.endSec));
  const [trimError, setTrimError] = useState<string | null>(null);
  const [isSavingTrim, setIsSavingTrim] = useState(false);

  const [isRenderingMp4, setIsRenderingMp4] = useState(false);
  const [renderStage, setRenderStage] = useState<string>('');
  const [renderProgress, setRenderProgress] = useState<number>(0);
  const [renderElapsedSec, setRenderElapsedSec] = useState<number>(0);
  const [renderLayout, setRenderLayout] = useState<UiRenderLayout>(() =>
    clip.renderedLayout ? normalizeUiLayout(clip.renderedLayout) : defaultRenderLayout
  );
  const [renderQuality, setRenderQuality] = useState<ClipRenderQuality>(
    () => clip.renderedQuality ?? defaultRenderQuality
  );
  const [enableEmotionEffects, setEnableEmotionEffects] = useState<boolean>(
    () => clip.emotionEffectsEnabled ?? defaultEmotionEffectsEnabled
  );
  const [enableAiIntro, setEnableAiIntro] = useState<boolean>(
    () => clip.introEnabled ?? defaultAiIntroEnabled
  );
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderErrorCode, setRenderErrorCode] = useState<string | null>(null);
  const [isClearingQueue, setIsClearingQueue] = useState(false);
  const [needsSourceOrCookies, setNeedsSourceOrCookies] = useState(false);
  const [isUploadingSource, setIsUploadingSource] = useState(false);
  const [directUrlDraft, setDirectUrlDraft] = useState(episode.directVideoUrl ?? '');
  const [isSavingDirectUrl, setIsSavingDirectUrl] = useState(false);
  const [cookiesDraft, setCookiesDraft] = useState('');
  const [isSavingCookies, setIsSavingCookies] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedReadyPack, setCopiedReadyPack] = useState(false);
  const [videoPlaybackError, setVideoPlaybackError] = useState<string | null>(null);
  const [isDownloadingMp4, setIsDownloadingMp4] = useState(false);
  const [downloadProgressLabel, setDownloadProgressLabel] = useState<string>('');
  const [hasYoutubeCookies, setHasYoutubeCookies] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const renderAbortRef = useRef<AbortController | null>(null);
  const activeJobIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) {
      setHasYoutubeCookies(false);
      return;
    }
    let active = true;
    apiFetch('/api/automation/cookies-status')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { hasYoutubeCookies?: boolean } | null) => {
        if (active && d) setHasYoutubeCookies(Boolean(d.hasYoutubeCookies));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [isAuthenticated]);

  const clipDuration = Math.max(5, clip.endSec - clip.startSec);

  useEffect(() => {
    setStartInput(formatTimestamp(clip.startSec));
    setEndInput(formatTimestamp(clip.endSec));
    setTrimError(null);
    setRenderError(null);
    setRenderErrorCode(null);
    setVideoPlaybackError(null);
    setNeedsSourceOrCookies(false);
    setRenderLayout(
      clip.renderedLayout ? normalizeUiLayout(clip.renderedLayout) : defaultRenderLayout
    );
    setRenderQuality(clip.renderedQuality ?? defaultRenderQuality);
    setEnableEmotionEffects(clip.emotionEffectsEnabled ?? defaultEmotionEffectsEnabled);
    setEnableAiIntro(clip.introEnabled ?? defaultAiIntroEnabled);
    setDirectUrlDraft(episode.directVideoUrl ?? '');
  }, [
    clip.id,
    clip.startSec,
    clip.endSec,
    clip.renderedClipUrl,
    clip.renderedLayout,
    clip.renderedQuality,
    clip.emotionEffectsEnabled,
    clip.introEnabled,
    episode.id,
    episode.directVideoUrl,
    defaultRenderLayout,
    defaultRenderQuality,
    defaultEmotionEffectsEnabled,
    defaultAiIntroEnabled,
  ]);

  const handleApplyTrim = async () => {
    const parsedStart = parseTimestamp(startInput);
    const parsedEnd = parseTimestamp(endInput);
    if (parsedStart === null || parsedEnd === null) {
      setTrimError('Gunakan format waktu MM:SS atau HH:MM:SS yang valid.');
      return;
    }
    if (parsedEnd <= parsedStart) {
      setTrimError('Waktu selesai harus lebih besar dari waktu mulai.');
      return;
    }
    if (parsedEnd - parsedStart < 10) {
      setTrimError('Durasi minimal klip Shorts adalah 10 detik.');
      return;
    }
    if (parsedEnd - parsedStart > 180) {
      setTrimError('Durasi maksimal klip YouTube Shorts adalah 180 detik (3 menit).');
      return;
    }
    setTrimError(null);
    setIsSavingTrim(true);
    try {
      await onSaveTrim(clip.id, parsedStart, parsedEnd);
    } finally {
      setIsSavingTrim(false);
    }
  };

  const handleNudge = async (target: 'start' | 'end', deltaSec: number) => {
    const nextStart = target === 'start' ? Math.max(0, clip.startSec + deltaSec) : clip.startSec;
    const nextEnd =
      target === 'end'
        ? Math.min(episode.durationSec, clip.endSec + deltaSec)
        : clip.endSec;
    if (nextEnd - nextStart < 10 || nextEnd - nextStart > 180) return;
    await onSaveTrim(clip.id, nextStart, nextEnd);
  };

  const handleCancelRender = async () => {
    const jobIdToCancel = activeJobIdRef.current;
    activeJobIdRef.current = null;
    renderAbortRef.current?.abort();
    renderAbortRef.current = null;
    setIsRenderingMp4(false);
    setRenderStage('');
    setRenderProgress(0);
    setRenderElapsedSec(0);
    setRenderError(null);
    setRenderErrorCode(null);
    // Always terminate the background FFmpeg/yt-dlp job on the server too so CPU & queue free immediately
    await cancelActiveServerRenders(jobIdToCancel);
  };

  const handleRenderMp4 = async (
    overrideLayout?: UiRenderLayout,
    overrideQuality?: ClipRenderQuality,
    forceRestart = false,
    overrideOverlayStyle?: ClipOverlayStyle
  ) => {
    if (renderAbortRef.current) {
      renderAbortRef.current.abort();
    }
    const controller = new AbortController();
    renderAbortRef.current = controller;
    activeJobIdRef.current = null;

    setIsRenderingMp4(true);
    setRenderError(null);
    setRenderErrorCode(null);
    setRenderStage('Menyiapkan proses render...');
    setRenderProgress(5);
    setRenderElapsedSec(0);
    try {
      const data = await runRenderClipJob({
        clipId: clip.id,
        layout: overrideLayout ?? renderLayout,
        quality: overrideQuality ?? renderQuality,
        enableEmotionEffects,
        enableAiIntro,
        overlayStyle: overrideOverlayStyle ?? clip.overlayStyle,
        forceRestart,
        signal: controller.signal,
        onJobStarted: (jobId) => {
          if (renderAbortRef.current === controller) {
            activeJobIdRef.current = jobId;
          }
        },
        onProgress: (stage, progress, elapsedSec) => {
          if (renderAbortRef.current === controller) {
            setRenderStage(stage);
            setRenderProgress(progress);
            setRenderElapsedSec(elapsedSec);
          }
        },
      });
      setNeedsSourceOrCookies(false);
      if (data.store) {
        onStoreUpdate(data.store);
      }
    } catch (err) {
      const renderErr = err as RenderJobError;
      if (renderErr?.code === 'CANCELLED' || controller.signal.aborted) {
        if (renderAbortRef.current === controller) {
          setRenderError(null);
          setRenderErrorCode(null);
        }
        return;
      }
      if (renderErr?.code === 'YOUTUBE_BOT_CHECK') {
        setNeedsSourceOrCookies(true);
      }
      if (renderAbortRef.current === controller) {
        setRenderErrorCode(renderErr?.code ?? null);
        setRenderError(
          renderErr?.message || 'Gagal memproses render video MP4. Silakan coba lagi.'
        );
      }
    } finally {
      if (renderAbortRef.current === controller) {
        renderAbortRef.current = null;
        activeJobIdRef.current = null;
        setIsRenderingMp4(false);
        setRenderStage('');
        setRenderProgress(0);
        setRenderElapsedSec(0);
      }
    }
  };

  const handleClearQueueAndRetry = async () => {
    setIsClearingQueue(true);
    try {
      await cancelActiveServerRenders();
      await new Promise((r) => window.setTimeout(r, 400));
    } finally {
      setIsClearingQueue(false);
    }
    await handleRenderMp4(undefined, undefined, true);
  };

  const handleUploadSourceVideo = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploadingSource(true);
    setRenderError(null);
    try {
      const res = await apiFetch(`/api/episodes/${episode.id}/upload-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) {
        setRenderError(data.error || 'Gagal mengunggah video sumber.');
        return;
      }
      if (data.store) {
        onStoreUpdate(data.store);
      }
      setNeedsSourceOrCookies(false);
      await handleRenderMp4();
    } catch {
      setRenderError('Gagal mengunggah file video sumber.');
    } finally {
      setIsUploadingSource(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSaveCookiesAndRender = async () => {
    if (!cookiesDraft.trim()) {
      setRenderError('Tempel isi file cookies.txt YouTube terlebih dahulu.');
      return;
    }
    setIsSavingCookies(true);
    setRenderError(null);
    try {
      const res = await apiFetch('/api/automation/youtube-cookies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookiesTxt: cookiesDraft }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        hasYoutubeCookies?: boolean;
        error?: string;
      };
      if (!res.ok) {
        setRenderError(data.error || 'Gagal menyimpan cookies.txt YouTube.');
        return;
      }
      setHasYoutubeCookies(Boolean(data.hasYoutubeCookies));
      setCookiesDraft('');
      setNeedsSourceOrCookies(false);
      await handleRenderMp4();
    } finally {
      setIsSavingCookies(false);
    }
  };

  const handleSaveDirectSourceUrl = async () => {
    setIsSavingDirectUrl(true);
    setRenderError(null);
    try {
      const res = await apiFetch(`/api/episodes/${episode.id}/source-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directVideoUrl: directUrlDraft }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        store?: StudioStoreState;
      };
      if (!res.ok) {
        setRenderError(data.error || 'Gagal menyimpan URL video sumber.');
        return;
      }
      if (data.store) {
        onStoreUpdate(data.store);
      }
      setNeedsSourceOrCookies(false);
      if (directUrlDraft.trim()) {
        await handleRenderMp4();
      }
    } catch {
      setRenderError('Gagal menyimpan URL video sumber langsung.');
    } finally {
      setIsSavingDirectUrl(false);
    }
  };

  const handleDownloadMp4 = async () => {
    if (!clip.renderedClipUrl || isDownloadingMp4) return;
    setIsDownloadingMp4(true);
    setDownloadProgressLabel('Menyiapkan unduhan...');
    setRenderError(null);
    try {
      await downloadVideoInChunks({
        url: clip.renderedClipUrl,
        filename: `klip_${clip.id}_${effectiveRenderedLayout}_${(clip.renderedQuality ?? renderQuality).toLowerCase()}.mp4`,
        onProgress: (loaded, total, pct) => {
          setDownloadProgressLabel(
            `Mengunduh ${pct}% (${formatMegabytes(loaded)} / ${formatMegabytes(total)})`
          );
        },
      });
    } catch (err) {
      setRenderError(
        err instanceof Error ? err.message : 'Gagal mengunduh file MP4 hasil render.'
      );
    } finally {
      setIsDownloadingMp4(false);
      setDownloadProgressLabel('');
    }
  };

  const handleCopyLocalCmd = async () => {
    try {
      await navigator.clipboard.writeText(buildYtDlpFfmpegCommand(clip, episode.sourceUrl));
      setCopiedCmd(true);
      window.setTimeout(() => setCopiedCmd(false), 1800);
    } catch {
      // Ignore clipboard error
    }
  };

  const handleCopyReadyMetadata = async () => {
    const readyTitle = clip.autoGeneratedTitle || clip.title;
    const readyCaption =
      clip.autoGeneratedCaption ||
      `${clip.platformCopies.youtube_shorts.caption}\n\n${clip.platformCopies.youtube_shorts.hashtags.join(' ')}`;
    try {
      await navigator.clipboard.writeText(`${readyTitle}\n\n${readyCaption}`);
      setCopiedReadyPack(true);
      window.setTimeout(() => setCopiedReadyPack(false), 1800);
    } catch {
      // Ignore clipboard error
    }
  };

  const youtubeEmbedSrc = `https://www.youtube.com/embed/${episode.videoId}?start=${clip.startSec}&end=${clip.endSec}&rel=0`;
  const effectiveRenderedLayout = normalizeUiLayout(clip.renderedLayout ?? renderLayout);
  const isVerticalRendered = effectiveRenderedLayout !== 'full_16_9_focus';
  const readyTitleText = clip.autoGeneratedTitle || clip.title;
  const readyCaptionText =
    clip.autoGeneratedCaption ||
    `${clip.platformCopies.youtube_shorts.caption} ${clip.platformCopies.youtube_shorts.hashtags.join(' ')}`.trim();

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-display text-base font-bold text-slate-900">
            Hasil Akhir Klip & Pemotong
          </h3>
          <p className="text-xs text-slate-500 font-mono tabular-nums mt-0.5">
            {formatTimestamp(clip.startSec)} – {formatTimestamp(clip.endSec)} · Durasi{' '}
            {clipDuration} detik
          </p>
        </div>

        {!clip.renderedClipUrl && (
          <div
            role="tablist"
            aria-label="Mode pemutar pratinjau"
            className="inline-flex items-center p-1 bg-slate-100 rounded-lg"
          >
            <button
              type="button"
              role="tab"
              aria-selected={previewMode === 'vertical'}
              onClick={() => setPreviewMode('vertical')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md studio-transition whitespace-nowrap cursor-pointer ${
                previewMode === 'vertical'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Film className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Shorts 9:16</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={previewMode === 'youtube'}
              onClick={() => setPreviewMode('youtube')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md studio-transition whitespace-nowrap cursor-pointer ${
                previewMode === 'youtube'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Youtube className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Video 16:9 Asli</span>
            </button>
          </div>
        )}
      </div>

      {/* Rendered MP4 Player (Real Video + Real Audio + Burned Subtitles + Studio Framing) OR Live YouTube Split Preview */}
      {clip.renderedClipUrl ? (
        <div className="flex flex-col items-center space-y-3">
          <div className="w-full flex items-center justify-between gap-2 text-xs">
            <span className="font-semibold text-emerald-700">
              File Video Klip MP4 Siap Upload
            </span>
            <button
              type="button"
              disabled={isDownloadingMp4}
              onClick={() => void handleDownloadMp4()}
              className="inline-flex items-center gap-1 font-semibold text-red-600 hover:text-red-700 whitespace-nowrap cursor-pointer disabled:opacity-60"
            >
              {isDownloadingMp4 ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>{isDownloadingMp4 ? downloadProgressLabel : 'Unduh .MP4'}</span>
            </button>
          </div>
          <video
            key={clip.renderedClipUrl}
            src={clip.renderedClipUrl}
            controls
            playsInline
            preload="metadata"
            onLoadedMetadata={() => setVideoPlaybackError(null)}
            onError={() =>
              setVideoPlaybackError(
                'Browser tidak dapat memutar file video ini (ukuran/codec 4K tidak didukung perangkat). Klik tombol di bawah untuk render ulang versi jernih kompatibel.'
              )
            }
            className={`w-full rounded-xl border border-slate-200 bg-slate-950 ${
              effectiveRenderedLayout === 'square_1_1'
                ? 'max-w-[320px] aspect-square'
                : effectiveRenderedLayout === 'portrait_4_5'
                  ? 'max-w-[300px] aspect-[4/5]'
                  : isVerticalRendered
                    ? 'max-w-[290px] aspect-[9/16]'
                    : 'aspect-video'
            }`}
          />
          {videoPlaybackError && (
            <div className="w-full p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-2">
              <p className="leading-relaxed">{videoPlaybackError}</p>
              <button
                type="button"
                disabled={isRenderingMp4}
                onClick={() => {
                  setRenderQuality('1080p');
                  void handleRenderMp4(effectiveRenderedLayout, '1080p');
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white font-semibold cursor-pointer disabled:opacity-60"
              >
                <Scissors className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Render Ulang 1080p Full HD (Kompatibel)</span>
              </button>
            </div>
          )}
          <div className="w-full p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold">
                <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">
                  {clip.subtitleAccuracySource === 'audio_transcribed'
                    ? 'Subtitle Audio 100% Akurat'
                    : 'Subtitle Terpasang'}
                </span>
                <span className="px-2 py-0.5 rounded bg-slate-200 text-slate-700">
                  {effectiveRenderedLayout === 'shorts_full_bleed'
                    ? 'Full Frame 9:16'
                    : effectiveRenderedLayout === 'shorts_studio_focus'
                      ? 'Shorts 9:16 Studio'
                      : effectiveRenderedLayout === 'square_1_1'
                        ? 'Square 1:1 Feed'
                        : effectiveRenderedLayout === 'portrait_4_5'
                          ? 'Portrait 4:5 IG/FB'
                          : 'Video Full 16:9'}
                  {' · '}
                  {(clip.renderedQuality ?? renderQuality).toUpperCase()}
                  {clip.renderedFileSizeBytes
                    ? ` · ${formatMegabytes(clip.renderedFileSizeBytes)}`
                    : ''}
                </span>
                {typeof clip.renderedSourceHeight === 'number' && (
                  <span
                    className={`px-2 py-0.5 rounded font-mono tabular-nums ${
                      clip.renderedSourceHeight >= 720
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-amber-100 text-amber-900'
                    }`}
                  >
                    Sumber {clip.renderedSourceWidth}×{clip.renderedSourceHeight}
                  </span>
                )}
                {typeof clip.viralScore === 'number' && (
                  <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-900 font-mono tabular-nums">
                    Potensi Viral {clip.viralScore}/100
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={handleCopyReadyMetadata}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-600 hover:text-red-700 cursor-pointer"
              >
                {copiedReadyPack ? (
                  <Check className="w-3 h-3 text-emerald-700" aria-hidden="true" />
                ) : (
                  <Copy className="w-3 h-3" aria-hidden="true" />
                )}
                <span>{copiedReadyPack ? 'Tersalin!' : 'Salin Judul & Caption'}</span>
              </button>
            </div>
            {typeof clip.renderedSourceHeight === 'number' && clip.renderedSourceHeight < 720 && (
              <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-950 leading-relaxed flex flex-wrap items-center justify-between gap-2">
                <span>
                  Klip ini masih memakai sumber lama{' '}
                  <strong>{clip.renderedSourceWidth}×{clip.renderedSourceHeight}</strong>. Klik
                  render ulang untuk otomatis menarik sumber <strong>1080p Full HD / 4K asli</strong>{' '}
                  yang jauh lebih jernih.
                </span>
                <button
                  type="button"
                  disabled={isRenderingMp4}
                  onClick={() => void handleRenderMp4()}
                  className="text-red-700 hover:text-red-800 font-semibold underline cursor-pointer shrink-0 disabled:opacity-60"
                >
                  Render Ulang 1080p/4K Asli
                </button>
              </div>
            )}
            {clip.introEnabled && clip.introHeadline && (
              <div className="p-2.5 rounded-lg bg-white border border-slate-200 space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-1.5 text-[10px] font-semibold">
                  <span className="inline-flex items-center gap-1 text-red-700 uppercase tracking-wide">
                    <Film className="w-3 h-3 shrink-0" aria-hidden="true" />
                    <span>Intro Pembuka AI · {clip.introTag || 'TOPIK PILIHAN'}</span>
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono tabular-nums text-slate-500">
                      {(clip.introDurationSec ?? 2.8).toFixed(1)}d
                    </span>
                    <button
                      type="button"
                      onClick={() => setIsOverlayEditorOpen(true)}
                      className="text-red-600 hover:text-red-800 underline cursor-pointer"
                    >
                      Edit Teks & Posisi
                    </button>
                  </div>
                </div>
                <p className="text-xs font-bold text-slate-900 leading-snug">
                  {clip.introHeadline}
                </p>
                {clip.introTeaser && (
                  <p className="text-[11px] text-slate-600 leading-snug">{clip.introTeaser}</p>
                )}
              </div>
            )}
            {clip.speakerFocusSummary && (
              <p className="text-[11px] text-slate-600 leading-snug">
                <span className="font-semibold text-slate-700">Auto-Fokus:</span>{' '}
                {clip.speakerFocusSummary}
              </p>
            )}
            {clip.emotionEffectsEnabled !== false &&
              Array.isArray(clip.emotionMoments) &&
              clip.emotionMoments.length > 0 && (
                <div className="space-y-1.5 pt-1 border-t border-slate-200/80">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-800">
                      <Sparkles className="w-3 h-3 text-red-600 shrink-0" aria-hidden="true" />
                      <span>Momen Emosi AI ({clip.emotionMoments.length} Efek Animasi & SFX)</span>
                    </span>
                  </div>
                  {clip.emotionSummary && (
                    <p className="text-[11px] text-slate-600 leading-snug">
                      {clip.emotionSummary}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    {clip.emotionMoments.map((m, idx) => (
                      <span
                        key={`${m.timeSec}-${idx}`}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-slate-200 bg-white text-[10px] font-medium text-slate-700"
                      >
                        <span className="font-mono tabular-nums text-slate-500">
                          {formatTimestamp(Math.round(m.timeSec))}
                        </span>
                        <span className="font-semibold text-slate-900">{m.badgeText}</span>
                        <span className="text-slate-400">·</span>
                        <span className="text-slate-600">{getSfxShortLabel(m.sfxStyle)}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            {clip.viralReason && (
              <p className="text-[11px] text-slate-600 leading-snug">
                <span className="font-semibold text-slate-700">Alasan Viral:</span>{' '}
                {clip.viralReason}
              </p>
            )}
            <div className="space-y-1 pt-1 border-t border-slate-200/80">
              <p className="text-xs font-bold text-slate-900 leading-snug">{readyTitleText}</p>
              <p className="text-[11px] text-slate-600 leading-relaxed">{readyCaptionText}</p>
            </div>
          </div>
        </div>
      ) : previewMode === 'vertical' ? (
        <div className="flex flex-col items-center space-y-2.5">
          <div className="relative w-full max-w-[290px] aspect-[9/16] bg-slate-950 rounded-xl overflow-hidden border border-slate-800 flex flex-col justify-between">
            <div className="h-[50%] w-full bg-slate-900">
              <iframe
                key={`split-${youtubeEmbedSrc}`}
                src={youtubeEmbedSrc}
                title={`Pemutar YouTube Shorts: ${clip.title}`}
                className="w-full h-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>

            <div className="flex-1 px-4 py-4 flex flex-col justify-between bg-slate-950 text-white">
              <div className="space-y-2">
                <p className="text-[11px] font-mono tabular-nums text-slate-400 truncate">
                  {episode.channelName} · {formatTimestamp(clip.startSec)} –{' '}
                  {formatTimestamp(clip.endSec)}
                </p>
                <p className="text-xs font-semibold text-red-400 line-clamp-2">
                  {clip.title}
                </p>
                <p
                  data-testid="active-caption-cue"
                  className="font-display text-sm font-bold leading-snug text-white"
                >
                  {clip.captionCues[0]?.text ?? clip.hookLine}
                </p>
              </div>
              <p className="text-[11px] text-slate-400 leading-snug">
                Tekan Play di video atas untuk memutar suara & video asli segmen{' '}
                {formatTimestamp(clip.startSec)}–{formatTimestamp(clip.endSec)}.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-2.5">
          <div className="aspect-video w-full rounded-xl overflow-hidden bg-slate-950 border border-slate-200">
            <iframe
              key={youtubeEmbedSrc}
              src={youtubeEmbedSrc}
              title={`Pemutar YouTube: ${clip.title}`}
              className="w-full h-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
          <p className="text-xs text-slate-500">
            Video asli dimulai pada{' '}
            <span className="font-mono tabular-nums font-medium text-slate-700">
              {formatTimestamp(clip.startSec)}
            </span>{' '}
            dan berhenti otomatis di{' '}
            <span className="font-mono tabular-nums font-medium text-slate-700">
              {formatTimestamp(clip.endSec)}
            </span>
            .
          </p>
        </div>
      )}

      {/* Real FFmpeg MP4 Render Controls */}
      <div className="pt-4 border-t border-slate-200 space-y-3">
        <div className="space-y-2">
          <div>
            <label
              htmlFor="render-layout-select"
              className="block text-xs font-semibold text-slate-800"
            >
              Ekspor Video MP4 Asli (Video + Suara)
            </label>
            <p className="text-[11px] text-slate-500 leading-snug mt-0.5">
              Default Full Frame 9:16 jernih (tanpa garis tepi), auto-fokus wajah pembicara aktif, judul otomatis, caption, & subtitle audio 100% akurat.
            </p>
          </div>
          <select
            id="render-layout-select"
            aria-label="Format rasio render MP4"
            value={renderLayout}
            onChange={(e) => setRenderLayout(e.target.value as UiRenderLayout)}
            className="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-700 focus:border-slate-900 focus:outline-none"
          >
            <option value="shorts_full_bleed">
              Full Frame 9:16 (Auto-Fokus + Judul + Subtitle Natural)
            </option>
            <option value="shorts_studio_focus">
              Shorts 9:16 Studio (Latar Blur + Pembicara Terpusat)
            </option>
            <option value="portrait_4_5">
              Portrait 4:5 Feed (Instagram / Facebook / LinkedIn)
            </option>
            <option value="square_1_1">
              Square 1:1 (Feed Persegi Multi-Platform)
            </option>
            <option value="full_16_9_focus">
              Video Full 16:9 (Layar Lebar Auto-Fokus)
            </option>
          </select>

          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="render-quality-select"
                className="text-xs font-medium text-slate-700 whitespace-nowrap"
              >
                Resolusi Video
              </label>
              {ultraHdEnabled && (
                <span className="text-[11px] font-semibold text-red-700">
                  Mode Ultra HD Aktif
                </span>
              )}
            </div>
            <select
              id="render-quality-select"
              aria-label="Kualitas resolusi render MP4"
              value={renderQuality}
              onChange={(e) => setRenderQuality(e.target.value as ClipRenderQuality)}
              className="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-700 focus:border-slate-900 focus:outline-none"
            >
              <option value="1080p">1080p Full HD (Jernih & Tajam)</option>
              <option value="4k">4K Ultra HD 2160p (Kejernihan Maksimal)</option>
            </select>
          </div>

          <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-slate-50 border border-slate-200">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
                <Film className="w-3.5 h-3.5 text-red-600 shrink-0" aria-hidden="true" />
                <span>Intro Judul & Konteks AI (Pembuka 2.8d)</span>
              </div>
              <p className="text-[11px] text-slate-500 leading-snug mt-0.5">
                Otomatis membuka klip dengan kartu judul & ringkasan topik hasil analisis AI sebelum masuk ke pembicara agar penonton langsung paham isi video.
              </p>
            </div>
            <button
              id="toggle-ai-intro"
              type="button"
              role="switch"
              aria-checked={enableAiIntro}
              aria-label="Aktifkan Intro Judul & Konteks AI"
              onClick={() => setEnableAiIntro((prev) => !prev)}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-1 ${
                enableAiIntro ? 'bg-red-600' : 'bg-slate-300'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-xs transition-transform ${
                  enableAiIntro ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-slate-50 border border-slate-200">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
                <Sparkles className="w-3.5 h-3.5 text-red-600 shrink-0" aria-hidden="true" />
                <span>Efek Emosi AI (Animasi & SFX Retensi)</span>
              </div>
              <p className="text-[11px] text-slate-500 leading-snug mt-0.5">
                AI otomatis mendeteksi momen lucu/kaget/insight lalu menambahkan animasi reaksi & efek suara halus agar penonton betah.
              </p>
            </div>
            <button
              id="toggle-emotion-effects"
              type="button"
              role="switch"
              aria-checked={enableEmotionEffects}
              aria-label="Aktifkan Efek Emosi AI"
              onClick={() => setEnableEmotionEffects((prev) => !prev)}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-1 ${
                enableEmotionEffects ? 'bg-red-600' : 'bg-slate-300'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-xs transition-transform ${
                  enableEmotionEffects ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          <button
            type="button"
            onClick={() => setIsOverlayEditorOpen(true)}
            className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg bg-white border border-slate-300 hover:border-slate-900 hover:bg-slate-50 text-left studio-transition cursor-pointer"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-900">
                <SlidersHorizontal className="w-3.5 h-3.5 text-red-600 shrink-0" aria-hidden="true" />
                <span>Edit Manual: Teks Intro, Font & Posisi</span>
              </div>
              <p className="text-[11px] text-slate-500 leading-snug mt-0.5">
                {(() => {
                  const s = normalizeClipOverlayStyle(clip.overlayStyle);
                  const fontLabel =
                    BUNDLED_FONT_PRESETS.find((f) => f.id === s.fontFamily)?.label ?? 'Modern Sans';
                  return `${fontLabel} · Intro ${s.introPositionY}% · Subtitle ${s.subtitlePositionY}%`;
                })()}
              </p>
            </div>
            <span
              className={`shrink-0 px-2 py-0.5 rounded text-[10px] font-semibold ${
                isCustomOverlayStyleActive(clip.overlayStyle)
                  ? 'bg-red-100 text-red-700'
                  : 'bg-slate-100 text-slate-600'
              }`}
            >
              {isCustomOverlayStyleActive(clip.overlayStyle) ? 'Kustom Aktif' : 'Ubah'}
            </span>
          </button>
        </div>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={isRenderingMp4 || isUploadingSource}
            onClick={() => handleRenderMp4()}
            className="w-full inline-flex items-center justify-center gap-2 h-10 px-4 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg studio-transition cursor-pointer whitespace-nowrap disabled:opacity-60"
          >
            {isRenderingMp4 ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                <span>Transkrip Audio, Auto-Fokus & Render...</span>
              </>
            ) : (
              <>
                <Scissors className="w-3.5 h-3.5" aria-hidden="true" />
                <span>
                  {clip.renderedClipUrl ? 'Render Ulang MP4 Studio' : 'Potong & Render MP4 Otomatis'}
                </span>
              </>
            )}
          </button>

          {isRenderingMp4 && (
            <div role="status" className="space-y-1.5 pt-0.5">
              <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-slate-600">
                <span className="leading-snug">
                  {renderStage || 'Memproses video HD, subtitle akurat & auto-fokus...'}
                </span>
                <span className="font-mono tabular-nums text-slate-700 shrink-0">
                  {renderProgress}% · {formatTimestamp(renderElapsedSec)}
                </span>
              </div>
              <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className={`h-full bg-red-600 transition-all duration-500 ease-out ${
                    renderProgress >= 95
                      ? 'w-full'
                      : renderProgress >= 80
                        ? 'w-5/6'
                        : renderProgress >= 65
                          ? 'w-3/4'
                          : renderProgress >= 45
                            ? 'w-1/2'
                            : renderProgress >= 20
                              ? 'w-1/3'
                              : 'w-1/6'
                  }`}
                />
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => void handleCancelRender()}
                  className="text-[11px] font-semibold text-red-600 hover:text-red-800 cursor-pointer"
                >
                  Batalkan & Hentikan Server
                </button>
              </div>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="video/mp4,video/webm,video/quicktime,video/x-matroska"
            onChange={handleUploadSourceVideo}
            className="hidden"
            id="upload-source-video-input"
          />
          <button
            type="button"
            disabled={isUploadingSource || isRenderingMp4}
            onClick={() => fileInputRef.current?.click()}
            className="w-full inline-flex items-center justify-center gap-1.5 h-9 px-3 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg studio-transition cursor-pointer whitespace-nowrap disabled:opacity-60"
          >
            <Upload className="w-3.5 h-3.5" aria-hidden="true" />
            <span>
              {isUploadingSource
                ? 'Mengunggah...'
                : episode.hasUploadedSourceVideo
                  ? 'Ganti File MP4 Sumber'
                  : 'Unggah MP4 Sumber 1080p/4K (Opsional)'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setNeedsSourceOrCookies((prev) => !prev)}
            className="w-full inline-flex items-center justify-center gap-1.5 h-8 px-3 text-[11px] font-semibold text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg studio-transition cursor-pointer"
          >
            <KeyRound className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
            <span>
              {canManageCookies
                ? hasYoutubeCookies
                  ? 'Link MP4 Langsung / Cookies YouTube Aktif · Ubah'
                  : 'Link MP4 Langsung / Pasang Cookies YouTube'
                : 'Pasang Link Video .MP4 Langsung (Alternatif)'}
            </span>
          </button>
        </div>

        {episode.hasUploadedSourceVideo && (
          <p className="text-[11px] font-medium text-emerald-700">
            Video podcast sumber tersimpan di server — pemotongan MP4 langsung memakai file lokal Anda.
          </p>
        )}

        {!episode.hasUploadedSourceVideo && episode.directVideoUrl && (
          <p className="text-[11px] font-medium text-emerald-700">
            Link video .MP4 langsung terpasang — render melewati blokir YouTube secara otomatis.
          </p>
        )}

        {renderError && (
          <div
            role="alert"
            className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-xs font-medium text-red-700 leading-relaxed space-y-2"
          >
            <p>{renderError}</p>
            {(renderErrorCode === 'RATE_LIMITED' ||
              renderError.includes('429') ||
              renderError.toLowerCase().includes('sibuk') ||
              renderError.toLowerCase().includes('penuh')) && (
              <button
                type="button"
                disabled={isClearingQueue || isRenderingMp4}
                onClick={() => void handleClearQueueAndRetry()}
                className="inline-flex items-center justify-center h-7 px-2.5 text-[11px] font-semibold text-red-700 bg-white border border-red-300 hover:bg-red-100 rounded-md cursor-pointer disabled:opacity-60"
              >
                {isClearingQueue
                  ? 'Mengosongkan antrean...'
                  : 'Kosongkan Antrean & Coba Lagi'}
              </button>
            )}
          </div>
        )}

        {needsSourceOrCookies && (
          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-900">
                <Film className="w-3.5 h-3.5 text-red-600 shrink-0" aria-hidden="true" />
                <span>Alternatif 1 — Link Video .MP4 Langsung (Bebas Blokir YouTube):</span>
              </div>
              <p className="text-[11px] text-slate-600 leading-relaxed">
                Tempel URL file <code>.mp4</code> langsung (GCS / S3 / CDN / server Anda) atau
                gunakan tombol <strong>Unggah MP4 Sumber</strong> di atas agar server tidak perlu
                mengunduh dari YouTube.
              </p>
              <div className="flex gap-2">
                <label htmlFor="inline-direct-mp4-url" className="sr-only">
                  URL video MP4 langsung
                </label>
                <input
                  id="inline-direct-mp4-url"
                  type="url"
                  value={directUrlDraft}
                  onChange={(e) => setDirectUrlDraft(e.target.value)}
                  placeholder="https://cdn.domainanda.com/podcast-full.mp4"
                  className="flex-1 min-w-0 h-8 px-2.5 text-xs bg-white border border-slate-200 rounded-md focus:border-red-600 focus:outline-none"
                />
                <button
                  type="button"
                  disabled={isSavingDirectUrl}
                  onClick={handleSaveDirectSourceUrl}
                  className="h-8 px-3 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-md cursor-pointer whitespace-nowrap disabled:opacity-60"
                >
                  {isSavingDirectUrl ? 'Menyimpan...' : 'Pakai Link'}
                </button>
              </div>
            </div>

            {canManageCookies && (
              <div className="pt-2.5 border-t border-slate-200 space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-900">
                  <KeyRound className="w-3.5 h-3.5 text-red-600 shrink-0" aria-hidden="true" />
                  <span>Alternatif 2 — Cookies YouTube Server (Admin):</span>
                </div>
                <p className="text-[11px] text-slate-600 leading-relaxed">
                  Tempel isi file <code>cookies.txt</code> format Netscape agar server cloud bisa
                  mengunduh langsung dari YouTube tanpa terkena cek bot.
                </p>
                <label htmlFor="inline-cookies-txt" className="sr-only">
                  Tempel cookies.txt YouTube
                </label>
                <textarea
                  id="inline-cookies-txt"
                  rows={2}
                  value={cookiesDraft}
                  onChange={(e) => setCookiesDraft(e.target.value)}
                  placeholder="# Netscape HTTP Cookie File..."
                  className="w-full p-2 text-xs font-mono bg-white border border-slate-200 rounded-md focus:border-red-600 focus:outline-none"
                />
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    disabled={isSavingCookies}
                    onClick={handleSaveCookiesAndRender}
                    className="w-full h-8 px-3 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-md cursor-pointer disabled:opacity-60"
                  >
                    {isSavingCookies ? 'Menyimpan...' : 'Simpan Cookies & Render 1080p/4K Asli'}
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyLocalCmd}
                    className="w-full h-8 inline-flex items-center justify-center gap-1.5 px-3 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-md cursor-pointer"
                  >
                    {copiedCmd ? (
                      <Check className="w-3.5 h-3.5 text-emerald-700" aria-hidden="true" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    <span>{copiedCmd ? 'Perintah Tersalin' : 'Salin Perintah yt-dlp Lokal'}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Trimmer Controls */}
      <div className="pt-4 border-t border-slate-200 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-slate-700">
            Atur Potongan Timestamp
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => handleNudge('start', -5)}
              className="px-2 py-1 text-xs font-mono tabular-nums text-slate-600 bg-slate-100 hover:bg-slate-200 rounded cursor-pointer whitespace-nowrap"
            >
              Awal -5d
            </button>
            <button
              type="button"
              onClick={() => handleNudge('end', 10)}
              className="px-2 py-1 text-xs font-mono tabular-nums text-slate-600 bg-slate-100 hover:bg-slate-200 rounded cursor-pointer whitespace-nowrap"
            >
              Akhir +10d
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label htmlFor="trim-start" className="block text-xs text-slate-500 mb-1 whitespace-nowrap">
              Mulai (MM:SS)
            </label>
            <input
              id="trim-start"
              type="text"
              value={startInput}
              onChange={(e) => setStartInput(e.target.value)}
              className="w-full h-9 px-3 text-sm font-mono tabular-nums text-slate-900 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-red-600 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="trim-end" className="block text-xs text-slate-500 mb-1 whitespace-nowrap">
              Selesai (MM:SS)
            </label>
            <input
              id="trim-end"
              type="text"
              value={endInput}
              onChange={(e) => setEndInput(e.target.value)}
              className="w-full h-9 px-3 text-sm font-mono tabular-nums text-slate-900 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-red-600 focus:outline-none"
            />
          </div>
          <button
            type="button"
            disabled={isSavingTrim}
            onClick={handleApplyTrim}
            className="col-span-2 w-full inline-flex items-center justify-center gap-1.5 h-9 px-4 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg studio-transition whitespace-nowrap cursor-pointer disabled:opacity-60"
          >
            <Scissors className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{isSavingTrim ? 'Menyimpan...' : 'Simpan Potongan'}</span>
          </button>
        </div>

        {trimError && (
          <p role="alert" className="text-xs font-medium text-red-600">
            {trimError}
          </p>
        )}
      </div>

      <ClipOverlayEditorModal
        isOpen={isOverlayEditorOpen}
        clip={clip}
        episode={episode}
        isLandscape={renderLayout === 'full_16_9_focus'}
        isRenderingMp4={isRenderingMp4}
        onClose={() => setIsOverlayEditorOpen(false)}
        onSaveStyle={(nextStyle) => onSaveOverlayStyle(clip.id, nextStyle)}
        onSaveAndRender={async (nextStyle) => {
          await onSaveOverlayStyle(clip.id, nextStyle);
          void handleRenderMp4(undefined, undefined, true, nextStyle);
        }}
      />
    </div>
  );
}
