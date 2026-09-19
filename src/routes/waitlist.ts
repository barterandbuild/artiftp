import { Router, type Request, type Response } from 'express';
import { sendEmail, type SendEmailInput, type SendEmailResult } from '../mail.js';
import {
  buildWaitlistEmail,
  clientIpFromHeaders,
  createMemoryRateLimiter,
  isWaitlistAllowedOrigin,
  parseWaitlistBody,
  type MemoryRateLimiter,
} from '../waitlist.js';

export type WaitlistSendEmail = (
  input: SendEmailInput,
  opts?: { warn?: (msg: string) => void; fetch?: typeof fetch },
) => Promise<SendEmailResult>;

export type WaitlistRouterOpts = {
  sendEmail?: WaitlistSendEmail;
  rateLimiter?: MemoryRateLimiter;
};

function applyWaitlistCors(req: Request, res: Response): void {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (!isWaitlistAllowedOrigin(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export function createWaitlistRouter(opts: WaitlistRouterOpts = {}): Router {
  const doSend = opts.sendEmail ?? sendEmail;
  const limiter = opts.rateLimiter ?? createMemoryRateLimiter();
  const router = Router();

  router.options('/api/waitlist', (req, res) => {
    applyWaitlistCors(req, res);
    res.status(204).end();
  });

  router.post('/api/waitlist', async (req, res) => {
    applyWaitlistCors(req, res);

    const ip = clientIpFromHeaders(req.headers, req.socket.remoteAddress);
    if (!limiter.allow(ip)) {
      res.status(429).json({ error: 'Too many waitlist submissions. Try again later.' });
      return;
    }

    const parsed = parseWaitlistBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const mail = buildWaitlistEmail(parsed.signup);
    const result = await doSend(mail);
    if (!result.ok && result.reason === 'missing_api_key') {
      res.status(503).json({ error: 'Email is not configured (RESEND_API_KEY missing)' });
      return;
    }
    if (!result.ok) {
      res.status(502).json({ error: 'Failed to send waitlist email' });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}

export const waitlistRouter = createWaitlistRouter();
