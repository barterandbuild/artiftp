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

Set `ARTIFTP_SECRET` in Railway (encrypts site credential blobs). Optionally set `OWNER_EMAIL` and `BASE_URL` (magic-link host, e.g. your public Railway URL).

## Env

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `8787` | Listen port |
| `ARTIFTP_SECRET` | dev string | Encrypt site creds (`AGENTFTP_SECRET` is a legacy fallback) |
| `OWNER_EMAIL` | `bryan@barterandbuild.com` | Bootstrap owner |
| `BASE_URL` | `http://127.0.0.1:8787` | Magic-link host |
