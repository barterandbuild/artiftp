# ArtiFTP

**ArtiFTP** lets a website owner grant AI agents short-lived, magic-link-approved access to a **jailed folder**. Agents never see the host password — only an opaque session token.

This MVP uses a mock filesystem backend. Health check: **`GET /health`**.

## Quick start

```bash
npm install
npm start
```

The server binds **`0.0.0.0`** and **`process.env.PORT`** (default `8787`). On boot it prints an owner magic link; then open **Owner UI** at `/ui/`.

| Script | What |
|--------|------|
| `npm start` | API + static owner UI |
| `npm run dev` | Same with watch |
| `npm test` | Path-jail unit tests |

## Railway

Deploy from this repo with the included `Dockerfile` and `railway.toml`:

- Builder: Dockerfile
- Healthcheck path: `/health`
- Listen address: `0.0.0.0` + Railway-injected `PORT`

Set `ARTIFTP_SECRET` in Railway (encrypts site credential blobs). Set **`PUBLIC_BASE_URL=https://app.artiftp.com`** (or your public host) so magic/approve links printed to logs are clickable. `BASE_URL` is a legacy alias. On boot the process logs `public_base_url=… env_PUBLIC_BASE_URL=set|missing` so you can confirm the variable reached the container.

## Env

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `8787` | Listen port |
| `ARTIFTP_SECRET` | dev string | Encrypt site creds (`AGENTFTP_SECRET` is a legacy fallback) |
| `OWNER_EMAIL` | `bryan@barterandbuild.com` | Bootstrap owner |
| `PUBLIC_BASE_URL` | *(unset)* | Public origin for magic/approve links (read at request time) |
| `BASE_URL` | `http://127.0.0.1:8787` | Legacy alias if `PUBLIC_BASE_URL` is unset |
