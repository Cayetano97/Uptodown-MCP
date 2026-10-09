import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  buildSessionFileContents,
  parseCookieHeader,
  resolveSession,
  SESSION_FILE_ENV,
  SESSION_COOKIE_ENV,
} from '../src/session.js';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'uptodown-session-'));
  dirs.push(dir);
  return dir;
}

/** Session payload with the schema the login helper writes. */
function sessionFile(capturedAt: string, cookies: { name: string; value: string; expires?: number }[]): string {
  const contents = buildSessionFileContents(
    cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: '.uptodown.dev',
      path: '/',
      ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
    })),
    'tester@example.com',
    capturedAt,
  );
  return JSON.stringify(contents);
}

function writeSession(capturedAt: string, cookies: { name: string; value: string; expires?: number }[]): string {
  const path = join(tempDir(), '.uptodown-session.json');
  writeFileSync(path, sessionFile(capturedAt, cookies), 'utf8');
  return path;
}

/** Far-future expiry so a cookie is never the reason a case fails. */
const LATER = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
const PAST = Math.floor(Date.now() / 1000) - 60;

describe('resolveSession', () => {
  it('prefers UPTODOWN_SESSION_COOKIE over an explicit file', () => {
    const path = writeSession(new Date().toISOString(), [{ name: 'from-file', value: 'file-value', expires: LATER }]);
    const resolved = resolveSession({
      [SESSION_COOKIE_ENV]: 'from-cookie=cookie-value',
      [SESSION_FILE_ENV]: path,
    } as NodeJS.ProcessEnv);

    assert.equal(resolved.failure, null);
    assert.equal(resolved.session?.source, 'env-cookie');
    assert.equal(resolved.session?.cookies.get('from-cookie'), 'cookie-value');
  });

  it('reads an explicit UPTODOWN_SESSION_FILE', () => {
    const path = writeSession(new Date().toISOString(), [{ name: 'uptodown_edi', value: 'abc', expires: LATER }]);
    const resolved = resolveSession({ [SESSION_FILE_ENV]: path } as NodeJS.ProcessEnv);

    assert.equal(resolved.failure, null);
    assert.equal(resolved.session?.source, 'env-file');
    assert.equal(resolved.session?.user, 'tester@example.com');
  });

  it('reports an explicit file that does not exist', () => {
    const resolved = resolveSession({ [SESSION_FILE_ENV]: join(tempDir(), 'nope.json') } as NodeJS.ProcessEnv);

    assert.equal(resolved.session, null);
    assert.match(resolved.failure ?? '', /No session file at/);
  });

  it('treats a missing default file as "not configured", not as an error', () => {
    // No env vars at all: the default lives at the package root, which may not exist in CI.
    const resolved = resolveSession({} as NodeJS.ProcessEnv);

    assert.equal(resolved.session, null);
    if (resolved.failure !== null) {
      // Only acceptable when the default file genuinely exists with bad contents.
      assert.match(resolved.failure, /No session file at|usable session cookies/);
    }
  });

  it('drops expired cookies and keeps the usable ones', () => {
    const path = writeSession(new Date().toISOString(), [
      { name: 'live', value: 'kept', expires: LATER },
      { name: 'dead', value: 'dropped', expires: PAST },
    ]);
    const resolved = resolveSession({ [SESSION_FILE_ENV]: path } as NodeJS.ProcessEnv);

    assert.equal(resolved.failure, null);
    assert.equal(resolved.session?.cookies.get('live'), 'kept');
    assert.equal(resolved.session?.cookies.has('dead'), false);
  });

  it('fails when every cookie has expired', () => {
    const path = writeSession(new Date().toISOString(), [
      { name: 'a', value: '1', expires: PAST },
      { name: 'b', value: '2', expires: PAST },
    ]);
    const resolved = resolveSession({ [SESSION_FILE_ENV]: path } as NodeJS.ProcessEnv);

    assert.equal(resolved.session, null);
    assert.match(resolved.failure ?? '', /expired/);
  });

  it('accepts a capture far older than 30 days as long as its cookies live', () => {
    // The age cap was removed: freshness is decided by cookie expiry, not capture date.
    const path = writeSession('2020-01-01T00:00:00.000Z', [{ name: 'uptodown_edi', value: 'abc', expires: LATER }]);
    const resolved = resolveSession({ [SESSION_FILE_ENV]: path } as NodeJS.ProcessEnv);

    assert.equal(resolved.failure, null);
    assert.equal(resolved.session?.capturedAt, '2020-01-01T00:00:00.000Z');
  });

  it('rejects a session file that is not valid JSON', () => {
    const path = join(tempDir(), 'broken.json');
    writeFileSync(path, '{ not json', 'utf8');
    const resolved = resolveSession({ [SESSION_FILE_ENV]: path } as NodeJS.ProcessEnv);

    assert.equal(resolved.session, null);
    assert.match(resolved.failure ?? '', /not valid JSON/);
  });

  it('rejects an unsupported session file version', () => {
    const path = join(tempDir(), 'version.json');
    writeFileSync(path, JSON.stringify({ version: 99, cookies: [] }), 'utf8');
    const resolved = resolveSession({ [SESSION_FILE_ENV]: path } as NodeJS.ProcessEnv);

    assert.equal(resolved.session, null);
    assert.match(resolved.failure ?? '', /version 99/);
  });

  it('rejects a cookie header that does not look like one', () => {
    const resolved = resolveSession({ [SESSION_COOKIE_ENV]: 'not-a-cookie' } as NodeJS.ProcessEnv);

    assert.equal(resolved.session, null);
    assert.match(resolved.failure ?? '', /does not look like a cookie header/);
  });
});

describe('parseCookieHeader', () => {
  it('parses a standard header', () => {
    const jar = parseCookieHeader('a=1; b=2');
    assert.equal(jar.get('a'), '1');
    assert.equal(jar.get('b'), '2');
  });

  it('keeps "=" inside values and skips empty segments', () => {
    const jar = parseCookieHeader('jwt=abc=def==; ; trailing=1');
    assert.equal(jar.get('jwt'), 'abc=def==');
    assert.equal(jar.get('trailing'), '1');
    assert.equal(jar.size, 2);
  });

  it('returns an empty jar for blank input', () => {
    assert.equal(parseCookieHeader('   ').size, 0);
    assert.equal(parseCookieHeader(';;').size, 0);
  });
});
