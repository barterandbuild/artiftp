import type { Request, Response, NextFunction } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso, audit } from './db.js';
import { hashToken, randomToken } from './crypto.js';
import { getPublicBaseUrl } from './publicUrl.js';

const OWNER_EMAIL = process.env.OWNER_EMAIL || 'bryan@barterandbuild.com';

export { getPublicBaseUrl, getBaseUrl } from './publicUrl.js';

export function ensureDefaultOwner(): { id: string; email: string } {
  let row = db.prepare('SELECT id, email FROM owners WHERE email = ?').get(OWNER_EMAIL) as
    | { id: string; email: string }
    | undefined;
  if (!row) {
    const id = nanoid();
    db.prepare('INSERT INTO owners (id, email, created_at) VALUES (?, ?, ?)').run(
      id,
      OWNER_EMAIL,
      nowIso(),
    );
    row = { id, email: OWNER_EMAIL };
    audit('system', 'owner_bootstrap', { detail: { email: OWNER_EMAIL } });
  }
  return row;
}

export function createOwnerMagicLink(): { token: string; url: string; expires_at: string } {
  const owner = ensureDefaultOwner();
  const token = randomToken(24);
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO magic_links (token_hash, purpose, payload, expires_at, created_at)
     VALUES (?, 'owner_login', ?, ?, ?)`,
  ).run(hashToken(token), JSON.stringify({ owner_id: owner.id }), expires, nowIso());
  const url = `${getPublicBaseUrl()}/auth/magic?token=${encodeURIComponent(token)}`;
  console.log('\n[ArtiFTP] Owner magic link (dev):\n  ' + url + '\n');
  return { token, url, expires_at: expires };
}

export function consumeOwnerMagicLink(token: string): string | null {
  const hash = hashToken(token);
  const row = db
    .prepare('SELECT * FROM magic_links WHERE token_hash = ? AND purpose = ?')
    .get(hash, 'owner_login') as
    | {
        payload: string;
        expires_at: string;
        used_at: string | null;
      }
    | undefined;
  if (!row || row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  db.prepare('UPDATE magic_links SET used_at = ? WHERE token_hash = ?').run(nowIso(), hash);
  const { owner_id } = JSON.parse(row.payload) as { owner_id: string };
  const sessionToken = randomToken(32);
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO owner_sessions (token_hash, owner_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
  ).run(hashToken(sessionToken), owner_id, expires, nowIso());
  audit('owner', 'login', { detail: { owner_id } });
  return sessionToken;
}

export function createApproveMagicLink(requestId: string): { token: string; url: string } {
  const token = randomToken(24);
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO magic_links (token_hash, purpose, payload, expires_at, created_at)
     VALUES (?, 'approve', ?, ?, ?)`,
  ).run(hashToken(token), JSON.stringify({ request_id: requestId, token }), expires, nowIso());
  const url = `${getPublicBaseUrl()}/approve/${encodeURIComponent(token)}`;
  console.log('\n[ArtiFTP] Approve magic link (dev):\n  ' + url + '\n');
  return { token, url };
}

export function lookupApproveToken(token: string): string | null {
  const hash = hashToken(token);
  const row = db
    .prepare('SELECT * FROM magic_links WHERE token_hash = ? AND purpose = ?')
    .get(hash, 'approve') as
    | { payload: string; expires_at: string; used_at: string | null }
    | undefined;
  if (!row || row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  const { request_id } = JSON.parse(row.payload) as { request_id: string };
  return request_id;
}

export function markApproveTokenUsed(token: string): void {
  db.prepare('UPDATE magic_links SET used_at = ? WHERE token_hash = ?').run(
    nowIso(),
    hashToken(token),
  );
}

export type OwnerReq = Request & { ownerId?: string };

export function requireOwner(req: OwnerReq, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const cookie = (req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('artiftp_owner=') || c.startsWith('agentftp_owner='));
  const raw =
    (header?.startsWith('Bearer ') ? header.slice(7) : null) ||
    (cookie ? decodeURIComponent(cookie.split('=')[1]!) : null) ||
    (typeof req.query.owner_token === 'string' ? req.query.owner_token : null);

  if (!raw) {
    res.status(401).json({ error: 'owner_auth_required' });
    return;
  }
  const row = db
    .prepare(
      `SELECT owner_id, expires_at FROM owner_sessions WHERE token_hash = ?`,
    )
    .get(hashToken(raw)) as { owner_id: string; expires_at: string } | undefined;
  if (!row || new Date(row.expires_at).getTime() < Date.now()) {
    res.status(401).json({ error: 'owner_session_expired' });
    return;
  }
  req.ownerId = row.owner_id;
  next();
}

