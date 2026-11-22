import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server.ts';
import { INITIAL_STUDIO_STATE } from '../src/data/seedPodcasts.ts';
import { KlipCastDatabase } from './db.ts';
import type { VerifiedGoogleIdentity } from './googleAuthVerifier.ts';
import { V2Repository } from './repositories/v2Repository.ts';
import {
  resolvePaymentProvider,
  UnconfiguredPaymentProvider,
} from './services/paymentProvider.ts';
import {
  clampPlayhead,
  clampZoom,
  createDefaultEditingProject,
  deleteTimelineElement,
  deriveClipBoundsFromTimeline,
  moveTimelineElement,
  splitTimelineElement,
  trimTimelineElement,
} from './utils/timelineMath.ts';
import { normalizeClippingApproach } from './routes/v2Routes.ts';

test('timelineMath pure functions: create, trim, move, split, delete, clamp, derive bounds', () => {
  const sampleClip = {
    ...INITIAL_STUDIO_STATE.clips[0],
    id: 'clip-math-1',
    startSec: 120,
    endSec: 180,
    captionCues: [
      { offsetSec: 0, durationSec: 4, text: 'Halo semuanya' },
      { offsetSec: 4.5, durationSec: 5, text: 'Ini bagian penting' },
    ],
  };

  const project = createDefaultEditingProject(sampleClip, 'uid-1', 'ws-1');
  assert.equal(project.durationSec, 60);
  assert.equal(project.zoomLevel, 1);
  assert.equal(project.safeAreaEnabled, true);

  const videoEl = project.elements.find((e) => e.trackType === 'video');
  assert.ok(videoEl, 'should contain primary video element');
  assert.equal(videoEl.startSec, 0);
  assert.equal(videoEl.endSec, 60);
  assert.equal(videoEl.sourceOffsetSec, 120);

  // Clamp helpers
  assert.equal(clampPlayhead(-5, 60), 0);
  assert.equal(clampPlayhead(999, 60), 60);
  assert.equal(clampPlayhead(Number.NaN, 60), 0);
  assert.equal(clampZoom(0.2), 1);
  assert.equal(clampZoom(10), 4);
  assert.equal(clampZoom(2.5), 2.5);

  // Trim video element (5s to 50s -> sourceOffset shifts by +5s to 125s)
  const trimmed = trimTimelineElement(project.elements, videoEl.id, 5, 50, 60);
  const trimmedVideo = trimmed.find((e) => e.id === videoEl.id)!;
  assert.equal(trimmedVideo.startSec, 5);
  assert.equal(trimmedVideo.endSec, 50);
  assert.equal(trimmedVideo.sourceOffsetSec, 125);

  // Move intro text element
  const textEl = trimmed.find((e) => e.trackType === 'text')!;
  const moved = moveTimelineElement(trimmed, textEl.id, 2.5, 60);
  const movedText = moved.find((e) => e.id === textEl.id)!;
  assert.equal(movedText.startSec, 2.5);

  // Split video element at 25s
  const splitOk = splitTimelineElement(moved, videoEl.id, 25);
  assert.equal(splitOk.didSplit, true);
  assert.ok(splitOk.rightElementId);
  const leftPart = splitOk.elements.find((e) => e.id === videoEl.id)!;
  const rightPart = splitOk.elements.find((e) => e.id === splitOk.rightElementId)!;
  assert.equal(leftPart.startSec, 5);
  assert.equal(leftPart.endSec, 25);
  assert.equal(rightPart.startSec, 25);
  assert.equal(rightPart.endSec, 50);
  assert.equal(rightPart.sourceOffsetSec, 145);

  // Reject split too close to edge
  const splitEdge = splitTimelineElement(splitOk.elements, videoEl.id, 5.2);
  assert.equal(splitEdge.didSplit, false);

  // Deleting one of two video tracks succeeds, deleting the last remaining video track is blocked
  const afterDeleteRight = deleteTimelineElement(splitOk.elements, rightPart.id);
  assert.equal(
    afterDeleteRight.filter((e) => e.trackType === 'video').length,
    1
  );
  const afterDeleteLast = deleteTimelineElement(afterDeleteRight, leftPart.id);
  assert.equal(
    afterDeleteLast.filter((e) => e.trackType === 'video').length,
    1
  );

  // Derive clip bounds from remaining trimmed video track (start 5..25, sourceOffset 125 -> 125..145)
  const bounds = deriveClipBoundsFromTimeline(
    { ...project, elements: afterDeleteLast },
    120,
    180
  );
  assert.equal(bounds.startSec, 125);
  assert.equal(bounds.endSec, 145);
});

test('PaymentProvider reports honest unconfigured state and normalizeClippingApproach validates enum', async () => {
  const provider = new UnconfiguredPaymentProvider();
  const status = provider.getStatus();
  assert.equal(status.configured, false);
  assert.equal(status.mode, 'unconfigured');
  const checkout = await provider.createCheckoutSession();
  assert.equal(checkout.supported, false);

  const prevProv = process.env.PAYMENT_PROVIDER;
  const prevKey = process.env.PAYMENT_SERVER_KEY;
  delete process.env.PAYMENT_PROVIDER;
  delete process.env.PAYMENT_SERVER_KEY;
  try {
    assert.equal(resolvePaymentProvider().getStatus().configured, false);
  } finally {
    if (prevProv !== undefined) process.env.PAYMENT_PROVIDER = prevProv;
    if (prevKey !== undefined) process.env.PAYMENT_SERVER_KEY = prevKey;
  }

  assert.equal(normalizeClippingApproach('storytelling'), 'storytelling');
  assert.equal(normalizeClippingApproach('promotional'), 'promotional');
  assert.equal(normalizeClippingApproach('invalid-value'), 'educational');
});

test('Migration 002 creates all 22 tables and V2Repository enforces user isolation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klipcast-v2-db-'));
  const db = new KlipCastDatabase({ dbPath: path.join(dir, 'v2.sqlite'), dataDir: dir });

  try {
    const raw = db.getRawDb();
    const tables = (
      raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    const expectedV2Tables = [
      'workspaces',
      'workspace_members',
      'editing_projects',
      'templates',
      'content_generations',
      'ai_advisor_messages',
      'analytics_snapshots',
      'system_settings',
      'billing_records',
    ];
    for (const tbl of expectedV2Tables) {
      assert.ok(tables.includes(tbl), `Expected table ${tbl} to exist`);
    }
    assert.ok(tables.length >= 22, `Expected >= 22 tables, got ${tables.length}: ${tables.join(', ')}`);

    db.upsertAuthenticatedUser({
      uid: 'u-1',
      email: 'u1@example.com',
      displayName: 'User One',
      photoUrl: null,
      resolvedRole: 'user',
    });
    db.upsertAuthenticatedUser({
      uid: 'u-2',
      email: 'u2@example.com',
      displayName: 'User Two',
      photoUrl: null,
      resolvedRole: 'user',
    });

    // Verify theme_preset persistence on user_profiles
    db.updateUserProfile('u-1', { themePreset: 'creator_neon', themePreference: 'dark' });
    const prof = db.getUserProfileData('u-1');
    assert.ok(prof, 'Expected user profile for u-1');
    assert.equal(prof.themePreset, 'creator_neon');
    assert.equal(prof.themePreference, 'dark');

    const repo = new V2Repository(db);
    const ws1 = repo.ensureDefaultWorkspace('u-1', 'User One');
    assert.equal(ws1.ownerUid, 'u-1');
    assert.equal(repo.listUserWorkspaces('u-2').length, 0);

    const tpl = repo.createTemplate({
      userUid: 'u-1',
      workspaceId: ws1.id,
      name: 'Subtitle Neon Preset',
      category: 'subtitle',
      description: 'Preset subtitle kontras tinggi',
      isPublic: false,
      config: { subtitleStylePreset: 'bold_pop' },
    });
    assert.equal(repo.listTemplates('u-1', 'subtitle').length, 1);
    assert.equal(repo.listTemplates('u-2', 'subtitle').length, 0);
    assert.equal(repo.deleteTemplate('u-2', tpl.id), false);
    assert.equal(repo.deleteTemplate('u-1', tpl.id), true);

    const ep1 = { ...INITIAL_STUDIO_STATE.episodes[0], id: 'ep-u1' };
    db.upsertEpisode('u-1', ep1);
    repo.appendAdvisorMessage({
      userUid: 'u-1',
      episodeId: 'ep-u1',
      role: 'user',
      content: 'Berikan ide hook episode ini',
    });
    assert.equal(repo.listAdvisorMessages('u-1', 'ep-u1').length, 1);
    assert.equal(repo.listAdvisorMessages('u-2', 'ep-u1').length, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AICLIPER 2.0 HTTP API integration: Auth, Editor, Templates, Analytics, Theme & Admin RBAC', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klipcast-v2-http-'));
  const db = new KlipCastDatabase({ dbPath: path.join(dir, 'v2http.sqlite'), dataDir: dir });

  const nowSec = Math.floor(Date.now() / 1000);
  const tokenMap: Record<string, VerifiedGoogleIdentity> = {
    'tok-super': {
      uid: 'uid-super',
      email: 'yogandhika2132@gmail.com',
      emailVerified: true,
      name: 'Super Admin',
      picture: null,
      signInProvider: 'google.com',
      authTime: nowSec - 10,
      expiresAt: nowSec + 3600,
    },
    'tok-admin': {
      uid: 'uid-admin',
      email: 'admin@example.com',
      emailVerified: true,
      name: 'Ops Admin',
      picture: null,
      signInProvider: 'google.com',
      authTime: nowSec - 10,
      expiresAt: nowSec + 3600,
    },
    'tok-a': {
      uid: 'uid-a',
      email: 'a@example.com',
      emailVerified: true,
      name: 'Alice',
      picture: null,
      signInProvider: 'google.com',
      authTime: nowSec - 10,
      expiresAt: nowSec + 3600,
    },
    'tok-b': {
      uid: 'uid-b',
      email: 'b@example.com',
      emailVerified: true,
      name: 'Bob',
      picture: null,
      signInProvider: 'google.com',
      authTime: nowSec - 10,
      expiresAt: nowSec + 3600,
    },
  };

  db.upsertAuthenticatedUser({
    uid: 'uid-super',
    email: 'yogandhika2132@gmail.com',
    displayName: 'Super Admin',
    photoUrl: null,
    resolvedRole: 'super_admin',
  });
  db.upsertAuthenticatedUser({
    uid: 'uid-admin',
    email: 'admin@example.com',
    displayName: 'Ops Admin',
    photoUrl: null,
    resolvedRole: 'admin',
  });
  db.upsertAuthenticatedUser({
    uid: 'uid-a',
    email: 'a@example.com',
    displayName: 'Alice',
    photoUrl: null,
    resolvedRole: 'user',
  });
  db.upsertAuthenticatedUser({
    uid: 'uid-b',
    email: 'b@example.com',
    displayName: 'Bob',
    photoUrl: null,
    resolvedRole: 'user',
  });

  const epA = { ...INITIAL_STUDIO_STATE.episodes[0], id: 'ep-a-1' };
  const clipA = {
    ...INITIAL_STUDIO_STATE.clips[0],
    id: 'clip-a-1',
    episodeId: 'ep-a-1',
    startSec: 100,
    endSec: 160,
  };
  db.upsertEpisode('uid-a', epA);
  db.upsertClip('uid-a', clipA);

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
    // 1. Anonymous requests to /api/v2/* must return 401
    for (const ep of [
      '/api/v2/workspaces',
      '/api/v2/templates',
      '/api/v2/analytics/overview',
      '/api/v2/billing/summary',
      '/api/v2/editor/clip-a-1',
    ]) {
      const res = await fetch(`${baseUrl}${ep}`);
      assert.equal(res.status, 401, `Expected 401 for anonymous ${ep}`);
    }

    // 2. Workspaces create & list
    const wsCreate = await fetch(`${baseUrl}/api/v2/workspaces`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-a', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Tim Podcast Utama', description: 'Workspace produksi harian' }),
    });
    assert.equal(wsCreate.status, 201);

    const wsList = await fetch(`${baseUrl}/api/v2/workspaces`, {
      headers: { Authorization: 'Bearer tok-a' },
    });
    assert.equal(wsList.status, 200);
    const wsJson = (await wsList.json()) as { workspaces: Array<{ name: string }> };
    assert.ok(wsJson.workspaces.some((w) => w.name === 'Tim Podcast Utama'));

    // 3. Smart Video Editor GET + PUT with syncClipBounds + cross-user isolation
    const edGet = await fetch(`${baseUrl}/api/v2/editor/clip-a-1`, {
      headers: { Authorization: 'Bearer tok-a' },
    });
    assert.equal(edGet.status, 200);
    const edJson = (await edGet.json()) as {
      project: {
        title: string;
        durationSec: number;
        zoomLevel: number;
        safeAreaEnabled: boolean;
        elements: Array<{ id: string; trackType: string; startSec: number; endSec: number; sourceOffsetSec?: number; label: string }>;
        exportPreset: Record<string, unknown>;
      };
    };
    const nextElements = edJson.project.elements.map((el) =>
      el.trackType === 'video' ? { ...el, startSec: 10, endSec: 50, sourceOffsetSec: 110 } : el
    );

    const edPut = await fetch(`${baseUrl}/api/v2/editor/clip-a-1`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer tok-a', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: edJson.project.title,
        durationSec: edJson.project.durationSec,
        zoomLevel: 2,
        safeAreaEnabled: true,
        elements: nextElements,
        exportPreset: edJson.project.exportPreset,
        syncClipBounds: true,
      }),
    });
    assert.equal(edPut.status, 200);
    const updatedClip = db.getClipForUser('uid-a', 'clip-a-1')!;
    assert.equal(updatedClip.startSec, 110);
    assert.equal(updatedClip.endSec, 150);

    // User B cannot access or mutate User A's editor project
    const crossEdGet = await fetch(`${baseUrl}/api/v2/editor/clip-a-1`, {
      headers: { Authorization: 'Bearer tok-b' },
    });
    assert.equal(crossEdGet.status, 404);

    // 4. Templates CRUD + isolation
    const tplCreate = await fetch(`${baseUrl}/api/v2/templates`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok-a', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Gaya Subtitle Bold',
        category: 'subtitle',
        description: 'Preset subtitle kuning kontras',
        config: { subtitleStylePreset: 'bold_pop', fontSizeScale: 1.15 },
      }),
    });
    assert.equal(tplCreate.status, 201);
    const tplJson = (await tplCreate.json()) as { template: { id: string } };

    const crossDelTpl = await fetch(`${baseUrl}/api/v2/templates/${tplJson.template.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer tok-b' },
    });
    assert.equal(crossDelTpl.status, 404);

    // 5. Real Analytics Overview (zero fake YouTube views when unsynced) & Billing Summary
    const analyticsRes = await fetch(`${baseUrl}/api/v2/analytics/overview`, {
      headers: { Authorization: 'Bearer tok-a' },
    });
    assert.equal(analyticsRes.status, 200);
    const analyticsJson = (await analyticsRes.json()) as {
      overview: {
        totals: { episodes: number; clips: number; youtubeViews: number | null };
      };
    };
    assert.equal(analyticsJson.overview.totals.episodes, 1);
    assert.equal(analyticsJson.overview.totals.clips, 1);
    assert.equal(analyticsJson.overview.totals.youtubeViews, null);

    const billingRes = await fetch(`${baseUrl}/api/v2/billing/summary`, {
      headers: { Authorization: 'Bearer tok-a' },
    });
    assert.equal(billingRes.status, 200);
    const billingJson = (await billingRes.json()) as {
      plans: unknown[];
      paymentProvider: { configured: boolean };
    };
    assert.equal(billingJson.plans.length, 4);
    assert.equal(billingJson.paymentProvider.configured, false);

    // 6. Theme preset profile persistence (fixes themePreference bug)
    const themeRes = await fetch(`${baseUrl}/api/me/profile`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer tok-a', 'Content-Type': 'application/json' },
      body: JSON.stringify({ themePreset: 'creator_neon' }),
    });
    assert.equal(themeRes.status, 200);
    const themeJson = (await themeRes.json()) as {
      profile: { themePreset: string; themePreference: string };
    };
    assert.equal(themeJson.profile.themePreset, 'creator_neon');
    assert.equal(themeJson.profile.themePreference, 'dark');

    // 7. Admin 2.0 RBAC: user -> 403, admin -> GET 200 / PATCH 403, super_admin -> PATCH 200 + audit log
    const userAdmWs = await fetch(`${baseUrl}/api/v2/admin/workspaces`, {
      headers: { Authorization: 'Bearer tok-a' },
    });
    assert.equal(userAdmWs.status, 403);

    const adminAdmWs = await fetch(`${baseUrl}/api/v2/admin/workspaces`, {
      headers: { Authorization: 'Bearer tok-admin' },
    });
    assert.equal(adminAdmWs.status, 200);

    const adminTryPatch = await fetch(`${baseUrl}/api/v2/admin/system-settings`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer tok-admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ maintenanceMode: true }),
    });
    assert.equal(adminTryPatch.status, 403);

    const superPatch = await fetch(`${baseUrl}/api/v2/admin/system-settings`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer tok-super', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        maintenanceMode: false,
        defaultThemePreset: 'dark_studio',
        allowNewRegistrations: true,
      }),
    });
    assert.equal(superPatch.status, 200);
    const superPatchJson = (await superPatch.json()) as {
      settings: { defaultThemePreset: string };
    };
    assert.equal(superPatchJson.settings.defaultThemePreset, 'dark_studio');

    const logs = db.listAuditLogs(20);
    assert.ok(
      logs.some((l) => l.action === 'admin.system_settings_updated'),
      'Expected audit log entry for system settings update'
    );

    // 8. Admin plan update logs a billing record
    const planUpd = await fetch(`${baseUrl}/api/admin/users/uid-a/plan`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer tok-super', 'Content-Type': 'application/json' },
      body: JSON.stringify({ planTier: 'pro' }),
    });
    assert.equal(planUpd.status, 200);
    const billingAfter = await fetch(`${baseUrl}/api/v2/billing/summary`, {
      headers: { Authorization: 'Bearer tok-a' },
    });
    const billingAfterJson = (await billingAfter.json()) as {
      currentPlan: string;
      billingRecords: Array<{ planTier: string }>;
    };
    assert.equal(billingAfterJson.currentPlan, 'pro');
    assert.ok(billingAfterJson.billingRecords.some((r) => r.planTier === 'pro'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
