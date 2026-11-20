import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const GOOGLE_SECURETOKEN_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

export interface VerifiedGoogleIdentity {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  signInProvider: string;
  authTime: number;
  expiresAt: number;
}

export class GoogleTokenVerificationError extends Error {
  status: number;
  code: string;

  constructor(message: string, code = 'INVALID_GOOGLE_TOKEN', status = 401) {
    super(message);
    this.name = 'GoogleTokenVerificationError';
    this.code = code;
    this.status = status;
  }
}

interface CertCacheEntry {
  certs: Record<string, string>;
  expiresAtMs: number;
}

let certCache: CertCacheEntry | null = null;

function decodeBase64Url(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLen), 'base64');
}

export function parseCacheControlMaxAgeMs(headerValue: string | null): number {
  if (!headerValue) return 3600_000;
  const match = headerValue.match(/max-age=(\d+)/i);
  if (!match) return 3600_000;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return 60_000;
  return Math.min(seconds * 1000, 6 * 3600_000);
}

export function verifyFirebaseGoogleIdTokenWithCerts(params: {
  idToken: string;
  certsByKid: Record<string, string>;
  projectId: string;
  nowSec?: number;
  requireGoogleProvider?: boolean;
}): VerifiedGoogleIdentity {
  const {
    idToken,
    certsByKid,
    projectId,
    nowSec = Math.floor(Date.now() / 1000),
    requireGoogleProvider = true,
  } = params;

  if (!idToken || typeof idToken !== 'string') {
    throw new GoogleTokenVerificationError(
      'Token verifikasi Google tidak ditemukan.',
      'MISSING_ID_TOKEN',
      401
    );
  }

  const parts = idToken.trim().split('.');
  if (parts.length !== 3) {
    throw new GoogleTokenVerificationError(
      'Format token verifikasi Google tidak valid.',
      'MALFORMED_ID_TOKEN',
      401
    );
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string; kid?: string };
  let payload: {
    aud?: string;
    iss?: string;
    sub?: string;
    iat?: number;
    exp?: number;
    auth_time?: number;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
    firebase?: { sign_in_provider?: string };
  };

  try {
    header = JSON.parse(decodeBase64Url(headerB64).toString('utf8'));
    payload = JSON.parse(decodeBase64Url(payloadB64).toString('utf8'));
  } catch {
    throw new GoogleTokenVerificationError(
      'Payload token Google tidak dapat dibaca.',
      'INVALID_JWT_JSON',
      401
    );
  }

  if (header.alg !== 'RS256' || !header.kid) {
    throw new GoogleTokenVerificationError(
      'Algoritma atau ID kunci tanda tangan Google tidak valid.',
      'INVALID_JWT_HEADER',
      401
    );
  }

  const publicCert = certsByKid[header.kid];
  if (!publicCert) {
    throw new GoogleTokenVerificationError(
      'Kunci sertifikat publik Google tidak cocok atau sudah diperbarui.',
      'UNKNOWN_KEY_ID',
      401
    );
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();

  const signatureBuf = decodeBase64Url(signatureB64);
  let signatureValid = false;
  try {
    signatureValid = verifier.verify(publicCert, signatureBuf);
  } catch {
    signatureValid = false;
  }

  if (!signatureValid) {
    throw new GoogleTokenVerificationError(
      'Tanda tangan digital Google tidak valid.',
      'INVALID_SIGNATURE',
      401
    );
  }

  const expectedIssuer = `https://securetoken.google.com/${projectId}`;
  if (payload.aud !== projectId || payload.iss !== expectedIssuer) {
    throw new GoogleTokenVerificationError(
      'Token Google tidak diterbitkan untuk project KlipCast ini.',
      'PROJECT_MISMATCH',
      401
    );
  }

  if (!payload.sub || typeof payload.sub !== 'string' || payload.sub.length > 128) {
    throw new GoogleTokenVerificationError(
      'Identitas pengguna Google tidak valid.',
      'INVALID_SUBJECT',
      401
    );
  }

  const skewSec = 300;
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec - 30) {
    throw new GoogleTokenVerificationError(
      'Sesi verifikasi Google sudah kedaluwarsa. Silakan masuk ulang.',
      'TOKEN_EXPIRED',
      401
    );
  }

  if (typeof payload.iat !== 'number' || payload.iat > nowSec + skewSec) {
    throw new GoogleTokenVerificationError(
      'Waktu penerbitan token Google tidak valid.',
      'INVALID_IAT',
      401
    );
  }

  if (typeof payload.auth_time === 'number' && payload.auth_time > nowSec + skewSec) {
    throw new GoogleTokenVerificationError(
      'Waktu autentikasi Google tidak valid.',
      'INVALID_AUTH_TIME',
      401
    );
  }

  const signInProvider = payload.firebase?.sign_in_provider ?? 'unknown';
  if (requireGoogleProvider && signInProvider !== 'google.com') {
    throw new GoogleTokenVerificationError(
      'Akses KlipCast memerlukan akun yang diverifikasi melalui Google Sign-In.',
      'GOOGLE_PROVIDER_REQUIRED',
      401
    );
  }

  return {
    uid: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    emailVerified: Boolean(payload.email_verified),
    name: typeof payload.name === 'string' ? payload.name : null,
    picture: typeof payload.picture === 'string' ? payload.picture : null,
    signInProvider,
    authTime: typeof payload.auth_time === 'number' ? payload.auth_time : payload.iat,
    expiresAt: payload.exp,
  };
}

function loadConfiguredProjectId(): string {
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as { projectId?: string };
  if (!parsed.projectId) {
    throw new Error('Konfigurasi Firebase projectId tidak ditemukan.');
  }
  return parsed.projectId;
}

async function fetchGoogleSecureTokenCerts(forceRefresh = false): Promise<Record<string, string>> {
  if (!forceRefresh && certCache && Date.now() < certCache.expiresAtMs) {
    return certCache.certs;
  }

  const res = await fetch(GOOGLE_SECURETOKEN_CERTS_URL, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new GoogleTokenVerificationError(
      'Gagal mengunduh sertifikat verifikasi publik Google.',
      'CERT_FETCH_FAILED',
      503
    );
  }
  const certs = (await res.json()) as Record<string, string>;
  const ttlMs = parseCacheControlMaxAgeMs(res.headers.get('cache-control'));
  certCache = {
    certs,
    expiresAtMs: Date.now() + ttlMs,
  };
  return certs;
}

export async function verifyFirebaseGoogleIdToken(
  idToken: string
): Promise<VerifiedGoogleIdentity> {
  const projectId = loadConfiguredProjectId();
  let certs = await fetchGoogleSecureTokenCerts(false);

  try {
    return verifyFirebaseGoogleIdTokenWithCerts({
      idToken,
      certsByKid: certs,
      projectId,
    });
  } catch (err) {
    if (err instanceof GoogleTokenVerificationError && err.code === 'UNKNOWN_KEY_ID') {
      certs = await fetchGoogleSecureTokenCerts(true);
      return verifyFirebaseGoogleIdTokenWithCerts({
        idToken,
        certsByKid: certs,
        projectId,
      });
    }
    throw err;
  }
}
