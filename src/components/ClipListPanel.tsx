import type { PodcastClip, PodcastEpisode } from '../types/clipper';
import { formatTimestamp } from '../utils/youtube';

interface ClipListPanelProps {
  episodes: PodcastEpisode[];
  selectedEpisodeId: string;
  onSelectEpisode: (episodeId: string) => void;
  clips: PodcastClip[];
  selectedClipId: string;
  onSelectClip: (clipId: string) => void;
  isAnalyzing: boolean;
}

const STATUS_LABEL: Record<PodcastClip['status'], { text: string; tone: string }> = {
  draft: { text: 'Siap Tinjau', tone: 'text-slate-600' },
  queued: { text: 'Dalam Antrean', tone: 'text-amber-700' },
  published_auto: { text: 'Diposting Otomatis', tone: 'text-emerald-700' },
  published_manual: { text: 'Diposting Manual', tone: 'text-emerald-700' },
  failed: { text: 'Gagal Kirim', tone: 'text-red-600' },
};

export function ClipListPanel({
  episodes,
  selectedEpisodeId,
  onSelectEpisode,
  clips,
  selectedClipId,
  onSelectClip,
  isAnalyzing,
}: ClipListPanelProps) {
  const activeEpisode = episodes.find((e) => e.id === selectedEpisodeId) ?? episodes[0];

  if (isAnalyzing) {
    return (
      <aside className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="h-5 w-40 bg-slate-200 rounded animate-pulse" />
        <div className="h-20 w-full bg-slate-100 rounded-lg animate-pulse" />
        <div className="space-y-3 pt-2">
          {[1, 2, 3].map((item) => (
            <div key={item} className="h-24 w-full bg-slate-100 rounded-lg animate-pulse" />
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className="bg-white border border-slate-200 rounded-xl p-5 space-y-5">
      {/* Episode selector when multiple podcasts exist */}
      <div>
        <label
          htmlFor="episode-selector"
          className="block text-xs font-semibold text-slate-500 mb-1.5"
        >
          Episode Podcast ({episodes.length})
        </label>
        <select
          id="episode-selector"
          value={activeEpisode?.id ?? ''}
          onChange={(e) => onSelectEpisode(e.target.value)}
          className="w-full h-10 px-3 text-sm font-medium text-slate-900 bg-slate-50 border border-slate-200 rounded-lg focus:border-red-600 focus:outline-none"
        >
          {episodes.map((ep) => (
            <option key={ep.id} value={ep.id}>
              {ep.title}
            </option>
          ))}
        </select>
      </div>

      {activeEpisode && (
        <div className="pb-4 border-b border-slate-200 space-y-2.5">
          <div className="flex items-start gap-3">
            <img
              src={activeEpisode.thumbnailUrl}
              alt={activeEpisode.title}
              referrerPolicy="no-referrer"
              onError={(e) => {
                const target = e.currentTarget;
                if (target.src !== activeEpisode.fallbackImageUrl) {
                  target.src = activeEpisode.fallbackImageUrl;
                }
              }}
              className="w-20 h-14 object-cover rounded-lg border border-slate-200 shrink-0 bg-slate-100"
            />
            <div className="min-w-0">
              <h2 className="font-display text-sm font-bold text-slate-900 line-clamp-2">
                {activeEpisode.title}
              </h2>
              <p className="mt-1 text-xs text-slate-500 flex flex-wrap items-center gap-x-1.5">
                <span>{activeEpisode.channelName}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">
                  {formatTimestamp(activeEpisode.durationSec)}
                </span>
              </p>
            </div>
          </div>
          <p className="text-xs leading-relaxed text-slate-600">
            {activeEpisode.episodeSummary}
          </p>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-sm font-bold text-slate-900">
            Potongan Klip ({clips.length})
          </h3>
          <span className="text-xs text-slate-500">Pilih untuk edit & post</span>
        </div>

        <ul className="divide-y divide-slate-100" role="listbox" aria-label="Daftar klip podcast">
          {clips.map((clip, idx) => {
            const isSelected = clip.id === selectedClipId;
            const duration = Math.max(1, clip.endSec - clip.startSec);
            const statusInfo = STATUS_LABEL[clip.status];
            return (
              <li key={clip.id} className="py-1.5 first:pt-0 last:pb-0">
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => onSelectClip(clip.id)}
                  className={`w-full text-left p-3 rounded-lg studio-transition cursor-pointer focus-visible:outline-2 focus-visible:outline-red-600 ${
                    isSelected
                      ? 'bg-slate-900 text-white'
                      : 'bg-white hover:bg-slate-50 text-slate-900'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs mb-1">
                    <span
                      className={`font-mono tabular-nums ${
                        isSelected ? 'text-slate-300' : 'text-slate-500'
                      }`}
                    >
                      {String(idx + 1).padStart(2, '0')} · {formatTimestamp(clip.startSec)} –{' '}
                      {formatTimestamp(clip.endSec)}
                    </span>
                    <span
                      className={`font-mono tabular-nums font-semibold ${
                        isSelected ? 'text-red-400' : 'text-slate-700'
                      }`}
                    >
                      {duration} dtk
                    </span>
                  </div>

                  <p className="text-sm font-semibold leading-snug line-clamp-2">
                    {clip.title}
                  </p>

                  <div
                    className={`mt-1.5 flex flex-wrap items-center gap-1.5 text-xs ${
                      isSelected ? 'text-slate-300' : 'text-slate-500'
                    }`}
                  >
                    <span>{clip.priorityLabel}</span>
                    {typeof clip.viralScore === 'number' && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span
                          className={`font-mono tabular-nums font-semibold ${
                            isSelected ? 'text-amber-300' : 'text-amber-700'
                          }`}
                        >
                          Viral {clip.viralScore}
                        </span>
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span className={isSelected ? 'text-white font-medium' : `${statusInfo.tone} font-medium`}>
                      {statusInfo.text}
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
