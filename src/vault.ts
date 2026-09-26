/**
 * ArtiFTP credential vault — envelope encryption for stored FTP/SFTP passwords.
 *
 * Model:
 *   - Master key lives ONLY in env (ARTIFTP_MASTER_KEY, 32 bytes base64). Never commit it.
 *   - Each site gets a random 32-byte data key; the password is encrypted with the
 *     data key; the data key is wrapped with the master key.
 *   - DB stores only ciphertext blobs (JSON SealedCredential). A DB leak yields noise
 *     without the env var.
 *   - openCredential() / openPersistedCredential() are called ONLY immediately before
 *     an FTP/SFTP handshake (remoteBackend connect path). Never in request handlers,
 *     never in logging paths, never in anything returned to an agent or owner API.
 */

import crypto from 'node:crypto';

export const MASTER_KEY_ENV = 'ARTIFTP_MASTER_KEY';

/** Generate a 32-byte master key (base64). Never commit the output. */
export const GENERATE_MASTER_KEY_CMD =
  'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"';

let masterKey: Buffer | null = null;

export function isProductionLikeEnv(): boolean {
  return Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.PORT);
}

function missingKeyError(): Error {
  return new Error(
    `Vault init failed: set ${MASTER_KEY_ENV} to a 32-byte base64 value. ` +
      `Generate one with: ${GENERATE_MASTER_KEY_CMD}`,
  );
}

/** Call once at app boot (e.g. server entrypoint). Throws fast if env is missing. Re-readable for tests. */
export function initVault(): void {
  const raw = process.env[MASTER_KEY_ENV];
  if (!raw) {
    throw missingKeyError();
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`Vault init failed: ${MASTER_KEY_ENV} must decode to exactly 32 bytes (base64).`);
  }
  masterKey = key;
}

/** Test-only: drop the in-memory master key. Do not call from production paths. */
export function resetVaultForTests(): void {
  masterKey = null;
}

function ensureInit(): Buffer {
  if (!masterKey) throw new Error('Vault not initialized. Call initVault() at boot.');
  return masterKey;
}

/** Shape persisted in the DB for each site (`cred_enc` column). All fields base64 strings. */
export interface SealedCredential {
  wrappedKey: string; // [12B wrap-nonce | wrapped data key | 16B GCM tag]
  nonce: string; // 12B IV used for the password encryption
  ciphertext: string;
  authTag: string; // 16B GCM tag for the password encryption
}

function isSealedCredential(value: unknown): value is SealedCredential {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return [o.wrappedKey, o.nonce, o.ciphertext, o.authTag].every(
    (v) => typeof v === 'string' && v.length > 0,
  );
}

const LEGACY_BLOB_MSG =
  'Invalid sealed credential — re-enter the site password (legacy blobs cannot be migrated).';

/** Parse a persisted sealed JSON blob. Never include blob contents in the error. */
export function parseSealedCredential(raw: string): SealedCredential {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(LEGACY_BLOB_MSG);
  }
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) {
    throw new Error(LEGACY_BLOB_MSG);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(LEGACY_BLOB_MSG);
  }
  if (!isSealedCredential(parsed)) {
    throw new Error(LEGACY_BLOB_MSG);
  }
  return parsed;
}

/** Encrypt a raw FTP/SFTP password. Store the result; discard everything else. */
export function sealCredential(password: string): SealedCredential {
  const master = ensureInit();

  // 1. encrypt the password with a fresh per-site data key
  const dataKey = crypto.randomBytes(32);
  const pwNonce = crypto.randomBytes(12);
  const pwCipher = crypto.createCipheriv('aes-256-gcm', dataKey, pwNonce);
  const ciphertext = Buffer.concat([pwCipher.update(password, 'utf8'), pwCipher.final()]);
  const authTag = pwCipher.getAuthTag();

  // 2. wrap the data key with the master key (fresh nonce per seal)
  const wrapNonce = crypto.randomBytes(12);
  const wrapCipher = crypto.createCipheriv('aes-256-gcm', master, wrapNonce);
  const wrappedKey = Buffer.concat([
    wrapNonce,
    wrapCipher.update(dataKey),
    wrapCipher.final(),
    wrapCipher.getAuthTag(),
  ]);

  // 3. zero the data key buffer; it lives only inside wrappedKey ciphertext now
  dataKey.fill(0);

  return {
    wrappedKey: wrappedKey.toString('base64'),
    nonce: pwNonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/** Seal a password and serialize for the `cred_enc` column. */
export function persistSealedCredential(password: string): string {
  return JSON.stringify(sealCredential(password));
}

/**
 * Decrypt a sealed credential. Call this ONLY immediately before opening the
 * FTP/SFTP connection, never in request handlers, never in logging paths,
 * never in anything that returns to an agent or owner API.
 */
export function openCredential(sealed: SealedCredential): string {
  const master = ensureInit();

  // 1. unwrap the data key
  const blob = Buffer.from(sealed.wrappedKey, 'base64');
  if (blob.length < 44) throw new Error('Corrupt wrapped key.');
  const wrapNonce = blob.subarray(0, 12);
  const wrappedBody = blob.subarray(12, blob.length - 16);
  const wrapTag = blob.subarray(blob.length - 16);
  const unwrap = crypto.createDecipheriv('aes-256-gcm', master, wrapNonce);
  unwrap.setAuthTag(wrapTag);
  const dataKey = Buffer.concat([unwrap.update(wrappedBody), unwrap.final()]);

  // 2. decrypt the password
  const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, Buffer.from(sealed.nonce, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');

  dataKey.fill(0);
  return plain;
}

/**
 * Open a persisted `cred_enc` JSON blob. Call only immediately before FTP/SFTP connect.
 */
export function openPersistedCredential(credEncJson: string): string {
  return openCredential(parseSealedCredential(credEncJson));
}

/** Sanity check for a boot-time self-test: seal, open, compare. Throws on failure. */
export function verifyRoundTrip(): boolean {
  const probe = 'vault-self-test-' + crypto.randomBytes(8).toString('hex');
  const opened = openCredential(sealCredential(probe));
  if (opened !== probe) {
    throw new Error('Vault self-test failed: round-trip mismatch.');
  }
  return true;
}

/**
 * Initialize the vault and run a round-trip self-test.
 * Production-like env (PORT or RAILWAY_ENVIRONMENT set) is fail-closed.
 * Local/dev also requires a generated key — there is no baked-in default.
 * Tests may set a documented test-only key; never ship that key to Railway.
 */
export function bootCredentialVault(): void {
  const productionLike = isProductionLikeEnv();
  try {
    initVault();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (productionLike) {
      throw new Error(
        `Refusing to start: ${MASTER_KEY_ENV} is required when PORT or RAILWAY_ENVIRONMENT is set. ${msg}`,
      );
    }
    throw new Error(
      `${msg} Local/dev also requires a generated ${MASTER_KEY_ENV} (never commit it). ` +
        `Tests may inject a documented test-only key; production must not.`,
    );
  }
  try {
    if (!verifyRoundTrip()) {
      throw new Error('Vault self-test failed: round-trip mismatch.');
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Vault self-test failed; refusing to start. ${msg}`);
  }
}
