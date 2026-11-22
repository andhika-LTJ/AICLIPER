import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server.ts';
import { KlipCastDatabase, PLAN_DEFAULTS } from './db.ts';
import type { VerifiedGoogleIdentity } from './googleAuthVerifier.ts';
import { INITIAL_STUDIO_STATE } from '../src/data/seedPodcasts.ts';

function buildTestServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klipcast-api-test-'));
  const db = new KlipCastDatabase({ dbPath: path.join(dir, 'api.sqlite'), dataDir: dir });

  const nowSec = Math.floor(Date.now() / 1000);
  const tokenMap: Record<string, VerifiedGoogleIdentity> = {
    'token-super-admin': {
      uid: 'uid-super-admin',
      email: 'yogandhika2132@gmail.com',
      emailVerified: true,
      name: 'Super Admin',
      picture: null,
      signInProvider: 'google.com',
      authTime: nowSec - 10,
      expiresAt: nowSec + 3600,
    },
    'token-admin': {
      uid: 'uid-admin',
      email: 'ops.admin@example.com',
      emailVerified: true,
      name: 'Ops Admin',
      picture: null,
      signInProvider: 'google.com',
      authTime: nowSec - 10,
      expiresAt: nowSec + 3600,
    },
    'token-user-a': {
      uid: 'uid-user-a',
      email: 'alice@example.com',
      emailVerified: true,
      name: 'Alice Creator',
      picture: null,
      signInProvider: 'google.com',
      authTime: nowSec - 10,
      expiresAt: nowSec + 3600,
    },
    'token-user-b': {
      uid: 'uid-user-b',
      email: 'bob@example.com',
      emailVerified: true,
      name: 'Bob Creator',
      picture: null,
      signInProvider: 'google.com',
      authTime: nowSec - 10,
      expiresAt: nowSec + 3600,
    },
  };

  // Pre-seed roles in DB
  db.upsertAuthenticatedUser({
    uid: 'uid-super-admin',
    email: 'yogandhika2132@gmail.com',
    displayName: 'Super Admin',
    photoUrl: null,
    resolvedRole: 'super_admin',
  });
  db.upsertAuthenticatedUser({
    uid: 'uid-admin',
    email: 'ops.admin@example.com',
    displayName: 'Ops Admin',
    photoUrl: null,
    resolvedRole: 'admin',
  });
  db.upsertAuthenticatedUser({
    uid: 'uid-user-a',
    email: 'alice@example.com',
    displayName: 'Alice Creator',
    photoUrl: null,
    resolvedRole: 'user',
  });
  db.upsertAuthenticatedUser({
    uid: 'uid-user-b',
    email: 'bob@example.com',
    displayName: 'Bob Creator',
    photoUrl: null,
    resolvedRole: 'user',
  });

  // Seed one episode & clip owned strictly by User A
  const epA = { ...INITIAL_STUDIO_STATE.episodes[0], id: 'ep-only-alice' };
  const clipA = { ...INITIAL_STUDIO_STATE.clips[0], id: 'clip-only-alice', episodeId: 'ep-only-alice' };
  db.upsertEpisode('uid-user-a', epA);
  db.upsertClip('uid-user-a', clipA);

  const { app } = createApp({
    db,
    disableRateLimit: true,
    verifyToken: async (rawToken: string) => {
      const matched = tokenMap[rawToken];
      if (!matched) {
        throw new Error('Token Firebase tidak valid.');
      }
      return matched;
    },
  });

  return { dir, db, app };
}

test('Full HTTP RBAC, Auth, Isolation, SSRF, Secret Redaction, Upload & Quota integration suite', async () => {
  const { dir, db, app } = buildTestServer();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Public health works; private endpoints strictly reject anonymous requests (401)
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);

    const anonState = await fetch(`${baseUrl}/api/state`);
    assert.equal(anonState.status, 401);

    const anonAdmin = await fetch(`${baseUrl}/api/admin/overview`);
    assert.equal(anonAdmin.status, 401);

    const invalidTokenRes = await fetch(`${baseUrl}/api/state`, {
      headers: { Authorization: 'Bearer forged-invalid-jwt' },
    });
    assert.equal(invalidTokenRes.status, 401);

    // 2. RBAC: regular user blocked from admin endpoints (403)
    const userAdminRes = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: 'Bearer token-user-a' },
    });
    assert.equal(userAdminRes.status, 403);

    // 3. RBAC: admin can view overview (200) but CANNOT change user roles (Super Admin only -> 403)
    const adminOverview = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: 'Bearer token-admin' },
    });
    assert.equal(adminOverview.status, 200);

    const adminTryRole = await fetch(`${baseUrl}/api/admin/users/uid-user-b/role`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer token-admin',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'admin' }),
    });
    assert.equal(adminTryRole.status, 403);

    // 4. Super Admin can update role & create DB backup (200)
    const superRole = await fetch(`${baseUrl}/api/admin/users/uid-user-b/role`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer token-super-admin',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'user' }),
    });
    assert.equal(superRole.status, 200);

    const backupRes = await fetch(`${baseUrl}/api/admin/backup`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token-super-admin' },
    });
    assert.equal(backupRes.status, 200);

    // 5. Cross-user isolation: User B cannot read/edit/delete User A's clip or episode
    const userBStateRes = await fetch(`${baseUrl}/api/state`, {
      headers: { Authorization: 'Bearer token-user-b' },
    });
    assert.equal(userBStateRes.status, 200);
    const userBState = (await userBStateRes.json()) as { episodes: unknown[]; clips: unknown[] };
    assert.equal(userBState.episodes.length, 0);
    assert.equal(userBState.clips.length, 0);

    const crossEdit = await fetch(`${baseUrl}/api/clips/clip-only-alice`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer token-user-b',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Hijacked Title' }),
    });
    assert.equal(crossEdit.status, 404);

    const crossDelete = await fetch(`${baseUrl}/api/clips/clip-only-alice`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token-user-b' },
    });
    assert.equal(crossDelete.status, 404);

    // 6. SSRF blocking on webhook test & directVideoUrl
    const ssrfWebhook = await fetch(`${baseUrl}/api/automation/test-webhook`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-user-a',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ webhookUrl: 'http://169.254.169.254/latest/meta-data/' }),
    });
    assert.equal(ssrfWebhook.status, 400);

    const ssrfDirectUrl = await fetch(`${baseUrl}/api/episodes/ep-only-alice/source-url`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-user-a',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ directVideoUrl: 'http://127.0.0.1:3000/secret.mp4' }),
    });
    assert.equal(ssrfDirectUrl.status, 400);

    // 7. Fake video file upload rejected by magic byte check
    const fakeUpload = await fetch(`${baseUrl}/api/episodes/ep-only-alice/upload-video`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-user-a',
        'Content-Type': 'application/octet-stream',
      },
      body: Buffer.from('<html><body>not a real video file at all</body></html>'),
    });
    assert.equal(fakeUpload.status, 400);

    // 8. Secret redaction: webhookSecretHeader never leaked in /api/state
    const saveAuto = await fetch(`${baseUrl}/api/automation`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer token-user-a',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...INITIAL_STUDIO_STATE.automation,
        webhookUrl: '',
        webhookSecretHeader: 'TOP-SECRET-WEBHOOK-XYZ',
      }),
    });
    assert.equal(saveAuto.status, 200);
    const saveAutoJson = (await saveAuto.json()) as {
      automation: { webhookSecretHeader: string; hasWebhookSecret?: boolean };
    };
    assert.equal(saveAutoJson.automation.webhookSecretHeader, '');
    assert.equal(saveAutoJson.automation.hasWebhookSecret, true);

    const stateAfterSave = await fetch(`${baseUrl}/api/state`, {
      headers: { Authorization: 'Bearer token-user-a' },
    });
    const stateText = await stateAfterSave.text();
    assert.equal(stateText.includes('TOP-SECRET-WEBHOOK-XYZ'), false);

    // 9. Suspended user is blocked (403)
    db.setUserStatus('uid-user-b', 'suspended');
    const suspendedRes = await fetch(`${baseUrl}/api/state`, {
      headers: { Authorization: 'Bearer token-user-b' },
    });
    assert.equal(suspendedRes.status, 403);

    // 10. Quota enforcement: exhausting monthly AI quota returns 403 QUOTA_EXCEEDED
    db.incrementUsageRecord('uid-user-a', {
      aiAnalyses: PLAN_DEFAULTS.free.monthlyAiLimit,
    });
    const overQuotaRes = await fetch(`${baseUrl}/api/ai/hooks`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-user-a',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ clipId: 'clip-only-alice', tones: ['profesional'] }),
    });
    assert.equal(overQuotaRes.status, 403);
    const overQuotaJson = (await overQuotaRes.json()) as { code?: string };
    assert.equal(overQuotaJson.code, 'QUOTA_EXCEEDED');

    // 11. Logout revokes session so previously issued token is rejected (401)
    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token-user-a' },
    });
    assert.equal(logoutRes.status, 200);
    const afterLogout = await fetch(`${baseUrl}/api/state`, {
      headers: { Authorization: 'Bearer token-user-a' },
    });
    assert.equal(afterLogout.status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
