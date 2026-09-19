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

  it('accepts business_name and host_type aliases', () => {
    const parsed = parseWaitlistBody({
      name: 'Ada',
      business_name: 'AE',
      email: 'ada@example.com',
      agent: 'Grok',
      host_type: 'cPanel',
    });
    assert.deepEqual(parsed, {
      ok: true,
      signup: { name: 'Ada', business: 'AE', email: 'ada@example.com', agent: 'Grok', host: 'cPanel' },
    });
  });

  it('omits host when absent', () => {
    const parsed = parseWaitlistBody({
      name: 'Ada',
      business: 'AE',
      email: 'ada@example.com',
      agent: 'Other',
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.signup.host, undefined);
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
    assert.match(mail.text, /Host: GoDaddy/);
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
