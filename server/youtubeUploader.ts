import fs from 'fs';
import { Readable } from 'stream';

export type YouTubePrivacyStatus = 'public' | 'unlisted' | 'private';

export interface YouTubeUploadMetadataInput {
  title: string;
  description: string;
  tags?: string[];
  privacyStatus?: YouTubePrivacyStatus;
  includeShortsTag?: boolean;
}

export interface YouTubeApiVideoPayload {
  snippet: {
    title: string;
    description: string;
    tags: string[];
    categoryId: string;
  };
  status: {
    privacyStatus: YouTubePrivacyStatus;
    selfDeclaredMadeForKids: boolean;
  };
}

export function buildYouTubeUploadMetadata(
  input: YouTubeUploadMetadataInput
): YouTubeApiVideoPayload {
  const includeShorts = input.includeShortsTag !== false;
  let title = (input.title || 'Podcast Clip').replace(/\s+/g, ' ').trim();
  if (includeShorts && !/#shorts\b/i.test(title)) {
    const candidate = `${title} #Shorts`;
    if (candidate.length <= 100) {
      title = candidate;
    } else {
      title = `${title.slice(0, 92).trim()} #Shorts`;
    }
  }
  if (title.length > 100) {
    title = title.slice(0, 100).trim();
  }

  let description = (input.description || '').trim();
  if (includeShorts && !/#shorts\b/i.test(description)) {
    description = description ? `${description}\n\n#Shorts` : '#Shorts';
  }
  if (description.length > 5000) {
    description = description.slice(0, 5000).trim();
  }

  const normalizedTags: string[] = [];
  const seen = new Set<string>();
  const rawTags = [...(input.tags ?? []), ...(includeShorts ? ['Shorts'] : [])];
  for (const raw of rawTags) {
    const cleaned = raw.replace(/^#+/, '').replace(/[^\p{L}\p{N}_\- ]/gu, '').trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedTags.push(cleaned);
    if (normalizedTags.length >= 15) break;
  }

  const privacyStatus: YouTubePrivacyStatus =
    input.privacyStatus === 'public' ||
    input.privacyStatus === 'unlisted' ||
    input.privacyStatus === 'private'
      ? input.privacyStatus
      : 'private';

  return {
    snippet: {
      title,
      description,
      tags: normalizedTags,
      categoryId: '22',
    },
    status: {
      privacyStatus,
      selfDeclaredMadeForKids: false,
    },
  };
}

export function parseYouTubeApiError(status: number, rawBody: string): {
  message: string;
  needsReauth: boolean;
} {
  let reason = '';
  let apiMessage = '';

  try {
    const parsed = JSON.parse(rawBody) as {
      error?: {
        message?: string;
        errors?: Array<{ reason?: string; message?: string }>;
      };
    };
    apiMessage = parsed.error?.message ?? '';
    reason = parsed.error?.errors?.[0]?.reason ?? '';
  } catch {
    apiMessage = rawBody.slice(0, 200);
  }

  if (reason === 'youtubeSignupRequired') {
    return {
      needsReauth: false,
      message:
        'Akun Google ini belum memiliki channel YouTube aktif. Buka youtube.com lalu buat channel terlebih dahulu.',
    };
  }

  if (reason === 'quotaExceeded' || reason === 'uploadLimitExceeded') {
    return {
      needsReauth: false,
      message:
        'Kuota harian upload YouTube API pada project sedang penuh. Coba lagi besok atau unggah manual lewat YouTube Studio.',
    };
  }

  if (reason === 'insufficientPermissions' || reason === 'forbidden') {
    return {
      needsReauth: true,
      message:
        'Izin unggah video YouTube belum disetujui. Silakan login ulang dan centang izin mengelola upload YouTube.',
    };
  }

  if (status === 401 || reason === 'authError' || reason === 'unauthorized') {
    return {
      needsReauth: true,
      message:
        'Sesi login Google untuk YouTube sudah kedaluwarsa atau belum memiliki izin unggah. Silakan klik Masuk dengan Google ulang.',
    };
  }

  return {
    needsReauth: false,
    message: apiMessage
      ? `Gagal mengunggah ke YouTube (${status}): ${apiMessage}`
      : `Gagal mengunggah video ke YouTube (HTTP ${status}).`,
  };
}

export class YouTubeUploadHttpError extends Error {
  status: number;
  needsReauth: boolean;

  constructor(status: number, message: string, needsReauth: boolean) {
    super(message);
    this.name = 'YouTubeUploadHttpError';
    this.status = status;
    this.needsReauth = needsReauth;
  }
}

export async function uploadVideoFileToYouTube(params: {
  accessToken: string;
  filePath: string;
  metadata: YouTubeApiVideoPayload;
}): Promise<{ youtubeVideoId: string; youtubeWatchUrl: string }> {
  const { accessToken, filePath, metadata } = params;
  if (!fs.existsSync(filePath)) {
    throw new Error('File video MP4 hasil render tidak ditemukan di server.');
  }

  const stat = fs.statSync(filePath);
  if (stat.size < 10_000) {
    throw new Error('File video MP4 terlalu kecil atau rusak untuk diunggah ke YouTube.');
  }

  // Step 1: Initiate YouTube Data API v3 Resumable Upload session
  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(stat.size),
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify(metadata),
      signal: AbortSignal.timeout(20_000),
    }
  );

  if (!initRes.ok) {
    const errBody = await initRes.text();
    const parsed = parseYouTubeApiError(initRes.status, errBody);
    throw new YouTubeUploadHttpError(
      parsed.needsReauth ? 401 : initRes.status,
      parsed.message,
      parsed.needsReauth
    );
  }

  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) {
    throw new Error('YouTube tidak mengembalikan URL sesi resumable upload.');
  }

  // Step 2: Stream the MP4 file directly from disk to YouTube
  const nodeStream = fs.createReadStream(filePath);
  const webBody = Readable.toWeb(nodeStream) as unknown as BodyInit;

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Length': String(stat.size),
      'Content-Type': 'video/mp4',
    },
    body: webBody,
    // Required by Node.js undici fetch when sending ReadableStream body
    ...({ duplex: 'half' } as Record<string, unknown>),
    signal: AbortSignal.timeout(180_000),
  });

  const uploadText = await uploadRes.text();
  if (!uploadRes.ok) {
    const parsed = parseYouTubeApiError(uploadRes.status, uploadText);
    throw new YouTubeUploadHttpError(
      parsed.needsReauth ? 401 : uploadRes.status,
      parsed.message,
      parsed.needsReauth
    );
  }

  const uploaded = JSON.parse(uploadText) as { id?: string };
  if (!uploaded.id) {
    throw new Error('Unggahan selesai tetapi ID video YouTube tidak diterima.');
  }

  return {
    youtubeVideoId: uploaded.id,
    youtubeWatchUrl: `https://www.youtube.com/shorts/${uploaded.id}`,
  };
}
