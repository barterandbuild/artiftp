import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  DEFAULT_WAITLIST_OWNER_EMAIL,
  buildWaitlistEmail,
  clientIpFromHeaders,
  createMemoryRateLimiter,
  getWaitlistRecipient,
  isWaitlistAllowedOrigin,
  parseWaitlistBody,
} from '../src/waitlist.js';
import { createWaitlistRouter } from '../src/routes/waitlist.js';
import { sendEmail, type SendEmailInput, type SendEmailResult } from '../src/mail.js';

const SAVED = {
  OWNER_EMAIL: process.env.OWNER_EMAIL,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(restoreEnv);

const validBody = {
  name: 'Ada Lovelace',
  business: 'Analytical Engines',
  email: 'ada@example.com',
  agent: 'Cursor',
  sites: '1-2',
  host: 'GoDaddy',
};

async function withServer(
  router: express.Router,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe('parseWaitlistBody', () => {
  it('accepts required fields and optional host', () => {
    const parsed = parseWaitlistBody(validBody);
    assert.deepEqual(parsed, { ok: true, signup: validBody });
  });

  it('accepts business_name, site_count, and host_type aliases', () => {
    const parsed = parseWaitlistBody({
      name: 'Ada',
      business_name: 'AE',
      email: 'ada@example.com',
      agent: 'Grok',
      site_count: '3-6',
      host_type: 'cPanel',
    });
    assert.deepEqual(parsed, {
      ok: true,
      signup: {
        name: 'Ada',
        business: 'AE',
        email: 'ada@example.com',
        agent: 'Grok',
        sites: '3-6',
        host: 'cPanel',
      },
    });
  });

  it('omits host when absent', () => {
    const parsed = parseWaitlistBody({
      name: 'Ada',
      business: 'AE',
      email: 'ada@example.com',
      agent: 'Cursor',
      sites: '1-2',
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.signup.host, undefined);
  });

  it('rejects Other without agent_other', () => {
    assert.deepEqual(
      parseWaitlistBody({ ...validBody, agent: 'Other' }),
      { ok: false, error: 'agent_other is required' },
    );
    assert.deepEqual(
      parseWaitlistBody({ ...validBody, agent: 'other', agent_other: '   ' }),
      { ok: false, error: 'agent_other is required' },
    );
  });

  it('accepts Other with agent_other (case-insensitive agent)', () => {
    const parsed = parseWaitlistBody({
      ...validBody,
      agent: 'OTHER',
      agent_other: 'Claude Desktop',
    });
    assert.deepEqual(parsed, {
      ok: true,
      signup: {
        name: validBody.name,
        business: validBody.business,
        email: validBody.email,
        agent: 'OTHER',
        agent_other: 'Claude Desktop',
        sites: '1-2',
        host: 'GoDaddy',
      },
    });
  });

  it('ignores agent_other when agent is not Other', () => {
    const parsed = parseWaitlistBody({ ...validBody, agent_other: 'should ignore' });
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.signup.agent_other, undefined);
  });

  it('rejects missing or invalid sites', () => {
    const { sites: _sites, ...noSites } = validBody;
    assert.deepEqual(parseWaitlistBody(noSites), { ok: false, error: 'sites is required' });
    assert.deepEqual(parseWaitlistBody({ ...validBody, sites: 'many' }), {
      ok: false,
      error: 'sites is invalid',
    });
    assert.deepEqual(parseWaitlistBody({ ...validBody, sites: 0 }), {
      ok: false,
      error: 'sites is invalid',
    });
    assert.deepEqual(parseWaitlistBody({ ...validBody, sites: -3 }), {
      ok: false,
      error: 'sites is invalid',
    });
  });

  it('normalizes enum-ish and positive-integer site counts', () => {
    const base = { name: 'Ada', business: 'AE', email: 'ada@example.com', agent: 'Cursor' };
    const plus = parseWaitlistBody({ ...base, sites: '7+' });
    assert.equal(plus.ok, true);
    if (plus.ok) assert.equal(plus.signup.sites, '7+');
    const unlimited = parseWaitlistBody({ ...base, sites: 'Unlimited' });
    assert.equal(unlimited.ok, true);
    if (unlimited.ok) assert.equal(unlimited.signup.sites, 'unlimited');
    const asNumber = parseWaitlistBody({ ...base, site_count: 4 });
    assert.equal(asNumber.ok, true);
    if (asNumber.ok) assert.equal(asNumber.signup.sites, '4');
    const asNumericString = parseWaitlistBody({ ...base, sites: '12' });
    assert.equal(asNumericString.ok, true);
    if (asNumericString.ok) assert.equal(asNumericString.signup.sites, '12');
  });

  it('rejects missing required fields', () => {
    assert.deepEqual(parseWaitlistBody({}), { ok: false, error: 'name is required' });
    assert.deepEqual(parseWaitlistBody({ name: 'Ada' }), { ok: false, error: 'business is required' });
    assert.deepEqual(parseWaitlistBody({ name: 'Ada', business: 'AE' }), {
      ok: false,
      error: 'email is required',
    });
    assert.deepEqual(parseWaitlistBody({ name: 'Ada', business: 'AE', email: 'ada@example.com' }), {
      ok: false,
      error: 'agent is required',
    });
    assert.deepEqual(
      parseWaitlistBody({ name: 'Ada', business: 'AE', email: 'ada@example.com', agent: 'Cursor' }),
      { ok: false, error: 'sites is required' },
    );
  });

  it('rejects invalid email', () => {
    assert.deepEqual(
      parseWaitlistBody({ ...validBody, email: 'not-an-email' }),
      { ok: false, error: 'email is invalid' },
    );
    assert.deepEqual(
      parseWaitlistBody({ ...validBody, email: 'ada@' }),
      { ok: false, error: 'email is invalid' },
    );
  });

  it('rejects non-object bodies and blank strings', () => {
    assert.deepEqual(parseWaitlistBody(null), { ok: false, error: 'JSON object body required' });
    assert.deepEqual(parseWaitlistBody([]), { ok: false, error: 'JSON object body required' });
    assert.deepEqual(parseWaitlistBody({ ...validBody, name: '   ' }), {
      ok: false,
      error: 'name is required',
    });
  });
});

describe('buildWaitlistEmail / getWaitlistRecipient', () => {
  it('defaults recipient to hello@barterandbuild.com', () => {
    delete process.env.OWNER_EMAIL;
    assert.equal(getWaitlistRecipient(), DEFAULT_WAITLIST_OWNER_EMAIL);
    process.env.OWNER_EMAIL = '   ';
    assert.equal(getWaitlistRecipient(), DEFAULT_WAITLIST_OWNER_EMAIL);
    process.env.OWNER_EMAIL = '  ops@example.com  ';
    assert.equal(getWaitlistRecipient(), 'ops@example.com');
  });

  it('builds subject and plain-text field list', () => {
    delete process.env.OWNER_EMAIL;
    const mail = buildWaitlistEmail(validBody);
    assert.equal(mail.to, 'hello@barterandbuild.com');
    assert.equal(mail.subject, 'ArtiFTP waitlist: Ada Lovelace / Analytical Engines');
    assert.match(mail.text, /Name: Ada Lovelace/);
    assert.match(mail.text, /Business: Analytical Engines/);
    assert.match(mail.text, /Email: ada@example.com/);
    assert.match(mail.text, /Agent: Cursor/);
    assert.match(mail.text, /Sites: 1-2/);
    assert.match(mail.text, /Host: GoDaddy/);
  });

  it('includes agent_other and sites in the email body', () => {
    delete process.env.OWNER_EMAIL;
    const mail = buildWaitlistEmail({
      name: 'Ada Lovelace',
      business: 'Analytical Engines',
      email: 'ada@example.com',
      agent: 'Other',
      agent_other: 'Claude Desktop',
      sites: 'unlimited',
    });
    assert.match(mail.text, /Agent: Other/);
    assert.match(mail.text, /Agent other: Claude Desktop/);
    assert.match(mail.text, /Sites: unlimited/);
    assert.match(mail.html, /Agent other: Claude Desktop/);
    assert.match(mail.html, /Sites: unlimited/);
  });
});

describe('isWaitlistAllowedOrigin', () => {
  it('allows production landing origins and localhost', () => {
    assert.equal(isWaitlistAllowedOrigin('https://artiftp.com'), true);
    assert.equal(isWaitlistAllowedOrigin('https://www.artiftp.com'), true);
    assert.equal(isWaitlistAllowedOrigin('http://localhost:5173'), true);
    assert.equal(isWaitlistAllowedOrigin('http://127.0.0.1:3000'), true);
    assert.equal(isWaitlistAllowedOrigin('https://evil.example'), false);
    assert.equal(isWaitlistAllowedOrigin(undefined), false);
  });
});

describe('clientIpFromHeaders', () => {
  it('uses the first X-Forwarded-For hop', () => {
    assert.equal(clientIpFromHeaders({ 'x-forwarded-for': ' 1.2.3.4, 10.0.0.1' }, '9.9.9.9'), '1.2.3.4');
    assert.equal(clientIpFromHeaders({}, '9.9.9.9'), '9.9.9.9');
  });
});

describe('POST /api/waitlist', () => {
  it('returns 400 { error } on bad input', async () => {
    await withServer(createWaitlistRouter({ sendEmail: async () => ({ ok: true, id: 'x' }) }), async (base) => {
      const res = await fetch(`${base}/api/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Ada' }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: 'business is required' });
    });
  });

  it('returns 400 when agent is Other without agent_other', async () => {
    await withServer(createWaitlistRouter({ sendEmail: async () => ({ ok: true, id: 'x' }) }), async (base) => {
      const res = await fetch(`${base}/api/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, agent: 'Other' }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: 'agent_other is required' });
    });
  });

  it('returns { ok: true } when agent is Other with agent_other', async () => {
    const sent: SendEmailInput[] = [];
    const mockSend = async (input: SendEmailInput): Promise<SendEmailResult> => {
      sent.push(input);
      return { ok: true, id: 'ok' };
    };
    await withServer(createWaitlistRouter({ sendEmail: mockSend }), async (base) => {
      const res = await fetch(`${base}/api/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, agent: 'other', agent_other: 'Windsurf' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /Agent: other/);
    assert.match(sent[0]!.text, /Agent other: Windsurf/);
    assert.match(sent[0]!.text, /Sites: 1-2/);
  });

  it('returns 400 when sites is missing', async () => {
    const { sites: _sites, ...noSites } = validBody;
    await withServer(createWaitlistRouter({ sendEmail: async () => ({ ok: true, id: 'x' }) }), async (base) => {
      const res = await fetch(`${base}/api/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(noSites),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: 'sites is required' });
    });
  });

  it('returns 503 when RESEND_API_KEY is missing (does not pretend success)', async () => {
    delete process.env.RESEND_API_KEY;
    await withServer(createWaitlistRouter({ sendEmail }), async (base) => {
      const res = await fetch(`${base}/api/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      });
      assert.equal(res.status, 503);
      const json = (await res.json()) as { error: string };
      assert.match(json.error, /RESEND_API_KEY missing/);
    });
  });

  it('emails via mocked Resend send and returns { ok: true }', async () => {
    delete process.env.OWNER_EMAIL;
    const sent: SendEmailInput[] = [];
    const mockSend = async (input: SendEmailInput): Promise<SendEmailResult> => {
      sent.push(input);
      return { ok: true, id: 'email_waitlist' };
    };
    await withServer(createWaitlistRouter({ sendEmail: mockSend }), async (base) => {
      const res = await fetch(`${base}/api/waitlist`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://artiftp.com',
        },
        body: JSON.stringify(validBody),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.equal(res.headers.get('access-control-allow-origin'), 'https://artiftp.com');
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, 'hello@barterandbuild.com');
    assert.equal(sent[0]!.subject, 'ArtiFTP waitlist: Ada Lovelace / Analytical Engines');
    assert.match(sent[0]!.text, /Agent: Cursor/);
    assert.match(sent[0]!.text, /Sites: 1-2/);
    assert.match(sent[0]!.text, /Host: GoDaddy/);
  });

  it('sets CORS on allowed origins and skips it for others', async () => {
    const mockSend = async (): Promise<SendEmailResult> => ({ ok: true, id: 'ok' });
    await withServer(createWaitlistRouter({ sendEmail: mockSend }), async (base) => {
      const preflight = await fetch(`${base}/api/waitlist`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://www.artiftp.com',
          'Access-Control-Request-Method': 'POST',
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://www.artiftp.com');

      const denied = await fetch(`${base}/api/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: JSON.stringify(validBody),
      });
      assert.equal(denied.status, 200);
      assert.equal(denied.headers.get('access-control-allow-origin'), null);
    });
  });

  it('rate-limits repeat POSTs from the same IP', async () => {
    const limiter = createMemoryRateLimiter({ windowMs: 60_000, max: 2 });
    const mockSend = async (): Promise<SendEmailResult> => ({ ok: true, id: 'ok' });
    await withServer(createWaitlistRouter({ sendEmail: mockSend, rateLimiter: limiter }), async (base) => {
      const post = () =>
        fetch(`${base}/api/waitlist`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validBody),
        });
      assert.equal((await post()).status, 200);
      assert.equal((await post()).status, 200);
      const limited = await post();
      assert.equal(limited.status, 429);
      assert.deepEqual(await limited.json(), {
        error: 'Too many waitlist submissions. Try again later.',
      });
    });
  });
});
