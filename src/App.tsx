import { useEffect, useRef, useState } from 'react';
import { AutomationSettingsView } from './components/AutomationSettingsView';
import { ClipListPanel } from './components/ClipListPanel';
import { ClipPublisherPanel } from './components/ClipPublisherPanel';
import { DistributionQueueView } from './components/DistributionQueueView';
import { ManualShortsModal } from './components/ManualShortsModal';
import { PodcastInputBar } from './components/PodcastInputBar';
import { ShortsPreviewStage } from './components/ShortsPreviewStage';
import { SummaryArchiveView } from './components/SummaryArchiveView';
import { TopBar, type NavSection } from './components/TopBar';
import { INITIAL_STUDIO_STATE } from './data/seedPodcasts';
import type {
  BotAutomationConfig,
  PodcastClip,
  SocialPlatform,
  StudioStoreState,
} from './types/clipper';
import { PLATFORM_LABELS } from './utils/youtube';

export default function App() {
  const [store, setStore] = useState<StudioStoreState>(INITIAL_STUDIO_STATE);
  const [activeSection, setActiveSection] = useState<NavSection>('studio');
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string>(
    INITIAL_STUDIO_STATE.episodes[0].id
  );
  const [selectedClipId, setSelectedClipId] = useState<string>(
    INITIAL_STUDIO_STATE.clips[0].id
  );
  const [isLoadingStore, setIsLoadingStore] = useState(true);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [analyzeSuccess, setAnalyzeSuccess] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishFeedback, setPublishFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const [isManualModalOpen, setIsManualModalOpen] = useState(false);

  const urlInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadStore() {
      try {
        const res = await fetch('/api/state');
        if (!res.ok) return;
        const data = (await res.json()) as StudioStoreState;
        if (!cancelled && data.episodes.length > 0) {
          setStore(data);
          const firstEp = data.episodes[0];
          setSelectedEpisodeId(firstEp.id);
          const firstClip = data.clips.find((c) => c.episodeId === firstEp.id) ?? data.clips[0];
          if (firstClip) setSelectedClipId(firstClip.id);
        }
      } catch {
        // Fallback to seed state if offline
      } finally {
        if (!cancelled) setIsLoadingStore(false);
      }
    }
    loadStore();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeEpisode =
    store.episodes.find((e) => e.id === selectedEpisodeId) ?? store.episodes[0];
  const episodeClips = store.clips.filter((c) => c.episodeId === activeEpisode?.id);
  const activeClip =
    episodeClips.find((c) => c.id === selectedClipId) ?? episodeClips[0];

  const handleSelectEpisode = (episodeId: string) => {
    setSelectedEpisodeId(episodeId);
    const first = store.clips.find((c) => c.episodeId === episodeId);
    if (first) setSelectedClipId(first.id);
    setPublishFeedback(null);
  };

  const handleAnalyzePodcast = async (payload: {
    url: string;
    manualTranscript?: string;
    autoPostOverride: boolean;
  }) => {
    setIsAnalyzing(true);
    setAnalyzeError(null);
    setAnalyzeSuccess(null);
    setPublishFeedback(null);
    try {
      const res = await fetch('/api/podcast/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setAnalyzeError(data.error || 'Gagal menganalisis podcast YouTube.');
        return;
      }
      setStore(data.store);
      setSelectedEpisodeId(data.episode.id);
      if (data.clips?.[0]) {
        setSelectedClipId(data.clips[0].id);
      }
      setAnalyzeSuccess(
        `Berhasil memotong ${data.clips?.length ?? 0} klip dari "${data.episode.title}". Hasil pratinjau Shorts 9:16 dan ringkasan teks siap di bawah.`
      );
      if (payload.autoPostOverride) {
        setPublishFeedback({
          type: 'success',
          text: 'Klip Sorotan Utama berhasil dipotong dan langsung didistribusikan oleh bot otomatis.',
        });
      }
      window.setTimeout(() => {
        document.getElementById('clip-results-studio')?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      }, 80);
    } catch {
      setAnalyzeError('Terjadi gangguan jaringan saat menghubungi server analisis.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleUpdateClip = async (clipId: string, patch: Partial<PodcastClip>) => {
    const res = await fetch(`/api/clips/${clipId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const data = await res.json();
      setStore(data.store);
    }
  };

  const handleSaveTrim = async (clipId: string, startSec: number, endSec: number) => {
    await handleUpdateClip(clipId, { startSec, endSec });
  };

  const handlePublishClip = async (
    clipId: string,
    mode: 'auto' | 'manual',
    platforms: SocialPlatform[]
  ) => {
    setIsPublishing(true);
    setPublishFeedback(null);
    try {
      const res = await fetch(`/api/clips/${clipId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, platforms }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPublishFeedback({
          type: 'error',
          text: data.error || 'Gagal memproses distribusi klip.',
        });
        return;
      }
      setStore(data.store);
      const labelList = platforms.map((p) => PLATFORM_LABELS[p]).join(', ');
      setPublishFeedback({
        type: 'success',
        text:
          mode === 'auto'
            ? `Auto-Post berhasil dijalankan untuk ${labelList}.`
            : `Status klip diperbarui sebagai Diposting Manual (${labelList}).`,
      });
    } catch {
      setPublishFeedback({
        type: 'error',
        text: 'Gagal menghubungi server publikasi.',
      });
    } finally {
      setIsPublishing(false);
    }
  };

  const handleDeleteClip = async (clipId: string) => {
    const res = await fetch(`/api/clips/${clipId}`, { method: 'DELETE' });
    if (res.ok) {
      const data = (await res.json()) as { store: StudioStoreState };
      setStore(data.store);
      if (selectedClipId === clipId) {
        const fallback = data.store.clips.find((c) => c.episodeId === selectedEpisodeId) ?? data.store.clips[0];
        if (fallback) setSelectedClipId(fallback.id);
      }
    }
  };

  const handleSaveAutomation = async (nextConfig: BotAutomationConfig) => {
    const res = await fetch('/api/automation', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nextConfig),
    });
    if (res.ok) {
      const data = await res.json();
      setStore(data.store);
    }
  };

  const handleResetDemo = async () => {
    const res = await fetch('/api/reset-demo', { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      setStore(data.store);
      setSelectedEpisodeId(data.store.episodes[0].id);
      setSelectedClipId(data.store.clips[0].id);
      setActiveSection('studio');
    }
  };

  const handleStartNewLink = () => {
    setActiveSection('studio');
    window.setTimeout(() => {
      urlInputRef.current?.focus();
      urlInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
  };

  const handleJumpToClip = (episodeId: string, clipId: string) => {
    setSelectedEpisodeId(episodeId);
    setSelectedClipId(clipId);
    setPublishFeedback(null);
    setActiveSection('studio');
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      <TopBar
        activeSection={activeSection}
        onNavigate={setActiveSection}
        onStartNewLink={handleStartNewLink}
      />

      <main className="flex-1 w-full max-w-[1440px] mx-auto px-4 sm:px-8 py-6 sm:py-8">
        {activeSection === 'studio' && (
          <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
              <div className="max-w-2xl">
                <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 text-balance">
                  Studio Klip Podcast & Ringkasan Otomatis
                </h1>
                <p className="text-sm text-slate-600 mt-1">
                  Tempel link podcast YouTube untuk memotong bagian paling menarik menjadi YouTube Shorts, membuat ringkasan teksnya, lalu terbitkan otomatis atau manual.
                </p>
              </div>
              <div className="text-xs font-mono tabular-nums text-slate-500 whitespace-nowrap">
                {store.episodes.length} episode · {store.clips.length} klip siap kelola
              </div>
            </div>

            <PodcastInputBar
              inputRef={urlInputRef}
              isAnalyzing={isAnalyzing}
              autoPostEnabled={store.automation.autoPostOnAnalyze}
              errorMessage={analyzeError}
              onAnalyze={handleAnalyzePodcast}
            />

            {analyzeSuccess && (
              <div
                role="status"
                className="bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-xl px-4 py-3 text-sm font-medium"
              >
                {analyzeSuccess}
              </div>
            )}

            {!isLoadingStore && activeEpisode && activeClip ? (
              <div
                id="clip-results-studio"
                className="grid grid-cols-1 lg:grid-cols-[280px_400px_minmax(0,1fr)] gap-6 items-start"
              >
                <ClipListPanel
                  episodes={store.episodes}
                  selectedEpisodeId={activeEpisode.id}
                  onSelectEpisode={handleSelectEpisode}
                  clips={episodeClips}
                  selectedClipId={activeClip.id}
                  onSelectClip={(id) => {
                    setSelectedClipId(id);
                    setPublishFeedback(null);
                  }}
                  isAnalyzing={isAnalyzing}
                />

                <ShortsPreviewStage
                  clip={activeClip}
                  episode={activeEpisode}
                  defaultRenderQuality={
                    store.automation.enableUltraHdRender
                      ? '4k'
                      : store.automation.defaultRenderQuality
                  }
                  defaultRenderLayout={store.automation.defaultRenderLayout}
                  defaultEmotionEffectsEnabled={store.automation.enableAiEmotionEffects}
                  ultraHdEnabled={store.automation.enableUltraHdRender}
                  onSaveTrim={handleSaveTrim}
                  onStoreUpdate={setStore}
                />

                <ClipPublisherPanel
                  clip={activeClip}
                  episode={activeEpisode}
                  defaultPlatforms={store.automation.defaultPlatforms}
                  isPublishing={isPublishing}
                  publishFeedback={publishFeedback}
                  onUpdateClip={handleUpdateClip}
                  onAutoPostAll={(id, platforms) => handlePublishClip(id, 'auto', platforms)}
                  onOpenManualShorts={() => setIsManualModalOpen(true)}
                  onManualSharePlatform={(id, platform) =>
                    handlePublishClip(id, 'manual', [platform])
                  }
                />
              </div>
            ) : (
              <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-3">
                <p className="text-base font-semibold text-slate-900">
                  {isLoadingStore ? 'Memuat studio kliping...' : 'Belum ada klip podcast'}
                </p>
                {!isLoadingStore && (
                  <button
                    type="button"
                    onClick={handleResetDemo}
                    className="px-4 py-2 text-sm font-semibold text-white bg-slate-900 rounded-lg cursor-pointer"
                  >
                    Muat Contoh Podcast
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {activeSection === 'summaries' && (
          <SummaryArchiveView
            episodes={store.episodes}
            clips={store.clips}
            onJumpToClip={handleJumpToClip}
          />
        )}

        {activeSection === 'queue' && (
          <DistributionQueueView
            episodes={store.episodes}
            clips={store.clips}
            logs={store.distributionLogs}
            defaultPlatforms={store.automation.defaultPlatforms}
            onJumpToClip={handleJumpToClip}
            onAutoPostClip={(id, platforms) => handlePublishClip(id, 'auto', platforms)}
            onDeleteClip={handleDeleteClip}
          />
        )}

        {activeSection === 'automation' && (
          <AutomationSettingsView
            config={store.automation}
            onSaveConfig={handleSaveAutomation}
            onResetDemo={handleResetDemo}
          />
        )}
      </main>

      {activeEpisode && activeClip && (
        <ManualShortsModal
          clip={activeClip}
          episode={activeEpisode}
          isOpen={isManualModalOpen}
          defaultRenderQuality={
            store.automation.enableUltraHdRender
              ? '4k'
              : store.automation.defaultRenderQuality
          }
          defaultRenderLayout={store.automation.defaultRenderLayout}
          onClose={() => setIsManualModalOpen(false)}
          onMarkManualPublished={(id) => handlePublishClip(id, 'manual', ['youtube_shorts'])}
          onStoreUpdate={setStore}
        />
      )}
    </div>
  );
}
