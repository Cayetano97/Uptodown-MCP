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

/** A live CDP endpoint published by a running Chrome. */
export interface DevToolsEndpoint {
  readonly port: number;
  readonly path: string;
  readonly wsUrl: string;
}

/**
 * Parses the contents of `DevToolsActivePort`. Pure.
 *
 * Line 1 must be an integer port in `1..65535`, line 2 a non-empty path starting with `/`.
 * CRLF, a trailing newline and blank lines around the pair are tolerated; anything else
 * (including extra non-blank lines) returns null.
 */
export function parseDevToolsActivePort(contents: string): { port: number; path: string } | null {
  const lines = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length !== 2) return null;

  const portLine = lines[0];
  const pathLine = lines[1];
  if (portLine === undefined || pathLine === undefined) return null;
  if (!/^\d+$/.test(portLine)) return null;

  const port = Number(portLine);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (!pathLine.startsWith('/')) return null;

  return { port, path: pathLine };
}

/**
 * Resolves the Chrome user-data directory to look for `DevToolsActivePort` in.
 *
 * `UPTODOWN_CHROME_DATA_DIR` wins when set (returned as-is); otherwise the standard location
 * for the platform is used. Null when nothing can be resolved. Existence is not checked here.
 */
export function resolveChromeUserDataDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const override = readEnvValue(env, 'UPTODOWN_CHROME_DATA_DIR');
  if (override !== null) return override;

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
export async function readDevToolsEndpoint(userDataDir: string): Promise<DevToolsEndpoint | null> {
  let contents: string;
  try {
    contents = await readFile(join(userDataDir, DEVTOOLS_ACTIVE_PORT_FILE), 'utf8');
  } catch {
    return null;
  }

  const parsed = parseDevToolsActivePort(contents);
  if (parsed === null) return null;
  return {
    port: parsed.port,
    path: parsed.path,
    wsUrl: `ws://127.0.0.1:${parsed.port}${parsed.path}`,
  };
}

/** The subset of a CDP `Network.Cookie` this module keeps. */
export interface CdpCookie {
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly path?: string;
  readonly expires?: number;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
}

/** The websocket handshake waits for the user's "Allow" click in Chrome. */
export const ATTACH_CONNECT_TIMEOUT_MS = 60_000;
/** How long to wait for one CDP command answer once connected. */
export const ATTACH_RESPONSE_TIMEOUT_MS = 15_000;

/**
 * Why a CDP connection attempt failed:
 * - `timeout`: the socket did not open in time (Chrome's Allow dialog is pending or ignored),
 * - `unreachable`: the endpoint is stale, Chrome is not listening, or the connection was
 *   refused. Node's WebSocket does not expose the HTTP status of a refused upgrade, so a denied
 *   Allow dialog and a dead endpoint look identical here; callers use
 *   {@linkcode probeDebuggingServer} to tell them apart.
 */
export type CdpConnectFailureKind = 'timeout' | 'unreachable';

/** An {@linkcode openCdpSession} connect failure carrying its {@linkcode CdpConnectFailureKind}. */
export class CdpConnectError extends Error {
  readonly kind: CdpConnectFailureKind;

  constructor(kind: CdpConnectFailureKind, message: string) {
    super(message);
    this.name = 'CdpConnectError';
    this.kind = kind;
  }
}

/**
 * Reads the failure kind off any error; null when the error did not come from a connection
 * attempt (a plain `Error` from a command, for example).
 */
export function connectFailureKind(error: unknown): CdpConnectFailureKind | null {
  if (error instanceof CdpConnectError) return error.kind;
  if (typeof error === 'object' && error !== null) {
    const kind = (error as { readonly kind?: unknown }).kind;
    if (kind === 'timeout' || kind === 'unreachable') return kind;
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
export async function probeDebuggingServer(
  port: number,
  timeoutMs: number = DEBUGGING_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/**
 * One open connection to a Chrome browser endpoint.
 *
 * Chrome prompts for every NEW connection (there is no "remember"), so a caller that needs
 * more than one command must reuse the same session: reconnect attempts re-prompt the user
 * and lose the previous answer.
 */
export interface CdpSession {
  /** `Storage.getCookies`, mapped to the local cookie shape. */
  getCookies(): Promise<readonly CdpCookie[]>;
  /** `Target.createTarget`; true when Chrome answered with a `targetId`, false otherwise. */
  createTarget(url: string): Promise<boolean>;
  /** Best-effort close: pending requests reject and {@linkcode isClosed} turns true. */
  close(): void;
  readonly isClosed: boolean;
}

/**
 * Opens one CDP session, waiting for the user to answer Chrome's Allow dialog.
 *
 * Rejects with a {@linkcode CdpConnectError} (check {@linkcode connectFailureKind}) when the
 * connection cannot be established. The returned session multiplexes requests over that single
 * websocket and stops answering once it is closed.
 */
export async function openCdpSession(
  wsUrl: string,
  options?: { readonly connectTimeoutMs?: number; readonly responseTimeoutMs?: number },
): Promise<CdpSession> {
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
export async function captureCookiesOverCdp(
  wsUrl: string,
  options?: { readonly connectTimeoutMs?: number; readonly responseTimeoutMs?: number },
): Promise<readonly CdpCookie[]> {
  const session = await openCdpSession(wsUrl, options);
  try {
    return await session.getCookies();
  } finally {
    session.close();
  }
}

/** Keeps only cookies that apply to `host`: exact domain or a dotted domain suffix of it. */
export function cookiesForHost(cookies: readonly CdpCookie[], host: string): readonly CdpCookie[] {
  const normalizedHost = host.trim().toLowerCase();
  if (normalizedHost === '') return [];

  return cookies.filter((cookie) => {
    if (typeof cookie.domain !== 'string') return false;
    const domain = cookie.domain.trim().toLowerCase().replace(/^\./, '');
    if (domain === '') return false;
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
export function resolveChromeExecutable(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const override = readEnvValue(env, 'UPTODOWN_CHROME_EXECUTABLE');
  if (override !== null) return override;

  return chromeExecutableCandidates(env, platform).find((candidate) => existsSync(candidate)) ?? null;
}

function chromeExecutableCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): readonly string[] {
  switch (platform) {
    case 'win32': {
      const roots = [
        readEnvValue(env, 'PROGRAMFILES', 'ProgramFiles'),
        readEnvValue(env, 'PROGRAMFILES(X86)', 'ProgramFiles(x86)'),
        readEnvValue(env, 'LOCALAPPDATA', 'LocalAppData'),
      ];
      return roots
        .filter((root): root is string => root !== null)
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
export function launchChrome(exePath: string, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exePath, [url], { detached: true, stdio: 'ignore', windowsHide: false });
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    child.once('error', () => {
      if (settled) return;
      settled = true;
      resolve(false);
    });
    child.once('spawn', () => {
      if (settled) return;
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
export async function waitForDevToolsEndpoint(
  userDataDir: string,
  deadlineMs: number,
  onTick?: (elapsedMs: number) => void,
): Promise<DevToolsEndpoint | null> {
  const startedAt = Date.now();
  while (Date.now() < deadlineMs) {
    const endpoint = await readDevToolsEndpoint(userDataDir);
    if (endpoint !== null) return endpoint;
    onTick?.(Date.now() - startedAt);
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

/** Opens the browser websocket, classifying a failure so the caller can react. */
function connectSocket(wsUrl: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      reject(new CdpConnectError('unreachable', 'CDP connection could not be started (invalid websocket URL)'));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      try {
        socket.close();
      } catch {
        // The socket is already unusable; there is nothing else to clean up.
      }
      reject(new CdpConnectError('timeout', `CDP connection timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
    };
    const onOpen = (): void => {
      cleanup();
      resolve(socket);
    };
    const onClose = (): void => {
      cleanup();
      reject(new CdpConnectError('unreachable', 'CDP socket closed before a response arrived'));
    };
    const onError = (): void => {
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

/** One in-flight CDP request, resolved or rejected by id when its answer arrives. */
interface PendingRequest {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

class CdpSessionImpl implements CdpSession {
  private readonly socket: WebSocket;
  private readonly responseTimeoutMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly onMessage = (event: MessageEvent): void => this.handleMessage(event);
  private readonly onClose = (): void => {
    this.closed = true;
    this.rejectPending('CDP socket closed before a response arrived');
  };
  private readonly onError = (): void => {
    this.closed = true;
    this.rejectPending('CDP connection failed before a response arrived');
  };
  private nextId = 1;
  private closed = false;

  constructor(socket: WebSocket, responseTimeoutMs: number) {
    this.socket = socket;
    this.responseTimeoutMs = responseTimeoutMs;
    socket.addEventListener('message', this.onMessage);
    socket.addEventListener('close', this.onClose);
    socket.addEventListener('error', this.onError);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async getCookies(): Promise<readonly CdpCookie[]> {
    const result = await this.request('Storage.getCookies', undefined);
    const cookies =
      typeof result === 'object' && result !== null
        ? (result as Record<string, unknown>)['cookies']
        : undefined;
    return mapCookieList(cookies);
  }

  async createTarget(url: string): Promise<boolean> {
    try {
      const result = await this.request('Target.createTarget', { url });
      if (typeof result !== 'object' || result === null) return false;
      const targetId = (result as Record<string, unknown>)['targetId'];
      return typeof targetId === 'string' && targetId !== '';
    } catch {
      return false;
    }
  }

  close(): void {
    const wasClosed = this.closed;
    this.closed = true;
    if (!wasClosed) this.rejectPending('CDP session closed before a response arrived');

    this.socket.removeEventListener('message', this.onMessage);
    this.socket.removeEventListener('close', this.onClose);
    this.socket.removeEventListener('error', this.onError);
    try {
      this.socket.close();
    } catch {
      // Best-effort: a broken socket needs no close handshake.
    }
  }

  private request(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('CDP session is closed'));

    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP did not answer ${method} within ${Math.round(this.responseTimeoutMs / 1000)}s`));
      }, this.responseTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });

      try {
        const message: Record<string, unknown> = { id, method };
        if (params !== undefined) message['params'] = params;
        this.socket.send(JSON.stringify(message));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('CDP request could not be sent (the connection is not open)'));
      }
    });
  }

  private handleMessage(event: MessageEvent): void {
    const message = parseCdpMessage(event.data);
    if (message === null) return;

    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.error !== undefined) {
      pending.reject(new Error(`CDP rejected the ${pending.method} request`));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectPending(reason: string): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
  }
}

interface CdpMessage {
  readonly id: number;
  readonly error: unknown;
  readonly result: unknown;
}

/** Parses one websocket frame into the pieces of a CDP response; null when it is not one. */
function parseCdpMessage(data: unknown): CdpMessage | null {
  if (typeof data !== 'string') return null;

  let value: unknown;
  try {
    value = JSON.parse(data) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;

  const record = value as Record<string, unknown>;
  const id = record['id'];
  if (typeof id !== 'number') return null;

  return { id, error: record['error'], result: record['result'] };
}

function mapCookieList(raw: unknown): readonly CdpCookie[] {
  if (!Array.isArray(raw)) return [];
  const cookies: CdpCookie[] = [];
  for (const entry of raw) {
    const cookie = mapCookie(entry);
    if (cookie !== null) cookies.push(cookie);
  }
  return cookies;
}

/** Maps one raw CDP cookie; keeps only string `name`/`value`, copies matching extras. */
function mapCookie(raw: unknown): CdpCookie | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const record = raw as Record<string, unknown>;
  const name = record['name'];
  const value = record['value'];
  if (typeof name !== 'string' || name === '' || typeof value !== 'string') return null;

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

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** First non-empty, trimmed value among `names`; null when all are missing. */
function readEnvValue(env: NodeJS.ProcessEnv, ...names: readonly string[]): string | null {
  for (const name of names) {
    const value = (env[name] ?? '').trim();
    if (value !== '') return value;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
