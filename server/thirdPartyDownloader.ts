import { extractYouTubeVideoId } from '../src/utils/youtube.ts';
import {
  buildCanonicalWatchUrl,
  extractNotubeDownloadUrl,
  extractNotubeServerIds,
  formatAmp4TrimArg,
  getQualityRank,
  normalizeThirdPartyMediaUrl,
  solveAltchaChallenge,
  solveSaveNowPow,
  type AltchaChallengePayload,
  type StreamQualityTier,
} from './downloaderParsers.ts';

export interface ResolvedThirdPartyStream {
  streamUrl: string;
  provider: 'savenow' | 'notube' | 'amp4';
  isPreTrimmed: boolean;
  /** True when the provider serves a live chunked MP4 stream that should be downloaded directly via HTTP GET instead of Range-probed. */
  isDirectChunkedDownload?: boolean;
  qualityTier?: StreamQualityTier;
  headers?: Record<string, string>;
}

interface CachedStreamEntry {
  stream: ResolvedThirdPartyStream;
  expiresAt: number;
}

const STREAM_CACHE_TTL_MS = 14 * 60 * 1000;
const SERVER_POOL_TTL_MS = 10 * 60 * 1000;
const HD_PRIORITY_WINDOW_MS = 14_000;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SAVENOW_HOST = 'https://p.savenow.to';
const SAVENOW_API_KEY = 'dfcb6d76f2f6a9894gjkege8a4ab232222';
const SAVENOW_HEADERS: Record<string, string> = {
  'User-Agent': BROWSER_UA,
  Origin: 'https://y2down.cc',
  Referer: 'https://y2down.cc/',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'cross-site',
};

const streamCache = new Map<string, CachedStreamEntry>();
const inFlightResolutions = new Map<string, Promise<ResolvedThirdPartyStream>>();
let cachedServerPool: { ids: number[]; expiresAt: number } | null = null;
let cachedSaveNowToken: { token: string; expiresAtMs: number } | null = null;
let saveNowTokenInFlight: Promise<string> | null = null;

function getCacheKey(videoIdOrUrl: string): string {
  return extractYouTubeVideoId(videoIdOrUrl) ?? videoIdOrUrl.trim();
}

export function invalidateEpisodeStreamCache(videoIdOrUrl: string): void {
  const key = getCacheKey(videoIdOrUrl);
  streamCache.delete(key);
}

function updateEpisodeStreamCache(key: string, candidate: ResolvedThirdPartyStream): void {
  if (candidate.isPreTrimmed || candidate.isDirectChunkedDownload) return;
  const existing = streamCache.get(key);
  if (
    existing &&
    existing.expiresAt > Date.now() &&
    getQualityRank(existing.stream.qualityTier) > getQualityRank(candidate.qualityTier)
  ) {
    return;
  }
  streamCache.set(key, {
    stream: candidate,
    expiresAt: Date.now() + STREAM_CACHE_TTL_MS,
  });
}

async function getSaveNowBearerToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedSaveNowToken && cachedSaveNowToken.expiresAtMs - 30_000 > Date.now()) {
    return cachedSaveNowToken.token;
  }
  if (!forceRefresh && saveNowTokenInFlight) {
    return saveNowTokenInFlight;
  }

  const mint = (async (): Promise<string> => {
    const chRes = await fetch(`${SAVENOW_HOST}/api/pow/challenge`, {
      headers: SAVENOW_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    if (!chRes.ok) {
      throw new Error(`SaveNow PoW challenge HTTP ${chRes.status}`);
    }
    const ch = (await chRes.json()) as {
      salt?: string;
      difficulty?: number;
      expires_at?: number;
      signature?: string;
    };
    if (!ch.salt || typeof ch.difficulty !== 'number' || !ch.signature) {
      throw new Error('SaveNow PoW challenge payload tidak lengkap.');
    }

    const nonce = solveSaveNowPow(ch.salt, ch.difficulty);
    const vrRes = await fetch(`${SAVENOW_HOST}/api/pow/verify`, {
      method: 'POST',
      headers: {
        ...SAVENOW_HEADERS,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        salt: ch.salt,
        difficulty: ch.difficulty,
        expires_at: ch.expires_at,
        signature: ch.signature,
        nonce,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!vrRes.ok) {
      throw new Error(`SaveNow PoW verify HTTP ${vrRes.status}`);
    }
    const vr = (await vrRes.json()) as {
      success?: boolean;
      token?: string;
      expires_at?: number;
    };
    if (!vr.success || !vr.token) {
      throw new Error('SaveNow PoW token ditolak.');
    }

    const expMs =
      typeof vr.expires_at === 'number' && vr.expires_at > 0
        ? vr.expires_at > 1e12
          ? vr.expires_at
          : vr.expires_at * 1000
        : Date.now() + 8 * 60 * 1000;
    cachedSaveNowToken = { token: vr.token, expiresAtMs: expMs };
    return vr.token;
  })();

  saveNowTokenInFlight = mint;
  try {
    return await mint;
  } finally {
    if (saveNowTokenInFlight === mint) {
      saveNowTokenInFlight = null;
    }
  }
}

async function resolveViaSaveNow(
  canonicalUrl: string,
  format: '4k' | '1080' | '720',
  startSec?: number,
  endSec?: number,
  maxWaitMs = 55_000
): Promise<ResolvedThirdPartyStream> {
  const hasTrim =
    typeof startSec === 'number' && typeof endSec === 'number' && endSec > startSec;
  const query = new URLSearchParams({
    format,
    url: canonicalUrl,
    apikey: SAVENOW_API_KEY,
    allow_extended_duration: '1',
  });
  if (hasTrim) {
    query.set('start_time', String(Math.max(0, Math.floor(startSec))));
    query.set('end_time', String(Math.max(Math.floor(startSec) + 5, Math.ceil(endSec))));
  }

  let token = await getSaveNowBearerToken(false);
  let initRes = await fetch(`${SAVENOW_HOST}/api/v2/download?${query.toString()}`, {
    headers: {
      ...SAVENOW_HEADERS,
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (initRes.status === 401 || initRes.status === 403) {
    token = await getSaveNowBearerToken(true);
    initRes = await fetch(`${SAVENOW_HOST}/api/v2/download?${query.toString()}`, {
      headers: {
        ...SAVENOW_HEADERS,
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
  }

  if (!initRes.ok) {
    throw new Error(`SaveNow ${format} HTTP ${initRes.status}`);
  }

  const initJson = (await initRes.json()) as {
    success?: boolean;
    id?: string;
    progress_url?: string;
    message?: string;
  };
  const progressUrl =
    initJson.progress_url ||
    (initJson.id ? `${SAVENOW_HOST}/api/progress?id=${encodeURIComponent(initJson.id)}` : '');

  if (!initJson.success || !progressUrl) {
    throw new Error(initJson.message || `SaveNow ${format} gagal memulai job unduhan.`);
  }

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1800));
    const progRes = await fetch(progressUrl, {
      headers: SAVENOW_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    if (!progRes.ok) continue;

    const prog = (await progRes.json()) as {
      success?: number;
      progress?: number;
      download_url?: string;
      text?: string;
      message?: string;
    };

    if (prog.download_url) {
      const qualityTier: StreamQualityTier =
        format === '4k' ? '2160p' : format === '1080' ? '1080p' : '720p';
      return {
        streamUrl: normalizeThirdPartyMediaUrl(prog.download_url),
        provider: 'savenow',
        isPreTrimmed: hasTrim,
        isDirectChunkedDownload: true,
        qualityTier,
        headers: { 'User-Agent': BROWSER_UA },
      };
    }

    if (prog.success === 1 && !prog.download_url) {
      throw new Error(prog.text || prog.message || `SaveNow ${format} selesai tanpa URL unduhan.`);
    }
    if (prog.text && /error|fail|unavailable|exceed/i.test(prog.text)) {
      throw new Error(`SaveNow ${format} gagal: ${prog.text}`);
    }
  }

  throw new Error(`SaveNow ${format} timeout menunggu stream HD.`);
}

async function verifyStreamReachable(
  streamUrl: string,
  extraHeaders?: Record<string, string>
): Promise<boolean> {
  try {
    const res = await fetch(streamUrl, {
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_UA,
        Range: 'bytes=0-1023',
        ...(extraHeaders ?? {}),
      },
      signal: AbortSignal.timeout(6000),
    });
    const ok = res.ok || res.status === 206;
    await res.body?.cancel();
    return ok;
  } catch {
    return false;
  }
}

async function getNotubeServerPool(): Promise<number[]> {
  if (cachedServerPool && cachedServerPool.expiresAt > Date.now()) {
    return cachedServerPool.ids;
  }
  try {
    const res = await fetch('https://notube.net/en/youtube-app-459', {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const html = await res.text();
      const ids = extractNotubeServerIds(html);
      cachedServerPool = { ids, expiresAt: Date.now() + SERVER_POOL_TTL_MS };
      return ids;
    }
  } catch {
    // Fall back to known healthy server pool
  }
  return [60, 61, 59, 62, 63, 64, 58, 65, 57, 66];
}

async function isNotubeServerHealthy(serverId: number): Promise<boolean> {
  try {
    const res = await fetch(`https://s${serverId}.notube.net/weight.php`, {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function resolveSingleNotubeWorker(
  serverId: number,
  canonicalUrl: string,
  format: 'mp4hd' | 'mp4',
  recoverTimeoutMs: number
): Promise<ResolvedThirdPartyStream> {
  const healthy = await isNotubeServerHealthy(serverId);
  if (!healthy) {
    throw new Error(`s${serverId} unhealthy`);
  }

  const serverHost = `https://s${serverId}.notube.net`;
  const rwRes = await fetch(`${serverHost}/recover_weight.php`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': BROWSER_UA,
      Origin: 'https://notube.net',
      Referer: 'https://notube.net/',
    },
    body: new URLSearchParams({
      url: canonicalUrl,
      format,
      lang: 'en',
      subscribed: 'false',
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!rwRes.ok) {
    throw new Error(`s${serverId}/${format} recover_weight HTTP ${rwRes.status}`);
  }

  const dw = (await rwRes.json()) as {
    token?: string;
    name_mp4?: string;
    VevoUSA?: string;
  };

  if (!dw.token || !dw.name_mp4) {
    throw new Error(`s${serverId}/${format} missing token/name_mp4`);
  }
  if (dw.VevoUSA === '1') {
    throw new Error(`s${serverId} Vevo/blocked`);
  }

  const rfRes = await fetch(`${serverHost}/recover_file.php`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': BROWSER_UA,
      Origin: 'https://notube.net',
      Referer: 'https://notube.net/',
    },
    body: new URLSearchParams({
      url: canonicalUrl,
      format,
      name_mp4: dw.name_mp4,
      lang: 'en',
      token: dw.token,
      subscribed: 'false',
      playlist: 'false',
      adblock: 'false',
    }),
    signal: AbortSignal.timeout(recoverTimeoutMs),
  });

  if (!rfRes.ok) {
    throw new Error(`s${serverId}/${format} recover_file HTTP ${rfRes.status}`);
  }

  const rfText = (await rfRes.text()).trim();
  if (rfText.includes('cf-turnstile')) {
    throw new Error(`s${serverId}/${format} turnstile challenge`);
  }

  let finalToken = dw.token;
  let rfOk = rfText === 'OK';
  if (!rfOk && rfText.startsWith('{')) {
    try {
      const parsed = JSON.parse(rfText) as { retour?: string; token?: string };
      rfOk = parsed.retour === 'OK';
      if (parsed.token) finalToken = parsed.token;
    } catch {
      rfOk = false;
    }
  }
  if (!rfOk) {
    throw new Error(`s${serverId}/${format} recover_file returned ${rfText.slice(0, 60)}`);
  }

  const dlPageRes = await fetch(
    `https://notube.net/en/download?token=${encodeURIComponent(finalToken)}`,
    {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(8_000),
    }
  );
  if (!dlPageRes.ok) {
    throw new Error(`notube/${format} download page HTTP ${dlPageRes.status}`);
  }

  const dlHtml = await dlPageRes.text();
  const rawDlUrl = extractNotubeDownloadUrl(dlHtml);
  if (!rawDlUrl) {
    throw new Error(`s${serverId}/${format} missing downloadButton href`);
  }

  const dlUrl = normalizeThirdPartyMediaUrl(rawDlUrl);
  const reachable = await verifyStreamReachable(dlUrl);
  if (!reachable) {
    throw new Error(`s${serverId}/${format} download URL unreachable`);
  }

  return {
    streamUrl: dlUrl,
    provider: 'notube',
    isPreTrimmed: false,
    qualityTier: format === 'mp4hd' ? '720p' : '360p',
  };
}

/**
 * Races 3 independent NoTube worker nodes in parallel instead of trying them serially,
 * cutting download setup latency by up to 3x and bypassing slow/Turnstile nodes automatically.
 */
async function resolveViaNotube(
  canonicalUrl: string,
  format: 'mp4hd' | 'mp4' = 'mp4',
  recoverTimeoutMs = 26_000
): Promise<ResolvedThirdPartyStream> {
  const pool = await getNotubeServerPool();
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const parallelWorkers = shuffled.slice(0, 3);

  try {
    return await Promise.any(
      parallelWorkers.map((serverId) =>
        resolveSingleNotubeWorker(serverId, canonicalUrl, format, recoverTimeoutMs)
      )
    );
  } catch (err) {
    const details =
      err instanceof AggregateError
        ? err.errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ')
        : String(err);
    throw new Error(`NoTube (${format}) gagal: ${details}`);
  }
}

async function resolveViaAmp4(
  canonicalUrl: string,
  quality: '1080p' | '720p' | '480p' | '360p',
  startSec?: number,
  endSec?: number,
  maxWaitMs = 28_000
): Promise<ResolvedThirdPartyStream> {
  const homeRes = await fetch('https://amp4.cc/', {
    headers: { 'User-Agent': BROWSER_UA },
    signal: AbortSignal.timeout(8_000),
  });
  if (!homeRes.ok) {
    throw new Error(`AMP4 homepage HTTP ${homeRes.status}`);
  }

  const rawCookies = homeRes.headers.getSetCookie?.() ?? [];
  const cookies = rawCookies.map((c) => c.split(';')[0]).join('; ');
  const html = await homeRes.text();
  const csrf = html.match(/name="csrf-token"\s+content="([^"]+)"/)?.[1];
  if (!csrf || !cookies) {
    throw new Error('AMP4 CSRF/session token tidak ditemukan.');
  }

  const chRes = await fetch('https://amp4.cc/captcha?context=POST%3A%2Fconvert', {
    headers: {
      Cookie: cookies,
      'User-Agent': BROWSER_UA,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!chRes.ok) {
    throw new Error(`AMP4 captcha HTTP ${chRes.status}`);
  }
  const challenge = (await chRes.json()) as AltchaChallengePayload;
  const altcha = solveAltchaChallenge(challenge);

  const fd = new FormData();
  fd.append('url', canonicalUrl);
  fd.append('type', 'video');
  fd.append('format', 'mp4');
  fd.append('quality', quality);
  fd.append('altcha', altcha);
  fd.append('altcha_context', 'POST:/convert');
  const hasTrim = typeof startSec === 'number' && typeof endSec === 'number' && endSec > startSec;
  if (hasTrim) {
    fd.append('trim', formatAmp4TrimArg(startSec, endSec));
  }

  const convRes = await fetch('https://amp4.cc/convert', {
    method: 'POST',
    headers: {
      'X-CSRF-TOKEN': csrf,
      Cookie: cookies,
      Accept: 'application/json',
      'User-Agent': BROWSER_UA,
      Origin: 'https://amp4.cc',
      Referer: 'https://amp4.cc/',
    },
    body: fd,
    signal: AbortSignal.timeout(12_000),
  });

  const convJson = (await convRes.json()) as {
    ok?: boolean;
    data?: { token?: string };
    message?: string;
  };
  const jobToken = convJson?.data?.token;
  if (!convRes.ok || !convJson.ok || !jobToken) {
    throw new Error(convJson?.message || `AMP4 ${quality} convert gagal (HTTP ${convRes.status})`);
  }

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1800));
    const stRes = await fetch(`https://amp4.cc/status?token=${encodeURIComponent(jobToken)}`, {
      headers: {
        Cookie: cookies,
        Accept: 'application/json',
        'User-Agent': BROWSER_UA,
        Referer: 'https://amp4.cc/',
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!stRes.ok) continue;

    const stJson = (await stRes.json()) as {
      data?: {
        state?: string;
        ready?: boolean;
        done?: boolean;
        error?: string;
        download_url?: string;
        downloadUrl?: string;
        url?: string;
      };
    };
    const st = stJson?.data;
    const isFinished = Boolean(st?.ready || st?.done || st?.state === 'completed');
    const rawDlUrl = st?.download_url || st?.downloadUrl || st?.url;
    if (isFinished && rawDlUrl) {
      const dlUrl = normalizeThirdPartyMediaUrl(rawDlUrl);
      const headers = { Referer: 'https://amp4.cc/', Cookie: cookies };
      if (await verifyStreamReachable(dlUrl, headers)) {
        return {
          streamUrl: dlUrl,
          provider: 'amp4',
          isPreTrimmed: hasTrim,
          qualityTier: quality,
          headers,
        };
      }
    }
    if (st?.state === 'failed') {
      throw new Error(st.error || `AMP4 ${quality} job failed`);
    }
  }

  throw new Error(`AMP4 ${quality} timeout menunggu konversi.`);
}

/**
 * Resolves a downloadable MP4 stream URL prioritizing TRUE native 1080p/4K streams first.
 * 1. Primary HD engine: SaveNow v2 PoW API with server-side exact segment trimming (`start_time`/`end_time`)
 *    delivering native 1920x1080 / 4K H.264 + AAC streams with zero cookies or API keys.
 * 2. Fallback engine: Parallel NoTube + AMP4 multi-worker cascade if SaveNow is unavailable.
 */
export async function resolveThirdPartyMp4Stream(params: {
  sourceUrl: string;
  videoId?: string;
  startSec?: number;
  endSec?: number;
  preferredQuality?: '1080p' | '4k';
  skipCache?: boolean;
}): Promise<ResolvedThirdPartyStream> {
  const key = getCacheKey(params.videoId || params.sourceUrl);
  const canonicalUrl = buildCanonicalWatchUrl(params.videoId || params.sourceUrl);
  const hasTrim =
    typeof params.startSec === 'number' &&
    typeof params.endSec === 'number' &&
    params.endSec > params.startSec;

  if (!params.skipCache && !hasTrim) {
    const cached = streamCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      const ok = await verifyStreamReachable(cached.stream.streamUrl, cached.stream.headers);
      if (ok) {
        return cached.stream;
      }
      streamCache.delete(key);
    }

    const existingFlight = inFlightResolutions.get(key);
    if (existingFlight) {
      return existingFlight;
    }
  }

  const work = (async (): Promise<ResolvedThirdPartyStream> => {
    const errors: string[] = [];

    // 1. Primary true-HD engine: SaveNow v2 pre-trimmed native 4K / 1080p / 720p stream
    if (hasTrim) {
      const saveNowFormats: Array<'4k' | '1080' | '720'> =
        params.preferredQuality === '4k' ? ['4k', '1080', '720'] : ['1080', '720'];

      for (const fmt of saveNowFormats) {
        try {
          return await resolveViaSaveNow(
            canonicalUrl,
            fmt,
            params.startSec,
            params.endSec,
            fmt === '4k' ? 35_000 : 50_000
          );
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
    }

    // 2. Fallback parallel HD workers (NoTube mp4hd + AMP4 1080p/720p trimmed)
    const hdCandidates: Promise<ResolvedThirdPartyStream>[] = [
      resolveViaNotube(canonicalUrl, 'mp4hd', 45_000),
      resolveViaAmp4(canonicalUrl, '1080p', params.startSec, params.endSec, 32_000),
      resolveViaAmp4(canonicalUrl, '720p', params.startSec, params.endSec, 32_000),
    ];

    const hdRace = Promise.any(hdCandidates);
    hdRace
      .then((hdStream) => updateEpisodeStreamCache(key, hdStream))
      .catch(() => {
        // Handled below via fallback race
      });

    const hdWindowResult = await Promise.race<ResolvedThirdPartyStream | 'HD_WINDOW_ELAPSED'>([
      hdRace.catch(() => 'HD_WINDOW_ELAPSED' as const),
      new Promise<'HD_WINDOW_ELAPSED'>((resolve) =>
        setTimeout(() => resolve('HD_WINDOW_ELAPSED'), HD_PRIORITY_WINDOW_MS)
      ),
    ]);

    if (hdWindowResult !== 'HD_WINDOW_ELAPSED') {
      updateEpisodeStreamCache(key, hdWindowResult);
      return hdWindowResult;
    }

    // 3. Final fallback race (NoTube mp4 + AMP4 480p/360p)
    try {
      const winner = await Promise.any([
        hdRace,
        resolveViaNotube(canonicalUrl, 'mp4', 24_000),
        resolveViaAmp4(canonicalUrl, '480p', params.startSec, params.endSec, 28_000),
        resolveViaAmp4(canonicalUrl, '360p', params.startSec, params.endSec, 28_000),
      ]);
      updateEpisodeStreamCache(key, winner);
      return winner;
    } catch (aggErr) {
      const details =
        aggErr instanceof AggregateError
          ? aggErr.errors.map((e) => (e instanceof Error ? e.message : String(e))).join(' | ')
          : aggErr instanceof Error
            ? aggErr.message
            : String(aggErr);
      const prefix = errors.length > 0 ? `${errors.join(' | ')} | ` : '';
      throw new Error(`Semua pengunduh otomatis gagal (${prefix}${details})`);
    }
  })();

  if (!params.skipCache && !hasTrim) {
    inFlightResolutions.set(key, work);
  }
  try {
    return await work;
  } finally {
    if (!hasTrim) {
      inFlightResolutions.delete(key);
    }
  }
}

/**
 * Warms up the SaveNow PoW Bearer token in the background after podcast analysis
 * so the first HD 1080p/4K clip render starts instantly without waiting for PoW setup.
 */
export async function prewarmEpisodeStream(_sourceUrl: string, _videoId?: string): Promise<void> {
  try {
    await getSaveNowBearerToken(false);
  } catch {
    // Silent background warmup failure; explicit render will retry gracefully
  }
}

