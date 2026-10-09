import { createHash } from 'node:crypto';
import { createReadStream, openAsBlob } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { defaultSessionFilePath, isAuthMode, resolveSession, SESSION_COOKIE_ENV, SESSION_FILE_ENV, } from './session.js';
/** Default API host, taken from the Developers Console bundle. */
export const DEFAULT_BASE_URL = 'https://www.uptodown.dev';
/** JSON requests abort after this long; multipart uploads are never aborted. */
const JSON_TIMEOUT_MS = 90_000;
/**
 * Envelope error code the API returns when the session cookie is missing or stale.
 * Compared as text: the envelope carries it as a number or as a string, depending on the endpoint.
 */
const SESSION_COOKIE_ERROR_CODE = -37;
/**
 * Raised when a captured session is rejected. Session mode never re-authenticates:
 * only the user can produce a fresh browser session.
 */
export const SESSION_EXPIRED_MESSAGE = 'Uptodown session expired or invalid — run "npm run login" to capture a fresh session, or set UPTODOWN_AUTH_MODE=password.';
/** Any non-2xx response, `success: 0` envelope, or transport failure. Message is safe to show. */
export class UptodownApiError extends Error {
    code;
    status;
    constructor(message, details) {
        super(message);
        this.name = 'UptodownApiError';
        this.code = details.code;
        this.status = details.status;
    }
}
/**
 * Minimal Uptodown Developers Console API client.
 *
 * Two auth modes:
 *
 * - **session** — reuses a session cookie captured from a real browser login (Google,
 *   GitHub or email) through `UPTODOWN_SESSION_COOKIE`, `UPTODOWN_SESSION_FILE` or the
 *   default `<package-root>/.uptodown-session.json`. A rejected session raises an
 *   actionable error; the client never tries to re-authenticate on its own.
 * - **password** — `POST /developers/author/login` with `UPTODOWN_EMAIL`/`UPTODOWN_PASSWORD`,
 *   single-flight, with one re-login + retry when the cookie goes stale.
 *
 * Credentials and cookies are held in memory only and are redacted from every message.
 */
export class UptodownClient {
    baseUrl;
    mail;
    password;
    fetchImpl;
    authMode;
    activeAuthMode;
    configurationErrorMessage;
    sessionLabel = null;
    sessionUser = null;
    sessionExpiresAt = null;
    cookieJar = new Map();
    loginPromise = null;
    sessionGeneration = 0;
    constructor(options = {}) {
        this.mail = (options.email ?? process.env['UPTODOWN_EMAIL'] ?? '').trim();
        this.password = options.password ?? process.env['UPTODOWN_PASSWORD'] ?? '';
        const configuredBase = (options.baseUrl ?? process.env['UPTODOWN_BASE_URL'] ?? '').trim();
        this.baseUrl = (configuredBase === '' ? DEFAULT_BASE_URL : configuredBase).replace(/\/+$/, '');
        this.fetchImpl = options.fetchImpl ?? fetch;
        // An empty value (e.g. `UPTODOWN_AUTH_MODE=` in an env block) means "not configured".
        const configuredMode = (options.authMode ?? process.env['UPTODOWN_AUTH_MODE'] ?? '').trim().toLowerCase();
        const requestedMode = configuredMode === '' ? 'auto' : configuredMode;
        if (!isAuthMode(requestedMode)) {
            this.authMode = 'auto';
            this.activeAuthMode = 'password';
            this.configurationErrorMessage = [
                `UPTODOWN_AUTH_MODE must be one of "auto", "session" or "password" (got "${requestedMode}").`,
                'Fix the value and restart the server. See README.md for the auth setup.',
            ].join(' ');
            return;
        }
        this.authMode = requestedMode;
        const session = resolveSession({
            ...process.env,
            ...(options.sessionCookie === undefined ? {} : { [SESSION_COOKIE_ENV]: options.sessionCookie }),
            ...(options.sessionFile === undefined ? {} : { [SESSION_FILE_ENV]: options.sessionFile }),
        });
        const hasEmail = this.mail !== '';
        const hasPassword = this.password !== '';
        if (this.authMode !== 'password' && session.session !== null) {
            this.activeAuthMode = 'session';
            this.cookieJar = new Map(session.session.cookies);
            this.sessionLabel = session.session.label;
            this.sessionUser = session.session.user;
            this.sessionExpiresAt = session.session.expiresAt;
            this.configurationErrorMessage = null;
            return;
        }
        // No usable session: only `auto` may fall back to password, and only when it is complete.
        const passwordConfigured = hasEmail && hasPassword;
        if (this.authMode !== 'session' && passwordConfigured) {
            this.activeAuthMode = 'password';
            this.sessionLabel = null;
            this.sessionUser = null;
            this.sessionExpiresAt = null;
            this.configurationErrorMessage = null;
            return;
        }
        // Unusable configuration: every request answers with this hint instead of running.
        this.activeAuthMode = this.authMode === 'session' ? 'session' : 'password';
        this.sessionLabel = null;
        this.sessionUser = null;
        this.sessionExpiresAt = null;
        this.configurationErrorMessage =
            this.authMode === 'session'
                ? sessionConfigurationError(session.failure)
                : this.authMode === 'password'
                    ? passwordConfigurationError(hasEmail, hasPassword)
                    : autoConfigurationError(hasEmail || hasPassword, session.failure);
    }
    /**
     * Human-readable configuration hint when auth is not usable, otherwise null.
     * The server always starts; tool calls answer with this text instead of failing to boot.
     */
    get configurationError() {
        return this.configurationErrorMessage;
    }
    /** Short description of the active auth setup. Safe to print: cookie NAMES only, never values. */
    get authSummary() {
        if (this.activeAuthMode === 'session') {
            const names = [...this.cookieJar.keys()];
            const parts = [`session (source: ${this.sessionLabel ?? 'none'})`];
            if (this.sessionUser !== null)
                parts.push(`user: ${this.sessionUser}`);
            parts.push(`cookies: ${names.length === 0 ? 'none' : names.join(', ')}`);
            if (this.sessionExpiresAt !== null)
                parts.push(`earliest cookie expiry: ${this.sessionExpiresAt}`);
            return parts.join(', ');
        }
        return `password (UPTODOWN_EMAIL ${this.mail === '' ? 'missing' : 'set'})`;
    }
    /** Removes configured secrets from arbitrary text so nothing sensitive is ever surfaced. */
    redact(text) {
        let result = text;
        if (this.password !== '')
            result = result.split(this.password).join('[redacted]');
        if (this.mail !== '')
            result = result.split(this.mail).join('[redacted-email]');
        for (const value of this.cookieJar.values()) {
            if (value.length >= 4)
                result = result.split(value).join('[redacted-cookie]');
        }
        const cookie = this.cookieHeader();
        if (cookie !== null)
            result = result.split(cookie).join('[redacted-cookie]');
        return result;
    }
    /** GET with query params. Throws {@linkcode UptodownApiError} on any API failure. */
    async get(path, query) {
        return this.request({ method: 'GET', path, query });
    }
    /** POST a JSON body (`.env`-style endpoints plus the description/name writes). */
    async postJson(path, json) {
        return this.request({ method: 'POST', path, json });
    }
    /** PUT a JSON body. */
    async putJson(path, json) {
        return this.request({ method: 'PUT', path, json });
    }
    /**
     * POST multipart form fields (optionally with files).
     * Uploads carry no timeout (large files); plain form posts use the standard JSON timeout.
     */
    async postForm(path, form, files = []) {
        return this.request({ method: 'POST', path, form, files, timeoutMs: files.length > 0 ? 0 : JSON_TIMEOUT_MS });
    }
    /**
     * Performs a request and maps errors per the console contract:
     * 429 -> rate-limit message (never retried), `success: 0` / HTTP >= 400 -> API error.
     *
     * A stale cookie (`401` with errorCode -37) is handled by mode:
     * password mode re-logs in once and retries once; session mode raises an actionable
     * error and never attempts a login (only the user can capture a new browser session).
     */
    async request(options) {
        const configurationError = this.configurationError;
        if (configurationError !== null) {
            throw new UptodownApiError(configurationError, { code: 'configuration', status: null });
        }
        await this.ensureSession();
        const generation = this.sessionGeneration;
        let raw = await this.send(options);
        if (raw.status === 401 && String(errorCodeOf(raw.body)) === String(SESSION_COOKIE_ERROR_CODE)) {
            if (this.activeAuthMode === 'session') {
                throw new UptodownApiError(this.redact(SESSION_EXPIRED_MESSAGE), { code: 'session-expired', status: 401 });
            }
            if (this.sessionGeneration === generation) {
                await this.ensureSession(true);
            }
            raw = await this.send(options);
        }
        return this.interpret(raw, options.allowEnvelopeFailure === true);
    }
    interpret(raw, allowEnvelopeFailure) {
        const envelope = asEnvelope(raw.body);
        if (raw.status === 429) {
            throw new UptodownApiError(this.redact('Uptodown API error [429]: rate limit reached (HTTP 429). The request was not retried; wait a minute before calling again.'), { code: 429, status: 429 });
        }
        if (raw.status >= 400) {
            throw this.apiError(raw.status, envelope);
        }
        if (envelope !== null && envelope.success !== 1 && !allowEnvelopeFailure) {
            throw this.apiError(raw.status, envelope);
        }
        return {
            status: raw.status,
            empty: raw.body === null,
            body: raw.body,
            envelope,
            data: envelope === null ? raw.body : envelope.data,
        };
    }
    apiError(status, envelope) {
        const code = envelope?.errorCode ?? status;
        const message = typeof envelope?.errorMsg === 'string' && envelope.errorMsg.trim() !== ''
            ? envelope.errorMsg
            : `HTTP ${status} response without error details`;
        return new UptodownApiError(this.redact(`Uptodown API error [${String(code)}]: ${message}`), {
            code: typeof code === 'number' || typeof code === 'string' ? code : status,
            status,
        });
    }
    async send(options) {
        const url = this.buildUrl(options.path, options.query);
        const headers = { accept: 'application/json, text/plain, */*' };
        const cookie = this.cookieHeader();
        if (cookie !== null)
            headers['cookie'] = cookie;
        const init = { method: options.method, headers };
        if (options.files !== undefined && options.files.length > 0) {
            const form = new FormData();
            appendFormFields(form, options.form);
            for (const file of options.files) {
                form.append(file.field, await openUploadBlob(file), file.filename ?? basename(file.path));
            }
            init.body = form;
        }
        else if (options.form !== undefined) {
            const form = new FormData();
            appendFormFields(form, options.form);
            init.body = form;
        }
        else if (options.json !== undefined) {
            headers['content-type'] = 'application/json';
            init.body = JSON.stringify(options.json);
        }
        const timeoutMs = options.timeoutMs ?? JSON_TIMEOUT_MS;
        if (timeoutMs > 0) {
            init.signal = AbortSignal.timeout(timeoutMs);
        }
        let response;
        try {
            response = await this.fetchImpl(url, init);
        }
        catch (error) {
            throw new UptodownApiError(this.redact(`Uptodown request to ${options.path} failed: ${describeNetworkError(error)}`), { code: 'network-error', status: null });
        }
        return { status: response.status, body: await readBody(response) };
    }
    /**
     * Password mode: single-flight login, concurrent callers share one login request.
     * Session mode: cookies were captured up front, so there is nothing to do.
     */
    async ensureSession(force = false) {
        if (this.activeAuthMode === 'session')
            return;
        if (!force && this.cookieJar.size > 0)
            return;
        this.loginPromise ??= this.login().finally(() => {
            this.loginPromise = null;
        });
        return this.loginPromise;
    }
    async login() {
        this.cookieJar.clear();
        const url = this.buildUrl('/developers/author/login');
        let response;
        try {
            response = await this.fetchImpl(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*' },
                body: JSON.stringify({ mail: this.mail, password: this.password }),
                signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
            });
        }
        catch (error) {
            throw new UptodownApiError(this.redact(`Uptodown login failed: ${describeNetworkError(error)}`), { code: 'network-error', status: null });
        }
        const cookies = readSetCookies(response);
        const body = await readBody(response);
        const envelope = asEnvelope(body);
        if (response.status === 429) {
            throw new UptodownApiError(this.redact('Uptodown API error [429]: rate limit reached (HTTP 429) while logging in. Wait a minute before calling again.'), { code: 429, status: 429 });
        }
        if (response.status >= 400 || (envelope !== null && envelope.success !== 1)) {
            throw this.apiError(response.status, envelope);
        }
        if (cookies.size === 0) {
            throw new UptodownApiError(this.redact('Uptodown login succeeded but the response did not set a session cookie.'), { code: 'login-no-cookie', status: response.status });
        }
        this.cookieJar = cookies;
        this.sessionGeneration += 1;
    }
    cookieHeader() {
        if (this.cookieJar.size === 0)
            return null;
        return [...this.cookieJar].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    buildUrl(path, query) {
        const normalizedPath = path.startsWith('/') ? path : `/${path}`;
        const url = new URL(`${this.baseUrl}${normalizedPath}`);
        for (const [key, raw] of Object.entries(query ?? {})) {
            const values = Array.isArray(raw) ? raw : [raw];
            for (const value of values) {
                if (value === undefined || value === null || value === '')
                    continue;
                url.searchParams.append(key, String(value));
            }
        }
        return url.toString();
    }
}
/** Hex sha256 of a file, streamed so large APKs never sit in memory. */
export async function sha256File(filePath) {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    for await (const chunk of stream) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}
function appendFormFields(form, fields) {
    for (const [name, raw] of Object.entries(fields ?? {})) {
        const values = Array.isArray(raw) ? raw : [raw];
        for (const value of values) {
            if (value === undefined || value === null)
                continue;
            form.append(name, String(value));
        }
    }
}
/**
 * `openAsBlob` streams the file instead of buffering it, which matters for APK-sized
 * uploads; the fallback keeps older runtimes working.
 */
async function openUploadBlob(file) {
    const contentType = file.contentType ?? guessContentType(file.filename ?? file.path);
    try {
        return await openAsBlob(file.path, { type: contentType });
    }
    catch {
        return new Blob([await readFile(file.path)], { type: contentType });
    }
}
const CONTENT_TYPES = new Map([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
    ['gif', 'image/gif'],
    ['apk', 'application/vnd.android.package-archive'],
    ['xapk', 'application/octet-stream'],
    ['aab', 'application/octet-stream'],
    ['zip', 'application/zip'],
    ['mp4', 'video/mp4'],
    ['webm', 'video/webm'],
]);
function guessContentType(path) {
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    return CONTENT_TYPES.get(extension) ?? 'application/octet-stream';
}
function basename(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    return normalized.slice(normalized.lastIndexOf('/') + 1);
}
function asEnvelope(body) {
    if (typeof body !== 'object' || body === null || Array.isArray(body))
        return null;
    const candidate = body;
    return 'success' in candidate ? candidate : null;
}
function errorCodeOf(body) {
    return asEnvelope(body)?.errorCode;
}
async function readBody(response) {
    if (response.status === 204 || response.status === 205)
        return null;
    const text = await response.text();
    if (text.trim() === '')
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
/** Parses `Set-Cookie` headers into a cookie jar (expired cookies delete their entry). */
function readSetCookies(response) {
    const jar = new Map();
    const headers = response.headers.getSetCookie();
    for (const header of headers) {
        const pair = header.split(';', 1)[0]?.trim() ?? '';
        const separator = pair.indexOf('=');
        if (separator <= 0)
            continue;
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        if (name === '')
            continue;
        if (value === '')
            jar.delete(name);
        else
            jar.set(name, value);
    }
    return jar;
}
function describeNetworkError(error) {
    if (error instanceof Error) {
        if (error.name === 'TimeoutError')
            return 'the request timed out';
        if (error.name === 'AbortError')
            return 'the request was aborted';
        const cause = error.cause;
        if (cause instanceof Error && cause.message !== '')
            return `${error.message} (${cause.message})`;
        return error.message;
    }
    return String(error);
}
function passwordConfigurationError(hasEmail, hasPassword) {
    const missing = [!hasEmail ? 'UPTODOWN_EMAIL' : null, !hasPassword ? 'UPTODOWN_PASSWORD' : null]
        .filter((name) => name !== null)
        .join(' and ');
    return [
        `Uptodown password auth is not configured: ${missing} ${missing.includes(' and ') ? 'are' : 'is'} not set.`,
        'Set them in the `environment` block of this MCP server in your client config (mcp.servers.<name>.environment) or in your shell, then restart the server.',
        'Or switch to session auth: run "npm run login" once in a browser (works with Google, GitHub and email logins).',
        'See README.md for the full setup.',
    ].join(' ');
}
function sessionConfigurationError(failure) {
    return [
        'Uptodown session auth is not configured: no usable session cookies were found.',
        `Capture a session with "npm run login" (works with Google, GitHub and email logins), or set ${SESSION_COOKIE_ENV} to a raw cookie header ("name=value; ..."), or set ${SESSION_FILE_ENV} to a session JSON file (default: ${defaultSessionFilePath()}).`,
        ...(failure === null ? [] : [failure]),
        'See README.md for the full setup.',
    ].join(' ');
}
function autoConfigurationError(partialPassword, failure) {
    return [
        'Uptodown credentials are not configured. Choose one:',
        '(1) run "npm run login" once in a browser to capture a session (works with Google, GitHub and email logins);',
        `(2) set ${SESSION_COOKIE_ENV} to a raw cookie header ("name=value; ...") or ${SESSION_FILE_ENV} to a session JSON file (default: ${defaultSessionFilePath()});`,
        '(3) set UPTODOWN_EMAIL and UPTODOWN_PASSWORD for password auth.',
        ...(partialPassword ? ['Only one of UPTODOWN_EMAIL/UPTODOWN_PASSWORD is set; password auth needs both.'] : []),
        ...(failure === null ? [] : [failure]),
        'See README.md for the full setup.',
    ].join(' ');
}
