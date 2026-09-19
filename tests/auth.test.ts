import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerMagicLink, DEFAULT_OWNER_EMAIL, getOwnerEmail } from '../src/auth.js';
import { RESEND_API_URL } from '../src/mail.js';

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('getOwnerEmail', () => {
  it('defaults OWNER_EMAIL to hello@barterandbuild.com', () => {
    delete process.env.OWNER_EMAIL;
    assert.equal(getOwnerEmail(), DEFAULT_OWNER_EMAIL);
    assert.equal(getOwnerEmail(), 'hello@barterandbuild.com');
  });

  it('trims OWNER_EMAIL and treats blank as the default', () => {
    process.env.OWNER_EMAIL = '  owner@example.com  ';
    assert.equal(getOwnerEmail(), 'owner@example.com');
    process.env.OWNER_EMAIL = '   ';
    assert.equal(getOwnerEmail(), DEFAULT_OWNER_EMAIL);
  });
});

describe('createOwnerMagicLink email option', () => {
  it('does not call Resend when email: false (boot path)', async () => {
    process.env.RESEND_API_KEY = 're_must_not_be_used';
    process.env.OWNER_EMAIL = 'hello@barterandbuild.com';
    const origFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return jsonResponse({ id: 'should-not-send' });
    }) as typeof fetch;
    try {
      const link = createOwnerMagicLink({ email: false });
      assert.match(link.url, /\/auth\/magic\?token=/);
      assert.ok(link.token.length > 0);
      const emailed = await link.emailed;
      assert.equal(emailed.ok, false);
      if (!emailed.ok) assert.equal(emailed.reason, 'skipped');
      assert.equal(fetched, false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('emails via Resend when requested (default / UI path)', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.OWNER_EMAIL = 'hello@barterandbuild.com';
    const origFetch = globalThis.fetch;
    const calls: Array<{ url: string; body: { to?: string[]; subject?: string } }> = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as { to?: string[]; subject?: string },
      });
      return jsonResponse({ id: 'email_ui' });
    }) as typeof fetch;
    try {
      const link = createOwnerMagicLink();
      const emailed = await link.emailed;
      assert.deepEqual(emailed, { ok: true, id: 'email_ui' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url, RESEND_API_URL);
      assert.deepEqual(calls[0]!.body.to, ['hello@barterandbuild.com']);
      assert.equal(calls[0]!.body.subject, 'Your ArtiFTP login link');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
