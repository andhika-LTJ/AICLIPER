import crypto from 'crypto';
import { and, desc, eq } from 'drizzle-orm';
import { getPgDb, isPostgresConfigured, sanitizePgError } from '../../src/db/index.ts';
import {
  cameraTrackingSegments,
  cameraTrackingSettings,
  clipCandidates,
  faceTracks,
  introTemplateVersions,
  jobEvents,
  performanceMetrics,
  projects,
  renderAssets,
  sourceAssets,
  speakerProfiles,
  speakerSegments,
  userIntroTemplates,
  users,
} from '../../src/db/schema.ts';
import type {
  BalancedRenderProfile,
  CameraFramingMode,
  CameraTrackingSegment,
  CameraTrackingSettings,
  FaceTrackCandidate,
  IntroTemplateCategory,
  IntroTemplateDefinition,
  IntroTemplateVersionRecord,
  JobEventRecord,
  MultiSpeakerLayoutMode,
  PerformanceMetricRecord,
  PodcastClip,
  PodcastEpisode,
  RenderAssetRecord,
  SourceAssetRecord,
  SpeakerProfile,
  SpeakerSegment,
  UserIntroTemplateRecord,
} from '../../src/types/clipper.ts';
import type { KlipCastDatabase } from '../db.ts';
import { DEFAULT_CAMERA_TRACKING_SETTINGS, normalizeCameraTrackingSettings } from '../services/activeSpeakerEngine.ts';
import { normalizeIntroTemplateDefinition } from '../services/introRenderCompiler.ts';

function genId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export interface ObservabilityMetricsSummary {
  totalRecordedOperations: number;
  cacheHitCount: number;
  cacheHitRate: number;
  avgDurationByCategory: Array<{
    category: string;
    count: number;
    avgDurationMs: number;
    successRate: number;
    cacheHitRate: number;
  }>;
  recentMetrics: PerformanceMetricRecord[];
}

export class V3Repository {
  constructor(private readonly sqliteDb: KlipCastDatabase) {}

  private async ensurePgParents(params: {
    userUid: string;
    episode?: PodcastEpisode | null;
    clip?: PodcastClip | null;
  }): Promise<void> {
    if (!isPostgresConfigured()) return;
    const pgDb = getPgDb();
    const userRow = this.sqliteDb.getUser(params.userUid);
    await pgDb
      .insert(users)
      .values({
        uid: params.userUid,
        email: userRow?.email || '',
        displayName: userRow?.display_name || '',
        avatarUrl: userRow?.photo_url || '',
        role: userRow?.role || 'user',
        status: userRow?.status || 'active',
      })
      .onConflictDoUpdate({
        target: users.uid,
        set: {
          email: userRow?.email || '',
          displayName: userRow?.display_name || '',
          updatedAt: new Date(),
        },
      });

    if (params.episode) {
      await pgDb
        .insert(projects)
        .values({
          id: params.episode.id,
          userUid: params.userUid,
          title: params.episode.title,
          sourceUrl: params.episode.sourceUrl,
          sourceVideoId: params.episode.videoId,
          channelName: params.episode.channelName,
          durationSec: Math.round(params.episode.durationSec || 0),
          thumbnailUrl: params.episode.thumbnailUrl,
        })
        .onConflictDoNothing({ target: projects.id });
    }

    if (params.clip) {
      await pgDb
        .insert(clipCandidates)
        .values({
          id: params.clip.id,
          projectId: params.clip.episodeId,
          userUid: params.userUid,
          title: params.clip.title,
          hook: params.clip.hookLine,
          startSec: params.clip.startSec,
          endSec: params.clip.endSec,
          durationSec: Math.max(1, params.clip.endSec - params.clip.startSec),
          viralScore: params.clip.viralScore ?? 0,
          status: params.clip.status,
        })
        .onConflictDoNothing({ target: clipCandidates.id });
    }
  }

  async getCameraData(clipId: string): Promise<{
    settings: CameraTrackingSettings;
    speakers: SpeakerProfile[];
    faceTracks: FaceTrackCandidate[];
    speakerSegments: SpeakerSegment[];
    cameraSegments: CameraTrackingSegment[];
  }> {
    if (isPostgresConfigured()) {
      try {
        const pgDb = getPgDb();
        const [setRow] = await pgDb
          .select()
          .from(cameraTrackingSettings)
          .where(eq(cameraTrackingSettings.clipId, clipId));
        const spkRows = await pgDb
          .select()
          .from(speakerProfiles)
          .where(eq(speakerProfiles.clipId, clipId));
        const ftRows = await pgDb
          .select()
          .from(faceTracks)
          .where(eq(faceTracks.clipId, clipId));
        const spkSegRows = await pgDb
          .select()
          .from(speakerSegments)
          .where(eq(speakerSegments.clipId, clipId));
        const camRows = await pgDb
          .select()
          .from(cameraTrackingSegments)
          .where(eq(cameraTrackingSegments.clipId, clipId));

        if (setRow || spkRows.length > 0 || camRows.length > 0) {
          return {
            settings: setRow
              ? {
                  clipId: setRow.clipId,
                  autoMode: setRow.autoMode,
                  framingMode: setRow.framingMode as CameraFramingMode,
                  multiSpeakerLayout: setRow.multiSpeakerLayout as MultiSpeakerLayoutMode,
                  lockedSpeakerKey: setRow.lockedSpeakerKey,
                  ignoredSpeakerKeys: setRow.ignoredSpeakerKeysJson,
                  trackingSensitivity: setRow.trackingSensitivity,
                  switchingSensitivity: setRow.switchingSensitivity,
                  minShotDurationSec: setRow.minShotDurationSec,
                  confidenceThreshold: setRow.confidenceThreshold,
                  cooldownSec: setRow.cooldownSec,
                  manualCropX: setRow.manualCropX,
                  manualCropY: setRow.manualCropY,
                  manualZoom: setRow.manualZoom,
                }
              : { clipId, ...DEFAULT_CAMERA_TRACKING_SETTINGS },
            speakers: spkRows.map((r) => ({
              id: r.id,
              clipId: r.clipId,
              speakerKey: r.speakerKey,
              label: r.label,
              colorHex: r.colorHex,
              avgCenterX: r.avgCenterX,
              avgCenterY: r.avgCenterY,
              speakingRatio: r.speakingRatio,
              avgConfidence: r.avgConfidence,
              isLocked: r.isLocked,
              isIgnored: r.isIgnored,
            })),
            faceTracks: ftRows.map((r) => ({
              speakerKey: r.speakerKey,
              timeSec: r.timeSec,
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              mouthActivity: r.mouthActivity,
              trackingConfidence: r.trackingConfidence,
              occluded: r.occluded,
            })),
            speakerSegments: spkSegRows.map((r) => ({
              id: r.id,
              clipId: r.clipId,
              speakerKey: r.speakerKey,
              startSec: r.startSec,
              endSec: r.endSec,
              audioActivityScore: r.audioActivityScore,
              lipSyncScore: r.lipSyncScore,
              diarizationScore: r.diarizationScore,
              activeSpeakerScore: r.activeSpeakerScore,
              transcriptExcerpt: r.transcriptExcerpt,
            })),
            cameraSegments: camRows.map((r) => ({
              id: r.id,
              clipId: r.clipId,
              startSec: r.startSec,
              endSec: r.endSec,
              activeSpeakerKey: r.activeSpeakerKey,
              framingMode: r.framingMode as CameraFramingMode,
              layoutMode: r.layoutMode as MultiSpeakerLayoutMode,
              targetX: r.targetX,
              targetY: r.targetY,
              zoom: r.zoom,
              confidence: r.confidence,
              reason: r.reason,
              isManualOverride: r.isManualOverride,
            })),
          };
        }
      } catch (err) {
        const mapped = sanitizePgError(err);
        throw new Error(mapped.error, { cause: err });
      }
    }

    const local = this.sqliteDb.getCameraAnalysisData(clipId);
    const clipRow = this.sqliteDb.getClipByIdInternal(clipId);
    const settings =
      local.settings ??
      normalizeCameraTrackingSettings(clipId, clipRow?.clip.cameraTrackingSettings);
    return {
      settings,
      speakers: local.speakers,
      faceTracks: local.faceTracks,
      speakerSegments: local.speakerSegments,
      cameraSegments: local.cameraSegments,
    };
  }

  async saveCameraSettings(params: {
    userUid: string;
    clip: PodcastClip;
    episode?: PodcastEpisode | null;
    settings: Partial<CameraTrackingSettings>;
  }): Promise<CameraTrackingSettings> {
    const normalized = normalizeCameraTrackingSettings(params.clip.id, params.settings);
    this.sqliteDb.saveCameraTrackingSettings(params.userUid, normalized);
    this.sqliteDb.upsertClip(params.userUid, {
      ...params.clip,
      cameraTrackingSettings: normalized,
    });

    if (isPostgresConfigured()) {
      try {
        await this.ensurePgParents({
          userUid: params.userUid,
          episode: params.episode,
          clip: params.clip,
        });
        const pgDb = getPgDb();
        await pgDb
          .insert(cameraTrackingSettings)
          .values({
            clipId: normalized.clipId,
            userUid: params.userUid,
            autoMode: normalized.autoMode,
            framingMode: normalized.framingMode,
            multiSpeakerLayout: normalized.multiSpeakerLayout,
            lockedSpeakerKey: normalized.lockedSpeakerKey,
            ignoredSpeakerKeysJson: normalized.ignoredSpeakerKeys,
            trackingSensitivity: normalized.trackingSensitivity,
            switchingSensitivity: normalized.switchingSensitivity,
            minShotDurationSec: normalized.minShotDurationSec,
            confidenceThreshold: normalized.confidenceThreshold,
            cooldownSec: normalized.cooldownSec,
            manualCropX: normalized.manualCropX,
            manualCropY: normalized.manualCropY,
            manualZoom: normalized.manualZoom,
          })
          .onConflictDoUpdate({
            target: cameraTrackingSettings.clipId,
            set: {
              autoMode: normalized.autoMode,
              framingMode: normalized.framingMode,
              multiSpeakerLayout: normalized.multiSpeakerLayout,
              lockedSpeakerKey: normalized.lockedSpeakerKey,
              ignoredSpeakerKeysJson: normalized.ignoredSpeakerKeys,
              trackingSensitivity: normalized.trackingSensitivity,
              switchingSensitivity: normalized.switchingSensitivity,
              minShotDurationSec: normalized.minShotDurationSec,
              confidenceThreshold: normalized.confidenceThreshold,
              cooldownSec: normalized.cooldownSec,
              manualCropX: normalized.manualCropX,
              manualCropY: normalized.manualCropY,
              manualZoom: normalized.manualZoom,
              updatedAt: new Date(),
            },
          });
      } catch (err) {
        const mapped = sanitizePgError(err);
        throw new Error(mapped.error, { cause: err });
      }
    }

    return normalized;
  }

  async saveCameraAnalysis(params: {
    userUid: string;
    clip: PodcastClip;
    episode?: PodcastEpisode | null;
    speakers: SpeakerProfile[];
    faceTracks: FaceTrackCandidate[];
    speakerSegments: SpeakerSegment[];
    cameraSegments: CameraTrackingSegment[];
  }): Promise<void> {
    this.sqliteDb.saveCameraAnalysisData({
      userUid: params.userUid,
      clipId: params.clip.id,
      speakers: params.speakers,
      faceTracks: params.faceTracks,
      speakerSegments: params.speakerSegments,
      cameraSegments: params.cameraSegments,
    });

    if (isPostgresConfigured()) {
      try {
        await this.ensurePgParents({
          userUid: params.userUid,
          episode: params.episode,
          clip: params.clip,
        });
        const pgDb = getPgDb();
        await pgDb.delete(speakerProfiles).where(eq(speakerProfiles.clipId, params.clip.id));
        await pgDb.delete(speakerSegments).where(eq(speakerSegments.clipId, params.clip.id));
        await pgDb.delete(faceTracks).where(eq(faceTracks.clipId, params.clip.id));
        await pgDb
          .delete(cameraTrackingSegments)
          .where(eq(cameraTrackingSegments.clipId, params.clip.id));

        if (params.speakers.length > 0) {
          await pgDb.insert(speakerProfiles).values(
            params.speakers.map((s) => ({
              id: s.id || genId('spk'),
              clipId: params.clip.id,
              userUid: params.userUid,
              speakerKey: s.speakerKey,
              label: s.label,
              colorHex: s.colorHex,
              avgCenterX: s.avgCenterX,
              avgCenterY: s.avgCenterY,
              speakingRatio: s.speakingRatio,
              avgConfidence: s.avgConfidence,
              isLocked: s.isLocked,
              isIgnored: s.isIgnored,
            }))
          );
        }
        if (params.speakerSegments.length > 0) {
          await pgDb.insert(speakerSegments).values(
            params.speakerSegments.map((seg) => ({
              id: seg.id || genId('spks'),
              clipId: params.clip.id,
              speakerKey: seg.speakerKey,
              startSec: seg.startSec,
              endSec: seg.endSec,
              audioActivityScore: seg.audioActivityScore,
              lipSyncScore: seg.lipSyncScore,
              diarizationScore: seg.diarizationScore,
              activeSpeakerScore: seg.activeSpeakerScore,
              transcriptExcerpt: seg.transcriptExcerpt,
            }))
          );
        }
        if (params.faceTracks.length > 0) {
          await pgDb.insert(faceTracks).values(
            params.faceTracks.map((ft) => ({
              id: genId('ft'),
              clipId: params.clip.id,
              speakerKey: ft.speakerKey,
              timeSec: ft.timeSec,
              x: ft.x,
              y: ft.y,
              width: ft.width,
              height: ft.height,
              mouthActivity: ft.mouthActivity,
              trackingConfidence: ft.trackingConfidence,
              occluded: Boolean(ft.occluded),
            }))
          );
        }
        if (params.cameraSegments.length > 0) {
          await pgDb.insert(cameraTrackingSegments).values(
            params.cameraSegments.map((cam) => ({
              id: cam.id || genId('cam'),
              clipId: params.clip.id,
              userUid: params.userUid,
              startSec: cam.startSec,
              endSec: cam.endSec,
              activeSpeakerKey: cam.activeSpeakerKey,
              framingMode: cam.framingMode,
              layoutMode: cam.layoutMode,
              targetX: cam.targetX,
              targetY: cam.targetY,
              zoom: cam.zoom,
              confidence: cam.confidence,
              reason: cam.reason,
              isManualOverride: cam.isManualOverride,
            }))
          );
        }
      } catch (err) {
        const mapped = sanitizePgError(err);
        throw new Error(mapped.error, { cause: err });
      }
    }
  }

  async listUserIntroTemplates(userUid: string): Promise<UserIntroTemplateRecord[]> {
    if (isPostgresConfigured()) {
      try {
        const pgDb = getPgDb();
        const rows = await pgDb
          .select()
          .from(userIntroTemplates)
          .where(eq(userIntroTemplates.userUid, userUid))
          .orderBy(desc(userIntroTemplates.updatedAt));
        return rows.map((r) => ({
          id: r.id,
          userUid: r.userUid,
          baseTemplateId: r.baseTemplateId,
          name: r.name,
          category: r.category as IntroTemplateCategory,
          description: r.description,
          durationSec: r.durationSec,
          currentVersion: r.currentVersion,
          config: normalizeIntroTemplateDefinition(r.configJson as Partial<IntroTemplateDefinition>),
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        }));
      } catch (err) {
        const mapped = sanitizePgError(err);
        throw new Error(mapped.error, { cause: err });
      }
    }
    return this.sqliteDb.listUserIntroTemplates(userUid);
  }

  async saveUserIntroTemplate(params: {
    id?: string;
    userUid: string;
    baseTemplateId?: string | null;
    name: string;
    category: IntroTemplateCategory;
    description: string;
    durationSec: number;
    config: Partial<IntroTemplateDefinition>;
    changeNote?: string;
  }): Promise<UserIntroTemplateRecord> {
    const normalizedConfig = normalizeIntroTemplateDefinition({
      ...params.config,
      name: params.name,
      category: params.category,
      description: params.description,
      durationSec: params.durationSec,
      isGlobal: false,
    });

    if (isPostgresConfigured()) {
      try {
        await this.ensurePgParents({ userUid: params.userUid });
        const pgDb = getPgDb();
        const existing = params.id
          ? (
              await pgDb
                .select()
                .from(userIntroTemplates)
                .where(
                  and(
                    eq(userIntroTemplates.id, params.id),
                    eq(userIntroTemplates.userUid, params.userUid)
                  )
                )
            )[0]
          : undefined;

        if (existing) {
          const nextVer = existing.currentVersion + 1;
          const updatedConfig = {
            ...normalizedConfig,
            id: existing.id,
            currentVersion: nextVer,
            updatedAt: new Date().toISOString(),
          };
          const [updated] = await pgDb
            .update(userIntroTemplates)
            .set({
              name: params.name,
              category: params.category,
              description: params.description,
              durationSec: normalizedConfig.durationSec,
              currentVersion: nextVer,
              configJson: updatedConfig as unknown as Record<string, unknown>,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(userIntroTemplates.id, existing.id),
                eq(userIntroTemplates.userUid, params.userUid)
              )
            )
            .returning();
          await pgDb.insert(introTemplateVersions).values({
            id: genId('itv'),
            templateId: existing.id,
            userUid: params.userUid,
            versionNumber: nextVer,
            changeNote: params.changeNote || 'Pembaruan template intro',
            configJson: updatedConfig as unknown as Record<string, unknown>,
          });
          return {
            id: updated.id,
            userUid: updated.userUid,
            baseTemplateId: updated.baseTemplateId,
            name: updated.name,
            category: updated.category as IntroTemplateCategory,
            description: updated.description,
            durationSec: updated.durationSec,
            currentVersion: updated.currentVersion,
            config: updatedConfig,
            createdAt: updated.createdAt.toISOString(),
            updatedAt: updated.updatedAt.toISOString(),
          };
        }

        const newId = params.id || genId('uit');
        const createdConfig = {
          ...normalizedConfig,
          id: newId,
          currentVersion: 1,
          updatedAt: new Date().toISOString(),
        };
        const [inserted] = await pgDb
          .insert(userIntroTemplates)
          .values({
            id: newId,
            userUid: params.userUid,
            baseTemplateId: params.baseTemplateId ?? null,
            name: params.name,
            category: params.category,
            description: params.description,
            durationSec: normalizedConfig.durationSec,
            currentVersion: 1,
            configJson: createdConfig as unknown as Record<string, unknown>,
          })
          .returning();
        await pgDb.insert(introTemplateVersions).values({
          id: genId('itv'),
          templateId: newId,
          userUid: params.userUid,
          versionNumber: 1,
          changeNote: params.changeNote || 'Versi awal template intro',
          configJson: createdConfig as unknown as Record<string, unknown>,
        });
        return {
          id: inserted.id,
          userUid: inserted.userUid,
          baseTemplateId: inserted.baseTemplateId,
          name: inserted.name,
          category: inserted.category as IntroTemplateCategory,
          description: inserted.description,
          durationSec: inserted.durationSec,
          currentVersion: inserted.currentVersion,
          config: createdConfig,
          createdAt: inserted.createdAt.toISOString(),
          updatedAt: inserted.updatedAt.toISOString(),
        };
      } catch (err) {
        const mapped = sanitizePgError(err);
        throw new Error(mapped.error, { cause: err });
      }
    }

    return this.sqliteDb.saveUserIntroTemplate({
      id: params.id,
      userUid: params.userUid,
      baseTemplateId: params.baseTemplateId,
      name: params.name,
      category: params.category,
      description: params.description,
      durationSec: normalizedConfig.durationSec,
      config: normalizedConfig,
      changeNote: params.changeNote,
    });
  }

  async deleteUserIntroTemplate(userUid: string, id: string): Promise<boolean> {
    if (isPostgresConfigured()) {
      try {
        const pgDb = getPgDb();
        const deleted = await pgDb
          .delete(userIntroTemplates)
          .where(and(eq(userIntroTemplates.id, id), eq(userIntroTemplates.userUid, userUid)))
          .returning({ id: userIntroTemplates.id });
        return deleted.length > 0;
      } catch (err) {
        const mapped = sanitizePgError(err);
        throw new Error(mapped.error, { cause: err });
      }
    }
    return this.sqliteDb.deleteUserIntroTemplate(userUid, id);
  }

  async listIntroTemplateVersions(
    userUid: string,
    templateId: string
  ): Promise<IntroTemplateVersionRecord[]> {
    if (isPostgresConfigured()) {
      try {
        const pgDb = getPgDb();
        const rows = await pgDb
          .select()
          .from(introTemplateVersions)
          .where(
            and(
              eq(introTemplateVersions.templateId, templateId),
              eq(introTemplateVersions.userUid, userUid)
            )
          )
          .orderBy(desc(introTemplateVersions.versionNumber));
        return rows.map((r) => ({
          id: r.id,
          templateId: r.templateId,
          userUid: r.userUid,
          versionNumber: r.versionNumber,
          changeNote: r.changeNote,
          config: normalizeIntroTemplateDefinition(r.configJson as Partial<IntroTemplateDefinition>),
          createdAt: r.createdAt.toISOString(),
        }));
      } catch (err) {
        const mapped = sanitizePgError(err);
        throw new Error(mapped.error, { cause: err });
      }
    }
    return this.sqliteDb.listIntroTemplateVersions(userUid, templateId);
  }

  async findRenderAssetByFingerprint(
    userUid: string,
    renderFingerprint: string
  ): Promise<RenderAssetRecord | null> {
    if (isPostgresConfigured()) {
      try {
        const pgDb = getPgDb();
        const [r] = await pgDb
          .select()
          .from(renderAssets)
          .where(
            and(
              eq(renderAssets.userUid, userUid),
              eq(renderAssets.renderFingerprint, renderFingerprint)
            )
          );
        if (r) {
          return {
            id: r.id,
            userUid: r.userUid,
            clipId: r.clipId,
            renderJobId: r.renderJobId,
            sourceFingerprint: r.sourceFingerprint,
            renderFingerprint: r.renderFingerprint,
            renderProfile: r.renderProfile as BalancedRenderProfile,
            storageBackend: r.storageBackend === 'gcs' ? 'gcs' : 'local',
            gcsUri: r.gcsUri,
            localPath: r.localPath,
            sizeBytes: r.sizeBytes,
            durationSec: r.durationSec,
            width: r.width,
            height: r.height,
            pipelineVersion: r.pipelineVersion,
            createdAt: r.createdAt.toISOString(),
          };
        }
      } catch {
        // Fall through to SQLite staged cache
      }
    }
    return this.sqliteDb.findRenderAssetByFingerprint(userUid, renderFingerprint);
  }

  async upsertRenderAsset(params: {
    userUid: string;
    clipId: string;
    renderJobId?: string | null;
    sourceFingerprint: string;
    renderFingerprint: string;
    renderProfile: BalancedRenderProfile;
    storageBackend: 'gcs' | 'local';
    gcsUri: string;
    localPath: string;
    sizeBytes: number;
    durationSec: number;
    width: number;
    height: number;
    pipelineVersion?: string;
  }): Promise<RenderAssetRecord> {
    const localRecord = this.sqliteDb.upsertRenderAsset(params);
    if (isPostgresConfigured()) {
      try {
        await this.ensurePgParents({ userUid: params.userUid });
        const pgDb = getPgDb();
        await pgDb
          .insert(renderAssets)
          .values({
            id: localRecord.id,
            userUid: params.userUid,
            clipId: params.clipId,
            renderJobId: null,
            sourceFingerprint: params.sourceFingerprint,
            renderFingerprint: params.renderFingerprint,
            renderProfile: params.renderProfile,
            storageBackend: params.storageBackend,
            gcsUri: params.gcsUri,
            localPath: params.localPath,
            sizeBytes: params.sizeBytes,
            durationSec: params.durationSec,
            width: params.width,
            height: params.height,
            pipelineVersion: params.pipelineVersion || 'v3.0-balanced',
          })
          .onConflictDoUpdate({
            target: [renderAssets.userUid, renderAssets.renderFingerprint],
            set: {
              storageBackend: params.storageBackend,
              gcsUri: params.gcsUri,
              localPath: params.localPath,
              sizeBytes: params.sizeBytes,
              durationSec: params.durationSec,
              width: params.width,
              height: params.height,
            },
          });
      } catch {
        // Staged PG mirror failure should not abort local render completion
      }
    }
    return localRecord;
  }

  async recordJobEvent(params: {
    jobId: string;
    jobType: string;
    userUid: string;
    stage: string;
    status: string;
    message: string;
    durationMs?: number;
    metadata?: Record<string, unknown>;
  }): Promise<JobEventRecord> {
    const rec = this.sqliteDb.recordJobEvent(params);
    if (isPostgresConfigured()) {
      try {
        const pgDb = getPgDb();
        await pgDb.insert(jobEvents).values({
          id: rec.id,
          jobId: rec.jobId,
          jobType: rec.jobType,
          userUid: rec.userUid,
          stage: rec.stage,
          status: rec.status,
          message: rec.message,
          durationMs: rec.durationMs,
          metadataJson: rec.metadata,
        });
      } catch {
        // Non-blocking audit event
      }
    }
    return rec;
  }

  async listJobEvents(jobId: string, userUid?: string): Promise<JobEventRecord[]> {
    if (isPostgresConfigured()) {
      try {
        const pgDb = getPgDb();
        const rows = await pgDb
          .select()
          .from(jobEvents)
          .where(
            userUid
              ? and(eq(jobEvents.jobId, jobId), eq(jobEvents.userUid, userUid))
              : eq(jobEvents.jobId, jobId)
          );
        if (rows.length > 0) {
          return rows.map((r) => ({
            id: r.id,
            jobId: r.jobId,
            jobType: r.jobType,
            userUid: r.userUid,
            stage: r.stage,
            status: r.status,
            message: r.message,
            durationMs: r.durationMs,
            metadata: r.metadataJson,
            createdAt: r.createdAt.toISOString(),
          }));
        }
      } catch {
        // Fall back to SQLite staged log
      }
    }
    return this.sqliteDb.listJobEvents(jobId, userUid);
  }

  async recordPerformanceMetric(params: {
    userUid: string;
    category: string;
    operation: string;
    durationMs: number;
    success: boolean;
    cacheHit: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<PerformanceMetricRecord> {
    const rec = this.sqliteDb.recordPerformanceMetric(params);
    if (isPostgresConfigured()) {
      try {
        const pgDb = getPgDb();
        await pgDb.insert(performanceMetrics).values({
          id: rec.id,
          userUid: rec.userUid,
          category: rec.category,
          operation: rec.operation,
          durationMs: rec.durationMs,
          success: rec.success,
          cacheHit: rec.cacheHit,
          metadataJson: rec.metadata,
        });
      } catch {
        // Non-blocking metric write
      }
    }
    return rec;
  }

  async findSourceAssetByFingerprint(
    userUid: string,
    sourceFingerprint: string
  ): Promise<SourceAssetRecord | null> {
    if (isPostgresConfigured()) {
      try {
        const pgDb = getPgDb();
        const [r] = await pgDb
          .select()
          .from(sourceAssets)
          .where(
            and(
              eq(sourceAssets.userUid, userUid),
              eq(sourceAssets.sourceFingerprint, sourceFingerprint)
            )
          );
        if (r) {
          return {
            id: r.id,
            userUid: r.userUid,
            projectId: r.projectId,
            sourceFingerprint: r.sourceFingerprint,
            storageBackend: r.storageBackend === 'gcs' ? 'gcs' : 'local',
            gcsUri: r.gcsUri,
            localPath: r.localPath,
            mimeType: r.mimeType,
            sizeBytes: r.sizeBytes,
            width: r.width,
            height: r.height,
            fps: r.fps,
            durationSec: r.durationSec,
            audioChannels: r.audioChannels,
            createdAt: r.createdAt.toISOString(),
          };
        }
      } catch {
        // Fall through
      }
    }
    return this.sqliteDb.findSourceAssetByFingerprint(userUid, sourceFingerprint);
  }

  async getObservabilitySummary(userUid?: string): Promise<ObservabilityMetricsSummary> {
    const recentMetrics = this.sqliteDb.listPerformanceMetrics(userUid, 150);
    const total = recentMetrics.length;
    const cacheHits = recentMetrics.filter((m) => m.cacheHit).length;
    const grouped = new Map<
      string,
      { count: number; totalMs: number; successes: number; cacheHits: number }
    >();

    for (const m of recentMetrics) {
      const entry = grouped.get(m.category) ?? { count: 0, totalMs: 0, successes: 0, cacheHits: 0 };
      entry.count += 1;
      entry.totalMs += m.durationMs;
      if (m.success) entry.successes += 1;
      if (m.cacheHit) entry.cacheHits += 1;
      grouped.set(m.category, entry);
    }

    const avgDurationByCategory = Array.from(grouped.entries()).map(([category, g]) => ({
      category,
      count: g.count,
      avgDurationMs: Math.round(g.totalMs / Math.max(1, g.count)),
      successRate: Number((g.successes / Math.max(1, g.count)).toFixed(3)),
      cacheHitRate: Number((g.cacheHits / Math.max(1, g.count)).toFixed(3)),
    }));

    return {
      totalRecordedOperations: total,
      cacheHitCount: cacheHits,
      cacheHitRate: total > 0 ? Number((cacheHits / total).toFixed(3)) : 0,
      avgDurationByCategory,
      recentMetrics: recentMetrics.slice(0, 40),
    };
  }
}
