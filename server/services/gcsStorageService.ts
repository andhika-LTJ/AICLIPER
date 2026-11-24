/**
 * AICLIPER Fase 0B — Google Cloud Storage Media Service (Production-Enforced)
 *
 * Tenant-isolated object key convention:
 *   users/{userUid}/projects/{projectId}/{category}/{filename}
 *
 * Production security rules:
 *   - When `NODE_ENV === 'production'` (or `GCS_REQUIRED === 'true'`), `GCS_BUCKET_NAME`
 *     is MANDATORY. Missing config throws `GcsStorageError('GCS_NOT_CONFIGURED')` —
 *     NEVER silently falls back to local filesystem in production.
 *   - Strict object key validation prevents path traversal and cross-user access.
 *   - Content-type & file-size limits enforced on upload.
 *   - Resumable upload automatically enabled for large files (> 5 MiB).
 *   - Signed URLs are strictly scoped to the verified owner (or admin) with bounded TTL.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Storage } from '@google-cloud/storage';
import { redactSensitiveString } from './structuredLogger.ts';

export type StorageAssetCategory = 'sources' | 'renders' | 'thumbnails' | 'intro_assets' | 'temp';

export type GcsStorageErrorCode =
  | 'GCS_NOT_CONFIGURED'
  | 'INVALID_OBJECT_KEY'
  | 'UNAUTHORIZED_ACCESS'
  | 'FILE_TOO_LARGE'
  | 'INVALID_CONTENT_TYPE'
  | 'OBJECT_NOT_FOUND'
  | 'GCS_UNAVAILABLE'
  | 'UPLOAD_FAILED'
  | 'DOWNLOAD_FAILED'
  | 'CHECKSUM_MISMATCH'
  | 'INVALID_SIGNED_URL_TTL';

export class GcsStorageError extends Error {
  readonly code: GcsStorageErrorCode;
  readonly httpStatus: number;

  constructor(
    code: GcsStorageErrorCode,
    message: string,
    options: { httpStatus?: number; cause?: unknown } = {}
  ) {
    super(redactSensitiveString(message), options.cause ? { cause: options.cause } : undefined);
    this.name = 'GcsStorageError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? 500;
  }
}

export interface GcsConfig {
  bucketName: string;
  projectId: string;
  signedUrlTtlSec: number;
  localFallbackDir: string;
  maxUploadBytes: number;
  strictProduction: boolean;
}

export interface StoredObjectResult {
  backend: 'gcs' | 'local';
  bucketName: string | null;
  objectKey: string;
  gcsUri: string;
  localPath: string;
  sizeBytes: number;
  contentType: string;
  sha256: string;
  attemptsUsed?: number;
  resumableUsed?: boolean;
}

export interface GcsReadinessSnapshot {
  configured: boolean;
  authenticated: boolean;
  connected: boolean;
  operational: boolean;
  tested: boolean;
  bucketName: string | null;
  signedUrlTtlSec: number;
  strictProduction: boolean;
  mode: 'gcs' | 'local_fallback' | 'gcs_misconfigured' | 'gcs_unreachable';
  error?: string;
}

const VALID_OBJECT_KEY_REGEX =
  /^users\/[a-zA-Z0-9._-]{1,128}\/projects\/[a-zA-Z0-9._-]{1,128}\/(sources|renders|thumbnails|intro_assets|temp)\/[a-zA-Z0-9._-]{1,200}$/;

const ALLOWED_CONTENT_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/vtt',
  'application/json',
  'application/octet-stream',
]);

export const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024; // 5 MiB
const DEFAULT_MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB
const MIN_SIGNED_URL_TTL_SEC = 60;
const MAX_SIGNED_URL_TTL_SEC = 86_400; // 24 hours

let cachedStorageClient: Storage | null = null;

export function isProductionStorageEnforced(strictOverride?: boolean): boolean {
  if (typeof strictOverride === 'boolean') return strictOverride;
  return process.env.NODE_ENV === 'production' || process.env.GCS_REQUIRED === 'true';
}

export function getGcsConfig(override?: Partial<GcsConfig>): GcsConfig {
  const bucketName = (override?.bucketName ?? process.env.GCS_BUCKET_NAME ?? '').trim();
  const projectId = (override?.projectId ?? process.env.GCP_PROJECT_ID ?? '').trim();
  const ttlRaw = Number(override?.signedUrlTtlSec ?? process.env.GCS_SIGNED_URL_TTL_SECONDS ?? 3600);
  const signedUrlTtlSec = Number.isFinite(ttlRaw)
    ? Math.max(MIN_SIGNED_URL_TTL_SEC, Math.min(MAX_SIGNED_URL_TTL_SEC, Math.round(ttlRaw)))
    : 3600;
  const maxBytesRaw = Number(override?.maxUploadBytes ?? process.env.MAX_STORAGE_UPLOAD_BYTES ?? DEFAULT_MAX_UPLOAD_BYTES);
  const maxUploadBytes =
    Number.isFinite(maxBytesRaw) && maxBytesRaw > 0 ? maxBytesRaw : DEFAULT_MAX_UPLOAD_BYTES;
  const localFallbackDir =
    override?.localFallbackDir ??
    path.resolve(process.cwd(), process.env.LOCAL_STORAGE_DIR || path.join('data', 'storage'));
  const strictProduction = isProductionStorageEnforced(override?.strictProduction);

  return {
    bucketName,
    projectId,
    signedUrlTtlSec,
    localFallbackDir,
    maxUploadBytes,
    strictProduction,
  };
}

export function isGcsConfigured(override?: Partial<GcsConfig>): boolean {
  return Boolean(getGcsConfig(override).bucketName);
}

function getStorageClient(override?: Partial<GcsConfig>): Storage | null {
  const cfg = getGcsConfig(override);
  if (!cfg.bucketName) {
    if (cfg.strictProduction) {
      throw new GcsStorageError(
        'GCS_NOT_CONFIGURED',
        'GCS_BUCKET_NAME wajib dikonfigurasi di environment production. Fallback local filesystem dinonaktifkan di production.',
        { httpStatus: 503 }
      );
    }
    return null;
  }
  if (!cachedStorageClient) {
    cachedStorageClient = new Storage(cfg.projectId ? { projectId: cfg.projectId } : {});
  }
  return cachedStorageClient;
}

export function resetGcsClientForTests(): void {
  cachedStorageClient = null;
}

export function sanitizePathSegment(raw: string, fallback = 'item'): string {
  const cleaned = String(raw || '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^_+/, '')
    .slice(0, 120);
  return cleaned || fallback;
}

/**
 * Validates strict tenant-isolated object key format & blocks traversal attacks.
 */
export function validateObjectKey(objectKey: string): string {
  const normalized = String(objectKey || '').trim().replace(/^\/+/, '');
  if (
    !normalized ||
    normalized.includes('..') ||
    normalized.includes('\\') ||
    normalized.includes('\0') ||
    !VALID_OBJECT_KEY_REGEX.test(normalized)
  ) {
    throw new GcsStorageError(
      'INVALID_OBJECT_KEY',
      'Object key media tidak valid atau melanggar struktur isolasi tenant.',
      { httpStatus: 400 }
    );
  }
  return normalized;
}

/**
 * Extracts owner UID from a validated object key.
 */
export function extractOwnerUidFromObjectKey(objectKey: string): string {
  const valid = validateObjectKey(objectKey);
  const parts = valid.split('/');
  return parts[1];
}

/**
 * Enforces that the requesting user owns the object key (unless admin).
 */
export function assertUserOwnsObjectKey(
  requesterUid: string,
  objectKey: string,
  isAdmin = false
): string {
  const validKey = validateObjectKey(objectKey);
  const ownerUid = extractOwnerUidFromObjectKey(validKey);
  const safeRequester = sanitizePathSegment(requesterUid, '');
  if (!isAdmin && (!safeRequester || ownerUid !== safeRequester)) {
    throw new GcsStorageError(
      'UNAUTHORIZED_ACCESS',
      'Akses ditolak: pengguna tidak memiliki izin mengakses objek media milik pengguna lain.',
      { httpStatus: 403 }
    );
  }
  return validKey;
}

export function buildUserMediaObjectKey(params: {
  userUid: string;
  projectId: string;
  category: StorageAssetCategory;
  filename: string;
}): string {
  const safeUser = sanitizePathSegment(params.userUid, 'anon');
  const safeProject = sanitizePathSegment(params.projectId, 'default');
  const safeFile = sanitizePathSegment(params.filename, `asset_${Date.now()}`);
  return validateObjectKey(`users/${safeUser}/projects/${safeProject}/${params.category}/${safeFile}`);
}

export function parseGcsUri(gcsUri: string): { bucketName: string; objectKey: string } | null {
  const match = String(gcsUri || '').trim().match(/^gs:\/\/([a-z0-9._-]+)\/(.+)$/i);
  if (!match) return null;
  return {
    bucketName: match[1],
    objectKey: validateObjectKey(match[2]),
  };
}

export function validateUploadPolicy(params: {
  contentType: string;
  sizeBytes: number;
  maxUploadBytes?: number;
}): void {
  const normalizedType = String(params.contentType || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(normalizedType)) {
    throw new GcsStorageError(
      'INVALID_CONTENT_TYPE',
      `Tipe konten media tidak diizinkan: ${normalizedType || 'kosong'}.`,
      { httpStatus: 400 }
    );
  }
  const limit = params.maxUploadBytes ?? getGcsConfig().maxUploadBytes;
  if (!Number.isFinite(params.sizeBytes) || params.sizeBytes <= 0) {
    throw new GcsStorageError(
      'UPLOAD_FAILED',
      'File media kosong atau tidak dapat dibaca.',
      { httpStatus: 400 }
    );
  }
  if (params.sizeBytes > limit) {
    throw new GcsStorageError(
      'FILE_TOO_LARGE',
      `Ukuran file (${Math.round(params.sizeBytes / (1024 * 1024))} MB) melampaui batas maksimum (${Math.round(limit / (1024 * 1024))} MB).`,
      { httpStatus: 413 }
    );
  }
}

function classifyGcsError(err: unknown, fallbackCode: GcsStorageErrorCode): GcsStorageError {
  if (err instanceof GcsStorageError) return err;
  const anyErr = err as { code?: number | string; message?: string } | undefined;
  const code = anyErr?.code;
  const msg = redactSensitiveString(anyErr?.message || String(err));
  if (code === 404 || code === 'ENOENT' || /No such object/i.test(msg)) {
    return new GcsStorageError('OBJECT_NOT_FOUND', `Objek media tidak ditemukan di GCS: ${msg}`, {
      httpStatus: 404,
      cause: err,
    });
  }
  if (code === 403 || /Permission|Forbidden|does not have storage/i.test(msg)) {
    return new GcsStorageError('UNAUTHORIZED_ACCESS', `Izin GCS ditolak: ${msg}`, {
      httpStatus: 403,
      cause: err,
    });
  }
  if (code === 503 || code === 500 || code === 429 || /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|network/i.test(msg)) {
    return new GcsStorageError('GCS_UNAVAILABLE', `Layanan GCS tidak tersedia: ${msg}`, {
      httpStatus: 503,
      cause: err,
    });
  }
  return new GcsStorageError(fallbackCode, msg, { httpStatus: 502, cause: err });
}

export function computeFileSha256(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const buf = fs.readFileSync(filePath);
  hash.update(buf);
  return hash.digest('hex');
}

function isRetryableGcsError(err: unknown): boolean {
  if (err instanceof GcsStorageError) {
    return err.code === 'GCS_UNAVAILABLE';
  }
  const anyErr = err as { code?: number | string; message?: string } | undefined;
  const code = anyErr?.code;
  const msg = String(anyErr?.message ?? err ?? '');
  if (code === 400 || code === 401 || code === 403 || code === 404 || code === 413) {
    return false;
  }
  if (code === 429 || code === 500 || code === 502 || code === 503 || code === 504) {
    return true;
  }
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|socket hang up|503|429|temporarily unavailable/i.test(
    msg
  );
}

async function runWithGcsRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: { maxAttempts?: number; baseDelayMs?: number; sleepFn?: (ms: number) => Promise<void> } = {}
): Promise<{ result: T; attempts: number }> {
  const maxAttempts = Math.max(1, Math.min(5, options.maxAttempts ?? 3));
  const baseDelayMs = Math.max(10, options.baseDelayMs ?? 150);
  const sleep = options.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn(attempt);
      return { result, attempts: attempt };
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !isRetryableGcsError(err)) {
        throw err;
      }
      await sleep(baseDelayMs * Math.pow(2, attempt - 1));
    }
  }
  throw lastErr;
}

export interface GcsClientAdapter {
  uploadFile(localFilePath: string, objectKey: string, contentType: string, resumable: boolean): Promise<void>;
  downloadFile(objectKey: string, destinationPath: string): Promise<void>;
  getSignedReadUrl(objectKey: string, ttlSec: number): Promise<string>;
  deleteFile(objectKey: string): Promise<void>;
  exists(objectKey: string): Promise<boolean>;
  checkBucketAccess(): Promise<boolean>;
}

function buildRealGcsAdapter(storage: Storage, bucketName: string): GcsClientAdapter {
  const bucket = storage.bucket(bucketName);
  return {
    async uploadFile(localFilePath, objectKey, contentType, resumable) {
      await bucket.upload(localFilePath, {
        destination: objectKey,
        resumable,
        metadata: {
          contentType,
          cacheControl: 'private, max-age=3600',
        },
      });
    },
    async downloadFile(objectKey, destinationPath) {
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      await bucket.file(objectKey).download({ destination: destinationPath });
    },
    async getSignedReadUrl(objectKey, ttlSec) {
      const [url] = await bucket.file(objectKey).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + ttlSec * 1000,
      });
      return url;
    },
    async deleteFile(objectKey) {
      await bucket.file(objectKey).delete({ ignoreNotFound: false });
    },
    async exists(objectKey) {
      const [exists] = await bucket.file(objectKey).exists();
      return Boolean(exists);
    },
    async checkBucketAccess() {
      const [exists] = await bucket.exists();
      return Boolean(exists);
    },
  };
}

function resolveSafeLocalPath(localFallbackDir: string, objectKey: string): string {
  const validKey = validateObjectKey(objectKey);
  const root = path.resolve(localFallbackDir);
  const target = path.resolve(root, validKey);
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new GcsStorageError('INVALID_OBJECT_KEY', 'Path lokal keluar dari direktori storage.', {
      httpStatus: 400,
    });
  }
  return target;
}

/**
 * Uploads a local file to GCS (or dev/test local storage if not in production).
 */
export async function uploadLocalFileToStorage(
  params: {
    localFilePath: string;
    userUid: string;
    projectId: string;
    category: StorageAssetCategory;
    filename: string;
    contentType?: string;
    maxRetries?: number;
    retryBaseDelayMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
    configOverride?: Partial<GcsConfig>;
    gcsAdapter?: GcsClientAdapter;
  }
): Promise<StoredObjectResult> {
  const cfg = getGcsConfig(params.configOverride);
  const objectKey = buildUserMediaObjectKey({
    userUid: params.userUid,
    projectId: params.projectId,
    category: params.category,
    filename: params.filename,
  });
  const contentType = params.contentType || 'video/mp4';

  if (!fs.existsSync(params.localFilePath)) {
    throw new GcsStorageError(
      'OBJECT_NOT_FOUND',
      'File lokal sumber yang akan diunggah tidak ditemukan.',
      { httpStatus: 404 }
    );
  }
  const stat = fs.statSync(params.localFilePath);
  validateUploadPolicy({
    contentType,
    sizeBytes: stat.size,
    maxUploadBytes: cfg.maxUploadBytes,
  });

  const sha256 = computeFileSha256(params.localFilePath);
  const resumable = stat.size > RESUMABLE_UPLOAD_THRESHOLD_BYTES;
  const maxAttempts = params.maxRetries !== undefined ? Math.max(1, params.maxRetries) : 3;

  if (params.gcsAdapter) {
    if (!cfg.bucketName) {
      throw new GcsStorageError('GCS_NOT_CONFIGURED', 'GCS_BUCKET_NAME belum dikonfigurasi.', {
        httpStatus: 503,
      });
    }
    try {
      const { attempts } = await runWithGcsRetry(
        () => params.gcsAdapter!.uploadFile(params.localFilePath, objectKey, contentType, resumable),
        { maxAttempts, baseDelayMs: params.retryBaseDelayMs, sleepFn: params.sleepFn }
      );
      return {
        backend: 'gcs',
        bucketName: cfg.bucketName,
        objectKey,
        gcsUri: `gs://${cfg.bucketName}/${objectKey}`,
        localPath: params.localFilePath,
        sizeBytes: stat.size,
        contentType,
        sha256,
        attemptsUsed: attempts,
        resumableUsed: resumable,
      };
    } catch (err) {
      throw classifyGcsError(err, 'UPLOAD_FAILED');
    }
  }

  const client = getStorageClient(params.configOverride);
  if (client && cfg.bucketName) {
    const adapter = buildRealGcsAdapter(client, cfg.bucketName);
    try {
      const { attempts } = await runWithGcsRetry(
        () => adapter.uploadFile(params.localFilePath, objectKey, contentType, resumable),
        { maxAttempts, baseDelayMs: params.retryBaseDelayMs, sleepFn: params.sleepFn }
      );
      return {
        backend: 'gcs',
        bucketName: cfg.bucketName,
        objectKey,
        gcsUri: `gs://${cfg.bucketName}/${objectKey}`,
        localPath: params.localFilePath,
        sizeBytes: stat.size,
        contentType,
        sha256,
        attemptsUsed: attempts,
        resumableUsed: resumable,
      };
    } catch (err) {
      throw classifyGcsError(err, 'UPLOAD_FAILED');
    }
  }

  // Dev/test local fallback ONLY (production already threw GCS_NOT_CONFIGURED above)
  const targetLocalPath = resolveSafeLocalPath(cfg.localFallbackDir, objectKey);
  fs.mkdirSync(path.dirname(targetLocalPath), { recursive: true });
  if (path.resolve(params.localFilePath) !== targetLocalPath) {
    fs.copyFileSync(params.localFilePath, targetLocalPath);
  }
  return {
    backend: 'local',
    bucketName: null,
    objectKey,
    gcsUri: '',
    localPath: targetLocalPath,
    sizeBytes: stat.size,
    contentType,
    sha256,
    attemptsUsed: 1,
    resumableUsed: false,
  };
}

/**
 * Downloads a media object (by objectKey or gs:// URI) into a local path, enforcing user ownership
 * and optional SHA-256 checksum integrity verification.
 */
export async function downloadMediaToLocalPath(params: {
  objectKey: string;
  requesterUid: string;
  destinationPath: string;
  isAdmin?: boolean;
  expectedSha256?: string;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  configOverride?: Partial<GcsConfig>;
  gcsAdapter?: GcsClientAdapter;
}): Promise<{ localPath: string; sizeBytes: number; sha256: string; backend: 'gcs' | 'local' }> {
  const cfg = getGcsConfig(params.configOverride);
  const parsed = params.objectKey.startsWith('gs://') ? parseGcsUri(params.objectKey) : null;
  const rawKey = parsed ? parsed.objectKey : params.objectKey;
  const validKey = assertUserOwnsObjectKey(params.requesterUid, rawKey, Boolean(params.isAdmin));
  const maxAttempts = params.maxRetries !== undefined ? Math.max(1, params.maxRetries) : 3;

  fs.mkdirSync(path.dirname(params.destinationPath), { recursive: true });

  const verifyChecksum = (): { localPath: string; sizeBytes: number; sha256: string } => {
    const stat = fs.statSync(params.destinationPath);
    const sha256 = computeFileSha256(params.destinationPath);
    if (params.expectedSha256 && sha256 !== params.expectedSha256.trim().toLowerCase()) {
      if (fs.existsSync(params.destinationPath)) {
        fs.rmSync(params.destinationPath, { force: true });
      }
      throw new GcsStorageError(
        'CHECKSUM_MISMATCH',
        'Integritas file unduhan tidak cocok dengan checksum SHA-256 yang diharapkan.',
        { httpStatus: 502 }
      );
    }
    return { localPath: params.destinationPath, sizeBytes: stat.size, sha256 };
  };

  if (params.gcsAdapter) {
    if (!cfg.bucketName && !parsed?.bucketName) {
      throw new GcsStorageError('GCS_NOT_CONFIGURED', 'GCS_BUCKET_NAME belum dikonfigurasi.', {
        httpStatus: 503,
      });
    }
    try {
      await runWithGcsRetry(
        () => params.gcsAdapter!.downloadFile(validKey, params.destinationPath),
        { maxAttempts, baseDelayMs: params.retryBaseDelayMs, sleepFn: params.sleepFn }
      );
      return { ...verifyChecksum(), backend: 'gcs' };
    } catch (err) {
      throw classifyGcsError(err, 'DOWNLOAD_FAILED');
    }
  }

  const client = getStorageClient(params.configOverride);
  const targetBucket = parsed?.bucketName || cfg.bucketName;
  if (client && targetBucket) {
    const adapter = buildRealGcsAdapter(client, targetBucket);
    try {
      await runWithGcsRetry(
        () => adapter.downloadFile(validKey, params.destinationPath),
        { maxAttempts, baseDelayMs: params.retryBaseDelayMs, sleepFn: params.sleepFn }
      );
      return { ...verifyChecksum(), backend: 'gcs' };
    } catch (err) {
      throw classifyGcsError(err, 'DOWNLOAD_FAILED');
    }
  }

  const sourceLocal = resolveSafeLocalPath(cfg.localFallbackDir, validKey);
  if (!fs.existsSync(sourceLocal)) {
    throw new GcsStorageError(
      'OBJECT_NOT_FOUND',
      `Objek media lokal tidak ditemukan: ${validKey}`,
      { httpStatus: 404 }
    );
  }
  if (path.resolve(sourceLocal) !== path.resolve(params.destinationPath)) {
    fs.copyFileSync(sourceLocal, params.destinationPath);
  }
  return { ...verifyChecksum(), backend: 'local' };
}

/**
 * Generates an authorized v4 Signed URL for GCS (or dev fallback URL) after validating ownership & TTL.
 */
export async function generateSignedReadUrl(
  params: {
    objectKey: string;
    requesterUid?: string;
    isAdmin?: boolean;
    ttlSec?: number;
    configOverride?: Partial<GcsConfig>;
    gcsAdapter?: GcsClientAdapter;
  }
): Promise<{ url: string; backend: 'gcs' | 'local'; expiresAt: string; ttlSec: number } | null> {
  const cfg = getGcsConfig(params.configOverride);
  const validKey = params.requesterUid
    ? assertUserOwnsObjectKey(params.requesterUid, params.objectKey, Boolean(params.isAdmin))
    : validateObjectKey(params.objectKey);

  if (
    params.ttlSec !== undefined &&
    (!Number.isFinite(params.ttlSec) ||
      params.ttlSec < MIN_SIGNED_URL_TTL_SEC ||
      params.ttlSec > MAX_SIGNED_URL_TTL_SEC)
  ) {
    throw new GcsStorageError(
      'INVALID_SIGNED_URL_TTL',
      `TTL Signed URL harus berada di antara ${MIN_SIGNED_URL_TTL_SEC} dan ${MAX_SIGNED_URL_TTL_SEC} detik.`,
      { httpStatus: 400 }
    );
  }

  const ttlSec = params.ttlSec ?? cfg.signedUrlTtlSec;
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();

  if (params.gcsAdapter) {
    if (!cfg.bucketName) {
      throw new GcsStorageError('GCS_NOT_CONFIGURED', 'GCS_BUCKET_NAME belum dikonfigurasi.', {
        httpStatus: 503,
      });
    }
    try {
      const exists = await params.gcsAdapter.exists(validKey);
      if (!exists) {
        throw new GcsStorageError('OBJECT_NOT_FOUND', 'Objek media tidak ditemukan di GCS.', {
          httpStatus: 404,
        });
      }
      const url = await params.gcsAdapter.getSignedReadUrl(validKey, ttlSec);
      return { url, backend: 'gcs', expiresAt, ttlSec };
    } catch (err) {
      throw classifyGcsError(err, 'GCS_UNAVAILABLE');
    }
  }

  const client = getStorageClient(params.configOverride);
  if (client && cfg.bucketName) {
    const adapter = buildRealGcsAdapter(client, cfg.bucketName);
    try {
      const url = await adapter.getSignedReadUrl(validKey, ttlSec);
      return { url, backend: 'gcs', expiresAt, ttlSec };
    } catch (err) {
      throw classifyGcsError(err, 'GCS_UNAVAILABLE');
    }
  }

  const localPath = resolveSafeLocalPath(cfg.localFallbackDir, validKey);
  if (!fs.existsSync(localPath)) return null;
  return {
    url: `/api/v3/storage/local?key=${encodeURIComponent(validKey)}`,
    backend: 'local',
    expiresAt,
    ttlSec,
  };
}

/**
 * Deletes an object from GCS (or dev local fallback) after strict owner verification.
 */
export async function deleteStorageObject(params: {
  objectKey: string;
  requesterUid: string;
  isAdmin?: boolean;
  configOverride?: Partial<GcsConfig>;
  gcsAdapter?: GcsClientAdapter;
}): Promise<{ deleted: boolean; backend: 'gcs' | 'local'; objectKey: string }> {
  const cfg = getGcsConfig(params.configOverride);
  const validKey = assertUserOwnsObjectKey(
    params.requesterUid,
    params.objectKey,
    Boolean(params.isAdmin)
  );

  if (params.gcsAdapter) {
    if (!cfg.bucketName) {
      throw new GcsStorageError('GCS_NOT_CONFIGURED', 'GCS_BUCKET_NAME belum dikonfigurasi.', {
        httpStatus: 503,
      });
    }
    try {
      await params.gcsAdapter.deleteFile(validKey);
      return { deleted: true, backend: 'gcs', objectKey: validKey };
    } catch (err) {
      throw classifyGcsError(err, 'GCS_UNAVAILABLE');
    }
  }

  const client = getStorageClient(params.configOverride);
  if (client && cfg.bucketName) {
    const adapter = buildRealGcsAdapter(client, cfg.bucketName);
    try {
      await adapter.deleteFile(validKey);
      return { deleted: true, backend: 'gcs', objectKey: validKey };
    } catch (err) {
      throw classifyGcsError(err, 'GCS_UNAVAILABLE');
    }
  }

  const localPath = resolveSafeLocalPath(cfg.localFallbackDir, validKey);
  if (!fs.existsSync(localPath)) {
    throw new GcsStorageError('OBJECT_NOT_FOUND', 'Objek media tidak ditemukan.', {
      httpStatus: 404,
    });
  }
  fs.unlinkSync(localPath);
  return { deleted: true, backend: 'local', objectKey: validKey };
}

export function resolveLocalFallbackObjectPath(
  objectKey: string,
  configOverride?: Partial<GcsConfig>
): string | null {
  const cfg = getGcsConfig(configOverride);
  try {
    const candidate = resolveSafeLocalPath(cfg.localFallbackDir, objectKey);
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Performs honest 5-level GCS readiness verification (never reports connected/operational
 * merely because an env var is set).
 */
export async function checkGcsReadiness(options?: {
  configOverride?: Partial<GcsConfig>;
  gcsAdapter?: GcsClientAdapter;
}): Promise<GcsReadinessSnapshot> {
  const cfg = getGcsConfig(options?.configOverride);
  if (!cfg.bucketName) {
    return {
      configured: false,
      authenticated: false,
      connected: false,
      operational: false,
      tested: false,
      bucketName: null,
      signedUrlTtlSec: cfg.signedUrlTtlSec,
      strictProduction: cfg.strictProduction,
      mode: cfg.strictProduction ? 'gcs_misconfigured' : 'local_fallback',
      error: cfg.strictProduction
        ? 'GCS_BUCKET_NAME wajib diatur di mode production.'
        : 'GCS_BUCKET_NAME belum dikonfigurasi (memakai local storage fallback di development).',
    };
  }

  try {
    const adapter =
      options?.gcsAdapter ??
      buildRealGcsAdapter(getStorageClient(options?.configOverride)!, cfg.bucketName);
    const exists = await adapter.checkBucketAccess();
    if (!exists) {
      return {
        configured: true,
        authenticated: true,
        connected: false,
        operational: false,
        tested: false,
        bucketName: cfg.bucketName,
        signedUrlTtlSec: cfg.signedUrlTtlSec,
        strictProduction: cfg.strictProduction,
        mode: 'gcs_unreachable',
        error: `Bucket GCS "${cfg.bucketName}" tidak ditemukan atau tidak dapat diakses.`,
      };
    }
    return {
      configured: true,
      authenticated: true,
      connected: true,
      operational: true,
      tested: true,
      bucketName: cfg.bucketName,
      signedUrlTtlSec: cfg.signedUrlTtlSec,
      strictProduction: cfg.strictProduction,
      mode: 'gcs',
    };
  } catch (err) {
    const classified = classifyGcsError(err, 'GCS_UNAVAILABLE');
    return {
      configured: true,
      authenticated: classified.code !== 'UNAUTHORIZED_ACCESS',
      connected: false,
      operational: false,
      tested: false,
      bucketName: cfg.bucketName,
      signedUrlTtlSec: cfg.signedUrlTtlSec,
      strictProduction: cfg.strictProduction,
      mode: 'gcs_unreachable',
      error: classified.message,
    };
  }
}

export function getGcsStatusSummary(): {
  configured: boolean;
  bucketName: string | null;
  signedUrlTtlSec: number;
  strictProduction: boolean;
  mode: 'gcs' | 'local_fallback' | 'gcs_misconfigured';
} {
  const cfg = getGcsConfig();
  return {
    configured: Boolean(cfg.bucketName),
    bucketName: cfg.bucketName || null,
    signedUrlTtlSec: cfg.signedUrlTtlSec,
    strictProduction: cfg.strictProduction,
    mode: cfg.bucketName
      ? 'gcs'
      : cfg.strictProduction
        ? 'gcs_misconfigured'
        : 'local_fallback',
  };
}
