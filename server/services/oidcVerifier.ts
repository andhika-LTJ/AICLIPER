/**
 * AICLIPER Fase 0B — Cloud Tasks OIDC JWT Verifier
 *
 * Validates Google-signed OIDC ID tokens attached by Google Cloud Tasks to internal
 * dispatcher requests (`/api/internal/dispatch/render` and `/workers/render/execute`).
 *
 * Security checks performed:
 *   1. Authorization: Bearer <jwt> header presence
 *   2. Cryptographic signature verification via Google JWKS (`OAuth2Client.verifyIdToken`)
 *   3. Exact audience (`aud`) match against configured dispatcher endpoint / base URL
 *   4. Issuer (`iss`) check (`https://accounts.google.com` or `accounts.google.com`)
 *   5. Service account email (`email`) & `email_verified` match against `CLOUD_TASKS_OIDC_SA_EMAIL`
 */

import type { NextFunction, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { logStructuredEvent, redactSensitiveString } from './structuredLogger.ts';

export type OidcErrorCode =
  | 'OIDC_UNCONFIGURED'
  | 'OIDC_MISSING'
  | 'OIDC_INVALID'
  | 'OIDC_ISSUER_MISMATCH'
  | 'OIDC_AUDIENCE_MISMATCH'
  | 'OIDC_SA_MISMATCH';

export class OidcVerificationError extends Error {
  readonly code: OidcErrorCode;
  readonly httpStatus: number;

  constructor(code: OidcErrorCode, message: string, httpStatus = 401) {
    super(redactSensitiveString(message));
    this.name = 'OidcVerificationError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface VerifiedOidcCaller {
  email: string;
  subject: string;
  audience: string;
  issuer: string;
  expiresAtSec: number;
}

export interface OidcVerifierConfig {
  expectedServiceAccountEmail: string;
  allowedAudiences: string[];
}

export interface OidcTokenClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  email?: string;
  email_verified?: boolean;
  exp?: number;
}

export type VerifyIdTokenFn = (params: {
  idToken: string;
  audience: string | string[];
}) => Promise<OidcTokenClaims>;

const VALID_GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

let cachedOAuthClient: OAuth2Client | null = null;

function getOAuthClient(): OAuth2Client {
  if (!cachedOAuthClient) {
    cachedOAuthClient = new OAuth2Client();
  }
  return cachedOAuthClient;
}

export function getOidcVerifierConfig(override?: Partial<OidcVerifierConfig>): OidcVerifierConfig {
  const expectedServiceAccountEmail = (
    override?.expectedServiceAccountEmail ??
    process.env.CLOUD_TASKS_OIDC_SA_EMAIL ??
    ''
  )
    .trim()
    .toLowerCase();

  if (override?.allowedAudiences && override.allowedAudiences.length > 0) {
    return {
      expectedServiceAccountEmail,
      allowedAudiences: override.allowedAudiences.map((a) => a.trim().replace(/\/+$/, '')),
    };
  }

  const baseUrl = (process.env.WORKER_DISPATCH_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const explicitAudience = (process.env.CLOUD_TASKS_OIDC_AUDIENCE ?? '').trim().replace(/\/+$/, '');
  const audiences = new Set<string>();
  if (explicitAudience) audiences.add(explicitAudience);
  if (baseUrl) {
    audiences.add(baseUrl);
    audiences.add(`${baseUrl}/api/internal/dispatch/render`);
    audiences.add(`${baseUrl}/workers/render/execute`);
  }

  return {
    expectedServiceAccountEmail,
    allowedAudiences: Array.from(audiences),
  };
}

export async function verifyCloudTasksOidcToken(params: {
  authorizationHeader?: string;
  configOverride?: Partial<OidcVerifierConfig>;
  verifyIdTokenFn?: VerifyIdTokenFn;
}): Promise<VerifiedOidcCaller> {
  const cfg = getOidcVerifierConfig(params.configOverride);
  if (!cfg.expectedServiceAccountEmail || cfg.allowedAudiences.length === 0) {
    throw new OidcVerificationError(
      'OIDC_UNCONFIGURED',
      'Konfigurasi OIDC dispatcher belum lengkap (wajib set CLOUD_TASKS_OIDC_SA_EMAIL dan WORKER_DISPATCH_BASE_URL / CLOUD_TASKS_OIDC_AUDIENCE).',
      503
    );
  }

  const header = (params.authorizationHeader ?? '').trim();
  const match = header.match(/^Bearer\s+([^\s]+)$/i);
  if (!match || !match[1]) {
    throw new OidcVerificationError(
      'OIDC_MISSING',
      'Header Authorization Bearer OIDC token wajib disertakan pada internal dispatcher.',
      401
    );
  }

  const idToken = match[1];
  let claims: OidcTokenClaims | undefined;
  try {
    if (params.verifyIdTokenFn) {
      claims = await params.verifyIdTokenFn({
        idToken,
        audience: cfg.allowedAudiences,
      });
    } else {
      const client = getOAuthClient();
      const ticket = await client.verifyIdToken({
        idToken,
        audience: cfg.allowedAudiences,
      });
      claims = ticket.getPayload();
    }
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    if (/audience|aud/i.test(rawMsg)) {
      throw new OidcVerificationError(
        'OIDC_AUDIENCE_MISMATCH',
        'Audience OIDC token tidak cocok dengan endpoint dispatcher yang diizinkan.',
        403
      );
    }
    throw new OidcVerificationError(
      'OIDC_INVALID',
      `Verifikasi OIDC token gagal: ${redactSensitiveString(rawMsg)}`,
      401
    );
  }

  if (!claims) {
    throw new OidcVerificationError('OIDC_INVALID', 'Payload OIDC token kosong.', 401);
  }

  const issuer = String(claims.iss ?? '').trim();
  if (!VALID_GOOGLE_ISSUERS.has(issuer)) {
    throw new OidcVerificationError(
      'OIDC_ISSUER_MISMATCH',
      `Issuer OIDC token tidak valid: ${issuer || 'kosong'}.`,
      403
    );
  }

  const tokenAudList = Array.isArray(claims.aud)
    ? claims.aud.map((a) => String(a).trim().replace(/\/+$/, ''))
    : [String(claims.aud ?? '').trim().replace(/\/+$/, '')];
  const matchedAud = tokenAudList.find((aud) => cfg.allowedAudiences.includes(aud));
  if (!matchedAud) {
    throw new OidcVerificationError(
      'OIDC_AUDIENCE_MISMATCH',
      'Audience OIDC token tidak cocok dengan konfigurasi dispatcher.',
      403
    );
  }

  const email = String(claims.email ?? '').trim().toLowerCase();
  if (!email || claims.email_verified === false || email !== cfg.expectedServiceAccountEmail) {
    throw new OidcVerificationError(
      'OIDC_SA_MISMATCH',
      'Service account OIDC tidak diizinkan memanggil dispatcher render.',
      403
    );
  }

  if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) {
    throw new OidcVerificationError('OIDC_INVALID', 'OIDC token sudah kedaluwarsa.', 401);
  }

  return {
    email,
    subject: String(claims.sub ?? email),
    audience: matchedAud,
    issuer,
    expiresAtSec: Number(claims.exp ?? 0),
  };
}

export interface OidcAuthenticatedRequest extends Request {
  oidcCaller?: VerifiedOidcCaller;
}

export function createCloudTasksOidcMiddleware(options?: {
  configOverride?: Partial<OidcVerifierConfig>;
  verifyIdTokenFn?: VerifyIdTokenFn;
}) {
  return async (req: OidcAuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const caller = await verifyCloudTasksOidcToken({
        authorizationHeader: req.headers.authorization,
        configOverride: options?.configOverride,
        verifyIdTokenFn: options?.verifyIdTokenFn,
      });
      req.oidcCaller = caller;
      next();
    } catch (err) {
      const oidcErr =
        err instanceof OidcVerificationError
          ? err
          : new OidcVerificationError('OIDC_INVALID', 'Autentikasi OIDC gagal.', 401);
      logStructuredEvent({
        service: 'internal-render-dispatcher',
        event: 'oidc_verification_rejected',
        severity: 'WARNING',
        stage: 'oidc_auth',
        errorCode: oidcErr.code,
        errorMessage: oidcErr.message,
        path: req.originalUrl,
      });
      res.status(oidcErr.httpStatus).json({
        error: oidcErr.message,
        code: oidcErr.code,
      });
    }
  };
}
