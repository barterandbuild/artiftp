import path from 'node:path';

export class PathForbiddenError extends Error {
  readonly code = 'path_forbidden' as const;
  constructor(message = 'path_forbidden') {
    super(message);
    this.name = 'PathForbiddenError';
  }
}

/**
 * Resolve a user-supplied relative path under `rootAbs`.
 * Rejects absolute paths, `..` escapes, and null bytes.
 * Returns the absolute resolved path (must stay under root).
 */
export function resolveJailPath(rootAbs: string, relativePath: string): string {
  if (relativePath == null || typeof relativePath !== 'string') {
    throw new PathForbiddenError('path must be a string');
  }
  if (relativePath.includes('\0')) {
    throw new PathForbiddenError('null byte in path');
  }

  const root = path.resolve(rootAbs);
  // Treat empty / "." as the root itself
  const trimmed = relativePath.trim() === '' ? '.' : relativePath.trim();

  // Reject absolute paths (POSIX and Windows-ish)
  if (path.isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    throw new PathForbiddenError('absolute paths not allowed');
  }

  // Normalize separators then join under root
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
  if (relativePath == null || typeof relativePath !== 'string') {
    throw new PathForbiddenError('path must be a string');
  }
  if (relativePath.includes('\0')) {
    throw new PathForbiddenError('null byte in path');
  }

  const root = normalizeRemoteRoot(rootPath);
  const trimmed = relativePath.trim() === '' ? '.' : relativePath.trim().replace(/\\/g, '/');

  if (trimmed.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    throw new PathForbiddenError('absolute paths not allowed');
  }

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
