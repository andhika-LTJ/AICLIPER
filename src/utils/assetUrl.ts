/**
 * Isomorphic asset URL resolver supporting optional Cloud Storage / CDN offloading
 * (e.g. Google Cloud Storage, Cloudflare R2, AWS CloudFront, or jsDelivr) via
 * `VITE_ASSET_CDN_BASE_URL` (client) or `ASSET_CDN_BASE_URL` (server).
 *
 * When no CDN base URL is configured, local compressed assets are served as-is.
 */

export function normalizeCdnBaseUrl(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed.replace(/\/+$/, '');
}

export function getConfiguredAssetCdnBaseUrl(): string | null {
  const viteEnv =
    typeof import.meta !== 'undefined'
      ? (import.meta as { env?: Record<string, string | undefined> }).env
      : undefined;

  const nodeEnv =
    typeof process !== 'undefined' && process.env
      ? (process.env as Record<string, string | undefined>)
      : undefined;

  return (
    normalizeCdnBaseUrl(viteEnv?.VITE_ASSET_CDN_BASE_URL) ??
    normalizeCdnBaseUrl(nodeEnv?.ASSET_CDN_BASE_URL) ??
    normalizeCdnBaseUrl(nodeEnv?.VITE_ASSET_CDN_BASE_URL)
  );
}

/**
 * Resolves a static asset path to a Cloud Storage / CDN URL when configured,
 * or returns the local relative path otherwise.
 */
export function resolveAssetUrl(
  assetPath: string,
  overrideCdnBaseUrl?: string | null
): string {
  const trimmed = assetPath.trim();
  if (!trimmed) return trimmed;

  // Already an external URL or inline URI
  if (/^(?:https?:|data:|blob:|\/\/)/i.test(trimmed)) {
    return trimmed;
  }

  const cdnBase =
    overrideCdnBaseUrl !== undefined
      ? normalizeCdnBaseUrl(overrideCdnBaseUrl)
      : getConfiguredAssetCdnBaseUrl();

  if (!cdnBase) {
    return trimmed;
  }

  // Normalize `/src/assets/images/foo.jpg` -> `assets/images/foo.jpg` for clean bucket keys
  const normalizedKey = trimmed
    .replace(/^\/+/, '')
    .replace(/^src\//i, '')
    .replace(/^public\//i, '');

  return `${cdnBase}/${normalizedKey}`;
}
