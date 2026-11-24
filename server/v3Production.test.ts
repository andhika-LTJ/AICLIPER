import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server.ts';
import { INITIAL_STUDIO_STATE } from '../src/data/seedPodcasts.ts';
import {
  GLOBAL_INTRO_TEMPLATES,
  INTRO_ANIMATION_OPTIONS,
  INTRO_TEMPLATE_CATEGORIES,
} from '../src/data/introTemplatesCatalog.ts';
import { KlipCastDatabase } from './db.ts';
import type { VerifiedGoogleIdentity } from './googleAuthVerifier.ts';
import {
  normalizeCameraTrackingSettings,
  runActiveSpeakerBenchmark,
} from './services/activeSpeakerEngine.ts';
import {
  compileIntroTemplateForFfmpeg,
  normalizeIntroTemplateDefinition,
} from './services/introRenderCompiler.ts';
import {
  BALANCED_RENDER_PROFILES,
  computeRenderFingerprint,
  computeSourceFingerprint,
} from './services/renderFingerprint.ts';
import { ensureFfmpegPath, ensureFfprobePath } from './ffmpegBinaries.ts';
import {
  downloadChunkedStreamToFile,
  renderClipMp4,
  RenderCancelledError,
} from './videoClipper.ts';

const execFileAsync = promisify(execFile);

test('Active Speaker Engine benchmark achieves >= 85% precision, recall, and switch accuracy', () => {
  const report = runActiveSpeakerBenchmark();
  assert.ok(report.scenarios.length >= 4, 'should benchmark at least 4 realistic scenarios');
  assert.ok(
    report.overallPrecision >= 0.85,
    `precision ${report.overallPrecision} must be >= 0.85`
  );
  assert.ok(report.overallRecall >= 0.85, `recall ${report.overallRecall} must be >= 0.85`);
  assert.ok(
    report.overallSwitchAccuracy >= 0.85,
    `switch accuracy ${report.overallSwitchAccuracy} must be >= 0.85`
  );
  assert.ok(
    report.overallStability >= 0.8,
    `stability ${report.overallStability} must be >= 0.8`
  );
});

test('Intro Studio covers all 22 categories and compiles valid FFmpeg filter + ASS plans', () => {
  assert.equal(INTRO_TEMPLATE_CATEGORIES.length, 22);
  const covered = new Set(GLOBAL_INTRO_TEMPLATES.map((t) => t.category));
  for (const cat of INTRO_TEMPLATE_CATEGORIES) {
    assert.ok(covered.has(cat), `missing catalog template for category ${cat}`);
  }

  for (const bgMode of ['solid', 'gradient', 'blur_footage', 'footage'] as const) {
    const sample = GLOBAL_INTRO_TEMPLATES.find((t) => t.background.mode === bgMode);
    assert.ok(sample, `missing sample for background mode ${bgMode}`);
    const plan = compileIntroTemplateForFfmpeg({
      template: sample!,
      width: 1080,
      height: 1920,
      fps: 30,
    });
    assert.ok(plan.backgroundFilter.length > 10);
    assert.ok(plan.assScript.includes('[Events]'));
    assert.ok(plan.assScript.includes('Dialogue:'));
  }

  // Test boxed vs text-only layer ASS styling and all 10 animation types
  const custom = normalizeIntroTemplateDefinition({
    durationSec: 4.5,
    audio: {
      enabled: true,
      sfxType: 'whoosh',
      volume: 0.6,
      fadeInSec: 0.1,
      fadeOutSec: 0.25,
      muted: false,
      keepOriginalAudio: true,
    },
    layers: INTRO_ANIMATION_OPTIONS.map((anim, idx) => ({
      ...GLOBAL_INTRO_TEMPLATES[0].layers[0],
      id: `layer-${anim.id}`,
      type: idx % 2 === 0 ? 'headline' : 'subtitle',
      name: anim.label,
      text: `Animasi ${anim.label}`,
      textBox: {
        ...GLOBAL_INTRO_TEMPLATES[0].layers[0].textBox,
        enabled: idx % 2 === 0,
      },
      animation: {
        type: anim.id,
        durationSec: 0.4,
        delaySec: 0.1,
        direction: 'up',
        easing: 'ease_out',
        intensity: 0.8,
      },
    })),
  });
  const animPlan = compileIntroTemplateForFfmpeg({
    template: custom,
    width: 720,
    height: 1280,
    fps: 30,
  });
  assert.equal(animPlan.animationTypes.length, 10);
  assert.ok(animPlan.hasTextBoxLayers >= 5);
  assert.ok(animPlan.hasTextOnlyLayers >= 5);
  assert.ok(animPlan.audioFilter && animPlan.audioFilter.includes('anoisesrc'));
});

test('Source & 14-parameter Render Fingerprints separate source identity from edit deltas', () => {
  const srcA = computeSourceFingerprint({
    videoId: 'dQw4w9WgXcQ',
    sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    startSec: 120,
    endSec: 180,
  });
  const srcB = computeSourceFingerprint({
    videoId: 'dQw4w9WgXcQ',
    sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    startSec: 120,
    endSec: 180,
  });
  assert.equal(srcA, srcB);

  const baseRender = computeRenderFingerprint({
    sourceFingerprint: srcA,
    startSec: 120,
    endSec: 180,
    renderProfile: 'balanced_1080p',
    resolution: '1080x1920',
    codec: 'libx264',
    bitrateKbps: BALANCED_RENDER_PROFILES.balanced_1080p.maxrateKbps,
    aspectRatio: 'shorts_full_bleed',
    captionConfig: [{ offsetSec: 0, durationSec: 3, text: 'Halo' }],
    introConfig: { enabled: true, slug: 'tpl-1' },
    cameraSettings: normalizeCameraTrackingSettings('clip-1'),
    speakerOverrides: { locked: null, ignored: [] },
    layoutConfig: 'shorts_full_bleed',
    overlayStyle: null,
    audioSettings: { normalizeAudio: true, emotionEffects: true, audioBitrateKbps: 192 },
  });

  const editedIntroRender = computeRenderFingerprint({
    sourceFingerprint: srcA,
    startSec: 120,
    endSec: 180,
    renderProfile: 'balanced_1080p',
    resolution: '1080x1920',
    codec: 'libx264',
    bitrateKbps: BALANCED_RENDER_PROFILES.balanced_1080p.maxrateKbps,
    aspectRatio: 'shorts_full_bleed',
    captionConfig: [{ offsetSec: 0, durationSec: 3, text: 'Halo' }],
    introConfig: { enabled: true, slug: 'tpl-2' },
    cameraSettings: normalizeCameraTrackingSettings('clip-1'),
    speakerOverrides: { locked: null, ignored: [] },
    layoutConfig: 'shorts_full_bleed',
    overlayStyle: null,
    audioSettings: { normalizeAudio: true, emotionEffects: true, audioBitrateKbps: 192 },
  });

  assert.notEqual(baseRender, editedIntroRender);
});

test('downloadChunkedStreamToFile completes normal streams, fails fast on stall/header timeouts, and cleans up partial files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klipcast-dl-test-'));
  let mode: 'ok' | 'hang_header' | 'stall_mid' = 'ok';

  const server = http.createServer((req, res) => {
    if (mode === 'hang_header') {
      // Intentionally do not write headers so headerTimeoutMs triggers
      return;
    }
    if (mode === 'stall_mid') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '50000' });
      res.write(Buffer.alloc(1024, 0x41));
      // Intentionally stall before ending so inactivityTimeoutMs triggers
      return;
    }
    const payload = Buffer.alloc(16_384, 0x5a);
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(payload.length),
    });
    res.end(payload);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/stream.mp4`;

  try {
    // 1. Healthy download
    mode = 'ok';
    const okPath = path.join(dir, 'ok.mp4');
    let progressEvents = 0;
    const okRes = await downloadChunkedStreamToFile({
      streamUrl: url,
      destPath: okPath,
      onBytesProgress: () => {
        progressEvents += 1;
      },
    });
    assert.equal(okRes.bytesWritten, 16_384);
    assert.ok(progressEvents >= 1);
    assert.equal(fs.statSync(okPath).size, 16_384);

    // 2. Header timeout
    mode = 'hang_header';
    const hdrPath = path.join(dir, 'hdr.mp4');
    await assert.rejects(
      downloadChunkedStreamToFile({
        streamUrl: url,
        destPath: hdrPath,
        headerTimeoutMs: 250,
        inactivityTimeoutMs: 250,
        totalTimeoutMs: 1000,
      }),
      /Timeout/i
    );
    assert.equal(fs.existsSync(hdrPath), false);

    // 3. Mid-stream inactivity stall deletes partial file
    mode = 'stall_mid';
    const stallPath = path.join(dir, 'stall.mp4');
    await assert.rejects(
      downloadChunkedStreamToFile({
        streamUrl: url,
        destPath: stallPath,
        headerTimeoutMs: 1000,
        inactivityTimeoutMs: 260,
        totalTimeoutMs: 2000,
      }),
      /inactivity stall/i
    );
    assert.equal(fs.existsSync(stallPath), false);

    // 4. Parent AbortSignal cancels immediately with RenderCancelledError
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      downloadChunkedStreamToFile({
        streamUrl: url,
        destPath: path.join(dir, 'abort.mp4'),
        signal: ac.signal,
      }),
      (err: unknown) => err instanceof RenderCancelledError
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AICLIPER V3 HTTP API integration: Auth, Camera Studio, 22-Category Intro Studio & Versioning, Storage Isolation, Readiness', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klipcast-v3-http-'));
  const db = new KlipCastDatabase({ dbPath: path.join(dir, 'v3http.sqlite'), dataDir: dir });

  const nowSec = Math.floor(Date.now() / 1000);
  const tokenMap: Record<string, VerifiedGoogleIdentity> = {
    'tok-a': {
      uid: 'uid-a',
      email: 'alice@example.com',
      emailVerified: true,
      name: 'Alice',
      picture: null,
      signInProvider: 'google.com',
      authTime: nowSec - 10,
      expiresAt: nowSec + 3600,
    },
    'tok-b': {
      uid: 'uid-b',
      email: 'bob@example.com',
      emailVerified: true,
      name: 'Bob',
      picture: null,
      signInProvider: 'google.com',
      authTime: nowSec - 10,
      expiresAt: nowSec + 3600,
    },
  };

  db.upsertAuthenticatedUser({
    uid: 'uid-a',
    email: 'alice@example.com',
    displayName: 'Alice',
    photoUrl: null,
    resolvedRole: 'user',
  });
  db.upsertAuthenticatedUser({
    uid: 'uid-b',
    email: 'bob@example.com',
    displayName: 'Bob',
    photoUrl: null,
    resolvedRole: 'user',
  });

  const epA = { ...INITIAL_STUDIO_STATE.episodes[0], id: 'ep-v3-a' };
  const clipA = {
    ...INITIAL_STUDIO_STATE.clips[0],
    id: 'clip-v3-a',
    episodeId: 'ep-v3-a',
    startSec: 100,
    endSec: 135,
  };
  db.upsertEpisode('uid-a', epA);
  db.upsertClip('uid-a', clipA);

  db.upsertRenderJob({
    jobId: 'job-v3-a',
    clipId: 'clip-v3-a',
    userUid: 'uid-a',
    layout: 'shorts_full_bleed',
    quality: '1080p',
    status: 'running',
    stage: 'queued',
    progress: 10,
  });

  const { app } = createApp({
    db,
    disableRateLimit: true,
    verifyToken: async (rawToken: string) => {
      const m = tokenMap[rawToken];
      if (!m) throw new Error('Invalid token');
      return m;
    },
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Unauthenticated access rejected
    const anonCam = await fetch(`${baseUrl}/api/v3/clips/clip-v3-a/camera`);
    assert.equal(anonCam.status, 401);

    // 2. Alice updates & recalculates camera settings
    const putCam = await fetch(`${baseUrl}/api/v3/clips/clip-v3-a/camera`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer tok-a',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        settings: {
          framingMode: 'upper_body',
          multiSpeakerLayout: 'split_screen',
          minShotDurationSec: 2.5,
        },
      }),
    });
    assert.equal(putCam.status, 200);
    const putCamJson = (await putCam.json()) as {
      settings: { framingMode: string; multiSpeakerLayout: string };
    };
    assert.equal(putCamJson.settings.framingMode, 'upper_body');
    assert.equal(putCamJson.settings.multiSpeakerLayout, 'split_screen');

    const recalcCam = await fetch(`${baseUrl}/api/v3/clips/clip-v3-a/camera/recalculate`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer tok-a',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(recalcCam.status, 200);
    const recalcJson = (await recalcCam.json()) as {
      ok: boolean;
      cameraSegments: unknown[];
    };
    assert.equal(recalcJson.ok, true);
    assert.ok(recalcJson.cameraSegments.length >= 1);

    // Cross-user isolation on camera route
    const bobCam = await fetch(`${baseUrl}/api/v3/clips/clip-v3-a/camera`, {
      headers: { Authorization: 'Bearer tok-b' },
    });
    assert.equal(bobCam.status, 404);

    // 3. Intro Studio 22-category catalog & Personal Template CRUD + Version Restore
    const catRes = await fetch(`${baseUrl}/api/v3/intro-templates/catalog`, {
      headers: { Authorization: 'Bearer tok-a' },
    });
    assert.equal(catRes.status, 200);
    const catJson = (await catRes.json()) as { categories: string[]; totalCount: number };
    assert.equal(catJson.categories.length, 22);
    assert.ok(catJson.totalCount >= 22);

    const createTpl = await fetch(`${baseUrl}/api/v3/intro-templates/personal`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer tok-a',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Intro Podcast Utama',
        category: 'Podcast Highlight',
        durationSec: 2.0,
        config: GLOBAL_INTRO_TEMPLATES[0],
      }),
    });
    assert.equal(createTpl.status, 201);
    const createdTpl = (await createTpl.json()) as {
      template: { id: string; currentVersion: number; durationSec: number };
    };
    assert.equal(createdTpl.template.currentVersion, 1);

    const updateTpl = await fetch(
      `${baseUrl}/api/v3/intro-templates/personal/${createdTpl.template.id}`,
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer tok-a',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          durationSec: 3.5,
          changeNote: 'Perpanjang intro jadi 3.5 detik',
        }),
      }
    );
    assert.equal(updateTpl.status, 200);
    const updatedTpl = (await updateTpl.json()) as {
      template: { currentVersion: number; durationSec: number };
    };
    assert.equal(updatedTpl.template.currentVersion, 2);
    assert.equal(updatedTpl.template.durationSec, 3.5);

    const restoreVer1 = await fetch(
      `${baseUrl}/api/v3/intro-templates/personal/${createdTpl.template.id}/versions/1/restore`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer tok-a' },
      }
    );
    assert.equal(restoreVer1.status, 200);
    const restoredJson = (await restoreVer1.json()) as {
      template: { currentVersion: number; durationSec: number };
    };
    assert.equal(restoredJson.template.durationSec, 2.0);
    assert.equal(restoredJson.template.currentVersion, 3);

    // 4. Observability cross-user protection + Storage path confinement + Readiness report
    const bobEvents = await fetch(`${baseUrl}/api/v3/observability/jobs/job-v3-a/events`, {
      headers: { Authorization: 'Bearer tok-b' },
    });
    assert.equal(bobEvents.status, 403);

    const badStorage = await fetch(
      `${baseUrl}/api/v3/storage/local?key=${encodeURIComponent('../../etc/passwd')}`,
      { headers: { Authorization: 'Bearer tok-a' } }
    );
    assert.ok(badStorage.status === 403 || badStorage.status === 404);

    const readinessRes = await fetch(`${baseUrl}/api/v3/readiness`, {
      headers: { Authorization: 'Bearer tok-a' },
    });
    assert.equal(readinessRes.status, 200);
    const readiness = (await readinessRes.json()) as {
      database: { backend: string };
      media: { ffmpegReady: boolean; ffprobeReady: boolean };
    };
    assert.equal(readiness.database.backend, 'sqlite_staged');
    assert.equal(readiness.media.ffmpegReady, true);
    assert.equal(readiness.media.ffprobeReady, true);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Real FFmpeg CLI E2E Render Smoke Test: split_screen + Intro Studio + source fingerprint reuse', async () => {
  const ffmpeg = await ensureFfmpegPath();
  const ffprobe = await ensureFfprobePath();

  const testSuffix = Date.now().toString(36);
  const testEpId = `ep-ffmpeg-e2e-${testSuffix}`;
  const testClipId = `clip-ffmpeg-e2e-${testSuffix}`;

  const dataDir = path.resolve(process.cwd(), 'data');
  const uploadsDir = path.join(dataDir, 'uploads');
  const rendersDir = path.join(dataDir, 'renders');
  const tmpDir = path.join(dataDir, 'tmp');
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(rendersDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const uploadPath = path.join(uploadsDir, `${testEpId}.mp4`);
  const renderOutPath = path.join(rendersDir, `${testClipId}.mp4`);

  const ep = {
    ...INITIAL_STUDIO_STATE.episodes[0],
    id: testEpId,
    videoId: `vid_${testSuffix}`,
    sourceUrl: `https://www.youtube.com/watch?v=vid_${testSuffix}`,
    durationSec: 20,
    hasUploadedSourceVideo: true,
  };
  const clip = {
    ...INITIAL_STUDIO_STATE.clips[0],
    id: testClipId,
    episodeId: testEpId,
    startSec: 0,
    endSec: 6,
    captionCues: [
      { offsetSec: 0.2, durationSec: 2.4, text: 'Pembicara pertama memulai diskusi.', speaker: 'Host' },
      { offsetSec: 2.8, durationSec: 2.8, text: 'Pembicara kedua membalas dengan argumen.', speaker: 'Tamu' },
    ],
  };

  const srcFp = computeSourceFingerprint({
    videoId: ep.videoId,
    sourceUrl: ep.sourceUrl,
    startSec: clip.startSec,
    endSec: clip.endSec,
  });
  const segCachePath = path.join(tmpDir, `seg_src_${srcFp}.mp4`);
  const intelCachePath = path.join(tmpDir, `intel_src_${srcFp}.json`);

  try {
    // Generate synthetic 6-second 1280x720 H.264 + AAC source video with real audio tone
    await execFileAsync(ffmpeg, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=30:duration=6',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100:duration=6',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      uploadPath,
    ]);

    // Pass 1: fast_preview + split_screen + Breaking News solid Intro Studio template
    const solidIntro = GLOBAL_INTRO_TEMPLATES.find((t) => t.background.mode === 'solid')!;
    const res1 = await renderClipMp4({
      episode: ep,
      clip,
      layout: 'shorts_full_bleed',
      quality: '1080p',
      renderProfile: 'fast_preview',
      enableAiIntro: true,
      enableEmotionEffects: false,
      cameraSettings: {
        multiSpeakerLayout: 'split_screen',
        framingMode: 'speaker_focus',
      },
      introTemplateConfig: { ...solidIntro, durationSec: 1.0 },
      sourceFingerprint: srcFp,
    });

    assert.equal(res1.width, 720);
    assert.equal(res1.height, 1280);
    assert.ok(fs.existsSync(renderOutPath), 'rendered MP4 output must exist');
    assert.ok(fs.existsSync(segCachePath), 'source fingerprint segment cache should be created');

    const probe1 = await execFileAsync(ffprobe, [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,width,height:format=duration',
      '-of',
      'json',
      renderOutPath,
    ]);
    const parsed1 = JSON.parse(probe1.stdout) as {
      streams: Array<{ codec_type: string; width?: number; height?: number }>;
      format: { duration: string };
    };
    const vStream = parsed1.streams.find((s) => s.codec_type === 'video');
    const aStream = parsed1.streams.find((s) => s.codec_type === 'audio');
    assert.equal(vStream?.width, 720);
    assert.equal(vStream?.height, 1280);
    assert.ok(aStream, 'audio stream must remain present after intro concat');
    const dur1 = Number(parsed1.format.duration);
    assert.ok(dur1 >= 6.5 && dur1 <= 7.8, `expected ~7.0s output duration, got ${dur1}`);

    // Pass 2: intro-only + camera edit (gradient + typewriter + boxed text) reuses segCachePath
    const gradIntro = GLOBAL_INTRO_TEMPLATES.find((t) => t.background.mode === 'gradient')!;
    const mtimeBefore = fs.statSync(segCachePath).mtimeMs;
    const res2 = await renderClipMp4({
      episode: ep,
      clip,
      layout: 'shorts_full_bleed',
      quality: '1080p',
      renderProfile: 'fast_preview',
      enableAiIntro: true,
      enableEmotionEffects: false,
      cameraSettings: {
        multiSpeakerLayout: 'active_speaker_full',
        framingMode: 'speaker_focus',
      },
      introTemplateConfig: { ...gradIntro, durationSec: 1.5 },
      sourceFingerprint: srcFp,
    });
    const mtimeAfter = fs.statSync(segCachePath).mtimeMs;
    assert.equal(mtimeBefore, mtimeAfter, 'source segment cache should be reused without re-extracting');
    assert.ok(res2.sizeBytes > 10_000);

    const probe2 = await execFileAsync(ffprobe, [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,width,height:format=duration',
      '-of',
      'json',
      renderOutPath,
    ]);
    const parsed2 = JSON.parse(probe2.stdout) as {
      streams: Array<{ codec_type: string; width?: number; height?: number }>;
      format: { duration: string };
    };
    const vStream2 = parsed2.streams.find((s) => s.codec_type === 'video');
    assert.equal(vStream2?.width, 720);
    assert.equal(vStream2?.height, 1280);
    const dur2 = Number(parsed2.format.duration);
    assert.ok(dur2 >= 7.0 && dur2 <= 8.4, `expected ~7.5s output duration, got ${dur2}`);
  } finally {
    for (const p of [uploadPath, renderOutPath, segCachePath, intelCachePath]) {
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }
});
