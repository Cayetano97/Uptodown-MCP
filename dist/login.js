#!/usr/bin/env node
/**
 * Session capture: `npm run login`.
 *
 * Default (browser-first): captures the Uptodown session with as little user action as possible:
 *   1. reuse a saved session that still works (live probe; skipped by `--force`, `--helper`
 *      and `--manual`),
 *   2. use the user's **real Chrome** through the sanctioned Chrome 144+ consent flow: when
 *      Chrome already runs with the one-time `chrome://inspect/#remote-debugging` toggle on,
 *      the helper connects to the browser websocket and captures the session as soon as it is
 *      signed in; when Chrome is not running, the helper launches it at the site and keeps
 *      watching the SAME live connection while the user signs in, opening the page there when
 *      no session exists yet,
 *   3. open a dedicated helper browser window (profile `.uptodown-browser/`) — only when Chrome
 *      cannot be launched on this machine: sign in once, the helper polls until the session
 *      lands, saves it and closes the window itself.
 *
 * `--helper` skips tiers 1 and 2. `--manual` keeps the hand capture: your normal browser plus
 * any DevTools "Copy as cURL", pasted or read from the clipboard (it never reuses the saved
 * session either). `--playwright` remains as an alias of `--helper`.
 *
 * Cookie VALUES are never printed or logged: only names, counts and file paths.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ATTACH_CONNECT_TIMEOUT_MS, connectFailureKind, cookiesForHost, launchChrome, openCdpSession, POLL_INTERVAL_MS, probeDebuggingServer, readDevToolsEndpoint, resolveChromeExecutable, resolveChromeUserDataDir, } from './chrome-attach.js';
import { DEFAULT_BASE_URL } from './client.js';
import { BROWSER_PROFILE_DIR_NAME, browserProfileDir, buildSessionFileContents, defaultSessionFilePath, parseCookieHeader, resolveSession, SESSION_COOKIE_ENV, SESSION_FILE_ENV, } from './session.js';
const DEFAULT_TIMEOUT_MS = 300_000;
const CLIPBOARD_TIMEOUT_MS = 5_000;
const LOGGED_DATA_PATH = '/developers/author/logged-data';
/** Consecutive failed attempts to connect to a Chrome debugging endpoint before giving up. */
const CHROME_ATTACH_MAX_ATTEMPTS = 3;
/** Silence after a line that marks the end of one pasted block. */
const PASTE_SETTLE_MS = 300;
/** Consecutive unparseable blocks that do not look like a partial cURL before giving up. */
const MAX_GUIDANCE_FAILURES = 5;
/** Safety bound for blocks that do look like a partial cURL: never cuts a long paste short. */
const MAX_INCOMPLETE_BLOCKS = 30;
/** How often the waiting flows print a progress line. */
const PROGRESS_INTERVAL_MS = 15_000;
const MANUAL_PROMPT = "Press Enter when the request is copied (or paste the cURL / cookie header; 'r' reset, 'q' quit): ";
/** Capture-source lines printed on success; they never contain cookie values. */
const MANUAL_CAPTURE_SOURCE = 'the cURL you copied from your normal browser';
const CHROME_BROWSER_SOURCE = 'your Chrome browser (the automation banner is gone now)';
const HELPER_CAPTURE_SOURCE = `the helper browser window (profile: ${BROWSER_PROFILE_DIR_NAME}/)`;
const execFileAsync = promisify(execFile);
function resolveContext() {
    const configured = (process.env['UPTODOWN_BASE_URL'] ?? '').trim();
    const baseUrl = (configured === '' ? DEFAULT_BASE_URL : configured).replace(/\/+$/, '');
    const origin = new URL(baseUrl).origin;
    const configuredTimeout = Number((process.env['UPTODOWN_LOGIN_TIMEOUT_MS'] ?? '').trim());
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? Math.floor(configuredTimeout) : DEFAULT_TIMEOUT_MS;
    const overrideChannel = (process.env['UPTODOWN_BROWSER_CHANNEL'] ?? '').trim();
    // Honor the same session file the client reads, so capture and use never disagree.
    const configuredSessionFile = (process.env[SESSION_FILE_ENV] ?? '').trim();
    return {
        origin,
        baseUrl,
        sessionFilePath: configuredSessionFile === '' ? defaultSessionFilePath() : configuredSessionFile,
        timeoutMs,
        headless: /^(1|true|yes)$/i.test((process.env['UPTODOWN_LOGIN_HEADLESS'] ?? '').trim()),
        channels: overrideChannel === '' ? ['chrome', 'msedge'] : [overrideChannel],
        skipBrowserOpen: /^(1|true|yes)$/i.test((process.env['UPTODOWN_LOGIN_NO_BROWSER'] ?? '').trim()),
    };
}
// ---------------------------------------------------------------------------
// Cookie header extraction (exported for tests)
// ---------------------------------------------------------------------------
/**
 * Extracts a normalized cookie header from text a user copied out of DevTools or pasted.
 *
 * Handles: bash cURL `-H 'cookie: ...'`, cmd cURL `-H "cookie: ..."` **and Chrome's Windows
 * `Copy as cURL (cmd)` format** (`-H ^"cookie: ...^"`, `-b ^"...^"`, `^` line continuations,
 * multi-line output), PowerShell `-Headers @{"cookie"="..."}` (with escaped quotes), a
 * standalone `cookie: name=value` line, and a raw `name=value; name2=value2` header.
 *
 * Returns `name=value; name2=value2`, or null when the text carries no usable cookie header.
 * Never throws, and never returns the input verbatim (values are re-serialized from parsed
 * pairs). Inner `^"`/`^` sequences that belong to a value are preserved as-is; only the
 * quoting delimiters around an argument are stripped.
 */
export function extractCookieHeader(text) {
    if (typeof text !== 'string' || text.trim() === '')
        return null;
    // cURL output is often multi-line: join it, dropping cmd (`^`) and bash (`\`) continuations.
    const joined = joinContinuedLines(text);
    const unescaped = joined.replace(/\\"/g, '"').replace(/\\'/g, "'");
    // 1. PowerShell "Copy as PowerShell"/cURL: -Headers @{"cookie"="a=b; c=d"}
    const powershellHeaders = /-headers\s+@?\{\s*["']cookie["']\s*=\s*["']([^"']*)["']/i.exec(unescaped);
    if (powershellHeaders?.[1] !== undefined) {
        const normalized = normalizeCookieHeader(powershellHeaders[1]);
        if (normalized !== null)
            return normalized;
    }
    // 2. cURL -H / --header whose value is the cookie header (any of the quoting forms)
    for (const value of readFlagArguments(joined, /(?:^|\s)(?:-h|--header)\s+/i)) {
        const cookiePart = /^\s*cookie\s*:\s*([^]*)$/i.exec(value);
        if (cookiePart?.[1] === undefined)
            continue;
        const normalized = normalizeCookieHeader(cookiePart[1]);
        if (normalized !== null)
            return normalized;
    }
    // 3. cURL -b / --cookie (Chrome's Windows "Copy as cURL" puts the session here)
    for (const value of readFlagArguments(joined, /(?:^|\s)(?:-b|--cookie)\s+/i)) {
        const normalized = normalizeCookieHeader(value);
        if (normalized !== null)
            return normalized;
    }
    // 4. A standalone "cookie: ..." line (case-insensitive), e.g. copied from the request headers
    for (const line of text.split(/\r?\n/)) {
        const standalone = /^\s*cookie\s*:\s*(.+)$/i.exec(line);
        if (standalone?.[1] !== undefined) {
            const normalized = normalizeCookieHeader(standalone[1]);
            if (normalized !== null)
                return normalized;
        }
    }
    // 5. A raw cookie header pasted on its own
    const firstLine = text.split(/\r?\n/).find((line) => line.trim() !== '');
    if (firstLine !== undefined) {
        const candidate = stripSurroundingQuotes(firstLine.trim());
        // Cookie names are RFC 6265 tokens: no separators (so no "/", quotes or braces), which
        // also keeps URLs, cURL lines and JSON blobs out of this branch.
        const looksLikeCookieHeader = !candidate.includes('://') && /^[^=;\s"'{}[\]/^\\]+=[^;]*(\s*;\s*[^=;\s"'{}[\]/^\\]+=[^;]*)*$/.test(candidate);
        if (looksLikeCookieHeader) {
            const normalized = normalizeCookieHeader(candidate);
            if (normalized !== null)
                return normalized;
        }
    }
    return null;
}
/** Joins cURL output into one line, stripping cmd (`^`) and bash (`\`) line continuations. */
function joinContinuedLines(text) {
    return text
        .split(/\r?\n/)
        .map((line) => line.replace(/\s*[\^\\]\s*$/, ''))
        .join(' ')
        .trim();
}
/**
 * Collects every argument that follows a flag, in any quoting form cURL/Chrome emits:
 * `'…'`, `"…"`, cmd-escaped `^"…^"`, or bare. Inner text is preserved verbatim (cmd `^"`
 * sequences inside a value belong to the value).
 */
function readFlagArguments(text, flagPattern) {
    const values = [];
    const pattern = new RegExp(flagPattern.source, `${flagPattern.flags.replace(/g/g, '')}g`);
    let match;
    while ((match = pattern.exec(text)) !== null) {
        const value = readArgumentValue(text.slice(match.index + match[0].length));
        if (value !== null && value !== '')
            values.push(value);
        if (pattern.lastIndex <= match.index)
            pattern.lastIndex = match.index + 1;
    }
    return values;
}
/** Reads one argument value (delimiters stripped, inner text untouched). */
function readArgumentValue(text) {
    const candidate = text.replace(/^\s+/, '');
    if (candidate === '')
        return null;
    if (candidate.startsWith('^"')) {
        const body = candidate.slice(2);
        const end = findClosingCaretQuote(body);
        return end === null ? body : body.slice(0, end);
    }
    const quote = candidate[0];
    if (quote === '"' || quote === "'") {
        const body = candidate.slice(1);
        const end = body.indexOf(quote);
        return end === -1 ? body : body.slice(0, end);
    }
    const end = candidate.search(/\s/);
    return end === -1 ? candidate : candidate.slice(0, end);
}
/** Index of the `^"` that closes a cmd-escaped value: the first one followed by whitespace/EOL. */
function findClosingCaretQuote(text) {
    const match = /\^"(?=\s|$)/.exec(text);
    return match === null ? null : match.index;
}
/** Strips surrounding `^"…^"`, `"…"` or `'…'` delimiters from a pasted value. */
function stripSurroundingQuotes(text) {
    if (text.startsWith('^"') && text.endsWith('^"') && text.length >= 4)
        return text.slice(2, -2);
    const first = text.slice(0, 1);
    if (text.length >= 2 && (first === '"' || first === "'") && text.endsWith(first)) {
        return text.slice(1, -1);
    }
    return text;
}
/** Re-serializes `name=value; ...` pairs, dropping anything malformed. */
function normalizeCookieHeader(value) {
    const jar = parseCookieHeader(value);
    if (jar.size === 0)
        return null;
    return [...jar].map(([name, cookieValue]) => `${name}=${cookieValue}`).join('; ');
}
// ---------------------------------------------------------------------------
// Clipboard + default browser
// ---------------------------------------------------------------------------
/** Reads the clipboard, or null when no clipboard tool is available/fails. */
async function readClipboard() {
    const platform = process.platform;
    const command = platform === 'win32' ? 'powershell' : platform === 'darwin' ? 'pbpaste' : 'xclip';
    const args = platform === 'win32'
        ? ['-NoProfile', '-Command', 'Get-Clipboard', '-Raw']
        : platform === 'darwin'
            ? []
            : ['-selection', 'clipboard', '-o'];
    try {
        const { stdout } = await execFileAsync(command, args, {
            timeout: CLIPBOARD_TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
        });
        return stdout;
    }
    catch {
        return null;
    }
}
/** Opens the URL in the user's default browser; never throws. */
function openInDefaultBrowser(context) {
    if (context.skipBrowserOpen)
        return;
    const url = `${context.baseUrl}/`;
    const platform = process.platform;
    const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
    const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try {
        const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false });
        child.on('error', () => undefined);
        child.unref();
    }
    catch {
        // The instructions tell the user to open the URL themselves if this fails.
    }
}
// ---------------------------------------------------------------------------
// Terminal input
// ---------------------------------------------------------------------------
/** Line reader that also works with piped stdin and reports EOF as null. */
class LineReader {
    input;
    lines = [];
    waiters = [];
    buffer = '';
    ended = false;
    constructor(input) {
        this.input = input;
        input.setEncoding('utf8');
        input.on('data', (chunk) => this.onData(chunk));
        input.on('end', () => this.onEnd());
    }
    read(prompt) {
        process.stdout.write(prompt);
        const queued = this.lines.shift();
        if (queued !== undefined)
            return Promise.resolve(queued);
        if (this.ended)
            return Promise.resolve(null);
        return new Promise((resolve) => {
            this.waiters.push(resolve);
        });
    }
    /** Like {@linkcode read}, but gives up after `ms` of silence (used to drain a paste block). */
    readWithin(ms) {
        const queued = this.lines.shift();
        if (queued !== undefined)
            return Promise.resolve(queued);
        if (this.ended)
            return Promise.resolve(null);
        return new Promise((resolve) => {
            const waiter = (line) => {
                clearTimeout(timer);
                resolve(line);
            };
            const timer = setTimeout(() => {
                const index = this.waiters.indexOf(waiter);
                if (index >= 0)
                    this.waiters.splice(index, 1);
                resolve(null);
            }, ms);
            this.waiters.push(waiter);
        });
    }
    close() {
        this.input.removeAllListeners('data');
        this.input.removeAllListeners('end');
        this.input.pause();
    }
    onData(chunk) {
        this.buffer += chunk;
        let index;
        while ((index = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, index).replace(/\r$/, '');
            this.buffer = this.buffer.slice(index + 1);
            this.deliver(line);
        }
    }
    onEnd() {
        this.ended = true;
        if (this.buffer !== '') {
            this.deliver(this.buffer.replace(/\r$/, ''));
            this.buffer = '';
        }
        while (this.waiters.length > 0)
            this.waiters.shift()?.(null);
    }
    deliver(line) {
        const waiter = this.waiters.shift();
        if (waiter === undefined)
            this.lines.push(line);
        else
            waiter(line);
    }
}
// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------
/** Returns the author name when the cookie header is accepted, otherwise null. */
async function probeIdentity(context, cookieHeader) {
    try {
        const response = await fetch(`${context.baseUrl}${LOGGED_DATA_PATH}`, {
            headers: { accept: 'application/json, text/plain, */*', cookie: cookieHeader },
            signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok)
            return null;
        const body = (await response.json());
        if (body.success !== 1)
            return null;
        const name = body.data?.name;
        return typeof name === 'string' && name !== '' ? name : '';
    }
    catch {
        return null;
    }
}
function saveSession(context, cookies, user) {
    const contents = buildSessionFileContents(cookies, user, new Date().toISOString());
    writeFileSync(context.sessionFilePath, `${JSON.stringify(contents, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}
/**
 * Checks whether a saved/configured session still authenticates against the live API.
 * Returns the identity behind it, or null when there is no session or it was rejected.
 */
export async function hasReusableSession(context) {
    const session = resolveSession(process.env).session;
    if (session === null)
        return null;
    const identity = await probeIdentity(context, session.cookieHeader);
    if (identity === null)
        return null;
    return {
        user: identity === '' ? (session.user ?? '') : identity,
        sourceLabel: session.label,
        capturedAt: session.capturedAt,
    };
}
function printSuccess(context, cookies, user, source) {
    process.stdout.write([
        '',
        user === null || user === '' ? 'Signed in.' : `Signed in as "${user}".`,
        `Captured ${cookies.length} cookie${cookies.length === 1 ? '' : 's'}: ${cookies.map((cookie) => cookie.name).join(', ')}`,
        `Captured from ${source}.`,
        `Session saved to ${context.sessionFilePath}`,
        'Restart the MCP server (or your MCP client) so it picks up the session.',
        '',
    ].join('\n'));
}
async function runAutoFlow(context, options) {
    if (!options.force) {
        const reusable = await hasReusableSession(context);
        if (reusable !== null) {
            const identity = reusable.user === '' ? '' : ` as "${reusable.user}"`;
            process.stdout.write(`Already signed in${identity} — reused the captured session (${reusable.sourceLabel}). Nothing to do. Use --force to capture again.\n`);
            return 0;
        }
        // A saved session that cannot be reused for a concrete reason (expired cookies, malformed
        // file) is worth saying out loud before capturing again.
        const sessionFailure = resolveSession(process.env).failure;
        if (sessionFailure !== null) {
            process.stdout.write(`${sessionFailure} Capturing a fresh one.\n`);
        }
    }
    if (!options.tryAttach)
        return runHelperFlow(context);
    const userDataDir = resolveChromeUserDataDir(process.env);
    if (userDataDir === null) {
        process.stdout.write('Could not locate your Chrome profile — using the helper browser window instead.\n');
        return runHelperFlow(context);
    }
    return runChromeBrowserFlow(context, userDataDir);
}
/**
 * Browser-first capture. Uses the user's Chrome (launching it when needed), opens the site
 * there, and keeps the SAME live connection open until the signed-in session appears.
 *
 * One connection per run: Chrome prompts for every new connection, so reconnecting would
 * re-prompt the user and lose the watch. The endpoint file is re-read on every attempt because
 * the port can change across Chrome restarts, and a stale endpoint is treated as a normal case.
 */
async function runChromeBrowserFlow(context, userDataDir) {
    const startedAt = Date.now();
    const deadline = startedAt + context.timeoutMs;
    let launched = false;
    let connectAttempts = 0;
    let staleNoticePrinted = false;
    let dialogTipPrinted = false;
    let lastWaitNoticeAt = 0;
    for (;;) {
        if (Date.now() >= deadline) {
            printAttachTimeoutGuidance(context);
            return 1;
        }
        const endpoint = await readDevToolsEndpoint(userDataDir);
        if (endpoint !== null) {
            if (!dialogTipPrinted) {
                dialogTipPrinted = true;
                process.stdout.write('Chrome will ask you to allow the debugging connection — click "Allow".\n');
            }
            connectAttempts += 1;
            let session;
            try {
                // Respect a short UPTODOWN_LOGIN_TIMEOUT_MS: never wait longer for the Allow dialog
                // than the caller is willing to wait overall (with a small floor so a nearly-expired
                // deadline still gives Chrome a chance to answer).
                const connectTimeoutMs = Math.min(ATTACH_CONNECT_TIMEOUT_MS, Math.max(5_000, deadline - Date.now()));
                session = await openCdpSession(endpoint.wsUrl, { connectTimeoutMs });
            }
            catch (error) {
                const kind = connectFailureKind(error);
                if (kind === 'timeout') {
                    // Do not spin more dialogs: the open one was not answered, and each retry re-prompts.
                    process.stderr.write('Chrome did not answer the debugging dialog. Click "Allow" in the Chrome window (it asks once per connection), then run "npm run login" again — or use --helper.\n');
                    return 1;
                }
                // Node's WebSocket hides the HTTP status of a refused upgrade, so a denied Allow dialog
                // and a stale endpoint look identical here. The preflight tells them apart: a port that
                // still answers HTTP is alive, so the refusal came from Chrome's consent gate — do not
                // reconnect (each attempt re-prompts) and do not relaunch Chrome.
                const serverAlive = await probeDebuggingServer(endpoint.port);
                if (serverAlive) {
                    process.stderr.write(`Chrome's debugging server did not accept the connection. If Chrome showed a permission dialog, click "Allow" — it appears once per connection. Run "npm run login" again, or use --helper.\n`);
                    return 1;
                }
                // Stale endpoint: Chrome stopped, restarted on another port, or the toggle is off and
                // the file is a leftover.
                if (!launched) {
                    launched = await openUserChrome(context);
                    if (!launched)
                        return runHelperFlow(context);
                }
                if (!staleNoticePrinted) {
                    staleNoticePrinted = true;
                    process.stdout.write('The saved Chrome debugging endpoint is not responding — waiting for a fresh one.\n');
                }
                if (connectAttempts >= CHROME_ATTACH_MAX_ATTEMPTS) {
                    process.stderr.write('Chrome did not accept the debugging connection after 3 attempts. Try again, or use --helper.\n');
                    return 1;
                }
                await sleep(POLL_INTERVAL_MS);
                continue;
            }
            const removeSigintHandler = installAttachSigintHandler(session);
            try {
                return await watchChromeSession(context, session, deadline);
            }
            finally {
                removeSigintHandler();
                session.close();
            }
        }
        if (!launched) {
            launched = await openUserChrome(context);
            if (!launched)
                return runHelperFlow(context);
            lastWaitNoticeAt = Date.now();
        }
        else if (Date.now() - lastWaitNoticeAt >= PROGRESS_INTERVAL_MS) {
            lastWaitNoticeAt = Date.now();
            const elapsed = Math.round((Date.now() - startedAt) / 1000);
            process.stdout.write(`  waiting for Chrome's debugging endpoint (${elapsed}s). If remote debugging is off, enable it once at chrome://inspect/#remote-debugging.\n`);
        }
        await sleep(POLL_INTERVAL_MS);
    }
}
/**
 * Opens the site in the user's Chrome so the sign-in can happen there.
 * Returns false (after explaining why) when Chrome cannot be used at all: the helper window
 * takes over in that case.
 */
async function openUserChrome(context) {
    const executable = resolveChromeExecutable(process.env);
    if (executable === null) {
        process.stdout.write('Chrome was not found on this machine — using the helper browser window instead.\n');
        return false;
    }
    const started = await launchChrome(executable, `${context.baseUrl}/`);
    if (!started) {
        process.stdout.write('Could not open Chrome — using the helper browser window instead.\n');
        return false;
    }
    process.stdout.write(`Opening your Chrome at ${context.origin} so you can sign in. The session is captured automatically once you are signed in.\n`);
    process.stdout.write('If the capture does not start, enable remote debugging once in Chrome at chrome://inspect/#remote-debugging — it stays enabled.\n');
    return true;
}
/**
 * Watches the live connection until the signed-in session appears (or the deadline passes).
 * When the profile has no usable Uptodown session yet, the site is opened in Chrome over the
 * same connection, so the user only has to sign in there.
 */
async function watchChromeSession(context, session, deadline) {
    const host = new URL(context.baseUrl).hostname;
    const startedAt = Date.now();
    let tabOpened = false;
    let notSignedInNoticePrinted = false;
    let lastProbedHeader = null;
    let lastProgressAt = startedAt;
    while (Date.now() < deadline) {
        let cookies;
        try {
            cookies = await session.getCookies();
        }
        catch {
            if (session.isClosed) {
                process.stderr.write('\nThe connection to Chrome closed before the session was captured (Chrome was closed?). Run "npm run login" again.\n');
                return 1;
            }
            await sleep(POLL_INTERVAL_MS);
            continue;
        }
        const sessionCookies = cookiesForHost(cookies, host);
        if (sessionCookies.length > 0) {
            const cookieHeader = sessionCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
            // Probe only when the cookies changed: a stale header is not worth hammering the API.
            if (cookieHeader !== lastProbedHeader) {
                lastProbedHeader = cookieHeader;
                const user = await probeIdentity(context, cookieHeader);
                if (user !== null) {
                    const records = sessionCookies.map(toSessionCookie);
                    saveSession(context, records, user === '' ? null : user);
                    session.close();
                    printSuccess(context, records, user === '' ? null : user, CHROME_BROWSER_SOURCE);
                    return 0;
                }
            }
        }
        if (!tabOpened) {
            tabOpened = true;
            try {
                await session.createTarget(`${context.baseUrl}/`);
            }
            catch {
                // Best-effort: the user can still open the page in Chrome themselves.
            }
        }
        if (!notSignedInNoticePrinted) {
            notSignedInNoticePrinted = true;
            process.stdout.write(lastProbedHeader === null
                ? `You are not signed in to ${context.origin} in Chrome yet — sign in in the page that just opened; the session is captured automatically.\n`
                : 'The session in Chrome looks stale — sign in again in the page that just opened; the session is captured automatically.\n');
        }
        await sleep(POLL_INTERVAL_MS);
        if (Date.now() - lastProgressAt >= PROGRESS_INTERVAL_MS) {
            lastProgressAt = Date.now();
            process.stdout.write(`  still waiting for the sign-in in Chrome (${Math.round((Date.now() - startedAt) / 1000)}s)\n`);
        }
    }
    process.stderr.write([
        '',
        `The signed-in session was not captured within ${Math.round(context.timeoutMs / 1000)}s.`,
        'Finish the sign-in in the Chrome window that opened, then run "npm run login" again — or use --helper / --manual.',
        '',
    ].join('\n'));
    return 1;
}
/** While the Chrome connection is open, Ctrl+C closes it best-effort and exits. */
function installAttachSigintHandler(session) {
    const onSigint = () => {
        process.stderr.write('\nInterrupted: closing the connection to Chrome...\n');
        session.close();
        process.exit(130);
    };
    process.on('SIGINT', onSigint);
    return () => {
        process.removeListener('SIGINT', onSigint);
    };
}
/** Chrome could not be used at all (no endpoint ever appeared, or no connection was accepted). */
function printAttachTimeoutGuidance(context) {
    process.stderr.write([
        '',
        `The session was not captured within ${Math.round(context.timeoutMs / 1000)}s.`,
        'Check that:',
        `  - Chrome is running with the profile where you are signed in to ${context.origin};`,
        '  - remote debugging is enabled once at chrome://inspect/#remote-debugging (it stays enabled);',
        '  - you clicked "Allow" in the debugging dialog.',
        'Run "npm run login" again, or use "npm run login -- --helper" / "--manual".',
        '',
    ].join('\n'));
}
/** Maps a CDP cookie to the session-file schema; `expires: -1` stays a session cookie. */
function toSessionCookie(cookie) {
    return {
        name: cookie.name,
        value: cookie.value,
        ...(cookie.domain === undefined ? {} : { domain: cookie.domain }),
        ...(cookie.path === undefined ? {} : { path: cookie.path }),
        ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
        ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
        ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
    };
}
// ---------------------------------------------------------------------------
// Manual flow (--manual): normal browser + clipboard capture
// ---------------------------------------------------------------------------
async function runManualFlow(context) {
    const reader = new LineReader(process.stdin);
    let buffer = '';
    let guidanceFailures = 0;
    let incompleteBlocks = 0;
    try {
        printManualInstructions(context);
        openInDefaultBrowser(context);
        process.stdout.write(context.skipBrowserOpen
            ? `Open ${context.baseUrl}/ in your browser if it is not already open.\n`
            : `Opened ${context.baseUrl}/ in your default browser.\n`);
        for (;;) {
            const block = await readBlock(reader);
            if (block === null) {
                printQuitGuidance(context);
                return 1;
            }
            const text = block.join('\n').trim();
            if (/^(q|quit|exit)$/i.test(text)) {
                printQuitGuidance(context);
                return 1;
            }
            if (/^(r|reset)$/i.test(text)) {
                buffer = '';
                guidanceFailures = 0;
                incompleteBlocks = 0;
                process.stdout.write('Cleared the pasted text.\n');
                continue;
            }
            let candidate = buffer === '' ? text : `${buffer}\n${text}`;
            if (text === '') {
                const clipboard = await readClipboard();
                if (clipboard === null) {
                    process.stdout.write('Could not read the clipboard on this system. Paste the cURL text or the cookie header directly instead.\n');
                    continue;
                }
                if (clipboard.trim() === '') {
                    process.stdout.write('The clipboard is empty. Copy the request as cURL in DevTools, then try again.\n');
                    continue;
                }
                candidate = buffer === '' ? clipboard : `${buffer}\n${clipboard}`;
            }
            const cookieHeader = extractCookieHeader(candidate);
            if (cookieHeader === null) {
                if (looksLikePartialCurl(candidate) && incompleteBlocks < MAX_INCOMPLETE_BLOCKS) {
                    incompleteBlocks += 1;
                    buffer = candidate;
                    process.stdout.write('That looks like the start of a cURL command without a cookie header yet — keep pasting, then press Enter again.\n');
                    continue;
                }
                guidanceFailures += 1;
                if (guidanceFailures >= MAX_GUIDANCE_FAILURES) {
                    printGiveUpGuidance(context, guidanceFailures);
                    return 1;
                }
                buffer = candidate;
                process.stdout.write(`Couldn't find a cookie header in that text (attempt ${guidanceFailures} of ${MAX_GUIDANCE_FAILURES}).\n` +
                    'Check that you copied a request to ' +
                    `${context.baseUrl} (DevTools -> Network -> right-click -> Copy as cURL).\n` +
                    "'r' clears the pasted text, 'q' quits.\n");
                continue;
            }
            const user = await probeIdentity(context, cookieHeader);
            if (user === null) {
                buffer = candidate;
                process.stdout.write('Those cookies were rejected by Uptodown (the request was not authenticated).\n' +
                    'Make sure you are signed in in the browser and copy a request to ' +
                    `${context.baseUrl} (not another site).\n`);
                continue;
            }
            const cookies = [...parseCookieHeader(cookieHeader)].map(([name, value]) => ({
                name,
                value,
            }));
            saveSession(context, cookies, user);
            printSuccess(context, cookies, user, MANUAL_CAPTURE_SOURCE);
            return 0;
        }
    }
    finally {
        reader.close();
    }
}
/** Reads one pasted block: the first line, then everything that arrives within the settle window. */
async function readBlock(reader) {
    const first = await reader.read(MANUAL_PROMPT);
    if (first === null)
        return null;
    const lines = [first];
    for (;;) {
        const next = await reader.readWithin(PASTE_SETTLE_MS);
        if (next === null)
            break;
        lines.push(next);
    }
    return lines;
}
/** True when the text may be the beginning of a cURL command the user is still pasting. */
function looksLikePartialCurl(text) {
    return /\bcurl\b/i.test(text) || /cookie/i.test(text) || /[\^\\]\s*$/.test(text);
}
function printManualInstructions(context) {
    process.stdout.write([
        '',
        'Capture your Uptodown session from your normal browser:',
        '',
        `  1. Sign in at ${context.baseUrl}/ with Google, GitHub or email (the browser opens next).`,
        '  2. Open DevTools (F12) and go to the Network tab.',
        '  3. Click any request to the site, right-click it, then Copy -> Copy as cURL.',
        '     "Copy as cURL (cmd)" works too: the ^" quoting and multi-line output are handled.',
        '  4. Come back here and press Enter: the helper reads the cookie from your clipboard.',
        '',
        '  Multi-line pastes are fine. Paste the whole command, or paste it line by line and',
        '  press Enter as you go: the helper keeps the text until it can read a cookie header.',
        "  'r' clears the pasted text, 'q' quits.",
        '',
    ].join('\n'));
}
function printGiveUpGuidance(context, attempts) {
    process.stderr.write([
        '',
        `No usable cookie header after ${attempts} attempts.`,
        'Run "npm run login" again when you are signed in, or set the session manually:',
        `  - ${SESSION_COOKIE_ENV}="name=value; name2=value2"`,
        `  - or a session file (${SESSION_FILE_ENV}, default ${context.sessionFilePath}).`,
        'See README.md ("Authentication") for details.',
        '',
    ].join('\n'));
}
function printQuitGuidance(context) {
    process.stderr.write([
        '',
        'Cancelled: no session captured.',
        'Sign in at ' + `${context.baseUrl}/` + ' in your browser, then run "npm run login" again.',
        '',
    ].join('\n'));
}
async function launchBrowser(context) {
    let chromium;
    try {
        ({ chromium } = await import('playwright-core'));
    }
    catch (error) {
        return { failures: [`  - playwright-core could not be loaded: ${describe(error)} (run "npm install" first)`] };
    }
    mkdirSync(browserProfileDir(), { recursive: true });
    const failures = [];
    for (const channel of context.channels) {
        try {
            const browser = await chromium.launchPersistentContext(browserProfileDir(), {
                channel,
                headless: context.headless,
                viewport: null,
                // playwright-core 1.63 no longer injects --enable-automation; keep both guards so the
                // one-time sign-in never sees an automation flag.
                ignoreDefaultArgs: ['--enable-automation'],
                args: ['--disable-blink-features=AutomationControlled'],
            });
            return { browser, channel };
        }
        catch (error) {
            failures.push(`  - channel "${channel}": ${describe(error)}`);
        }
    }
    return { failures };
}
async function captureWithHelper(context, browser) {
    let windowClosed = false;
    const onClose = () => {
        windowClosed = true;
    };
    browser.on('close', onClose);
    try {
        const pages = browser.pages();
        const page = pages[0] ?? (await browser.newPage());
        try {
            await page.goto(`${context.origin}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        }
        catch (error) {
            process.stdout.write(`Could not open ${context.origin}/ automatically (${describe(error)}). Open it manually in the browser window.\n`);
        }
        process.stdout.write([
            '',
            `A dedicated browser window is open at ${context.origin}/ (profile: ${BROWSER_PROFILE_DIR_NAME}/).`,
            'Sign in there with Google, GitHub or email; the window closes itself once the session is captured.',
            `Waiting up to ${Math.round(context.timeoutMs / 1000)}s for the sign-in...`,
            '',
        ].join('\n'));
        const deadline = Date.now() + context.timeoutMs;
        let polls = 0;
        while (Date.now() < deadline) {
            if (windowClosed)
                return { status: 'closed' };
            polls += 1;
            let cookies;
            try {
                cookies = await browser.cookies(context.baseUrl);
            }
            catch (error) {
                if (windowClosed || isContextClosedError(error))
                    return { status: 'closed' };
                throw error;
            }
            if (cookies.length > 0) {
                const header = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
                const identity = await probeIdentity(context, header);
                if (identity !== null) {
                    return {
                        status: 'captured',
                        user: identity === '' ? null : identity,
                        cookies: cookies.map((cookie) => ({
                            name: cookie.name,
                            value: cookie.value,
                            domain: cookie.domain,
                            path: cookie.path,
                            expires: cookie.expires,
                            httpOnly: cookie.httpOnly,
                            secure: cookie.secure,
                        })),
                    };
                }
            }
            if (polls % 5 === 0) {
                const elapsed = Math.round((Date.now() - (deadline - context.timeoutMs)) / 1000);
                process.stdout.write(`  still waiting for a signed-in session (${elapsed}s elapsed, ${cookies.length} cookies seen)\n`);
            }
            await sleep(POLL_INTERVAL_MS);
        }
        return { status: 'timeout' };
    }
    finally {
        browser.removeListener('close', onClose);
    }
}
/** True for playwright's "target closed" family of errors (window closed mid-poll). */
function isContextClosedError(error) {
    return error instanceof Error && /closed/i.test(error.message);
}
async function runHelperFlow(context) {
    const launched = await launchBrowser(context);
    if ('failures' in launched) {
        printPlaywrightFallback(['Could not launch a browser for the automated login helper.', 'Tried:', ...launched.failures].join('\n'));
        return 1;
    }
    const removeSigintHandler = installHelperSigintHandler(launched.browser);
    try {
        const outcome = await captureWithHelper(context, launched.browser);
        if (outcome.status === 'closed') {
            process.stderr.write('\nThe helper browser window was closed before the sign-in completed. Run "npm run login" again when you are ready.\n');
            return 1;
        }
        if (outcome.status === 'timeout') {
            process.stderr.write([
                '',
                `Login timed out after ${Math.round(context.timeoutMs / 1000)}s without a completed sign-in (channel: ${launched.channel}).`,
                'Finish the sign-in in the browser window, then run "npm run login" again.',
                '',
            ].join('\n'));
            return 1;
        }
        saveSession(context, outcome.cookies, outcome.user);
        printSuccess(context, outcome.cookies, outcome.user, HELPER_CAPTURE_SOURCE);
        return 0;
    }
    finally {
        removeSigintHandler();
        await launched.browser.close().catch(() => undefined);
    }
}
/** While the helper window is open, Ctrl+C closes it best-effort and exits. */
function installHelperSigintHandler(browser) {
    const onSigint = () => {
        process.stderr.write('\nInterrupted: closing the helper browser window...\n');
        const forceExit = setTimeout(() => process.exit(130), 5_000);
        forceExit.unref();
        void browser
            .close()
            .catch(() => undefined)
            .then(() => process.exit(130));
    };
    process.on('SIGINT', onSigint);
    return () => {
        process.removeListener('SIGINT', onSigint);
    };
}
function printPlaywrightFallback(reason) {
    process.stderr.write([
        '',
        reason,
        '',
        'Capture the session another way:',
        '  npm run login -- --manual     your normal browser + DevTools "Copy as cURL" (no helper window)',
        '',
        'Or set the session by hand:',
        `  - ${SESSION_COOKIE_ENV}="name=value; name2=value2"`,
        `  - or create a session file (${SESSION_FILE_ENV}, default ${defaultSessionFilePath()}) with:`,
        '    { "version": 1, "capturedAt": "<ISO date>", "user": "<name>",',
        '      "cookies": [ { "name": "...", "value": "..." } ] }',
        '',
        'See README.md ("Authentication") for details.',
        '',
    ].join('\n'));
}
// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
function printUsage() {
    process.stdout.write([
        '',
        'Usage: npm run login [-- --manual | --helper | --force]',
        '       npx uptodown-mcp-login [-- --manual | --helper | --force]',
        '',
        '  (default)  browser-first capture, in this order:',
        '             1. reuse the saved session when it still works (no browser opens);',
        '             2. use the Chrome you already have: the site opens there and the session',
        '                is captured as soon as you are signed in. Chrome asks once per run to',
        '                allow the debugging connection ("Allow"). One-time setup: enable',
        '                remote debugging at chrome://inspect/#remote-debugging (Chrome 144+)',
        '                — it stays enabled;',
        '             3. only when Chrome cannot be launched: a dedicated helper browser',
        '                window (one sign-in, self-closing).',
        '  --helper   capture again in the helper browser window (skips steps 1 and 2;',
        '             alias: --playwright).',
        '  --manual   capture by hand: your normal browser + DevTools "Copy as cURL", pasted or read',
        '             from the clipboard (skips the automatic capture entirely).',
        '  --force    capture again even when the saved session still works (implied by --helper',
        '             and --manual, which never reuse it).',
        '  -h, --help show this help.',
        '',
        'Environment: UPTODOWN_BASE_URL, UPTODOWN_LOGIN_TIMEOUT_MS, UPTODOWN_CHROME_EXECUTABLE,',
        '             UPTODOWN_CHROME_DATA_DIR, UPTODOWN_LOGIN_HEADLESS and UPTODOWN_BROWSER_CHANNEL',
        '             (helper window only), UPTODOWN_LOGIN_NO_BROWSER (--manual only).',
        '',
    ].join('\n'));
}
async function main() {
    const args = process.argv.slice(2);
    const wantsHelp = args.includes('--help') || args.includes('-h');
    const wantsManual = args.includes('--manual');
    const wantsHelper = args.includes('--helper') || args.includes('--playwright');
    const wantsForce = args.includes('--force');
    const knownFlags = new Set(['--help', '-h', '--manual', '--helper', '--playwright', '--force']);
    const unknownFlags = args.filter((arg) => !knownFlags.has(arg));
    if (wantsHelp) {
        printUsage();
        return;
    }
    if (unknownFlags.length > 0) {
        process.stderr.write(`login: unrecognized argument${unknownFlags.length === 1 ? '' : 's'}: ${unknownFlags.join(' ')}\n`);
        process.exitCode = 2;
        return;
    }
    if (wantsManual && wantsHelper) {
        process.stderr.write('login: pass either --manual or --helper, not both.\n');
        process.exitCode = 2;
        return;
    }
    const context = resolveContext();
    if (wantsManual) {
        // `--manual` never consults the saved session: the user asked for the cURL capture.
        process.exitCode = await runManualFlow(context);
        return;
    }
    process.exitCode = await runAutoFlow(context, {
        // An explicit `--helper` means "capture again", exactly like `--force`: skip the reuse tier.
        force: wantsForce || wantsHelper,
        tryAttach: !wantsHelper,
    });
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
// Only run when invoked as a CLI: importing this module (for the parser tests) must not
// start the interactive flow.
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
    void main()
        .catch((error) => {
        process.stderr.write(`login: failed: ${describe(error)}\n`);
        process.exitCode = 1;
    })
        .finally(() => exitAfterFlush());
}
/**
 * Deterministic CLI shutdown. Flushing both streams first keeps redirected output intact
 * (an empty write's callback runs after everything already queued), and the explicit
 * `process.exit` ends the process even when a teardown keeps a handle alive forever: an
 * unanswered CDP close handshake (silent or stopped peer) otherwise parks the event loop.
 */
async function exitAfterFlush() {
    try {
        await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
    }
    finally {
        process.exit(process.exitCode ?? 0);
    }
}
/** Resolves once `stream` flushed its prior writes, or after a short grace period. */
function flushStream(stream) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        timer.unref();
        try {
            stream.write('', () => {
                clearTimeout(timer);
                resolve();
            });
        }
        catch {
            clearTimeout(timer);
            resolve();
        }
    });
}
