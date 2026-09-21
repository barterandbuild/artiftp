# ArtiFTP — UI screen ↔ API route map
**Date:** Thu Sep 17, 2026 (PT)  
**UI:** Webby production polish (`/workspace/agentftp-ui/` → served at `/ui/`)  
**API:** `/workspace/agentftp/`

## Screen map

| UI screen | Owner actions | API routes |
|-----------|---------------|------------|
| **Sites** | List connected hosts + pending/live badges + `backend` | `GET /api/sites` · `GET /api/requests` · `GET /api/sessions` |
| **Connect host** | Add FTP/SFTP host (mock password OK for dogfood) | `POST /api/sites` `{ slug, display_name, host, port, username, password, root_path, mode, max_ttl_sec }` |
| **Policy** | Type-to-add root, R/O vs R/W, TTL | `PATCH /api/sites/:id` `{ root_path, mode, max_ttl_sec, … }` |
| **Test host** | Connect + list jail root | `POST /api/sites/:id/test` → `{ ok, latency_ms, backend, entry_count? }` |
| **Backend** | Per-site storage mode | `GET /api/sites/:id/backend` → `{ backend, host, port, root_path }` |
| **Approve** | Magic-link Approve / Deny | `GET /approve/:token` (HTML) · `POST /approve/:token` `{ action: "approve"\|\"deny" }` |
| **Session** | Countdown + Revoke | `GET /api/sessions` · `POST /api/sessions/:id/revoke` |
| **Audit** | Filter activity | `GET /api/audit` |

## Public waitlist (landing page — no auth)

`POST /api/waitlist` at `https://app.artiftp.com/api/waitlist`  
JSON: `name`, `business` or `business_name`, `email`, `agent`, `sites` or `site_count` (required); `agent_other` (required when `agent` is Other); `host` or `host_type` (optional).  
Emails hello@ via Resend. Not stored in SQLite. CORS: artiftp.com + www + localhost.

## Owner auth (gates the `/api/*` routes)
- `POST /auth/request-link` → prints/emails magic link  
- `GET /auth/magic?token=…` → sets owner cookie  
- `GET /api/me`

## Agent / MCP tools (Justice dogfood)
| Tool | Route |
|------|-------|
| list_sites | `GET /tools/list_sites` |
| request_access | `POST /tools/request_access` |
| session_status | `GET /tools/session_status` |
| list_files | `GET /tools/list_files` |
| upload_file | `POST /tools/upload_file` |
| download_file | `GET /tools/download_file` |
| end_session | `POST /tools/end_session` |

Errors: `session_locked` · `denied` · `expired` · `path_forbidden` (403 on `../`) · `mode_forbidden` · `not_found`

## Storage backends
- `mock.local` or `ARTIFTP_FORCE_MOCK=1` (legacy `AGENTFTP_FORCE_MOCK=1` also supported) → local mock FS
- port `22` → SFTP (`ssh2-sftp-client`)
- otherwise → FTP/FTPS (`basic-ftp`; explicit FTPS then plain FTP)
- Jail = site/session `root_path` (e.g. `/public_html`); relative paths only — **absolute paths rejected** at the security boundary
- Site passwords: sealed with `ARTIFTP_MASTER_KEY` (vault); never returned on owner/agent APIs. Re-enter passwords after vault deploy.

## Gaps vs Webby UI
1. ~~UI client-demo state~~ → **fetch wired** (Thu Sep 17, 2026 PT) with cookie auth.  
2. Connect fields ↔ API: UI sends `sftp_user` (map said `username`; alias accepted).  
3. Policy type-to-add → `PATCH root_path` (single root MVP). Multi-root = v1.1.  
4. Approve: `GET /api/requests` returns `approve_url` / `approve_token` for pending; UI POSTs `{ decision }` (map said `action`; alias accepted).  
5. ~~Real GoDaddy still mock FS~~ → **real FTP/FTPS/SFTP wired** via storage facade (Thu Sep 17, 2026 PT). Use Test host before live agent sessions.

## Verify
```bash
cd /workspace/agentftp && npm run dev
# open http://127.0.0.1:8787/ui/
# Justice: npm run dogfood
# curl http://127.0.0.1:8787/health
```
