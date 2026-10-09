import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { assertUploadPathAllowed, FILE_ROOT_ENV, resolveFileRoot } from '../src/file-root.js';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'uptodown-fileroot-'));
  dirs.push(dir);
  return dir;
}

describe('resolveFileRoot', () => {
  it('returns null when unset or blank', () => {
    assert.equal(resolveFileRoot({}), null);
    assert.equal(resolveFileRoot({ [FILE_ROOT_ENV]: '   ' }), null);
  });

  it('resolves an absolute path', () => {
    const dir = tempDir();
    assert.equal(resolveFileRoot({ [FILE_ROOT_ENV]: dir }), resolve(dir));
  });
});

describe('assertUploadPathAllowed', () => {
  it('allows anything when no root is configured', () => {
    assert.doesNotThrow(() => assertUploadPathAllowed('/anywhere/file.apk', null));
  });

  it('allows a file inside the root', () => {
    const root = tempDir();
    assert.doesNotThrow(() => assertUploadPathAllowed(join(root, 'build', 'app.apk'), root));
  });

  it('blocks a file outside the root', () => {
    const root = tempDir();
    const outside = join(tempDir(), 'app.apk');
    assert.throws(() => assertUploadPathAllowed(outside, root), /outside that directory/);
  });

  it('blocks a sibling directory sharing the root as a string prefix', () => {
    // `startsWith` would wrongly accept C:\ab for a root of C:\a: no separator between them.
    const root = tempDir();
    const sibling = `${root}extra`;
    assert.throws(() => assertUploadPathAllowed(join(sibling, 'app.apk'), root), /outside that directory/);
  });

  it('blocks a traversal that escapes the root', () => {
    const root = tempDir();
    assert.throws(() => assertUploadPathAllowed(join(root, '..', 'escape.apk'), root), /outside that directory/);
  });

  it('blocks a relative path that resolves outside the root', () => {
    const root = tempDir();
    assert.throws(() => assertUploadPathAllowed(join('..', 'outside.apk'), root), /outside that directory/);
  });
});
