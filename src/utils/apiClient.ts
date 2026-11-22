import { getCurrentFirebaseIdToken, getCurrentFirebaseUser } from './youtubeAuth';

export function isFirebaseUserSignedIn(): boolean {
  return Boolean(getCurrentFirebaseUser());
}

/**
 * Authenticated fetch wrapper for KlipCast backend APIs.
 * Automatically attaches the verified Firebase ID Token via Authorization Bearer
 * and X-Requested-With header, and performs a single silent token refresh retry on 401.
 */
export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const buildHeaders = (token: string | null): Headers => {
    const headers = new Headers(init.headers);
    if (!headers.has('X-Requested-With')) {
      headers.set('X-Requested-With', 'XMLHttpRequest');
    }
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    return headers;
  };

  const initialToken = await getCurrentFirebaseIdToken(false);
  const firstRes = await fetch(input, {
    ...init,
    headers: buildHeaders(initialToken),
  });

  if (firstRes.status === 401 && getCurrentFirebaseUser()) {
    const refreshedToken = await getCurrentFirebaseIdToken(true);
    if (refreshedToken && refreshedToken !== initialToken) {
      return fetch(input, {
        ...init,
        headers: buildHeaders(refreshedToken),
      });
    }
  }

  return firstRes;
}
