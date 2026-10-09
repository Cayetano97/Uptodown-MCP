import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Session-cookie support.
 *
 * The `npm run login` helper captures the browser session; this module only *reads* it —
 * the server never writes a session file.
 */
export const SESSION_COOKIE_ENV = 'UPTODOWN_SESSION_COOKIE';
export const SESSION_FILE_ENV = 'UPTODOWN_SESSION_FILE';
export const DEFAULT_SESSION_FILE_NAME = '.uptodown-session.json';
export const BROWSER_PROFILE_DIR_NAME = '.uptodown-browser';
export const SESSION_FILE_VERSION = 1;
export const AUTH_MODES = ['auto', 'session', 'password'];
export function isAuthMode(value) {
    return AUTH_MODES.includes(value);
}
/**
 * Package root, resolved from this module's own URL rather than `process.cwd()`, so the default
 * session file is found no matter where the MCP client starts the server from.
 */
export function packageRoot() {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}
export function defaultSessionFilePath() {
    return join(packageRoot(), DEFAULT_SESSION_FILE_NAME);
}
export function browserProfileDir() {
    return join(packageRoot(), BROWSER_PROFILE_DIR_NAME);
}
/**
 * Resolves the session source with the documented priority:
 * `UPTODOWN_SESSION_COOKIE` > `UPTODOWN_SESSION_FILE` > `<package-root>/.uptodown-session.json`.
 */
export function resolveSession(env) {
    const rawCookie = (env[SESSION_COOKIE_ENV] ?? '').trim();
    if (rawCookie !== '') {
        const cookies = parseCookieHeader(rawCookie);
        if (cookies.size === 0) {
            return {
                session: null,
                failure: `${SESSION_COOKIE_ENV} is set but does not look like a cookie header (expected "name=value; name2=value2").`,
            };
        }
        return { session: buildSession('env-cookie', SESSION_COOKIE_ENV, cookies, null, null, null), failure: null };
    }
    const configuredFile = (env[SESSION_FILE_ENV] ?? '').trim();
    const explicitFile = configuredFile !== '';
    const filePath = explicitFile ? resolve(configuredFile) : defaultSessionFilePath();
    const label = explicitFile ? `${SESSION_FILE_ENV} (${filePath})` : filePath;
    const read = readSessionFile(filePath);
    if (read.session !== null) {
        return {
            session: buildSession(explicitFile ? 'env-file' : 'default-file', label, read.session.cookies, read.session.user, read.session.capturedAt, read.session.expiresAt),
            failure: null,
        };
    }
    // A missing default file is the normal "no session configured" case, not a failure.
    if (read.missing && !explicitFile)
        return { session: null, failure: null };
    return { session: null, failure: read.reason };
}
/** Reads and validates a session file, dropping cookies that already expired. */
export function readSessionFile(filePath) {
    let raw;
    try {
        raw = readFileSync(filePath, 'utf8');
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT') {
            return { session: null, missing: true, reason: `No session file at ${filePath}.` };
        }
        return {
            session: null,
            missing: false,
            reason: `Could not read the session file at ${filePath} (${error instanceof Error ? error.message : String(error)}).`,
        };
    }
    const parsed = parseSessionFile(raw);
    if ('error' in parsed) {
        return { session: null, missing: false, reason: `The session file at ${filePath} ${parsed.error}` };
    }
    // A session file carries when it was captured. That timestamp is informational only: freshness
    // is decided by the cookies themselves (expired ones are dropped below), not by the capture date.
    const capturedAt = typeof parsed.capturedAt === 'string' && parsed.capturedAt !== '' ? parsed.capturedAt : null;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const cookies = new Map();
    let expired = 0;
    let invalid = 0;
    let earliestExpiry = null;
    for (const cookie of parsed.cookies) {
        const expires = cookie.expires;
        if (typeof expires === 'number' && expires > 0 && expires <= nowSeconds) {
            expired += 1;
            continue;
        }
        if (typeof cookie.name !== 'string' || cookie.name === '' || typeof cookie.value !== 'string') {
            invalid += 1;
            continue;
        }
        if (typeof expires === 'number' && expires > 0 && (earliestExpiry === null || expires < earliestExpiry)) {
            earliestExpiry = expires;
        }
        cookies.set(cookie.name, cookie.value);
    }
    if (cookies.size === 0) {
        const details = [];
        if (expired > 0)
            details.push(`${expired} expired`);
        if (invalid > 0)
            details.push(`${invalid} invalid`);
        const suffix = details.length === 0 ? 'it has no cookies' : `it has no usable cookies (${details.join(', ')})`;
        return { session: null, missing: false, reason: `The session file at ${filePath} exists but ${suffix}.` };
    }
    return {
        session: {
            cookies,
            user: typeof parsed.user === 'string' && parsed.user !== '' ? parsed.user : null,
            capturedAt,
            expiresAt: earliestExpiry === null ? null : new Date(earliestExpiry * 1000).toISOString(),
        },
        missing: false,
        reason: null,
    };
}
function parseSessionFile(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return { error: 'is not valid JSON.' };
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { error: 'must contain a JSON object.' };
    }
    const record = value;
    if (record['version'] !== SESSION_FILE_VERSION) {
        return {
            error: `has version ${JSON.stringify(record['version'])}; expected version ${SESSION_FILE_VERSION}. Re-run "npm run login".`,
        };
    }
    const cookies = record['cookies'];
    if (!Array.isArray(cookies)) {
        return { error: 'has no "cookies" array. Re-run "npm run login".' };
    }
    return {
        cookies: cookies.filter((cookie) => typeof cookie === 'object' && cookie !== null),
        user: record['user'],
        capturedAt: record['capturedAt'],
    };
}
/** Parses a raw cookie header (`name=value; name2=value2`) into a jar. */
export function parseCookieHeader(raw) {
    const jar = new Map();
    for (const part of raw.split(';')) {
        const trimmed = part.trim();
        if (trimmed === '')
            continue;
        const separator = trimmed.indexOf('=');
        if (separator <= 0)
            continue;
        const name = trimmed.slice(0, separator).trim();
        const value = trimmed.slice(separator + 1).trim();
        if (name === '' || value === '')
            continue;
        jar.set(name, value);
    }
    return jar;
}
function buildSession(source, label, cookies, user, capturedAt, expiresAt) {
    return {
        source,
        label,
        cookies,
        cookieHeader: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        expiresAt,
        user,
        capturedAt,
    };
}
/**
 * Builds the session file payload written by `npm run login`. Pure: the helper owns the
 * filesystem write, the server never persists session data.
 */
export function buildSessionFileContents(cookies, user, capturedAt) {
    return {
        version: SESSION_FILE_VERSION,
        capturedAt,
        ...(user === null || user === '' ? {} : { user }),
        cookies,
    };
}
