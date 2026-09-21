import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  encodeSealedBlob,
  initVault,
  isSealedBlob,
  needsCredentialReentry,
  openCredential,
  sealCredential,
  verifyRoundTrip,
  VaultError,
} from '../src/vault.js';

const SAVED_MASTER = process.env.ARTIFTP_MASTER_KEY;
const SAVED_NODE_ENV = process.env.NODE_ENV;
const SAVED_RAILWAY = process.env.RAILWAY_ENVIRONMENT;

function freshKey(): string {
  return crypto.randomBytes(32).toString('base64');
}

function restoreEnv(): void {
  if (SAVED_MASTER === undefined) delete process.env.ARTIFTP_MASTER_KEY;
  else process.env.ARTIFTP_MASTER_KEY = SAVED_MASTER;
  if (SAVED_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = SAVED_NODE_ENV;
  if (SAVED_RAILWAY === undefined) delete process.env.RAILWAY_ENVIRONMENT;
  else process.env.RAILWAY_ENVIRONMENT = SAVED_RAILWAY;
}

afterEach(restoreEnv);

describe('vault envelope', () => {
  it('round-trips a password and survives JSON/DB encoding', () => {
    process.env.ARTIFTP_MASTER_KEY = freshKey();
    initVault();
    const blob = sealCredential('s3cret-password');
    assert.equal(isSealedBlob(blob), true);
    assert.equal(openCredential(blob), 's3cret-password');
    assert.equal(JSON.stringify(blob).includes('s3cret-password'), false);
    const stored = encodeSealedBlob(blob);
    assert.equal(needsCredentialReentry(stored), false);
    assert.equal(openCredential(stored), 's3cret-password');
    assert.equal(openCredential(JSON.parse(stored)), 's3cret-password');
  });

  it('uses a fresh data key and nonce on every seal', () => {
    process.env.ARTIFTP_MASTER_KEY = freshKey();
    initVault();
    const a = sealCredential('same-plaintext');
    const b = sealCredential('same-plaintext');
    assert.notEqual(JSON.stringify(a), JSON.stringify(b));
    assert.notEqual(a.wk, b.wk);
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.wk_iv, b.wk_iv);
    assert.equal(openCredential(a), 'same-plaintext');
    assert.equal(openCredential(b), 'same-plaintext');
  });

  it('rejects tampered ciphertext and wrapped key', () => {
    process.env.ARTIFTP_MASTER_KEY = freshKey();
    initVault();
    const blob = sealCredential('integrity');
    const ct = Buffer.from(blob.ct, 'base64');
    ct[0] ^= 0xff;
    assert.throws(
      () => openCredential({ ...blob, ct: ct.toString('base64') }),
      VaultError,
    );
    const wk = Buffer.from(blob.wk, 'base64');
    wk[0] ^= 0xff;
    assert.throws(
      () => openCredential({ ...blob, wk: wk.toString('base64') }),
      VaultError,
    );
    const tag = Buffer.from(blob.tag, 'base64');
    tag[0] ^= 0xff;
    assert.throws(
      () => openCredential({ ...blob, tag: tag.toString('base64') }),
      VaultError,
    );
  });

  it('cannot decrypt under a different master key', () => {
    process.env.ARTIFTP_MASTER_KEY = freshKey();
    initVault();
    const blob = sealCredential('no-cross-key');
    process.env.ARTIFTP_MASTER_KEY = freshKey();
    initVault();
    assert.throws(() => openCredential(blob), VaultError);
  });

  it('detects legacy ARTIFTP_SECRET blobs and refuses to open them', () => {
    process.env.ARTIFTP_MASTER_KEY = freshKey();
    initVault();
    const legacy = 'YWJj:ZGVm:Z2hp'; // iv:tag:ciphertext
    assert.equal(needsCredentialReentry(legacy), true);
    assert.equal(isSealedBlob(legacy), false);
    try {
      openCredential(legacy);
      assert.fail('expected reentry error');
    } catch (e) {
      assert.equal((e as VaultError).code, 'credential_reentry_required');
    }
  });

  it('verifyRoundTrip passes with a valid master key', () => {
    process.env.ARTIFTP_MASTER_KEY = freshKey();
    initVault();
    verifyRoundTrip();
  });

  it('refuses to start without a master key in production', () => {
    delete process.env.ARTIFTP_MASTER_KEY;
    delete process.env.RAILWAY_ENVIRONMENT;
    process.env.NODE_ENV = 'production';
    assert.throws(() => initVault(), (err: unknown) => {
      assert.equal((err as VaultError).code, 'master_key_missing');
      return true;
    });
  });
});
