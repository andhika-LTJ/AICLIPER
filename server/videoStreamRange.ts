export const DEFAULT_MAX_RANGE_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MiB per 206 chunk (well below Cloud Run 32 MiB response limit)

export interface ResolvedByteRange {
  status: 206 | 416;
  start: number;
  end: number;
  chunkLength: number;
  totalSize: number;
  contentRange: string;
}

/**
 * Parses an HTTP Range header (e.g. `bytes=0-`, `bytes=1048576-2097151`, `bytes=-65536`)
 * and caps each 206 Partial Content response to `maxChunkBytes` so large HD/4K MP4 videos
 * stream smoothly through reverse proxies with response-size limits (e.g., 32 MiB on Cloud Run).
 */
export function resolveCappedByteRange(
  rangeHeader: string,
  totalSize: number,
  maxChunkBytes: number = DEFAULT_MAX_RANGE_CHUNK_BYTES
): ResolvedByteRange | null {
  if (!Number.isFinite(totalSize) || totalSize <= 0) {
    return null;
  }

  const trimmed = rangeHeader.trim();
  const match = /^bytes=(\d*)-(\d*)$/i.exec(trimmed);
  if (!match) {
    return null;
  }

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) {
    return null;
  }

  const safeMaxChunk = Math.max(64 * 1024, Math.floor(maxChunkBytes));
  let start: number;
  let requestedEnd: number;

  if (!rawStart && rawEnd) {
    // Suffix byte range: bytes=-N (last N bytes)
    const suffixLen = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) {
      return {
        status: 416,
        start: 0,
        end: 0,
        chunkLength: 0,
        totalSize,
        contentRange: `bytes */${totalSize}`,
      };
    }
    start = Math.max(0, totalSize - suffixLen);
    requestedEnd = totalSize - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    requestedEnd = rawEnd ? Number.parseInt(rawEnd, 10) : totalSize - 1;
  }

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(requestedEnd) ||
    start < 0 ||
    start >= totalSize ||
    requestedEnd < start
  ) {
    return {
      status: 416,
      start: 0,
      end: 0,
      chunkLength: 0,
      totalSize,
      contentRange: `bytes */${totalSize}`,
    };
  }

  const boundedEnd = Math.min(requestedEnd, totalSize - 1, start + safeMaxChunk - 1);
  const chunkLength = boundedEnd - start + 1;

  return {
    status: 206,
    start,
    end: boundedEnd,
    chunkLength,
    totalSize,
    contentRange: `bytes ${start}-${boundedEnd}/${totalSize}`,
  };
}
