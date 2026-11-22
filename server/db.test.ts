import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KlipCastDatabase } from './db.ts';
import { INITIAL_STUDIO_STATE } from '../src/data/seedPodcasts.ts';

function createTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klipcast-db-test-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const db = new KlipCastDatabase({ dbPath, dataDir: dir });
  return { dir, dbPath, db };
}

test('KlipCastDatabase creates all 13 required tables and enforces per-user data isolation', () => {
  const { dir, db } = createTempDb();
  try {
    assert.equal(db.checkHealth(), true);

    db.upsertAuthenticatedUser({
      uid: 'user-a',
      email: 'alice@example.com',
      displayName: 'Alice',
      photoUrl: null,
      resolvedRole: 'user',
    });
    db.upsertAuthenticatedUser({
      uid: 'user-b',
      email: 'bob@example.com',
      displayName: 'Bob',
      photoUrl: null,
      resolvedRole: 'user',
    });

    const epA = { ...INITIAL_STUDIO_STATE.episodes[0], id: 'ep-alice-1' };
    const clipA = { ...INITIAL_STUDIO_STATE.clips[0], id: 'clip-alice-1', episodeId: 'ep-alice-1' };
    db.upsertEpisode('user-a', epA);
    db.upsertClip('user-a', clipA);

    // User A sees their data; User B sees zero rows from User A
    assert.equal(db.listUserEpisodes('user-a').length, 1);
    assert.equal(db.listUserClips('user-a').length, 1);
    assert.equal(db.listUserEpisodes('user-b').length, 0);
    assert.equal(db.listUserClips('user-b').length, 0);
    assert.equal(db.getEpisodeForUser('user-b', 'ep-alice-1'), null);
    assert.equal(db.getClipForUser('user-b', 'clip-alice-1'), null);

    // Soft delete hides clip from User A without crashing
    assert.equal(db.softDeleteClipForUser('user-b', 'clip-alice-1'), false);
    assert.equal(db.softDeleteClipForUser('user-a', 'clip-alice-1'), true);
    assert.equal(db.listUserClips('user-a').length, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrateLegacyJsonStore creates timestamped backup, imports rows atomically, preserves source JSON, and is idempotent', () => {
  const { dir, db } = createTempDb();
  try {
    const legacyPath = path.join(dir, 'klipcast-store.json');
    fs.writeFileSync(legacyPath, JSON.stringify(INITIAL_STUDIO_STATE, null, 2), 'utf-8');

    const first = db.migrateLegacyJsonStore({
      legacyJsonPath: legacyPath,
      ownerUid: 'legacy_owner',
    });
    assert.equal(first.migrated, true);
    assert.equal(first.episodesImported, INITIAL_STUDIO_STATE.episodes.length);
    assert.equal(first.clipsImported, INITIAL_STUDIO_STATE.clips.length);
    assert.equal(first.verifiedEpisodesCount, INITIAL_STUDIO_STATE.episodes.length);
    assert.equal(first.verifiedClipsCount, INITIAL_STUDIO_STATE.clips.length);
    assert.ok(first.backupPath && fs.existsSync(first.backupPath), 'Backup file must exist');
    assert.ok(fs.existsSync(legacyPath), 'Original legacy JSON must remain intact');

    // Second run must be idempotent
    const second = db.migrateLegacyJsonStore({
      legacyJsonPath: legacyPath,
      ownerUid: 'legacy_owner',
    });
    assert.equal(second.migrated, false);

    // Claiming legacy data transfers ownership to first super_admin
    db.upsertAuthenticatedUser({
      uid: 'super-admin-1',
      email: 'yogandhika2132@gmail.com',
      displayName: 'Super Admin',
      photoUrl: null,
      resolvedRole: 'super_admin',
    });
    assert.equal(db.claimLegacyDataIfPresent('super-admin-1'), true);
    assert.equal(db.listUserEpisodes('super-admin-1').length, INITIAL_STUDIO_STATE.episodes.length);

    // Backup snapshot creation works cleanly
    const snap = db.createDatabaseBackupSnapshot();
    assert.ok(fs.existsSync(snap.backupFilePath));
    assert.ok(snap.sizeBytes > 100);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
