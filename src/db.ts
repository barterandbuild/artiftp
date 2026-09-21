import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const DB_PATH = path.join(DATA_DIR, 'agentftp.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS owners (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_sessions (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS magic_links (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  display_name TEXT NOT NULL,
  slug TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  sftp_user TEXT NOT NULL,
  cred_enc TEXT NOT NULL, -- JSON SealedCredential (vault); legacy ARTIFTP_SECRET blobs are invalid after deploy
  root_path TEXT NOT NULL DEFAULT '/samples',
  mode TEXT NOT NULL DEFAULT 'read_write',
  max_ttl_sec INTEGER NOT NULL DEFAULT 900,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id, slug)
);

CREATE TABLE IF NOT EXISTS access_requests (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  purpose TEXT NOT NULL,
  path_hint TEXT,
  mode TEXT NOT NULL,
  requested_ttl_sec INTEGER NOT NULL,
  agent_label TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  request_id TEXT REFERENCES access_requests(id),
  token_hash TEXT UNIQUE NOT NULL,
  root_path TEXT NOT NULL,
  mode TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  site_id TEXT,
  request_id TEXT,
  session_id TEXT,
  detail TEXT
);
`);

export type SiteRow = {
  id: string;
  owner_id: string;
  display_name: string;
  slug: string;
  host: string;
  port: number;
  sftp_user: string;
  cred_enc: string;
  root_path: string;
  mode: 'read' | 'read_write';
  max_ttl_sec: number;
  created_at: string;
  updated_at: string;
};

export type SessionRow = {
  id: string;
  site_id: string;
  request_id: string | null;
  token_hash: string;
  root_path: string;
  mode: 'read' | 'read_write';
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
};

export type AccessRequestRow = {
  id: string;
  site_id: string;
  purpose: string;
  path_hint: string | null;
  mode: 'read' | 'read_write';
  requested_ttl_sec: number;
  agent_label: string | null;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  created_at: string;
  resolved_at: string | null;
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function audit(
  actor: string,
  action: string,
  opts: {
    site_id?: string;
    request_id?: string;
    session_id?: string;
    detail?: unknown;
  } = {},
): void {
  db.prepare(
    `INSERT INTO audit_events (at, actor, action, site_id, request_id, session_id, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    nowIso(),
    actor,
    action,
    opts.site_id ?? null,
    opts.request_id ?? null,
    opts.session_id ?? null,
    opts.detail != null ? JSON.stringify(opts.detail) : null,
  );
}
