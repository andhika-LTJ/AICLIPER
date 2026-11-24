import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server.ts';
import { KlipCastDatabase } from './db.ts';
import type { VerifiedGoogleIdentity } from './googleAuthVerifier.ts';
import { INITIAL_STUDIO_STATE } from '../src/data/seedPodcasts.ts';
import { getRenderedClipPath, getUploadTargetPath, RenderTimeoutError } from './videoClipper.ts';

const execFileAsync = promisify(execFile);

interface FfprobeVideoInfo {
  width: number;
  height: number;
  codecName: string;
  hasAudio: boolean;
  durationSec: number;
}

async function generateSyntheticMp4(
  outputPath: string,
  width: number,
  height: number,
  durationSec = 4
): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${width}x${height}:rate=24:duration=${durationSec}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=44100:duration=${durationSec}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-shortest',
    outputPath,
  ]);
}

async function probeMp4(filePath: string): Promise<FfprobeVideoInfo> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    filePath,
  ]);
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
    }>;
    format?: { duration?: string };
  };
  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  return {
    width: Number(videoStream?.width ?? 0),
    height: Number(videoStream?.height ?? 0),
    codecName: String(videoStream?.codec_name ?? ''),
    hasAudio: Boolean(audioStream),
    durationSec: Number(parsed.format?.duration ?? 0),
  };
}

async function pollRenderUntilTerminal(
  baseUrl: string,
  token: string,
  jobId: string,
  timeoutMs = 120_000
): Promise<{
  status: string;
  stage?: string;
  error?: string;
  code?: string;
  result?: {
    videoUrl: string;
    sizeBytes: number;
    width: number;
    height: number;
    layout: string;
    quality: string;
    renderProfile?: string;
    cacheHit?: boolean;
    upscalePrevented?: boolean;
    upscaleNote?: string;
  };
}> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${baseUrl}/api/render-jobs/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      status: string;
      stage?: string;
      error?: string;
      code?: string;
      result?: {
        videoUrl: string;
        sizeBytes: number;
        width: number;
        height: number;
        layout: string;
        quality: string;
        renderProfile?: string;
        cacheHit?: boolean;
        upscalePrevented?: boolean;
        upscaleNote?: string;
      };
    };
    if (body.status === 'completed' || body.status === 'failed' || body.status === 'cancelled') {
      return body;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out polling render job ${jobId}`);
}

test('MP4 Studio 1080p & 4K real FFmpeg render pipeline, authorization, non-upscaling, switching, cache, and error differentiation', async (t) => {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klipcast-4k-pipeline-'));
  const db = new KlipCastDatabase({ dbPath: path.join(dir, 'pipeline.sqlite'), dataDir: dir });

  const nowSec = Math.floor(Date.now() / 1000);
  const uidFree = `uid-free-${suffix}`;
  const uidPro = `uid-pro-${suffix}`;
  const uidAdmin = `uid-admin-${suffix}`;
  const uidOther = `uid-other-${suffix}`;

  const ep4kId = `ep-4k-${suffix}`;
  const clip4kId = `clip-4k-${suffix}`;
  const ep1080Id = `ep-1080-${suffix}`;
  const clip1080Id = `clip-1080-${suffix}`;
  const epFreeId = `ep-free-${suffix}`;
  const clipFreeId = `clip-free-${suffix}`;
  const epBadRangeId = `ep-badrange-${suffix}`;
  const clipBadRangeId = `clip-badrange-${suffix}`;

  const tokens: Record<string, VerifiedGoogleIdentity> = {
    'token-free': {
      uid: uidFree,
      email: 'free-creator@example.com',
      emailVerified: true,
      name: 'Free Creator',
      picture: null,
      signInProvider: 'google.com',
      authTime: nowSec - 10,
      expiresAt: nowSec + 3600,
    },
    'token-pro': {
      uid: uidPro,
      email: 'pro-creator@example.com',
      emailVerified: true,
      name: 'Pro Creator',
      picture: null,
      signInProvider: 'google.com',
      authTime: nowSec - 10,
      expiresAt: nowSec + 3600,
    },
    'token-admin': {
      uid: uidAdmin,
      email: 'studio-admin@example.com',
      emailVerified: true,
      name: 'Studio Admin',
      picture: null,
      signInProvider: 'google.com',
      authTime: nowSec - 10,
      expiresAt: nowSec + 3600,
    },
    'token-other': {
      uid: uidOther,
      email: 'other-creator@example.com',
      emailVerified: true,
      name: 'Other Creator',
      picture: null,
      signInProvider: 'google.com',
      authTime: nowSec - 10,
      expiresAt: nowSec + 3600,
    },
  };

  db.upsertAuthenticatedUser({
    uid: uidFree,
    email: 'free-creator@example.com',
    displayName: 'Free Creator',
    photoUrl: null,
    resolvedRole: 'user',
  });
  db.upsertAuthenticatedUser({
    uid: uidPro,
    email: 'pro-creator@example.com',
    displayName: 'Pro Creator',
    photoUrl: null,
    resolvedRole: 'user',
  });
  db.updateUserPlan(uidPro, 'pro');

  // Verify returning admin auto-upgrades from free/starter to business 4K access
  db.upsertAuthenticatedUser({
    uid: uidAdmin,
    email: 'studio-admin@example.com',
    displayName: 'Studio Admin',
    photoUrl: null,
    resolvedRole: 'user',
  });
  db.upsertAuthenticatedUser({
    uid: uidAdmin,
    email: 'studio-admin@example.com',
    displayName: 'Studio Admin',
    photoUrl: null,
    resolvedRole: 'admin',
  });

  db.upsertAuthenticatedUser({
    uid: uidOther,
    email: 'other-creator@example.com',
    displayName: 'Other Creator',
    photoUrl: null,
    resolvedRole: 'user',
  });

  const baseEp = INITIAL_STUDIO_STATE.episodes[0];
  const baseClip = INITIAL_STUDIO_STATE.clips[0];

  db.upsertEpisode(uidPro, {
    ...baseEp,
    id: ep4kId,
    userUid: uidPro,
    durationSec: 120,
    hasUploadedSourceVideo: true,
    transcriptSource: 'youtube_captions',
  });
  db.upsertClip(uidPro, {
    ...baseClip,
    id: clip4kId,
    episodeId: ep4kId,
    userUid: uidPro,
    startSec: 0,
    endSec: 3,
    renderedClipUrl: undefined,
    renderProfile: undefined,
    renderedQuality: undefined,
  });

  db.upsertEpisode(uidPro, {
    ...baseEp,
    id: ep1080Id,
    userUid: uidPro,
    durationSec: 120,
    hasUploadedSourceVideo: true,
    transcriptSource: 'youtube_captions',
  });
  db.upsertClip(uidPro, {
    ...baseClip,
    id: clip1080Id,
    episodeId: ep1080Id,
    userUid: uidPro,
    startSec: 0,
    endSec: 3,
    renderedClipUrl: undefined,
  });

  db.upsertEpisode(uidFree, {
    ...baseEp,
    id: epFreeId,
    userUid: uidFree,
    durationSec: 120,
    hasUploadedSourceVideo: true,
    transcriptSource: 'youtube_captions',
  });
  db.upsertClip(uidFree, {
    ...baseClip,
    id: clipFreeId,
    episodeId: epFreeId,
    userUid: uidFree,
    startSec: 0,
    endSec: 3,
    renderedClipUrl: undefined,
  });

  db.upsertEpisode(uidPro, {
    ...baseEp,
    id: epBadRangeId,
    userUid: uidPro,
    durationSec: 120,
  });
  db.upsertClip(uidPro, {
    ...baseClip,
    id: clipBadRangeId,
    episodeId: epBadRangeId,
    userUid: uidPro,
    startSec: 10,
    endSec: 11,
  });

  const uploaded4kPath = getUploadTargetPath(ep4kId);
  const uploaded1080Path = getUploadTargetPath(ep1080Id);
  const uploadedFreePath = getUploadTargetPath(epFreeId);

  const { app } = createApp({
    db,
    disableRateLimit: true,
    verifyToken: async (raw) => {
      const user = tokens[raw];
      if (!user) throw new Error('Invalid Firebase token');
      return user;
    },
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Generate real synthetic 4K (3840x2160) & 1080p (1920x1080) MP4 inputs
    await generateSyntheticMp4(uploaded4kPath, 3840, 2160, 4);
    await generateSyntheticMp4(uploaded1080Path, 1920, 1080, 4);
    fs.copyFileSync(uploaded1080Path, uploadedFreePath);

    // Scenario 1: Render MP4 1080p (portrait 9:16) with real FFmpeg + ffprobe check
    const r1Res = await fetch(`${baseUrl}/api/clips/${clip4kId}/render-mp4`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-pro',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        layout: 'shorts_full_bleed',
        quality: '1080p',
        renderProfile: 'balanced_1080p',
        enableAiIntro: false,
        enableEmotionEffects: false,
      }),
    });
    assert.equal(r1Res.status, 202);
    const r1Queue = (await r1Res.json()) as { jobId: string; quality: string; renderProfile: string };
    assert.equal(r1Queue.quality, '1080p');
    assert.equal(r1Queue.renderProfile, 'balanced_1080p');

    const r1Done = await pollRenderUntilTerminal(baseUrl, 'token-pro', r1Queue.jobId);
    assert.equal(r1Done.status, 'completed', r1Done.error);
    assert.equal(r1Done.result?.width, 1080);
    assert.equal(r1Done.result?.height, 1920);
    assert.equal(r1Done.result?.quality, '1080p');
    assert.equal(r1Done.result?.cacheHit, false);

    const rendered1080File = getRenderedClipPath(clip4kId);
    assert.ok(rendered1080File && fs.existsSync(rendered1080File));
    const probe1080 = await probeMp4(rendered1080File);
    const size1080 = fs.statSync(rendered1080File).size;
    t.diagnostic(`1080p portrait ffprobe: ${probe1080.width}x${probe1080.height}, codec=${probe1080.codecName}, audio=${probe1080.hasAudio}, dur=${probe1080.durationSec.toFixed(2)}s, size=${size1080}B`);
    assert.equal(probe1080.width, 1080);
    assert.equal(probe1080.height, 1920);
    assert.equal(probe1080.codecName, 'h264');
    assert.equal(probe1080.hasAudio, true);
    assert.ok(probe1080.durationSec >= 2.5);

    // Scenario 5a & 2: Switch quality 1080p -> 4K (portrait 2160x3840) and landscape 4K (3840x2160)
    const r2Res = await fetch(`${baseUrl}/api/clips/${clip4kId}/render-mp4`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-pro',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        layout: 'shorts_full_bleed',
        quality: '4k',
        renderProfile: 'balanced_4k',
        enableAiIntro: false,
        enableEmotionEffects: false,
      }),
    });
    assert.equal(r2Res.status, 202);
    const r2Queue = (await r2Res.json()) as { jobId: string; quality: string; renderProfile: string };
    assert.equal(r2Queue.quality, '4k');
    assert.equal(r2Queue.renderProfile, 'balanced_4k');

    const r2Done = await pollRenderUntilTerminal(baseUrl, 'token-pro', r2Queue.jobId);
    assert.equal(r2Done.status, 'completed', r2Done.error);
    assert.equal(r2Done.result?.width, 2160);
    assert.equal(r2Done.result?.height, 3840);
    assert.equal(r2Done.result?.quality, '4k');
    assert.equal(r2Done.result?.upscalePrevented, false);

    const rendered4kPortrait = getRenderedClipPath(clip4kId);
    assert.ok(rendered4kPortrait);
    const probe4kPortrait = await probeMp4(rendered4kPortrait);
    const size4kPortrait = fs.statSync(rendered4kPortrait).size;
    t.diagnostic(`4K portrait ffprobe: ${probe4kPortrait.width}x${probe4kPortrait.height}, codec=${probe4kPortrait.codecName}, audio=${probe4kPortrait.hasAudio}, dur=${probe4kPortrait.durationSec.toFixed(2)}s, size=${size4kPortrait}B`);
    assert.equal(probe4kPortrait.width, 2160);
    assert.equal(probe4kPortrait.height, 3840);
    assert.equal(probe4kPortrait.codecName, 'h264');
    assert.equal(probe4kPortrait.hasAudio, true);

    // Landscape 4K (3840x2160)
    const r2LandRes = await fetch(`${baseUrl}/api/clips/${clip4kId}/render-mp4`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-pro',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        layout: 'full_16_9_focus',
        quality: '4k',
        renderProfile: 'balanced_4k',
        enableAiIntro: false,
        enableEmotionEffects: false,
      }),
    });
    assert.equal(r2LandRes.status, 202);
    const r2LandQueue = (await r2LandRes.json()) as { jobId: string };
    const r2LandDone = await pollRenderUntilTerminal(baseUrl, 'token-pro', r2LandQueue.jobId);
    assert.equal(r2LandDone.status, 'completed', r2LandDone.error);
    assert.equal(r2LandDone.result?.width, 3840);
    assert.equal(r2LandDone.result?.height, 2160);
    const rendered4kLand = getRenderedClipPath(clip4kId)!;
    const probe4kLand = await probeMp4(rendered4kLand);
    const size4kLand = fs.statSync(rendered4kLand).size;
    t.diagnostic(`4K landscape ffprobe: ${probe4kLand.width}x${probe4kLand.height}, codec=${probe4kLand.codecName}, audio=${probe4kLand.hasAudio}, dur=${probe4kLand.durationSec.toFixed(2)}s, size=${size4kLand}B`);
    assert.equal(probe4kLand.width, 3840);
    assert.equal(probe4kLand.height, 2160);

    // Scenario 4: Re-render same video in 4K (cache hit returns 4K portrait)
    const r4CacheRes = await fetch(`${baseUrl}/api/clips/${clip4kId}/render-mp4`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-pro',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        layout: 'shorts_full_bleed',
        quality: '4k',
        renderProfile: 'balanced_4k',
        enableAiIntro: false,
        enableEmotionEffects: false,
      }),
    });
    assert.equal(r4CacheRes.status, 202);
    const r4CacheDone = await pollRenderUntilTerminal(
      baseUrl,
      'token-pro',
      ((await r4CacheRes.json()) as { jobId: string }).jobId
    );
    assert.equal(r4CacheDone.status, 'completed');
    assert.equal(r4CacheDone.result?.cacheHit, true);
    assert.equal(r4CacheDone.result?.width, 2160);
    assert.equal(r4CacheDone.result?.height, 3840);

    // Scenario 3 & 5b: Switch 4K -> 1080p WITHOUT sending renderProfile (must NOT get stuck on balanced_4k!)
    const r3SwitchBackRes = await fetch(`${baseUrl}/api/clips/${clip4kId}/render-mp4`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-pro',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        layout: 'shorts_full_bleed',
        quality: '1080p',
        enableAiIntro: false,
        enableEmotionEffects: false,
      }),
    });
    assert.equal(r3SwitchBackRes.status, 202);
    const r3Queue = (await r3SwitchBackRes.json()) as {
      jobId: string;
      quality: string;
      renderProfile: string;
    };
    assert.equal(r3Queue.quality, '1080p');
    assert.equal(r3Queue.renderProfile, 'balanced_1080p');
    const r3Done = await pollRenderUntilTerminal(baseUrl, 'token-pro', r3Queue.jobId);
    assert.equal(r3Done.status, 'completed', r3Done.error);
    assert.equal(r3Done.result?.width, 1080);
    assert.equal(r3Done.result?.height, 1920);
    assert.equal(r3Done.result?.quality, '1080p');
    assert.equal(r3Done.result?.renderProfile, 'balanced_1080p');

    // Scenario 3b: Re-render same video in 1080p hits 1080p cache, then 4K still hits distinct 4K cache
    const r3bRes = await fetch(`${baseUrl}/api/clips/${clip4kId}/render-mp4`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-pro',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        layout: 'shorts_full_bleed',
        quality: '1080p',
        enableAiIntro: false,
        enableEmotionEffects: false,
      }),
    });
    assert.equal(r3bRes.status, 202);
    const r3bDone = await pollRenderUntilTerminal(
      baseUrl,
      'token-pro',
      ((await r3bRes.json()) as { jobId: string }).jobId
    );
    assert.equal(r3bDone.status, 'completed');
    assert.equal(r3bDone.result?.cacheHit, true);
    assert.equal(r3bDone.result?.width, 1080);
    assert.equal(r3bDone.result?.height, 1920);
    assert.equal(r3bDone.result?.quality, '1080p');

    const r4bRes = await fetch(`${baseUrl}/api/clips/${clip4kId}/render-mp4`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-pro',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        layout: 'shorts_full_bleed',
        quality: '4k',
        enableAiIntro: false,
        enableEmotionEffects: false,
      }),
    });
    assert.equal(r4bRes.status, 202);
    const r4bDone = await pollRenderUntilTerminal(
      baseUrl,
      'token-pro',
      ((await r4bRes.json()) as { jobId: string }).jobId
    );
    assert.equal(r4bDone.status, 'completed');
    assert.equal(r4bDone.result?.cacheHit, true);
    assert.equal(r4bDone.result?.width, 2160);
    assert.equal(r4bDone.result?.height, 3840);
    assert.equal(r4bDone.result?.quality, '4k');

    // Scenario 7: Requesting 4K on a 1080p-only source must NOT upscale to 4K
    const r7Res = await fetch(`${baseUrl}/api/clips/${clip1080Id}/render-mp4`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-pro',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        layout: 'shorts_full_bleed',
        quality: '4k',
        renderProfile: 'balanced_4k',
        enableAiIntro: false,
        enableEmotionEffects: false,
      }),
    });
    assert.equal(r7Res.status, 202);
    const r7Done = await pollRenderUntilTerminal(
      baseUrl,
      'token-pro',
      ((await r7Res.json()) as { jobId: string }).jobId
    );
    assert.equal(r7Done.status, 'completed', r7Done.error);
    assert.equal(r7Done.result?.upscalePrevented, true);
    assert.equal(r7Done.result?.quality, '1080p');
    assert.equal(r7Done.result?.width, 1080);
    assert.equal(r7Done.result?.height, 1920);
    const renderedNonUpscaled = getRenderedClipPath(clip1080Id)!;
    const probeNonUpscaled = await probeMp4(renderedNonUpscaled);
    t.diagnostic(`Non-upscaled 4K-on-1080p ffprobe: ${probeNonUpscaled.width}x${probeNonUpscaled.height}, size=${fs.statSync(renderedNonUpscaled).size}B`);
    assert.equal(probeNonUpscaled.width, 1080);
    assert.equal(probeNonUpscaled.height, 1920);

    // Scenario 6: Multi-user isolation & RBAC
    // 6a. Free user requesting 4K -> 403 PLAN_4K_LOCKED with clear currentPlan/maxExportQuality metadata
    const free4kRes = await fetch(`${baseUrl}/api/render`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-free',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clipId: clipFreeId,
        layout: 'shorts_full_bleed',
        quality: '4k',
      }),
    });
    assert.equal(free4kRes.status, 403);
    const free4kBody = (await free4kRes.json()) as {
      code: string;
      currentPlan: string;
      maxExportQuality: string;
    };
    assert.equal(free4kBody.code, 'PLAN_4K_LOCKED');
    assert.equal(free4kBody.currentPlan, 'free');
    assert.equal(free4kBody.maxExportQuality, '1080p');

    // 6b. Same Free user requesting 1080p -> succeeds (202 -> completed)
    const free1080Res = await fetch(`${baseUrl}/api/render`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-free',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clipId: clipFreeId,
        layout: 'shorts_full_bleed',
        quality: '1080p',
        enableAiIntro: false,
        enableEmotionEffects: false,
      }),
    });
    assert.equal(free1080Res.status, 202);
    const free1080Done = await pollRenderUntilTerminal(
      baseUrl,
      'token-free',
      ((await free1080Res.json()) as { jobId: string }).jobId
    );
    assert.equal(free1080Done.status, 'completed');

    // 6c. Auto-upgraded admin account is allowed 4K
    const adminQuotaRes = await fetch(`${baseUrl}/api/auth/verify-google`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token-admin' },
    });
    assert.equal(adminQuotaRes.status, 200);
    const adminQuota = (await adminQuotaRes.json()) as { quota: { planTier: string; maxExportQuality: string } };
    assert.equal(adminQuota.quota.planTier, 'business');
    assert.equal(adminQuota.quota.maxExportQuality, '4k');

    // 6d. Cross-user isolation: User Other cannot render or stream User Pro's clip
    const crossRender = await fetch(`${baseUrl}/api/clips/${clip4kId}/render-mp4`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-other',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ layout: 'shorts_full_bleed', quality: '1080p' }),
    });
    assert.equal(crossRender.status, 404);

    const crossStream = await fetch(`${baseUrl}/api/clips/${clip4kId}/video`, {
      headers: { Authorization: 'Bearer token-other' },
    });
    assert.equal(crossStream.status, 403);

    const crossJob = await fetch(`${baseUrl}/api/render-jobs/${r1Queue.jobId}`, {
      headers: { Authorization: 'Bearer token-other' },
    });
    assert.equal(crossJob.status, 403);

    // Scenario 8: Error differentiation (401, 400, 422, 404, 429, 503, worker timeout/failure)
    const unauthRes = await fetch(`${baseUrl}/api/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clipId: clip4kId, quality: '4k' }),
    });
    assert.equal(unauthRes.status, 401);

    const badQualityRes = await fetch(`${baseUrl}/api/clips/${clip4kId}/render-mp4`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-pro',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ layout: 'shorts_full_bleed', quality: '8k_ultra' }),
    });
    assert.equal(badQualityRes.status, 400);

    const badRangeRes = await fetch(`${baseUrl}/api/clips/${clipBadRangeId}/render-mp4`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-pro',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ layout: 'shorts_full_bleed', quality: '1080p' }),
    });
    assert.equal(badRangeRes.status, 422);

    const missingClipRes = await fetch(`${baseUrl}/api/clips/clip-does-not-exist/render-mp4`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-pro',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ layout: 'shorts_full_bleed', quality: '1080p' }),
    });
    assert.equal(missingClipRes.status, 404);

    // 429 USAGE_LIMIT_REACHED when monthly render limit is exhausted
    db.incrementUsageRecord(uidFree, { renders: 60 });
    const quota429Res = await fetch(`${baseUrl}/api/clips/${clipFreeId}/render-mp4`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-free',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ layout: 'shorts_full_bleed', quality: '1080p' }),
    });
    assert.equal(quota429Res.status, 429);
    assert.equal(((await quota429Res.json()) as { code: string }).code, 'USAGE_LIMIT_REACHED');

    // 503 WORKER_UNAVAILABLE + persistent job failure when external worker fails
    const { app: workerDownApp } = createApp({
      db,
      disableRateLimit: true,
      requireExternalWorker: true,
      dispatchCloudRunJobFn: async () => {
        throw new Error('Cloud Run Jobs execution endpoint unreachable');
      },
      verifyToken: async (raw) => {
        const user = tokens[raw];
        if (!user) throw new Error('Invalid token');
        return user;
      },
    });
    const workerDownServer = workerDownApp.listen(0);
    await new Promise<void>((resolve) => workerDownServer.once('listening', resolve));
    const downPort = (workerDownServer.address() as AddressInfo).port;
    try {
      const downRes = await fetch(`http://127.0.0.1:${downPort}/api/clips/${clip4kId}/render-mp4`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-pro',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          layout: 'shorts_full_bleed',
          quality: '4k',
          forceRestart: true,
        }),
      });
      assert.equal(downRes.status, 503);
      const downBody = (await downRes.json()) as { code: string; jobId: string };
      assert.equal(downBody.code, 'WORKER_UNAVAILABLE');
      const persistedDownJob = db.getRenderJobById(downBody.jobId);
      assert.equal(persistedDownJob?.status, 'failed');
    } finally {
      workerDownServer.close();
    }

    // Worker timeout persistence check
    const { app: timeoutApp } = createApp({
      db,
      disableRateLimit: true,
      renderClipFn: async () => {
        throw new RenderTimeoutError('Proses render melewati batas waktu worker (timeout).');
      },
      verifyToken: async (raw) => {
        const user = tokens[raw];
        if (!user) throw new Error('Invalid token');
        return user;
      },
    });
    const timeoutServer = timeoutApp.listen(0);
    await new Promise<void>((resolve) => timeoutServer.once('listening', resolve));
    const timeoutPort = (timeoutServer.address() as AddressInfo).port;
    try {
      const toRes = await fetch(`http://127.0.0.1:${timeoutPort}/api/clips/${clip4kId}/render-mp4`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-pro',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          layout: 'shorts_full_bleed',
          quality: '4k',
          forceRestart: true,
        }),
      });
      assert.equal(toRes.status, 202);
      const toQueue = (await toRes.json()) as { jobId: string };
      const toDone = await pollRenderUntilTerminal(
        `http://127.0.0.1:${timeoutPort}`,
        'token-pro',
        toQueue.jobId
      );
      assert.equal(toDone.status, 'failed');
      assert.equal(toDone.code, 'WORKER_TIMEOUT');
      const persistedToJob = db.getRenderJobById(toQueue.jobId);
      assert.equal(persistedToJob?.status, 'failed');
      const events = db.listJobEvents(toQueue.jobId);
      assert.ok(events.some((e) => e.stage === 'failed' && e.status === 'failed'));
    } finally {
      timeoutServer.close();
    }
  } finally {
    server.close();
    for (const p of [
      uploaded4kPath,
      uploaded1080Path,
      uploadedFreePath,
      getRenderedClipPath(clip4kId),
      getRenderedClipPath(clip1080Id),
      getRenderedClipPath(clipFreeId),
    ]) {
      if (p && fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch {
          // Ignore cleanup error
        }
      }
    }
    for (const uid of [uidPro, uidFree]) {
      const userStorageDir = path.resolve(process.cwd(), 'data', 'storage', 'users', uid);
      if (fs.existsSync(userStorageDir)) {
        fs.rmSync(userStorageDir, { recursive: true, force: true });
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
