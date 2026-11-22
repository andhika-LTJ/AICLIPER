import { useState, type FormEvent, type RefObject } from 'react';
import { ChevronDown, ChevronUp, Loader2, Scissors, Youtube } from 'lucide-react';
import { SAMPLE_PODCAST_PRESETS } from '../data/seedPodcasts';
import type { ClippingApproach } from '../types/clipper';

interface PodcastInputBarProps {
  inputRef: RefObject<HTMLInputElement | null>;
  isAnalyzing: boolean;
  autoPostEnabled: boolean;
  errorMessage: string | null;
  onAnalyze: (payload: {
    url: string;
    manualTranscript?: string;
    autoPostOverride: boolean;
    clippingApproach: ClippingApproach;
  }) => Promise<void>;
}

const CLIPPING_APPROACHES: Array<{ id: ClippingApproach; label: string; hint: string }> = [
  { id: 'educational', label: 'Edukatif', hint: 'Framework & langkah praktis' },
  { id: 'storytelling', label: 'Storytelling', hint: 'Alur cerita & konflik personal' },
  { id: 'motivational', label: 'Motivasi', hint: 'Mindset shift & inspirasi' },
  { id: 'informative', label: 'Informatif', hint: 'Data, fakta & wawasan cepat' },
  { id: 'entertainment', label: 'Hiburan', hint: 'Momen lucu & punchline' },
  { id: 'promotional', label: 'Promosi', hint: 'Studi kasus & hook bisnis' },
];

export function PodcastInputBar({
  inputRef,
  isAnalyzing,
  autoPostEnabled,
  errorMessage,
  onAnalyze,
}: PodcastInputBarProps) {
  const [url, setUrl] = useState('');
  const [manualTranscript, setManualTranscript] = useState('');
  const [showTranscriptInput, setShowTranscriptInput] = useState(false);
  const [autoPostOnComplete, setAutoPostOnComplete] = useState(autoPostEnabled);
  const [clippingApproach, setClippingApproach] = useState<ClippingApproach>('educational');
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) {
      setLocalError('Masukkan URL podcast YouTube terlebih dahulu.');
      inputRef.current?.focus();
      return;
    }
    setLocalError(null);
    await onAnalyze({
      url: trimmed,
      manualTranscript: manualTranscript.trim() || undefined,
      autoPostOverride: autoPostOnComplete,
      clippingApproach,
    });
  };

  const displayError = localError || errorMessage;

  return (
    <section
      aria-label="Input link podcast YouTube"
      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6"
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-end gap-4">
          <div className="flex-1 min-w-0">
            <label
              htmlFor="youtube-podcast-url"
              className="block text-sm font-semibold text-slate-900 dark:text-white mb-1.5"
            >
              Link Podcast YouTube
            </label>
            <div className="relative">
              <Youtube
                className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                ref={inputRef}
                id="youtube-podcast-url"
                type="url"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (localError) setLocalError(null);
                }}
                placeholder="https://www.youtube.com/watch?v=... atau https://youtu.be/..."
                disabled={isAnalyzing}
                className="w-full h-11 pl-10 pr-4 text-sm text-slate-900 dark:text-white bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg placeholder:text-slate-400 focus:bg-white dark:focus:bg-slate-900 focus:border-red-600 focus:outline-none studio-transition disabled:opacity-60"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <label className="inline-flex items-center gap-2.5 h-11 px-3.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-700 dark:text-slate-200 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoPostOnComplete}
                onChange={(e) => setAutoPostOnComplete(e.target.checked)}
                disabled={isAnalyzing}
                className="w-4 h-4 accent-red-600 rounded"
              />
              <span className="whitespace-nowrap">Auto-Post Shorts & Sosmed</span>
            </label>

            <button
              type="submit"
              disabled={isAnalyzing}
              className="inline-flex items-center justify-center gap-2 h-11 px-5 text-sm font-semibold text-white bg-slate-900 dark:bg-red-600 hover:bg-slate-800 dark:hover:bg-red-700 disabled:bg-slate-400 rounded-lg studio-transition whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
            >
              {isAnalyzing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  <span>Memotong & Meringkas...</span>
                </>
              ) : (
                <>
                  <Scissors className="w-4 h-4" aria-hidden="true" />
                  <span>Analisis & Potong Klip</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* AI Clipping Approach Selector (6 Modes) */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span className="text-xs font-semibold text-slate-600 dark:text-slate-400 mr-1">
            Pendekatan Klip AI:
          </span>
          {CLIPPING_APPROACHES.map((mode) => {
            const active = clippingApproach === mode.id;
            return (
              <button
                key={mode.id}
                type="button"
                aria-pressed={active}
                title={mode.hint}
                disabled={isAnalyzing}
                onClick={() => setClippingApproach(mode.id)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md border studio-transition cursor-pointer disabled:opacity-50 ${
                  active
                    ? 'bg-slate-900 dark:bg-red-600 text-white border-slate-900 dark:border-red-600'
                    : 'bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-slate-400'
                }`}
              >
                {mode.label}
              </button>
            );
          })}
        </div>

        {displayError && (
          <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
            {displayError}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100 dark:border-slate-800">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-500 dark:text-slate-400">
            <span className="font-medium text-slate-600 dark:text-slate-300">Contoh cepat:</span>
            {SAMPLE_PODCAST_PRESETS.map((preset) => (
              <button
                key={preset.url}
                type="button"
                disabled={isAnalyzing}
                onClick={() => {
                  setUrl(preset.url);
                  setLocalError(null);
                }}
                className="text-slate-600 dark:text-slate-300 hover:text-red-600 dark:hover:text-red-400 underline underline-offset-2 cursor-pointer whitespace-nowrap disabled:opacity-50"
              >
                {preset.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShowTranscriptInput((prev) => !prev)}
            aria-expanded={showTranscriptInput}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white cursor-pointer whitespace-nowrap"
          >
            <span>Tempel Transkrip Manual (Opsional)</span>
            {showTranscriptInput ? (
              <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
            )}
          </button>
        </div>

        {showTranscriptInput && (
          <div className="pt-2">
            <label
              htmlFor="manual-transcript-input"
              className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5"
            >
              Jika video tidak memiliki subtitle publik, tempel potongan transkrip atau catatan timestamp di sini agar pemotongan lebih presisi:
            </label>
            <textarea
              id="manual-transcript-input"
              rows={4}
              value={manualTranscript}
              onChange={(e) => setManualTranscript(e.target.value)}
              placeholder="Contoh: [04:12] Hal pertama yang sering dilupakan podcaster pemula adalah..."
              disabled={isAnalyzing}
              className="w-full p-3 text-sm text-slate-900 dark:text-white bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg placeholder:text-slate-400 focus:bg-white dark:focus:bg-slate-900 focus:border-red-600 focus:outline-none"
            />
          </div>
        )}
      </form>
    </section>
  );
}
