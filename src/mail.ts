/**
 * Transactional mail via the Resend HTTP API.
 *
 * Env:
 *   RESEND_API_KEY  required to actually send (missing → warn, do not crash)
 *   EMAIL_FROM      default `noreply@artiftp.com` (also accepts `Name <email>`)
 *
 * Smoke (key mocked — never commit a real key):
 *   See tests/mail.test.ts, or:
 *   curl -sS https://api.resend.com/emails \
 *     -H "Authorization: Bearer $RESEND_API_KEY" \
 *     -H "Content-Type: application/json" \
 *     -d '{"from":"noreply@artiftp.com","to":["you@example.com"],"subject":"Your ArtiFTP login link","text":"https://…"}'
 */

export const RESEND_API_URL = 'https://api.resend.com/emails';
export const DEFAULT_EMAIL_FROM = 'noreply@artiftp.com';

export type MailLog = (msg: string) => void;

export type SendEmailInput = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export type SendEmailResult =
  | { ok: true; id: string | null }
  | {
      ok: false;
      reason: 'missing_api_key' | 'invalid_to' | 'http_error' | 'network_error';
      status?: number;
    };

function envFlag(name: string): 'set' | 'missing' {
  const raw = process.env[name];
  return raw != null && raw.trim() !== '' ? 'set' : 'missing';
}

/** Read at call time so Railway/dashboard vars are never captured at import. */
export function getResendApiKey(): string | undefined {
  const raw = process.env.RESEND_API_KEY;
  if (raw == null) return undefined;
  const value = raw.trim();
  return value || undefined;
}

export function isMailConfigured(): boolean {
  return Boolean(getResendApiKey());
}

export function getEmailFrom(): string {
  const raw = process.env.EMAIL_FROM;
  if (raw == null) return DEFAULT_EMAIL_FROM;
  const value = raw.trim();
  return value || DEFAULT_EMAIL_FROM;
}

/**
 * Strip API keys / bearer tokens from diagnostic strings.
 * Do not use this on the console magic-link line — that URL stays full.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bre_[A-Za-z0-9]+\b/g, 're_[redacted]')
    .replace(/RESEND_API_KEY\s*[=:]\s*\S+/gi, 'RESEND_API_KEY=[redacted]');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function buildOwnerLoginEmail(
  url: string,
  expiresMinutes = 15,
): { subject: string; text: string; html: string } {
  const expiry =
    expiresMinutes === 1 ? 'This link expires in 1 minute.' : `This link expires in ${expiresMinutes} minutes.`;
  return {
    subject: 'Your ArtiFTP login link',
    text: `Use this link to sign in to ArtiFTP:\n\n${url}\n\n${expiry}`,
    html: `<p>Use this link to sign in to ArtiFTP:</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p><p>${escapeHtml(expiry)}</p>`,
  };
}

export function buildApproveAccessEmail(
  url: string,
  expiresMinutes = 60,
): { subject: string; text: string; html: string } {
  const expiry =
    expiresMinutes === 60 ? 'This link expires in 1 hour.' : `This link expires in ${expiresMinutes} minutes.`;
  return {
    subject: 'Approve ArtiFTP access request',
    text: `An agent requested access. Approve or deny here:\n\n${url}\n\n${expiry}`,
    html: `<p>An agent requested access. Approve or deny here:</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p><p>${escapeHtml(expiry)}</p>`,
  };
}

export function logMailConfigOnStartup(log: MailLog = console.log): void {
  log(
    `[ArtiFTP] email from=${getEmailFrom()} env_RESEND_API_KEY=${envFlag('RESEND_API_KEY')} env_EMAIL_FROM=${envFlag('EMAIL_FROM')}`,
  );
  if (envFlag('RESEND_API_KEY') === 'missing') {
    log(
      '[ArtiFTP] WARNING: RESEND_API_KEY is missing — magic links will be printed to the console only (email not sent).',
    );
  }
}

export async function sendEmail(
  input: SendEmailInput,
  opts: { warn?: MailLog; fetch?: typeof fetch } = {},
): Promise<SendEmailResult> {
  const warn = opts.warn ?? console.warn;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const apiKey = getResendApiKey();
  if (!apiKey) {
    warn(
      '[ArtiFTP] WARNING: RESEND_API_KEY is missing — email not sent. Magic link is printed to the console.',
    );
    return { ok: false, reason: 'missing_api_key' };
  }

  const to = input.to.trim();
  if (!to || !to.includes('@')) {
    warn('[ArtiFTP] WARNING: invalid email recipient — email not sent.');
    return { ok: false, reason: 'invalid_to' };
  }

  try {
    const res = await doFetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: getEmailFrom(),
        to: [to],
        subject: input.subject,
        text: input.text,
        html: input.html,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      warn(`[ArtiFTP] Resend send failed: status=${res.status} ${redactSecrets(body).slice(0, 200)}`);
      return { ok: false, reason: 'http_error', status: res.status };
    }

    const json = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: typeof json.id === 'string' ? json.id : null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`[ArtiFTP] Resend send failed: ${redactSecrets(msg)}`);
    return { ok: false, reason: 'network_error' };
  }
}

export async function sendOwnerLoginLink(
  to: string,
  url: string,
  opts?: { warn?: MailLog; fetch?: typeof fetch },
): Promise<SendEmailResult> {
  return sendEmail({ to, ...buildOwnerLoginEmail(url) }, opts);
}

export async function sendApproveAccessLink(
  to: string,
  url: string,
  opts?: { warn?: MailLog; fetch?: typeof fetch },
): Promise<SendEmailResult> {
  return sendEmail({ to, ...buildApproveAccessEmail(url) }, opts);
}
