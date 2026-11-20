import type { User } from 'firebase/auth';
import { LogOut, Scissors } from 'lucide-react';
import { GoogleAccountBadge, GoogleSignInButton } from './GoogleSignInButton';

export type NavSection = 'studio' | 'summaries' | 'queue' | 'automation';

interface TopBarProps {
  activeSection: NavSection;
  onNavigate: (section: NavSection) => void;
  onStartNewLink: () => void;
  youtubeUser: User | null;
  isGoogleVerified: boolean;
  isSigningInGoogle: boolean;
  onGoogleSignIn: () => void;
  onGoogleSignOut: () => void;
}

const NAV_ITEMS: { id: NavSection; label: string }[] = [
  { id: 'studio', label: 'Studio Klip' },
  { id: 'summaries', label: 'Ringkasan' },
  { id: 'queue', label: 'Distribusi' },
  { id: 'automation', label: 'Otomasi' },
];

export function TopBar({
  activeSection,
  onNavigate,
  onStartNewLink,
  youtubeUser,
  isGoogleVerified,
  isSigningInGoogle,
  onGoogleSignIn,
  onGoogleSignOut,
}: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-sm border-b border-slate-200">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-8 h-16 flex items-center justify-between gap-3 sm:gap-6">
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

        {/* Zone 3: Verified Google Account & Primary Action */}
        <div className="shrink-0 flex items-center gap-2.5">
          {youtubeUser ? (
            <>
              <div className="hidden sm:block">
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
                className="sm:hidden p-2 text-slate-600 hover:text-red-600 border border-slate-200 rounded-lg cursor-pointer"
              >
                <LogOut className="w-4 h-4" aria-hidden="true" />
              </button>
            </>
          ) : (
            <div className="hidden md:block">
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
            className="hidden sm:inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg studio-transition whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600"
          >
            <Scissors className="w-4 h-4" aria-hidden="true" />
            <span>Proses Link Baru</span>
          </button>
        </div>
      </div>
    </header>
  );
}
