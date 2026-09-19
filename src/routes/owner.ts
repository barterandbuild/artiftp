import { Router } from 'express';
import { nanoid } from 'nanoid';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, nowIso, audit, type SiteRow, type AccessRequestRow, type SessionRow } from '../db.js';
import { encrypt } from '../crypto.js';
import {
  createOwnerMagicLink,
  consumeOwnerMagicLink,
  createApproveMagicLink,
  requireOwner,
  type OwnerReq,
  lookupApproveToken,
  markApproveTokenUsed,
  getPublicBaseUrl,
} from '../auth.js';
import { mintSession, revokeSession, sessionLifecycle } from '../sessions.js';
import { seedFromSamples, siteMockRoot } from '../fs/mockBackend.js';
import { siteBackendKind, testSiteConnection } from '../fs/storage.js';
import { parseMaxTtlSec, UNTIL_REVOKE_SEC } from '../ttl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.resolve(__dirname, '../../data/samples');

function sitePublic(row: Omit<SiteRow, 'cred_enc'> | SiteRow) {
  const { cred_enc: _c, ...rest } = row as SiteRow;
  return { ...rest, backend: siteBackendKind(row as SiteRow) };
}

export const ownerRouter = Router();

ownerRouter.post('/auth/request-link', (_req, res) => {
  const link = createOwnerMagicLink();
  res.json({ ok: true, expires_at: link.expires_at, hint: 'magic link printed to server console' });
});

ownerRouter.get('/auth/magic', (req, res) => {
  const token = String(req.query.token || '');
  const session = consumeOwnerMagicLink(token);
  if (!session) {
    res.status(400).send('<h1>Invalid or expired magic link</h1>');
    return;
  }
  res.setHeader(
    'Set-Cookie',
    `artiftp_owner=${encodeURIComponent(session)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}`,
  );
  res.redirect('/ui/');
});

ownerRouter.get('/api/me', requireOwner, (req: OwnerReq, res) => {
  const owner = db.prepare('SELECT id, email, created_at FROM owners WHERE id = ?').get(req.ownerId!);
  res.json({ owner });
});

ownerRouter.get('/api/sites', requireOwner, (req: OwnerReq, res) => {
  const sites = db
    .prepare('SELECT id, display_name, slug, host, port, sftp_user, root_path, mode, max_ttl_sec, created_at, updated_at FROM sites WHERE owner_id = ? ORDER BY created_at DESC')
    .all(req.ownerId!) as Omit<SiteRow, 'cred_enc'>[];
  res.json({ sites: sites.map((s) => sitePublic(s)) });
});

ownerRouter.post('/api/sites', requireOwner, (req: OwnerReq, res) => {
  const body = req.body || {};
  const display_name = String(body.display_name || 'My site');
  const slug = String(body.slug || display_name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).replace(/^-|-$/g, '');
  const host = String(body.host || 'mock.local');
  const port = Number(body.port || 22);
  const sftp_user = String(body.sftp_user || body.username || 'mock');
  const password = String(body.password || 'mock-password');
  const root_path = String(body.root_path || '/samples');
  const mode = body.mode === 'read' ? 'read' : 'read_write';
  const max_ttl_sec = parseMaxTtlSec(body.max_ttl_sec ?? body.ttl ?? body.session_ttl, UNTIL_REVOKE_SEC);
  const id = nanoid();
  const t = nowIso();
  try {
    db.prepare(
      `INSERT INTO sites (id, owner_id, display_name, slug, host, port, sftp_user, cred_enc, root_path, mode, max_ttl_sec, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      req.ownerId!,
      display_name,
      slug,
      host,
      port,
      sftp_user,
      encrypt(password),
      root_path,
      mode,
      max_ttl_sec,
      t,
      t,
    );
  } catch (e: unknown) {
    res.status(400).json({ error: 'site_create_failed', detail: String(e) });
    return;
  }
  siteMockRoot(id);
  if (body.seed_samples !== false) {
    const sub = root_path.replace(/^\//, '') || 'samples';
    seedFromSamples(id, SAMPLES, sub);
  }
  audit('owner', 'site_create', { site_id: id, detail: { slug, root_path, mode } });
  const site = db
    .prepare(
      'SELECT id, display_name, slug, host, port, sftp_user, root_path, mode, max_ttl_sec, created_at, updated_at FROM sites WHERE id = ?',
    )
    .get(id) as Omit<SiteRow, 'cred_enc'>;
  res.status(201).json({ site: sitePublic(site) });
});

ownerRouter.patch('/api/sites/:id', requireOwner, (req: OwnerReq, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ? AND owner_id = ?').get(req.params.id, req.ownerId!) as
    | SiteRow
    | undefined;
  if (!site) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const body = req.body || {};
  const root_path = body.root_path != null ? String(body.root_path) : site.root_path;
  const mode = body.mode === 'read' || body.mode === 'read_write' ? body.mode : site.mode;
  const max_ttl_sec =
    body.max_ttl_sec != null || body.ttl != null || body.session_ttl != null
      ? parseMaxTtlSec(body.max_ttl_sec ?? body.ttl ?? body.session_ttl, site.max_ttl_sec)
      : site.max_ttl_sec;
  const display_name = body.display_name != null ? String(body.display_name) : site.display_name;
  const host = body.host != null ? String(body.host) : site.host;
  const port = body.port != null ? Number(body.port) : site.port;
  const sftp_user =
    body.sftp_user != null || body.username != null
      ? String(body.sftp_user || body.username)
      : site.sftp_user;
  let cred_enc = site.cred_enc;
  if (body.password != null && String(body.password).length > 0) {
    cred_enc = encrypt(String(body.password));
  }
  db.prepare(
    `UPDATE sites SET root_path = ?, mode = ?, max_ttl_sec = ?, display_name = ?, host = ?, port = ?, sftp_user = ?, cred_enc = ?, updated_at = ? WHERE id = ?`,
  ).run(root_path, mode, max_ttl_sec, display_name, host, port, sftp_user, cred_enc, nowIso(), site.id);
  audit('owner', 'site_policy_update', {
    site_id: site.id,
    detail: { root_path, mode, max_ttl_sec, host, port, sftp_user, password_rotated: Boolean(body.password) },
  });
  const updated = db
    .prepare(
      'SELECT id, display_name, slug, host, port, sftp_user, root_path, mode, max_ttl_sec, created_at, updated_at FROM sites WHERE id = ?',
    )
    .get(site.id) as Omit<SiteRow, 'cred_enc'>;
  res.json({ site: sitePublic(updated) });
});

ownerRouter.delete('/api/sites/:id', requireOwner, (req: OwnerReq, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ? AND owner_id = ?').get(req.params.id, req.ownerId!);
  if (!site) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  db.prepare('DELETE FROM sites WHERE id = ?').run(req.params.id);
  audit('owner', 'site_delete', { site_id: req.params.id });
  res.json({ ok: true });
});

ownerRouter.get('/api/sites/:id/backend', requireOwner, (req: OwnerReq, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ? AND owner_id = ?').get(req.params.id, req.ownerId!) as
    | SiteRow
    | undefined;
  if (!site) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({
    site_id: site.id,
    backend: siteBackendKind(site),
    host: site.host,
    port: site.port,
    root_path: site.root_path,
  });
});

ownerRouter.post('/api/sites/:id/test', requireOwner, async (req: OwnerReq, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ? AND owner_id = ?').get(req.params.id, req.ownerId!) as
    | SiteRow
    | undefined;
  if (!site) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const result = await testSiteConnection(site);
  audit('owner', 'site_test', {
    site_id: site.id,
    detail: { ok: result.ok, backend: result.backend, latency_ms: result.latency_ms },
  });
  res.status(result.ok ? 200 : 502).json(result);
});

ownerRouter.get('/api/requests', requireOwner, (req: OwnerReq, res) => {
  const rows = db
    .prepare(
      `SELECT r.* FROM access_requests r
       JOIN sites s ON s.id = r.site_id
       WHERE s.owner_id = ?
       ORDER BY r.created_at DESC LIMIT 50`,
    )
    .all(req.ownerId!) as AccessRequestRow[];
  // Map unused approve magic-links → plaintext token (stored in payload for owner UI deep-link)
  const linkRows = db
    .prepare(
      `SELECT payload, expires_at, used_at FROM magic_links WHERE purpose = 'approve' AND used_at IS NULL`,
    )
    .all() as Array<{ payload: string; expires_at: string; used_at: string | null }>;
  const tokenByRequest = new Map<string, string>();
  for (const link of linkRows) {
    if (new Date(link.expires_at).getTime() < Date.now()) continue;
    try {
      const p = JSON.parse(link.payload) as { request_id?: string; token?: string };
      if (p.request_id && p.token && !tokenByRequest.has(p.request_id)) {
        tokenByRequest.set(p.request_id, p.token);
      }
    } catch {
      /* ignore */
    }
  }
  const base = getPublicBaseUrl();
  const requests = rows.map((r) => {
    if (r.status !== 'pending') return { ...r, approve_token: null, approve_url: null };
    let token = tokenByRequest.get(r.id) || null;
    if (!token) {
      // Mint a fresh link so in-app Approve can deep-link / POST
      const minted = createApproveMagicLink(r.id);
      token = minted.token;
    }
    return {
      ...r,
      approve_token: token,
      approve_url: `${base}/approve/${encodeURIComponent(token)}`,
    };
  });
  res.json({ requests });
});

ownerRouter.get('/api/sessions', requireOwner, (req: OwnerReq, res) => {
  const rows = db
    .prepare(
      `SELECT sess.* FROM sessions sess
       JOIN sites s ON s.id = sess.site_id
       WHERE s.owner_id = ?
       ORDER BY sess.created_at DESC LIMIT 50`,
    )
    .all(req.ownerId!) as SessionRow[];
  const enriched = rows.map((s) => ({
    ...s,
    status: sessionLifecycle(s),
    token_hash: undefined,
  }));
  res.json({ sessions: enriched });
});

ownerRouter.post('/api/sessions/:id/revoke', requireOwner, (req: OwnerReq, res) => {
  const sess = db
    .prepare(
      `SELECT sess.* FROM sessions sess
       JOIN sites s ON s.id = sess.site_id
       WHERE sess.id = ? AND s.owner_id = ?`,
    )
    .get(req.params.id, req.ownerId!) as SessionRow | undefined;
  if (!sess) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  revokeSession(sess.id, 'owner');
  res.json({ ok: true });
});

ownerRouter.get('/api/audit', requireOwner, (req: OwnerReq, res) => {
  const filter = String(req.query.filter || 'all');
  let sql = `SELECT a.* FROM audit_events a
    LEFT JOIN sites s ON s.id = a.site_id
    WHERE (s.owner_id = ? OR a.site_id IS NULL)
    ORDER BY a.id DESC LIMIT 100`;
  const rows = db.prepare(sql).all(req.ownerId!) as Array<Record<string, unknown>>;
  const filtered =
    filter === 'all'
      ? rows
      : rows.filter((r) => {
          const action = String(r.action);
          if (filter === 'approvals') return /approve|deny|session_mint|request_access/.test(action);
          if (filter === 'files') return /list_files|upload_file|download_file/.test(action);
          if (filter === 'denials') return /deny|path_forbidden|expired|revoked|mode_forbidden/.test(action);
          return true;
        });
  res.json({ events: filtered });
});

/** HTML approve/deny page via magic link token */
ownerRouter.get('/approve/:token', (req, res) => {
  const requestId = lookupApproveToken(req.params.token);
  if (!requestId) {
    res.status(400).send(pageShell('Link expired', '<p>This approve link is invalid or already used.</p>'));
    return;
  }
  const request = db.prepare('SELECT * FROM access_requests WHERE id = ?').get(requestId) as
    | AccessRequestRow
    | undefined;
  if (!request) {
    res.status(404).send(pageShell('Not found', '<p>Request missing.</p>'));
    return;
  }
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(request.site_id) as SiteRow;
  if (request.status !== 'pending') {
    res.send(
      pageShell(
        'Already resolved',
        `<p>Status: <strong>${request.status}</strong></p><p><a href="/ui/">Owner UI</a></p>`,
      ),
    );
    return;
  }
  res.send(
    pageShell(
      'Approve access',
      `
      <div class="card">
        <p class="pill">${escapeHtml(request.agent_label || 'Agent')}</p>
        <h2>${escapeHtml(request.purpose)}</h2>
        <dl>
          <dt>Site</dt><dd>${escapeHtml(site.display_name)}</dd>
          <dt>Root</dt><dd><code>${escapeHtml(site.root_path)}</code></dd>
          <dt>Mode</dt><dd>${escapeHtml(request.mode)}</dd>
          <dt>TTL</dt><dd>${request.requested_ttl_sec}s (max ${site.max_ttl_sec}s)</dd>
          <dt>Path hint</dt><dd>${escapeHtml(request.path_hint || '—')}</dd>
        </dl>
        <form method="POST" action="/approve/${encodeURIComponent(req.params.token)}" class="row">
          <button name="decision" value="approve" class="approve">Approve</button>
          <button name="decision" value="deny" class="deny">Deny</button>
        </form>
      </div>`,
    ),
  );
});

ownerRouter.post('/approve/:token', (req, res) => {
  const token = req.params.token;
  const requestId = lookupApproveToken(token);
  if (!requestId) {
    res.status(400).send(pageShell('Link expired', '<p>Invalid or used link.</p>'));
    return;
  }
  const request = db.prepare('SELECT * FROM access_requests WHERE id = ?').get(requestId) as
    | AccessRequestRow
    | undefined;
  if (!request || request.status !== 'pending') {
    res.status(400).send(pageShell('Already resolved', '<p>Nothing to do.</p>'));
    return;
  }
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(request.site_id) as SiteRow;
  const decision = String((req.body && (req.body.decision || req.body.action)) || 'deny');
  markApproveTokenUsed(token);

  if (decision === 'approve') {
    const ttl = Math.min(request.requested_ttl_sec, site.max_ttl_sec);
    const { token: sessionToken, session } = mintSession(site, request, ttl);
    // Store session token temporarily for agent poll — also print for dogfood
    console.log(
      `\n[ArtiFTP] Session approved. Token (dogfood — not for chat logs):\n  ${sessionToken}\n  expires ${session.expires_at}\n`,
    );
    // Persist plaintext token in a short-lived side table via magic_links payload for poll
    db.prepare(
      `INSERT INTO magic_links (token_hash, purpose, payload, expires_at, created_at)
       VALUES (?, 'session_handoff', ?, ?, ?)`,
    ).run(
      // use request id as lookup key hash-ish
      `handoff:${request.id}`,
      JSON.stringify({ session_token: sessionToken, session_id: session.id }),
      session.expires_at,
      nowIso(),
    );
    audit('owner', 'approve', { site_id: site.id, request_id: request.id, session_id: session.id });
    res.send(
      pageShell(
        'Approved',
        `<div class="card ok"><h2>Session active</h2>
         <p>Expires <code>${escapeHtml(session.expires_at)}</code></p>
         <p>Root <code>${escapeHtml(site.root_path)}</code> · ${escapeHtml(request.mode)}</p>
         <p><a href="/ui/#session">Open owner UI</a></p></div>`,
      ),
    );
    return;
  }

  db.prepare(`UPDATE access_requests SET status = 'denied', resolved_at = ? WHERE id = ?`).run(
    nowIso(),
    request.id,
  );
  audit('owner', 'deny', { site_id: site.id, request_id: request.id });
  res.send(pageShell('Denied', '<div class="card"><p>Access denied. Agent will see <code>denied</code>.</p></div>'));
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function pageShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ArtiFTP · ${escapeHtml(title)}</title>
<style>
:root{--bg:#0b1220;--card:#101929;--text:#eef2f9;--muted:#8b9bb8;--emerald:#10b981;--rose:#f43f5e;--font:system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:linear-gradient(160deg,#070b14,#0b1220 40%,#12241f);color:var(--text);font-family:var(--font);display:flex;align-items:center;justify-content:center;padding:24px}
.wrap{width:100%;max-width:420px}.brand{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:12px}
.card{background:var(--card);border:1px solid #1c2a42;border-radius:16px;padding:24px;box-shadow:0 8px 32px rgba(0,0,0,.4)}
.card.ok{border-color:#059669}h2{margin:8px 0 16px;font-size:1.35rem}
dl{display:grid;grid-template-columns:100px 1fr;gap:8px 12px;font-size:14px;margin:0 0 20px}
dt{color:var(--muted)}dd{margin:0}code{font-size:12px;background:#152033;padding:2px 6px;border-radius:6px}
.row{display:flex;gap:12px}.approve,.deny{flex:1;border:0;border-radius:12px;padding:14px;font-weight:600;font-size:15px;cursor:pointer}
.approve{background:var(--emerald);color:#06281c}.deny{background:transparent;color:#fb7185;border:1px solid #3d5275}
.pill{display:inline-block;background:#152033;color:#60a5fa;font-size:12px;padding:4px 10px;border-radius:999px}
a{color:var(--emerald)}
</style></head>
<body><div class="wrap"><div class="brand">ArtiFTP · Access Gate</div>${body}</div></body></html>`;
}
