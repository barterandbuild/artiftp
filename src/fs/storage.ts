import { db, type SiteRow } from '../db.js';
import * as mock from './mockBackend.js';
import * as remote from './remoteBackend.js';
import type { ListedEntry } from './mockBackend.js';

export type BackendKind = 'mock' | 'ftp' | 'sftp';

export function isMockSite(site: Pick<SiteRow, 'host'>): boolean {
  return (process.env.ARTIFTP_FORCE_MOCK || process.env.AGENTFTP_FORCE_MOCK) === '1' || site.host === 'mock.local';
}

export function siteBackendKind(site: Pick<SiteRow, 'host' | 'port'>): BackendKind {
  if (isMockSite(site)) return 'mock';
  return Number(site.port) === 22 ? 'sftp' : 'ftp';
}

/**
 * Global health backend hint: `ftp`/`sftp` if any non-mock site is configured,
 * else `mock`. Forced mock via env always reports mock.
 */
export function getBackendMode(): BackendKind {
  if ((process.env.ARTIFTP_FORCE_MOCK || process.env.AGENTFTP_FORCE_MOCK) === '1') return 'mock';
  const row = db
    .prepare(`SELECT host, port FROM sites WHERE host != 'mock.local' ORDER BY created_at DESC LIMIT 1`)
    .get() as { host: string; port: number } | undefined;
  if (!row) return 'mock';
  return Number(row.port) === 22 ? 'sftp' : 'ftp';
}

function withRoot(site: SiteRow, rootPath?: string): SiteRow {
  if (rootPath == null || rootPath === site.root_path) return site;
  return { ...site, root_path: rootPath };
}

export async function listFiles(
  site: SiteRow,
  rel = '.',
  rootPath?: string,
): Promise<ListedEntry[]> {
  const s = withRoot(site, rootPath);
  if (isMockSite(s)) {
    return mock.listFiles(s.id, s.root_path, rel);
  }
  return remote.listFiles(s, rel);
}

export async function uploadFile(
  site: SiteRow,
  relPath: string,
  content: Buffer | string,
  mode: 'read' | 'read_write',
  rootPath?: string,
): Promise<{ path: string; bytes: number }> {
  const s = withRoot(site, rootPath);
  if (isMockSite(s)) {
    return mock.uploadFile(s.id, s.root_path, relPath, content, mode);
  }
  return remote.uploadFile(s, relPath, content, mode);
}

export async function downloadFile(
  site: SiteRow,
  relPath: string,
  rootPath?: string,
): Promise<{ path: string; content: Buffer; bytes: number }> {
  const s = withRoot(site, rootPath);
  if (isMockSite(s)) {
    return mock.downloadFile(s.id, s.root_path, relPath);
  }
  return remote.downloadFile(s, relPath);
}

export async function testSiteConnection(
  site: SiteRow,
): Promise<{ ok: boolean; backend: BackendKind; latency_ms: number; entry_count?: number; error?: string }> {
  const backend = siteBackendKind(site);
  const started = Date.now();
  try {
    if (isMockSite(site)) {
      const entries = mock.listFiles(site.id, site.root_path, '.');
      return { ok: true, backend, latency_ms: Date.now() - started, entry_count: entries.length };
    }
    const result = await remote.testConnection(site);
    return {
      ok: true,
      backend: result.backend,
      latency_ms: Date.now() - started,
      entry_count: result.entry_count,
    };
  } catch (e: unknown) {
    const err = e as { code?: string; message?: string };
    // Never include credentials; keep message short/sanitized
    const message = err.code || err.message || 'connection_failed';
    const safe = String(message).replace(/\bpassword[=:]\S+/gi, '[redacted]').slice(0, 200);
    return { ok: false, backend, latency_ms: Date.now() - started, error: safe };
  }
}
