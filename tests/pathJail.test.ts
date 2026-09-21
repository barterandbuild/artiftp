import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PathForbiddenError, relativeFromRoot, resolveJailPath, resolveJailed } from '../src/pathJail.js';

const root = path.resolve('/tmp/agentftp-jail-test/samples');

describe('resolveJailPath', () => {
  it('allows simple relative paths', () => {
    const abs = resolveJailPath(root, 'pack/index.html');
    assert.equal(abs, path.join(root, 'pack/index.html'));
  });

  it('allows "." and empty as root', () => {
    assert.equal(resolveJailPath(root, '.'), path.resolve(root));
    assert.equal(resolveJailPath(root, ''), path.resolve(root));
  });

  it('rejects .. escape', () => {
    assert.throws(() => resolveJailPath(root, '../etc/passwd'), PathForbiddenError);
    assert.throws(() => resolveJailPath(root, 'foo/../../etc/passwd'), PathForbiddenError);
  });

  it('rejects absolute paths', () => {
    assert.throws(() => resolveJailPath(root, '/etc/passwd'), PathForbiddenError);
  });

  it('rejects absolute paths outright and does not remap them inside the jail', () => {
    for (const p of ['/etc/shadow', '/etc/passwd', '//etc/shadow', '\\etc\\shadow']) {
      assert.throws(() => resolveJailPath(root, p), (err: unknown) => {
        assert.ok(err instanceof PathForbiddenError);
        assert.match((err as Error).message, /absolute/);
        return true;
      });
      assert.throws(() => resolveJailed(root, p, 'local'), PathForbiddenError);
    }
    assert.notEqual(path.join(root, 'etc/shadow'), '/etc/shadow');
  });

  it('rejects Windows-style absolute paths', () => {
    assert.throws(() => resolveJailPath(root, 'C:\\Windows\\System32\\config'), PathForbiddenError);
    assert.throws(() => resolveJailPath(root, 'C:/Windows/System32'), PathForbiddenError);
  });

  it('rejects null bytes', () => {
    assert.throws(() => resolveJailPath(root, 'foo\0bar'), PathForbiddenError);
  });

  it('normalizes nested dots that stay inside', () => {
    const abs = resolveJailPath(root, 'a/b/../c/file.txt');
    assert.equal(abs, path.join(root, 'a/c/file.txt'));
  });
});

describe('relativeFromRoot', () => {
  it('returns posix-ish relative', () => {
    const abs = path.join(root, 'a', 'b.txt');
    assert.equal(relativeFromRoot(root, abs), 'a/b.txt');
  });

  it('rejects escape', () => {
    assert.throws(() => relativeFromRoot(root, '/etc/passwd'), PathForbiddenError);
  });
});

import {
  normalizeRemoteRoot,
  resolveRemoteJailPath,
  remoteRelativeFromRoot,
} from '../src/pathJail.js';

describe('resolveRemoteJailPath', () => {
  const root = '/public_html';

  it('normalizes remote root', () => {
    assert.equal(normalizeRemoteRoot('public_html'), '/public_html');
    assert.equal(normalizeRemoteRoot('/public_html/'), '/public_html');
  });

  it('allows relative under root', () => {
    assert.equal(resolveRemoteJailPath(root, 'samples/pack.html'), '/public_html/samples/pack.html');
    assert.equal(resolveRemoteJailPath(root, '.'), '/public_html');
  });

  it('rejects .. escape', () => {
    assert.throws(() => resolveRemoteJailPath(root, '../etc/passwd'), PathForbiddenError);
    assert.throws(() => resolveRemoteJailPath(root, 'a/../../x'), PathForbiddenError);
    assert.throws(() => resolveJailed(root, 'foo/../../../../etc/shadow', 'remote'), PathForbiddenError);
  });

  it('rejects absolute paths', () => {
    assert.throws(() => resolveRemoteJailPath(root, '/etc/passwd'), PathForbiddenError);
  });

  it('rejects absolute paths outright and does not remap them inside the jail', () => {
    for (const p of ['/etc/shadow', '/etc/passwd', '//etc/shadow']) {
      assert.throws(() => resolveRemoteJailPath(root, p), (err: unknown) => {
        assert.ok(err instanceof PathForbiddenError);
        assert.match((err as Error).message, /absolute/);
        return true;
      });
      assert.throws(() => resolveJailed(root, p, 'remote'), PathForbiddenError);
    }
  });

  it('remoteRelativeFromRoot returns posix', () => {
    assert.equal(remoteRelativeFromRoot(root, '/public_html/samples/a.html'), 'samples/a.html');
    assert.equal(remoteRelativeFromRoot(root, '/public_html'), '.');
  });
});
