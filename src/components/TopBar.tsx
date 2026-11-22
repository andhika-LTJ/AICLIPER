import type { User } from '@firebase/auth';
import { LogOut, Palette, Scissors, ShieldCheck } from 'lucide-react';
import type { ThemePreset, UserRole } from '../types/clipper';
import { GoogleAccountBadge, GoogleSignInButton } from './GoogleSignInButton';
import { NotificationCenter } from './NotificationCenter';

export type NavSection =
  | 'dashboard'
  | 'studio'
  | 'editor'
  | 'ai_studio'
  | 'analytics'
  | 'summaries'
  | 'queue'
  | 'automation'
  | 'admin';

interface TopBarProps {
  activeSection: NavSection;
  onNavigate: (section: NavSection) => void;
  onStartNewLink: () => void;
  youtubeUser: User | null;
  isGoogleVerified: boolean;
  userRole: UserRole;
  isSigningInGoogle: boolean;
  themePreset: ThemePreset;
  onCycleTheme: () => void;
  onGoogleSignIn: () => void;
  onGoogleSignOut: () => void;
}

const THEME_LABELS: Record<ThemePreset, string> = {
  minimal_light: 'Minimal Light',
  dark_studio: 'Dark Studio',
  creator_neon: 'Creator Neon',
  professional: 'Professional',
};

const BASE_NAV_ITEMS: { id: NavSection; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'studio', label: 'Studio' },
  { id: 'editor', label: 'Editor' },
  { id: 'ai_studio', label: 'AI Studio' },
  { id: 'analytics', label: 'Analitik' },
  { id: 'queue', label: 'Distribusi' },
  { id: 'automation', label: 'Otomasi' },
];

export function TopBar({
  activeSection,
  onNavigate,
  onStartNewLink,
  youtubeUser,
  isGoogleVerified,
  userRole,
  isSigningInGoogle,
  themePreset,
  onCycleTheme,
  onGoogleSignIn,
  onGoogleSignOut,
}: TopBarProps) {
  const isAdmin = userRole === 'admin' || userRole === 'super_admin';
  const navItems = isAdmin
    ? [...BASE_NAV_ITEMS, { id: 'admin' as NavSection, label: 'Admin' }]
    : BASE_NAV_ITEMS;

  return (
    <header className="sticky top-0 z-30 bg-white/95 dark:bg-slate-950/95 backdrop-blur-sm border-b border-slate-200 dark:border-slate-800">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-8 h-14 md:h-16 flex items-center justify-between gap-3 sm:gap-5">
        {/* Zone 1: Brand wordmark */}
        <button
          type="button"
          onClick={() => onNavigate('studio')}
          className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red-600 cursor-pointer"
        >
          KlipCast
        </button>

        {/* Zone 2: Desktop single-line navigation links */}
        <nav
          aria-label="Navigasi utama"
          className="hidden md:flex items-center gap-3.5 lg:gap-5 overflow-x-auto"
        >
          {navItems.map((item) => {
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`relative py-5 text-sm font-medium whitespace-nowrap shrink-0 inline-flex items-center gap-1 studio-transition cursor-pointer focus-visible:outline-2 focus-visible:outline-red-600 ${
                  isActive
                    ? 'text-slate-900 dark:text-white'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {item.id === 'admin' && (
                  <ShieldCheck className="w-3.5 h-3.5 text-red-600" aria-hidden="true" />
                )}
                <span>{item.label}</span>
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

        {/* Zone 3: Theme, Notifications, Account & Primary Action */}
        <div className="shrink-0 flex items-center gap-1.5 sm:gap-2.5">
          <button
            type="button"
            onClick={onCycleTheme}
            aria-label={`Ganti tema (aktif: ${THEME_LABELS[themePreset]})`}
            title={`Tema aktif: ${THEME_LABELS[themePreset]} — Klik untuk mengganti`}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 studio-transition cursor-pointer"
          >
            <Palette className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="hidden xl:inline">{THEME_LABELS[themePreset]}</span>
          </button>

          <NotificationCenter isAuthenticated={Boolean(youtubeUser && isGoogleVerified)} />

          {youtubeUser ? (
            <>
              <div className="hidden lg:block">
                <GoogleAccountBadge
                  displayName={youtubeUser.displayName}
                  email={youtubeUser.email}
                  photoUrl={youtubeUser.photoURL}
                  verified={isGoogleVerified}
                  onSignOut={onGoogleSignOut}
                  compact
                />
              </div>
              <button
                type="button"
                onClick={onGoogleSignOut}
                aria-label="Keluar dari akun Google"
                className="lg:hidden p-2 text-slate-600 dark:text-slate-300 hover:text-red-600 border border-slate-200 dark:border-slate-700 rounded-lg cursor-pointer"
              >
                <LogOut className="w-4 h-4" aria-hidden="true" />
              </button>
            </>
          ) : (
            <div className="hidden xl:block">
              <GoogleSignInButton
                onClick={onGoogleSignIn}
                isLoading={isSigningInGoogle}
                compact
              />
            </div>
          )}

          <button
            type="button"
            onClick={onStartNewLink}
            className="inline-flex items-center gap-1.5 px-3 sm:px-3.5 py-1.5 sm:py-2 text-xs sm:text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg studio-transition whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600"
          >
            <Scissors className="w-3.5 h-3.5 sm:w-4 sm:h-4" aria-hidden="true" />
            <span>Link Baru</span>
          </button>
        </div>
      </div>

      {/* Mobile secondary navigation bar (<md) */}
      <nav
        aria-label="Navigasi utama mobile"
        className="md:hidden border-t border-slate-100 dark:border-slate-800/80 px-4 flex items-center gap-4 overflow-x-auto"
      >
        {navItems.map((item) => {
          const isActive = activeSection === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              aria-current={isActive ? 'page' : undefined}
              className={`relative py-2.5 text-xs font-medium whitespace-nowrap shrink-0 inline-flex items-center gap-1 cursor-pointer ${
                isActive
                  ? 'text-slate-900 dark:text-white'
                  : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              {item.id === 'admin' && (
                <ShieldCheck className="w-3.5 h-3.5 text-red-600" aria-hidden="true" />
              )}
              <span>{item.label}</span>
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
    </header>
  );
}
