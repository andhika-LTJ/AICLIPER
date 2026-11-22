import { useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, Loader2, SlidersHorizontal, Sparkles, Trash2 } from 'lucide-react';
import type {
  ContentGenerationKind,
  ContentGenerationRecord,
  ContentStudioCustomParams,
  ContentTextLength,
  HookStyleTone,
  PodcastClip,
  PodcastEpisode,
  SocialPlatform,
} from '../types/clipper';
import { apiFetch } from '../utils/apiClient';
import { PLATFORM_LABELS } from '../utils/youtube';

interface CustomContentGeneratorPanelProps {
  episode: PodcastEpisode;
  clip: PodcastClip;
  isAuthenticated: boolean;
  onRequireSignIn: () => void;
}

export function CustomContentGeneratorPanel({
  episode,
  clip,
  isAuthenticated,
  onRequireSignIn,
}: CustomContentGeneratorPanelProps) {
  const [kind, setKind] = useState<ContentGenerationKind>('full_package');
  const [language, setLanguage] = useState<'id' | 'en' | 'bilingual'>('id');
  const [platform, setPlatform] = useState<SocialPlatform>('youtube_shorts');
  const [tone, setTone] = useState<HookStyleTone>('edukatif');
  const [audience, setAudience] = useState('Kreator & Profesional Muda');
  const [objective, setObjective] =
    useState<ContentStudioCustomParams['objective']>('engagement');
  const [textLength, setTextLength] = useState<ContentTextLength>('medium');
  const [writingStyle, setWritingStyle] =
    useState<ContentStudioCustomParams['writingStyle']>('conversational');
  const [topicFocus, setTopicFocus] = useState('');

  const [history, setHistory] = useState<ContentGenerationRecord[]>([]);
  const [activeResult, setActiveResult] = useState<ContentGenerationRecord | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;
    let active = true;
    apiFetch('/api/v2/content-studio/generations')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { generations?: ContentGenerationRecord[] } | null) => {
        if (!active || !data?.generations) return;
        setHistory(data.generations);
        if (data.generations[0]) setActiveResult(data.generations[0]);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [isAuthenticated]);

  const handleGenerate = async (e: FormEvent) => {
    e.preventDefault();
    if (!isAuthenticated) {
      setErrorMsg('Masuk dengan Google terlebih dahulu untuk menggunakan Generator Konten AI.');
      onRequireSignIn();
      return;
    }
    setIsGenerating(true);
    setErrorMsg(null);
    try {
      const res = await apiFetch('/api/v2/content-studio/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          episodeId: episode.id,
          clipId: clip.id,
          kind,
          language,
          platform,
          tone,
          audience: audience.trim() || 'Kreator & Profesional Muda',
          objective,
          textLength,
          writingStyle,
          topicFocus: topicFocus.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        generation?: ContentGenerationRecord;
        error?: string;
      };
      if (!res.ok || !data.generation) {
        setErrorMsg(data.error || 'Gagal membuat materi konten kustom.');
        return;
      }
      setActiveResult(data.generation);
      setHistory((prev) => [data.generation!, ...prev.slice(0, 29)]);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDelete = async (id: string) => {
    const res = await apiFetch(`/api/v2/content-studio/generations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      setHistory((prev) => prev.filter((item) => item.id !== id));
      if (activeResult?.id === id) setActiveResult(null);
    }
  };

  const copyText = (key: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedField(key);
    window.setTimeout(() => setCopiedField(null), 1600);
  };

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-display text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-red-600" aria-hidden="true" />
            <span>AI Content Studio 2.0 — Generator Kustom</span>
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Atur Bahasa, Platform, Tone, Audiens, Tujuan, Panjang Teks, dan Gaya Penulisan untuk menghasilkan Naskah, Judul, Hook, Caption, Deskripsi, CTA, & Hashtag yang tersimpan otomatis.
          </p>
        </div>
      </div>

      <form onSubmit={handleGenerate} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div>
          <label htmlFor="cg-kind" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
            Fokus Output
          </label>
          <select
            id="cg-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as ContentGenerationKind)}
            className="w-full h-9 px-2.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"
          >
            <option value="full_package">Paket Lengkap (Script + Copy)</option>
            <option value="script">Naskah Video / Voiceover</option>
            <option value="title_hook">Judul & Hook Pembuka</option>
            <option value="caption_cta">Caption & CTA Diskusi</option>
            <option value="description_hashtags">Deskripsi SEO & Hashtag</option>
          </select>
        </div>

        <div>
          <label htmlFor="cg-lang" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
            Bahasa
          </label>
          <select
            id="cg-lang"
            value={language}
            onChange={(e) => setLanguage(e.target.value as 'id' | 'en' | 'bilingual')}
            className="w-full h-9 px-2.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"
          >
            <option value="id">Bahasa Indonesia</option>
            <option value="en">English</option>
            <option value="bilingual">Indonesia + Istilah Kreator EN</option>
          </select>
        </div>

        <div>
          <label htmlFor="cg-platform" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
            Platform Target
          </label>
          <select
            id="cg-platform"
            value={platform}
            onChange={(e) => setPlatform(e.target.value as SocialPlatform)}
            className="w-full h-9 px-2.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"
          >
            {(Object.keys(PLATFORM_LABELS) as SocialPlatform[]).map((p) => (
              <option key={p} value={p}>
                {PLATFORM_LABELS[p]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="cg-tone" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
            Tone / Nada
          </label>
          <select
            id="cg-tone"
            value={tone}
            onChange={(e) => setTone(e.target.value as HookStyleTone)}
            className="w-full h-9 px-2.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"
          >
            <option value="edukatif">Edukatif</option>
            <option value="profesional">Profesional</option>
            <option value="storytelling">Storytelling</option>
            <option value="emosional">Emosional</option>
            <option value="santai">Santai</option>
            <option value="provokatif_etis">Provokatif Etis</option>
          </select>
        </div>

        <div>
          <label htmlFor="cg-audience" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
            Target Audiens
          </label>
          <input
            id="cg-audience"
            type="text"
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
            className="w-full h-9 px-2.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"
          />
        </div>

        <div>
          <label htmlFor="cg-objective" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
            Tujuan Konten
          </label>
          <select
            id="cg-objective"
            value={objective}
            onChange={(e) =>
              setObjective(e.target.value as ContentStudioCustomParams['objective'])
            }
            className="w-full h-9 px-2.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"
          >
            <option value="views">Jangkauan & Views</option>
            <option value="engagement">Komentar & Share</option>
            <option value="education">Edukasi & Save</option>
            <option value="conversion">Konversi / Klik Link</option>
            <option value="authority">Personal Branding / Otoritas</option>
          </select>
        </div>

        <div>
          <label htmlFor="cg-length" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
            Panjang Teks
          </label>
          <select
            id="cg-length"
            value={textLength}
            onChange={(e) => setTextLength(e.target.value as ContentTextLength)}
            className="w-full h-9 px-2.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"
          >
            <option value="short">Singkat (Padat)</option>
            <option value="medium">Sedang (Seimbang)</option>
            <option value="long">Panjang (Mendalam)</option>
          </select>
        </div>

        <div>
          <label htmlFor="cg-style" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
            Gaya Penulisan
          </label>
          <select
            id="cg-style"
            value={writingStyle}
            onChange={(e) =>
              setWritingStyle(e.target.value as ContentStudioCustomParams['writingStyle'])
            }
            className="w-full h-9 px-2.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"
          >
            <option value="conversational">Mengobrol Alami</option>
            <option value="punchy">Singkat & Tajam</option>
            <option value="editorial">Editorial Majalah</option>
            <option value="storyteller">Naratif / Bercerita</option>
            <option value="analytical">Analitis Berbasis Poin</option>
          </select>
        </div>

        <div className="sm:col-span-2 lg:col-span-3">
          <label htmlFor="cg-focus" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
            Sudut / Fokus Tambahan (Opsional)
          </label>
          <input
            id="cg-focus"
            type="text"
            value={topicFocus}
            onChange={(e) => setTopicFocus(e.target.value)}
            placeholder="Contoh: Tekankan kesalahan pemula di 3 detik pertama..."
            className="w-full h-9 px-3 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg"
          />
        </div>

        <div className="flex items-end">
          <button
            type="submit"
            disabled={isGenerating}
            className="w-full inline-flex items-center justify-center gap-1.5 h-9 px-4 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer disabled:opacity-60"
          >
            {isGenerating ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
            )}
            <span>{isGenerating ? 'Menghasilkan...' : 'Generate Konten Kustom'}</span>
          </button>
        </div>
      </form>

      {errorMsg && (
        <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
          {errorMsg}
        </p>
      )}

      {/* Result Display */}
      {activeResult && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3 border-t border-slate-100 dark:border-slate-800">
          {(
            [
              { key: 'title', label: 'Judul Video', val: activeResult.output.title },
              { key: 'hook', label: 'Opening Hook (3 Detik Pertama)', val: activeResult.output.hook },
              { key: 'script', label: 'Naskah Lengkap / Voiceover', val: activeResult.output.script },
              { key: 'caption', label: 'Caption Sosial Media', val: activeResult.output.caption },
              { key: 'description', label: 'Deskripsi SEO', val: activeResult.output.description },
              {
                key: 'cta',
                label: 'Call-To-Action & Hashtags',
                val: `${activeResult.output.cta}\n\n${activeResult.output.hashtags.join(' ')}`,
              },
            ] as const
          ).map((block) => (
            <div
              key={block.key}
              className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-slate-900 dark:text-white">
                  {block.label}
                </span>
                <button
                  type="button"
                  onClick={() => copyText(block.key, block.val)}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:text-red-600 cursor-pointer"
                >
                  {copiedField === block.key ? (
                    <Check className="w-3 h-3 text-emerald-600" aria-hidden="true" />
                  ) : (
                    <Copy className="w-3 h-3" aria-hidden="true" />
                  )}
                  <span>{copiedField === block.key ? 'Disalin' : 'Salin'}</span>
                </button>
              </div>
              <p className="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-line leading-relaxed">
                {block.val}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Saved History */}
      {history.length > 0 && (
        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Riwayat Generasi Tersimpan ({history.length})
          </h3>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {history.slice(0, 6).map((item) => (
              <div key={item.id} className="py-2 flex items-center justify-between gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setActiveResult(item)}
                  className="text-left min-w-0 flex-1 hover:text-red-600 cursor-pointer"
                >
                  <span className="font-semibold text-slate-900 dark:text-white truncate block">
                    {item.output.title}
                  </span>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    {PLATFORM_LABELS[item.params.platform]} · {item.params.tone} ·{' '}
                    {item.params.language.toUpperCase()} · {new Date(item.createdAt).toLocaleString('id-ID')}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`Hapus riwayat ${item.output.title}`}
                  onClick={() => void handleDelete(item.id)}
                  className="p-1.5 text-slate-400 hover:text-red-600 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
