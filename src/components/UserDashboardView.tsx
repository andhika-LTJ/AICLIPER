import { useEffect, useState, type FormEvent } from 'react';
import {
  CheckCircle2,
  Circle,
  Download,
  Film,
  FolderKanban,
  Gauge,
  Scissors,
  Sparkles,
  Trash2,
  UserCircle2,
  Youtube,
} from 'lucide-react';
import type {
  BillingRecord,
  PaymentProviderStatus,
  PersistedRenderJobSummary,
  PlanCatalogItem,
  PodcastClip,
  PodcastEpisode,
  QuotaSummary,
  ThemePreset,
  UserProfileData,
  WorkspaceRecord,
} from '../types/clipper';
import { formatTimestamp } from '../utils/youtube';
import { apiFetch } from '../utils/apiClient';

interface DashboardResponsePayload {
  profile: UserProfileData;
  quota: QuotaSummary;
  unreadNotificationsCount: number;
  summary: {
    totalEpisodes: number;
    totalClips: number;
    publishedClips: number;
    scheduledClips: number;
    renderedClips: number;
  };
  recentRenderJobs: PersistedRenderJobSummary[];
  recentUploadJobs: Array<{
    id: string;
    clipId: string;
    platform: string;
    status: string;
    remoteUrl: string | null;
    errorMessage: string | null;
    createdAt: string;
  }>;
}

interface UserDashboardViewProps {
  isAuthenticated: boolean;
  episodes: PodcastEpisode[];
  clips: PodcastClip[];
  userDisplayName: string | null;
  userEmail: string | null;
  userRole: string;
  themePreset: ThemePreset;
  onThemePresetChange: (next: ThemePreset) => void;
  onJumpToClip: (episodeId: string, clipId: string) => void;
  onOpenStudio: () => void;
  onOpenAiStudio: () => void;
  onGoogleSignIn: () => void;
  onDataDeleted: () => Promise<void>;
}

const DEMO_QUOTA: QuotaSummary = {
  planTier: 'free',
  periodYm: new Date().toISOString().slice(0, 7),
  aiAnalysesUsed: 2,
  monthlyAiLimit: 25,
  rendersUsed: 1,
  monthlyRenderLimit: 15,
  uploadsUsed: 0,
  monthlyUploadLimit: 15,
  storageBytesUsed: 0,
  maxStorageMb: 1024,
  maxVideoDurationSec: 3600,
  maxExportQuality: '1080p',
  maxProjects: 15,
  projectsUsed: 1,
};

function QuotaBar({
  label,
  used,
  limit,
  unit = '',
}: {
  label: string;
  used: number;
  limit: number;
  unit?: string;
}) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const isHigh = pct >= 80;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-slate-700 dark:text-slate-300">{label}</span>
        <span
          className={`font-mono tabular-nums font-semibold ${
            isHigh ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-white'
          }`}
        >
          {used}
          {unit} / {limit}
          {unit} ({pct}%)
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            isHigh ? 'bg-red-600' : 'bg-slate-900 dark:bg-red-500'
          }`}
          style={{ width: `${Math.max(pct, used > 0 ? 4 : 0)}%` }}
        />
      </div>
    </div>
  );
}

export function UserDashboardView({
  isAuthenticated,
  episodes,
  clips,
  userDisplayName,
  userEmail,
  userRole,
  themePreset,
  onThemePresetChange,
  onJumpToClip,
  onOpenStudio,
  onOpenAiStudio,
  onGoogleSignIn,
  onDataDeleted,
}: UserDashboardViewProps) {
  const [dashboard, setDashboard] = useState<DashboardResponsePayload | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [billingSummary, setBillingSummary] = useState<{
    plans: PlanCatalogItem[];
    paymentProvider: PaymentProviderStatus;
    billingRecords: BillingRecord[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [displayNameInput, setDisplayNameInput] = useState(userDisplayName ?? '');
  const [niche, setNiche] = useState('');
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [isConfirmDeleteOpen, setIsConfirmDeleteOpen] = useState(false);
  const [isDeletingData, setIsDeletingData] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) {
      setDashboard(null);
      setWorkspaces([]);
      setBillingSummary(null);
      return;
    }
    let active = true;
    setLoading(true);
    Promise.all([
      apiFetch('/api/dashboard').then((res) => (res.ok ? res.json() : null)),
      apiFetch('/api/v2/workspaces').then((res) => (res.ok ? res.json() : null)),
      apiFetch('/api/v2/billing/summary').then((res) => (res.ok ? res.json() : null)),
    ])
      .then(([data, wsData, billData]) => {
        if (!active) return;
        if (data) {
          const typed = data as DashboardResponsePayload;
          setDashboard(typed);
          setDisplayNameInput(typed.profile.displayName ?? userDisplayName ?? '');
          setNiche(typed.profile.creatorNiche ?? '');
        }
        if (wsData?.workspaces) setWorkspaces(wsData.workspaces as WorkspaceRecord[]);
        if (billData?.plans) {
          setBillingSummary({
            plans: billData.plans as PlanCatalogItem[],
            paymentProvider: billData.paymentProvider as PaymentProviderStatus,
            billingRecords: (billData.billingRecords ?? []) as BillingRecord[],
          });
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isAuthenticated, episodes.length, clips.length, userDisplayName]);

  const quota = dashboard?.quota ?? DEMO_QUOTA;
  const renderedCount =
    dashboard?.summary.renderedClips ?? clips.filter((c) => Boolean(c.renderedClipUrl)).length;
  const publishedCount =
    dashboard?.summary.publishedClips ??
    clips.filter((c) => c.publishedPlatforms.length > 0).length;

  const onboardingSteps = [
    {
      label: 'Masuk dengan akun Google terverifikasi',
      done: isAuthenticated,
    },
    {
      label: 'Analisis minimal 1 episode podcast YouTube',
      done: episodes.length > 0,
    },
    {
      label: 'Render klip MP4 HD/4K dengan subtitle akurat',
      done: renderedCount > 0,
    },
    {
      label: 'Publikasikan atau jadwalkan klip ke platform sosial',
      done: publishedCount > 0 || clips.some((c) => Boolean(c.scheduledFor)),
    },
  ];
  const completedSteps = onboardingSteps.filter((s) => s.done).length;

  const handleSaveProfile = async (e: FormEvent) => {
    e.preventDefault();
    if (!isAuthenticated) {
      setProfileMsg('Silakan login dengan Google terlebih dahulu untuk menyimpan profil cloud.');
      return;
    }
    setIsSavingProfile(true);
    setProfileMsg(null);
    try {
      const isDarkPreset = themePreset === 'dark_studio' || themePreset === 'creator_neon';
      const res = await apiFetch('/api/me/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: displayNameInput.trim() || undefined,
          creatorNiche: niche.trim(),
          themePreference: isDarkPreset ? 'dark' : 'light',
          themePreset,
          onboardingCompleted: completedSteps >= 3,
        }),
      });
      if (res.ok) {
        setProfileMsg('Profil kreator & preferensi 4-tema tersimpan di database.');
      } else {
        setProfileMsg('Gagal menyimpan profil kreator.');
      }
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleExportJson = async () => {
    if (!isAuthenticated) {
      const blob = new Blob([JSON.stringify({ episodes, clips }, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'klipcast-demo-export.json';
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    const res = await apiFetch('/api/me/export');
    if (!res.ok) return;
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `klipcast-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setActionMsg('Ekspor data pribadi (.JSON) berhasil diunduh.');
  };

  const handleConfirmDeleteAllData = async () => {
    if (!isAuthenticated) return;
    setIsDeletingData(true);
    setActionMsg(null);
    try {
      const res = await apiFetch('/api/me/data', { method: 'DELETE' });
      if (res.ok) {
        setIsConfirmDeleteOpen(false);
        await onDataDeleted();
        setActionMsg('Seluruh episode, klip, dan riwayat konten milik akun Anda telah dihapus.');
      }
    } finally {
      setIsDeletingData(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-red-600">
            Workspace Kreator · Paket {quota.planTier.toUpperCase()}
          </p>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white mt-0.5">
            Selamat datang{userDisplayName ? `, ${userDisplayName}` : ' di KlipCast'}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Ringkasan proyek podcast, status render MP4, kuota bulanan, dan akses cepat ke AI Studio.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={onOpenStudio}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer"
          >
            <Scissors className="w-4 h-4" aria-hidden="true" />
            <span>Buka Studio Klip</span>
          </button>
          <button
            type="button"
            onClick={onOpenAiStudio}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-semibold text-slate-900 dark:text-white bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg cursor-pointer"
          >
            <Sparkles className="w-4 h-4 text-red-600" aria-hidden="true" />
            <span>AI Content Studio</span>
          </button>
        </div>
      </div>

      {!isAuthenticated && (
        <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs sm:text-sm text-amber-950 dark:text-amber-100">
            Anda sedang melihat <strong>Mode Pratinjau</strong>. Masuk dengan akun Google untuk menyimpan proyek terisolasi per akun, menjalankan analisis AI, dan merender video MP4.
          </p>
          <button
            type="button"
            onClick={onGoogleSignIn}
            className="px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer shrink-0"
          >
            Masuk dengan Google
          </button>
        </div>
      )}

      {/* KPI Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          {
            label: 'Total Episode Podcast',
            value: dashboard?.summary.totalEpisodes ?? episodes.length,
            sub: `${dashboard?.summary.totalClips ?? clips.length} segmen klip terdeteksi`,
            icon: FolderKanban,
          },
          {
            label: 'Klip MP4 Siap Upload',
            value: renderedCount,
            sub: 'Full HD 1080p / Ultra HD 4K',
            icon: Film,
          },
          {
            label: 'Klip Terpublikasi',
            value: publishedCount,
            sub: `${dashboard?.summary.scheduledClips ?? clips.filter((c) => c.scheduledFor).length} terjadwal di kalender`,
            icon: Youtube,
          },
          {
            label: 'Analisis AI Bulan Ini',
            value: quota.aiAnalysesUsed,
            sub: `Batas paket ${quota.planTier.toUpperCase()}: ${quota.monthlyAiLimit}x/bulan`,
            icon: Sparkles,
          },
        ].map((kpi) => {
          const Icon = kpi.icon;
          return (
            <div
              key={kpi.label}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-2"
            >
              <div className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
                <span>{kpi.label}</span>
                <Icon className="w-4 h-4 text-red-600" aria-hidden="true" />
              </div>
              <div className="font-display text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white font-mono tabular-nums">
                {kpi.value}
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">{kpi.sub}</p>
            </div>
          );
        })}
      </div>

      {/* Quota + Onboarding Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Gauge className="w-4 h-4 text-red-600" aria-hidden="true" />
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
                Penggunaan Kuota Bulanan ({quota.periodYm})
              </h2>
            </div>
            <span className="px-2.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-xs font-bold uppercase text-slate-800 dark:text-slate-200">
              Paket {quota.planTier}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <QuotaBar
              label="Permintaan AI (Analisis & Studio)"
              used={quota.aiAnalysesUsed}
              limit={quota.monthlyAiLimit}
            />
            <QuotaBar
              label="Render Video MP4 (FFmpeg)"
              used={quota.rendersUsed}
              limit={quota.monthlyRenderLimit}
            />
            <QuotaBar
              label="Upload Video / YouTube"
              used={quota.uploadsUsed}
              limit={quota.monthlyUploadLimit}
            />
            <QuotaBar
              label="Proyek Episode Aktif"
              used={quota.projectsUsed}
              limit={quota.maxProjects}
            />
          </div>

          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed pt-1">
            Batas penyimpanan paket Anda: <strong className="text-slate-800 dark:text-slate-200">{quota.maxStorageMb} MB</strong> · Durasi video maksimal:{' '}
            <strong className="text-slate-800 dark:text-slate-200">{Math.round(quota.maxVideoDurationSec / 60)} menit</strong> · Kualitas ekspor hingga{' '}
            <strong className="text-slate-800 dark:text-slate-200">{quota.maxExportQuality.toUpperCase()}</strong>. Hubungi Super Admin untuk peningkatan paket (Starter / Pro / Business).
          </p>
        </section>

        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
              Alur Mulai Cepat
            </h2>
            <span className="text-xs font-mono tabular-nums font-semibold text-red-600">
              {completedSteps}/{onboardingSteps.length}
            </span>
          </div>
          <ul className="space-y-2.5">
            {onboardingSteps.map((step) => (
              <li key={step.label} className="flex items-start gap-2.5 text-xs">
                {step.done ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" aria-hidden="true" />
                ) : (
                  <Circle className="w-4 h-4 text-slate-300 dark:text-slate-600 shrink-0 mt-0.5" aria-hidden="true" />
                )}
                <span
                  className={
                    step.done
                      ? 'text-slate-900 dark:text-slate-100 font-medium'
                      : 'text-slate-500 dark:text-slate-400'
                  }
                >
                  {step.label}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* Recent Clips + Render History */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 space-y-4">
          <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
            Klip Terbaru Anda
          </h2>
          {clips.length === 0 ? (
            <p className="text-xs text-slate-500">Belum ada klip. Mulai analisis link YouTube di Studio Klip.</p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {clips.slice(0, 5).map((clip) => (
                <div key={clip.id} className="py-2.5 first:pt-0 last:pb-0 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={() => onJumpToClip(clip.episodeId, clip.id)}
                      className="text-left text-xs sm:text-sm font-semibold text-slate-900 dark:text-white hover:text-red-600 truncate block max-w-full cursor-pointer"
                    >
                      {clip.title}
                    </button>
                    <p className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                      {formatTimestamp(clip.startSec)}–{formatTimestamp(clip.endSec)} · Kualitas{' '}
                      {clip.viralScore ?? 85}/100
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onJumpToClip(clip.episodeId, clip.id)}
                    className="text-xs font-semibold text-red-600 hover:underline shrink-0 cursor-pointer"
                  >
                    Kelola
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 space-y-4">
          <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
            Riwayat Render MP4 Server
          </h2>
          {loading ? (
            <p className="text-xs text-slate-500">Memuat riwayat render dari database...</p>
          ) : !dashboard || dashboard.recentRenderJobs.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Belum ada job render MP4 tersimpan. Render klip di Studio untuk melihat progres dan arsip file MP4.
            </p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {dashboard.recentRenderJobs.slice(0, 5).map((job) => (
                <div key={job.jobId} className="py-2.5 first:pt-0 last:pb-0 flex items-center justify-between gap-2 text-xs">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900 dark:text-white truncate">
                      {job.layout} · {job.quality.toUpperCase()}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                      {job.error || job.stage}
                    </div>
                  </div>
                  <span
                    className={`px-2 py-0.5 rounded font-semibold shrink-0 ${
                      job.status === 'completed'
                        ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300'
                        : job.status === 'failed'
                          ? 'bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-300'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    {job.status} ({job.progress}%)
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Creator Profile & Privacy Controls */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <UserCircle2 className="w-4 h-4 text-red-600" aria-hidden="true" />
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
              Profil Kreator, Tema & Privasi Data
            </h2>
          </div>
          <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
            {userEmail || 'Mode Demo'} · Role: {userRole}
          </span>
        </div>

        <form onSubmit={handleSaveProfile} className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label htmlFor="profile-channel" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Nama Tampilan / Kanal Podcast
            </label>
            <input
              id="profile-channel"
              type="text"
              value={displayNameInput}
              onChange={(e) => setDisplayNameInput(e.target.value)}
              placeholder="Contoh: Podcast Teknologi Nusantara"
              className="w-full h-10 px-3 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg focus:border-red-600 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="profile-niche" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Niche Konten
            </label>
            <input
              id="profile-niche"
              type="text"
              value={niche}
              onChange={(e) => setNiche(e.target.value)}
              placeholder="Bisnis, Edukasi, Teknologi, Komedi..."
              className="w-full h-10 px-3 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg focus:border-red-600 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="profile-theme" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Sistem 4 Tema Tampilan
            </label>
            <select
              id="profile-theme"
              value={themePreset}
              onChange={(e) => onThemePresetChange(e.target.value as ThemePreset)}
              className="w-full h-10 px-3 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg focus:border-red-600 focus:outline-none"
            >
              <option value="minimal_light">Minimal Light (Terang Bersih)</option>
              <option value="dark_studio">Dark Studio (Gelap Broadcast)</option>
              <option value="creator_neon">Creator Neon (Gelap Aksen Ungu)</option>
              <option value="professional">Professional (Editorial Biru Korporat)</option>
            </select>
          </div>
          <div className="md:col-span-3 flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100 dark:border-slate-800">
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => void handleExportJson()}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Ekspor Data Pribadi (.JSON)</span>
              </button>
              {isAuthenticated && (
                <button
                  type="button"
                  onClick={() => setIsConfirmDeleteOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 hover:bg-red-100 rounded-lg cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Hapus Semua Data Konten Saya</span>
                </button>
              )}
            </div>
            <div className="flex items-center gap-3">
              {profileMsg && (
                <span role="status" className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                  {profileMsg}
                </span>
              )}
              <button
                type="submit"
                disabled={isSavingProfile}
                className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 dark:bg-red-600 hover:bg-slate-800 dark:hover:bg-red-700 rounded-lg cursor-pointer disabled:opacity-60"
              >
                {isSavingProfile ? 'Menyimpan...' : 'Simpan Profil'}
              </button>
            </div>
          </div>
        </form>

        {actionMsg && (
          <p role="status" className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
            {actionMsg}
          </p>
        )}

        {isConfirmDeleteOpen && (
          <div
            role="alertdialog"
            aria-label="Konfirmasi hapus data akun"
            className="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 flex flex-wrap items-center justify-between gap-3"
          >
            <p className="text-xs text-red-900 dark:text-red-100 max-w-xl">
              Konfirmasi: Tindakan ini akan menghapus seluruh episode, klip, dan riwayat konten milik akun Anda secara permanen dari workspace Anda.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsConfirmDeleteOpen(false)}
                className="px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={isDeletingData}
                onClick={() => void handleConfirmDeleteAllData()}
                className="px-3 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer disabled:opacity-60"
              >
                {isDeletingData ? 'Menghapus...' : 'Ya, Hapus Data Saya'}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Workspaces & Subscription Plan Catalog (Honest Billing Status) */}
      {(workspaces.length > 0 || billingSummary) && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
                Workspace & Paket Langganan ({quota.planTier.toUpperCase()})
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                {workspaces.length} workspace aktif ·{' '}
                {billingSummary?.paymentProvider.message ??
                  'Status billing & katalog paket tersinkron dari konfigurasi sistem.'}
              </p>
            </div>
          </div>

          {billingSummary && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {billingSummary.plans.map((plan) => {
                const isCurrent = plan.tier === quota.planTier;
                return (
                  <div
                    key={plan.tier}
                    className={`p-4 rounded-xl border space-y-2 ${
                      isCurrent
                        ? 'border-red-600 bg-red-50/40 dark:bg-red-950/20'
                        : 'border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-display text-sm font-bold text-slate-900 dark:text-white">
                        {plan.label}
                      </span>
                      {isCurrent && (
                        <span className="text-[11px] font-semibold text-red-600 dark:text-red-400">
                          Paket Aktif
                        </span>
                      )}
                    </div>
                    <div className="font-mono tabular-nums text-lg font-bold text-slate-900 dark:text-white">
                      {plan.monthlyPriceIdr === 0
                        ? 'Gratis'
                        : `Rp ${plan.monthlyPriceIdr.toLocaleString('id-ID')}/bln`}
                    </div>
                    <ul className="space-y-1 text-[11px] text-slate-600 dark:text-slate-400">
                      {plan.highlights.slice(0, 3).map((item, idx) => (
                        <li key={idx}>• {item}</li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
