import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { db, nowIso } from '../src/db.js';
import { encodeSealedBlob, initVault, sealCredential } from '../src/vault.js';
import {
  liveConnectSecret,
  revokeSession,
  startApprovedSession,
} from '../src/sessions.js';
import { ensureDefaultOwner } from '../src/auth.js';
import type { AccessRequestRow, SiteRow } from '../src/db.js';

const SAVED_MASTER = process.env.ARTIFTP_MASTER_KEY;

function restoreEnv(): void {
  if (SAVED_MASTER === undefined) delete process.env.ARTIFTP_MASTER_KEY;
  else process.env.ARTIFTP_MASTER_KEY = SAVED_MASTER;
}

const ids: string[] = [];

afterEach(() => {
  restoreEnv();
  for (const id of ids.splice(0)) {
    db.prepare('DELETE FROM sessions WHERE site_id = ? OR id = ?').run(id, id);
    db.prepare('DELETE FROM access_requests WHERE site_id = ? OR id = ?').run(id, id);
    db.prepare('DELETE FROM sites WHERE id = ?').run(id);
  }
});

describe('startApprovedSession', () => {
  it('opens the sealed password only for the session handoff and forgets it on revoke', () => {
    process.env.ARTIFTP_MASTER_KEY = crypto.randomBytes(32).toString('base64');
    initVault();
    const owner = ensureDefaultOwner();
    const siteId = nanoid();
    const requestId = nanoid();
    ids.push(siteId, requestId);
    const t = nowIso();
    db.prepare(
      `INSERT INTO sites (id, owner_id, display_name, slug, host, port, sftp_user, cred_enc, root_path, mode, max_ttl_sec, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      siteId,
      owner.id,
      'vault-test',
      `vault-test-${siteId.slice(0, 8)}`,
      'mock.local',
      22,
      'mock',
      encodeSealedBlob(sealCredential('handoff-secret')),
      '/samples',
      'read_write',
      900,
      t,
      t,
    );
    db.prepare(
      `INSERT INTO access_requests (id, site_id, purpose, path_hint, mode, requested_ttl_sec, agent_label, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(requestId, siteId, 'test', null, 'read_write', 600, 'test', t);

    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId) as SiteRow;
    const request = db.prepare('SELECT * FROM access_requests WHERE id = ?').get(requestId) as AccessRequestRow;
    const { session } = startApprovedSession(site, request, 600);
    assert.equal(liveConnectSecret(session), 'handoff-secret');
    revokeSession(session.id, 'test');
    const revoked = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id) as typeof session;
    assert.throws(() => liveConnectSecret(revoked), (err: unknown) => {
      assert.equal((err as { code?: string }).code, 'revoked');
      return true;
    });
  });

  it('refuses to approve a legacy ARTIFTP_SECRET blob', () => {
    process.env.ARTIFTP_MASTER_KEY = crypto.randomBytes(32).toString('base64');
    initVault();
    const owner = ensureDefaultOwner();
    const siteId = nanoid();
    const requestId = nanoid();
    ids.push(siteId, requestId);
    const t = nowIso();
    db.prepare(
      `INSERT INTO sites (id, owner_id, display_name, slug, host, port, sftp_user, cred_enc, root_path, mode, max_ttl_sec, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      siteId,
      owner.id,
      'legacy-test',
      `legacy-test-${siteId.slice(0, 8)}`,
      'mock.local',
      22,
      'mock',
      'YWJj:ZGVm:Z2hp',
      '/samples',
      'read_write',
      900,
      t,
      t,
    );
    db.prepare(
      `INSERT INTO access_requests (id, site_id, purpose, path_hint, mode, requested_ttl_sec, agent_label, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(requestId, siteId, 'test', null, 'read_write', 600, 'test', t);
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId) as SiteRow;
    const request = db.prepare('SELECT * FROM access_requests WHERE id = ?').get(requestId) as AccessRequestRow;
    assert.throws(() => startApprovedSession(site, request, 600), (err: unknown) => {
      assert.equal((err as { code?: string }).code, 'credential_reentry_required');
      return true;
    });
  });
});
