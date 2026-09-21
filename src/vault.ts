import crypto from 'node:crypto';

/** AES-256-GCM envelope: per-site data key + master-wrapped key. */
export const VAULT_ALG = 'aes-256-gcm' as const;
export const VAULT_VERSION = 1 as const;

const GCM_IV_BYTES = 12;
const KEY_BYTES = 32;

export type SealedBlob = {
  v: typeof VAULT_VERSION;
  alg: typeof VAULT_ALG;
  wrap: typeof VAULT_ALG;
  wk_iv: string;
  wk_tag: string;
  wk: string;
  iv: string;
  tag: string;
  ct: string;
};

export class VaultError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 500) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
    this.status = status;
  }
}

let masterKey: Buffer | null = null;

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT);
}

function reentryError(): VaultError {
  return new VaultError(
    'credential_reentry_required',
    'Site password uses a retired encryption format. Re-enter it in the Owner UI.',
    409,
  );
}

function decodeMasterKey(raw: string): Buffer {
  const buf = Buffer.from(raw.trim(), 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new VaultError(
      'master_key_invalid',
      'ARTIFTP_MASTER_KEY must be base64 of exactly 32 random bytes',
      500,
    );
  }
  return buf;
}

function loadMasterKeyFromEnv(): Buffer {
  const raw = process.env.ARTIFTP_MASTER_KEY?.trim();
  if (!raw) {
    if (isProductionRuntime()) {
      throw new VaultError(
        'master_key_missing',
        'ARTIFTP_MASTER_KEY is required. Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
        500,
      );
    }
    const ephemeral = crypto.randomBytes(KEY_BYTES);
    console.warn(
      '[ArtiFTP] ARTIFTP_MASTER_KEY unset — using an ephemeral in-memory master key (dev only). Sealed credentials will not survive process restart.',
    );
    return ephemeral;
  }
  return decodeMasterKey(raw);
}

/** Load `ARTIFTP_MASTER_KEY`. Call once at process boot before sealing/opening. */
export function initVault(): void {
  masterKey = loadMasterKeyFromEnv();
}

function getMasterKey(): Buffer {
  if (!masterKey) {
    throw new VaultError('vault_not_init', 'initVault() must run at server boot', 500);
  }
  return masterKey;
}

function aesGcmEncrypt(key: Buffer, plaintext: Buffer): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv(VAULT_ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, tag, ct };
}

function aesGcmDecrypt(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): Buffer {
  const decipher = crypto.createDecipheriv(VAULT_ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function isB64(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isSealedBlob(value: unknown): value is SealedBlob {
  let candidate: unknown = value;
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith('{')) return false;
    try {
      candidate = JSON.parse(trimmed) as unknown;
    } catch {
      return false;
    }
  }
  if (!candidate || typeof candidate !== 'object') return false;
  const b = candidate as Record<string, unknown>;
  return (
    b.v === VAULT_VERSION &&
    b.alg === VAULT_ALG &&
    b.wrap === VAULT_ALG &&
    isB64(b.wk_iv) &&
    isB64(b.wk_tag) &&
    isB64(b.wk) &&
    isB64(b.iv) &&
    isB64(b.tag) &&
    isB64(b.ct)
  );
}

/** True when `cred_enc` is the retired `ARTIFTP_SECRET` `iv:tag:ciphertext` blob (or anything else non-envelope). */
export function needsCredentialReentry(raw: string | null | undefined): boolean {
  if (raw == null || typeof raw !== 'string' || raw.trim() === '') return true;
  return !isSealedBlob(raw);
}

export function encodeSealedBlob(blob: SealedBlob): string {
  return JSON.stringify(blob);
}

/**
 * Envelope-encrypt a site password.
 * Fresh random data key + GCM nonces on every call (same plaintext → different blobs).
 */
export function sealCredential(password: string): SealedBlob {
  if (typeof password !== 'string' || password.length === 0) {
    throw new VaultError('empty_password', 'password required', 400);
  }
  const dataKey = crypto.randomBytes(KEY_BYTES);
  try {
    const wrapped = aesGcmEncrypt(getMasterKey(), dataKey);
    const sealed = aesGcmEncrypt(dataKey, Buffer.from(password, 'utf8'));
    return {
      v: VAULT_VERSION,
      alg: VAULT_ALG,
      wrap: VAULT_ALG,
      wk_iv: wrapped.iv.toString('base64'),
      wk_tag: wrapped.tag.toString('base64'),
      wk: wrapped.ct.toString('base64'),
      iv: sealed.iv.toString('base64'),
      tag: sealed.tag.toString('base64'),
      ct: sealed.ct.toString('base64'),
    };
  } finally {
    dataKey.fill(0);
  }
}

function parseSealedBlob(blob: SealedBlob | string): SealedBlob {
  if (typeof blob === 'string') {
    if (needsCredentialReentry(blob)) throw reentryError();
    return JSON.parse(blob) as SealedBlob;
  }
  if (!isSealedBlob(blob)) throw reentryError();
  return blob;
}

/**
 * Unwrap the per-site data key and decrypt the password.
 *
 * Runtime rule: the HTTP app may only call this from `src/sessions.ts`
 * (approve-time `startApprovedSession` and live-session rehydrate).
 * Unit tests call it directly. Do not import from owner/agent routes.
 * Never log the return value.
 */
export function openCredential(blob: SealedBlob | string): string {
  const parsed = parseSealedBlob(blob);
  let dataKey: Buffer;
  try {
    dataKey = aesGcmDecrypt(
      getMasterKey(),
      Buffer.from(parsed.wk_iv, 'base64'),
      Buffer.from(parsed.wk_tag, 'base64'),
      Buffer.from(parsed.wk, 'base64'),
    );
  } catch {
    throw new VaultError('unwrap_failed', 'could not unwrap data key', 500);
  }
  try {
    const plain = aesGcmDecrypt(
      dataKey,
      Buffer.from(parsed.iv, 'base64'),
      Buffer.from(parsed.tag, 'base64'),
      Buffer.from(parsed.ct, 'base64'),
    );
    return plain.toString('utf8');
  } catch {
    throw new VaultError('decrypt_failed', 'tampered or invalid ciphertext', 500);
  } finally {
    dataKey.fill(0);
  }
}

function xorFirstByteB64(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) throw new Error('vault self-test: empty field');
  buf[0] = buf[0]! ^ 0xff;
  return buf.toString('base64');
}

/**
 * Boot self-test. Throws → caller must refuse to start.
 * Does not log plaintext.
 */
export function verifyRoundTrip(): void {
  const probe = 'vault-self-test-plaintext';
  const a = sealCredential(probe);
  const b = sealCredential(probe);
  if (JSON.stringify(a) === JSON.stringify(b)) {
    throw new Error('vault self-test: identical blobs (data key or nonce reused)');
  }
  if (a.wk === b.wk || a.iv === b.iv || a.wk_iv === b.wk_iv) {
    throw new Error('vault self-test: wrap/data nonce or key reused');
  }

  const fromDb = JSON.parse(JSON.stringify(a)) as SealedBlob;
  if (openCredential(fromDb) !== probe || openCredential(b) !== probe) {
    throw new Error('vault self-test: round-trip mismatch');
  }
  if (openCredential(JSON.stringify(a)) !== probe) {
    throw new Error('vault self-test: JSON string round-trip mismatch');
  }

  const tamperedCt: SealedBlob = { ...a, ct: xorFirstByteB64(a.ct) };
  let tamperRejected = false;
  try {
    openCredential(tamperedCt);
  } catch {
    tamperRejected = true;
  }
  if (!tamperRejected) {
    throw new Error('vault self-test: tampered ciphertext was accepted');
  }

  const previous = masterKey;
  masterKey = crypto.randomBytes(KEY_BYTES);
  let wrongKeyRejected = false;
  try {
    openCredential(a);
  } catch {
    wrongKeyRejected = true;
  } finally {
    masterKey = previous;
  }
  if (!wrongKeyRejected) {
    throw new Error('vault self-test: wrong master key decrypted ciphertext');
  }
}
