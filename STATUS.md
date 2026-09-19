# ArtiFTP MVP — STATUS

**Date:** Sat Sep 19, 2026 (PT)  
**Location:** `/workspace/agentftp/` (local interim path intentionally retained; Origin cloud repo blocked until Bryan creates a namespace)  
**Brand/domain:** ArtiFTP · `artiftp.com` acquired 2026-09-17 · planned app URL `https://app.artiftp.com`

## What works

- **API server** (`npm run dev` / `npm start`) on `http://127.0.0.1:8787`
  - Owner magic-link auth (link printed to console; emailed via Resend on explicit UI/API request when `RESEND_API_KEY` is set; cookie session). Boot only prints — it does not email.
  - Sites CRUD with encrypted password (`ARTIFTP_SECRET`; legacy `AGENTFTP_SECRET` fallback supported)
  - Policy: `root_path`, `read` \| `read_write`, `max_ttl_sec`
  - Access requests + HTML approve/deny pages (`/approve/:token`); approve magic link emailed to the site owner
  - Sessions: opaque token, SHA-256 hash at rest, expiry, revoke / `end_session`
  - **Storage facade** (`src/fs/storage.ts`):
    - `host === mock.local` or `ARTIFTP_FORCE_MOCK=1` (legacy `AGENTFTP_FORCE_MOCK=1` also supported) → local mock jail under `data/mock-root/<siteId>/`
    - else **FTP/FTPS** via `basic-ftp` (port ≠ 22; tries explicit FTPS then plain FTP)
    - else **SFTP** via `ssh2-sftp-client` (port 22)
  - Path jail for local + remote POSIX paths (`..` / absolute rejected); jail root = site/session `root_path`
  - Audit log in SQLite
  - Tool endpoints: `list_sites`, `request_access`, `session_status`, `list_files`, `upload_file`, `download_file`, `end_session`
  - Owner: `GET /api/sites` includes `backend`; `GET /api/sites/:id/backend`; `POST /api/sites/:id/test` (connect + list root, no secrets logged)
- **MCP stub** at `mcp/index.ts` — stdio MCP calling the HTTP API
- **Owner UI** at `/ui/` — **fetch wired** to live owner routes (cookie magic-link auth); ink+emerald polish
- **Tests** — `npm test` (path-jail + Resend mail helper with mocked key)
- **Dogfood script** — `npm run dogfood` (API must be up)

## Resend (magic-link email)

Owner login (`createOwnerMagicLink`) and approve-access (`createApproveMagicLink`) still print the full URL to the server console. Boot calls `createOwnerMagicLink({ email: false })` so Railway restarts do not email. Explicit UI/API requests (`POST /auth/request-link`) keep the default `email: true`. When `RESEND_API_KEY` is set those requests (and approve-access links) POST to `https://api.resend.com/emails`.

| Var | Default | Notes |
|-----|---------|-------|
| `RESEND_API_KEY` | *(unset)* | Required to send. **Do not commit.** Missing → warning + console-only (local/dev safe) |
| `EMAIL_FROM` | `noreply@artiftp.com` | Also accepts `ArtiFTP <noreply@artiftp.com>` |
| `OWNER_EMAIL` | `hello@barterandbuild.com` | Login + approve recipients (or the owner email stored in DB) |

Verify the `artiftp.com` domain in the Resend dashboard so `noreply@artiftp.com` is allowed. On boot the process logs `email from=… env_RESEND_API_KEY=set|missing` (never the key).

```bash
# Optional live smoke (uses your key; do not paste the key into chat/logs)
curl -sS https://api.resend.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"from":"noreply@artiftp.com","to":["'"$OWNER_EMAIL"'"],"subject":"Your ArtiFTP login link","text":"https://app.artiftp.com/auth/magic?token=…"}'
```

Helper + mocked-key unit tests: `src/mail.ts`, `tests/mail.test.ts`.

## How Justice dogfoods

1. `cd /workspace/agentftp && npm install && npm run dev`
2. Other terminal: `npm run dogfood`  
   Or: create site in UI → `request_access` → open printed approve URL → Approve → use `session_token` from `session_status` → list/upload under site `root_path` → revoke → confirm upload fails.
3. Real host: set site host/port/user/password in Owner UI (never commit passwords). Confirm with `POST /api/sites/:id/test`. Approve a session, then `GET /tools/list_files` with Bearer token.
4. Optional: wire `npm run mcp` into Cursor once API is up.

## Health

`GET /health` → `{ ok, product: "ArtiFTP", backend: "mock"|"ftp"|"sftp" }`  
`backend` is `ftp`/`sftp` when any non-`mock.local` site exists (unless `ARTIFTP_FORCE_MOCK=1` or its legacy `AGENTFTP_FORCE_MOCK=1` alias).

## Blockers / follow-ups

- **Origin git:** no cloud namespace yet — stay on `/workspace/agentftp/`; this folder name and `data/agentftp.db` filename remain intentionally unchanged to avoid breaking the running server.
- GoDaddy may need FTPS vs plain FTP — client tries explicit FTPS first, then plain; self-signed TLS accepted for FTPS
- Push notifications / PWA — out of scope
- Do not commit real GoDaddy creds; passwords stay encrypted at rest (`cred_enc`)

## Verify

```bash
cd /workspace/agentftp && npm install && npm test && npm run dev
# then: npm run dogfood
# owner (cookie): POST /api/sites/:id/test
```

## UI ↔ API
See `UI-API-MAP.md` (Webby production screens mapped). Polished UI copied to `public/index.html`.


## Dogfood policy (Bryan 2026-09-17)
**Until revoke** — one magic-link Approve opens the write window; uploads until Revoke. Not tap-per-pack. `max_ttl_sec` / `until_revoke` maps to a long-lived session (revoke still ends it).
Jail root is whatever site `root_path` is configured (e.g. `/public_html`); do not force a samples-only subtree.
