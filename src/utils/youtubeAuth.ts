import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

export const YOUTUBE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
] as const;

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

const provider = new GoogleAuthProvider();
for (const scope of YOUTUBE_OAUTH_SCOPES) {
  provider.addScope(scope);
}
provider.setCustomParameters({
  prompt: 'select_account',
});

// In-memory only OAuth token cache (never stored in localStorage/sessionStorage)
let isSigningIn = false;
let cachedAccessToken: string | null = null;

export interface YouTubeAuthSession {
  user: User;
  accessToken: string;
}

export function initYouTubeAuth(
  onAuthSuccess?: (user: User, accessToken: string) => void,
  onAuthCleared?: (user: User | null) => void
): () => void {
  return onAuthStateChanged(auth, (user) => {
    if (user && cachedAccessToken) {
      onAuthSuccess?.(user, cachedAccessToken);
      return;
    }
    if (!isSigningIn) {
      cachedAccessToken = null;
      onAuthCleared?.(user);
    }
  });
}

export async function signInWithGoogleForYouTube(): Promise<YouTubeAuthSession> {
  isSigningIn = true;
  try {
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error(
        'Token akses YouTube tidak diterima dari Google. Silakan coba login ulang dan setujui izin unggah YouTube.'
      );
    }
    cachedAccessToken = credential.accessToken;
    return {
      user: result.user,
      accessToken: cachedAccessToken,
    };
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

export async function signOutYouTube(): Promise<void> {
  cachedAccessToken = null;
  await signOut(auth);
}
