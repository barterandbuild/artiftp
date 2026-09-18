import { Router, type Request, type Response, type NextFunction } from 'express';
import { nanoid } from 'nanoid';
import { db, nowIso, audit, type SiteRow, type AccessRequestRow, type SessionRow } from '../db.js';
import { createApproveMagicLink } from '../auth.js';
import {
  assertActiveSession,
  endSessionByToken,
  getSessionByToken,
  sessionLifecycle,
} from '../sessions.js';
import { listFiles, uploadFile, downloadFile } from '../fs/storage.js';
import { PathForbiddenError } from '../pathJail.js';
import { parseRequestedTtlSec } from '../ttl.js';

export const agentRouter = Router();

function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  if (typeof req.headers['x-session-token'] === 'string') return req.headers['x-session-token'];
  return null;
}

type AuthedReq = Request & { session?: SessionRow; token?: string };

function optionalSession(req: AuthedReq, _res: Response, next: NextFunction): void {
  const t = bearer(req);
  if (t) {
    req.token = t;
    req.session = getSessionByToken(t) ?? undefined;
  }
  next();
}

function requireSession(req: AuthedReq, res: Response, next: NextFunction): void {
  const t = bearer(req);
  if (!t) {
    res.status(401).json({ error: 'session_locked', message: 'Bearer session token required' });
    return;
  }
  try {
    req.token = t;
    req.session = assertActiveSession(t);
    next();
  } catch (e: unknown) {
    const err = e as { code?: string; status?: number; message?: string };
    res.status(err.status || 401).json({ error: err.code || 'session_locked', message: err.message });
  }
}

function loadSite(siteId: string): SiteRow | undefined {
  return db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId) as SiteRow | undefined;
}

/** list_sites — public for MVP (single-tenant dogfood) */
agentRouter.get('/tools/list_sites', (_req, res) => {
  const sites = db
    .prepare(
      `SELECT id, display_name, slug, root_path, mode, max_ttl_sec FROM sites ORDER BY display_name`,
    )
    .all();
  audit('agent', 'list_sites', { detail: { count: (sites as unknown[]).length } });
  res.json({ sites });
});

/** request_access */
agentRouter.post('/tools/request_access', (req, res) => {
  const body = req.body || {};
  const siteIdOrSlug = String(body.site_id || body.slug || '');
  if (!siteIdOrSlug) {
    res.status(400).json({ error: 'site_required' });
    return;
  }
  const site = db
    .prepare('SELECT * FROM sites WHERE id = ? OR slug = ?')
    .get(siteIdOrSlug, siteIdOrSlug) as SiteRow | undefined;
  if (!site) {
    res.status(404).json({ error: 'site_not_found' });
    return;
  }
  const mode = body.mode === 'read' ? 'read' : body.mode === 'read_write' ? 'read_write' : site.mode;
  const requested_ttl_sec = parseRequestedTtlSec(
    body.ttl_sec ?? body.requested_ttl_sec ?? body.ttl ?? 'until_revoke',
    site.max_ttl_sec,
  );
  const purpose = String(body.purpose || 'Agent file access');
  const path_hint = body.path_hint != null ? String(body.path_hint) : null;
  const agent_label = body.agent_label != null ? String(body.agent_label) : 'Grok Bot';
  const id = nanoid();
  db.prepare(
    `INSERT INTO access_requests (id, site_id, purpose, path_hint, mode, requested_ttl_sec, agent_label, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(id, site.id, purpose, path_hint, mode, requested_ttl_sec, agent_label, nowIso());
  const { url } = createApproveMagicLink(id);
  audit('agent', 'request_access', {
    site_id: site.id,
    request_id: id,
    detail: { purpose, mode, requested_ttl_sec },
  });
  res.status(201).json({
    request_id: id,
    status: 'pending',
    message: 'session_locked — wait for owner Approve',
    approve_url_dev: url,
  });
});

/** session_status — by request_id and/or bearer token */
agentRouter.get('/tools/session_status', optionalSession, (req: AuthedReq, res) => {
  const requestId = typeof req.query.request_id === 'string' ? req.query.request_id : null;
  let request: AccessRequestRow | null = null;
  if (requestId) {
    request =
      (db.prepare('SELECT * FROM access_requests WHERE id = ?').get(requestId) as AccessRequestRow) ||
      null;
  }
  let session = req.session ?? null;
  if (!session && request?.status === 'approved') {
    session =
      (db
        .prepare('SELECT * FROM sessions WHERE request_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(request.id) as SessionRow) || null;
  }
  const status = sessionLifecycle(session, request);

  // Handoff token once after approve (dogfood / MCP poll)
  let session_token: string | undefined;
  if (request && status === 'active') {
    const handoff = db
      .prepare(`SELECT payload, used_at FROM magic_links WHERE token_hash = ? AND purpose = 'session_handoff'`)
      .get(`handoff:${request.id}`) as { payload: string; used_at: string | null } | undefined;
    if (handoff && !handoff.used_at) {
      const payload = JSON.parse(handoff.payload) as { session_token: string };
      session_token = payload.session_token;
      db.prepare('UPDATE magic_links SET used_at = ? WHERE token_hash = ?').run(
        nowIso(),
        `handoff:${request.id}`,
      );
    }
  }

  res.json({
    status,
    request_id: request?.id,
    session_id: session?.id,
    expires_at: session?.expires_at,
    root_path: session?.root_path,
    mode: session?.mode,
    session_token,
  });
});

agentRouter.get('/tools/list_files', requireSession, async (req: AuthedReq, res) => {
  const session = req.session!;
  const rel = typeof req.query.path === 'string' ? req.query.path : '.';
  const site = loadSite(session.site_id);
  if (!site) {
    res.status(404).json({ error: 'site_not_found' });
    return;
  }
  try {
    const entries = await listFiles(site, rel, session.root_path);
    audit('agent', 'list_files', {
      site_id: session.site_id,
      session_id: session.id,
      detail: { path: rel, count: entries.length },
    });
    res.json({ entries });
  } catch (e: unknown) {
    return toolError(res, e);
  }
});

agentRouter.post('/tools/upload_file', requireSession, async (req: AuthedReq, res) => {
  const session = req.session!;
  const body = req.body || {};
  const relPath = String(body.path || '');
  if (!relPath) {
    res.status(400).json({ error: 'path_required' });
    return;
  }
  let content: Buffer;
  if (typeof body.content_base64 === 'string') {
    content = Buffer.from(body.content_base64, 'base64');
  } else if (typeof body.content === 'string') {
    content = Buffer.from(body.content, 'utf8');
  } else {
    res.status(400).json({ error: 'content_required' });
    return;
  }
  const maxBytes = 5 * 1024 * 1024;
  if (content.length > maxBytes) {
    res.status(413).json({ error: 'quota_exceeded', message: 'max 5MB for MVP' });
    return;
  }
  const site = loadSite(session.site_id);
  if (!site) {
    res.status(404).json({ error: 'site_not_found' });
    return;
  }
  try {
    const result = await uploadFile(site, relPath, content, session.mode, session.root_path);
    audit('agent', 'upload_file', {
      site_id: session.site_id,
      session_id: session.id,
      detail: result,
    });
    res.json({ ok: true, ...result });
  } catch (e: unknown) {
    return toolError(res, e);
  }
});

agentRouter.get('/tools/download_file', requireSession, async (req: AuthedReq, res) => {
  const session = req.session!;
  const relPath = typeof req.query.path === 'string' ? req.query.path : '';
  if (!relPath) {
    res.status(400).json({ error: 'path_required' });
    return;
  }
  const site = loadSite(session.site_id);
  if (!site) {
    res.status(404).json({ error: 'site_not_found' });
    return;
  }
  try {
    const result = await downloadFile(site, relPath, session.root_path);
    audit('agent', 'download_file', {
      site_id: session.site_id,
      session_id: session.id,
      detail: { path: result.path, bytes: result.bytes },
    });
    res.json({
      path: result.path,
      bytes: result.bytes,
      content_base64: result.content.toString('base64'),
      content: result.content.toString('utf8'),
    });
  } catch (e: unknown) {
    return toolError(res, e);
  }
});

agentRouter.post('/tools/end_session', requireSession, (req: AuthedReq, res) => {
  endSessionByToken(req.token!);
  audit('agent', 'end_session', { session_id: req.session!.id, site_id: req.session!.site_id });
  res.json({ ok: true, status: 'revoked' });
});

function toolError(res: Response, e: unknown): void {
  if (e instanceof PathForbiddenError) {
    audit('agent', 'path_forbidden', { detail: { message: e.message } });
    res.status(403).json({ error: 'path_forbidden', message: e.message });
    return;
  }
  const err = e as { code?: string; message?: string };
  if (err.code === 'mode_forbidden') {
    res.status(403).json({ error: 'mode_forbidden' });
    return;
  }
  if (err.code === 'not_found') {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (err.code === 'not_a_directory') {
    res.status(400).json({ error: 'not_a_directory' });
    return;
  }
  console.error('[agent tool]', err.code || err.message || e);
  res.status(500).json({ error: 'internal', message: String(err.code || err.message || 'error') });
}
