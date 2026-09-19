/**
 * Public landing-page waitlist signup (email-only; not persisted).
 *
 * Landing form at artiftp.com POSTs JSON to /api/waitlist.
 * v1 emails hello@ (or OWNER_EMAIL) via Resend — Railway disk is ephemeral,
 * so we do not write waitlist rows to SQLite.
 */

import type { SendEmailInput } from './mail.js';

export const DEFAULT_WAITLIST_OWNER_EMAIL = 'hello@barterandbuild.com';

export const WAITLIST_ALLOWED_ORIGINS = [
  'https://artiftp.com',
  'https://www.artiftp.com',
] as const;

const BASIC_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FIELD = 500;

export type WaitlistSignup = {
  name: string;
  business: string;
  email: string;
  agent: string;
  host?: string;
};

export type ParseWaitlistResult =
  | { ok: true; signup: WaitlistSignup }
  | { ok: false; error: string };

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function tooLong(value: string): boolean {
  return value.length > MAX_FIELD;
}

export function parseWaitlistBody(body: unknown): ParseWaitlistResult {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'JSON object body required' };
  }
  const raw = body as Record<string, unknown>;

  const name = asTrimmedString(raw.name);
  const business = asTrimmedString(raw.business) || asTrimmedString(raw.business_name);
  const email = asTrimmedString(raw.email);
  const agent = asTrimmedString(raw.agent);
  const host = asTrimmedString(raw.host) || asTrimmedString(raw.host_type);

  if (!name) return { ok: false, error: 'name is required' };
  if (!business) return { ok: false, error: 'business is required' };
  if (!email) return { ok: false, error: 'email is required' };
  if (!BASIC_EMAIL.test(email)) return { ok: false, error: 'email is invalid' };
  if (!agent) return { ok: false, error: 'agent is required' };

  if (tooLong(name) || tooLong(business) || tooLong(email) || tooLong(agent) || tooLong(host)) {
    return { ok: false, error: 'field too long' };
  }

  const signup: WaitlistSignup = { name, business, email, agent };
  if (host) signup.host = host;
  return { ok: true, signup };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function buildWaitlistEmail(signup: WaitlistSignup): SendEmailInput {
  const lines = [
    'ArtiFTP waitlist signup',
    '',
    `Name: ${signup.name}`,
    `Business: ${signup.business}`,
    `Email: ${signup.email}`,
    `Agent: ${signup.agent}`,
  ];
  if (signup.host) lines.push(`Host: ${signup.host}`);
  const text = lines.join('\n');
  const htmlLines = [
    '<p>ArtiFTP waitlist signup</p>',
    `<p>Name: ${escapeHtml(signup.name)}</p>`,
    `<p>Business: ${escapeHtml(signup.business)}</p>`,
    `<p>Email: ${escapeHtml(signup.email)}</p>`,
    `<p>Agent: ${escapeHtml(signup.agent)}</p>`,
  ];
  if (signup.host) htmlLines.push(`<p>Host: ${escapeHtml(signup.host)}</p>`);
  return {
    to: getWaitlistRecipient(),
    subject: `ArtiFTP waitlist: ${signup.name} / ${signup.business}`,
    text,
    html: htmlLines.join(''),
  };
}

/** Read at call time so Railway/dashboard vars are never captured at import. */
export function getWaitlistRecipient(): string {
  const raw = process.env.OWNER_EMAIL;
  if (raw == null) return DEFAULT_WAITLIST_OWNER_EMAIL;
  const value = raw.trim();
  return value || DEFAULT_WAITLIST_OWNER_EMAIL;
}

export function isWaitlistAllowedOrigin(origin: string | undefined | null): boolean {
  if (!origin) return false;
  if ((WAITLIST_ALLOWED_ORIGINS as readonly string[]).includes(origin)) return true;
  try {
    const url = new URL(origin);
    const local =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    return local && (url.protocol === 'http:' || url.protocol === 'https:');
  } catch {
    return false;
  }
}

export type MemoryRateLimiter = {
  allow: (key: string, now?: number) => boolean;
  reset: () => void;
};

export function createMemoryRateLimiter(opts?: {
  windowMs?: number;
  max?: number;
}): MemoryRateLimiter {
  const windowMs = opts?.windowMs ?? 15 * 60 * 1000;
  const max = opts?.max ?? 8;
  const hits = new Map<string, number[]>();
  return {
    allow(key: string, now = Date.now()): boolean {
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
    reset() {
      hits.clear();
    },
  };
}

export function clientIpFromHeaders(
  headers: { [key: string]: string | string[] | undefined },
  remoteAddress?: string,
): string {
  const xf = headers['x-forwarded-for'];
  const first = Array.isArray(xf) ? xf[0] : xf;
  if (typeof first === 'string' && first.trim()) {
    return first.split(',')[0]!.trim();
  }
  return remoteAddress?.trim() || 'unknown';
}
