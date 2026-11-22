import type { PlanTier, QuotaSummary } from '../src/types/clipper.ts';
import { getCurrentPeriodYm, type KlipCastDatabase } from './db.ts';

export class QuotaExceededError extends Error {
  status = 403;
  code = 'QUOTA_EXCEEDED';
  resource: string;
  limit: number;
  used: number;

  constructor(message: string, resource: string, used: number, limit: number) {
    super(message);
    this.name = 'QuotaExceededError';
    this.resource = resource;
    this.used = used;
    this.limit = limit;
  }
}

/**
 * Transparent public-pricing estimate for Gemini API calls (USD per 1M tokens).
 */
export function estimateGeminiCostUsd(
  model: string,
  promptTokens: number,
  outputTokens: number
): number {
  const m = model.toLowerCase();
  let inputPer1M = 0.25;
  let outputPer1M = 1.5;

  if (m.includes('flash-lite')) {
    inputPer1M = 0.1;
    outputPer1M = 0.4;
  } else if (m.includes('pro')) {
    inputPer1M = 1.25;
    outputPer1M = 5.0;
  } else if (m.includes('hydrogen') || m.includes('flash')) {
    inputPer1M = 0.25;
    outputPer1M = 1.5;
  }

  const cost = (Math.max(0, promptTokens) / 1_000_000) * inputPer1M +
    (Math.max(0, outputTokens) / 1_000_000) * outputPer1M;
  return Number(cost.toFixed(6));
}

export function getUserQuotaSummary(
  db: KlipCastDatabase,
  userUid: string,
  periodYm = getCurrentPeriodYm()
): QuotaSummary {
  const sub = db.ensureSubscription(userUid);
  const usage = db.getOrCreateUsageRecord(userUid, periodYm);
  const projectsUsed = db.countUserEpisodes(userUid);

  return {
    planTier: sub.plan_tier as PlanTier,
    periodYm,
    aiAnalysesUsed: usage.ai_analyses_used,
    monthlyAiLimit: sub.monthly_ai_limit,
    rendersUsed: usage.renders_used,
    monthlyRenderLimit: sub.monthly_render_limit,
    uploadsUsed: usage.uploads_used,
    monthlyUploadLimit: sub.monthly_upload_limit,
    storageBytesUsed: usage.storage_bytes_used,
    maxStorageMb: sub.max_storage_mb,
    maxVideoDurationSec: sub.max_video_duration_sec,
    maxExportQuality: sub.max_export_quality,
    maxProjects: sub.max_projects,
    projectsUsed,
  };
}

function maybeNotifyQuotaWarning(
  db: KlipCastDatabase,
  userUid: string,
  label: string,
  used: number,
  limit: number
): void {
  if (limit <= 0) return;
  const ratio = used / limit;
  if (ratio >= 0.8 && used <= limit) {
    const pct = Math.min(100, Math.round(ratio * 100));
    db.createNotification({
      userUid,
      type: 'quota_warning',
      title: `Kuota ${label} Mencapai ${pct}%`,
      message: `Pemakaian ${label} bulan ini sudah ${used} dari ${limit}. Pantau penggunaan Anda di Dashboard.`,
    });
  }
}

export function assertQuotaAvailable(
  db: KlipCastDatabase,
  userUid: string,
  resource: 'ai' | 'render' | 'upload' | 'project' | 'quality_4k',
  options?: { incomingBytes?: number; videoDurationSec?: number }
): QuotaSummary {
  const q = getUserQuotaSummary(db, userUid);

  if (resource === 'ai' && q.aiAnalysesUsed >= q.monthlyAiLimit) {
    throw new QuotaExceededError(
      `Kuota analisis AI bulanan paket ${q.planTier.toUpperCase()} (${q.monthlyAiLimit}x/bulan) sudah habis.`,
      'ai',
      q.aiAnalysesUsed,
      q.monthlyAiLimit
    );
  }

  if (resource === 'render' && q.rendersUsed >= q.monthlyRenderLimit) {
    throw new QuotaExceededError(
      `Kuota render video bulanan paket ${q.planTier.toUpperCase()} (${q.monthlyRenderLimit}x/bulan) sudah habis.`,
      'render',
      q.rendersUsed,
      q.monthlyRenderLimit
    );
  }

  if (resource === 'upload') {
    if (q.uploadsUsed >= q.monthlyUploadLimit) {
      throw new QuotaExceededError(
        `Kuota unggah bulanan paket ${q.planTier.toUpperCase()} (${q.monthlyUploadLimit}x/bulan) sudah habis.`,
        'upload',
        q.uploadsUsed,
        q.monthlyUploadLimit
      );
    }
    const maxBytes = q.maxStorageMb * 1024 * 1024;
    if (options?.incomingBytes && q.storageBytesUsed + options.incomingBytes > maxBytes) {
      throw new QuotaExceededError(
        `Batas penyimpanan paket ${q.planTier.toUpperCase()} (${q.maxStorageMb} MB) terlampaui.`,
        'storage',
        Math.round((q.storageBytesUsed + options.incomingBytes) / (1024 * 1024)),
        q.maxStorageMb
      );
    }
  }

  if (resource === 'project' && q.projectsUsed >= q.maxProjects) {
    throw new QuotaExceededError(
      `Jumlah episode aktif mencapai batas paket ${q.planTier.toUpperCase()} (${q.maxProjects} proyek).`,
      'project',
      q.projectsUsed,
      q.maxProjects
    );
  }

  if (resource === 'quality_4k' && q.maxExportQuality !== '4k') {
    throw new QuotaExceededError(
      `Ekspor 4K Ultra HD tersedia mulai paket Pro & Business (paket saat ini: ${q.planTier.toUpperCase()}). Gunakan 1080p Full HD atau tingkatkan paket.`,
      'quality_4k',
      1,
      0
    );
  }

  if (
    options?.videoDurationSec &&
    options.videoDurationSec > q.maxVideoDurationSec
  ) {
    throw new QuotaExceededError(
      `Durasi video (${Math.round(options.videoDurationSec / 60)} menit) melebihi batas paket ${q.planTier.toUpperCase()} (${Math.round(q.maxVideoDurationSec / 60)} menit).`,
      'duration',
      options.videoDurationSec,
      q.maxVideoDurationSec
    );
  }

  return q;
}

export function consumeQuota(
  db: KlipCastDatabase,
  userUid: string,
  resource: 'ai' | 'render' | 'upload',
  storageBytesDelta = 0
): QuotaSummary {
  db.incrementUsageRecord(userUid, {
    aiAnalyses: resource === 'ai' ? 1 : 0,
    renders: resource === 'render' ? 1 : 0,
    uploads: resource === 'upload' ? 1 : 0,
    storageBytesDelta,
  });

  const updated = getUserQuotaSummary(db, userUid);
  if (resource === 'ai') {
    maybeNotifyQuotaWarning(db, userUid, 'Analisis AI', updated.aiAnalysesUsed, updated.monthlyAiLimit);
  } else if (resource === 'render') {
    maybeNotifyQuotaWarning(db, userUid, 'Render Video', updated.rendersUsed, updated.monthlyRenderLimit);
  } else if (resource === 'upload') {
    maybeNotifyQuotaWarning(db, userUid, 'Unggah Video', updated.uploadsUsed, updated.monthlyUploadLimit);
  }
  return updated;
}

export function trackGeminiApiUsage(
  db: KlipCastDatabase,
  params: {
    userUid: string;
    operation: string;
    model: string;
    promptTokens: number;
    outputTokens: number;
    cached?: boolean;
  }
): { estimatedCostUsd: number } {
  const estimatedCostUsd = params.cached
    ? 0
    : estimateGeminiCostUsd(params.model, params.promptTokens, params.outputTokens);
  db.recordApiUsage({
    userUid: params.userUid,
    operation: params.operation,
    model: params.model,
    promptTokens: params.promptTokens,
    outputTokens: params.outputTokens,
    estimatedCostUsd,
    cached: Boolean(params.cached),
  });
  return { estimatedCostUsd };
}
