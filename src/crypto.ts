import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';

function secretKey(): Buffer {
  const raw = process.env.ARTIFTP_SECRET || process.env.AGENTFTP_SECRET || 'dev-change-me-to-a-long-random-string';
  return crypto.createHash('sha256').update(raw).digest();
}

/** Encrypt a UTF-8 string; returns base64 `iv:tag:ciphertext`. */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, secretKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(blob: string): string {
  const [ivB64, tagB64, dataB64] = blob.split(':');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('invalid ciphertext');
  const decipher = crypto.createDecipheriv(ALGO, secretKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
