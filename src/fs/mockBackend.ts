import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PathForbiddenError, relativeFromRoot, resolveJailPath } from '../pathJail.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MOCK_ROOT_BASE = path.resolve(__dirname, '../../data/mock-root');

export function siteMockRoot(siteId: string): string {
  const dir = path.join(MOCK_ROOT_BASE, siteId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export type ListedEntry = {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
};

export function listFiles(siteId: string, rootPath: string, rel = '.'): ListedEntry[] {
  const absRoot = path.resolve(siteMockRoot(siteId), rootPath.replace(/^\//, '') || '.');
  fs.mkdirSync(absRoot, { recursive: true });
  const target = resolveJailPath(absRoot, rel);
  if (!fs.existsSync(target)) {
    throw Object.assign(new Error('not_found'), { code: 'not_found' });
  }
  const st = fs.statSync(target);
  if (!st.isDirectory()) {
    throw Object.assign(new Error('not_a_directory'), { code: 'not_a_directory' });
  }
  return fs.readdirSync(target, { withFileTypes: true }).map((d) => {
    const child = path.join(target, d.name);
    const relPath = relativeFromRoot(absRoot, child);
    return {
      name: d.name,
      path: relPath,
      type: d.isDirectory() ? 'dir' as const : 'file' as const,
      size: d.isFile() ? fs.statSync(child).size : undefined,
    };
  });
}

export function uploadFile(
  siteId: string,
  rootPath: string,
  relPath: string,
  content: Buffer | string,
  mode: 'read' | 'read_write',
): { path: string; bytes: number } {
  if (mode !== 'read_write') {
    throw Object.assign(new Error('mode_forbidden'), { code: 'mode_forbidden' });
  }
  const absRoot = path.resolve(siteMockRoot(siteId), rootPath.replace(/^\//, '') || '.');
  fs.mkdirSync(absRoot, { recursive: true });
  const target = resolveJailPath(absRoot, relPath);
  // Ensure parent stays in jail
  const parent = path.dirname(target);
  const rootWithSep = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
  if (parent !== absRoot && !parent.startsWith(rootWithSep)) {
    throw new PathForbiddenError('parent escapes jail');
  }
  fs.mkdirSync(parent, { recursive: true });
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  fs.writeFileSync(target, buf);
  return { path: relativeFromRoot(absRoot, target), bytes: buf.length };
}

export function downloadFile(
  siteId: string,
  rootPath: string,
  relPath: string,
): { path: string; content: Buffer; bytes: number } {
  const absRoot = path.resolve(siteMockRoot(siteId), rootPath.replace(/^\//, '') || '.');
  fs.mkdirSync(absRoot, { recursive: true });
  const target = resolveJailPath(absRoot, relPath);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw Object.assign(new Error('not_found'), { code: 'not_found' });
  }
  const content = fs.readFileSync(target);
  return { path: relativeFromRoot(absRoot, target), content, bytes: content.length };
}

/** Seed a site jail from a local samples directory (for dogfood). */
export function seedFromSamples(siteId: string, samplesDir: string, rootSub = 'samples'): void {
  const dest = path.join(siteMockRoot(siteId), rootSub);
  fs.mkdirSync(dest, { recursive: true });
  if (!fs.existsSync(samplesDir)) return;
  for (const name of fs.readdirSync(samplesDir)) {
    const src = path.join(samplesDir, name);
    const st = fs.statSync(src);
    if (st.isFile()) {
      fs.copyFileSync(src, path.join(dest, name));
    }
  }
}
