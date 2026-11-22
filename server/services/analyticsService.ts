import type {
  AnalyticsOverviewData,
  AnalyticsSnapshot,
  SocialPlatform,
} from '../../src/types/clipper.ts';
import type { KlipCastDatabase } from '../db.ts';
import type { V2Repository } from '../repositories/v2Repository.ts';

const ALL_PLATFORMS: SocialPlatform[] = [
  'youtube_shorts',
  'tiktok',
  'instagram_reels',
  'facebook_reels',
  'x_twitter',
  'linkedin',
];

/**
 * Aggregates strictly REAL user metrics from SQLite and synced YouTube Data API v3 snapshots.
 * Never fabricates or extrapolates fake views/engagement numbers.
 */
export function buildUserAnalyticsOverview(
  db: KlipCastDatabase,
  v2Repo: V2Repository,
  userUid: string
): AnalyticsOverviewData {
  const episodes = db.listUserEpisodes(userUid, 500, 0);
  const clips = db.listUserClips(userUid, 1000, 0);
  const renderJobs = db.listRenderJobs({ userUid, limit: 500 });
  const snapshots = v2Repo.listAnalyticsSnapshots(userUid);

  const renderedClips = clips.filter((c) => Boolean(c.renderedClipUrl)).length;
  const publishedClips = clips.filter(
    (c) => c.status === 'published_auto' || c.status === 'published_manual'
  ).length;
  const scheduledClips = clips.filter((c) => c.status === 'scheduled').length;
  const youtubeUploadedClips = clips.filter((c) => Boolean(c.youtubeVideoId)).length;

  const scores = clips
    .map((c) => c.qualityScores?.overallScore ?? c.viralScore)
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  const avgQualityScore =
    scores.length > 0
      ? Math.round((scores.reduce((acc, s) => acc + s, 0) / scores.length) * 10) / 10
      : null;

  const ytSnapshots = snapshots.filter((s) => s.source === 'youtube_api');
  const youtubeViews =
    ytSnapshots.length > 0 ? ytSnapshots.reduce((acc, s) => acc + s.views, 0) : null;
  const youtubeLikes =
    ytSnapshots.length > 0 ? ytSnapshots.reduce((acc, s) => acc + s.likes, 0) : null;
  const youtubeComments =
    ytSnapshots.length > 0 ? ytSnapshots.reduce((acc, s) => acc + s.comments, 0) : null;

  const lastYoutubeSyncAt = ytSnapshots.length > 0 ? ytSnapshots[0].lastSyncedAt : null;

  // Group clips by contentStyle / momentType
  const approachMap = new Map<
    string,
    { clipCount: number; scoreSum: number; scoreCount: number; publishedCount: number }
  >();
  for (const clip of clips) {
    const key = clip.contentStyle || clip.qualityScores?.momentType || 'general';
    const current = approachMap.get(key) ?? {
      clipCount: 0,
      scoreSum: 0,
      scoreCount: 0,
      publishedCount: 0,
    };
    current.clipCount += 1;
    const score = clip.qualityScores?.overallScore ?? clip.viralScore;
    if (typeof score === 'number' && Number.isFinite(score)) {
      current.scoreSum += score;
      current.scoreCount += 1;
    }
    if (clip.status === 'published_auto' || clip.status === 'published_manual') {
      current.publishedCount += 1;
    }
    approachMap.set(key, current);
  }

  const byApproach = Array.from(approachMap.entries())
    .map(([approach, data]) => ({
      approach,
      clipCount: data.clipCount,
      avgScore:
        data.scoreCount > 0 ? Math.round((data.scoreSum / data.scoreCount) * 10) / 10 : null,
      publishedCount: data.publishedCount,
    }))
    .sort((a, b) => b.clipCount - a.clipCount);

  const byPlatform = ALL_PLATFORMS.map((platform) => ({
    platform,
    publishedCount: clips.filter((c) => c.publishedPlatforms.includes(platform)).length,
  }));

  return {
    sourceSummary: {
      internalDb: true,
      youtubeApiSyncedCount: ytSnapshots.length,
      lastYoutubeSyncAt,
    },
    totals: {
      episodes: episodes.length,
      clips: clips.length,
      renderedClips,
      publishedClips,
      scheduledClips,
      youtubeUploadedClips,
      totalRendersCompleted: renderJobs.filter((j) => j.status === 'completed').length,
      totalRendersFailed: renderJobs.filter((j) => j.status === 'failed').length,
      avgQualityScore,
      youtubeViews,
      youtubeLikes,
      youtubeComments,
    },
    byApproach,
    byPlatform,
    snapshots,
  };
}

/**
 * Syncs REAL YouTube video statistics via YouTube Data API v3 (`videos?part=statistics`)
 * for clips that have a real `youtubeVideoId` uploaded by the authenticated user.
 */
export async function syncYouTubeStatsForUser(params: {
  db: KlipCastDatabase;
  v2Repo: V2Repository;
  userUid: string;
  youtubeAccessToken: string;
}): Promise<{ synced: AnalyticsSnapshot[]; skippedCount: number; message: string }> {
  const clips = params.db.listUserClips(params.userUid, 500, 0);
  const ytClips = clips.filter(
    (c) => typeof c.youtubeVideoId === 'string' && /^[a-zA-Z0-9_-]{6,20}$/.test(c.youtubeVideoId)
  );

  if (ytClips.length === 0) {
    return {
      synced: [],
      skippedCount: clips.length,
      message:
        'Belum ada klip yang diunggah langsung ke YouTube Shorts (youtubeVideoId kosong). Unggah klip via YouTube Direct Upload terlebih dahulu untuk menyinkronkan statistik nyata.',
    };
  }

  const batch = ytClips.slice(0, 50);
  const idToClip = new Map(batch.map((c) => [c.youtubeVideoId!, c]));
  const idsParam = Array.from(idToClip.keys()).join(',');

  const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(idsParam)}`;
  const res = await fetch(apiUrl, {
    headers: {
      Authorization: `Bearer ${params.youtubeAccessToken}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        'Token OAuth YouTube tidak memiliki izin baca statistik atau sudah kedaluwarsa. Hubungkan ulang akun YouTube Anda.'
      );
    }
    throw new Error(`YouTube Data API v3 mengembalikan status ${res.status}: ${errBody.slice(0, 140)}`);
  }

  const payload = (await res.json()) as {
    items?: Array<{
      id?: string;
      statistics?: {
        viewCount?: string;
        likeCount?: string;
        commentCount?: string;
      };
    }>;
  };

  const synced: AnalyticsSnapshot[] = [];
  for (const item of payload.items ?? []) {
    if (!item.id) continue;
    const clip = idToClip.get(item.id);
    if (!clip) continue;
    const snapshot = params.v2Repo.upsertAnalyticsSnapshot({
      userUid: params.userUid,
      clipId: clip.id,
      platform: 'youtube_shorts',
      externalVideoId: item.id,
      source: 'youtube_api',
      views: Number(item.statistics?.viewCount ?? 0),
      likes: Number(item.statistics?.likeCount ?? 0),
      comments: Number(item.statistics?.commentCount ?? 0),
      shares: 0,
    });
    synced.push({ ...snapshot, clipTitle: clip.title });
  }

  return {
    synced,
    skippedCount: Math.max(0, clips.length - synced.length),
    message:
      synced.length > 0
        ? `Berhasil menyinkronkan statistik real YouTube Data API v3 untuk ${synced.length} klip.`
        : 'YouTube Data API tidak mengembalikan statistik untuk video yang dipilih (pastikan video masih aktif dan milik channel Anda).',
  };
}
