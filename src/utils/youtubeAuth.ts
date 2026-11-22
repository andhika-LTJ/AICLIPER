import { initializeApp, getApps, getApp } from '@firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from '@firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import type { AccountStatus, PlanTier, UserRole } from '../types/clipper';
import { formatGoogleAuthError } from './youtubeAuthErrors';

export const YOUTUBE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
] as const;

export interface VerifiedGoogleIdentity {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  signInProvider: string;
  authTime: number;
  expiresAt: number;
  role?: UserRole;
  status?: AccountStatus;
  planTier?: PlanTier;
}

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

const provider = new GoogleAuthProvider();
provider.addScope('email');
provider.addScope('profile');
for (const scope of YOUTUBE_OAUTH_SCOPES) {
  provider.addScope(scope);
}
provider.setCustomParameters({
  prompt: 'select_account',
});

// In-memory only OAuth token cache (never stored in localStorage/sessionStorage)
let isSigningIn = false;
let cachedAccessToken: string | null = null;

export interface GoogleAuthSession {
  user: User;
  verifiedIdentity: VerifiedGoogleIdentity;
  accessToken: string | null;
}

export function getCurrentFirebaseUser(): User | null {
  return auth.currentUser;
}

export async function getCurrentFirebaseIdToken(forceRefresh = false): Promise<string | null> {
  const user = auth.currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken(forceRefresh);
  } catch {
    return null;
  }
}

export async function verifyGoogleSessionOnServer(
  user: User,
  forceRefresh = false
): Promise<VerifiedGoogleIdentity> {
  const idToken = await user.getIdToken(forceRefresh);
  const res = await fetch('/api/auth/verify-google', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Firebase-Id-Token': idToken,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify({ idToken }),
  });

  const data = (await res.json().catch(() => ({}))) as {
    verified?: boolean;
    user?: VerifiedGoogleIdentity;
    error?: string;
  };

  if (!res.ok || !data.verified || !data.user) {
    throw new Error(
      data.error || 'Verifikasi identitas Google oleh server KlipCast gagal.'
    );
  }

  return data.user;
}

export function initGoogleSessionListener(callbacks: {
  onSessionRestored: (
    user: User,
    verifiedIdentity: VerifiedGoogleIdentity,
    accessToken: string | null
  ) => void;
  onSessionError: (message: string) => void;
  onSignedOut: () => void;
}): () => void {
  let active = true;

  const unsubscribe = onAuthStateChanged(auth, (user) => {
    if (!active) return;

    if (!user) {
      if (!isSigningIn) {
        cachedAccessToken = null;
        callbacks.onSignedOut();
      }
      return;
    }

    // If user just clicked Sign In, signInWithGoogleSession handles verification directly
    if (isSigningIn) {
      return;
    }

    void (async () => {
      try {
        const verifiedIdentity = await verifyGoogleSessionOnServer(user, false);
        if (!active) return;
        callbacks.onSessionRestored(user, verifiedIdentity, cachedAccessToken);
      } catch (err) {
        if (!active) return;
        cachedAccessToken = null;
        try {
          await signOut(auth);
        } catch {
          // Ignore signOut cleanup errors
        }
        callbacks.onSessionError(formatGoogleAuthError(err));
        callbacks.onSignedOut();
      }
    })();
  });

  return () => {
    active = false;
    unsubscribe();
  };
}

export async function signInWithGoogleSession(options?: {
  requireYouTubeAccessToken?: boolean;
  onPhaseChange?: (phase: 'popup' | 'verifying') => void;
}): Promise<GoogleAuthSession> {
  isSigningIn = true;
  try {
    options?.onPhaseChange?.('popup');
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = credential?.accessToken ?? null;

    if (options?.requireYouTubeAccessToken && !accessToken) {
      throw new Error(
        'Izin akses unggah YouTube belum diberikan pada jendela Google. Pastikan Anda mencentang izin YouTube saat menyetujui akses.'
      );
    }

    options?.onPhaseChange?.('verifying');
    const verifiedIdentity = await verifyGoogleSessionOnServer(result.user, true);

    if (accessToken) {
      cachedAccessToken = accessToken;
    }

    return {
      user: result.user,
      verifiedIdentity,
      accessToken: cachedAccessToken,
    };
  } catch (err) {
    throw new Error(formatGoogleAuthError(err));
  } finally {
    isSigningIn = false;
  }
}

export function getYouTubeAccessToken(): string | null {
  return cachedAccessToken;
}

export function clearYouTubeAccessToken(): void {
  cachedAccessToken = null;
}

export async function signOutGoogleSession(): Promise<void> {
  const token = await getCurrentFirebaseIdToken(false);
  if (token) {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
    } catch {
      // Best-effort server revocation before local sign-out
    }
  }
  cachedAccessToken = null;
  await signOut(auth);
}

// Backwards-compatible aliases
export const signInWithGoogleForYouTube = signInWithGoogleSession;
export const signOutYouTube = signOutGoogleSession;
