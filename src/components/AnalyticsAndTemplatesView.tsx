import { useEffect, useState, type FormEvent } from 'react';
import {
  BarChart3,
  Bookmark,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Youtube,
} from 'lucide-react';
import type {
  AnalyticsOverviewData,
  GrowthRecommendation,
  PodcastClip,
  StudioTemplate,
  StudioTemplateCategory,
} from '../types/clipper';
import { apiFetch } from '../utils/apiClient';
import { PLATFORM_LABELS } from '../utils/youtube';

interface AnalyticsAndTemplatesViewProps {
  isAuthenticated: boolean;
  hasYouTubeToken: boolean;
  clips: PodcastClip[];
  onConnectYouTube: () => void;
  onApplyTemplateToActiveClip?: (template: StudioTemplate) => Promise<void>;
}

const CATEGORY_LABELS: Record<StudioTemplateCategory, string> = {
  subtitle: 'Subtitle',
  intro: 'Intro AI',
  thumbnail: 'Thumbnail',
  export: 'Export FFmpeg',
};

export function AnalyticsAndTemplatesView({
  isAuthenticated,
  hasYouTubeToken,
  clips,
  onConnectYouTube,
  onApplyTemplateToActiveClip,
}: AnalyticsAndTemplatesViewProps) {
  const [subTab, setSubTab] = useState<'analytics' | 'templates'>('analytics');
  const [overview, setOverview] = useState<AnalyticsOverviewData | null>(null);
  const [loadingAnalytics, setLoadingAnalytics] = useState(false);
  const [isSyncingYoutube, setIsSyncingYoutube] = useState(false);
  const [recommendations, setRecommendations] = useState<GrowthRecommendation[]>([]);
  const [isGeneratingGrowth, setIsGeneratingGrowth] = useState(false);
  const [analyticsMsg, setAnalyticsMsg] = useState<string | null>(null);
  const [analyticsErr, setAnalyticsErr] = useState<string | null>(null);

  // Templates state
  const [templates, setTemplates] = useState<StudioTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [tplName, setTplName] = useState('');
  const [tplCategory, setTplCategory] = useState<StudioTemplateCategory>('subtitle');
  const [tplDesc, setTplDesc] = useState('');
  const [isCreatingTpl, setIsCreatingTpl] = useState(false);
  const [tplMsg, setTplMsg] = useState<string | null>(null);

  const loadAnalytics = async () => {
    if (!isAuthenticated) return;
    setLoadingAnalytics(true);
    setAnalyticsErr(null);
    try {
      const res = await apiFetch('/api/v2/analytics/overview');
      if (!res.ok) throw new Error('Gagal memuat data analitik.');
      const data = (await res.json()) as { overview: AnalyticsOverviewData };
      setOverview(data.overview);
    } catch (err) {
      setAnalyticsErr(err instanceof Error ? err.message : 'Gagal memuat analitik.');
    } finally {
      setLoadingAnalytics(false);
    }
  };

  const loadTemplates = async () => {
    if (!isAuthenticated) return;
    setLoadingTemplates(true);
    try {
      const res = await apiFetch('/api/v2/templates');
      if (!res.ok) return;
      const data = (await res.json()) as { templates: StudioTemplate[] };
      setTemplates(data.templates ?? []);
    } finally {
      setLoadingTemplates(false);
    }
  };

  useEffect(() => {
    void loadAnalytics();
    void loadTemplates();
  }, [isAuthenticated]);

  const handleSyncYouTubeStats = async () => {
    if (!isAuthenticated) return;
    setIsSyncingYoutube(true);
    setAnalyticsErr(null);
    setAnalyticsMsg(null);
    try {
      // Read YouTube OAuth token from in-memory helper via window event/storage if available
      const { getYouTubeAccessToken } = await import('../utils/youtubeAuth');
      const token = getYouTubeAccessToken();
      if (!token) {
        onConnectYouTube();
        setAnalyticsErr(
          'Izin OAuth YouTube diperlukan untuk menarik statistik real dari YouTube Data API v3.'
        );
        return;
      }
      const res = await apiFetch('/api/v2/analytics/sync-youtube', {
        method: 'POST',
        headers: { 'X-YouTube-Access-Token': token },
      });
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
        overview?: AnalyticsOverviewData;
      };
      if (!res.ok) {
        setAnalyticsErr(data.error || 'Gagal menyinkronkan statistik YouTube.');
        return;
      }
      if (data.overview) setOverview(data.overview);
      setAnalyticsMsg(data.message || 'Sinkronisasi statistik YouTube selesai.');
    } finally {
      setIsSyncingYoutube(false);
    }
  };

  const handleGenerateGrowth = async () => {
    if (!isAuthenticated) return;
    setIsGeneratingGrowth(true);
    setAnalyticsErr(null);
    try {
      const res = await apiFetch('/api/v2/analytics/growth-recommendations', {
        method: 'POST',
      });
      const data = (await res.json().catch(() => ({}))) as {
        recommendations?: GrowthRecommendation[];
        error?: string;
      };
      if (!res.ok) {
        setAnalyticsErr(data.error || 'Gagal membuat rekomendasi pertumbuhan AI.');
        return;
      }
      setRecommendations(data.recommendations ?? []);
      setAnalyticsMsg('Rekomendasi AI disusun berdasarkan data aktual proyek Anda.');
    } finally {
      setIsGeneratingGrowth(false);
    }
  };

  const handleCreateTemplate = async (e: FormEvent) => {
    e.preventDefault();
    if (!tplName.trim() || !isAuthenticated) return;
    setIsCreatingTpl(true);
    setTplMsg(null);
    try {
      const res = await apiFetch('/api/v2/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: tplName.trim(),
          category: tplCategory,
          description: tplDesc.trim(),
          isPublic: false,
          config:
            tplCategory === 'subtitle'
              ? {
                  fontFamily: 'condensed_viral',
                  subtitleHighlightColor: '#FACC15',
                  subtitleBoxStyle: 'outline',
                }
              : { createdFrom: 'template_library' },
        }),
      });
      if (res.ok) {
        setTplName('');
        setTplDesc('');
        setTplMsg('Template baru berhasil disimpan ke pustaka.');
        void loadTemplates();
      }
    } finally {
      setIsCreatingTpl(false);
    }
  };

  const handleDeleteTemplate = async (id: string) => {
    const res = await apiFetch(`/api/v2/templates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      setTemplates((prev) => prev.filter((t) => t.id !== id));
      setTplMsg('Template berhasil dihapus.');
    }
  };

  // Fallback local stats strictly computed from actual loaded clips in preview mode (zero fake views)
  const localPublished = clips.filter(
    (c) => c.status === 'published_auto' || c.status === 'published_manual'
  ).length;
  const localRendered = clips.filter((c) => Boolean(c.renderedClipUrl)).length;
  const localScores = clips
    .map((c) => c.qualityScores?.overallScore ?? c.viralScore)
    .filter((n): n is number => typeof n === 'number');
  const localAvgScore =
    localScores.length > 0
      ? Math.round((localScores.reduce((a, b) => a + b, 0) / localScores.length) * 10) / 10
      : null;

  const totals = overview?.totals ?? {
    episodes: new Set(clips.map((c) => c.episodeId)).size,
    clips: clips.length,
    renderedClips: localRendered,
    publishedClips: localPublished,
    scheduledClips: clips.filter((c) => c.status === 'scheduled').length,
    youtubeUploadedClips: clips.filter((c) => Boolean(c.youtubeVideoId)).length,
    totalRendersCompleted: localRendered,
    totalRendersFailed: 0,
    avgQualityScore: localAvgScore,
    youtubeViews: null,
    youtubeLikes: null,
    youtubeComments: null,
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
            Analitik Konten & Pustaka Template
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Seluruh metrik berasal langsung dari database proyek Anda dan YouTube Data API v3 saat disinkronkan — tanpa angka simulasi.
          </p>
        </div>

        <div
          role="tablist"
          aria-label="Sub-halaman Analitik dan Template"
          className="inline-flex bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-1 self-start"
        >
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'analytics'}
            onClick={() => setSubTab('analytics')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md cursor-pointer ${
              subTab === 'analytics'
                ? 'bg-slate-900 dark:bg-red-600 text-white'
                : 'text-slate-600 dark:text-slate-300'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Analitik & AI Growth</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'templates'}
            onClick={() => setSubTab('templates')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md cursor-pointer ${
              subTab === 'templates'
                ? 'bg-slate-900 dark:bg-red-600 text-white'
                : 'text-slate-600 dark:text-slate-300'
            }`}
          >
            <Bookmark className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Pustaka Template ({templates.length})</span>
          </button>
        </div>
      </div>

      {subTab === 'analytics' && (
        <div className="space-y-6">
          {/* Source Banner & Actions */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-slate-600 dark:text-slate-400">
              Sumber data: <span className="font-semibold text-slate-900 dark:text-white">Database Internal Real</span>
              {' · '}
              YouTube Data API v3:{' '}
              <span className="font-semibold text-slate-900 dark:text-white">
                {overview?.sourceSummary.lastYoutubeSyncAt
                  ? `Tersinkron ${new Date(overview.sourceSummary.lastYoutubeSyncAt).toLocaleString('id-ID')}`
                  : 'Belum disinkronkan'}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!isAuthenticated || isSyncingYoutube}
                onClick={() => void handleSyncYouTubeStats()}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer disabled:opacity-70 disabled:cursor-not-allowed"
              >
                {isSyncingYoutube ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Youtube className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                <span>{hasYouTubeToken ? 'Sinkronkan Statistik YouTube' : 'Hubungkan & Sinkronkan YouTube'}</span>
              </button>

              <button
                type="button"
                disabled={!isAuthenticated || isGeneratingGrowth}
                onClick={() => void handleGenerateGrowth()}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg cursor-pointer disabled:opacity-70 disabled:cursor-not-allowed"
              >
                {isGeneratingGrowth ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5 text-red-500" aria-hidden="true" />
                )}
                <span>Minta Rekomendasi AI Growth</span>
              </button>

              <button
                type="button"
                disabled={loadingAnalytics}
                onClick={() => void loadAnalytics()}
                aria-label="Muat ulang analitik"
                className="p-2 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-lg cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingAnalytics ? 'animate-spin' : ''}`} aria-hidden="true" />
              </button>
            </div>
          </div>

          {analyticsMsg && (
            <p role="status" className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
              {analyticsMsg}
            </p>
          )}
          {analyticsErr && (
            <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
              {analyticsErr}
            </p>
          )}

          {/* KPI Strip — 100% Real DB / YouTube API Metrics */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">Total Klip & Render</div>
              <div className="font-display text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-1">
                {totals.clips}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                {totals.renderedClips} ter-render · {totals.publishedClips} dipublikasikan
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">Rata-rata Skor Kualitas AI</div>
              <div className="font-display text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-1">
                {totals.avgQualityScore !== null ? `${totals.avgQualityScore}/100` : '—'}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                Model 7 dimensi (hook, emosi, info)
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">Views YouTube (API v3)</div>
              <div className="font-display text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-1">
                {totals.youtubeViews !== null ? totals.youtubeViews.toLocaleString('id-ID') : 'Belum Sinkron'}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                {totals.youtubeUploadedClips} klip memiliki YouTube Video ID
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">Likes & Komentar YouTube</div>
              <div className="font-display text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-1">
                {totals.youtubeLikes !== null
                  ? `${totals.youtubeLikes.toLocaleString('id-ID')} / ${(totals.youtubeComments ?? 0).toLocaleString('id-ID')}`
                  : '—'}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                TikTok/IG/FB memerlukan izin API resmi terpisah
              </div>
            </div>
          </div>

          {/* Breakdown Tables */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
              <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                Distribusi Pendekatan Klip & Skor Kualitas
              </h2>
              {overview && overview.byApproach.length > 0 ? (
                <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                  {overview.byApproach.map((row) => (
                    <div key={row.approach} className="py-2.5 flex items-center justify-between gap-2">
                      <span className="font-medium capitalize text-slate-800 dark:text-slate-200">
                        {row.approach}
                      </span>
                      <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">
                        {row.clipCount} klip · skor {row.avgScore ?? '—'} · {row.publishedCount} publish
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-500">
                  Analisis episode baru dengan pendekatan Edukatif/Storytelling/Hiburan untuk melihat perbandingan skor di sini.
                </p>
              )}
            </section>

            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
              <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                Distribusi Publikasi per Platform
              </h2>
              <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {(overview?.byPlatform ?? []).map((row) => (
                  <div key={row.platform} className="py-2 flex items-center justify-between">
                    <span className="text-slate-700 dark:text-slate-300">
                      {PLATFORM_LABELS[row.platform]}
                    </span>
                    <span className="font-mono tabular-nums font-semibold text-slate-900 dark:text-white">
                      {row.publishedCount} klip
                    </span>
                  </div>
                ))}
                {!overview && (
                  <p className="text-xs text-slate-500 py-2">
                    Masuk dengan Google untuk memuat agregasi publikasi real per platform.
                  </p>
                )}
              </div>
            </section>
          </div>

          {/* Grounded AI Growth Recommendations */}
          {recommendations.length > 0 && (
            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
                Rekomendasi Pertumbuhan AI (Berbasis Metrik Real)
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {recommendations.map((rec, idx) => (
                  <div
                    key={idx}
                    className="p-4 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-slate-900 dark:text-white">
                        {rec.title}
                      </span>
                      <span className="text-[11px] font-mono uppercase text-red-600 dark:text-red-400">
                        {rec.priority}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-300">{rec.rationale}</p>
                    <p className="text-xs font-medium text-slate-900 dark:text-white">
                      Langkah: {rec.actionStep}
                    </p>
                    <p className="text-[11px] font-mono text-slate-500">
                      Dasar data: {rec.basedOnMetric}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {subTab === 'templates' && (
        <div className="grid grid-cols-1 lg:grid-cols-[340px_minmax(0,1fr)] gap-6 items-start">
          {/* Create Template Form */}
          <form
            onSubmit={handleCreateTemplate}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3.5"
          >
            <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white">
              Buat Template Baru
            </h2>
            <div>
              <label htmlFor="tpl-name" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Nama Template
              </label>
              <input
                id="tpl-name"
                type="text"
                value={tplName}
                onChange={(e) => setTplName(e.target.value)}
                placeholder="Contoh: Subtitle Podcast Bold Kuning"
                className="w-full h-9 px-3 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"
              />
            </div>
            <div>
              <label htmlFor="tpl-cat" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Kategori
              </label>
              <select
                id="tpl-cat"
                value={tplCategory}
                onChange={(e) => setTplCategory(e.target.value as StudioTemplateCategory)}
                className="w-full h-9 px-3 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"
              >
                <option value="subtitle">Subtitle Style</option>
                <option value="intro">Intro Card AI</option>
                <option value="thumbnail">Thumbnail Layout</option>
                <option value="export">Preset Export FFmpeg</option>
              </select>
            </div>
            <div>
              <label htmlFor="tpl-desc" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Catatan / Kegunaan
              </label>
              <textarea
                id="tpl-desc"
                rows={2}
                value={tplDesc}
                onChange={(e) => setTplDesc(e.target.value)}
                placeholder="Cocok untuk klip edukasi YouTube Shorts 9:16..."
                className="w-full p-2.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"
              />
            </div>
            <button
              type="submit"
              disabled={!isAuthenticated || isCreatingTpl || !tplName.trim()}
              className="w-full inline-flex items-center justify-center gap-1.5 h-9 text-xs font-semibold text-white bg-slate-900 dark:bg-red-600 hover:bg-slate-800 rounded-lg cursor-pointer disabled:opacity-50"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{isCreatingTpl ? 'Menyimpan...' : 'Simpan ke Pustaka'}</span>
            </button>
            {tplMsg && (
              <p role="status" className="text-xs text-emerald-700 dark:text-emerald-400">
                {tplMsg}
              </p>
            )}
          </form>

          {/* Templates List */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                Daftar Template Tersimpan
              </h2>
              {loadingTemplates && <span className="text-xs text-slate-500">Memuat...</span>}
            </div>
            {templates.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400 py-6 text-center">
                Belum ada template tersimpan. Simpan preset dari Smart Video Editor, Thumbnail Studio, atau formulir di samping.
              </p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {templates.map((tpl) => (
                  <div key={tpl.id} className="py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                        {tpl.name}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {CATEGORY_LABELS[tpl.category]} · {tpl.description || 'Preset kustom'}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {onApplyTemplateToActiveClip && tpl.category === 'subtitle' && (
                        <button
                          type="button"
                          onClick={() => void onApplyTemplateToActiveClip(tpl)}
                          className="px-2.5 py-1 text-xs font-semibold text-slate-800 dark:text-slate-100 bg-slate-100 dark:bg-slate-800 rounded-md cursor-pointer"
                        >
                          Terapkan
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={`Hapus template ${tpl.name}`}
                        onClick={() => void handleDeleteTemplate(tpl.id)}
                        className="p-1.5 text-slate-500 hover:text-red-600 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
