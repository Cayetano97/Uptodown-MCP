/**
 * Attach to the user's running Chrome through the sanctioned Chrome 144+ consent flow.
 *
 * Chrome 136+ refuses `--remote-debugging-port` / `--remote-debugging-pipe` on the *default*
 * profile (and passing the profile directory explicitly does not help). The supported way into
 * the browser the user is already signed in to is:
 *
 *   1. the user enables remote debugging once at `chrome://inspect/#remote-debugging`,
 *   2. Chrome writes `DevToolsActivePort` (line 1: port, line 2: websocket path) into its
 *      user-data directory,
 *   3. a client connects to `ws://127.0.0.1:<port><path>`; Chrome shows a per-connection
 *      "Allow" dialog, which is why the connect wait is generous,
 *   4. the client keeps that ONE connection open: it reads `Storage.getCookies` and can open
 *      the site with `Target.createTarget` while it keeps polling for the signed-in session.
 *
 * This module also covers the "no Chrome running" half of the flow: resolving the Chrome
 * executable, launching it at the site, and waiting for `DevToolsActivePort` to appear.
 *
 * Cookie VALUES travel through this module but are never printed or logged: every error is a
 * short, fixed message with no payload and no cookie value.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** `DevToolsActivePort` file name inside a Chrome user-data directory. */
const DEVTOOLS_ACTIVE_PORT_FILE = 'DevToolsActivePort';
/** How often the login flow re-reads the endpoint file / polls the live session while waiting. */
export const POLL_INTERVAL_MS = 2_000;
/**
 * Parses the contents of `DevToolsActivePort`. Pure.
 *
 * Line 1 must be an integer port in `1..65535`, line 2 a non-empty path starting with `/`.
 * CRLF, a trailing newline and blank lines around the pair are tolerated; anything else
 * (including extra non-blank lines) returns null.
 */
export function parseDevToolsActivePort(contents) {
    const lines = contents
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '');
    if (lines.length !== 2)
        return null;
    const portLine = lines[0];
    const pathLine = lines[1];
    if (portLine === undefined || pathLine === undefined)
        return null;
    if (!/^\d+$/.test(portLine))
        return null;
    const port = Number(portLine);
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
        return null;
    if (!pathLine.startsWith('/'))
        return null;
    return { port, path: pathLine };
}
/**
 * Resolves the Chrome user-data directory to look for `DevToolsActivePort` in.
 *
 * `UPTODOWN_CHROME_DATA_DIR` wins when set (returned as-is); otherwise the standard location
 * for the platform is used. Null when nothing can be resolved. Existence is not checked here.
 */
export function resolveChromeUserDataDir(env, platform = process.platform) {
    const override = readEnvValue(env, 'UPTODOWN_CHROME_DATA_DIR');
    if (override !== null)
        return override;
    switch (platform) {
        case 'win32': {
            const localAppData = readEnvValue(env, 'LOCALAPPDATA', 'LocalAppData');
            return localAppData === null ? null : join(localAppData, 'Google', 'Chrome', 'User Data');
        }
        case 'darwin': {
            const home = homedir();
            return home === '' ? null : join(home, 'Library', 'Application Support', 'Google', 'Chrome');
        }
        case 'linux': {
            const home = homedir();
            return home === '' ? null : join(home, '.config', 'google-chrome');
        }
        default:
            return null;
    }
}
/**
 * Reads `<userDataDir>/DevToolsActivePort` and turns it into a connectable endpoint.
 * Missing, unreadable or malformed files return null.
 */
export async function readDevToolsEndpoint(userDataDir) {
    let contents;
    try {
        contents = await readFile(join(userDataDir, DEVTOOLS_ACTIVE_PORT_FILE), 'utf8');
    }
    catch {
        return null;
    }
    const parsed = parseDevToolsActivePort(contents);
    if (parsed === null)
        return null;
    return {
        port: parsed.port,
        path: parsed.path,
        wsUrl: `ws://127.0.0.1:${parsed.port}${parsed.path}`,
    };
}
/** The websocket handshake waits for the user's "Allow" click in Chrome. */
export const ATTACH_CONNECT_TIMEOUT_MS = 60_000;
/** How long to wait for one CDP command answer once connected. */
export const ATTACH_RESPONSE_TIMEOUT_MS = 15_000;
/** An {@linkcode openCdpSession} connect failure carrying its {@linkcode CdpConnectFailureKind}. */
export class CdpConnectError extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.name = 'CdpConnectError';
        this.kind = kind;
    }
}
/**
 * Reads the failure kind off any error; null when the error did not come from a connection
 * attempt (a plain `Error` from a command, for example).
 */
export function connectFailureKind(error) {
    if (error instanceof CdpConnectError)
        return error.kind;
    if (typeof error === 'object' && error !== null) {
        const kind = error.kind;
        if (kind === 'timeout' || kind === 'unreachable')
            return kind;
    }
    return null;
}
/** How long the liveness preflight waits for any answer from Chrome's debugging server. */
const DEBUGGING_PROBE_TIMEOUT_MS = 3_000;
/**
 * Cheap liveness check for a Chrome debugging port.
 *
 * Sends a plain `GET /json/version` — NOT a debugging connection, so Chrome does not show the
 * Allow dialog (the consent server 404s `/json*`). Any HTTP answer (200/403/404) means something
 * is listening and answered; a network failure or timeout means nothing usable is there. Used to
 * tell a refused websocket (consent dialog denied) from a stale endpoint.
 */
export async function probeDebuggingServer(port, timeoutMs = DEBUGGING_PROBE_TIMEOUT_MS) {
    try {
        await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Opens one CDP session, waiting for the user to answer Chrome's Allow dialog.
 *
 * Rejects with a {@linkcode CdpConnectError} (check {@linkcode connectFailureKind}) when the
 * connection cannot be established. The returned session multiplexes requests over that single
 * websocket and stops answering once it is closed.
 */
export async function openCdpSession(wsUrl, options) {
    const connectTimeoutMs = options?.connectTimeoutMs ?? ATTACH_CONNECT_TIMEOUT_MS;
    const responseTimeoutMs = options?.responseTimeoutMs ?? ATTACH_RESPONSE_TIMEOUT_MS;
    const socket = await connectSocket(wsUrl, connectTimeoutMs);
    return new CdpSessionImpl(socket, responseTimeoutMs);
}
/**
 * One-shot capture kept for callers that need a single reading (and for the test harnesses):
 * open, `Storage.getCookies`, close. Prefer {@linkcode openCdpSession} when more than one
 * command is needed on the same connection.
 */
export async function captureCookiesOverCdp(wsUrl, options) {
    const session = await openCdpSession(wsUrl, options);
    try {
        return await session.getCookies();
    }
    finally {
        session.close();
    }
}
/** Keeps only cookies that apply to `host`: exact domain or a dotted domain suffix of it. */
export function cookiesForHost(cookies, host) {
    const normalizedHost = host.trim().toLowerCase();
    if (normalizedHost === '')
        return [];
    return cookies.filter((cookie) => {
        if (typeof cookie.domain !== 'string')
            return false;
        const domain = cookie.domain.trim().toLowerCase().replace(/^\./, '');
        if (domain === '')
            return false;
        return normalizedHost === domain || normalizedHost.endsWith(`.${domain}`);
    });
}
/**
 * Resolves the Chrome executable to launch when the user has no Chrome running.
 *
 * A non-empty `UPTODOWN_CHROME_EXECUTABLE` wins and is returned as-is (no existence check: a
 * failed launch is reported by the caller). Otherwise the standard install location for the
 * platform is used, and only an existing file is returned. Null when none exists.
 */
export function resolveChromeExecutable(env, platform = process.platform) {
    const override = readEnvValue(env, 'UPTODOWN_CHROME_EXECUTABLE');
    if (override !== null)
        return override;
    return chromeExecutableCandidates(env, platform).find((candidate) => existsSync(candidate)) ?? null;
}
function chromeExecutableCandidates(env, platform) {
    switch (platform) {
        case 'win32': {
            const roots = [
                readEnvValue(env, 'PROGRAMFILES', 'ProgramFiles'),
                readEnvValue(env, 'PROGRAMFILES(X86)', 'ProgramFiles(x86)'),
                readEnvValue(env, 'LOCALAPPDATA', 'LocalAppData'),
            ];
            return roots
                .filter((root) => root !== null)
                .map((root) => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
        }
        case 'darwin':
            return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
        case 'linux':
            return [
                '/usr/bin/google-chrome',
                '/usr/bin/google-chrome-stable',
                '/usr/bin/chromium',
                '/usr/bin/chromium-browser',
            ];
        default:
            return [];
    }
}
/**
 * Launches Chrome detached at `url`. Resolves true once the process spawned, false when the
 * executable cannot be started (missing file, permissions, …). Never throws; a Chrome that is
 * already running opens the URL in a new tab of the existing instance.
 */
export function launchChrome(exePath, url) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(exePath, [url], { detached: true, stdio: 'ignore', windowsHide: false });
        }
        catch {
            resolve(false);
            return;
        }
        let settled = false;
        child.once('error', () => {
            if (settled)
                return;
            settled = true;
            resolve(false);
        });
        child.once('spawn', () => {
            if (settled)
                return;
            settled = true;
            resolve(true);
        });
        child.unref();
    });
}
/**
 * Polls `DevToolsActivePort` until an endpoint appears or `deadlineMs` passes.
 *
 * The file is re-read on every poll, so a port that changed (Chrome restarted) is picked up.
 * `onTick` runs after each unsuccessful poll with the elapsed time, for progress messages.
 * Returns the first endpoint found, or null at the deadline.
 */
export async function waitForDevToolsEndpoint(userDataDir, deadlineMs, onTick) {
    const startedAt = Date.now();
    while (Date.now() < deadlineMs) {
        const endpoint = await readDevToolsEndpoint(userDataDir);
        if (endpoint !== null)
            return endpoint;
        onTick?.(Date.now() - startedAt);
        await sleep(POLL_INTERVAL_MS);
    }
    return null;
}
/** Opens the browser websocket, classifying a failure so the caller can react. */
function connectSocket(wsUrl, timeoutMs) {
    return new Promise((resolve, reject) => {
        let socket;
        try {
            socket = new WebSocket(wsUrl);
        }
        catch {
            reject(new CdpConnectError('unreachable', 'CDP connection could not be started (invalid websocket URL)'));
            return;
        }
        const timer = setTimeout(() => {
            cleanup();
            try {
                socket.close();
            }
            catch {
                // The socket is already unusable; there is nothing else to clean up.
            }
            reject(new CdpConnectError('timeout', `CDP connection timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        const cleanup = () => {
            clearTimeout(timer);
            socket.removeEventListener('open', onOpen);
            socket.removeEventListener('close', onClose);
            socket.removeEventListener('error', onError);
        };
        const onOpen = () => {
            cleanup();
            resolve(socket);
        };
        const onClose = () => {
            cleanup();
            reject(new CdpConnectError('unreachable', 'CDP socket closed before a response arrived'));
        };
        const onError = () => {
            cleanup();
            // The HTTP status of a refused upgrade is not surfaced by Node's WebSocket; a denied
            // Allow dialog and a dead endpoint both land here. Callers disambiguate with
            // probeDebuggingServer when they need to.
            reject(new CdpConnectError('unreachable', 'CDP connection failed before opening (Chrome may have stopped)'));
        };
        socket.addEventListener('open', onOpen);
        socket.addEventListener('close', onClose);
        socket.addEventListener('error', onError);
    });
}
class CdpSessionImpl {
    socket;
    responseTimeoutMs;
    pending = new Map();
    onMessage = (event) => this.handleMessage(event);
    onClose = () => {
        this.closed = true;
        this.rejectPending('CDP socket closed before a response arrived');
    };
    onError = () => {
        this.closed = true;
        this.rejectPending('CDP connection failed before a response arrived');
    };
    nextId = 1;
    closed = false;
    constructor(socket, responseTimeoutMs) {
        this.socket = socket;
        this.responseTimeoutMs = responseTimeoutMs;
        socket.addEventListener('message', this.onMessage);
        socket.addEventListener('close', this.onClose);
        socket.addEventListener('error', this.onError);
    }
    get isClosed() {
        return this.closed;
    }
    async getCookies() {
        const result = await this.request('Storage.getCookies', undefined);
        const cookies = typeof result === 'object' && result !== null
            ? result['cookies']
            : undefined;
        return mapCookieList(cookies);
    }
    async createTarget(url) {
        try {
            const result = await this.request('Target.createTarget', { url });
            if (typeof result !== 'object' || result === null)
                return false;
            const targetId = result['targetId'];
            return typeof targetId === 'string' && targetId !== '';
        }
        catch {
            return false;
        }
    }
    close() {
        const wasClosed = this.closed;
        this.closed = true;
        if (!wasClosed)
            this.rejectPending('CDP session closed before a response arrived');
        this.socket.removeEventListener('message', this.onMessage);
        this.socket.removeEventListener('close', this.onClose);
        this.socket.removeEventListener('error', this.onError);
        try {
            this.socket.close();
        }
        catch {
            // Best-effort: a broken socket needs no close handshake.
        }
    }
    request(method, params) {
        if (this.closed)
            return Promise.reject(new Error('CDP session is closed'));
        const id = this.nextId;
        this.nextId += 1;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`CDP did not answer ${method} within ${Math.round(this.responseTimeoutMs / 1000)}s`));
            }, this.responseTimeoutMs);
            this.pending.set(id, { method, resolve, reject, timer });
            try {
                const message = { id, method };
                if (params !== undefined)
                    message['params'] = params;
                this.socket.send(JSON.stringify(message));
            }
            catch {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new Error('CDP request could not be sent (the connection is not open)'));
            }
        });
    }
    handleMessage(event) {
        const message = parseCdpMessage(event.data);
        if (message === null)
            return;
        const pending = this.pending.get(message.id);
        if (pending === undefined)
            return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error !== undefined) {
            pending.reject(new Error(`CDP rejected the ${pending.method} request`));
            return;
        }
        pending.resolve(message.result);
    }
    rejectPending(reason) {
        const pending = [...this.pending.values()];
        this.pending.clear();
        for (const entry of pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error(reason));
        }
    }
}
/** Parses one websocket frame into the pieces of a CDP response; null when it is not one. */
function parseCdpMessage(data) {
    if (typeof data !== 'string')
        return null;
    let value;
    try {
        value = JSON.parse(data);
    }
    catch {
        return null;
    }
    if (typeof value !== 'object' || value === null)
        return null;
    const record = value;
    const id = record['id'];
    if (typeof id !== 'number')
        return null;
    return { id, error: record['error'], result: record['result'] };
}
function mapCookieList(raw) {
    if (!Array.isArray(raw))
        return [];
    const cookies = [];
    for (const entry of raw) {
        const cookie = mapCookie(entry);
        if (cookie !== null)
            cookies.push(cookie);
    }
    return cookies;
}
/** Maps one raw CDP cookie; keeps only string `name`/`value`, copies matching extras. */
function mapCookie(raw) {
    if (typeof raw !== 'object' || raw === null)
        return null;
    const record = raw;
    const name = record['name'];
    const value = record['value'];
    if (typeof name !== 'string' || name === '' || typeof value !== 'string')
        return null;
    const domain = optionalString(record['domain']);
    const path = optionalString(record['path']);
    const expires = optionalNumber(record['expires']);
    const httpOnly = optionalBoolean(record['httpOnly']);
    const secure = optionalBoolean(record['secure']);
    return {
        name,
        value,
        ...(domain === undefined ? {} : { domain }),
        ...(path === undefined ? {} : { path }),
        ...(expires === undefined ? {} : { expires }),
        ...(httpOnly === undefined ? {} : { httpOnly }),
        ...(secure === undefined ? {} : { secure }),
    };
}
function optionalString(value) {
    return typeof value === 'string' ? value : undefined;
}
function optionalNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function optionalBoolean(value) {
    return typeof value === 'boolean' ? value : undefined;
}
/** First non-empty, trimmed value among `names`; null when all are missing. */
function readEnvValue(env, ...names) {
    for (const name of names) {
        const value = (env[name] ?? '').trim();
        if (value !== '')
            return value;
    }
    return null;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
