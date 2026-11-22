import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AccountStatus, UserRole } from '../src/types/clipper.ts';
import type { KlipCastDatabase } from './db.ts';
import {
  GoogleTokenVerificationError,
  verifyFirebaseGoogleIdToken,
  type VerifiedGoogleIdentity,
} from './googleAuthVerifier.ts';

export interface AuthenticatedUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  role: UserRole;
  status: AccountStatus;
  authTime: number;
  expiresAt: number;
}

export interface AuthenticatedRequest extends Request {
  authUser?: AuthenticatedUser;
}

export type FirebaseTokenVerifierFn = (idToken: string) => Promise<VerifiedGoogleIdentity>;

const DEFAULT_SUPER_ADMIN_EMAILS = ['yogandhika2132@gmail.com'];

function parseEmailList(raw: string | undefined, defaults: string[] = []): Set<string> {
  const set = new Set<string>(defaults.map((e) => e.trim().toLowerCase()));
  if (raw) {
    for (const entry of raw.split(',')) {
      const cleaned = entry.trim().toLowerCase();
      if (cleaned) set.add(cleaned);
    }
  }
  return set;
}

/**
 * Server-side role determination. Frontend input is NEVER trusted.
 * Environment allowlists (`SUPER_ADMIN_EMAILS`, `ADMIN_EMAILS`) bootstrap privileged roles,
 * while persisted DB roles allow super_admins to promote/demote users safely.
 */
export function resolveServerRole(
  email: string | null,
  existingDbRole?: UserRole | null
): UserRole {
  const normalizedEmail = (email ?? '').trim().toLowerCase();
  const superAdmins = parseEmailList(process.env.SUPER_ADMIN_EMAILS, DEFAULT_SUPER_ADMIN_EMAILS);
  const admins = parseEmailList(process.env.ADMIN_EMAILS, []);

  if (normalizedEmail && superAdmins.has(normalizedEmail)) {
    return 'super_admin';
  }
  if (existingDbRole === 'super_admin' || existingDbRole === 'admin') {
    return existingDbRole;
  }
  if (normalizedEmail && admins.has(normalizedEmail)) {
    return 'admin';
  }
  return 'user';
}

export function extractBearerOrHeaderIdToken(req: Request): string {
  const explicitHeader = req.header('X-Firebase-Id-Token')?.trim();
  if (explicitHeader) return explicitHeader;

  const authHeader = req.headers.authorization ?? '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) return match[1].trim();

  const bodyToken =
    typeof (req.body as { idToken?: unknown } | undefined)?.idToken === 'string'
      ? (req.body as { idToken: string }).idToken.trim()
      : '';
  return bodyToken;
}

export function getClientIp(req: Request): string {
  const fwd = (req.headers['x-forwarded-for'] ?? '').toString().split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

// Ephemeral HMAC key (or env override) used ONLY for short-lived signed <video> & SSE media stream tokens
const STREAM_TOKEN_SECRET =
  process.env.MEDIA_STREAM_SECRET?.trim() ||
  crypto.randomBytes(32).toString('hex');

export function createSignedStreamToken(params: {
  uid: string;
  resourceId: string;
  scope: 'clip_video' | 'render_sse';
  ttlSec?: number;
}): string {
  const exp = Math.floor(Date.now() / 1000) + (params.ttlSec ?? 900);
  const payload = Buffer.from(
    JSON.stringify({
      u: params.uid,
      r: params.resourceId,
      s: params.scope,
      e: exp,
    }),
    'utf8'
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', STREAM_TOKEN_SECRET)
    .update(payload)
    .digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySignedStreamToken(
  token: string,
  expectedScope: 'clip_video' | 'render_sse',
  expectedResourceId: string
): { uid: string } | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', STREAM_TOKEN_SECRET)
    .update(payload)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      u?: string;
      r?: string;
      s?: string;
      e?: number;
    };
    const nowSec = Math.floor(Date.now() / 1000);
    if (
      !decoded.u ||
      decoded.s !== expectedScope ||
      decoded.r !== expectedResourceId ||
      typeof decoded.e !== 'number' ||
      decoded.e < nowSec
    ) {
      return null;
    }
    return { uid: decoded.u };
  } catch {
    return null;
  }
}

export function createAuthMiddlewares(params: {
  db: KlipCastDatabase;
  verifyToken?: FirebaseTokenVerifierFn;
}) {
  const { db } = params;
  const verifyToken: FirebaseTokenVerifierFn =
    params.verifyToken ?? verifyFirebaseGoogleIdToken;

  async function authenticateRequest(req: AuthenticatedRequest): Promise<AuthenticatedUser> {
    const idToken = extractBearerOrHeaderIdToken(req);
    if (!idToken) {
      throw new GoogleTokenVerificationError(
        'Autentikasi diperlukan. Silakan masuk dengan akun Google terlebih dahulu.',
        'AUTH_REQUIRED',
        401
      );
    }

    const verified = await verifyToken(idToken);
    const existing = db.getUser(verified.uid);

    // Check explicit logout / session revocation
    if (existing && existing.revoked_before_sec > 0 && verified.authTime < existing.revoked_before_sec) {
      throw new GoogleTokenVerificationError(
        'Sesi Anda telah dicabut atau keluar. Silakan login kembali.',
        'SESSION_REVOKED',
        401
      );
    }

    const resolvedRole = resolveServerRole(verified.email, existing?.role ?? null);
    const dbUser = db.upsertAuthenticatedUser({
      uid: verified.uid,
      email: verified.email,
      displayName: verified.name,
      photoUrl: verified.picture,
      resolvedRole,
    });

    if (dbUser.role === 'super_admin') {
      db.claimLegacyDataIfPresent(dbUser.uid);
    }

    if (dbUser.status === 'suspended') {
      throw new GoogleTokenVerificationError(
        'Akun Anda sedang ditangguhkan oleh administrator. Hubungi tim dukungan untuk informasi lebih lanjut.',
        'ACCOUNT_SUSPENDED',
        403
      );
    }

    const authUser: AuthenticatedUser = {
      uid: dbUser.uid,
      email: dbUser.email,
      emailVerified: verified.emailVerified,
      name: dbUser.display_name,
      picture: dbUser.photo_url,
      role: dbUser.role,
      status: dbUser.status,
      authTime: verified.authTime,
      expiresAt: verified.expiresAt,
    };
    req.authUser = authUser;
    return authUser;
  }

  const requireAuth = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      await authenticateRequest(req);
      next();
    } catch (err) {
      if (err instanceof GoogleTokenVerificationError) {
        res.status(err.status).json({
          code: err.code,
          error: err.message,
        });
        return;
      }
      res.status(401).json({
        code: 'AUTH_INVALID',
        error: 'Token autentikasi tidak valid atau sudah kedaluwarsa.',
      });
    }
  };

  const requireRole =
    (allowedRoles: readonly UserRole[]) =>
    (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
      const user = req.authUser;
      if (!user) {
        res.status(401).json({
          code: 'AUTH_REQUIRED',
          error: 'Autentikasi diperlukan.',
        });
        return;
      }
      if (!allowedRoles.includes(user.role)) {
        res.status(403).json({
          code: 'FORBIDDEN_ROLE',
          error: 'Anda tidak memiliki izin akses untuk halaman atau tindakan ini.',
        });
        return;
      }
      next();
    };

  return {
    authenticateRequest,
    requireAuth,
    requireRole,
    requireAdmin: requireRole(['admin', 'super_admin']),
    requireSuperAdmin: requireRole(['super_admin']),
  };
}
