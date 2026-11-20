export const DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MiB chunks (always safe under Cloud Run 32 MiB limit)

export interface DownloadByteRangePlan {
  index: number;
  start: number;
  end: number;
}

/**
 * Splits a file of `totalBytes` into inclusive HTTP byte ranges of at most `chunkBytes`
 * so arbitrarily large 1080p/4K MP4 files download cleanly through proxies with response-size limits.
 */
export function buildChunkedDownloadPlan(
  totalBytes: number,
  chunkBytes: number = DOWNLOAD_CHUNK_BYTES
): DownloadByteRangePlan[] {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    return [];
  }
  const safeChunk = Math.max(256 * 1024, Math.floor(chunkBytes));
  const plans: DownloadByteRangePlan[] = [];
  let offset = 0;
  let index = 0;
  while (offset < totalBytes) {
    const end = Math.min(totalBytes - 1, offset + safeChunk - 1);
    plans.push({ index, start: offset, end });
    offset = end + 1;
    index += 1;
  }
  return plans;
}

export function formatMegabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0.0 MB';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Downloads a video MP4 in safe 4 MiB HTTP Range chunks (bypassing 32 MiB proxy caps for large
 * high-bitrate 1080p/4K master clips), assembles a local Blob, and triggers a browser file download.
 */
export async function downloadVideoInChunks(params: {
  url: string;
  filename: string;
  onProgress?: (loadedBytes: number, totalBytes: number, percent: number) => void;
}): Promise<void> {
  const { url, filename, onProgress } = params;

  // Probe total size via HEAD first (returns Content-Length without transferring body)
  const headRes = await fetch(url, { method: 'HEAD', cache: 'no-store' });
  if (!headRes.ok) {
    throw new Error(`Gagal memeriksa ukuran file video (HTTP ${headRes.status}).`);
  }

  const totalBytes = Number.parseInt(headRes.headers.get('Content-Length') ?? '0', 10);
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    throw new Error('Ukuran file video tidak valid untuk diunduh.');
  }

  const plan = buildChunkedDownloadPlan(totalBytes, DOWNLOAD_CHUNK_BYTES);
  const buffers: ArrayBuffer[] = new Array(plan.length);
  let loadedBytes = 0;
  onProgress?.(0, totalBytes, 0);

  // Fetch chunks sequentially with automatic retry on transient 429/5xx blips
  for (const chunk of plan) {
    let chunkData: ArrayBuffer | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Range: `bytes=${chunk.start}-${chunk.end}`,
        },
        cache: 'no-store',
      });
      if (res.status === 206 || res.status === 200) {
        chunkData = await res.arrayBuffer();
        break;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1500 + attempt * 1500));
        continue;
      }
      throw new Error(`Gagal mengunduh bagian video (HTTP ${res.status}).`);
    }
    if (!chunkData) {
      throw new Error('Gagal mengunduh potongan video secara utuh.');
    }
    buffers[chunk.index] = chunkData;
    loadedBytes += chunkData.byteLength;
    const pct = Math.min(100, Math.round((loadedBytes / totalBytes) * 100));
    onProgress?.(loadedBytes, totalBytes, pct);
  }

  const blob = new Blob(buffers, { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  }
}
