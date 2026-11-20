import { useEffect, useState } from 'react';
import type { User } from '@firebase/auth';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Send,
  Share2,
  Terminal,
  Upload,
  Youtube,
} from 'lucide-react';
import type { PodcastClip, PodcastEpisode, SocialPlatform } from '../types/clipper';
import {
  buildFfmpegCommand,
  buildSocialShareUrl,
  generateSrtFromClip,
  PLATFORM_LABELS,
} from '../utils/youtube';
import { GoogleAccountBadge, GoogleSignInButton } from './GoogleSignInButton';

interface ClipPublisherPanelProps {
  clip: PodcastClip;
  episode: PodcastEpisode;
  defaultPlatforms: SocialPlatform[];
  isPublishing: boolean;
  publishFeedback: { type: 'success' | 'error'; text: string } | null;
  youtubeUser: User | null;
  hasYouTubeToken: boolean;
  isSigningInGoogle: boolean;
  googleAuthError: string | null;
  onGoogleSignIn: () => void;
  onGoogleSignOut: () => void;
  onOpenYouTubeDirectUpload: () => void;
  onUpdateClip: (clipId: string, patch: Partial<PodcastClip>) => Promise<void>;
  onAutoPostAll: (clipId: string, platforms: SocialPlatform[]) => Promise<void>;
  onOpenManualShorts: () => void;
  onManualSharePlatform: (clipId: string, platform: SocialPlatform) => Promise<void>;
}

const PLATFORMS: SocialPlatform[] = [
  'youtube_shorts',
  'tiktok',
  'instagram_reels',
  'x_twitter',
  'linkedin',
];

export function ClipPublisherPanel({
  clip,
  episode,
  defaultPlatforms,
  isPublishing,
  publishFeedback,
  youtubeUser,
  hasYouTubeToken,
  isSigningInGoogle,
  googleAuthError,
  onGoogleSignIn,
  onGoogleSignOut,
  onOpenYouTubeDirectUpload,
  onUpdateClip,
  onAutoPostAll,
  onOpenManualShorts,
  onManualSharePlatform,
}: ClipPublisherPanelProps) {
  const [activePlatform, setActivePlatform] = useState<SocialPlatform>('youtube_shorts');
  const [summaryDraft, setSummaryDraft] = useState(clip.ringkasanTeks);
  const [platformTitleDraft, setPlatformTitleDraft] = useState(
    clip.platformCopies.youtube_shorts.title
  );
  const [platformCaptionDraft, setPlatformCaptionDraft] = useState(
    clip.platformCopies.youtube_shorts.caption
  );
  const [selectedAutoPlatforms, setSelectedAutoPlatforms] =
    useState<SocialPlatform[]>(defaultPlatforms);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    setSummaryDraft(clip.ringkasanTeks);
    const current = clip.platformCopies[activePlatform];
    setPlatformTitleDraft(current.title);
    setPlatformCaptionDraft(current.caption);
  }, [clip.id, clip.ringkasanTeks, clip.platformCopies, activePlatform]);

  const handleCopy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      // Ignore clipboard failures in restricted environments
    }
  };

  const handleDownloadSrt = () => {
    const srtContent = generateSrtFromClip(clip);
    const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${clip.id}.srt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSaveCopyChanges = async () => {
    await onUpdateClip(clip.id, {
      ringkasanTeks: summaryDraft.trim() || clip.ringkasanTeks,
      platformCopies: {
        ...clip.platformCopies,
        [activePlatform]: {
          ...clip.platformCopies[activePlatform],
          title: platformTitleDraft.trim() || clip.platformCopies[activePlatform].title,
          caption: platformCaptionDraft.trim() || clip.platformCopies[activePlatform].caption,
        },
      },
    });
  };

  const toggleTargetPlatform = (p: SocialPlatform) => {
    setSelectedAutoPlatforms((prev) =>
      prev.includes(p) ? prev.filter((item) => item !== p) : [...prev, p]
    );
  };

  const activeCopy = clip.platformCopies[activePlatform];
  const shareUrl = buildSocialShareUrl(activePlatform, clip, episode.sourceUrl);
  const hashtagsString = activeCopy.hashtags.join(' ');
  const fullSummaryPack = `${clip.title}\n\nRingkasan:\n${summaryDraft}\n\nPoin Kunci:\n${clip.poinKunci
    .map((p) => `- ${p}`)
    .join('\n')}`;

  return (
    <div className="space-y-6 min-w-0">
      {/* Section 1: Text Summary & Key Takeaways */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-base font-bold text-slate-900">
              Ringkasan Teks & Transkrip Klip
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Otomatis diringkas dari segmen terpilih — dapat diedit sebelum dipublikasikan.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => handleCopy('summary', fullSummaryPack)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg studio-transition cursor-pointer whitespace-nowrap"
            >
              {copiedKey === 'summary' ? (
                <Check className="w-3.5 h-3.5 text-emerald-700" aria-hidden="true" />
              ) : (
                <Copy className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>{copiedKey === 'summary' ? 'Tersalin' : 'Salin Ringkasan'}</span>
            </button>
            <button
              type="button"
              onClick={handleDownloadSrt}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg studio-transition cursor-pointer whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Unduh .SRT</span>
            </button>
          </div>
        </div>

        {clip.viralReason && (
          <div className="px-3.5 py-2.5 bg-amber-50/70 border border-amber-200/80 rounded-lg text-xs text-amber-950 leading-relaxed flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {typeof clip.viralScore === 'number' && (
              <span className="font-mono tabular-nums font-bold text-amber-900">
                Skor Viral {clip.viralScore}/100:
              </span>
            )}
            <span>{clip.viralReason}</span>
          </div>
        )}

        <div>
          <label htmlFor="clip-summary-textarea" className="sr-only">
            Ringkasan teks klip
          </label>
          <textarea
            id="clip-summary-textarea"
            rows={3}
            value={summaryDraft}
            onChange={(e) => setSummaryDraft(e.target.value)}
            onBlur={handleSaveCopyChanges}
            className="w-full p-3.5 text-sm leading-relaxed text-slate-800 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-red-600 focus:outline-none"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold text-slate-700">Poin Kunci</h4>
            <ul className="space-y-1 text-xs leading-relaxed text-slate-600 list-disc pl-4">
              {clip.poinKunci.map((point, idx) => (
                <li key={idx}>{point}</li>
              ))}
            </ul>
          </div>
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold text-slate-700">
              Kutipan Transkrip
              {clip.subtitleAccuracySource === 'audio_transcribed' && (
                <span className="ml-1.5 text-[11px] font-semibold text-emerald-700">
                  (Audio Verbatim)
                </span>
              )}
            </h4>
            <p className="text-xs leading-relaxed text-slate-600 italic">
              “{clip.transcriptExcerpt}”
            </p>
          </div>
        </div>

        <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-3 min-w-0">
          <code className="text-xs text-slate-500 font-mono truncate min-w-0 flex-1">
            {buildFfmpegCommand(clip)}
          </code>
          <button
            type="button"
            onClick={() => handleCopy('ffmpeg', buildFfmpegCommand(clip))}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer whitespace-nowrap shrink-0"
          >
            <Terminal className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{copiedKey === 'ffmpeg' ? 'Perintah Tersalin' : 'Salin Perintah FFmpeg'}</span>
          </button>
        </div>
      </section>

      {/* Section 2: Multi-Platform Publishing (Auto-Post & Manual Shorts) */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-base font-bold text-slate-900">
              Publikasi YouTube Shorts & Media Sosial
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Pilih auto-post ke semua kanal aktif atau unggah manual ke YouTube Shorts.
            </p>
          </div>

          {clip.publishedPlatforms.length > 0 && (
            <span className="text-xs font-medium text-emerald-700">
              Terkirim ke: {clip.publishedPlatforms.map((p) => PLATFORM_LABELS[p]).join(', ')}
            </span>
          )}
        </div>

        {/* Platform copy tabs */}
        <div
          role="tablist"
          aria-label="Platform media sosial"
          className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg"
        >
          {PLATFORMS.map((platform) => {
            const isSelected = activePlatform === platform;
            return (
              <button
                key={platform}
                type="button"
                role="tab"
                aria-selected={isSelected}
                onClick={() => setActivePlatform(platform)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md studio-transition whitespace-nowrap cursor-pointer ${
                  isSelected
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {PLATFORM_LABELS[platform]}
              </button>
            );
          })}
        </div>

        <div className="space-y-3">
          <div>
            <label
              htmlFor="platform-title-input"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Judul / Hook ({PLATFORM_LABELS[activePlatform]})
            </label>
            <input
              id="platform-title-input"
              type="text"
              value={platformTitleDraft}
              onChange={(e) => setPlatformTitleDraft(e.target.value)}
              onBlur={handleSaveCopyChanges}
              className="w-full h-10 px-3 text-sm text-slate-900 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-red-600 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="platform-caption-input"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Caption & Deskripsi
            </label>
            <textarea
              id="platform-caption-input"
              rows={3}
              value={platformCaptionDraft}
              onChange={(e) => setPlatformCaptionDraft(e.target.value)}
              onBlur={handleSaveCopyChanges}
              className="w-full p-3 text-sm text-slate-900 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-red-600 focus:outline-none"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <span>{hashtagsString}</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() =>
                  handleCopy(
                    'platform-copy',
                    `${platformTitleDraft}\n\n${platformCaptionDraft}\n\n${hashtagsString}`
                  )
                }
                className="inline-flex items-center gap-1 font-medium text-slate-700 hover:text-slate-900 cursor-pointer"
              >
                <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                <span>
                  {copiedKey === 'platform-copy' ? 'Caption Tersalin' : 'Salin Caption'}
                </span>
              </button>
              <a
                href={shareUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => onManualSharePlatform(clip.id, activePlatform)}
                className="inline-flex items-center gap-1 font-semibold text-red-600 hover:text-red-700"
              >
                <Share2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Bagikan ke {PLATFORM_LABELS[activePlatform]}</span>
                <ExternalLink className="w-3 h-3" aria-hidden="true" />
              </a>
            </div>
          </div>
        </div>

        {/* Target Channels for Bot Auto-Post */}
        <div className="pt-4 border-t border-slate-200 space-y-3">
          <div className="text-xs font-semibold text-slate-700">
            Target Distribusi Bot Otomatis:
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {PLATFORMS.map((platform) => (
              <label
                key={platform}
                className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  checked={selectedAutoPlatforms.includes(platform)}
                  onChange={() => toggleTargetPlatform(platform)}
                  className="w-4 h-4 accent-red-600 rounded"
                />
                <span>{PLATFORM_LABELS[platform]}</span>
              </label>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="button"
              disabled={isPublishing || selectedAutoPlatforms.length === 0}
              onClick={async () => {
                await handleSaveCopyChanges();
                await onAutoPostAll(clip.id, selectedAutoPlatforms);
              }}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 disabled:bg-slate-400 rounded-lg studio-transition whitespace-nowrap cursor-pointer"
            >
              <Send className="w-4 h-4" aria-hidden="true" />
              <span>
                {isPublishing ? 'Mengirim ke Bot...' : 'Auto-Post ke Platform Terpilih'}
              </span>
            </button>

            <button
              type="button"
              onClick={async () => {
                await handleSaveCopyChanges();
                onOpenManualShorts();
              }}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-slate-900 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg studio-transition whitespace-nowrap cursor-pointer"
            >
              <Upload className="w-4 h-4" aria-hidden="true" />
              <span>Post Manual ke YouTube Shorts</span>
            </button>
          </div>

          {publishFeedback && (
            <p
              role="status"
              className={`text-xs font-medium ${
                publishFeedback.type === 'success' ? 'text-emerald-700' : 'text-red-600'
              }`}
            >
              {publishFeedback.text}
            </p>
          )}
        </div>

        {/* Direct YouTube Shorts Upload via Google Sign-In */}
        <div className="pt-4 border-t border-slate-200 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-900">
                <Youtube className="w-4 h-4 text-red-600 shrink-0" aria-hidden="true" />
                <span>Upload Langsung ke Channel YouTube (Login Google)</span>
              </div>
              <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
                {youtubeUser && !hasYouTubeToken
                  ? 'Akun Google Anda sudah terverifikasi. Klik sekali untuk menyegarkan izin unggah YouTube pada sesi browser ini.'
                  : 'Unggah video klip .MP4 langsung ke YouTube Shorts memakai akun Google Anda dengan konfirmasi terlebih dahulu.'}
              </p>
            </div>
            {youtubeUser && (
              <GoogleAccountBadge
                displayName={youtubeUser.displayName}
                email={youtubeUser.email}
                photoUrl={youtubeUser.photoURL}
                verified
                onSignOut={onGoogleSignOut}
              />
            )}
          </div>

          {googleAuthError && (
            <p role="alert" className="text-xs font-medium text-red-600">
              {googleAuthError}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {youtubeUser && hasYouTubeToken ? (
              <button
                type="button"
                onClick={async () => {
                  await handleSaveCopyChanges();
                  onOpenYouTubeDirectUpload();
                }}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg studio-transition cursor-pointer whitespace-nowrap"
              >
                <Youtube className="w-4 h-4 text-red-500" aria-hidden="true" />
                <span>Upload Langsung ke YouTube Shorts</span>
              </button>
            ) : (
              <GoogleSignInButton
                onClick={onGoogleSignIn}
                isLoading={isSigningInGoogle}
                label={
                  youtubeUser
                    ? 'Aktifkan Izin Upload YouTube'
                    : 'Sign in with Google'
                }
              />
            )}

            {clip.youtubeWatchUrl && (
              <a
                href={clip.youtubeWatchUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 hover:text-emerald-800 hover:underline"
              >
                <span>Sudah terbit di YouTube Shorts</span>
                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
