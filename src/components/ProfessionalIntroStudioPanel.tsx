import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Eye,
  EyeOff,
  Film,
  History,
  Layers,
  Loader2,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Trash2,
  Undo2,
  Volume2,
} from 'lucide-react';
import {
  createEditableIntroFromTemplate,
  GLOBAL_INTRO_TEMPLATES,
  INTRO_ANIMATION_OPTIONS,
  INTRO_DURATION_PRESETS,
  INTRO_TEMPLATE_CATEGORIES,
} from '../data/introTemplatesCatalog';
import type {
  IntroAnimationType,
  IntroAudioConfig,
  IntroBackgroundConfig,
  IntroElementLayer,
  IntroTemplateCategory,
  IntroTemplateDefinition,
  IntroTemplateVersionRecord,
  OverlayFontFamilyId,
  PodcastClip,
  UserIntroTemplateRecord,
} from '../types/clipper';
import { apiFetch } from '../utils/apiClient';

interface ProfessionalIntroStudioPanelProps {
  clip: PodcastClip;
  episodeTitle: string;
  isAuthenticated: boolean;
  onApplyIntroConfig: (template: IntroTemplateDefinition) => Promise<void>;
  onApplyAndRender?: (template: IntroTemplateDefinition) => void;
}

type StudioSubTab = 'catalog' | 'editor' | 'personal';

const FONT_OPTIONS: Array<{ id: OverlayFontFamilyId; label: string; cssFont: string }> = [
  { id: 'modern_sans', label: 'Modern Sans', cssFont: 'Plus Jakarta Sans, sans-serif' },
  { id: 'condensed_viral', label: 'Condensed Viral', cssFont: 'Plus Jakarta Sans, sans-serif' },
  { id: 'editorial_serif', label: 'Editorial Serif', cssFont: 'Georgia, serif' },
  { id: 'studio_mono', label: 'Studio Mono', cssFont: 'JetBrains Mono, monospace' },
];

const SFX_OPTIONS: Array<{ id: IntroAudioConfig['sfxType']; label: string }> = [
  { id: 'none', label: 'Tanpa SFX' },
  { id: 'whoosh', label: 'Whoosh Transisi' },
  { id: 'pop', label: 'Pop Hook' },
  { id: 'boom', label: 'Cinematic Boom' },
  { id: 'chime', label: 'Ding Insight' },
  { id: 'riser', label: 'Tension Riser' },
];

function createDefaultTemplateForClip(
  clip: PodcastClip,
  episodeTitle: string
): IntroTemplateDefinition {
  if (clip.introTemplateConfig) {
    return structuredClone(clip.introTemplateConfig);
  }
  const base = GLOBAL_INTRO_TEMPLATES[0];
  return createEditableIntroFromTemplate(base, {
    badge: clip.introTag || 'SOROTAN UTAMA',
    headline: clip.introHeadline || clip.title || episodeTitle,
    subline: clip.introTeaser || clip.hookLine,
  });
}

function pickPreferredEditableLayerId(layers: IntroElementLayer[]): string {
  return (
    layers.find((l) => l.type === 'headline')?.id ??
    layers.find((l) => l.type !== 'shape')?.id ??
    layers[0]?.id ??
    ''
  );
}

function makeCustomLayer(kind: 'custom_text' | 'shape'): IntroElementLayer {
  const uid = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  if (kind === 'shape') {
    return {
      id: `shape_${uid}`,
      type: 'shape',
      name: 'Garis Aksen',
      text: '',
      visible: true,
      x: 50,
      y: 34,
      widthPct: 32,
      heightPct: 1.5,
      fontFamily: 'modern_sans',
      fontSizePx: 24,
      fontWeight: 700,
      textColor: '#DC2626',
      letterSpacingPx: 0,
      lineHeight: 1.1,
      textAlign: 'center',
      opacity: 0.95,
      rotationDeg: 0,
      shadowEnabled: false,
      shadowColor: '#000000',
      outlineEnabled: false,
      outlineColor: '#000000',
      outlineWidthPx: 0,
      textBox: {
        enabled: true,
        backgroundColor: '#DC2626',
        opacity: 0.95,
        paddingX: 0,
        paddingY: 0,
        borderRadiusPx: 6,
        borderWidthPx: 0,
        borderColor: '#FFFFFF',
        shadowEnabled: false,
      },
      animation: {
        type: 'zoom_in',
        durationSec: 0.35,
        delaySec: 0,
        direction: 'center',
        easing: 'ease_out',
        intensity: 0.8,
      },
    };
  }

  return {
    id: `text_${uid}`,
    type: 'custom_text',
    name: 'Teks Tambahan',
    text: 'Tonton sampai akhir!',
    visible: true,
    x: 50,
    y: 72,
    widthPct: 78,
    heightPct: 10,
    fontFamily: 'modern_sans',
    fontSizePx: 34,
    fontWeight: 700,
    textColor: '#FFFFFF',
    letterSpacingPx: 0,
    lineHeight: 1.2,
    textAlign: 'center',
    opacity: 1,
    rotationDeg: 0,
    shadowEnabled: true,
    shadowColor: '#000000',
    outlineEnabled: false,
    outlineColor: '#000000',
    outlineWidthPx: 2,
    textBox: {
      enabled: false,
      backgroundColor: '#09090B',
      opacity: 0.8,
      paddingX: 16,
      paddingY: 10,
      borderRadiusPx: 10,
      borderWidthPx: 0,
      borderColor: '#FFFFFF',
      shadowEnabled: false,
    },
    animation: {
      type: 'slide_up',
      durationSec: 0.4,
      delaySec: 0.15,
      direction: 'up',
      easing: 'ease_out',
      intensity: 0.8,
    },
  };
}

export function ProfessionalIntroStudioPanel({
  clip,
  episodeTitle,
  isAuthenticated,
  onApplyIntroConfig,
  onApplyAndRender,
}: ProfessionalIntroStudioPanelProps) {
  const [subTab, setSubTab] = useState<StudioSubTab>('editor');
  const [catalog, setCatalog] = useState<IntroTemplateDefinition[]>(GLOBAL_INTRO_TEMPLATES);
  const [personalTemplates, setPersonalTemplates] = useState<UserIntroTemplateRecord[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<'ALL' | IntroTemplateCategory>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  const [draft, setDraft] = useState<IntroTemplateDefinition>(() =>
    createDefaultTemplateForClip(clip, episodeTitle)
  );
  const [undoStack, setUndoStack] = useState<IntroTemplateDefinition[]>([]);
  const [redoStack, setRedoStack] = useState<IntroTemplateDefinition[]>([]);
  const [selectedLayerId, setSelectedLayerId] = useState<string>(
    () => pickPreferredEditableLayerId(draft.layers)
  );
  const [previewTick, setPreviewTick] = useState(0);

  const [personalName, setPersonalName] = useState('');
  const [versionsForId, setVersionsForId] = useState<string | null>(null);
  const [versions, setVersions] = useState<IntroTemplateVersionRecord[]>([]);

  const [isApplying, setIsApplying] = useState(false);
  const [isSavingPersonal, setIsSavingPersonal] = useState(false);
  const [isLoadingPersonal, setIsLoadingPersonal] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    layerId: string;
    startClientX: number;
    startClientY: number;
    origX: number;
    origY: number;
  } | null>(null);

  useEffect(() => {
    const next = createDefaultTemplateForClip(clip, episodeTitle);
    setDraft(next);
    setUndoStack([]);
    setRedoStack([]);
    setSelectedLayerId(pickPreferredEditableLayerId(next.layers));
    setPersonalName(`${next.name} (${clip.id.slice(0, 6)})`);
    setStatusMessage(null);
    setErrorMessage(null);
  }, [clip.id]);

  useEffect(() => {
    if (!isAuthenticated) return;
    let active = true;
    apiFetch('/api/v3/intro-templates/catalog')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { templates?: IntroTemplateDefinition[] } | null) => {
        if (active && Array.isArray(d?.templates) && d.templates.length > 0) {
          setCatalog(d.templates);
        }
      })
      .catch(() => {});

    setIsLoadingPersonal(true);
    apiFetch('/api/v3/intro-templates/personal')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { templates?: UserIntroTemplateRecord[] } | null) => {
        if (active && Array.isArray(d?.templates)) {
          setPersonalTemplates(d.templates);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setIsLoadingPersonal(false);
      });

    return () => {
      active = false;
    };
  }, [isAuthenticated]);

  const filteredCatalog = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return catalog.filter((tpl) => {
      if (selectedCategory !== 'ALL' && tpl.category !== selectedCategory) return false;
      if (!q) return true;
      return `${tpl.name} ${tpl.category} ${tpl.description}`.toLowerCase().includes(q);
    });
  }, [catalog, selectedCategory, searchQuery]);

  const selectedLayer = useMemo(
    () => draft.layers.find((l) => l.id === selectedLayerId) ?? draft.layers[0] ?? null,
    [draft.layers, selectedLayerId]
  );

  const commitDraft = (next: IntroTemplateDefinition, pushHistory = true) => {
    if (pushHistory) {
      setUndoStack((prev) => [...prev.slice(-20), draft]);
      setRedoStack([]);
    }
    setDraft(next);
  };

  const updateSelectedLayer = (patch: Partial<IntroElementLayer>, pushHistory = true) => {
    if (!selectedLayer) return;
    commitDraft(
      {
        ...draft,
        layers: draft.layers.map((l) => (l.id === selectedLayer.id ? { ...l, ...patch } : l)),
      },
      pushHistory
    );
  };

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    setRedoStack((r) => [...r, draft]);
    setDraft(prev);
  };

  const handleRedo = () => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((r) => r.slice(0, -1));
    setUndoStack((s) => [...s, draft]);
    setDraft(next);
  };

  const handleResetBase = () => {
    const base =
      catalog.find((t) => t.id === draft.id || t.category === draft.category) ??
      GLOBAL_INTRO_TEMPLATES[0];
    const next = createEditableIntroFromTemplate(base, {
      badge: clip.introTag || 'SOROTAN UTAMA',
      headline: clip.introHeadline || clip.title || episodeTitle,
      subline: clip.introTeaser || clip.hookLine,
    });
    commitDraft(next);
    setSelectedLayerId(pickPreferredEditableLayerId(next.layers));
    setStatusMessage(`Template direset ke standar "${base.name}".`);
  };

  const handleSelectCatalogTemplate = (tpl: IntroTemplateDefinition) => {
    const edited = createEditableIntroFromTemplate(tpl, {
      badge: clip.introTag || undefined,
      headline: clip.introHeadline || clip.title,
      subline: clip.introTeaser || clip.hookLine,
    });
    commitDraft(edited);
    setSelectedLayerId(pickPreferredEditableLayerId(edited.layers));
    setPersonalName(edited.name);
    setSubTab('editor');
    setStatusMessage(`Template "${tpl.name}" (${tpl.category}) dimuat ke editor.`);
  };

  const handleStagePointerDown = (
    layer: IntroElementLayer,
    e: ReactPointerEvent<HTMLButtonElement>
  ) => {
    e.stopPropagation();
    setSelectedLayerId(layer.id);
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = {
      layerId: layer.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origX: layer.x,
      origY: layer.y,
    };
  };

  const handleStagePointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragStateRef.current;
    const box = stageRef.current?.getBoundingClientRect();
    if (!drag || !box || box.width <= 0 || box.height <= 0) return;
    const dxPct = ((e.clientX - drag.startClientX) / box.width) * 100;
    const dyPct = ((e.clientY - drag.startClientY) / box.height) * 100;
    let nextX = Math.max(8, Math.min(92, Math.round(drag.origX + dxPct)));
    let nextY = Math.max(8, Math.min(92, Math.round(drag.origY + dyPct)));
    if (draft.snapToCenter && Math.abs(nextX - 50) <= 3) nextX = 50;
    if (draft.snapToCenter && Math.abs(nextY - 50) <= 3) nextY = 50;

    setDraft((prev) => ({
      ...prev,
      layers: prev.layers.map((l) =>
        l.id === drag.layerId ? { ...l, x: nextX, y: nextY } : l
      ),
    }));
  };

  const handleStagePointerUp = () => {
    dragStateRef.current = null;
  };

  const handleMoveLayerOrder = (layerId: string, dir: -1 | 1) => {
    const idx = draft.layers.findIndex((l) => l.id === layerId);
    const targetIdx = idx + dir;
    if (idx < 0 || targetIdx < 0 || targetIdx >= draft.layers.length) return;
    const copy = [...draft.layers];
    const [item] = copy.splice(idx, 1);
    copy.splice(targetIdx, 0, item);
    commitDraft({ ...draft, layers: copy });
  };

  const handleSavePersonalTemplate = async () => {
    if (!isAuthenticated) {
      setErrorMessage('Masuk dengan Google terlebih dahulu untuk menyimpan template pribadi ke cloud.');
      return;
    }
    const cleanName = personalName.trim() || draft.name;
    setIsSavingPersonal(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const res = await apiFetch('/api/v3/intro-templates/personal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseTemplateId: draft.isGlobal ? draft.id : undefined,
          name: cleanName,
          category: draft.category,
          description: draft.description,
          durationSec: draft.durationSec,
          config: { ...draft, name: cleanName, isGlobal: false },
          changeNote: 'Disimpan dari Studio Intro Pro',
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        template?: UserIntroTemplateRecord;
        error?: string;
      };
      if (!res.ok || !data.template) {
        setErrorMessage(data.error || 'Gagal menyimpan template intro pribadi.');
        return;
      }
      setPersonalTemplates((prev) => [
        data.template!,
        ...prev.filter((item) => item.id !== data.template!.id),
      ]);
      setStatusMessage(`Template pribadi "${data.template.name}" berhasil disimpan.`);
    } finally {
      setIsSavingPersonal(false);
    }
  };

  const handleDuplicateTemplate = async (templateId: string) => {
    if (!isAuthenticated) return;
    const res = await apiFetch(
      `/api/v3/intro-templates/personal/${encodeURIComponent(templateId)}/duplicate`,
      { method: 'POST' }
    );
    const data = (await res.json().catch(() => ({}))) as {
      template?: UserIntroTemplateRecord;
    };
    if (res.ok && data.template) {
      setPersonalTemplates((prev) => [data.template!, ...prev]);
      setStatusMessage(`Salinan template "${data.template.name}" dibuat.`);
    }
  };

  const handleDeletePersonalTemplate = async (templateId: string) => {
    if (!isAuthenticated) return;
    const res = await apiFetch(
      `/api/v3/intro-templates/personal/${encodeURIComponent(templateId)}`,
      { method: 'DELETE' }
    );
    if (res.ok) {
      setPersonalTemplates((prev) => prev.filter((t) => t.id !== templateId));
      if (versionsForId === templateId) {
        setVersionsForId(null);
        setVersions([]);
      }
      setStatusMessage('Template pribadi dihapus.');
    }
  };

  const handleLoadVersions = async (templateId: string) => {
    if (!isAuthenticated) return;
    setVersionsForId(templateId);
    const res = await apiFetch(
      `/api/v3/intro-templates/personal/${encodeURIComponent(templateId)}/versions`
    );
    const data = (await res.json().catch(() => ({}))) as {
      versions?: IntroTemplateVersionRecord[];
    };
    if (res.ok && Array.isArray(data.versions)) {
      setVersions(data.versions);
    }
  };

  const handleRestoreVersion = async (templateId: string, versionNumber: number) => {
    if (!isAuthenticated) return;
    const res = await apiFetch(
      `/api/v3/intro-templates/personal/${encodeURIComponent(templateId)}/versions/${versionNumber}/restore`,
      { method: 'POST' }
    );
    const data = (await res.json().catch(() => ({}))) as {
      template?: UserIntroTemplateRecord;
    };
    if (res.ok && data.template) {
      setPersonalTemplates((prev) =>
        prev.map((t) => (t.id === data.template!.id ? data.template! : t))
      );
      setDraft(structuredClone(data.template.config));
      setStatusMessage(`Template dipulihkan ke versi v${versionNumber}.`);
    }
  };

  const handleApplyToClip = async () => {
    setIsApplying(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      await onApplyIntroConfig(draft);
      setStatusMessage(
        `Konfigurasi intro "${draft.name}" (${draft.durationSec.toFixed(1)}d) diterapkan ke klip aktif.`
      );
    } catch {
      setErrorMessage('Gagal menerapkan konfigurasi intro ke klip.');
    } finally {
      setIsApplying(false);
    }
  };

  const backgroundStyle = useMemo(() => {
    const bg = draft.background;
    if (bg.mode === 'solid') {
      return { background: bg.primaryColor };
    }
    if (bg.mode === 'gradient') {
      return {
        background: `linear-gradient(${bg.gradientAngleDeg || 135}deg, ${bg.primaryColor}, ${bg.secondaryColor})`,
      };
    }
    return {
      background: `linear-gradient(160deg, ${bg.primaryColor}, #09090B)`,
    };
  }, [draft.background]);

  return (
    <section
      aria-label="Studio Intro Profesional 22 Kategori"
      className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-4"
    >
      {/* Header + Sub-tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="font-display text-sm font-bold text-slate-900 flex items-center gap-1.5">
            <Film className="w-4 h-4 text-red-600 shrink-0" aria-hidden="true" />
            <span>Studio Intro Profesional · 22 Kategori</span>
          </h4>
          <p className="text-xs text-slate-600 mt-0.5 font-mono tabular-nums">
            Aktif: {draft.name} · {draft.category} · {draft.durationSec.toFixed(1)} detik ·{' '}
            {draft.layers.filter((l) => l.visible).length} layer
          </p>
        </div>

        <div
          role="tablist"
          aria-label="Mode Studio Intro"
          className="inline-flex items-center p-1 bg-white border border-slate-200 rounded-lg"
        >
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'catalog'}
            onClick={() => setSubTab('catalog')}
            className={`px-2.5 py-1 text-xs font-semibold rounded-md cursor-pointer whitespace-nowrap ${
              subTab === 'catalog'
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Galeri ({catalog.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'editor'}
            onClick={() => setSubTab('editor')}
            className={`px-2.5 py-1 text-xs font-semibold rounded-md cursor-pointer whitespace-nowrap ${
              subTab === 'editor'
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Editor Visual
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'personal'}
            onClick={() => setSubTab('personal')}
            className={`px-2.5 py-1 text-xs font-semibold rounded-md cursor-pointer whitespace-nowrap ${
              subTab === 'personal'
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Pribadi ({personalTemplates.length})
          </button>
        </div>
      </div>

      {/* TAB 1: 22-Category Template Gallery */}
      {subTab === 'catalog' && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div className="relative">
              <label htmlFor={`intro-search-${clip.id}`} className="sr-only">
                Cari template intro
              </label>
              <Search
                className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2"
                aria-hidden="true"
              />
              <input
                id={`intro-search-${clip.id}`}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Cari template (Breaking News, Podcast, Tech...)"
                className="w-full h-9 pl-8 pr-3 text-xs bg-white border border-slate-200 rounded-lg focus:border-slate-900 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor={`intro-cat-${clip.id}`} className="sr-only">
                Filter kategori intro
              </label>
              <select
                id={`intro-cat-${clip.id}`}
                value={selectedCategory}
                onChange={(e) =>
                  setSelectedCategory(e.target.value as 'ALL' | IntroTemplateCategory)
                }
                className="w-full h-9 px-2.5 text-xs bg-white border border-slate-200 rounded-lg text-slate-800 focus:border-slate-900 focus:outline-none"
              >
                <option value="ALL">Semua 22 Kategori ({catalog.length})</option>
                {INTRO_TEMPLATE_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-[340px] overflow-y-auto pr-0.5">
            {filteredCatalog.map((tpl) => {
              const isActive = draft.id === tpl.id;
              return (
                <div
                  key={tpl.id}
                  className={`p-3 rounded-lg border bg-white space-y-2 ${
                    isActive ? 'border-red-600' : 'border-slate-200'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-slate-900 truncate">{tpl.name}</div>
                      <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                        {tpl.category} · {tpl.durationSec.toFixed(1)}d · {tpl.background.mode}
                      </div>
                    </div>
                    <span
                      aria-hidden="true"
                      className="w-6 h-6 rounded border border-slate-200 shrink-0"
                      style={{
                        background:
                          tpl.background.mode === 'solid'
                            ? tpl.background.primaryColor
                            : `linear-gradient(135deg, ${tpl.background.primaryColor}, ${tpl.background.secondaryColor})`,
                      }}
                    />
                  </div>
                  <p className="text-[11px] text-slate-600 line-clamp-2 leading-snug">
                    {tpl.description}
                  </p>
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => handleSelectCatalogTemplate(tpl)}
                      className="px-2.5 py-1 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded cursor-pointer whitespace-nowrap"
                    >
                      Pilih & Edit
                    </button>
                    {isAuthenticated && (
                      <button
                        type="button"
                        onClick={() => void handleDuplicateTemplate(tpl.id)}
                        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                      >
                        <Copy className="w-3 h-3" aria-hidden="true" />
                        <span>Duplikat</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB 2: Interactive 9:16 Visual Editor */}
      {subTab === 'editor' && (
        <div className="grid grid-cols-1 xl:grid-cols-[240px_minmax(0,1fr)] gap-4 items-start">
          {/* Left: 9:16 Live Drag Stage & Layer Manager */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 text-xs">
              <button
                type="button"
                onClick={() => setPreviewTick((t) => t + 1)}
                className="inline-flex items-center gap-1 px-2.5 py-1 font-semibold text-slate-800 bg-white border border-slate-200 hover:bg-slate-100 rounded cursor-pointer"
              >
                <Play className="w-3 h-3 text-red-600" aria-hidden="true" />
                <span>Pratinjau Animasi</span>
              </button>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={undoStack.length === 0}
                  aria-label="Undo perubahan intro"
                  onClick={handleUndo}
                  className="p-1.5 bg-white border border-slate-200 rounded disabled:opacity-40 cursor-pointer"
                >
                  <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  disabled={redoStack.length === 0}
                  aria-label="Redo perubahan intro"
                  onClick={handleRedo}
                  className="p-1.5 bg-white border border-slate-200 rounded disabled:opacity-40 cursor-pointer"
                >
                  <Redo2 className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="Reset template intro ke standar"
                  onClick={handleResetBase}
                  className="p-1.5 bg-white border border-slate-200 rounded cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>

            {/* 9:16 Interactive Canvas */}
            <div
              ref={stageRef}
              key={`stage-${previewTick}`}
              data-testid="intro-canvas-stage"
              style={backgroundStyle}
              className="relative w-full max-w-[230px] mx-auto aspect-[9/16] rounded-xl overflow-hidden border border-slate-800 select-none"
            >
              {(draft.background.mode === 'blur_footage' || draft.background.mode === 'footage') && (
                <div
                  aria-hidden="true"
                  className="absolute inset-0 bg-black"
                  style={{ opacity: Math.min(0.85, Math.max(0.15, draft.background.dimOpacity)) }}
                />
              )}

              {draft.safeAreaGuides && (
                <>
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-3 top-[12%] bottom-[18%] border border-dashed border-white/25 rounded"
                  />
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-white/15"
                  />
                </>
              )}

              {draft.layers
                .filter((l) => l.visible)
                .map((layer) => {
                  const isSel = selectedLayer?.id === layer.id;
                  const fontCss =
                    FONT_OPTIONS.find((f) => f.id === layer.fontFamily)?.cssFont ??
                    'Plus Jakarta Sans, sans-serif';
                  const scaledFontPx = Math.max(9, Math.round(layer.fontSizePx * 0.21));
                  return (
                    <button
                      key={layer.id}
                      type="button"
                      aria-label={`Layer ${layer.name}: geser atau edit`}
                      onClick={() => setSelectedLayerId(layer.id)}
                      onPointerDown={(e) => handleStagePointerDown(layer, e)}
                      onPointerMove={handleStagePointerMove}
                      onPointerUp={handleStagePointerUp}
                      style={{
                        left: `${layer.x}%`,
                        top: `${layer.y}%`,
                        width: `${layer.widthPct}%`,
                        transform: `translate(-50%, -50%) rotate(${layer.rotationDeg}deg)`,
                        opacity: layer.opacity,
                        fontFamily: fontCss,
                        fontSize: `${scaledFontPx}px`,
                        fontWeight: layer.fontWeight,
                        color: layer.textColor,
                        textAlign: layer.textAlign,
                        backgroundColor:
                          layer.type === 'shape'
                            ? layer.textBox.backgroundColor
                            : layer.textBox.enabled
                              ? layer.textBox.backgroundColor
                              : 'transparent',
                        borderRadius: `${Math.min(18, layer.textBox.borderRadiusPx)}px`,
                        borderWidth: layer.textBox.borderWidthPx > 0 ? '1px' : '0px',
                        borderColor: layer.textBox.borderColor,
                        padding:
                          layer.type === 'shape'
                            ? '0px'
                            : layer.textBox.enabled
                              ? '4px 7px'
                              : '2px',
                        minHeight: layer.type === 'shape' ? '4px' : undefined,
                      }}
                      className={`absolute cursor-move leading-tight transition-transform ${
                        isSel ? 'ring-2 ring-red-500 ring-offset-1 ring-offset-transparent' : ''
                      }`}
                    >
                      {layer.type === 'shape' ? (
                        <span className="sr-only">{layer.name}</span>
                      ) : (
                        layer.text
                      )}
                    </button>
                  );
                })}
            </div>

            {/* Layer Stack */}
            <div className="bg-white border border-slate-200 rounded-lg p-2.5 space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-slate-800 flex items-center gap-1">
                  <Layers className="w-3.5 h-3.5 text-red-600" aria-hidden="true" />
                  <span>Layer ({draft.layers.length})</span>
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      const nl = makeCustomLayer('custom_text');
                      commitDraft({ ...draft, layers: [...draft.layers, nl] });
                      setSelectedLayerId(nl.id);
                    }}
                    className="inline-flex items-center gap-0.5 px-2 py-0.5 text-[11px] font-semibold bg-slate-100 hover:bg-slate-200 rounded cursor-pointer"
                  >
                    <Plus className="w-3 h-3" aria-hidden="true" />
                    <span>Teks</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const nl = makeCustomLayer('shape');
                      commitDraft({ ...draft, layers: [...draft.layers, nl] });
                      setSelectedLayerId(nl.id);
                    }}
                    className="inline-flex items-center gap-0.5 px-2 py-0.5 text-[11px] font-semibold bg-slate-100 hover:bg-slate-200 rounded cursor-pointer"
                  >
                    <Plus className="w-3 h-3" aria-hidden="true" />
                    <span>Aksen</span>
                  </button>
                </div>
              </div>

              <div className="space-y-1">
                {draft.layers.map((l, idx) => {
                  const isSel = selectedLayer?.id === l.id;
                  return (
                    <div
                      key={l.id}
                      className={`flex items-center justify-between gap-1 px-2 py-1 rounded border text-[11px] ${
                        isSel ? 'bg-slate-900 text-white border-slate-900' : 'bg-slate-50 border-slate-200'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedLayerId(l.id)}
                        className="flex-1 text-left font-medium truncate cursor-pointer"
                      >
                        {l.name}
                      </button>
                      <button
                        type="button"
                        aria-label={`Tampilkan atau sembunyikan ${l.name}`}
                        onClick={() =>
                          commitDraft({
                            ...draft,
                            layers: draft.layers.map((item) =>
                              item.id === l.id ? { ...item, visible: !item.visible } : item
                            ),
                          })
                        }
                        className="p-0.5 cursor-pointer"
                      >
                        {l.visible ? (
                          <Eye className="w-3 h-3" aria-hidden="true" />
                        ) : (
                          <EyeOff className="w-3 h-3 opacity-60" aria-hidden="true" />
                        )}
                      </button>
                      <button
                        type="button"
                        disabled={idx === 0}
                        aria-label={`Naikkan urutan ${l.name}`}
                        onClick={() => handleMoveLayerOrder(l.id, -1)}
                        className="p-0.5 disabled:opacity-30 cursor-pointer"
                      >
                        <ArrowUp className="w-3 h-3" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        disabled={idx === draft.layers.length - 1}
                        aria-label={`Turunkan urutan ${l.name}`}
                        onClick={() => handleMoveLayerOrder(l.id, 1)}
                        className="p-0.5 disabled:opacity-30 cursor-pointer"
                      >
                        <ArrowDown className="w-3 h-3" aria-hidden="true" />
                      </button>
                      {draft.layers.length > 1 && (
                        <button
                          type="button"
                          aria-label={`Hapus ${l.name}`}
                          onClick={() => {
                            const remaining = draft.layers.filter((item) => item.id !== l.id);
                            commitDraft({ ...draft, layers: remaining });
                            if (selectedLayerId === l.id) {
                              setSelectedLayerId(remaining[0]?.id ?? '');
                            }
                          }}
                          className="p-0.5 hover:text-red-500 cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right: Complete Layer + Global + Background + Audio Inspector */}
          <div className="space-y-3">
            {/* Global Duration & Guides */}
            <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2.5 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label
                  htmlFor={`intro-dur-${clip.id}`}
                  className="font-semibold text-slate-800"
                >
                  Durasi Intro ({draft.durationSec.toFixed(1)} detik)
                </label>
                <div className="flex flex-wrap gap-1">
                  {INTRO_DURATION_PRESETS.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() => commitDraft({ ...draft, durationSec: p.value })}
                      className={`px-2 py-0.5 rounded text-[11px] font-mono tabular-nums border cursor-pointer ${
                        Math.abs(draft.durationSec - p.value) < 0.05
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-slate-50 text-slate-700 border-slate-200'
                      }`}
                    >
                      {p.value.toFixed(1)}d
                    </button>
                  ))}
                </div>
              </div>
              <input
                id={`intro-dur-${clip.id}`}
                type="range"
                min={5}
                max={100}
                step={1}
                value={Math.round(draft.durationSec * 10)}
                onChange={(e) =>
                  commitDraft({ ...draft, durationSec: Number(e.target.value) / 10 }, false)
                }
                className="w-full accent-red-600 cursor-pointer"
              />
            </div>

            {/* Selected Layer Properties */}
            {selectedLayer && (
              <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-900">
                    Properti Layer: {selectedLayer.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => updateSelectedLayer({ x: 50 })}
                    className="px-2 py-0.5 text-[11px] font-medium bg-slate-100 hover:bg-slate-200 rounded cursor-pointer"
                  >
                    Tengah Horizontal
                  </button>
                </div>

                {selectedLayer.type !== 'shape' && (
                  <div className="space-y-2.5">
                    <div>
                      <label
                        htmlFor={`layer-text-${selectedLayer.id}`}
                        className="block text-[11px] font-medium text-slate-700 mb-1"
                      >
                        Isi Teks Layer
                      </label>
                      <input
                        id={`layer-text-${selectedLayer.id}`}
                        type="text"
                        value={selectedLayer.text}
                        onChange={(e) => updateSelectedLayer({ text: e.target.value }, false)}
                        className="w-full h-8 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:border-slate-900 focus:outline-none"
                      />
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      <div>
                        <label
                          htmlFor={`layer-font-${selectedLayer.id}`}
                          className="block text-[11px] text-slate-600 mb-1"
                        >
                          Font
                        </label>
                        <select
                          id={`layer-font-${selectedLayer.id}`}
                          value={selectedLayer.fontFamily}
                          onChange={(e) =>
                            updateSelectedLayer({
                              fontFamily: e.target.value as OverlayFontFamilyId,
                            })
                          }
                          className="w-full h-8 px-2 text-xs bg-slate-50 border border-slate-200 rounded-md"
                        >
                          {FONT_OPTIONS.map((f) => (
                            <option key={f.id} value={f.id}>
                              {f.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label
                          htmlFor={`layer-size-${selectedLayer.id}`}
                          className="block text-[11px] text-slate-600 mb-1 font-mono tabular-nums"
                        >
                          Ukuran ({selectedLayer.fontSizePx}px)
                        </label>
                        <input
                          id={`layer-size-${selectedLayer.id}`}
                          type="range"
                          min={16}
                          max={120}
                          value={selectedLayer.fontSizePx}
                          onChange={(e) =>
                            updateSelectedLayer({ fontSizePx: Number(e.target.value) }, false)
                          }
                          className="w-full accent-red-600 cursor-pointer"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor={`layer-color-${selectedLayer.id}`}
                          className="block text-[11px] text-slate-600 mb-1"
                        >
                          Warna Teks
                        </label>
                        <input
                          id={`layer-color-${selectedLayer.id}`}
                          type="color"
                          value={selectedLayer.textColor}
                          onChange={(e) =>
                            updateSelectedLayer({ textColor: e.target.value }, false)
                          }
                          className="w-full h-8 p-0.5 bg-white border border-slate-200 rounded cursor-pointer"
                        />
                      </div>
                    </div>

                    {/* Optional Text Box Toggle */}
                    <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold text-slate-800">
                          Kotak Latar Teks (Text Box Opsional)
                        </span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={selectedLayer.textBox.enabled}
                          aria-label="Aktifkan Text Box pada layer ini"
                          onClick={() =>
                            updateSelectedLayer({
                              textBox: {
                                ...selectedLayer.textBox,
                                enabled: !selectedLayer.textBox.enabled,
                              },
                            })
                          }
                          className={`px-2.5 py-0.5 rounded text-[11px] font-semibold cursor-pointer ${
                            selectedLayer.textBox.enabled
                              ? 'bg-red-600 text-white'
                              : 'bg-white text-slate-700 border border-slate-300'
                          }`}
                        >
                          {selectedLayer.textBox.enabled ? 'Aktif (Kotak)' : 'Nonaktif (Teks Bersih)'}
                        </button>
                      </div>

                      {selectedLayer.textBox.enabled && (
                        <div className="grid grid-cols-3 gap-2">
                          <div>
                            <label
                              htmlFor={`layer-box-bg-${selectedLayer.id}`}
                              className="block text-[10px] text-slate-600 mb-1"
                            >
                              Warna Kotak
                            </label>
                            <input
                              id={`layer-box-bg-${selectedLayer.id}`}
                              type="color"
                              value={
                                selectedLayer.textBox.backgroundColor.startsWith('#')
                                  ? selectedLayer.textBox.backgroundColor
                                  : '#09090B'
                              }
                              onChange={(e) =>
                                updateSelectedLayer(
                                  {
                                    textBox: {
                                      ...selectedLayer.textBox,
                                      backgroundColor: e.target.value,
                                    },
                                  },
                                  false
                                )
                              }
                              className="w-full h-7 p-0.5 bg-white border border-slate-200 rounded cursor-pointer"
                            />
                          </div>
                          <div>
                            <label
                              htmlFor={`layer-box-op-${selectedLayer.id}`}
                              className="block text-[10px] text-slate-600 mb-1 font-mono tabular-nums"
                            >
                              Opasitas {Math.round(selectedLayer.textBox.opacity * 100)}%
                            </label>
                            <input
                              id={`layer-box-op-${selectedLayer.id}`}
                              type="range"
                              min={15}
                              max={100}
                              value={Math.round(selectedLayer.textBox.opacity * 100)}
                              onChange={(e) =>
                                updateSelectedLayer(
                                  {
                                    textBox: {
                                      ...selectedLayer.textBox,
                                      opacity: Number(e.target.value) / 100,
                                    },
                                  },
                                  false
                                )
                              }
                              className="w-full accent-red-600 cursor-pointer"
                            />
                          </div>
                          <div>
                            <label
                              htmlFor={`layer-box-pad-${selectedLayer.id}`}
                              className="block text-[10px] text-slate-600 mb-1 font-mono tabular-nums"
                            >
                              Padding {selectedLayer.textBox.paddingX}px
                            </label>
                            <input
                              id={`layer-box-pad-${selectedLayer.id}`}
                              type="range"
                              min={4}
                              max={44}
                              value={selectedLayer.textBox.paddingX}
                              onChange={(e) =>
                                updateSelectedLayer(
                                  {
                                    textBox: {
                                      ...selectedLayer.textBox,
                                      paddingX: Number(e.target.value),
                                      paddingY: Math.max(4, Math.round(Number(e.target.value) * 0.65)),
                                    },
                                  },
                                  false
                                )
                              }
                              className="w-full accent-red-600 cursor-pointer"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {selectedLayer.type === 'shape' && (
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label
                        htmlFor={`shape-color-${selectedLayer.id}`}
                        className="block text-[11px] text-slate-600 mb-1"
                      >
                        Warna Aksen
                      </label>
                      <input
                        id={`shape-color-${selectedLayer.id}`}
                        type="color"
                        value={
                          selectedLayer.textBox.backgroundColor.startsWith('#')
                            ? selectedLayer.textBox.backgroundColor
                            : '#DC2626'
                        }
                        onChange={(e) =>
                          updateSelectedLayer(
                            {
                              textBox: {
                                ...selectedLayer.textBox,
                                backgroundColor: e.target.value,
                              },
                            },
                            false
                          )
                        }
                        className="w-full h-8 p-0.5 bg-white border border-slate-200 rounded cursor-pointer"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`shape-w-${selectedLayer.id}`}
                        className="block text-[11px] text-slate-600 mb-1 font-mono tabular-nums"
                      >
                        Lebar ({Math.round(selectedLayer.widthPct)}%)
                      </label>
                      <input
                        id={`shape-w-${selectedLayer.id}`}
                        type="range"
                        min={10}
                        max={92}
                        value={Math.round(selectedLayer.widthPct)}
                        onChange={(e) =>
                          updateSelectedLayer({ widthPct: Number(e.target.value) }, false)
                        }
                        className="w-full accent-red-600 cursor-pointer"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`shape-op-${selectedLayer.id}`}
                        className="block text-[11px] text-slate-600 mb-1 font-mono tabular-nums"
                      >
                        Opasitas ({Math.round(selectedLayer.opacity * 100)}%)
                      </label>
                      <input
                        id={`shape-op-${selectedLayer.id}`}
                        type="range"
                        min={15}
                        max={100}
                        value={Math.round(selectedLayer.opacity * 100)}
                        onChange={(e) =>
                          updateSelectedLayer({ opacity: Number(e.target.value) / 100 }, false)
                        }
                        className="w-full accent-red-600 cursor-pointer"
                      />
                    </div>
                  </div>
                )}

                {/* Coordinates & Animation */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 border-t border-slate-100">
                  <div>
                    <label
                      htmlFor={`layer-x-${selectedLayer.id}`}
                      className="block text-[10px] text-slate-600 font-mono tabular-nums"
                    >
                      Posisi X ({selectedLayer.x}%)
                    </label>
                    <input
                      id={`layer-x-${selectedLayer.id}`}
                      type="range"
                      min={10}
                      max={90}
                      value={selectedLayer.x}
                      onChange={(e) => updateSelectedLayer({ x: Number(e.target.value) }, false)}
                      className="w-full accent-slate-900 cursor-pointer"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor={`layer-y-${selectedLayer.id}`}
                      className="block text-[10px] text-slate-600 font-mono tabular-nums"
                    >
                      Posisi Y ({selectedLayer.y}%)
                    </label>
                    <input
                      id={`layer-y-${selectedLayer.id}`}
                      type="range"
                      min={10}
                      max={90}
                      value={selectedLayer.y}
                      onChange={(e) => updateSelectedLayer({ y: Number(e.target.value) }, false)}
                      className="w-full accent-slate-900 cursor-pointer"
                    />
                  </div>
                  <div className="col-span-2">
                    <label
                      htmlFor={`layer-anim-${selectedLayer.id}`}
                      className="block text-[10px] text-slate-600 mb-0.5"
                    >
                      Animasi Masuk Layer
                    </label>
                    <select
                      id={`layer-anim-${selectedLayer.id}`}
                      value={selectedLayer.animation.type}
                      onChange={(e) =>
                        updateSelectedLayer({
                          animation: {
                            ...selectedLayer.animation,
                            type: e.target.value as IntroAnimationType,
                          },
                        })
                      }
                      className="w-full h-7 px-2 text-xs bg-slate-50 border border-slate-200 rounded"
                    >
                      {INTRO_ANIMATION_OPTIONS.map((anim) => (
                        <option key={anim.id} value={anim.id}>
                          {anim.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            )}

            {/* Background & Audio SFX Settings */}
            <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2.5 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div>
                  <label
                    htmlFor={`intro-bg-mode-${clip.id}`}
                    className="block text-[11px] font-semibold text-slate-700 mb-1"
                  >
                    Mode Latar Intro
                  </label>
                  <select
                    id={`intro-bg-mode-${clip.id}`}
                    value={draft.background.mode}
                    onChange={(e) =>
                      commitDraft({
                        ...draft,
                        background: {
                          ...draft.background,
                          mode: e.target.value as IntroBackgroundConfig['mode'],
                        },
                      })
                    }
                    className="w-full h-8 px-2 text-xs bg-slate-50 border border-slate-200 rounded-md"
                  >
                    <option value="gradient">Gradient Warna</option>
                    <option value="solid">Solid Color</option>
                    <option value="blur_footage">Blur Video Footage</option>
                    <option value="footage">Video Footage Redup</option>
                  </select>
                </div>

                <div>
                  <label
                    htmlFor={`intro-bg-p-${clip.id}`}
                    className="block text-[11px] font-semibold text-slate-700 mb-1"
                  >
                    Warna Utama Latar
                  </label>
                  <input
                    id={`intro-bg-p-${clip.id}`}
                    type="color"
                    value={draft.background.primaryColor}
                    onChange={(e) =>
                      commitDraft(
                        {
                          ...draft,
                          background: { ...draft.background, primaryColor: e.target.value },
                        },
                        false
                      )
                    }
                    className="w-full h-8 p-0.5 bg-white border border-slate-200 rounded cursor-pointer"
                  />
                </div>

                <div>
                  <label
                    htmlFor={`intro-sfx-${clip.id}`}
                    className="block text-[11px] font-semibold text-slate-700 mb-1 flex items-center gap-1"
                  >
                    <Volume2 className="w-3 h-3 text-red-600" aria-hidden="true" />
                    <span>Efek Suara Intro</span>
                  </label>
                  <select
                    id={`intro-sfx-${clip.id}`}
                    value={draft.audio.sfxType}
                    onChange={(e) => {
                      const sfx = e.target.value as IntroAudioConfig['sfxType'];
                      commitDraft({
                        ...draft,
                        audio: {
                          ...draft.audio,
                          sfxType: sfx,
                          enabled: sfx !== 'none',
                          muted: sfx === 'none',
                        },
                      });
                    }}
                    className="w-full h-8 px-2 text-xs bg-slate-50 border border-slate-200 rounded-md"
                  >
                    {SFX_OPTIONS.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: Personal Templates & Versioning */}
      {subTab === 'personal' && (
        <div className="space-y-3">
          <div className="bg-white border border-slate-200 rounded-lg p-3 flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[200px]">
              <label
                htmlFor={`personal-tpl-name-${clip.id}`}
                className="block text-[11px] font-semibold text-slate-700 mb-1"
              >
                Simpan Konfigurasi Aktif sebagai Template Pribadi
              </label>
              <input
                id={`personal-tpl-name-${clip.id}`}
                type="text"
                value={personalName}
                onChange={(e) => setPersonalName(e.target.value)}
                placeholder="Nama template intro pribadi Anda..."
                className="w-full h-8 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md"
              />
            </div>
            <button
              type="button"
              disabled={isSavingPersonal || !isAuthenticated}
              onClick={() => void handleSavePersonalTemplate()}
              className="inline-flex items-center gap-1.5 h-8 px-3 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-md cursor-pointer disabled:opacity-50"
            >
              {isSavingPersonal ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Save className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>Simpan Template Pribadi</span>
            </button>
          </div>

          {isLoadingPersonal ? (
            <p className="text-xs text-slate-500">Memuat template pribadi...</p>
          ) : personalTemplates.length === 0 ? (
            <p className="text-xs text-slate-600 bg-white border border-slate-200 rounded-lg p-4 text-center">
              Belum ada template intro pribadi tersimpan. Sesuaikan intro di Editor Visual lalu klik Simpan Template Pribadi.
            </p>
          ) : (
            <div className="divide-y divide-slate-200 bg-white border border-slate-200 rounded-lg">
              {personalTemplates.map((pt) => (
                <div key={pt.id} className="p-3 space-y-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-900 truncate">{pt.name}</div>
                      <div className="text-[11px] font-mono tabular-nums text-slate-500">
                        {pt.category} · {pt.durationSec.toFixed(1)}d · v{pt.currentVersion}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          commitDraft(structuredClone(pt.config));
                          setSelectedLayerId(pickPreferredEditableLayerId(pt.config.layers));
                          setSubTab('editor');
                          setStatusMessage(`Template "${pt.name}" dimuat ke editor.`);
                        }}
                        className="px-2.5 py-1 text-[11px] font-semibold bg-slate-900 text-white rounded cursor-pointer"
                      >
                        Muat
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleLoadVersions(pt.id)}
                        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-slate-100 rounded cursor-pointer"
                      >
                        <History className="w-3 h-3" aria-hidden="true" />
                        <span>Versi</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDuplicateTemplate(pt.id)}
                        className="px-2 py-1 text-[11px] font-medium bg-slate-100 rounded cursor-pointer"
                      >
                        Duplikat
                      </button>
                      <button
                        type="button"
                        aria-label={`Hapus template pribadi ${pt.name}`}
                        onClick={() => void handleDeletePersonalTemplate(pt.id)}
                        className="p-1 text-slate-500 hover:text-red-600 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </div>

                  {versionsForId === pt.id && versions.length > 0 && (
                    <div className="pt-2 border-t border-slate-100 space-y-1">
                      {versions.map((ver) => (
                        <div
                          key={ver.id}
                          className="flex items-center justify-between gap-2 text-[11px] text-slate-600"
                        >
                          <span className="font-mono tabular-nums">
                            v{ver.versionNumber} · {ver.changeNote}
                          </span>
                          <button
                            type="button"
                            onClick={() => void handleRestoreVersion(pt.id, ver.versionNumber)}
                            className="text-red-600 hover:text-red-800 font-semibold cursor-pointer"
                          >
                            Pulihkan
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Footer Apply CTAs */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={isApplying}
            onClick={() => void handleApplyToClip()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer whitespace-nowrap disabled:opacity-60"
          >
            {isApplying ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Check className="w-3.5 h-3.5" aria-hidden="true" />
            )}
            <span>Terapkan Intro ke Klip</span>
          </button>

          {onApplyAndRender && (
            <button
              type="button"
              onClick={() => onApplyAndRender(draft)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer whitespace-nowrap"
            >
              <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Terapkan & Render MP4</span>
            </button>
          )}
        </div>
      </div>

      {statusMessage && (
        <p role="status" className="text-xs font-medium text-emerald-700">
          {statusMessage}
        </p>
      )}
      {errorMessage && (
        <p role="alert" className="text-xs font-medium text-red-600">
          {errorMessage}
        </p>
      )}
    </section>
  );
}
