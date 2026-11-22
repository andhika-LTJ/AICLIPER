import { useState } from 'react';
import { CalendarClock, CheckCircle2, Info, Search, Send, Trash2 } from 'lucide-react';
import type {
  DistributionLog,
  PodcastClip,
  PodcastEpisode,
  SocialPlatform,
} from '../types/clipper';
import { formatTimestamp, PLATFORM_LABELS } from '../utils/youtube';

interface DistributionQueueViewProps {
  episodes: PodcastEpisode[];
  clips: PodcastClip[];
  logs: DistributionLog[];
  defaultPlatforms: SocialPlatform[];
  onJumpToClip: (episodeId: string, clipId: string) => void;
  onAutoPostClip: (clipId: string, platforms: SocialPlatform[]) => Promise<void>;
  onScheduleClip?: (
    clipId: string,
    scheduledAt: string | null,
    platforms: SocialPlatform[]
  ) => Promise<void>;
  onDeleteClip: (clipId: string) => Promise<void>;
}

type StatusFilter = 'all' | 'draft' | 'scheduled' | 'published_auto' | 'published_manual';

const STATUS_DISPLAY: Record<PodcastClip['status'], { label: string; className: string }> = {
  draft: { label: 'Siap Tinjau', className: 'text-slate-600 dark:text-slate-300' },
  queued: { label: 'Dalam Antrean', className: 'text-amber-700 dark:text-amber-400' },
  scheduled: { label: 'Terjadwal', className: 'text-blue-700 dark:text-blue-400 font-semibold' },
  published_auto: {
    label: 'Diposting Otomatis',
    className: 'text-emerald-700 dark:text-emerald-400 font-semibold',
  },
  published_manual: {
    label: 'Diposting Manual',
    className: 'text-emerald-700 dark:text-emerald-400 font-semibold',
  },
  failed: { label: 'Gagal', className: 'text-red-600 dark:text-red-400 font-semibold' },
};

const PLATFORM_INTEGRATION_STATUS: Array<{
  platform: SocialPlatform;
  mode: string;
  readiness: 'aktif' | 'webhook';
  note: string;
}> = [
  {
    platform: 'youtube_shorts',
    mode: 'Upload Langsung via YouTube Data API v3 (OAuth Google)',
    readiness: 'aktif',
    note: 'Tersedia langsung setelah login Google dan memberi izin unggah YouTube.',
  },
  {
    platform: 'tiktok',
    mode: 'Webhook Worker / Paket Ekspor Manual',
    readiness: 'webhook',
    note: 'API posting langsung TikTok membutuhkan persetujuan TikTok Content Posting API App Review.',
  },
  {
    platform: 'instagram_reels',
    mode: 'Webhook Worker / Paket Ekspor Manual',
    readiness: 'webhook',
    note: 'API Instagram Graph memerlukan akun Business/Creator terverifikasi & Meta App Review.',
  },
  {
    platform: 'facebook_reels',
    mode: 'Webhook Worker / Paket Ekspor Manual',
    readiness: 'webhook',
    note: 'API Facebook Reels memerlukan izin Meta Page Publish & App Review.',
  },
  {
    platform: 'linkedin',
    mode: 'Webhook Worker / Share URL',
    readiness: 'webhook',
    note: 'Posting video otomatis LinkedIn membutuhkan aplikasi LinkedIn Marketing API.',
  },
  {
    platform: 'x_twitter',
    mode: 'Webhook Worker / Share Intent',
    readiness: 'webhook',
    note: 'Posting otomatis X/Twitter membutuhkan kredensial X API v2 berbayar.',
  },
];

export function DistributionQueueView({
  episodes,
  clips,
  logs,
  defaultPlatforms,
  onJumpToClip,
  onAutoPostClip,
  onScheduleClip,
  onDeleteClip,
}: DistributionQueueViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [busyClipId, setBusyClipId] = useState<string | null>(null);
  const [scheduleClipId, setScheduleClipId] = useState<string>(clips[0]?.id ?? '');
  const [scheduleDateTime, setScheduleDateTime] = useState<string>(() => {
    const nextHour = new Date(Date.now() + 2 * 60 * 60 * 1000);
    nextHour.setMinutes(0, 0, 0);
    return nextHour.toISOString().slice(0, 16);
  });
  const [scheduleMsg, setScheduleMsg] = useState<string | null>(null);
  const [isScheduling, setIsScheduling] = useState(false);

  const episodeMap = new Map(episodes.map((e) => [e.id, e]));
  const normalized = searchQuery.trim().toLowerCase();

  const filteredClips = clips.filter((clip) => {
    if (statusFilter !== 'all' && clip.status !== statusFilter) return false;
    if (!normalized) return true;
    const epTitle = episodeMap.get(clip.episodeId)?.title.toLowerCase() ?? '';
    return clip.title.toLowerCase().includes(normalized) || epTitle.includes(normalized);
  });

  const scheduledClips = clips
    .filter((c) => Boolean(c.scheduledFor))
    .sort((a, b) => (a.scheduledFor || '').localeCompare(b.scheduledFor || ''));

  const handleQuickAutoPost = async (clipId: string) => {
    setBusyClipId(clipId);
    try {
      await onAutoPostClip(clipId, defaultPlatforms);
    } finally {
      setBusyClipId(null);
    }
  };

  const handleSaveSchedule = async () => {
    const targetId = scheduleClipId || clips[0]?.id;
    if (!targetId || !scheduleDateTime || !onScheduleClip) return;
    setIsScheduling(true);
    setScheduleMsg(null);
    try {
      const iso = new Date(scheduleDateTime).toISOString();
      await onScheduleClip(targetId, iso, defaultPlatforms);
      setScheduleMsg('Jadwal publikasi klip berhasil disimpan ke Kalender Konten.');
    } finally {
      setIsScheduling(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            Distribusi, Kalender Konten & Riwayat
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Pantau antrean publikasi, atur jadwal Kalender Konten, dan lihat status integrasi tiap platform.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full sm:w-64">
            <Search
              className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <label htmlFor="queue-search-input" className="sr-only">
              Cari klip dalam antrean
            </label>
            <input
              id="queue-search-input"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari judul klip..."
              className="w-full h-9 pl-9 pr-3 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:border-red-600 focus:outline-none"
            />
          </div>

          <div
            role="tablist"
            aria-label="Filter status klip"
            className="inline-flex items-center p-1 bg-slate-100 dark:bg-slate-800 rounded-lg overflow-x-auto"
          >
            {(
              [
                ['all', 'Semua'],
                ['draft', 'Siap Tinjau'],
                ['scheduled', 'Terjadwal'],
                ['published_auto', 'Otomatis'],
                ['published_manual', 'Manual'],
              ] as [StatusFilter, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={statusFilter === value}
                onClick={() => setStatusFilter(value)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md whitespace-nowrap cursor-pointer studio-transition ${
                  statusFilter === value
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content Calendar Scheduler */}
      {onScheduleClip && clips.length > 0 && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <CalendarClock className="w-4 h-4 text-red-600" aria-hidden="true" />
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
                Kalender Konten & Penjadwalan Klip
              </h2>
            </div>
            <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
              {scheduledClips.length} klip terjadwal
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr_auto] gap-3 items-end">
            <div>
              <label
                htmlFor="schedule-clip-select"
                className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
              >
                Pilih Klip untuk Dijadwalkan
              </label>
              <select
                id="schedule-clip-select"
                value={scheduleClipId || clips[0]?.id || ''}
                onChange={(e) => setScheduleClipId(e.target.value)}
                className="w-full h-10 px-3 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg focus:border-red-600 focus:outline-none"
              >
                {clips.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title} ({formatTimestamp(c.startSec)}–{formatTimestamp(c.endSec)})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="schedule-datetime-input"
                className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
              >
                Tanggal & Jam Publikasi
              </label>
              <input
                id="schedule-datetime-input"
                type="datetime-local"
                value={scheduleDateTime}
                onChange={(e) => setScheduleDateTime(e.target.value)}
                className="w-full h-10 px-3 text-sm font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg focus:border-red-600 focus:outline-none"
              />
            </div>
            <button
              type="button"
              disabled={isScheduling}
              onClick={() => void handleSaveSchedule()}
              className="h-10 px-4 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer whitespace-nowrap disabled:opacity-60"
            >
              {isScheduling ? 'Menyimpan...' : 'Simpan ke Kalender'}
            </button>
          </div>

          {scheduleMsg && (
            <p role="status" className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
              {scheduleMsg}
            </p>
          )}

          {scheduledClips.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pt-2">
              {scheduledClips.map((c) => (
                <div
                  key={c.id}
                  className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 flex flex-col justify-between gap-2"
                >
                  <div>
                    <div className="text-[11px] font-mono tabular-nums font-semibold text-blue-700 dark:text-blue-400">
                      {c.scheduledFor
                        ? new Date(c.scheduledFor).toLocaleString('id-ID', {
                            weekday: 'short',
                            day: '2-digit',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : ''}
                    </div>
                    <p className="text-xs font-semibold text-slate-900 dark:text-white line-clamp-2 mt-0.5">
                      {c.title}
                    </p>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <button
                      type="button"
                      onClick={() => onJumpToClip(c.episodeId, c.id)}
                      className="font-semibold text-red-600 hover:underline cursor-pointer"
                    >
                      Buka Klip
                    </button>
                    <button
                      type="button"
                      onClick={() => void onScheduleClip(c.id, null, defaultPlatforms)}
                      className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer"
                    >
                      Batalkan Jadwal
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* High-density clip table */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 text-xs font-semibold text-slate-600 dark:text-slate-300">
                <th className="py-3 px-4">Klip & Sumber Podcast</th>
                <th className="py-3 px-4 whitespace-nowrap">Rentang Waktu</th>
                <th className="py-3 px-4 text-right whitespace-nowrap">Durasi</th>
                <th className="py-3 px-4 whitespace-nowrap">Status</th>
                <th className="py-3 px-4">Kanal Terkirim</th>
                <th className="py-3 px-4 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
              {filteredClips.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 px-4 text-center text-sm text-slate-500">
                    Belum ada klip yang sesuai dengan filter ini.
                  </td>
                </tr>
              ) : (
                filteredClips.map((clip) => {
                  const ep = episodeMap.get(clip.episodeId);
                  const statusInfo = STATUS_DISPLAY[clip.status];
                  const dur = Math.max(1, clip.endSec - clip.startSec);
                  return (
                    <tr
                      key={clip.id}
                      className="hover:bg-slate-50/80 dark:hover:bg-slate-800/50 studio-transition"
                    >
                      <td className="py-2.5 px-4 max-w-md">
                        <button
                          type="button"
                          onClick={() => onJumpToClip(clip.episodeId, clip.id)}
                          className="text-left font-semibold text-slate-900 dark:text-white hover:text-red-600 cursor-pointer line-clamp-1"
                        >
                          {clip.title}
                        </button>
                        <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                          {ep?.title ?? 'Episode Podcast'}
                        </div>
                      </td>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">
                        {formatTimestamp(clip.startSec)} – {formatTimestamp(clip.endSec)}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-xs text-slate-700 dark:text-slate-300 whitespace-nowrap">
                        {dur} dtk
                      </td>
                      <td className={`py-2.5 px-4 text-xs whitespace-nowrap ${statusInfo.className}`}>
                        {statusInfo.label}
                      </td>
                      <td className="py-2.5 px-4 text-xs text-slate-600 dark:text-slate-300 max-w-xs truncate">
                        {clip.publishedPlatforms.length > 0
                          ? clip.publishedPlatforms.map((p) => PLATFORM_LABELS[p]).join(', ')
                          : 'Belum dikirim'}
                      </td>
                      <td className="py-2.5 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            disabled={busyClipId === clip.id}
                            onClick={() => handleQuickAutoPost(clip.id)}
                            aria-label={`Auto-post klip ${clip.title}`}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-white bg-slate-900 dark:bg-red-600 hover:bg-slate-800 dark:hover:bg-red-700 rounded-md cursor-pointer disabled:opacity-60"
                          >
                            <Send className="w-3 h-3" aria-hidden="true" />
                            <span>{busyClipId === clip.id ? 'Kirim...' : 'Auto-Post'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onDeleteClip(clip.id)}
                            aria-label={`Hapus klip ${clip.title}`}
                            className="p-1.5 text-slate-400 hover:text-red-600 rounded-md cursor-pointer"
                          >
                            <Trash2 className="w-4 h-4" aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Honest Platform Integration Status */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 space-y-4">
        <div>
          <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
            Status Integrasi Platform Media Sosial
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Transparansi metode publikasi aktual untuk setiap kanal yang didukung KlipCast.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {PLATFORM_INTEGRATION_STATUS.map((item) => (
            <div
              key={item.platform}
              className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 space-y-1"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-slate-900 dark:text-white">
                  {PLATFORM_LABELS[item.platform]}
                </span>
                <span
                  className={`inline-flex items-center gap-1 text-[11px] font-semibold ${
                    item.readiness === 'aktif'
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-amber-700 dark:text-amber-400'
                  }`}
                >
                  {item.readiness === 'aktif' ? (
                    <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                  ) : (
                    <Info className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                  <span>{item.readiness === 'aktif' ? 'API Langsung Aktif' : 'Webhook / Manual'}</span>
                </span>
              </div>
              <p className="text-[11px] font-medium text-slate-700 dark:text-slate-300">{item.mode}</p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">{item.note}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Recent Distribution Log */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
            Log Eksekusi Bot ({logs.length})
          </h2>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Riwayat pengiriman otomatis & manual
          </span>
        </div>

        {logs.length === 0 ? (
          <p className="text-sm text-slate-500 py-4">
            Belum ada aktivitas publikasi yang tercatat.
          </p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {logs.slice(0, 15).map((log) => (
              <div
                key={log.id}
                className="py-3 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
              >
                <div className="space-y-0.5">
                  <div className="text-sm font-semibold text-slate-900 dark:text-white">
                    {log.clipTitle}
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-400">{log.message}</p>
                </div>
                <div className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 shrink-0">
                  {new Date(log.timestamp).toLocaleString('id-ID', {
                    day: '2-digit',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
