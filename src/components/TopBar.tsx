import { Scissors } from 'lucide-react';

export type NavSection = 'studio' | 'summaries' | 'queue' | 'automation';

interface TopBarProps {
  activeSection: NavSection;
  onNavigate: (section: NavSection) => void;
  onStartNewLink: () => void;
}

const NAV_ITEMS: { id: NavSection; label: string }[] = [
  { id: 'studio', label: 'Studio Klip' },
  { id: 'summaries', label: 'Ringkasan' },
  { id: 'queue', label: 'Distribusi' },
  { id: 'automation', label: 'Otomasi' },
];

export function TopBar({ activeSection, onNavigate, onStartNewLink }: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-sm border-b border-slate-200">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-8 h-16 flex items-center justify-between gap-4 sm:gap-8">
        {/* Zone 1: Single text element wordmark */}
        <button
          type="button"
          onClick={() => onNavigate('studio')}
          className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red-600 cursor-pointer"
        >
          KlipCast
        </button>

        {/* Zone 2: Concise single-line navigation links */}
        <nav
          aria-label="Navigasi utama"
          className="flex items-center gap-3.5 sm:gap-7 overflow-x-auto"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`relative py-5 text-xs sm:text-sm font-medium whitespace-nowrap shrink-0 studio-transition cursor-pointer focus-visible:outline-2 focus-visible:outline-red-600 ${
                  isActive
                    ? 'text-slate-900'
                    : 'text-slate-500 hover:text-slate-900'
                }`}
              >
                {item.label}
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-red-600"
                  />
                )}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Single primary action */}
        <div className="shrink-0 hidden sm:block">
          <button
            type="button"
            onClick={onStartNewLink}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg studio-transition whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600"
          >
            <Scissors className="w-4 h-4" aria-hidden="true" />
            <span>Proses Link Baru</span>
          </button>
        </div>
      </div>
    </header>
  );
}
