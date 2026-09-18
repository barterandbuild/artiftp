/**
 * ArtiFTP dogfood — create site, request access, approve, upload, revoke, verify deny.
 * Usage: API must be running.  npx tsx scripts/dogfood.ts
 */
import { createOwnerMagicLink, consumeOwnerMagicLink } from '../src/auth.js';
import { db } from '../src/db.js';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';

async function api(
  path: string,
  opts: RequestInit & { token?: string } = {},
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> | undefined),
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const { token: _t, ...rest } = opts;
  const res = await fetch(`${BASE}${path}`, { ...rest, headers });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* html */
  }
  return { status: res.status, json, text };
}

function ownerSession(): string {
  const { token } = createOwnerMagicLink();
  const session = consumeOwnerMagicLink(token);
  if (!session) throw new Error('failed to mint owner session');
  return session;
}

async function main(): Promise<void> {
  console.log(`== ArtiFTP dogfood against ${BASE} ==`);

  const health = await api('/health');
  if (health.status !== 200) throw new Error('health failed');
  console.log('-- health', health.json);

  const owner = ownerSession();
  console.log('-- owner session ok');

  let sites = await api('/api/sites', { token: owner });
  let siteId: string;
  const list = (sites.json.sites as Array<{ id: string }>) || [];
  if (!list.length) {
    const created = await api('/api/sites', {
      method: 'POST',
      token: owner,
      body: JSON.stringify({
        display_name: 'barterandbuild.com',
        slug: 'barterandbuild',
        host: 'mock.local',
        sftp_user: 'mock',
        password: 'mock-password',
        root_path: '/samples',
        mode: 'read_write',
        max_ttl_sec: 900,
      }),
    });
    if (created.status !== 201) throw new Error('site create failed: ' + created.text);
    siteId = (created.json.site as { id: string }).id;
    console.log('-- created site', siteId);
  } else {
    siteId = list[0]!.id;
    console.log('-- using existing site', siteId);
  }

  const req = await api('/tools/request_access', {
    method: 'POST',
    body: JSON.stringify({
      site_id: siteId,
      purpose: 'Upload dogfood sample',
      mode: 'read_write',
      ttl_sec: 600,
      agent_label: 'Justice dogfood',
    }),
  });
  if (req.status !== 201) throw new Error('request_access failed: ' + req.text);
  const requestId = String(req.json.request_id);
  const approveUrl = String(req.json.approve_url_dev);
  console.log('-- request_access', requestId);
  console.log('   approve_url', approveUrl);

  const approveRes = await fetch(approveUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'decision=approve',
  });
  if (!approveRes.ok) throw new Error('approve failed: ' + approveRes.status);
  console.log('-- approved');

  const status = await api(`/tools/session_status?request_id=${encodeURIComponent(requestId)}`);
  const sessionToken = status.json.session_token as string | undefined;
  if (!sessionToken) throw new Error('no session_token: ' + JSON.stringify(status.json));
  console.log('-- session_token received, status=', status.json.status);

  const listed = await api('/tools/list_files', { token: sessionToken });
  if (listed.status !== 200) throw new Error('list_files failed: ' + listed.text);
  console.log('-- list_files', listed.json);

  const upload = await api('/tools/upload_file', {
    method: 'POST',
    token: sessionToken,
    body: JSON.stringify({
      path: 'dogfood-hello.txt',
      content: 'hello from ArtiFTP dogfood\n',
    }),
  });
  if (upload.status !== 200) throw new Error('upload failed: ' + upload.text);
  console.log('-- upload_file', upload.json);

  const jail = await api('/tools/upload_file', {
    method: 'POST',
    token: sessionToken,
    body: JSON.stringify({ path: '../escape.txt', content: 'nope' }),
  });
  console.log('-- traversal HTTP', jail.status, jail.json);
  if (jail.status !== 403 || jail.json.error !== 'path_forbidden') {
    throw new Error('expected path_forbidden 403');
  }

  const end = await api('/tools/end_session', {
    method: 'POST',
    token: sessionToken,
    body: '{}',
  });
  if (end.status !== 200) throw new Error('end_session failed');
  console.log('-- end_session ok');

  const after = await api('/tools/upload_file', {
    method: 'POST',
    token: sessionToken,
    body: JSON.stringify({ path: 'after-revoke.txt', content: 'nope' }),
  });
  console.log('-- post-revoke HTTP', after.status, after.json);
  if (after.status !== 401) throw new Error('expected 401 after revoke');

  const auditCount = (
    db.prepare('SELECT COUNT(*) AS c FROM audit_events').get() as { c: number }
  ).c;
  console.log('-- audit events in DB:', auditCount);
  console.log('\n== dogfood OK ==');
}

main().catch((e) => {
  console.error('DOGFOOD FAILED', e);
  process.exit(1);
});
