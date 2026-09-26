import { Readable, Writable } from 'node:stream';
import path from 'node:path';
import { Client as FtpClient, type FileInfo as FtpFileInfo } from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';
import { openPersistedCredential } from '../vault.js';
import type { SiteRow } from '../db.js';
import {
  PathForbiddenError,
  normalizeRemoteRoot,
  remoteRelativeFromRoot,
  resolveRemoteJailPath,
} from '../pathJail.js';
import type { ListedEntry } from './mockBackend.js';

export type RemoteBackendKind = 'ftp' | 'sftp';

/**
 * Open the site password immediately before an FTP/SFTP handshake.
 * Plaintext must not leave this connect path (no logs, no API payloads, no session map).
 */
function passwordForConnect(site: SiteRow): string {
  return openPersistedCredential(site.cred_enc);
}

function codeError(code: string, message?: string): Error {
  return Object.assign(new Error(message || code), { code });
}

function mapRemoteError(e: unknown): never {
  if (e instanceof PathForbiddenError) throw e;
  const err = e as { code?: string | number; message?: string };
  const msg = String(err.message || e);
  const lower = msg.toLowerCase();
  if (
    err.code === 550 ||
    err.code === 'ENOENT' ||
    /not\s*found|no such file|doesn.?t exist|failed to change directory|550/.test(lower)
  ) {
    throw codeError('not_found', msg);
  }
  throw e instanceof Error ? e : new Error(msg);
}

export function remoteKindForSite(site: SiteRow): RemoteBackendKind {
  return Number(site.port) === 22 ? 'sftp' : 'ftp';
}

/** Connect FTP/FTPS: prefer explicit FTPS, fall back to plain FTP (GoDaddy often needs one or the other). */
async function connectFtp(site: SiteRow): Promise<FtpClient> {
  const user = site.sftp_user;
  const password = passwordForConnect(site);
  const host = site.host;
  const port = Number(site.port) || 21;
  const secureOptions = { rejectUnauthorized: false };

  const tryAccess = async (secure: boolean | 'implicit'): Promise<FtpClient> => {
    const client = new FtpClient(30_000);
    try {
      await client.access({ host, port, user, password, secure, secureOptions });
      return client;
    } catch (e) {
      client.close();
      throw e;
    }
  };

  // GoDaddy shared hosting often resets FTPS — try plain FTP first on :21, then explicit FTPS.
  const order: Array<boolean | 'implicit'> = port === 21 ? [false, true] : [true, false];
  let last: unknown;
  for (const secure of order) {
    try {
      return await tryAccess(secure);
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function withFtp<T>(site: SiteRow, fn: (client: FtpClient, root: string) => Promise<T>): Promise<T> {
  let root = normalizeRemoteRoot(site.root_path);
  const client = await connectFtp(site);
  try {
    // GoDaddy FTP is often already chrooted to public_html — `/public_html` then 550s.
    const candidates =
      root === '/public_html' || root === '/httpdocs' || root === '/www'
        ? [root, '/']
        : [root];
    let lastErr: unknown;
    for (const candidate of candidates) {
      try {
        if (candidate === '/') {
          // Stay at login cwd (chroot home) — treat jail root as `/`
          root = '/';
          return await fn(client, root);
        }
        await client.cd(candidate);
        root = candidate;
        return await fn(client, root);
      } catch (e) {
        lastErr = e;
      }
    }
    return mapRemoteError(lastErr);
  } catch (e) {
    return mapRemoteError(e);
  } finally {
    client.close();
  }
}

async function withSftp<T>(site: SiteRow, fn: (sftp: SftpClient, root: string) => Promise<T>): Promise<T> {
  const root = normalizeRemoteRoot(site.root_path);
  const sftp = new SftpClient('artiftp', {
    error: () => {},
    end: () => {},
    close: () => {},
  });
  try {
    await sftp.connect({
      host: site.host,
      port: Number(site.port) || 22,
      username: site.sftp_user,
      password: passwordForConnect(site),
      readyTimeout: 30_000,
    });
    // Ensure jail root exists / is accessible
    const exists = await sftp.exists(root);
    if (!exists) {
      throw codeError('not_found', 'root_path not found on remote');
    }
    return await fn(sftp, root);
  } catch (e) {
    return mapRemoteError(e);
  } finally {
    try {
      await sftp.end();
    } catch {
      /* ignore */
    }
  }
}

function ftpEntries(root: string, dirRemote: string, listing: FtpFileInfo[]): ListedEntry[] {
  return listing
    .filter((f) => f.name !== '.' && f.name !== '..')
    .map((f) => {
      const abs = path.posix.join(dirRemote, f.name);
      return {
        name: f.name,
        path: remoteRelativeFromRoot(root, abs),
        type: f.isDirectory ? ('dir' as const) : ('file' as const),
        size: f.isFile ? f.size : undefined,
      };
    });
}

export async function listFiles(site: SiteRow, rel = '.'): Promise<ListedEntry[]> {
  const kind = remoteKindForSite(site);
  if (kind === 'sftp') {
    return withSftp(site, async (sftp, root) => {
      const target = resolveRemoteJailPath(root, rel);
      const exists = await sftp.exists(target);
      if (!exists) throw codeError('not_found');
      if (exists !== 'd') throw codeError('not_a_directory');
      const listing = await sftp.list(target);
      return listing
        .filter((f) => f.name !== '.' && f.name !== '..')
        .map((f) => {
          const abs = path.posix.join(target, f.name);
          return {
            name: f.name,
            path: remoteRelativeFromRoot(root, abs),
            type: f.type === 'd' ? ('dir' as const) : ('file' as const),
            size: f.type === '-' ? f.size : undefined,
          };
        });
    });
  }

  return withFtp(site, async (client, root) => {
    const target = resolveRemoteJailPath(root, rel);
    try {
      const listing = await client.list(target);
      return ftpEntries(root, target, listing);
    } catch (e) {
      return mapRemoteError(e);
    }
  });
}

export async function uploadFile(
  site: SiteRow,
  relPath: string,
  content: Buffer | string,
  mode: 'read' | 'read_write',
): Promise<{ path: string; bytes: number }> {
  if (mode !== 'read_write') {
    throw codeError('mode_forbidden');
  }
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const kind = remoteKindForSite(site);

  if (kind === 'sftp') {
    return withSftp(site, async (sftp, root) => {
      const target = resolveRemoteJailPath(root, relPath);
      const parent = path.posix.dirname(target);
      if (parent !== root && !parent.startsWith(root + '/')) {
        throw new PathForbiddenError('parent escapes jail');
      }
      if (parent !== root) {
        await sftp.mkdir(parent, true);
      }
      await sftp.put(buf, target);
      return { path: remoteRelativeFromRoot(root, target), bytes: buf.length };
    });
  }

  return withFtp(site, async (client, root) => {
    const target = resolveRemoteJailPath(root, relPath);
    const parent = path.posix.dirname(target);
    if (parent !== root && !parent.startsWith(root + '/')) {
      throw new PathForbiddenError('parent escapes jail');
    }
    if (parent !== root) {
      await client.ensureDir(parent);
      // ensureDir cds into the dir; return to root jail for clarity
      await client.cd(root);
    }
    const stream = Readable.from(buf);
    await client.uploadFrom(stream, target);
    return { path: remoteRelativeFromRoot(root, target), bytes: buf.length };
  });
}

export async function downloadFile(
  site: SiteRow,
  relPath: string,
): Promise<{ path: string; content: Buffer; bytes: number }> {
  const kind = remoteKindForSite(site);

  if (kind === 'sftp') {
    return withSftp(site, async (sftp, root) => {
      const target = resolveRemoteJailPath(root, relPath);
      const exists = await sftp.exists(target);
      if (!exists || exists === 'd') throw codeError('not_found');
      const data = (await sftp.get(target)) as Buffer;
      const content = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      return { path: remoteRelativeFromRoot(root, target), content, bytes: content.length };
    });
  }

  return withFtp(site, async (client, root) => {
    const target = resolveRemoteJailPath(root, relPath);
    const chunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        cb();
      },
    });
    try {
      await client.downloadTo(writable, target);
    } catch (e) {
      return mapRemoteError(e);
    }
    const content = Buffer.concat(chunks);
    return { path: remoteRelativeFromRoot(root, target), content, bytes: content.length };
  });
}

/** Connect + list jail root. Does not log secrets. */
export async function testConnection(
  site: SiteRow,
): Promise<{ ok: true; backend: RemoteBackendKind; entry_count: number }> {
  const backend = remoteKindForSite(site);
  const entries = await listFiles(site, '.');
  return { ok: true, backend, entry_count: entries.length };
}
