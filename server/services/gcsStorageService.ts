import fs from 'fs';
import path from 'path';
import { Storage } from '@google-cloud/storage';

export type StorageAssetCategory = 'sources' | 'renders' | 'thumbnails' | 'intro_assets' | 'temp';

export interface GcsReadinessStatus {
  configured: boolean;
  bucketName: string;
  signedUrlTtlSec: number;
  mode: 'google_cloud_storage' | 'local_filesystem_fallback';
}

export interface StoredMediaDescriptor {
  backend: 'gcs' | 'local';
  objectKey: string;
  gcsUri: string;
  localPath: string;
  sizeBytes: number;
  contentType: string;
}

const LOCAL_STORAGE_ROOT = path.resolve(process.cwd(), 'data', 'storage');

let storageClient: Storage | null = null;

function getBucketName(): string {
  return (process.env.GCS_BUCKET_NAME || '').trim();
}

export function isGcsConfigured(): boolean {
  return Boolean(getBucketName());
}

export function getGcsReadinessStatus(): GcsReadinessStatus {
  const bucketName = getBucketName();
  const signedUrlTtlSec = Math.max(
    60,
    Math.min(86_400, Number(process.env.GCS_SIGNED_URL_TTL_SEC) || 3600)
  );
  return {
    configured: Boolean(bucketName),
    bucketName,
    signedUrlTtlSec,
    mode: bucketName ? 'google_cloud_storage' : 'local_filesystem_fallback',
  };
}

function getStorageClient(): Storage {
  if (!storageClient) {
    storageClient = new Storage({
      projectId: process.env.GCP_PROJECT_ID || undefined,
    });
  }
  return storageClient;
}

function sanitizeSegment(input: string): string {
  const cleaned = input.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_');
  return cleaned.slice(0, 120) || 'item';
}

/**
 * Builds an isolated per-user, per-project GCS object key to prevent cross-tenant collisions or traversal.
 */
export function buildUserObjectKey(params: {
  userUid: string;
  projectId: string;
  category: StorageAssetCategory;
  filename: string;
}): string {
  const safeUser = sanitizeSegment(params.userUid);
  const safeProject = sanitizeSegment(params.projectId);
  const safeCategory = sanitizeSegment(params.category);
  const safeFile = sanitizeSegment(path.basename(params.filename));
  return `users/${safeUser}/projects/${safeProject}/${safeCategory}/${safeFile}`;
}

function resolveSafeLocalPath(objectKey: string): string {
  const normalized = path.normalize(objectKey).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.resolve(LOCAL_STORAGE_ROOT, normalized);
  if (!full.startsWith(LOCAL_STORAGE_ROOT + path.sep) && full !== LOCAL_STORAGE_ROOT) {
    throw new Error('Path traversal ditolak pada storage lokal.');
  }
  return full;
}

export async function uploadFileToMediaStorage(params: {
  localFilePath: string;
  userUid: string;
  projectId: string;
  category: StorageAssetCategory;
  filename: string;
  contentType?: string;
}): Promise<StoredMediaDescriptor> {
  if (!fs.existsSync(params.localFilePath)) {
    throw new Error('File sumber tidak ditemukan untuk diunggah ke storage.');
  }
  const stat = fs.statSync(params.localFilePath);
  const contentType = params.contentType || 'video/mp4';
  const objectKey = buildUserObjectKey({
    userUid: params.userUid,
    projectId: params.projectId,
    category: params.category,
    filename: params.filename,
  });

  const bucketName = getBucketName();
  if (bucketName) {
    const bucket = getStorageClient().bucket(bucketName);
    await bucket.upload(params.localFilePath, {
      destination: objectKey,
      resumable: stat.size > 5 * 1024 * 1024,
      metadata: {
        contentType,
        cacheControl: 'private, max-age=3600',
        metadata: {
          userUid: params.userUid,
          projectId: params.projectId,
          category: params.category,
        },
      },
    });
    return {
      backend: 'gcs',
      objectKey,
      gcsUri: `gs://${bucketName}/${objectKey}`,
      localPath: params.localFilePath,
      sizeBytes: stat.size,
      contentType,
    };
  }

  // Honest local-development fallback when GCS_BUCKET_NAME is not yet provisioned
  const destPath = resolveSafeLocalPath(objectKey);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (path.resolve(params.localFilePath) !== destPath) {
    fs.copyFileSync(params.localFilePath, destPath);
  }
  return {
    backend: 'local',
    objectKey,
    gcsUri: '',
    localPath: destPath,
    sizeBytes: stat.size,
    contentType,
  };
}

export async function downloadMediaToLocalPath(params: {
  objectKey: string;
  destinationPath: string;
}): Promise<string> {
  const bucketName = getBucketName();
  fs.mkdirSync(path.dirname(params.destinationPath), { recursive: true });
  if (bucketName) {
    await getStorageClient()
      .bucket(bucketName)
      .file(params.objectKey)
      .download({ destination: params.destinationPath });
    return params.destinationPath;
  }
  const localSrc = resolveSafeLocalPath(params.objectKey);
  if (!fs.existsSync(localSrc)) {
    throw new Error('Media tidak ditemukan pada local storage fallback.');
  }
  if (path.resolve(localSrc) !== path.resolve(params.destinationPath)) {
    fs.copyFileSync(localSrc, params.destinationPath);
  }
  return params.destinationPath;
}

export async function getSignedMediaUrl(params: {
  objectKey: string;
  expiresInSec?: number;
  action?: 'read' | 'write';
  contentType?: string;
}): Promise<{ url: string; backend: 'gcs' | 'local'; expiresAt: string }> {
  const ttlSec = Math.max(
    60,
    Math.min(86_400, params.expiresInSec ?? (Number(process.env.GCS_SIGNED_URL_TTL_SEC) || 3600))
  );
  const expiresAtMs = Date.now() + ttlSec * 1000;
  const bucketName = getBucketName();

  if (bucketName) {
    const [url] = await getStorageClient()
      .bucket(bucketName)
      .file(params.objectKey)
      .getSignedUrl({
        version: 'v4',
        action: params.action ?? 'read',
        expires: expiresAtMs,
        ...(params.contentType ? { contentType: params.contentType } : {}),
      });
    return {
      url,
      backend: 'gcs',
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  return {
    url: `/api/v3/storage/local?key=${encodeURIComponent(params.objectKey)}`,
    backend: 'local',
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export async function deleteMediaObject(objectKey: string): Promise<boolean> {
  const bucketName = getBucketName();
  if (bucketName) {
    try {
      await getStorageClient().bucket(bucketName).file(objectKey).delete({ ignoreNotFound: true });
      return true;
    } catch {
      return false;
    }
  }
  const localPath = resolveSafeLocalPath(objectKey);
  if (fs.existsSync(localPath)) {
    fs.unlinkSync(localPath);
    return true;
  }
  return false;
}
