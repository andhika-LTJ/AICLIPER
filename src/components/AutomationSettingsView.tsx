import { useEffect, useState, type FormEvent } from 'react';
import { Check, RotateCcw, Send, Sparkles } from 'lucide-react';
import type {
  BotAutomationConfig,
  ClipRenderQuality,
  SocialPlatform,
} from '../types/clipper';
import { PLATFORM_LABELS } from '../utils/youtube';

interface AutomationSettingsViewProps {
  config: BotAutomationConfig;
  onSaveConfig: (next: BotAutomationConfig) => Promise<void>;
  onResetDemo: () => Promise<void>;
}

const ALL_PLATFORMS: SocialPlatform[] = [
  'youtube_shorts',
  'tiktok',
  'instagram_reels',
  'x_twitter',
  'linkedin',
];

export function AutomationSettingsView({
  config,
  onSaveConfig,
  onResetDemo,
}: AutomationSettingsViewProps) {
  const [draft, setDraft] = useState<BotAutomationConfig>(config);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [webhookTestResult, setWebhookTestResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [isTestingWebhook, setIsTestingWebhook] = useState(false);
  const [hasCookies, setHasCookies] = useState(false);
  const [cookiesInput, setCookiesInput] = useState('');
  const [cookiesStatusMsg, setCookiesStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    setDraft(config);
  }, [config]);

  useEffect(() => {
    fetch('/api/automation/cookies-status')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d.hasYoutubeCookies === 'boolean') {
          setHasCookies(d.hasYoutubeCookies);
        }
      })
      .catch(() => {});
  }, []);

  const togglePlatform = (platform: SocialPlatform) => {
    setDraft((prev) => {
      const exists = prev.defaultPlatforms.includes(platform);
      const nextPlatforms = exists
        ? prev.defaultPlatforms.filter((p) => p !== platform)
        : [...prev.defaultPlatforms, platform];
      return { ...prev, defaultPlatforms: nextPlatforms };
    });
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setSaveMessage(null);
    try {
      await onSaveConfig(draft);
      setSaveMessage('Pengaturan otomasi bot berhasil disimpan.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestWebhook = async () => {
    setIsTestingWebhook(true);
    setWebhookTestResult(null);
    try {
      const res = await fetch('/api/automation/test-webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookUrl: draft.webhookUrl,
          webhookSecretHeader: draft.webhookSecretHeader,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setWebhookTestResult({ ok: false, text: data.error || 'Gagal menguji webhook.' });
      } else if (data.delivered) {
        setWebhookTestResult({
          ok: true,
          text: `Koneksi berhasil (HTTP ${data.statusCode}). Endpoint webhook siap menerima payload klip.`,
        });
      } else {
        setWebhookTestResult({
          ok: false,
          text: data.error || `Endpoint merespons dengan status HTTP ${data.statusCode ?? 'error'}.`,
        });
      }
    } catch {
      setWebhookTestResult({ ok: false, text: 'Gagal menghubungi server pengujian webhook.' });
    } finally {
      setIsTestingWebhook(false);
    }
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
          Otomasi Bot & Integrasi Kanal
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          Atur aturan pemotongan otomatis, target platform media sosial, dan endpoint webhook untuk worker pengunggah YouTube Shorts / n8n / Telegram.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="bg-white border border-slate-200 rounded-xl p-6 space-y-6"
      >
        {/* Rule 1: Auto-post behavior */}
        <div className="space-y-3 pb-5 border-b border-slate-100">
          <h2 className="font-display text-base font-bold text-slate-900">
            Aturan Pemotongan & Publikasi
          </h2>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={draft.autoPostOnAnalyze}
              onChange={(e) =>
                setDraft((p) => ({ ...p, autoPostOnAnalyze: e.target.checked }))
              }
              className="mt-1 w-4 h-4 accent-red-600 rounded"
            />
            <div>
              <div className="text-sm font-semibold text-slate-900">
                Auto-Post klip Sorotan Utama segera setelah analisis selesai
              </div>
              <p className="text-xs text-slate-500">
                Jika dimatikan, semua klip masuk sebagai draf agar Anda bisa tinjau atau post manual ke YouTube Shorts.
              </p>
            </div>
          </label>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={draft.autoAddHashtagShorts}
              onChange={(e) =>
                setDraft((p) => ({ ...p, autoAddHashtagShorts: e.target.checked }))
              }
              className="mt-1 w-4 h-4 accent-red-600 rounded"
            />
            <div>
              <div className="text-sm font-semibold text-slate-900">
                Sertakan tagar #Shorts secara otomatis pada judul YouTube
              </div>
              <p className="text-xs text-slate-500">
                Memastikan video vertikal terindeks di feed YouTube Shorts saat diunggah otomatis atau manual.
              </p>
            </div>
          </label>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={draft.enableAiEmotionEffects}
              onChange={(e) =>
                setDraft((p) => ({ ...p, enableAiEmotionEffects: e.target.checked }))
              }
              className="mt-1 w-4 h-4 accent-red-600 rounded"
            />
            <div>
              <div className="text-sm font-semibold text-slate-900">
                Aktifkan Efek Emosi AI Otomatis (Animasi Kinetik & SFX Retensi)
              </div>
              <p className="text-xs text-slate-500">
                AI otomatis menyisipkan efek suara halus (Pop Komedi, Bass Drop, Ding Insight) dan animasi reaksi di momen puncak agar penonton menonton lebih lama.
              </p>
            </div>
          </label>
        </div>

        {/* Rule 1B: Ultra HD (4K / 1080p) Rendering Settings */}
        <div className="space-y-4 pb-5 border-b border-slate-100">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1 max-w-2xl">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-red-600 shrink-0" aria-hidden="true" />
                <h2 className="font-display text-base font-bold text-slate-900">
                  Kualitas Render Video (Full HD 1080p / Ultra HD 4K)
                </h2>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">
                Aktifkan mode <strong>Ultra HD</strong> agar API rendering secara default menghasilkan output klip <strong>4K (2160p)</strong> super tajam dengan upscaling Lanczos + Unsharp. Jika dimatikan, render otomatis menggunakan <strong>1080p Full HD</strong>.
              </p>
            </div>

            <button
              id="cfg-ultra-hd-toggle"
              type="button"
              role="switch"
              aria-checked={draft.enableUltraHdRender}
              aria-label="Aktifkan Mode Ultra HD 4K"
              onClick={() =>
                setDraft((p) => {
                  const nextUltra = !p.enableUltraHdRender;
                  return {
                    ...p,
                    enableUltraHdRender: nextUltra,
                    defaultRenderQuality: nextUltra ? '4k' : '1080p',
                  };
                })
              }
              className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-2 ${
                draft.enableUltraHdRender ? 'bg-red-600' : 'bg-slate-300'
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-xs transition-transform ${
                  draft.enableUltraHdRender ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="cfg-render-quality"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Resolusi Output Default API Render
              </label>
              <select
                id="cfg-render-quality"
                value={draft.enableUltraHdRender ? '4k' : draft.defaultRenderQuality}
                onChange={(e) => {
                  const q = e.target.value as ClipRenderQuality;
                  setDraft((p) => ({
                    ...p,
                    defaultRenderQuality: q,
                    enableUltraHdRender: q === '4k',
                  }));
                }}
                className="w-full h-10 px-3 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-red-600 focus:outline-none"
              >
                <option value="1080p">1080p Full HD (Cepat & Tajam)</option>
                <option value="4k">Ultra HD 4K 2160p (Kejernihan Maksimal)</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="cfg-render-layout"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                Format Rasio Default Klip
              </label>
              <select
                id="cfg-render-layout"
                value={draft.defaultRenderLayout}
                onChange={(e) =>
                  setDraft((p) => ({
                    ...p,
                    defaultRenderLayout: e.target.value as BotAutomationConfig['defaultRenderLayout'],
                  }))
                }
                className="w-full h-10 px-3 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-red-600 focus:outline-none"
              >
                <option value="shorts_full_bleed">Full Frame 9:16 (Auto-Fokus Natural)</option>
                <option value="shorts_studio_focus">Shorts 9:16 Studio (Latar Blur)</option>
                <option value="full_16_9_focus">Video Full 16:9 (Layar Lebar)</option>
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs">
            <span className="font-medium text-slate-700">
              Output Aktif:{' '}
              <strong className="text-slate-900 font-mono tabular-nums">
                {draft.defaultRenderLayout === 'full_16_9_focus'
                  ? draft.enableUltraHdRender
                    ? '3840 × 2160 px (4K Ultra HD 16:9)'
                    : '1920 × 1080 px (1080p Full HD 16:9)'
                  : draft.enableUltraHdRender
                    ? '2160 × 3840 px (4K Ultra HD 9:16)'
                    : '1080 × 1920 px (1080p Full HD 9:16)'}
              </strong>
            </span>
            <span className="font-mono text-[11px] text-slate-500">
              API: POST /api/render · quality: &quot;{draft.enableUltraHdRender ? '4k' : '1080p'}&quot;
            </span>
          </div>
        </div>

        {/* Rule 2: Clip parameters */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 pb-5 border-b border-slate-100">
          <div>
            <label htmlFor="cfg-clip-count" className="block text-xs font-semibold text-slate-700 mb-1">
              Jumlah Klip / Podcast
            </label>
            <input
              id="cfg-clip-count"
              type="number"
              min={1}
              max={5}
              value={draft.targetClipCount}
              onChange={(e) =>
                setDraft((p) => ({ ...p, targetClipCount: Number(e.target.value) || 3 }))
              }
              className="w-full h-10 px-3 text-sm font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-red-600 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="cfg-min-sec" className="block text-xs font-semibold text-slate-700 mb-1">
              Durasi Min (detik)
            </label>
            <input
              id="cfg-min-sec"
              type="number"
              min={15}
              max={45}
              value={draft.minClipSec}
              onChange={(e) =>
                setDraft((p) => ({ ...p, minClipSec: Number(e.target.value) || 25 }))
              }
              className="w-full h-10 px-3 text-sm font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-red-600 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="cfg-max-sec" className="block text-xs font-semibold text-slate-700 mb-1">
              Durasi Maks (detik)
            </label>
            <input
              id="cfg-max-sec"
              type="number"
              min={20}
              max={60}
              value={draft.maxClipSec}
              onChange={(e) =>
                setDraft((p) => ({ ...p, maxClipSec: Number(e.target.value) || 55 }))
              }
              className="w-full h-10 px-3 text-sm font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-red-600 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="cfg-yt-vis" className="block text-xs font-semibold text-slate-700 mb-1">
              Visibilitas YouTube
            </label>
            <select
              id="cfg-yt-vis"
              value={draft.youtubeDefaultVisibility}
              onChange={(e) =>
                setDraft((p) => ({
                  ...p,
                  youtubeDefaultVisibility: e.target.value as BotAutomationConfig['youtubeDefaultVisibility'],
                }))
              }
              className="w-full h-10 px-3 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-red-600 focus:outline-none"
            >
              <option value="public">Publik</option>
              <option value="unlisted">Tidak Publik</option>
              <option value="private">Pribadi</option>
            </select>
          </div>
        </div>

        {/* Rule 3: Default social platforms */}
        <div className="space-y-3 pb-5 border-b border-slate-100">
          <h2 className="font-display text-base font-bold text-slate-900">
            Platform Distribusi Default
          </h2>
          <div className="flex flex-wrap items-center gap-4">
            {ALL_PLATFORMS.map((platform) => (
              <label key={platform} className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.defaultPlatforms.includes(platform)}
                  onChange={() => togglePlatform(platform)}
                  className="w-4 h-4 accent-red-600 rounded"
                />
                <span>{PLATFORM_LABELS[platform]}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Rule 4: Webhook connector */}
        <div className="space-y-4">
          <div>
            <h2 className="font-display text-base font-bold text-slate-900">
              Webhook Worker Otomatis (n8n / Make / Telegram / YouTube Uploader)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Saat Auto-Post dijalankan, KlipCast mengirim payload JSON berisi timestamp potong, ringkasan teks, subtitle .SRT, dan caption semua platform ke URL ini.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr] gap-4">
            <div>
              <label htmlFor="cfg-webhook-url" className="block text-xs font-semibold text-slate-700 mb-1">
                Endpoint Webhook (HTTPS)
              </label>
              <input
                id="cfg-webhook-url"
                type="url"
                value={draft.webhookUrl}
                onChange={(e) => setDraft((p) => ({ ...p, webhookUrl: e.target.value }))}
                placeholder="https://hook.domainanda.com/klipcast-autopost"
                className="w-full h-10 px-3 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-red-600 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="cfg-webhook-secret" className="block text-xs font-semibold text-slate-700 mb-1">
                Header X-KlipCast-Secret (Opsional)
              </label>
              <input
                id="cfg-webhook-secret"
                type="password"
                value={draft.webhookSecretHeader}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, webhookSecretHeader: e.target.value }))
                }
                placeholder="Token rahasia"
                className="w-full h-10 px-3 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-red-600 focus:outline-none"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={isTestingWebhook}
              onClick={handleTestWebhook}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer disabled:opacity-60"
            >
              <Send className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{isTestingWebhook ? 'Menguji...' : 'Uji Koneksi Webhook'}</span>
            </button>

            {webhookTestResult && (
              <span
                role="status"
                className={`text-xs font-medium ${
                  webhookTestResult.ok ? 'text-emerald-700' : 'text-red-600'
                }`}
              >
                {webhookTestResult.text}
              </span>
            )}
          </div>
        </div>

        {/* Rule 5: YouTube Cookies for direct server MP4 extraction */}
        <div className="space-y-3 pt-5 border-t border-slate-100">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-base font-bold text-slate-900">
                Autentikasi Unduhan Video YouTube (cookies.txt)
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Diperlukan jika YouTube memblokir unduhan segmen MP4 dari IP server cloud. Status:{' '}
                <strong className={hasCookies ? 'text-emerald-700' : 'text-slate-700'}>
                  {hasCookies ? 'Cookies Terpasang' : 'Belum Terpasang'}
                </strong>
              </p>
            </div>
          </div>

          <div>
            <label htmlFor="cfg-cookies-txt" className="block text-xs font-semibold text-slate-700 mb-1">
              Tempel Isi File cookies.txt (Format Netscape)
            </label>
            <textarea
              id="cfg-cookies-txt"
              rows={3}
              value={cookiesInput}
              onChange={(e) => setCookiesInput(e.target.value)}
              placeholder="# Netscape HTTP Cookie File..."
              className="w-full p-3 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-red-600 focus:outline-none"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={async () => {
                const res = await fetch('/api/automation/youtube-cookies', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ cookiesTxt: cookiesInput }),
                });
                const data = (await res.json().catch(() => ({}))) as {
                  hasYoutubeCookies?: boolean;
                  error?: string;
                };
                if (res.ok) {
                  setHasCookies(Boolean(data.hasYoutubeCookies));
                  setCookiesInput('');
                  setCookiesStatusMsg(
                    data.hasYoutubeCookies
                      ? 'Cookies YouTube disimpan di server.'
                      : 'Cookies YouTube dihapus.'
                  );
                } else {
                  setCookiesStatusMsg(data.error || 'Format cookies.txt tidak valid.');
                }
              }}
              className="px-3.5 py-2 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
            >
              Simpan / Hapus Cookies
            </button>
            {cookiesStatusMsg && (
              <span role="status" className="text-xs font-medium text-emerald-700">
                {cookiesStatusMsg}
              </span>
            )}
          </div>
        </div>

        <div className="pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-4">
          <button
            type="button"
            onClick={onResetDemo}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Kembalikan Data Contoh Awal</span>
          </button>

          <div className="flex items-center gap-4">
            {saveMessage && (
              <span role="status" className="text-xs font-medium text-emerald-700">
                {saveMessage}
              </span>
            )}
            <button
              type="submit"
              disabled={isSaving}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer disabled:opacity-60"
            >
              <Check className="w-4 h-4" aria-hidden="true" />
              <span>{isSaving ? 'Menyimpan...' : 'Simpan Pengaturan'}</span>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
