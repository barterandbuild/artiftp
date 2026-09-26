# ArtiFTP

**ArtiFTP** lets a website owner grant AI agents short-lived, magic-link-approved access to a **jailed folder**. Agents never see the host password — only an opaque session token.

This MVP uses a mock filesystem backend. Health check: **`GET /health`**.

## Quick start

```bash
npm install
# Generate a local master key (never commit it)
export ARTIFTP_MASTER_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
npm start
```

The server binds **`0.0.0.0`** and **`process.env.PORT`** (default `8787`). Boot **requires** `ARTIFTP_MASTER_KEY` (no default). On boot it prints an owner magic link for ops backup (it does not email). Request a link from the Owner UI to email it when `RESEND_API_KEY` is set; then open **Owner UI** at `/ui/`.

| Script | What |
|--------|------|
| `npm start` | API + static owner UI |
| `npm run dev` | Same with watch |
| `npm test` | Path-jail + credential-vault unit tests |

## Railway

Deploy from this repo with the included `Dockerfile` and `railway.toml`:

- Builder: Dockerfile
- Healthcheck path: `/health`
- Listen address: `0.0.0.0` + Railway-injected `PORT`

Set **`ARTIFTP_MASTER_KEY`** in Railway (32-byte base64 master key for the credential vault). Without it the process **refuses to start** (`PORT` / `RAILWAY_ENVIRONMENT` are fail-closed). Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Never commit the key. After this vault deploy, **re-enter each site password** in Connect host (old `ARTIFTP_SECRET` blobs are invalid).

Set **`PUBLIC_BASE_URL=https://app.artiftp.com`** (or your public host) so magic/approve links printed to logs are clickable. `BASE_URL` is a legacy alias. On boot the process logs `public_base_url=… env_PUBLIC_BASE_URL=set|missing` so you can confirm the variable reached the container.

To email magic links and waitlist signups, set **`RESEND_API_KEY`** (Resend dashboard) and verify the `artiftp.com` domain so mail can come from `noreply@artiftp.com`. Optional **`EMAIL_FROM`** overrides the from address (`Name <email>` allowed). Without the API key the app still boots and prints links to the console; `POST /api/waitlist` returns `503` instead of pretending success.

Public landing form: `POST /api/waitlist` (`name`, `business` or `business_name`, `email`, `agent`, `sites` or `site_count`; `agent_other` when `agent` is Other; optional `host` / `host_type`) → emails `OWNER_EMAIL`. Not stored in SQLite.

## Env

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `8787` | Listen port (presence of `PORT` or `RAILWAY_ENVIRONMENT` = production-like vault requirement) |
| `ARTIFTP_MASTER_KEY` | *(required)* | 32-byte base64 vault master key. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Never commit.** Tests only: documented key in `tests/vault.test.ts` |
| `OWNER_EMAIL` | `hello@barterandbuild.com` | Bootstrap owner + waitlist / login / approve recipient |
| `RESEND_API_KEY` | *(unset)* | Resend API key; required to send mail. Missing → console-only |
| `EMAIL_FROM` | `noreply@artiftp.com` | From address (`Name <email>` allowed) |
| `PUBLIC_BASE_URL` | *(unset)* | Public origin for magic/approve links (read at request time) |
| `BASE_URL` | `http://127.0.0.1:8787` | Legacy alias if `PUBLIC_BASE_URL` is unset |
