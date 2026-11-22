import { useEffect, useRef, useState } from 'react';
import type { User } from '@firebase/auth';
import { AdminControlCenterView } from './components/AdminControlCenterView';
import { AiContentStudioView } from './components/AiContentStudioView';
import { AnalyticsAndTemplatesView } from './components/AnalyticsAndTemplatesView';
import { AutomationSettingsView } from './components/AutomationSettingsView';
import { ClipListPanel } from './components/ClipListPanel';
import { ClipPublisherPanel } from './components/ClipPublisherPanel';
import { DistributionQueueView } from './components/DistributionQueueView';
import { ManualShortsModal } from './components/ManualShortsModal';
import { PodcastInputBar } from './components/PodcastInputBar';
import { ShortsPreviewStage } from './components/ShortsPreviewStage';
import { SmartVideoEditorView } from './components/SmartVideoEditorView';
import { SummaryArchiveView } from './components/SummaryArchiveView';
import { TopBar, type NavSection } from './components/TopBar';
import { UserDashboardView } from './components/UserDashboardView';
import { YouTubeDirectUploadModal } from './components/YouTubeDirectUploadModal';
import { GoogleLoginGate } from './components/GoogleLoginGate';
import { INITIAL_STUDIO_STATE } from './data/seedPodcasts';
import type {
  BotAutomationConfig,
  ClipOverlayStyle,
  ClippingApproach,
  PodcastClip,
  SocialPlatform,
  StudioStoreState,
  StudioTemplate,
  ThemePreset,
  UserRole,
} from './types/clipper';
import { DEFAULT_CLIP_OVERLAY_STYLE } from './utils/clipOverlayStyle';
import { apiFetch } from './utils/apiClient';
import { PLATFORM_LABELS } from './utils/youtube';
import {
  clearYouTubeAccessToken,
  getYouTubeAccessToken,
  initGoogleSessionListener,
  signInWithGoogleSession,
  signOutGoogleSession,
  type VerifiedGoogleIdentity,
} from './utils/youtubeAuth';
import type { YouTubePrivacyStatus } from '../server/youtubeUploader';

export default function App() {
  const [store, setStore] = useState<StudioStoreState>(INITIAL_STUDIO_STATE);
  const [activeSection, setActiveSection] = useState<NavSection>('studio');
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string>(
    INITIAL_STUDIO_STATE.episodes[0].id
  );
  const [selectedClipId, setSelectedClipId] = useState<string>(
    INITIAL_STUDIO_STATE.clips[0].id
  );
  const [isLoadingStore, setIsLoadingStore] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [analyzeSuccess, setAnalyzeSuccess] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishFeedback, setPublishFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const [isManualModalOpen, setIsManualModalOpen] = useState(false);
  const [themePreset, setThemePreset] = useState<ThemePreset>(() => {
    if (typeof window !== 'undefined') {
      const savedPreset = window.localStorage.getItem('klipcast_theme_preset');
      if (
        savedPreset === 'minimal_light' ||
        savedPreset === 'dark_studio' ||
        savedPreset === 'creator_neon' ||
        savedPreset === 'professional'
      ) {
        return savedPreset;
      }
      const legacy = window.localStorage.getItem('klipcast_theme');
      if (legacy === 'dark') return 'dark_studio';
    }
    return 'minimal_light';
  });

  // Google Identity & server verification gate + in-memory YouTube upload OAuth token
  const [isCheckingGoogleSession, setIsCheckingGoogleSession] = useState(true);
  const [youtubeUser, setYoutubeUser] = useState<User | null>(null);
  const [verifiedIdentity, setVerifiedIdentity] = useState<VerifiedGoogleIdentity | null>(null);
  const [youtubeAccessToken, setYoutubeAccessToken] = useState<string | null>(() =>
    getYouTubeAccessToken()
  );
  const [isSigningInGoogle, setIsSigningInGoogle] = useState(false);
  const [googleAuthPhase, setGoogleAuthPhase] = useState<'idle' | 'popup' | 'verifying'>('idle');
  const [googleAuthError, setGoogleAuthError] = useState<string | null>(null);
  const [isYouTubeUploadModalOpen, setIsYouTubeUploadModalOpen] = useState(false);
  const [isUploadingYouTube, setIsUploadingYouTube] = useState(false);
  const [youTubeUploadError, setYouTubeUploadError] = useState<string | null>(null);

  const isPreviewAutostart =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('autostart') === '1';

  const urlInputRef = useRef<HTMLInputElement | null>(null);

  const isAuthenticatedWithGoogle = Boolean(youtubeUser && verifiedIdentity);
  const userRole: UserRole = verifiedIdentity?.role ?? 'user';
  const isAdmin = userRole === 'admin' || userRole === 'super_admin';

  useEffect(() => {
    const isDark = themePreset === 'dark_studio' || themePreset === 'creator_neon';
    document.documentElement.dataset.theme = themePreset;
    document.documentElement.classList.toggle('dark', isDark);
    try {
      window.localStorage.setItem('klipcast_theme_preset', themePreset);
      window.localStorage.setItem('klipcast_theme', isDark ? 'dark' : 'light');
    } catch {
      // Ignore storage restrictions
    }
  }, [themePreset]);

  const handleThemePresetChange = (nextPreset: ThemePreset) => {
    setThemePreset(nextPreset);
    const isDark = nextPreset === 'dark_studio' || nextPreset === 'creator_neon';
    if (isAuthenticatedWithGoogle) {
      void apiFetch('/api/me/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          themePreference: isDark ? 'dark' : 'light',
          themePreset: nextPreset,
        }),
      }).catch(() => {});
    }
  };

  const handleCycleTheme = () => {
    const order: ThemePreset[] = [
      'minimal_light',
      'dark_studio',
      'creator_neon',
      'professional',
    ];
    const next = order[(order.indexOf(themePreset) + 1) % order.length];
    handleThemePresetChange(next);
  };

  useEffect(() => {
    const unsubscribe = initGoogleSessionListener({
      onSessionRestored: (user, identity, accessToken) => {
        setYoutubeUser(user);
        setVerifiedIdentity(identity);
        setYoutubeAccessToken(accessToken);
        setGoogleAuthError(null);
        setIsCheckingGoogleSession(false);
      },
      onSessionError: (message) => {
        setGoogleAuthError(message);
        setIsCheckingGoogleSession(false);
      },
      onSignedOut: () => {
        setYoutubeUser(null);
        setVerifiedIdentity(null);
        setYoutubeAccessToken(null);
        setIsCheckingGoogleSession(false);
      },
    });
    return unsubscribe;
  }, []);

  const refreshStoreFromServer = async () => {
    if (!isAuthenticatedWithGoogle) {
      setIsLoadingStore(false);
      return;
    }
    setIsLoadingStore(true);
    try {
      const res = await apiFetch('/api/state', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as StudioStoreState;
      setStore(data);
      if (data.episodes.length > 0) {
        const firstEp = data.episodes[0];
        setSelectedEpisodeId((prev) =>
          data.episodes.some((e) => e.id === prev) ? prev : firstEp.id
        );
        const firstClip = data.clips.find((c) => c.episodeId === firstEp.id) ?? data.clips[0];
        if (firstClip) {
          setSelectedClipId((prev) =>
            data.clips.some((c) => c.id === prev) ? prev : firstClip.id
          );
        }
      }
    } catch {
      // Keep current state on transient network failure
    } finally {
      setIsLoadingStore(false);
    }
  };

  useEffect(() => {
    if (!isAuthenticatedWithGoogle) {
      setIsLoadingStore(false);
      return;
    }
    void refreshStoreFromServer();
  }, [isAuthenticatedWithGoogle, verifiedIdentity?.uid]);

  useEffect(() => {
    if (activeSection === 'admin' && !isAdmin) {
      setActiveSection('dashboard');
    }
  }, [activeSection, isAdmin]);

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
    clippingApproach: ClippingApproach;
  }) => {
    if (!isAuthenticatedWithGoogle) {
      setAnalyzeError('Silakan masuk dengan akun Google terlebih dahulu untuk menganalisis link YouTube.');
      return;
    }
    setIsAnalyzing(true);
    setAnalyzeError(null);
    setAnalyzeSuccess(null);
    setPublishFeedback(null);
    try {
      const res = await apiFetch('/api/podcast/analyze', {
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
    if (!isAuthenticatedWithGoogle) {
      setStore((prev) => ({
        ...prev,
        clips: prev.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
      }));
      return;
    }
    const res = await apiFetch(`/api/clips/${clipId}`, {
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

  const handleScheduleClip = async (
    clipId: string,
    scheduledAt: string | null,
    platforms: SocialPlatform[]
  ) => {
    if (!isAuthenticatedWithGoogle) {
      setStore((prev) => ({
        ...prev,
        clips: prev.clips.map((c) =>
          c.id === clipId
            ? {
                ...c,
                scheduledAt: scheduledAt ?? undefined,
                status: scheduledAt ? 'scheduled' : 'draft',
              }
            : c
        ),
      }));
      return;
    }
    const res = await apiFetch(`/api/clips/${clipId}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduledAt, platforms }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.store) setStore(data.store);
    }
  };

  const handlePublishClip = async (
    clipId: string,
    mode: 'auto' | 'manual',
    platforms: SocialPlatform[]
  ) => {
    if (!isAuthenticatedWithGoogle) {
      setPublishFeedback({
        type: 'error',
        text: 'Masuk dengan akun Google untuk menjalankan publikasi dan menyimpan riwayat ke cloud.',
      });
      return;
    }
    setIsPublishing(true);
    setPublishFeedback(null);
    try {
      const res = await apiFetch(`/api/clips/${clipId}/publish`, {
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
    if (!isAuthenticatedWithGoogle) {
      setStore((prev) => ({
        ...prev,
        clips: prev.clips.filter((c) => c.id !== clipId),
      }));
      return;
    }
    const res = await apiFetch(`/api/clips/${clipId}`, { method: 'DELETE' });
    if (res.ok) {
      const data = (await res.json()) as { store: StudioStoreState };
      setStore(data.store);
      if (selectedClipId === clipId) {
        const fallback =
          data.store.clips.find((c) => c.episodeId === selectedEpisodeId) ?? data.store.clips[0];
        if (fallback) setSelectedClipId(fallback.id);
      }
    }
  };

  const handleSaveAutomation = async (nextConfig: BotAutomationConfig) => {
    if (!isAuthenticatedWithGoogle) {
      setStore((prev) => ({ ...prev, automation: nextConfig }));
      return;
    }
    const res = await apiFetch('/api/automation', {
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
    if (!isAuthenticatedWithGoogle) {
      setStore(INITIAL_STUDIO_STATE);
      setSelectedEpisodeId(INITIAL_STUDIO_STATE.episodes[0].id);
      setSelectedClipId(INITIAL_STUDIO_STATE.clips[0].id);
      setActiveSection('studio');
      return;
    }
    const res = await apiFetch('/api/reset-demo', { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      setStore(data.store);
      if (data.store.episodes[0]) setSelectedEpisodeId(data.store.episodes[0].id);
      if (data.store.clips[0]) setSelectedClipId(data.store.clips[0].id);
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

  const handleGoogleSignIn = async (requireYouTubeAccessToken = false) => {
    setIsSigningInGoogle(true);
    setGoogleAuthPhase('popup');
    setGoogleAuthError(null);
    try {
      const session = await signInWithGoogleSession({
        requireYouTubeAccessToken,
        onPhaseChange: (phase) => setGoogleAuthPhase(phase),
      });
      setYoutubeUser(session.user);
      setVerifiedIdentity(session.verifiedIdentity);
      setYoutubeAccessToken(session.accessToken);
      setIsCheckingGoogleSession(false);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Gagal masuk dengan Google. Pastikan popup tidak diblokir browser.';
      setGoogleAuthError(msg);
    } finally {
      setIsSigningInGoogle(false);
      setGoogleAuthPhase('idle');
    }
  };

  const handleGoogleSignOut = async () => {
    await signOutGoogleSession();
    setYoutubeUser(null);
    setVerifiedIdentity(null);
    setYoutubeAccessToken(null);
    setGoogleAuthError(null);
    setIsYouTubeUploadModalOpen(false);
    setStore(INITIAL_STUDIO_STATE);
    if (activeSection === 'admin') setActiveSection('studio');
  };

  const handleOpenYouTubeDirectUpload = () => {
    setYouTubeUploadError(null);
    setIsYouTubeUploadModalOpen(true);
  };

  const handleConfirmYouTubeDirectUpload = async (payload: {
    title: string;
    description: string;
    tags: string[];
    privacyStatus: YouTubePrivacyStatus;
  }) => {
    if (!activeClip) return;
    const token = youtubeAccessToken ?? getYouTubeAccessToken();
    if (!token) {
      setYouTubeUploadError(
        'Sesi izin unggah YouTube belum aktif. Silakan klik "Aktifkan Izin Upload YouTube" terlebih dahulu.'
      );
      return;
    }

    setIsUploadingYouTube(true);
    setYouTubeUploadError(null);
    setPublishFeedback(null);
    try {
      // apiFetch sends Authorization: Bearer <firebaseIdToken>; YouTube OAuth token goes in X-YouTube-Access-Token
      const res = await apiFetch(`/api/clips/${activeClip.id}/youtube-upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-YouTube-Access-Token': token,
        },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        youtubeWatchUrl?: string;
        store?: StudioStoreState;
        error?: string;
        needsReauth?: boolean;
      };
      if (!res.ok) {
        if (data.needsReauth || res.status === 401) {
          clearYouTubeAccessToken();
          setYoutubeAccessToken(null);
        }
        setYouTubeUploadError(data.error || 'Gagal mengunggah video ke YouTube.');
        return;
      }

      if (data.store) {
        setStore(data.store);
      }
      setIsYouTubeUploadModalOpen(false);
      setPublishFeedback({
        type: 'success',
        text: data.youtubeWatchUrl
          ? `Video berhasil diunggah ke YouTube Shorts! (${data.youtubeWatchUrl})`
          : 'Video berhasil diunggah ke YouTube Shorts!',
      });
    } catch {
      setYouTubeUploadError('Terjadi gangguan jaringan saat mengunggah video ke YouTube.');
    } finally {
      setIsUploadingYouTube(false);
    }
  };

  if (!isPreviewAutostart && (isCheckingGoogleSession || !isAuthenticatedWithGoogle)) {
    return (
      <GoogleLoginGate
        isCheckingSession={isCheckingGoogleSession}
        isSigningIn={isSigningInGoogle}
        authPhase={googleAuthPhase}
        errorMessage={googleAuthError}
        onGoogleSignIn={() => void handleGoogleSignIn(false)}
      />
    );
  }

  return (
    <div className="app-shell min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <TopBar
        activeSection={activeSection}
        onNavigate={setActiveSection}
        onStartNewLink={handleStartNewLink}
        youtubeUser={youtubeUser}
        isGoogleVerified={Boolean(verifiedIdentity)}
        userRole={userRole}
        isSigningInGoogle={isSigningInGoogle}
        themePreset={themePreset}
        onCycleTheme={handleCycleTheme}
        onGoogleSignIn={() => void handleGoogleSignIn(false)}
        onGoogleSignOut={() => void handleGoogleSignOut()}
      />

      <main className="flex-1 w-full max-w-[1440px] mx-auto px-4 sm:px-8 py-6 sm:py-8">
        {activeSection === 'dashboard' && (
          <UserDashboardView
            isAuthenticated={isAuthenticatedWithGoogle}
            episodes={store.episodes}
            clips={store.clips}
            userDisplayName={youtubeUser?.displayName ?? null}
            userEmail={youtubeUser?.email ?? null}
            userRole={userRole}
            themePreset={themePreset}
            onThemePresetChange={handleThemePresetChange}
            onJumpToClip={handleJumpToClip}
            onOpenStudio={() => setActiveSection('studio')}
            onOpenAiStudio={() => setActiveSection('ai_studio')}
            onGoogleSignIn={() => void handleGoogleSignIn(false)}
            onDataDeleted={refreshStoreFromServer}
          />
        )}

        {activeSection === 'studio' && (
          <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
              <div className="max-w-2xl">
                <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white text-balance">
                  Studio Klip Podcast & Ringkasan Otomatis
                </h1>
                <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                  Tempel link podcast YouTube untuk memotong bagian paling menarik menjadi YouTube Shorts, Reels, atau TikTok lengkap dengan intro AI, subtitle akurat, dan auto-fokus pembicara.
                </p>
              </div>
              <div className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
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
                className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200 rounded-xl px-4 py-3 text-sm font-medium"
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
                  defaultAiIntroEnabled={store.automation.enableAiIntro}
                  ultraHdEnabled={store.automation.enableUltraHdRender}
                  isAuthenticated={isAuthenticatedWithGoogle}
                  canManageCookies={isAdmin}
                  onSaveTrim={handleSaveTrim}
                  onSaveOverlayStyle={(clipId, overlayStyle) =>
                    handleUpdateClip(clipId, { overlayStyle })
                  }
                  onStoreUpdate={setStore}
                />

                <ClipPublisherPanel
                  clip={activeClip}
                  episode={activeEpisode}
                  defaultPlatforms={store.automation.defaultPlatforms}
                  isPublishing={isPublishing}
                  publishFeedback={publishFeedback}
                  youtubeUser={youtubeUser}
                  hasYouTubeToken={Boolean(youtubeAccessToken)}
                  isSigningInGoogle={isSigningInGoogle}
                  googleAuthError={googleAuthError}
                  onGoogleSignIn={() => void handleGoogleSignIn(true)}
                  onGoogleSignOut={() => void handleGoogleSignOut()}
                  onOpenYouTubeDirectUpload={handleOpenYouTubeDirectUpload}
                  onUpdateClip={handleUpdateClip}
                  onAutoPostAll={(id, platforms) => handlePublishClip(id, 'auto', platforms)}
                  onOpenManualShorts={() => setIsManualModalOpen(true)}
                  onManualSharePlatform={(id, platform) =>
                    handlePublishClip(id, 'manual', [platform])
                  }
                />
              </div>
            ) : (
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-10 text-center space-y-3">
                <p className="text-base font-semibold text-slate-900 dark:text-white">
                  {isLoadingStore ? 'Memuat studio kliping...' : 'Belum ada klip podcast'}
                </p>
                {!isLoadingStore && (
                  <button
                    type="button"
                    onClick={() => void handleResetDemo()}
                    className="px-4 py-2 text-sm font-semibold text-white bg-slate-900 dark:bg-red-600 rounded-lg cursor-pointer"
                  >
                    Muat Contoh Podcast
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {activeSection === 'editor' && (
          <SmartVideoEditorView
            episodes={store.episodes}
            clips={store.clips}
            activeEpisodeId={activeEpisode?.id ?? ''}
            activeClipId={activeClip?.id ?? ''}
            isAuthenticated={isAuthenticatedWithGoogle}
            onSelectClip={(epId, cId) => {
              setSelectedEpisodeId(epId);
              setSelectedClipId(cId);
            }}
            onUpdateClip={handleUpdateClip}
            onJumpToRenderStudio={() => setActiveSection('studio')}
          />
        )}

        {activeSection === 'ai_studio' && (
          <AiContentStudioView
            episodes={store.episodes}
            clips={store.clips}
            activeEpisodeId={activeEpisode?.id ?? ''}
            activeClipId={activeClip?.id ?? ''}
            isAuthenticated={isAuthenticatedWithGoogle}
            onSelectClip={(epId, cId) => {
              setSelectedEpisodeId(epId);
              setSelectedClipId(cId);
            }}
            onUpdateClip={handleUpdateClip}
            onGoogleSignIn={() => void handleGoogleSignIn(false)}
          />
        )}

        {activeSection === 'analytics' && (
          <AnalyticsAndTemplatesView
            isAuthenticated={isAuthenticatedWithGoogle}
            hasYouTubeToken={Boolean(youtubeAccessToken)}
            clips={store.clips}
            onConnectYouTube={() => void handleGoogleSignIn(true)}
            onApplyTemplateToActiveClip={async (tpl: StudioTemplate) => {
              if (!activeClip) return;
              const merged: ClipOverlayStyle = {
                ...DEFAULT_CLIP_OVERLAY_STYLE,
                ...(activeClip.overlayStyle ?? {}),
                ...(tpl.config as Partial<ClipOverlayStyle>),
              };
              await handleUpdateClip(activeClip.id, { overlayStyle: merged });
              setActiveSection('studio');
            }}
          />
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
            onScheduleClip={handleScheduleClip}
            onDeleteClip={handleDeleteClip}
          />
        )}

        {activeSection === 'automation' && (
          <AutomationSettingsView
            config={store.automation}
            isAuthenticated={isAuthenticatedWithGoogle}
            canManageCookies={isAdmin}
            onSaveConfig={handleSaveAutomation}
            onResetDemo={handleResetDemo}
          />
        )}

        {activeSection === 'admin' && isAdmin && (
          <AdminControlCenterView currentUserRole={userRole} />
        )}
      </main>

      {activeEpisode && activeClip && (
        <>
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
          <YouTubeDirectUploadModal
            isOpen={isYouTubeUploadModalOpen}
            clip={activeClip}
            episode={activeEpisode}
            defaultVisibility={store.automation.youtubeDefaultVisibility}
            accountEmail={youtubeUser?.email ?? null}
            accountName={youtubeUser?.displayName ?? null}
            isUploading={isUploadingYouTube}
            uploadError={youTubeUploadError}
            onClose={() => {
              if (!isUploadingYouTube) setIsYouTubeUploadModalOpen(false);
            }}
            onRequestRenderFirst={() => {
              document.getElementById('render-layout-select')?.scrollIntoView({
                behavior: 'smooth',
                block: 'center',
              });
            }}
            onConfirmUpload={handleConfirmYouTubeDirectUpload}
          />
        </>
      )}
    </div>
  );
}
