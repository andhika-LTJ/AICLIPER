import dns from 'dns/promises';
import net from 'net';
import path from 'path';
import type { NextFunction, Request, Response } from 'express';
import type { BotAutomationConfig } from '../src/types/clipper.ts';

export const MAX_UPLOAD_BYTES = Math.max(
  10 * 1024 * 1024,
  (Number(process.env.MAX_UPLOAD_MB) || 250) * 1024 * 1024
);
export const MAX_CONCURRENT_UPLOADS = Math.max(
  1,
  Math.min(5, Number(process.env.MAX_CONCURRENT_UPLOADS) || 2)
);

const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{2,128}$/;

export function isSafeResourceId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID_REGEX.test(id);
}

export function assertSafeResourceId(id: unknown, label = 'ID'): string {
  if (!isSafeResourceId(id)) {
    throw new Error(`${label} tidak valid.`);
  }
  return id;
}

/**
 * Guarantees that a resolved filesystem path stays strictly inside `baseDir`
 * using a trailing path separator check to block path traversal.
 */
export function resolveConfinedPath(baseDir: string, ...segments: string[]): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, ...segments);
  const boundary = resolvedBase.endsWith(path.sep)
    ? resolvedBase
    : `${resolvedBase}${path.sep}`;
  if (!resolvedTarget.startsWith(boundary)) {
    throw new Error('Akses path file di luar direktori yang diizinkan ditolak.');
  }
  return resolvedTarget;
}

/**
 * Checks whether an IPv4 or IPv6 address belongs to loopback, private RFC1918,
 * link-local / cloud metadata (169.254.169.254), CGNAT, or multicast ranges.
 */
export function isBlockedIpAddress(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!ip) return true;

  // Handle IPv4-mapped IPv6 addresses like ::ffff:127.0.0.1 or ::ffff:a9fe:a9fe
  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice(7);
    if (net.isIPv4(mapped)) {
      return isBlockedIpAddress(mapped);
    }
    const hexMatch = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1], 16);
      const lo = parseInt(hexMatch[2], 16);
      const ipv4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
      return isBlockedIpAddress(ipv4);
    }
    return true;
  }

  if (net.isIPv4(ip)) {
    const octets = ip.split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = octets;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 192 && b === 0 && (octets[2] === 0 || octets[2] === 2)) return true; // IETF / TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return true; // Benchmarking
    if (a >= 224) return true; // Multicast & reserved (224.0.0.0/4, 240.0.0.0/4)
    return false;
  }

  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1') return true;
    // fc00::/7 (Unique Local), fe80::/10 (Link-Local), ff00::/8 (Multicast)
    if (
      ip.startsWith('fc') ||
      ip.startsWith('fd') ||
      ip.startsWith('fe8') ||
      ip.startsWith('fe9') ||
      ip.startsWith('fea') ||
      ip.startsWith('feb') ||
      ip.startsWith('ff')
    ) {
      return true;
    }
    return false;
  }

  return true;
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata',
  'instance-data',
  '169.254.169.254',
]);

export interface SafeUrlValidationResult {
  valid: boolean;
  normalizedUrl?: string;
  resolvedAddresses?: string[];
  reason?: string;
}

export interface SafeUrlValidationOptions {
  allowedDomainsEnv?: string;
  requireHttps?: boolean;
  skipDnsLookup?: boolean;
  lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>;
}

/**
 * Validates outbound webhook and direct-video URLs against SSRF, private IP ranges,
 * cloud metadata hosts, non-HTTP(S) schemes, optional domain allowlists, and DNS rebinding.
 */
export async function validateSafeExternalUrl(
  rawUrl: string,
  options: SafeUrlValidationOptions = {}
): Promise<SafeUrlValidationResult> {
  const trimmed = (rawUrl ?? '').trim();
  if (!trimmed) {
    return { valid: false, reason: 'URL eksternal tidak boleh kosong.' };
  }
  if (trimmed.length > 2048) {
    return { valid: false, reason: 'URL terlalu panjang (maksimal 2048 karakter).' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, reason: 'Format URL tidak valid.' };
  }

  if (options.requireHttps) {
    if (parsed.protocol !== 'https:') {
      return { valid: false, reason: 'Protokol URL wajib HTTPS.' };
    }
  } else if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, reason: 'Protokol URL wajib HTTP atau HTTPS.' };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, reason: 'URL tidak boleh menyertakan kredensial user/password.' };
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) {
    return { valid: false, reason: 'Hostname URL tidak valid.' };
  }

  if (
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localdomain')
  ) {
    return {
      valid: false,
      reason: 'Alamat lokal atau internal cloud tidak diizinkan untuk keamanan server.',
    };
  }

  const rawHostIp = host.replace(/^\[|\]$/g, '');
  if (net.isIP(rawHostIp)) {
    if (isBlockedIpAddress(rawHostIp)) {
      return {
        valid: false,
        reason: 'Alamat IP privat, loopback, link-local, atau metadata tidak diizinkan.',
      };
    }
  }

  const allowlistRaw = (options.allowedDomainsEnv ?? '').trim();
  if (allowlistRaw) {
    const allowedDomains = allowlistRaw
      .split(',')
      .map((d) => d.trim().toLowerCase().replace(/^\*\./, ''))
      .filter(Boolean);
    if (allowedDomains.length > 0) {
      const matched = allowedDomains.some(
        (domain) => host === domain || host.endsWith(`.${domain}`)
      );
      if (!matched) {
        return {
          valid: false,
          reason: `Domain "${host}" tidak termasuk dalam daftar domain yang diizinkan server.`,
        };
      }
    }
  }

  if (!options.skipDnsLookup && !net.isIP(rawHostIp)) {
    try {
      const lookupFn =
        options.lookupFn ?? ((hostname: string) => dns.lookup(hostname, { all: true }));
      const records = await lookupFn(host);
      if (!records || records.length === 0) {
        return { valid: false, reason: 'Hostname tujuan tidak dapat di-resolve melalui DNS.' };
      }
      const addresses = records.map((r) => r.address);
      for (const ip of addresses) {
        if (isBlockedIpAddress(ip)) {
          return {
            valid: false,
            reason:
              'Hostname tujuan mengarah ke alamat jaringan internal/privat dan diblokir demi keamanan.',
          };
        }
      }
      return {
        valid: true,
        normalizedUrl: parsed.toString(),
        resolvedAddresses: addresses,
      };
    } catch {
      return {
        valid: false,
        reason: 'Gagal memverifikasi DNS hostname tujuan. Pastikan domain publik valid.',
      };
    }
  }

  return {
    valid: true,
    normalizedUrl: parsed.toString(),
    resolvedAddresses: net.isIP(rawHostIp) ? [rawHostIp] : [],
  };
}

/**
 * Inspects leading file bytes (magic signature) to verify uploaded files are real video containers
 * (MP4/MOV ISO-BMFF `ftyp`, WebM/MKV EBML `1A 45 DF A3`, or AVI `RIFF....AVI `).
 */
export function validateVideoMagicBytes(headerBytes: Buffer): {
  valid: boolean;
  detectedFormat?: 'mp4_mov' | 'webm_mkv' | 'avi';
  reason?: string;
} {
  if (!headerBytes || headerBytes.length < 12) {
    return { valid: false, reason: 'File terlalu kecil atau bukan file video yang valid.' };
  }

  // ISO Base Media File Format (MP4, M4V, MOV): bytes 4..7 == "ftyp"
  const boxType = headerBytes.subarray(4, 8).toString('ascii');
  if (boxType === 'ftyp' || boxType === 'moov' || boxType === 'mdat' || boxType === 'wide') {
    return { valid: true, detectedFormat: 'mp4_mov' };
  }

  // Matroska / WebM EBML header: 0x1A 0x45 0xDF 0xA3
  if (
    headerBytes[0] === 0x1a &&
    headerBytes[1] === 0x45 &&
    headerBytes[2] === 0xdf &&
    headerBytes[3] === 0xa3
  ) {
    return { valid: true, detectedFormat: 'webm_mkv' };
  }

  // AVI container: "RIFF" .... "AVI "
  if (
    headerBytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    headerBytes.subarray(8, 12).toString('ascii') === 'AVI '
  ) {
    return { valid: true, detectedFormat: 'avi' };
  }

  return {
    valid: false,
    reason: 'Signature file tidak cocok dengan format video yang didukung (MP4, MOV, WebM, MKV, AVI).',
  };
}

/**
 * Strips webhook secrets before returning automation settings to any frontend client.
 */
export function sanitizeAutomationForClient(config: BotAutomationConfig): BotAutomationConfig {
  const hasSecret = Boolean(config.webhookSecretHeader?.trim() || config.hasWebhookSecret);
  return {
    ...config,
    webhookSecretHeader: '',
    hasWebhookSecret: hasSecret,
  };
}

/**
 * Sets standard security headers while keeping AI Studio preview iframe compatibility.
 */
export function securityHeadersMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()'
  );
  next();
}

/**
 * Enforces an explicit CORS allowlist instead of wildcard `*` on authenticated API endpoints.
 */
export function corsAllowlistMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const origin = req.headers.origin;
  if (!origin) {
    next();
    return;
  }

  const host = (req.headers['x-forwarded-host'] || req.headers.host || '')
    .toString()
    .split(',')[0]
    .trim()
    .toLowerCase();

  const envOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim().toLowerCase())
    .filter(Boolean);

  let isAllowed = false;
  try {
    const parsedOrigin = new URL(origin);
    const originHost = parsedOrigin.host.toLowerCase();
    const originHostname = parsedOrigin.hostname.toLowerCase();
    const hostHostname = host.split(':')[0] || '';
    if ((host && originHost === host) || (hostHostname && originHostname === hostHostname)) {
      isAllowed = true;
    } else if (
      originHostname.endsWith('.run.app') ||
      originHostname.endsWith('.aistudio.google.com') ||
      originHostname.endsWith('.usercontent.goog') ||
      originHostname.endsWith('.web.app') ||
      originHostname.endsWith('.firebaseapp.com') ||
      originHost === 'localhost:3000' ||
      originHost === '127.0.0.1:3000'
    ) {
      isAllowed = true;
    } else if (envOrigins.includes(origin.toLowerCase())) {
      isAllowed = true;
    }
  } catch {
    isAllowed = false;
  }

  if (isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Firebase-Id-Token, X-YouTube-Access-Token, X-Requested-With'
    );
  }

  if (req.method === 'OPTIONS') {
    if (isAllowed) {
      res.status(204).end();
    } else {
      res.status(403).json({
        code: 'CORS_ORIGIN_FORBIDDEN',
        error: 'Origin permintaan tidak diizinkan oleh kebijakan keamanan CORS.',
      });
    }
    return;
  }

  next();
}

export interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
  message?: string;
}

/**
 * In-memory sliding-window rate limiter keyed by authenticated UID or client IP.
 */
export function createRateLimiter(options: RateLimiterOptions) {
  const buckets = new Map<string, number[]>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const cutoff = now - options.windowMs;
    const authUid = (req as Request & { authUser?: { uid?: string } }).authUser?.uid;
    const forwardedIp = (req.headers['x-forwarded-for'] ?? '')
      .toString()
      .split(',')[0]
      .trim();
    const ip = forwardedIp || req.socket.remoteAddress || 'unknown';
    const key = `${options.keyPrefix}:${authUid || ip}`;

    const timestamps = (buckets.get(key) ?? []).filter((ts) => ts > cutoff);
    if (timestamps.length >= options.maxRequests) {
      const oldest = timestamps[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + options.windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        code: 'RATE_LIMITED',
        error:
          options.message ??
          `Terlalu banyak permintaan. Coba lagi dalam ${retryAfterSec} detik.`,
      });
      return;
    }

    timestamps.push(now);
    buckets.set(key, timestamps);

    // Opportunistic cleanup so idle buckets never grow unbounded
    if (buckets.size > 2000) {
      for (const [k, list] of buckets.entries()) {
        if (list.length === 0 || list[list.length - 1] <= cutoff) {
          buckets.delete(k);
        }
      }
    }

    next();
  };
}

let activeUploadCount = 0;

export function tryAcquireUploadSlot(): boolean {
  if (activeUploadCount >= MAX_CONCURRENT_UPLOADS) {
    return false;
  }
  activeUploadCount += 1;
  return true;
}

export function releaseUploadSlot(): void {
  activeUploadCount = Math.max(0, activeUploadCount - 1);
}

export function getActiveUploadCount(): number {
  return activeUploadCount;
}

export function sanitizePublicErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const msg = err.message.trim();
  if (!msg) return fallback;
  // Never expose raw SQLite/SQL, filesystem stack traces, or internal env secrets
  if (
    /sqlite|sql syntax|enoent|eacces|econnrefused|at\s+\S+\s+\(/i.test(msg) ||
    msg.length > 360
  ) {
    return fallback;
  }
  return msg;
}
