/**
 * Vault unit tests.
 *
 * Documented test-only master keys (32 bytes, base64). NEVER use these in
 * production or Railway. Production must set a unique ARTIFTP_MASTER_KEY
 * generated with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MASTER_KEY_ENV,
  bootCredentialVault,
  initVault,
  openCredential,
  openPersistedCredential,
  parseSealedCredential,
  persistSealedCredential,
  resetVaultForTests,
  sealCredential,
  verifyRoundTrip,
  type SealedCredential,
} from '../src/vault.js';

/** 32-byte test key A (0x11). Test-only. */
const TEST_KEY_A = Buffer.alloc(32, 0x11).toString('base64');
/** 32-byte test key B (0x22). Test-only. Different from A. */
const TEST_KEY_B = Buffer.alloc(32, 0x22).toString('base64');

const SAVED: Record<string, string | undefined> = {};

function saveEnv(): void {
  SAVED[MASTER_KEY_ENV] = process.env[MASTER_KEY_ENV];
  SAVED.PORT = process.env.PORT;
  SAVED.RAILWAY_ENVIRONMENT = process.env.RAILWAY_ENVIRONMENT;
}

function restoreEnv(): void {
  for (const key of [MASTER_KEY_ENV, 'PORT', 'RAILWAY_ENVIRONMENT'] as const) {
    const value = SAVED[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetVaultForTests();
}

beforeEach(() => {
  saveEnv();
  delete process.env.PORT;
  delete process.env.RAILWAY_ENVIRONMENT;
  resetVaultForTests();
});

afterEach(restoreEnv);

function withTestKey(key = TEST_KEY_A): void {
  process.env[MASTER_KEY_ENV] = key;
  initVault();
}

describe('vault seal/open', () => {
  it('round-trips a password', () => {
    withTestKey();
    const password = 'sftp-secret-do-not-log';
    const sealed = sealCredential(password);
    assert.equal(typeof sealed.wrappedKey, 'string');
    assert.equal(typeof sealed.nonce, 'string');
    assert.equal(typeof sealed.ciphertext, 'string');
    assert.equal(typeof sealed.authTag, 'string');
    assert.equal(openCredential(sealed), password);
  });

  it('persist + openPersistedCredential round-trips', () => {
    withTestKey();
    const json = persistSealedCredential('mock-password');
    const parsed = JSON.parse(json) as SealedCredential;
    assert.ok(parsed.wrappedKey && parsed.nonce && parsed.ciphertext && parsed.authTag);
    assert.equal(json.includes('mock-password'), false);
    assert.equal(openPersistedCredential(json), 'mock-password');
  });

  it('verifyRoundTrip succeeds after init', () => {
    withTestKey();
    assert.equal(verifyRoundTrip(), true);
  });

  it('throws if vault is not initialized', () => {
    resetVaultForTests();
    delete process.env[MASTER_KEY_ENV];
    assert.throws(() => sealCredential('x'), /not initialized/i);
  });

  it('rejects a missing master key', () => {
    delete process.env[MASTER_KEY_ENV];
    assert.throws(() => initVault(), /ARTIFTP_MASTER_KEY/);
  });

  it('rejects a master key that is not 32 bytes', () => {
    process.env[MASTER_KEY_ENV] = Buffer.alloc(16, 1).toString('base64');
    assert.throws(() => initVault(), /exactly 32 bytes/);
  });
});

describe('vault tamper reject', () => {
  it('rejects a tampered ciphertext', () => {
    withTestKey();
    const sealed = sealCredential('original');
    const buf = Buffer.from(sealed.ciphertext, 'base64');
    buf[0] ^= 0xff;
    const tampered = { ...sealed, ciphertext: buf.toString('base64') };
    assert.throws(() => openCredential(tampered));
  });

  it('rejects a tampered auth tag', () => {
    withTestKey();
    const sealed = sealCredential('original');
    const buf = Buffer.from(sealed.authTag, 'base64');
    buf[0] ^= 0xff;
    const tampered = { ...sealed, authTag: buf.toString('base64') };
    assert.throws(() => openCredential(tampered));
  });

  it('rejects a tampered wrapped key', () => {
    withTestKey();
    const sealed = sealCredential('original');
    const buf = Buffer.from(sealed.wrappedKey, 'base64');
    buf[20] ^= 0xff;
    const tampered = { ...sealed, wrappedKey: buf.toString('base64') };
    assert.throws(() => openCredential(tampered));
  });
});

describe('vault wrong master key', () => {
  it('rejects open after rotating to a different master key', () => {
    withTestKey(TEST_KEY_A);
    const sealed = sealCredential('original');
    process.env[MASTER_KEY_ENV] = TEST_KEY_B;
    initVault();
    assert.throws(() => openCredential(sealed));
  });
});

describe('vault legacy blob', () => {
  it('rejects old ARTIFTP_SECRET iv:tag:cipher blobs', () => {
    withTestKey();
    assert.throws(() => parseSealedCredential('aaaa:bbbb:cccc'), /re-enter the site password/i);
    assert.throws(() => parseSealedCredential('{"nope":true}'), /re-enter the site password/i);
  });
});

describe('bootCredentialVault', () => {
  it('fails closed when PORT is set and the master key is missing', () => {
    process.env.PORT = '8080';
    delete process.env[MASTER_KEY_ENV];
    assert.throws(() => bootCredentialVault(), /PORT or RAILWAY_ENVIRONMENT/);
  });

  it('fails closed when RAILWAY_ENVIRONMENT is set and the master key is missing', () => {
    process.env.RAILWAY_ENVIRONMENT = 'production';
    delete process.env[MASTER_KEY_ENV];
    assert.throws(() => bootCredentialVault(), /PORT or RAILWAY_ENVIRONMENT/);
  });

  it('fails without a default key in local/dev (no baked-in master key)', () => {
    delete process.env.PORT;
    delete process.env.RAILWAY_ENVIRONMENT;
    delete process.env[MASTER_KEY_ENV];
    assert.throws(() => bootCredentialVault(), /ARTIFTP_MASTER_KEY/);
  });

  it('starts after init + round-trip with a test-only key', () => {
    process.env[MASTER_KEY_ENV] = TEST_KEY_A;
    bootCredentialVault();
  });
});
