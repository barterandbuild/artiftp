import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EMAIL_FROM,
  RESEND_API_URL,
  buildApproveAccessEmail,
  buildOwnerLoginEmail,
  getEmailFrom,
  isMailConfigured,
  logMailConfigOnStartup,
  redactSecrets,
  sendApproveAccessLink,
  sendEmail,
  sendOwnerLoginLink,
} from '../src/mail.js';

const SAVED = {
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('getEmailFrom / isMailConfigured', () => {
  it('defaults from address to noreply@artiftp.com', () => {
    delete process.env.EMAIL_FROM;
    assert.equal(getEmailFrom(), DEFAULT_EMAIL_FROM);
    assert.equal(getEmailFrom(), 'noreply@artiftp.com');
  });

  it('accepts Name <email> form and treats blank as default', () => {
    process.env.EMAIL_FROM = 'ArtiFTP <noreply@artiftp.com>';
    assert.equal(getEmailFrom(), 'ArtiFTP <noreply@artiftp.com>');
    process.env.EMAIL_FROM = '   ';
    assert.equal(getEmailFrom(), DEFAULT_EMAIL_FROM);
  });

  it('reads RESEND_API_KEY at call time', () => {
    delete process.env.RESEND_API_KEY;
    assert.equal(isMailConfigured(), false);
    process.env.RESEND_API_KEY = 're_test_key';
    assert.equal(isMailConfigured(), true);
  });
});

describe('email content', () => {
  it('builds a plain owner login email with the full URL and expiry', () => {
    const url = 'https://app.artiftp.com/auth/magic?token=abc';
    const mail = buildOwnerLoginEmail(url);
    assert.equal(mail.subject, 'Your ArtiFTP login link');
    assert.match(mail.text, /https:\/\/app\.artiftp\.com\/auth\/magic\?token=abc/);
    assert.match(mail.text, /15 minutes/);
    assert.match(mail.html, /href="https:\/\/app\.artiftp\.com\/auth\/magic\?token=abc"/);
    assert.ok(!/unsubscribe|newsletter|marketing/i.test(mail.text + mail.html));
  });

  it('builds a plain approve-access email with the full URL and expiry', () => {
    const url = 'https://app.artiftp.com/approve/tok_123';
    const mail = buildApproveAccessEmail(url);
    assert.equal(mail.subject, 'Approve ArtiFTP access request');
    assert.match(mail.text, /https:\/\/app\.artiftp\.com\/approve\/tok_123/);
    assert.match(mail.text, /1 hour/);
    assert.match(mail.html, /href="https:\/\/app\.artiftp\.com\/approve\/tok_123"/);
  });
});

describe('sendEmail', () => {
  it('does not crash or fetch when RESEND_API_KEY is missing', async () => {
    delete process.env.RESEND_API_KEY;
    const warnings: string[] = [];
    let fetched = false;
    const result = await sendEmail(
      { to: 'owner@example.com', subject: 't', text: 't', html: '<p>t</p>' },
      {
        warn: (m) => warnings.push(m),
        fetch: async () => {
          fetched = true;
          return jsonResponse({ id: 'nope' });
        },
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'missing_api_key');
    assert.equal(fetched, false);
    assert.match(warnings.join('\n'), /RESEND_API_KEY is missing/);
  });

  it('POSTs to Resend with from/to/subject/text/html and never logs the API key', async () => {
    process.env.RESEND_API_KEY = 're_super_secret_key';
    process.env.EMAIL_FROM = 'ArtiFTP <noreply@artiftp.com>';
    const warnings: string[] = [];
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await sendEmail(
      {
        to: 'bryan@barterandbuild.com',
        subject: 'Your ArtiFTP login link',
        text: 'Use this link\n\nhttps://app.artiftp.com/auth/magic?token=abc\n',
        html: '<p>Use this link</p>',
      },
      {
        warn: (m) => warnings.push(m),
        fetch: async (url, init) => {
          calls.push({ url: String(url), init: init || {} });
          return jsonResponse({ id: 'email_123' });
        },
      },
    );
    assert.deepEqual(result, { ok: true, id: 'email_123' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, RESEND_API_URL);
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer re_super_secret_key');
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      from: string;
      to: string[];
      subject: string;
      text: string;
      html: string;
    };
    assert.equal(body.from, 'ArtiFTP <noreply@artiftp.com>');
    assert.deepEqual(body.to, ['bryan@barterandbuild.com']);
    assert.equal(body.subject, 'Your ArtiFTP login link');
    assert.match(body.text, /token=abc/);
    assert.match(body.html, /Use this link/);
    assert.ok(!warnings.some((w) => w.includes('re_super_secret_key')));
    assert.ok(!warnings.some((w) => w.includes('RESEND_API_KEY=')));
  });

  it('redacts bearer tokens in Resend error diagnostics', async () => {
    process.env.RESEND_API_KEY = 're_super_secret_key';
    const warnings: string[] = [];
    await sendEmail(
      { to: 'owner@example.com', subject: 't', text: 't', html: '<p>t</p>' },
      {
        warn: (m) => warnings.push(m),
        fetch: async () =>
          new Response('unauthorized Bearer re_leaked_from_upstream', { status: 401 }),
      },
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /status=401/);
    assert.ok(!warnings[0]!.includes('re_leaked_from_upstream'));
    assert.ok(!warnings[0]!.includes('re_super_secret_key'));
    assert.match(warnings[0]!, /Bearer \[redacted\]/);
  });

  it('sendOwnerLoginLink / sendApproveAccessLink use the expected subjects', async () => {
    process.env.RESEND_API_KEY = 're_test';
    const subjects: string[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { subject: string };
      subjects.push(body.subject);
      return jsonResponse({ id: 'ok' });
    };
    await sendOwnerLoginLink('a@b.com', 'https://app.artiftp.com/auth/magic?token=x', { fetch: fakeFetch });
    await sendApproveAccessLink('a@b.com', 'https://app.artiftp.com/approve/y', { fetch: fakeFetch });
    assert.deepEqual(subjects, ['Your ArtiFTP login link', 'Approve ArtiFTP access request']);
  });
});

describe('logMailConfigOnStartup', () => {
  it('logs set|missing flags without the API key', () => {
    process.env.RESEND_API_KEY = 're_must_not_appear';
    process.env.EMAIL_FROM = 'noreply@artiftp.com';
    const lines: string[] = [];
    logMailConfigOnStartup((m) => lines.push(m));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /env_RESEND_API_KEY=set/);
    assert.match(lines[0]!, /from=noreply@artiftp.com/);
    assert.ok(!lines[0]!.includes('re_must_not_appear'));
  });

  it('warns when the key is missing', () => {
    delete process.env.RESEND_API_KEY;
    const lines: string[] = [];
    logMailConfigOnStartup((m) => lines.push(m));
    assert.match(lines[0]!, /env_RESEND_API_KEY=missing/);
    assert.match(lines[1]!, /WARNING: RESEND_API_KEY is missing/);
  });
});

describe('redactSecrets', () => {
  it('redacts Bearer tokens and re_ keys', () => {
    assert.equal(
      redactSecrets('Authorization: Bearer re_abc123 and RESEND_API_KEY=re_abc123'),
      'Authorization: Bearer [redacted] and RESEND_API_KEY=[redacted]',
    );
  });
});
