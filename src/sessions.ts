import { nanoid } from 'nanoid';
import { db, nowIso, audit, type SessionRow, type AccessRequestRow, type SiteRow } from './db.js';
import { hashToken, randomToken } from './crypto.js';
import { needsCredentialReentry, openCredential, VaultError } from './vault.js';

export type SessionStatus = 'locked' | 'pending' | 'active' | 'expired' | 'denied' | 'revoked';

/** In-process connect secrets. Never persisted; never logged. */
const liveSecrets = new Map<string, string>();

const REAP_INTERVAL_MS = 30_000;

export { resolveJailed, PathForbiddenError } from './pathJail.js';

function credentialReentryError(): VaultError {
  return new VaultError(
    'credential_reentry_required',
    'Site password uses a retired encryption format. Re-enter it in the Owner UI.',
    409,
  );
}

/**
 * Open a sealed site password. HTTP runtime: only this module imports `openCredential`.
 * Routes must go through `startApprovedSession` / `liveConnectSecret` / `connectSecretForOwnerProbe`.
 */
function openSiteCredential(site: Pick<SiteRow, 'cred_enc'>): string {
  if (needsCredentialReentry(site.cred_enc)) {
    throw credentialReentryError();
  }
  return openCredential(site.cred_enc);
}

function forgetLiveSecret(sessionId: string): void {
  liveSecrets.delete(sessionId);
}

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

/**
 * Approve-time handoff: the only place the HTTP app opens a site password
 * to start an agent session. Holds the plaintext in memory for this process
 * until TTL/revoke/reap.
 */
export function startApprovedSession(
  site: SiteRow,
  request: AccessRequestRow,
  ttlSec: number,
): { session: SessionRow; token: string } {
  const password = openSiteCredential(site);
  const minted = mintSession(site, request, ttlSec);
  liveSecrets.set(minted.session.id, password);
  return minted;
}

/**
 * Password for SFTP/FTP connect on an active agent session.
 * Rehydrates after process restart if the session is still valid (still session-path,
 * never from owner/agent routes).
 */
export function liveConnectSecret(session: SessionRow): string {
  if (session.revoked_at) {
    forgetLiveSecret(session.id);
    throw Object.assign(new Error('revoked'), { code: 'revoked', status: 401 });
  }
  if (new Date(session.expires_at).getTime() < Date.now()) {
    forgetLiveSecret(session.id);
    throw Object.assign(new Error('expired'), { code: 'expired', status: 401 });
  }
  const held = liveSecrets.get(session.id);
  if (held != null) return held;

  const site = db.prepare('SELECT cred_enc FROM sites WHERE id = ?').get(session.site_id) as
    | Pick<SiteRow, 'cred_enc'>
    | undefined;
  if (!site) {
    throw Object.assign(new Error('site_not_found'), { code: 'site_not_found', status: 404 });
  }
  const password = openSiteCredential(site);
  liveSecrets.set(session.id, password);
  return password;
}

/**
 * Owner "test connection" probe. Opens inside this module so routes never
 * import `openCredential`. Do not log the return value.
 */
export function connectSecretForOwnerProbe(site: Pick<SiteRow, 'cred_enc'>): string {
  return openSiteCredential(site);
}

export function revokeSession(sessionId: string, actor = 'owner'): void {
  db.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(
    nowIso(),
    sessionId,
  );
  forgetLiveSecret(sessionId);
  audit(actor, 'session_revoke', { session_id: sessionId });
}

export function endSessionByToken(token: string): boolean {
  const session = getSessionByToken(token);
  if (!session) return false;
  revokeSession(session.id, 'agent');
  return true;
}

export function reapLiveSecrets(): void {
  const now = Date.now();
  for (const sessionId of [...liveSecrets.keys()]) {
    const row = db.prepare('SELECT expires_at, revoked_at FROM sessions WHERE id = ?').get(sessionId) as
      | { expires_at: string; revoked_at: string | null }
      | undefined;
    if (!row || row.revoked_at || new Date(row.expires_at).getTime() < now) {
      forgetLiveSecret(sessionId);
    }
  }
}

export function startSessionReaper(intervalMs = REAP_INTERVAL_MS): NodeJS.Timeout {
  reapLiveSecrets();
  const timer = setInterval(reapLiveSecrets, intervalMs);
  timer.unref?.();
  return timer;
}
