# ArtiFTP

**ArtiFTP** lets a website owner grant AI agents short-lived, magic-link-approved access to a **jailed folder**. Agents never see the host password — only an opaque session token.

This MVP uses a mock filesystem backend. Health check: **`GET /health`**.

## Quick start

```bash
npm install
npm start
```

The server binds **`0.0.0.0`** and **`process.env.PORT`** (default `8787`). On boot it prints an owner magic link for ops backup (it does not email). Request a link from the Owner UI to email it when `RESEND_API_KEY` is set; then open **Owner UI** at `/ui/`.

| Script | What |
|--------|------|
| `npm start` | API + static owner UI |
| `npm run dev` | Same with watch |
| `npm test` | Vault, path-jail, session handoff, mail, waitlist unit tests |

## Railway

Deploy from this repo with the included `Dockerfile` and `railway.toml`:

- Builder: Dockerfile
- Healthcheck path: `/health`
- Listen address: `0.0.0.0` + Railway-injected `PORT`

Set **`ARTIFTP_MASTER_KEY`** in Railway (envelope-encrypts site passwords at rest). Generate with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Do not commit this value. After this encryption upgrade, **re-enter every site password** in the Owner UI — blobs sealed with the old `ARTIFTP_SECRET` single-key `encrypt()` are rejected (`needs_password_reentry` / `credential_reentry_required`) rather than decrypted forever.

Set **`PUBLIC_BASE_URL=https://app.artiftp.com`** (or your public host) so magic/approve links printed to logs are clickable. `BASE_URL` is a legacy alias. On boot the process logs `public_base_url=… env_PUBLIC_BASE_URL=set|missing` so you can confirm the variable reached the container.

To email magic links and waitlist signups, set **`RESEND_API_KEY`** (Resend dashboard) and verify the `artiftp.com` domain so mail can come from `noreply@artiftp.com`. Optional **`EMAIL_FROM`** overrides the from address (`Name <email>` allowed). Without the API key the app still boots and prints links to the console; `POST /api/waitlist` returns `503` instead of pretending success.

Public landing form: `POST /api/waitlist` (`name`, `business` or `business_name`, `email`, `agent`, `sites` or `site_count`; `agent_other` when `agent` is Other; optional `host` / `host_type`) → emails `OWNER_EMAIL`. Not stored in SQLite.

## Env

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `8787` | Listen port |
| `ARTIFTP_MASTER_KEY` | *(required in production)* | Base64 of 32 random bytes; wraps per-site data keys (`AGENTFTP_*` aliases do **not** apply) |
| `ARTIFTP_SECRET` | *(retired)* | Old single-key encrypt; no longer read. Re-enter site passwords |
| `OWNER_EMAIL` | `hello@barterandbuild.com` | Bootstrap owner + waitlist / login / approve recipient |
| `RESEND_API_KEY` | *(unset)* | Resend API key; required to send mail. Missing → console-only |
| `EMAIL_FROM` | `noreply@artiftp.com` | From address (`Name <email>` allowed) |
| `PUBLIC_BASE_URL` | *(unset)* | Public origin for magic/approve links (read at request time) |
| `BASE_URL` | `http://127.0.0.1:8787` | Legacy alias if `PUBLIC_BASE_URL` is unset |

## Credential migration

Site passwords use **per-site envelope encryption** (AES-256-GCM data key wrapped with `ARTIFTP_MASTER_KEY`). The DB stores only JSON ciphertext in `sites.cred_enc`.

Existing sites sealed with the old `ARTIFTP_SECRET` single-key `encrypt()` **must re-enter credentials**. The API sets `needs_password_reentry` on `GET /api/sites` and refuses Approve / connect with `credential_reentry_required` rather than silently decrypting the old format.

Ops (Railway): set `ARTIFTP_MASTER_KEY` (do not commit it), deploy, then edit each site in the Owner UI and save the SFTP password again. Old `ARTIFTP_SECRET` can be removed after that.
