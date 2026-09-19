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
  agent_other?: string;
  /** Normalized display value: `1-2` | `3-6` | `7+` | `unlimited` | a positive integer string. */
  sites: string;
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

function isOtherAgent(agent: string): boolean {
  return agent.toLowerCase() === 'other';
}

const SITES_ENUM: Record<string, string> = {
  '1-2': '1-2',
  '3-6': '3-6',
  '7+': '7+',
  unlimited: 'unlimited',
};

/** Accept enum-ish strings (`1-2`, `3-6`, `7+`, `unlimited`) or a positive integer. */
export function normalizeWaitlistSites(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 1) return null;
    return String(value);
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const canonical = SITES_ENUM[trimmed.toLowerCase()];
  if (canonical) return canonical;
  if (/^[1-9]\d*$/.test(trimmed)) return trimmed;
  return null;
}

function pickSitesRaw(raw: Record<string, unknown>): { present: boolean; value: unknown } {
  if (raw.sites !== undefined && raw.sites !== null && raw.sites !== '') {
    return { present: true, value: raw.sites };
  }
  if (raw.site_count !== undefined && raw.site_count !== null && raw.site_count !== '') {
    return { present: true, value: raw.site_count };
  }
  return { present: false, value: undefined };
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
  const agentOther = asTrimmedString(raw.agent_other);
  const host = asTrimmedString(raw.host) || asTrimmedString(raw.host_type);
  const sitesPick = pickSitesRaw(raw);

  if (!name) return { ok: false, error: 'name is required' };
  if (!business) return { ok: false, error: 'business is required' };
  if (!email) return { ok: false, error: 'email is required' };
  if (!BASIC_EMAIL.test(email)) return { ok: false, error: 'email is invalid' };
  if (!agent) return { ok: false, error: 'agent is required' };
  if (isOtherAgent(agent) && !agentOther) return { ok: false, error: 'agent_other is required' };
  if (!sitesPick.present) return { ok: false, error: 'sites is required' };
  const sites = normalizeWaitlistSites(sitesPick.value);
  if (!sites) return { ok: false, error: 'sites is invalid' };

  if (
    tooLong(name) ||
    tooLong(business) ||
    tooLong(email) ||
    tooLong(agent) ||
    tooLong(agentOther) ||
    tooLong(sites) ||
    tooLong(host)
  ) {
    return { ok: false, error: 'field too long' };
  }

  const signup: WaitlistSignup = { name, business, email, agent, sites };
  if (isOtherAgent(agent)) signup.agent_other = agentOther;
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
  if (signup.agent_other) lines.push(`Agent other: ${signup.agent_other}`);
  lines.push(`Sites: ${signup.sites}`);
  if (signup.host) lines.push(`Host: ${signup.host}`);
  const text = lines.join('\n');
  const htmlLines = [
    '<p>ArtiFTP waitlist signup</p>',
    `<p>Name: ${escapeHtml(signup.name)}</p>`,
    `<p>Business: ${escapeHtml(signup.business)}</p>`,
    `<p>Email: ${escapeHtml(signup.email)}</p>`,
    `<p>Agent: ${escapeHtml(signup.agent)}</p>`,
  ];
  if (signup.agent_other) htmlLines.push(`<p>Agent other: ${escapeHtml(signup.agent_other)}</p>`);
  htmlLines.push(`<p>Sites: ${escapeHtml(signup.sites)}</p>`);
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
