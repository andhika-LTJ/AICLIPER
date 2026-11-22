import { useEffect, useRef, useState } from 'react';
import {
  BookmarkPlus,
  Check,
  Copy,
  Download,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Send,
  SlidersHorizontal,
  Sparkles,
  Subtitles,
  Trash2,
  Wand2,
} from 'lucide-react';
import type {
  AdvisorMessage,
  CaptionCue,
  HookGeneratorVariant,
  HookStyleTone,
  PodcastClip,
  PodcastEpisode,
  RepurposedContentBundle,
} from '../types/clipper';
import { apiFetch } from '../utils/apiClient';
import {
  formatTimestamp,
  generateSrtFromClip,
  generateVttFromClip,
} from '../utils/youtube';
import { CustomContentGeneratorPanel } from './CustomContentGeneratorPanel';

type StudioTab = 'custom' | 'repurpose' | 'hooks' | 'thumbnail' | 'subtitles' | 'assistant';
type ThumbRatio = '16:9' | '9:16' | '1:1';
type ThumbTemplate = 'editorial_red' | 'midnight_gold' | 'studio_clean' | 'podcast_split';

interface AiContentStudioViewProps {
  episodes: PodcastEpisode[];
  clips: PodcastClip[];
  activeEpisodeId: string;
  activeClipId: string;
  isAuthenticated: boolean;
  onSelectClip: (episodeId: string, clipId: string) => void;
  onUpdateClip: (clipId: string, patch: Partial<PodcastClip>) => Promise<void>;
  onGoogleSignIn: () => void;
}

const HOOK_TONE_LABELS: Record<HookStyleTone, string> = {
  profesional: 'Profesional',
  edukatif: 'Edukatif',
  storytelling: 'Storytelling',
  emosional: 'Emosional',
  santai: 'Santai',
  provokatif_etis: 'Provokatif Etis',
};

const THUMB_TEMPLATES: Array<{
  id: ThumbTemplate;
  label: string;
  bgStart: string;
  bgEnd: string;
  accent: string;
  text: string;
  badgeText: string;
}> = [
  {
    id: 'editorial_red',
    label: 'Editorial Merah Studio',
    bgStart: '#0f172a',
    bgEnd: '#1e1b4b',
    accent: '#ef4444',
    text: '#ffffff',
    badgeText: '#ffffff',
  },
  {
    id: 'midnight_gold',
    label: 'Podcast Midnight Emas',
    bgStart: '#09090b',
    bgEnd: '#27272a',
    accent: '#facc15',
    text: '#ffffff',
    badgeText: '#09090b',
  },
  {
    id: 'studio_clean',
    label: 'Minimalis Terang',
    bgStart: '#f8fafc',
    bgEnd: '#e2e8f0',
    accent: '#dc2626',
    text: '#0f172a',
    badgeText: '#ffffff',
  },
  {
    id: 'podcast_split',
    label: 'Broadcast Emerald',
    bgStart: '#022c22',
    bgEnd: '#0f172a',
    accent: '#10b981',
    text: '#ffffff',
    badgeText: '#022c22',
  },
];

function wrapCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width <= maxWidth) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
      if (lines.length >= maxLines - 1) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines;
}

export function AiContentStudioView({
  episodes,
  clips,
  activeEpisodeId,
  activeClipId,
  isAuthenticated,
  onSelectClip,
  onUpdateClip,
  onGoogleSignIn,
}: AiContentStudioViewProps) {
  const [activeTab, setActiveTab] = useState<StudioTab>('repurpose');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const selectedClip = clips.find((c) => c.id === activeClipId) ?? clips[0];
  const selectedEpisode =
    episodes.find((e) => e.id === (selectedClip?.episodeId ?? activeEpisodeId)) ?? episodes[0];

  // Tab 1: Repurposing
  const [isRepurposing, setIsRepurposing] = useState(false);
  const [repurposeBundle, setRepurposeBundle] = useState<RepurposedContentBundle | null>(null);

  // Tab 2: Viral Hooks
  const [isGeneratingHooks, setIsGeneratingHooks] = useState(false);
  const [selectedTones, setSelectedTones] = useState<HookStyleTone[]>([
    'profesional',
    'edukatif',
    'storytelling',
    'emosional',
    'santai',
    'provokatif_etis',
  ]);
  const [hooksResult, setHooksResult] = useState<HookGeneratorVariant[]>([]);

  // Tab 3: Thumbnail Studio (Real HTML5 Canvas Export)
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [thumbRatio, setThumbRatio] = useState<ThumbRatio>('16:9');
  const [thumbTemplate, setThumbTemplate] = useState<ThumbTemplate>('editorial_red');
  const [thumbBadge, setThumbBadge] = useState('PODCAST HIGHLIGHT');
  const [thumbHeadline, setThumbHeadline] = useState(
    selectedClip?.introHeadline || selectedClip?.title || 'Judul Thumbnail Podcast Anda'
  );
  const [thumbSubtext, setThumbSubtext] = useState(
    selectedClip?.hookLine || selectedEpisode?.channelName || 'Ringkasan utama segmen terpilih'
  );
  const [thumbFooter, setThumbFooter] = useState(selectedEpisode?.channelName || 'KlipCast Studio');

  // Tab 4: Subtitle Studio
  const [cueDrafts, setCueDrafts] = useState<CaptionCue[]>(selectedClip?.captionCues ?? []);
  const [isPolishingSubtitles, setIsPolishingSubtitles] = useState(false);
  const [subtitleNotes, setSubtitleNotes] = useState<string | null>(null);
  const [isSavingSubtitles, setIsSavingSubtitles] = useState(false);

  // Tab 5: Persistent AI Content Advisor (Grounded Episode Q&A)
  const [assistantQuestion, setAssistantQuestion] = useState('');
  const [isAskingAssistant, setIsAskingAssistant] = useState(false);
  const [advisorMessages, setAdvisorMessages] = useState<AdvisorMessage[]>([]);
  const [thumbTemplateSavedMsg, setThumbTemplateSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedClip) return;
    setRepurposeBundle(selectedClip.repurposedContent ?? null);
    setCueDrafts(selectedClip.captionCues ?? []);
    setThumbBadge((selectedClip.introTag || 'PODCAST HIGHLIGHT').toUpperCase());
    setThumbHeadline(selectedClip.introHeadline || selectedClip.title);
    setThumbSubtext(selectedClip.introTeaser || selectedClip.hookLine);
    setThumbFooter(selectedEpisode?.channelName || 'KlipCast Studio');
    setStatusError(null);
    setSubtitleNotes(null);
    setThumbTemplateSavedMsg(null);
  }, [selectedClip?.id, selectedEpisode?.id]);

  // Load persistent AI Content Advisor history per episode
  useEffect(() => {
    if (!selectedEpisode || !isAuthenticated) {
      setAdvisorMessages([]);
      return;
    }
    let active = true;
    apiFetch(`/api/v2/advisor/${encodeURIComponent(selectedEpisode.id)}/messages`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { messages?: AdvisorMessage[] } | null) => {
        if (active && data?.messages) setAdvisorMessages(data.messages);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [selectedEpisode?.id, isAuthenticated]);

  // Draw real HTML5 canvas thumbnail whenever controls change
  useEffect(() => {
    if (activeTab !== 'thumbnail') return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dims: Record<ThumbRatio, { w: number; h: number }> = {
      '16:9': { w: 1280, h: 720 },
      '9:16': { w: 1080, h: 1920 },
      '1:1': { w: 1080, h: 1080 },
    };
    const { w, h } = dims[thumbRatio];
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const tpl = THUMB_TEMPLATES.find((t) => t.id === thumbTemplate) ?? THUMB_TEMPLATES[0];

    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, tpl.bgStart);
    grad.addColorStop(1, tpl.bgEnd);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Subtle geometric studio framing accent
    ctx.save();
    ctx.fillStyle = tpl.accent;
    ctx.globalAlpha = 0.14;
    ctx.beginPath();
    ctx.arc(w * 0.86, h * 0.18, Math.min(w, h) * 0.36, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const padX = Math.round(w * 0.08);
    const maxTextW = w - padX * 2;
    const isTall = thumbRatio === '9:16';

    // Top badge pill
    const badgeFontSize = isTall ? 34 : 28;
    ctx.font = `700 ${badgeFontSize}px "Plus Jakarta Sans", system-ui, sans-serif`;
    const badgeText = (thumbBadge || 'PODCAST').toUpperCase();
    const badgeW = Math.min(maxTextW, ctx.measureText(badgeText).width + 48);
    const badgeH = badgeFontSize + 26;
    const badgeY = Math.round(h * (isTall ? 0.22 : 0.14));

    ctx.fillStyle = tpl.accent;
    ctx.beginPath();
    ctx.roundRect(padX, badgeY, badgeW, badgeH, 10);
    ctx.fill();

    ctx.fillStyle = tpl.badgeText;
    ctx.textBaseline = 'middle';
    ctx.fillText(badgeText, padX + 24, badgeY + badgeH / 2 + 1);

    // Headline
    const headlineSize = isTall ? 88 : thumbRatio === '1:1' ? 76 : 74;
    ctx.font = `800 ${headlineSize}px "Plus Jakarta Sans", system-ui, sans-serif`;
    ctx.fillStyle = tpl.text;
    ctx.textBaseline = 'top';
    const headlineLines = wrapCanvasText(ctx, thumbHeadline || 'Judul Klip', maxTextW, 4);
    let cursorY = badgeY + badgeH + (isTall ? 56 : 36);
    const lineHeight = Math.round(headlineSize * 1.16);
    for (const line of headlineLines) {
      ctx.fillText(line, padX, cursorY);
      cursorY += lineHeight;
    }

    // Accent bar
    cursorY += 20;
    ctx.fillStyle = tpl.accent;
    ctx.fillRect(padX, cursorY, 120, 8);
    cursorY += 34;

    // Subtext
    const subSize = isTall ? 40 : 32;
    ctx.font = `500 ${subSize}px "DM Sans", system-ui, sans-serif`;
    ctx.fillStyle = tpl.id === 'studio_clean' ? '#334155' : '#cbd5e1';
    const subLines = wrapCanvasText(ctx, thumbSubtext || '', maxTextW, 3);
    for (const line of subLines) {
      ctx.fillText(line, padX, cursorY);
      cursorY += Math.round(subSize * 1.35);
    }

    // Footer bar
    const footerY = h - Math.round(h * 0.1);
    ctx.font = `700 ${isTall ? 32 : 24}px "JetBrains Mono", monospace`;
    ctx.fillStyle = tpl.id === 'studio_clean' ? '#475569' : '#94a3b8';
    ctx.fillText(
      `${thumbFooter || 'KlipCast'} · ${
        selectedClip ? `${formatTimestamp(selectedClip.startSec)}–${formatTimestamp(selectedClip.endSec)}` : 'AI STUDIO'
      }`,
      padX,
      footerY
    );
  }, [
    activeTab,
    thumbRatio,
    thumbTemplate,
    thumbBadge,
    thumbHeadline,
    thumbSubtext,
    thumbFooter,
    selectedClip,
  ]);

  const handleCopy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 1600);
    } catch {
      // Ignore clipboard restrictions
    }
  };

  const handleGenerateRepurpose = async () => {
    if (!selectedClip) return;
    if (!isAuthenticated) {
      setStatusError('Masuk dengan akun Google untuk menjalankan AI Repurposing multi-platform.');
      return;
    }
    setIsRepurposing(true);
    setStatusError(null);
    try {
      const res = await apiFetch('/api/ai/repurpose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clipId: selectedClip.id }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        bundle?: RepurposedContentBundle;
        clip?: PodcastClip;
        error?: string;
      };
      if (!res.ok || !data.bundle) {
        setStatusError(data.error || 'Gagal menghasilkan paket repurposing AI.');
        return;
      }
      setRepurposeBundle(data.bundle);
      if (data.clip) {
        await onUpdateClip(selectedClip.id, {
          repurposedContent: data.bundle,
          platformCopies: data.clip.platformCopies,
        });
      }
    } finally {
      setIsRepurposing(false);
    }
  };

  const handleGenerateHooks = async () => {
    if (!selectedClip) return;
    if (!isAuthenticated) {
      setStatusError('Masuk dengan akun Google untuk menjalankan Viral Hook Generator AI.');
      return;
    }
    setIsGeneratingHooks(true);
    setStatusError(null);
    try {
      const res = await apiFetch('/api/ai/hooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clipId: selectedClip.id,
          tones: selectedTones.length > 0 ? selectedTones : ['profesional', 'edukatif'],
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        variants?: HookGeneratorVariant[];
        hooks?: HookGeneratorVariant[];
        error?: string;
      };
      const variants = data.variants ?? data.hooks;
      if (!res.ok || !variants) {
        setStatusError(data.error || 'Gagal membuat variasi hook AI.');
        return;
      }
      setHooksResult(variants);
    } finally {
      setIsGeneratingHooks(false);
    }
  };

  const handleDownloadThumbnail = (format: 'png' | 'jpeg') => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const mime = format === 'png' ? 'image/png' : 'image/jpeg';
    const dataUrl = canvas.toDataURL(mime, 0.94);
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `thumbnail_${selectedClip?.id ?? 'klip'}_${thumbRatio.replace(':', 'x')}.${format === 'png' ? 'png' : 'jpg'}`;
    a.click();
  };

  const handlePolishSubtitles = async () => {
    if (!selectedClip) return;
    if (!isAuthenticated) {
      setStatusError('Masuk dengan akun Google untuk menjalankan pemolesan subtitle AI.');
      return;
    }
    setIsPolishingSubtitles(true);
    setStatusError(null);
    setSubtitleNotes(null);
    try {
      const res = await apiFetch('/api/ai/subtitle-polish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clipId: selectedClip.id }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        cues?: CaptionCue[];
        notes?: string;
        error?: string;
      };
      if (!res.ok || !data.cues) {
        setStatusError(data.error || 'Gagal memoles subtitle dengan AI.');
        return;
      }
      setCueDrafts(data.cues);
      setSubtitleNotes(
        data.notes || 'Subtitle berhasil dipoles tanda baca dan keterbacaannya tanpa mengubah makna asli.'
      );
    } finally {
      setIsPolishingSubtitles(false);
    }
  };

  const handleSaveSubtitles = async () => {
    if (!selectedClip) return;
    setIsSavingSubtitles(true);
    try {
      await onUpdateClip(selectedClip.id, { captionCues: cueDrafts });
      setSubtitleNotes('Perubahan cue subtitle tersimpan ke klip.');
    } finally {
      setIsSavingSubtitles(false);
    }
  };

  const handleExportSubtitleFile = (ext: 'srt' | 'vtt') => {
    if (!selectedClip) return;
    const patchedClip: PodcastClip = { ...selectedClip, captionCues: cueDrafts };
    const content = ext === 'srt' ? generateSrtFromClip(patchedClip) : generateVttFromClip(patchedClip);
    const blob = new Blob([content], {
      type: ext === 'srt' ? 'text/plain;charset=utf-8' : 'text/vtt;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedClip.id}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleAskAssistant = async (promptText?: string) => {
    const q = (promptText ?? assistantQuestion).trim();
    if (!q || !selectedEpisode) return;
    if (!isAuthenticated) {
      setStatusError('Masuk dengan akun Google untuk menggunakan AI Content Advisor.');
      return;
    }
    setIsAskingAssistant(true);
    setStatusError(null);
    try {
      const res = await apiFetch(
        `/api/v2/advisor/${encodeURIComponent(selectedEpisode.id)}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: q }),
        }
      );
      const data = (await res.json().catch(() => ({}))) as {
        messages?: AdvisorMessage[];
        error?: string;
      };
      if (!res.ok || !data.messages) {
        setStatusError(data.error || 'AI Content Advisor tidak dapat menjawab saat ini.');
        return;
      }
      setAdvisorMessages(data.messages);
      setAssistantQuestion('');
    } finally {
      setIsAskingAssistant(false);
    }
  };

  const handleClearAdvisorHistory = async () => {
    if (!selectedEpisode || !isAuthenticated) return;
    const res = await apiFetch(
      `/api/v2/advisor/${encodeURIComponent(selectedEpisode.id)}/messages`,
      { method: 'DELETE' }
    );
    if (res.ok) setAdvisorMessages([]);
  };

  const handleSaveThumbnailTemplate = async () => {
    if (!isAuthenticated) {
      setStatusError('Masuk dengan Google terlebih dahulu untuk menyimpan template thumbnail.');
      return;
    }
    const res = await apiFetch('/api/v2/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `Thumbnail ${thumbTemplate} (${thumbRatio})`,
        category: 'thumbnail',
        description: `Badge: ${thumbBadge} · Kanal: ${thumbFooter}`,
        isPublic: false,
        config: { thumbRatio, thumbTemplate, thumbBadge, thumbFooter },
      }),
    });
    if (res.ok) {
      setThumbTemplateSavedMsg('Template thumbnail berhasil disimpan ke Pustaka Template.');
    }
  };

  if (!selectedClip || !selectedEpisode) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-10 text-center space-y-2">
        <p className="text-sm font-semibold text-slate-900 dark:text-white">
          Belum ada klip untuk diproses di AI Content Studio.
        </p>
        <p className="text-xs text-slate-500">
          Analisis satu podcast YouTube di Studio Klip terlebih dahulu.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-red-600">
            AI Content Studio 2.0
          </p>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white mt-0.5">
            Repurposing, Hook Generator, Thumbnail & Subtitle Studio
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Ubah satu klip podcast menjadi paket konten siap terbit untuk 6 platform, thumbnail beresolusi tinggi, dan subtitle siap pakai.
          </p>
        </div>

        <div className="w-full lg:w-80">
          <label
            htmlFor="ai-studio-clip-select"
            className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
          >
            Klip Aktif
          </label>
          <select
            id="ai-studio-clip-select"
            value={selectedClip.id}
            onChange={(e) => {
              const found = clips.find((c) => c.id === e.target.value);
              if (found) onSelectClip(found.episodeId, found.id);
            }}
            className="w-full h-10 px-3 text-xs sm:text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:border-red-600 focus:outline-none"
          >
            {clips.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title} ({formatTimestamp(c.startSec)}–{formatTimestamp(c.endSec)})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Studio Sub-Navigation */}
      <div
        role="tablist"
        aria-label="Modul AI Content Studio"
        className="flex flex-wrap items-center gap-1.5 p-1.5 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl"
      >
        {(
          [
            { id: 'custom', label: 'Generator Kustom 2.0', icon: SlidersHorizontal },
            { id: 'repurpose', label: 'Repurposing 6 Platform', icon: Sparkles },
            { id: 'hooks', label: 'Viral Hook Generator', icon: Wand2 },
            { id: 'thumbnail', label: 'Thumbnail Studio', icon: ImageIcon },
            { id: 'subtitles', label: 'Subtitle Studio', icon: Subtitles },
            { id: 'assistant', label: 'AI Content Advisor', icon: MessageSquare },
          ] as const
        ).map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setActiveTab(tab.id);
                setStatusError(null);
              }}
              className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg cursor-pointer studio-transition whitespace-nowrap ${
                active
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Icon className="w-3.5 h-3.5 text-red-600" aria-hidden="true" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {statusError && (
        <div
          role="alert"
          className="p-3.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs font-medium text-red-800 dark:text-red-200 flex flex-wrap items-center justify-between gap-2"
        >
          <span>{statusError}</span>
          {!isAuthenticated && (
            <button
              type="button"
              onClick={onGoogleSignIn}
              className="px-3 py-1 rounded bg-red-600 text-white font-semibold cursor-pointer"
            >
              Masuk Google
            </button>
          )}
        </div>
      )}

      {/* TAB 0: CUSTOM CONTENT STUDIO GENERATOR 2.0 */}
      {activeTab === 'custom' && (
        <CustomContentGeneratorPanel
          episode={selectedEpisode}
          clip={selectedClip}
          isAuthenticated={isAuthenticated}
          onRequireSignIn={onGoogleSignIn}
        />
      )}

      {/* TAB 1: REPURPOSING */}
      {activeTab === 'repurpose' && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
                AI Content Repurposing Multi-Platform
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Menghasilkan judul & caption YouTube Shorts, TikTok, Instagram Reels, Facebook Reels, X/Twitter, LinkedIn, naskah teaser, quote card, dan ringkasan artikel.
              </p>
            </div>
            <button
              type="button"
              disabled={isRepurposing}
              onClick={() => void handleGenerateRepurpose()}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer disabled:opacity-60"
            >
              {isRepurposing ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="w-4 h-4" aria-hidden="true" />
              )}
              <span>{isRepurposing ? 'Membuat Paket Konten...' : 'Generate Paket Repurposing AI'}</span>
            </button>
          </div>

          {repurposeBundle ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {(
                [
                  {
                    key: 'yt',
                    title: 'YouTube Shorts',
                    body: `${selectedClip.platformCopies.youtube_shorts.title}\n\n${selectedClip.platformCopies.youtube_shorts.caption}\n\n${selectedClip.platformCopies.youtube_shorts.hashtags.join(' ')}`,
                  },
                  {
                    key: 'tt',
                    title: 'TikTok',
                    body: `${selectedClip.platformCopies.tiktok.title}\n\n${selectedClip.platformCopies.tiktok.caption}\n\n${selectedClip.platformCopies.tiktok.hashtags.join(' ')}`,
                  },
                  {
                    key: 'ig',
                    title: 'Instagram Reels',
                    body: `${selectedClip.platformCopies.instagram_reels.title}\n\n${selectedClip.platformCopies.instagram_reels.caption}\n\n${selectedClip.platformCopies.instagram_reels.hashtags.join(' ')}`,
                  },
                  {
                    key: 'fb',
                    title: 'Facebook Reels',
                    body: repurposeBundle.facebookReelsCaption || `${selectedClip.platformCopies.facebook_reels.title}\n\n${selectedClip.platformCopies.facebook_reels.caption}\n\n${selectedClip.platformCopies.facebook_reels.hashtags.join(' ')}`,
                  },
                  {
                    key: 'x',
                    title: 'Utas X / Twitter',
                    body: `${selectedClip.platformCopies.x_twitter.title}\n\n${selectedClip.platformCopies.x_twitter.caption}\n\n${selectedClip.platformCopies.x_twitter.hashtags.join(' ')}`,
                  },
                  {
                    key: 'li',
                    title: 'Postingan LinkedIn',
                    body: `${selectedClip.platformCopies.linkedin.title}\n\n${selectedClip.platformCopies.linkedin.caption}\n\n${selectedClip.platformCopies.linkedin.hashtags.join(' ')}`,
                  },
                  {
                    key: 'teaser',
                    title: 'Naskah Teaser / Voiceover',
                    body: repurposeBundle.teaserScript,
                  },
                  {
                    key: 'quote',
                    title: 'Quote Card & Ringkasan Artikel',
                    body: `Kutipan: “${repurposeBundle.quoteCardText}” — ${repurposeBundle.quoteCardAuthor}\n\nRingkasan Artikel:\n${repurposeBundle.articleSummary}`,
                  },
                ] as const
              ).map((card) => (
                <div
                  key={card.key}
                  className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-bold uppercase tracking-wide text-slate-800 dark:text-slate-200">
                      {card.title}
                    </h3>
                    <button
                      type="button"
                      onClick={() => void handleCopy(card.key, card.body)}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-600 hover:underline cursor-pointer"
                    >
                      {copiedKey === card.key ? (
                        <Check className="w-3 h-3" aria-hidden="true" />
                      ) : (
                        <Copy className="w-3 h-3" aria-hidden="true" />
                      )}
                      <span>{copiedKey === card.key ? 'Tersalin' : 'Salin'}</span>
                    </button>
                  </div>
                  <p className="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-line leading-relaxed">
                    {card.body}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-6 rounded-xl bg-slate-50 dark:bg-slate-950 border border-dashed border-slate-300 dark:border-slate-700 text-center text-xs text-slate-600 dark:text-slate-400">
              Klik tombol <strong>Generate Paket Repurposing AI</strong> di atas untuk membuat paket copywriting lengkap dari klip “{selectedClip.title}”.
            </div>
          )}
        </section>
      )}

      {/* TAB 2: VIRAL HOOK GENERATOR */}
      {activeTab === 'hooks' && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
                Viral Hook & Judul Generator (6 Gaya Bahasa)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Pilih nada bicara untuk menghasilkan opening hook 3 detik, judul, caption, CTA, tagar, dan teks thumbnail.
              </p>
            </div>
            <button
              type="button"
              disabled={isGeneratingHooks}
              onClick={() => void handleGenerateHooks()}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer disabled:opacity-60"
            >
              {isGeneratingHooks ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              ) : (
                <Wand2 className="w-4 h-4" aria-hidden="true" />
              )}
              <span>{isGeneratingHooks ? 'Menyusun Variasi Hook...' : 'Generate Variasi Hook AI'}</span>
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            {(Object.keys(HOOK_TONE_LABELS) as HookStyleTone[]).map((tone) => {
              const active = selectedTones.includes(tone);
              return (
                <button
                  key={tone}
                  type="button"
                  onClick={() =>
                    setSelectedTones((prev) =>
                      prev.includes(tone) ? prev.filter((t) => t !== tone) : [...prev, tone]
                    )
                  }
                  className={`px-3 py-1.5 text-xs font-semibold rounded-lg border cursor-pointer ${
                    active
                      ? 'bg-red-600 text-white border-red-600'
                      : 'bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                  }`}
                >
                  {HOOK_TONE_LABELS[tone]}
                </button>
              );
            })}
          </div>

          {hooksResult.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {hooksResult.map((h, idx) => (
                <div
                  key={`${h.tone}-${idx}`}
                  className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="px-2 py-0.5 rounded bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-300 text-[11px] font-bold uppercase">
                      {HOOK_TONE_LABELS[h.tone] ?? h.tone}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setThumbHeadline(h.thumbnailText || h.videoTitle);
                        setActiveTab('thumbnail');
                      }}
                      className="text-[11px] font-semibold text-slate-700 dark:text-slate-300 hover:text-red-600 cursor-pointer"
                    >
                      Pakai di Thumbnail →
                    </button>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold text-slate-500">Opening Hook 3 Detik:</div>
                    <p className="text-sm font-bold text-slate-900 dark:text-white">“{h.openingHook}”</p>
                  </div>
                  <div className="text-xs text-slate-800 dark:text-slate-200">
                    <strong>Judul:</strong> {h.videoTitle}
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                    {h.caption}
                  </p>
                  <div className="text-[11px] text-slate-600 dark:text-slate-400">
                    <strong>CTA:</strong> {h.cta} · <strong>Thumbnail:</strong> {h.thumbnailText}
                  </div>
                  <div className="text-[11px] font-mono text-slate-500">{h.hashtags.join(' ')}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-6 rounded-xl bg-slate-50 dark:bg-slate-950 border border-dashed border-slate-300 dark:border-slate-700 text-center text-xs text-slate-600 dark:text-slate-400">
              Pilih gaya bahasa di atas lalu klik <strong>Generate Variasi Hook AI</strong>.
            </div>
          )}
        </section>
      )}

      {/* TAB 3: THUMBNAIL STUDIO */}
      {activeTab === 'thumbnail' && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-6 items-start">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
                Pratinjau Kanvas Thumbnail ({thumbRatio})
              </h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleDownloadThumbnail('png')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Unduh .PNG</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleDownloadThumbnail('jpeg')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 rounded-lg cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Unduh .JPG</span>
                </button>
              </div>
            </div>
            <div className="rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 bg-slate-950 flex items-center justify-center p-3">
              <canvas
                ref={canvasRef}
                data-testid="thumbnail-studio-canvas"
                className={`rounded-lg shadow-lg max-h-[460px] w-auto max-w-full ${
                  thumbRatio === '9:16'
                    ? 'aspect-[9/16]'
                    : thumbRatio === '1:1'
                      ? 'aspect-square'
                      : 'aspect-video'
                }`}
              />
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <span className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Rasio Aspek Ekspor
              </span>
              <div className="grid grid-cols-3 gap-2">
                {(['16:9', '9:16', '1:1'] as ThumbRatio[]).map((ratio) => (
                  <button
                    key={ratio}
                    type="button"
                    onClick={() => setThumbRatio(ratio)}
                    className={`py-2 text-xs font-semibold rounded-lg border cursor-pointer ${
                      thumbRatio === ratio
                        ? 'bg-red-600 text-white border-red-600'
                        : 'bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    {ratio}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Template Studio
              </span>
              <div className="grid grid-cols-2 gap-2">
                {THUMB_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => setThumbTemplate(tpl.id)}
                    className={`p-2.5 text-left text-xs font-semibold rounded-lg border cursor-pointer ${
                      thumbTemplate === tpl.id
                        ? 'border-red-600 bg-red-50/70 dark:bg-red-950/30 text-slate-900 dark:text-white'
                        : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    {tpl.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label htmlFor="thumb-badge" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Label Badge Atas
              </label>
              <input
                id="thumb-badge"
                type="text"
                value={thumbBadge}
                onChange={(e) => setThumbBadge(e.target.value)}
                className="w-full h-9 px-3 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"
              />
            </div>

            <div>
              <label htmlFor="thumb-headline" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Judul Utama Thumbnail
              </label>
              <textarea
                id="thumb-headline"
                rows={2}
                value={thumbHeadline}
                onChange={(e) => setThumbHeadline(e.target.value)}
                className="w-full p-2.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"
              />
            </div>

            <div>
              <label htmlFor="thumb-subtext" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Subjudul / Hook Pendukung
              </label>
              <textarea
                id="thumb-subtext"
                rows={2}
                value={thumbSubtext}
                onChange={(e) => setThumbSubtext(e.target.value)}
                className="w-full p-2.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"
              />
            </div>

            <div>
              <label htmlFor="thumb-footer" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Nama Kanal / Watermark Bawah
              </label>
              <input
                id="thumb-footer"
                type="text"
                value={thumbFooter}
                onChange={(e) => setThumbFooter(e.target.value)}
                className="w-full h-9 px-3 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"
              />
            </div>
            <div className="pt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 dark:border-slate-800">
              <button
                type="button"
                onClick={() => void handleSaveThumbnailTemplate()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg cursor-pointer"
              >
                <BookmarkPlus className="w-3.5 h-3.5 text-red-600" aria-hidden="true" />
                <span>Simpan ke Pustaka Template</span>
              </button>
              {thumbTemplateSavedMsg && (
                <span role="status" className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                  {thumbTemplateSavedMsg}
                </span>
              )}
            </div>
          </div>
        </section>
      )}

      {/* TAB 4: SUBTITLE STUDIO */}
      {activeTab === 'subtitles' && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
                Editor Subtitle & Ekspor SRT / VTT
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Edit baris subtitle secara presisi atau gunakan AI Polish untuk merapikan tanda baca tanpa mengubah makna ucapan pembicara.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={isPolishingSubtitles}
                onClick={() => void handlePolishSubtitles()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer disabled:opacity-60"
              >
                {isPolishingSubtitles ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                <span>Poles Tanda Baca (AI)</span>
              </button>
              <button
                type="button"
                onClick={() => handleExportSubtitleFile('srt')}
                className="px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 rounded-lg cursor-pointer"
              >
                Ekspor .SRT
              </button>
              <button
                type="button"
                onClick={() => handleExportSubtitleFile('vtt')}
                className="px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 rounded-lg cursor-pointer"
              >
                Ekspor .VTT
              </button>
            </div>
          </div>

          {subtitleNotes && (
            <p role="status" className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
              {subtitleNotes}
            </p>
          )}

          <div className="space-y-2.5 max-h-[420px] overflow-y-auto pr-1">
            {cueDrafts.map((cue, idx) => (
              <div
                key={`${cue.offsetSec}-${idx}`}
                className="grid grid-cols-1 sm:grid-cols-[120px_minmax(0,1fr)] gap-2 items-center p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800"
              >
                <span className="text-xs font-mono tabular-nums text-slate-500">
                  +{cue.offsetSec.toFixed(1)}d – {(cue.offsetSec + cue.durationSec).toFixed(1)}d
                </span>
                <input
                  type="text"
                  aria-label={`Teks subtitle baris ${idx + 1}`}
                  value={cue.text}
                  onChange={(e) => {
                    const nextText = e.target.value;
                    setCueDrafts((prev) =>
                      prev.map((item, i) => (i === idx ? { ...item, text: nextText } : item))
                    );
                  }}
                  className="w-full h-9 px-3 text-xs sm:text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md focus:border-red-600 focus:outline-none"
                />
              </div>
            ))}
          </div>

          <div className="flex justify-end pt-2 border-t border-slate-100 dark:border-slate-800">
            <button
              type="button"
              disabled={isSavingSubtitles}
              onClick={() => void handleSaveSubtitles()}
              className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 dark:bg-red-600 hover:bg-slate-800 rounded-lg cursor-pointer disabled:opacity-60"
            >
              {isSavingSubtitles ? 'Menyimpan...' : 'Simpan Perubahan Subtitle'}
            </button>
          </div>
        </section>
      )}

      {/* TAB 5: PERSISTENT AI CONTENT ADVISOR */}
      {activeTab === 'assistant' && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
                AI Content Advisor — Riwayat Persisten per Episode
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Percakapan tersimpan otomatis di database untuk episode “{selectedEpisode.title}” dan seluruh saran berlandaskan data klip aktual.
              </p>
            </div>
            {advisorMessages.length > 0 && (
              <button
                type="button"
                onClick={() => void handleClearAdvisorHistory()}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-lg hover:text-red-600 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Bersihkan Riwayat</span>
              </button>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {[
              'Apa 3 sudut konten paling kuat dari episode ini untuk YouTube Shorts?',
              'Evaluasi hook pembuka klip terpilih dan beri 2 alternatif lebih kuat.',
              'Susun strategi publikasi 3 hari lintas Shorts, TikTok, dan Reels dari episode ini.',
            ].map((starter) => (
              <button
                key={starter}
                type="button"
                onClick={() => void handleAskAssistant(starter)}
                className="px-3 py-1.5 text-xs text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg cursor-pointer text-left"
              >
                {starter}
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <label htmlFor="ai-assistant-input" className="sr-only">
              Tanyakan sesuatu tentang episode ini
            </label>
            <input
              id="ai-assistant-input"
              type="text"
              value={assistantQuestion}
              onChange={(e) => setAssistantQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAskAssistant();
              }}
              placeholder="Tanyakan ide hook, strategi distribusi, atau evaluasi klip episode ini..."
              className="flex-1 h-10 px-3 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg focus:border-red-600 focus:outline-none"
            />
            <button
              type="button"
              disabled={isAskingAssistant || !assistantQuestion.trim()}
              onClick={() => void handleAskAssistant()}
              className="inline-flex items-center gap-1.5 px-4 h-10 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer disabled:opacity-60"
            >
              {isAskingAssistant ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              ) : (
                <Send className="w-4 h-4" aria-hidden="true" />
              )}
              <span>Kirim</span>
            </button>
          </div>

          {advisorMessages.length > 0 && (
            <div className="space-y-3 pt-2 max-h-[460px] overflow-y-auto pr-1">
              {advisorMessages.map((msg) => (
                <div
                  key={msg.id}
                  className={`p-3.5 rounded-xl border text-xs sm:text-sm whitespace-pre-line leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-slate-900 dark:bg-slate-800 text-white border-slate-800 ml-6'
                      : 'bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200 border-slate-200 dark:border-slate-800 mr-6'
                  }`}
                >
                  <div className="text-[11px] font-semibold opacity-75 mb-1">
                    {msg.role === 'user' ? 'Anda' : `AI Content Advisor${msg.modelUsed ? ` · ${msg.modelUsed}` : ''}`}
                  </div>
                  {msg.content}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
