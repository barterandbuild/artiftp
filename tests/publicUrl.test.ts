import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_DEV_BASE_URL,
  getBaseUrl,
  getPublicBaseUrl,
  isProductionish,
  logPublicBaseUrlOnStartup,
  redactBaseUrlForLog,
} from '../src/publicUrl.js';

const SAVED = {
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  BASE_URL: process.env.BASE_URL,
  PORT: process.env.PORT,
  RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearUrlEnv(): void {
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.BASE_URL;
  delete process.env.PORT;
  delete process.env.RAILWAY_ENVIRONMENT;
}

afterEach(restoreEnv);

describe('getPublicBaseUrl', () => {
  it('falls back to local dev when both env vars are missing', () => {
    clearUrlEnv();
    assert.equal(getPublicBaseUrl(), LOCAL_DEV_BASE_URL);
    assert.equal(getBaseUrl(), LOCAL_DEV_BASE_URL);
  });

  it('prefers PUBLIC_BASE_URL over BASE_URL', () => {
    clearUrlEnv();
    process.env.BASE_URL = 'http://127.0.0.1:8787';
    process.env.PUBLIC_BASE_URL = 'https://app.artiftp.com';
    assert.equal(getPublicBaseUrl(), 'https://app.artiftp.com');
  });

  it('uses BASE_URL when PUBLIC_BASE_URL is missing', () => {
    clearUrlEnv();
    process.env.BASE_URL = 'https://example.up.railway.app';
    assert.equal(getPublicBaseUrl(), 'https://example.up.railway.app');
  });

  it('treats blank PUBLIC_BASE_URL as missing', () => {
    clearUrlEnv();
    process.env.PUBLIC_BASE_URL = '   ';
    process.env.BASE_URL = 'https://from-base.example';
    assert.equal(getPublicBaseUrl(), 'https://from-base.example');
  });

  it('trims whitespace, wrapping quotes, and trailing slashes', () => {
    clearUrlEnv();
    process.env.PUBLIC_BASE_URL = '  "https://app.artiftp.com/"  ';
    assert.equal(getPublicBaseUrl(), 'https://app.artiftp.com');
  });

  it('reads env on every call (not module-load snapshot)', () => {
    clearUrlEnv();
    assert.equal(getPublicBaseUrl(), LOCAL_DEV_BASE_URL);
    process.env.PUBLIC_BASE_URL = 'https://app.artiftp.com';
    assert.equal(getPublicBaseUrl(), 'https://app.artiftp.com');
    process.env.PUBLIC_BASE_URL = 'https://other.example';
    assert.equal(getPublicBaseUrl(), 'https://other.example');
    delete process.env.PUBLIC_BASE_URL;
    assert.equal(getPublicBaseUrl(), LOCAL_DEV_BASE_URL);
  });
});

describe('logPublicBaseUrlOnStartup', () => {
  it('logs resolved url and set|missing flags without secrets', () => {
    clearUrlEnv();
    process.env.PUBLIC_BASE_URL = 'https://app.artiftp.com/?token=super-secret';
    const lines: string[] = [];
    logPublicBaseUrlOnStartup((msg) => lines.push(msg));
    assert.equal(lines.length, 1);
    assert.equal(
      lines[0],
      '[ArtiFTP] public_base_url=https://app.artiftp.com env_PUBLIC_BASE_URL=set env_BASE_URL=missing',
    );
    assert.ok(!lines.some((l) => l.includes('super-secret')));
  });

  it('warns loudly when PUBLIC_BASE_URL is missing in production-like env', () => {
    clearUrlEnv();
    process.env.PORT = '8080';
    const lines: string[] = [];
    logPublicBaseUrlOnStartup((msg) => lines.push(msg));
    assert.match(lines[0]!, /public_base_url=http:\/\/127\.0\.0\.1:8787/);
    assert.match(lines[0]!, /env_PUBLIC_BASE_URL=missing/);
    assert.match(lines[1]!, /WARNING: PUBLIC_BASE_URL is missing/);
    assert.match(lines[1]!, /127\.0\.0\.1:8787/);
  });

  it('does not warn for local dev without PORT or RAILWAY_ENVIRONMENT', () => {
    clearUrlEnv();
    const lines: string[] = [];
    logPublicBaseUrlOnStartup((msg) => lines.push(msg));
    assert.equal(lines.length, 1);
    assert.ok(!lines[0]!.includes('WARNING'));
    assert.equal(isProductionish(), false);
  });

  it('does not warn when BASE_URL is a public origin even if PUBLIC_BASE_URL is missing', () => {
    clearUrlEnv();
    process.env.PORT = '8080';
    process.env.BASE_URL = 'https://app.artiftp.com';
    const lines: string[] = [];
    logPublicBaseUrlOnStartup((msg) => lines.push(msg));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /public_base_url=https:\/\/app\.artiftp\.com/);
    assert.match(lines[0]!, /env_PUBLIC_BASE_URL=missing env_BASE_URL=set/);
  });
});

describe('redactBaseUrlForLog', () => {
  it('strips userinfo, query, and hash', () => {
    assert.equal(
      redactBaseUrlForLog('https://user:pass@app.artiftp.com/path?token=abc#frag'),
      'https://app.artiftp.com/path',
    );
  });
});
