import { CheckCircle2, Loader2, LogOut } from 'lucide-react';

interface GoogleSignInButtonProps {
  onClick: () => void;
  disabled?: boolean;
  isLoading?: boolean;
  label?: string;
  compact?: boolean;
  fullWidth?: boolean;
}

export function GoogleSignInButton({
  onClick,
  disabled = false,
  isLoading = false,
  label = 'Sign in with Google',
  compact = false,
  fullWidth = false,
}: GoogleSignInButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || isLoading}
      className={`inline-flex items-center justify-center gap-2.5 bg-white hover:bg-slate-50 active:bg-slate-100 text-[#1f1f1f] border border-[#747775] rounded-full font-medium shadow-2xs studio-transition cursor-pointer whitespace-nowrap disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 ${
        fullWidth ? 'w-full h-11 px-5 text-sm' : compact ? 'h-9 px-3.5 text-xs' : 'h-10 px-4 text-sm'
      }`}
    >
      {isLoading ? (
        <Loader2 className="w-4 h-4 animate-spin text-slate-600 shrink-0" aria-hidden="true" />
      ) : (
        <svg
          version="1.1"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 48 48"
          className="w-4 h-4 shrink-0 block"
          aria-hidden="true"
        >
          <path
            fill="#EA4335"
            d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
          />
          <path
            fill="#4285F4"
            d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
          />
          <path
            fill="#FBBC05"
            d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
          />
          <path
            fill="#34A853"
            d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
          />
          <path fill="none" d="M0 0h48v48H0z" />
        </svg>
      )}
      <span>{isLoading ? 'Memverifikasi...' : label}</span>
    </button>
  );
}

interface GoogleAccountBadgeProps {
  displayName: string | null;
  email: string | null;
  photoUrl: string | null;
  verified?: boolean;
  onSignOut: () => void;
  compact?: boolean;
}

export function GoogleAccountBadge({
  displayName,
  email,
  photoUrl,
  verified = true,
  onSignOut,
  compact = false,
}: GoogleAccountBadgeProps) {
  const label = displayName || email || 'Akun Google';
  return (
    <div className="inline-flex items-center gap-2 pl-1.5 pr-2 py-1 bg-slate-100 border border-slate-200 rounded-full min-w-0 max-w-[260px]">
      {photoUrl ? (
        <img
          src={photoUrl}
          alt=""
          className="w-6 h-6 rounded-full object-cover shrink-0"
          referrerPolicy="no-referrer"
        />
      ) : (
        <span className="w-6 h-6 rounded-full bg-red-600 text-white text-[11px] font-bold flex items-center justify-center shrink-0">
          {label.charAt(0).toUpperCase()}
        </span>
      )}
      <span
        className={`font-medium text-slate-800 truncate ${compact ? 'text-xs' : 'text-xs'}`}
        title={email ? `${label} (${email})` : label}
      >
        {label}
      </span>
      {verified && (
        <CheckCircle2
          className="w-3.5 h-3.5 text-emerald-700 shrink-0"
          aria-label="Akun Google terverifikasi"
        />
      )}
      <button
        type="button"
        onClick={onSignOut}
        aria-label="Keluar dari akun Google"
        title="Keluar dari akun Google"
        className="p-1 text-slate-500 hover:text-red-600 rounded-full cursor-pointer shrink-0 focus-visible:outline-2 focus-visible:outline-red-600"
      >
        <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
