import path from 'node:path';

export class PathForbiddenError extends Error {
  readonly code = 'path_forbidden' as const;
  constructor(message = 'path_forbidden') {
    super(message);
    this.name = 'PathForbiddenError';
  }
}

/**
 * Shared rejection of absolute / drive / UNC paths.
 * Never reinterpret `/etc/shadow` (or similar) as a name inside the jail — throw.
 */
export function assertRelativeAgentPath(userPath: string): string {
  if (userPath == null || typeof userPath !== 'string') {
    throw new PathForbiddenError('path must be a string');
  }
  if (userPath.includes('\0')) {
    throw new PathForbiddenError('null byte in path');
  }

  const trimmed = userPath.trim() === '' ? '.' : userPath.trim();
  const posixish = trimmed.replace(/\\/g, '/');

  const absolute =
    trimmed !== '.' &&
    (path.isAbsolute(trimmed) ||
      path.posix.isAbsolute(posixish) ||
      path.win32.isAbsolute(trimmed) ||
      path.win32.isAbsolute(posixish) ||
      trimmed.startsWith('/') ||
      trimmed.startsWith('\\') ||
      posixish.startsWith('/') ||
      /^[a-zA-Z]:/.test(trimmed));

  if (absolute) {
    throw new PathForbiddenError('absolute paths not allowed');
  }
  return trimmed;
}

/**
 * Resolve a user-supplied relative path under `rootAbs`.
 * Rejects absolute paths, `..` escapes, and null bytes.
 * Returns the absolute resolved path (must stay under root).
 */
export function resolveJailPath(rootAbs: string, relativePath: string): string {
  const trimmed = assertRelativeAgentPath(relativePath);

  const root = path.resolve(rootAbs);
  const joined = path.resolve(root, trimmed);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;

  if (joined !== root && !joined.startsWith(rootWithSep)) {
    throw new PathForbiddenError('path escapes jail root');
  }

  return joined;
}

/** Relative path from root for display / storage (POSIX style). */
export function relativeFromRoot(rootAbs: string, absolutePath: string): string {
  const root = path.resolve(rootAbs);
  const abs = path.resolve(absolutePath);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathForbiddenError('path escapes jail root');
  }
  return rel.split(path.sep).join('/') || '.';
}

/** Normalize a remote jail root to POSIX form, e.g. `/public_html`. */
export function normalizeRemoteRoot(rootPath: string): string {
  let r = (rootPath ?? '').trim() || '/';
  r = r.replace(/\\/g, '/');
  if (!r.startsWith('/')) r = '/' + r;
  r = path.posix.normalize(r);
  if (r.length > 1 && r.endsWith('/')) r = r.slice(0, -1);
  return r;
}

/**
 * Resolve a user-supplied relative path under a remote POSIX root.
 * Rejects absolute paths, `..` escapes, and null bytes.
 * Returns the absolute remote POSIX path (must stay under root).
 */
export function resolveRemoteJailPath(rootPath: string, relativePath: string): string {
  const trimmed = assertRelativeAgentPath(relativePath).replace(/\\/g, '/');

  const root = normalizeRemoteRoot(rootPath);
  const joined = path.posix.normalize(path.posix.join(root === '/' ? '/' : root, trimmed));
  if (root === '/') {
    // Jail is entire FTP chroot home — any absolute POSIX path under `/` is in-jail
    if (!joined.startsWith('/') || joined === '/..' || joined.startsWith('/../')) {
      throw new PathForbiddenError('path escapes jail root');
    }
    // still reject escaping via normalize tricks
    if (joined.split('/').includes('..')) {
      throw new PathForbiddenError('path escapes jail root');
    }
    return joined === '/' ? '/' : joined;
  }
  if (joined !== root && !joined.startsWith(root + '/')) {
    throw new PathForbiddenError('path escapes jail root');
  }
  return joined;
}

/** Relative POSIX path from remote root for display / API. */
export function remoteRelativeFromRoot(rootPath: string, absoluteRemote: string): string {
  const root = normalizeRemoteRoot(rootPath);
  const abs = path.posix.normalize(absoluteRemote.replace(/\\/g, '/'));
  if (abs === root) return '.';
  if (root === '/') {
    if (!abs.startsWith('/')) throw new PathForbiddenError('path escapes jail root');
    return abs.slice(1) || '.';
  }
  if (!abs.startsWith(root + '/')) {
    throw new PathForbiddenError('path escapes jail root');
  }
  return abs.slice(root.length + 1) || '.';
}

export type JailKind = 'local' | 'remote';

/**
 * Canonical jail resolver (Bryan: `resolveJailed`).
 * `local` = host filesystem (mock backend). `remote` = POSIX FTP/SFTP paths.
 * Absolute user paths are rejected outright — never silently remapped inside the jail.
 */
export function resolveJailed(root: string, userPath: string, kind: JailKind = 'remote'): string {
  return kind === 'local' ? resolveJailPath(root, userPath) : resolveRemoteJailPath(root, userPath);
}
