import { useState } from 'react';
import { Check, Copy, Search } from 'lucide-react';
import type { PodcastClip, PodcastEpisode } from '../types/clipper';
import { formatTimestamp } from '../utils/youtube';

interface SummaryArchiveViewProps {
  episodes: PodcastEpisode[];
  clips: PodcastClip[];
  onJumpToClip: (episodeId: string, clipId: string) => void;
}

export function SummaryArchiveView({
  episodes,
  clips,
  onJumpToClip,
}: SummaryArchiveViewProps) {
  const [query, setQuery] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const normalizedQuery = query.trim().toLowerCase();

  const filteredEpisodes = episodes.filter((ep) => {
    if (!normalizedQuery) return true;
    const epClips = clips.filter((c) => c.episodeId === ep.id);
    return (
      ep.title.toLowerCase().includes(normalizedQuery) ||
      ep.episodeSummary.toLowerCase().includes(normalizedQuery) ||
      epClips.some(
        (c) =>
          c.title.toLowerCase().includes(normalizedQuery) ||
          c.ringkasanTeks.toLowerCase().includes(normalizedQuery)
      )
    );
  });

  const handleCopyEpisode = async (ep: PodcastEpisode, epClips: PodcastClip[]) => {
    const markdown = [
      `# ${ep.title}`,
      `Kanal: ${ep.channelName} | Sumber: ${ep.sourceUrl}`,
      '',
      `## Ringkasan Episode`,
      ep.episodeSummary,
      '',
      `## Sorotan Klip`,
      ...epClips.map(
        (c, i) =>
          `${i + 1}. [${formatTimestamp(c.startSec)} - ${formatTimestamp(c.endSec)}] ${c.title}\n   ${c.ringkasanTeks}`
      ),
    ].join('\n');

    try {
      await navigator.clipboard.writeText(markdown);
      setCopiedId(ep.id);
      window.setTimeout(() => setCopiedId(null), 1800);
    } catch {
      // Ignore clipboard failure
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
            Arsip Ringkasan Teks Podcast
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Ringkasan naratif dan poin kunci dari setiap episode podcast beserta timestamp klipnya.
          </p>
        </div>

        <div className="relative w-full sm:w-80">
          <Search
            className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <label htmlFor="summary-search" className="sr-only">
            Cari ringkasan podcast
          </label>
          <input
            id="summary-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cari topik atau judul podcast..."
            className="w-full h-10 pl-9 pr-3 text-sm text-slate-900 bg-white border border-slate-200 rounded-lg focus:border-red-600 focus:outline-none"
          />
        </div>
      </div>

      {filteredEpisodes.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-2">
          <p className="text-sm font-semibold text-slate-900">
            Tidak ada ringkasan yang cocok dengan pencarian Anda.
          </p>
          <p className="text-xs text-slate-500">
            Coba kata kunci lain atau proses link podcast baru di Studio Klip.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {filteredEpisodes.map((ep) => {
            const epClips = clips.filter((c) => c.episodeId === ep.id);
            return (
              <article
                key={ep.id}
                className="bg-white border border-slate-200 rounded-xl p-6 space-y-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-100">
                  <div className="space-y-1 max-w-3xl">
                    <div className="text-xs text-slate-500 flex flex-wrap items-center gap-x-2">
                      <span className="font-medium text-slate-700">{ep.channelName}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        Durasi {formatTimestamp(ep.durationSec)}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{epClips.length} klip</span>
                    </div>
                    <h2 className="font-display text-lg font-bold text-slate-900">
                      {ep.title}
                    </h2>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleCopyEpisode(ep, epClips)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer whitespace-nowrap"
                  >
                    {copiedId === ep.id ? (
                      <Check className="w-3.5 h-3.5 text-emerald-700" aria-hidden="true" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    <span>{copiedId === ep.id ? 'Ringkasan Tersalin' : 'Salin Semua Teks'}</span>
                  </button>
                </div>

                <p className="text-sm leading-relaxed text-slate-700 max-w-4xl">
                  {ep.episodeSummary}
                </p>

                <div className="divide-y divide-slate-100">
                  {epClips.map((c, idx) => (
                    <div
                      key={c.id}
                      className="py-3.5 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-start justify-between gap-4"
                    >
                      <div className="space-y-1 max-w-3xl">
                        <div className="text-xs font-mono tabular-nums text-slate-500">
                          {String(idx + 1).padStart(2, '0')} · {formatTimestamp(c.startSec)} –{' '}
                          {formatTimestamp(c.endSec)}
                        </div>
                        <h3 className="text-sm font-semibold text-slate-900">{c.title}</h3>
                        <p className="text-xs leading-relaxed text-slate-600">{c.ringkasanTeks}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => onJumpToClip(ep.id, c.id)}
                        className="text-xs font-semibold text-red-600 hover:text-red-700 whitespace-nowrap shrink-0 cursor-pointer self-start"
                      >
                        Buka di Studio
                      </button>
                    </div>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
