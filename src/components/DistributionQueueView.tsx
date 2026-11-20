import { useState } from 'react';
import { Search, Send, Trash2 } from 'lucide-react';
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
  onDeleteClip: (clipId: string) => Promise<void>;
}

type StatusFilter = 'all' | 'draft' | 'published_auto' | 'published_manual';

const STATUS_DISPLAY: Record<PodcastClip['status'], { label: string; className: string }> = {
  draft: { label: 'Siap Tinjau', className: 'text-slate-600' },
  queued: { label: 'Dalam Antrean', className: 'text-amber-700' },
  published_auto: { label: 'Diposting Otomatis', className: 'text-emerald-700 font-semibold' },
  published_manual: { label: 'Diposting Manual', className: 'text-emerald-700 font-semibold' },
  failed: { label: 'Gagal', className: 'text-red-600 font-semibold' },
};

export function DistributionQueueView({
  episodes,
  clips,
  logs,
  defaultPlatforms,
  onJumpToClip,
  onAutoPostClip,
  onDeleteClip,
}: DistributionQueueViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [busyClipId, setBusyClipId] = useState<string | null>(null);

  const episodeMap = new Map(episodes.map((e) => [e.id, e]));
  const normalized = searchQuery.trim().toLowerCase();

  const filteredClips = clips.filter((clip) => {
    if (statusFilter !== 'all' && clip.status !== statusFilter) return false;
    if (!normalized) return true;
    const epTitle = episodeMap.get(clip.episodeId)?.title.toLowerCase() ?? '';
    return (
      clip.title.toLowerCase().includes(normalized) || epTitle.includes(normalized)
    );
  });

  const handleQuickAutoPost = async (clipId: string) => {
    setBusyClipId(clipId);
    try {
      await onAutoPostClip(clipId, defaultPlatforms);
    } finally {
      setBusyClipId(null);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
            Antrean Klip & Riwayat Distribusi
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Pantau status publikasi ke YouTube Shorts dan kanal media sosial lainnya.
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
              className="w-full h-9 pl-9 pr-3 text-sm bg-white border border-slate-200 rounded-lg focus:border-red-600 focus:outline-none"
            />
          </div>

          <div
            role="tablist"
            aria-label="Filter status klip"
            className="inline-flex items-center p-1 bg-slate-100 rounded-lg overflow-x-auto"
          >
            {(
              [
                ['all', 'Semua'],
                ['draft', 'Siap Tinjau'],
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
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* High-density clip table */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-600">
                <th className="py-3 px-4">Klip & Sumber Podcast</th>
                <th className="py-3 px-4 whitespace-nowrap">Rentang Waktu</th>
                <th className="py-3 px-4 text-right whitespace-nowrap">Durasi</th>
                <th className="py-3 px-4 whitespace-nowrap">Status</th>
                <th className="py-3 px-4">Kanal Terkirim</th>
                <th className="py-3 px-4 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
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
                    <tr key={clip.id} className="hover:bg-slate-50/80 studio-transition">
                      <td className="py-2.5 px-4 max-w-md">
                        <button
                          type="button"
                          onClick={() => onJumpToClip(clip.episodeId, clip.id)}
                          className="text-left font-semibold text-slate-900 hover:text-red-600 cursor-pointer line-clamp-1"
                        >
                          {clip.title}
                        </button>
                        <div className="text-xs text-slate-500 truncate">
                          {ep?.title ?? 'Episode Podcast'}
                        </div>
                      </td>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-xs text-slate-600 whitespace-nowrap">
                        {formatTimestamp(clip.startSec)} – {formatTimestamp(clip.endSec)}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-xs text-slate-700 whitespace-nowrap">
                        {dur} dtk
                      </td>
                      <td className={`py-2.5 px-4 text-xs whitespace-nowrap ${statusInfo.className}`}>
                        {statusInfo.label}
                      </td>
                      <td className="py-2.5 px-4 text-xs text-slate-600 max-w-xs truncate">
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
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-md cursor-pointer disabled:opacity-60"
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

      {/* Recent Distribution Log */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-base font-bold text-slate-900">
            Log Eksekusi Bot ({logs.length})
          </h2>
          <span className="text-xs text-slate-500">Riwayat pengiriman otomatis & manual</span>
        </div>

        {logs.length === 0 ? (
          <p className="text-sm text-slate-500 py-4">
            Belum ada aktivitas publikasi yang tercatat.
          </p>
        ) : (
          <div className="divide-y divide-slate-100">
            {logs.slice(0, 15).map((log) => (
              <div
                key={log.id}
                className="py-3 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
              >
                <div className="space-y-0.5">
                  <div className="text-sm font-semibold text-slate-900">{log.clipTitle}</div>
                  <p className="text-xs text-slate-600">{log.message}</p>
                </div>
                <div className="text-xs font-mono tabular-nums text-slate-500 shrink-0">
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
