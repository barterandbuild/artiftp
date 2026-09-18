import { nanoid } from 'nanoid';
import { db, nowIso, audit, type SessionRow, type AccessRequestRow, type SiteRow } from './db.js';
import { hashToken, randomToken } from './crypto.js';

export type SessionStatus = 'locked' | 'pending' | 'active' | 'expired' | 'denied' | 'revoked';

export function sessionLifecycle(session: SessionRow | null, request?: AccessRequestRow | null): SessionStatus {
  if (request?.status === 'denied') return 'denied';
  if (request?.status === 'pending') return 'pending';
  if (!session) return 'locked';
  if (session.revoked_at) return 'revoked';
  if (new Date(session.expires_at).getTime() < Date.now()) return 'expired';
  return 'active';
}

export function getSessionByToken(token: string): SessionRow | null {
  const row = db
    .prepare('SELECT * FROM sessions WHERE token_hash = ?')
    .get(hashToken(token)) as SessionRow | undefined;
  return row ?? null;
}

export function assertActiveSession(token: string): SessionRow {
  const session = getSessionByToken(token);
  if (!session) {
    throw Object.assign(new Error('session_locked'), { code: 'session_locked', status: 401 });
  }
  if (session.revoked_at) {
    throw Object.assign(new Error('revoked'), { code: 'revoked', status: 401 });
  }
  if (new Date(session.expires_at).getTime() < Date.now()) {
    throw Object.assign(new Error('expired'), { code: 'expired', status: 401 });
  }
  return session;
}

export function mintSession(
  site: SiteRow,
  request: AccessRequestRow,
  ttlSec: number,
): { session: SessionRow; token: string } {
  const token = randomToken(32);
  const id = nanoid();
  const expires = new Date(Date.now() + ttlSec * 1000).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, site_id, request_id, token_hash, root_path, mode, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    site.id,
    request.id,
    hashToken(token),
    site.root_path,
    request.mode,
    expires,
    nowIso(),
  );
  db.prepare(
    `UPDATE access_requests SET status = 'approved', resolved_at = ? WHERE id = ?`,
  ).run(nowIso(), request.id);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow;
  audit('owner', 'session_mint', {
    site_id: site.id,
    request_id: request.id,
    session_id: id,
    detail: { expires_at: expires, mode: request.mode, root: site.root_path },
  });
  return { session, token };
}

export function revokeSession(sessionId: string, actor = 'owner'): void {
  db.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(
    nowIso(),
    sessionId,
  );
  audit(actor, 'session_revoke', { session_id: sessionId });
}

export function endSessionByToken(token: string): boolean {
  const session = getSessionByToken(token);
  if (!session) return false;
  revokeSession(session.id, 'agent');
  return true;
}
