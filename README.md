# uptodown-mcp

![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D%2020-brightgreen)
![TypeScript 7](https://img.shields.io/badge/TypeScript-7-3178c6?logo=typescript&logoColor=white)
![MCP: stdio](https://img.shields.io/badge/MCP-stdio-blue)
![Unofficial](https://img.shields.io/badge/uptodown-unofficial-critical)

> **Unofficial — not affiliated with, endorsed by, or supported by Uptodown.** It drives the internal
> API behind the Uptodown Developers Console (there is no public API): endpoints are undocumented,
> can change without notice, and may be rate limited. Use at your own risk.

An [MCP](https://modelcontextprotocol.io/) server that runs locally over stdio and lets an agent
manage **your own** Uptodown apps: descriptions, names, release notes, version files, screenshots,
icons, videos, comments and download stats.

## Requirements

- Node.js >= 20 (built and verified on v24).
- An Uptodown Developers Console account with apps of your own.
- Any MCP client that can run a local stdio server.

## Setup

```sh
npm install
npm run login   # capture a session once — see Authentication
npm run build
```

Register the server in your client (below), restart it and run `whoami` to check. Optional
read-only smoke test with real credentials: `npm run smoke`.

The server always starts: without auth, every tool answers with setup instructions instead of
failing to boot.

## Authentication

`UPTODOWN_AUTH_MODE` selects the mode (`auto` by default): **session** (a browser session captured
once with `npm run login`) or **password** (`UPTODOWN_EMAIL` + `UPTODOWN_PASSWORD`). `auto` prefers
a captured session and falls back to password.

### Capture a session once

```sh
npm run login
```

The helper captures the session itself, without you copying anything:

1. **Reuse** — a saved session that still authenticates is kept; nothing opens.
2. **Your Chrome** (144+) — it talks to the Chrome you already use. Chrome asks once per run to
   allow the debugging connection (**Allow**). One-time setup: enable remote debugging at
   `chrome://inspect/#remote-debugging`.
3. **Helper window** (fallback) — only when Chrome cannot be launched; you sign in once and it
   closes on capture.

| Flag | What it does |
| --- | --- |
| `--helper` | force the helper window (alias: `--playwright`) |
| `--manual` | capture by hand with DevTools "Copy as cURL" (never reuses the saved session) |
| `--force` | capture again even when the saved session still works |

Session sources, in priority order: `UPTODOWN_SESSION_COOKIE` (raw cookie header), then
`UPTODOWN_SESSION_FILE`, then `.uptodown-session.json` at the package root. A session never goes
stale on age — only its cookies matter, and each is dropped on load when it expires. A rejected
session is never silently replaced: in session mode you get an actionable "run `npm run login`"
error. Background in [`docs/api-map.md`](docs/api-map.md).

### Environment variables

| Variable | Description |
| --- | --- |
| `UPTODOWN_AUTH_MODE` | `auto` (default) \| `session` \| `password` |
| `UPTODOWN_SESSION_COOKIE` | Raw cookie header (`name=value; ...`); session mode |
| `UPTODOWN_SESSION_FILE` | Session JSON path; default `<package-root>/.uptodown-session.json` |
| `UPTODOWN_EMAIL`, `UPTODOWN_PASSWORD` | Password auth |
| `UPTODOWN_BASE_URL` | API base URL override; default `https://www.uptodown.dev` |
| `UPTODOWN_FILE_ROOT` | Confine local upload paths to this directory (unset: any path) |
| `UPTODOWN_CHROME_EXECUTABLE`, `UPTODOWN_CHROME_DATA_DIR` | `npm run login`: Chrome executable / user-data directory |
| `UPTODOWN_BROWSER_CHANNEL` | `--helper` only: browser channel (`chrome`, then `msedge`) |
| `UPTODOWN_LOGIN_TIMEOUT_MS` | `npm run login`: sign-in wait in ms (default 300000) |

Credentials stay in memory: the server never writes a session file, and values are redacted from
logs and errors. `.env.example` is a template — nothing loads `.env` automatically.

## Client configuration

Any stdio client works: the server answers every MCP protocol revision from `2024-10-07` through
`2025-11-25`, so OpenCode, Claude Code, Codex, Cursor, VS Code and friends all connect.

### Run from GitHub (no clone)

```sh
npx -y --allow-git=all github:Cayetano97/Uptodown-MCP
```

The first run clones and installs (about a minute); later runs start from the npm cache in about a
second. npm 12's `--allow-git=all` allows fetching the repository — older npm versions do not need
it. The compiled `dist/` is committed and CI fails when it drifts from `src/`, so the install does
not depend on build scripts running.

```json
{
  "mcpServers": {
    "uptodown": {
      "command": "npx",
      "args": ["-y", "--allow-git=all", "github:Cayetano97/Uptodown-MCP"]
    }
  }
}
```

That JSON is the common shape. Per client:

| Client | Change |
| --- | --- |
| Claude Code | `claude mcp add uptodown -- npx -y --allow-git=all github:Cayetano97/Uptodown-MCP` |
| VS Code (`.vscode/mcp.json`) | key is `servers`, not `mcpServers` |
| Codex (`~/.codex/config.toml`) | TOML: `command` and `args` at top level |

For session auth in this mode, capture once with
`npx -y --allow-git=all -p github:Cayetano97/Uptodown-MCP uptodown-mcp-login` and set
`UPTODOWN_SESSION_FILE` to a stable path (for example `~/.uptodown-session.json`) in both the
capture and the client's env block — under npx the package lives in the npm cache, so the default
location is not stable. Password auth needs no files at all.

### Local clone

OpenCode (`opencode.jsonc` or `~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "uptodown": {
        "type": "local",
        "command": ["node", "/absolute/path/to/uptodown-mcp/dist/index.js"]
      }
    }
  }
}
```

Replace the path with your own absolute path (Windows: `C:\\path\\to\\uptodown-mcp\\dist\\index.js`).
No `environment` block is needed with a captured session — it resolves from the package location,
not the working directory. For env-based auth add
`"environment": { "UPTODOWN_AUTH_MODE": "session", "UPTODOWN_SESSION_COOKIE": "{env:UPTODOWN_SESSION_COOKIE}" }`.

Check the connection with `opencode mcp list` (or `/mcps`). Protocol check without a client:

```sh
npx -y @modelcontextprotocol/inspector@latest --cli "node dist/index.js" --method tools/list
```

## Tools

Start with `whoami`, then `list_my_apps` (or `find_app_by_package` / `search_apps`) to get an
`appID`.

### Account and apps

| Tool | Purpose |
| --- | --- |
| `whoami` | Signed-in author profile |
| `update_profile_name` | Rename the author profile |
| `list_languages` | Languages and `languageID`s (`scope`: `all` or `active`) |
| `list_my_apps` | Your apps (name filter + page) and your total app count |
| `list_apps` | Raw console app table with filters |
| `find_app_by_package` | Resolve an Android package name to an app |
| `search_apps` | Search apps by name |
| `get_app_icon` | Icon information of an app |
| `get_app_media_summary` | Per-language screenshot/video inventory |

### Descriptions, names, release notes

| Tool | Purpose |
| --- | --- |
| `list_descriptions` | Per-language descriptions |
| `save_description` | Save short + full description (goes to review) |
| `generate_ai_description` | Queue Uptodown AI description generation |
| `set_app_name_all_languages` | Overwrite the app name in **all** languages |
| `get_release_notes` | Release notes of a version file in one language |
| `save_release_notes` | Save release notes for a file and language |

### Files and versions

| Tool | Purpose |
| --- | --- |
| `check_file_hash` | Duplicate check by sha256 (hash or local file) |
| `upload_app_file` | Upload APK/XAPK/AAB (sha256 computed locally, warnings surfaced) |
| `add_file_from_url` | Import from a remote URL (synchronous) |
| `add_file_from_url_async` | Queue a URL import; returns the correlation timestamp |
| `check_async_status` | Poll an async job (`sha256` + `time`; 204 = pending) |
| `save_file_metadata` | Version name, phase, min/max SDK |
| `delete_app_file` | Delete a version file (destructive) |

### Media

| Tool | Purpose |
| --- | --- |
| `list_screenshots` | Screenshots in one language |
| `upload_screenshots` | Upload one or more screenshots |
| `upload_feature_graphic` | Upload the feature graphic |
| `remove_screenshot` | Delete one screenshot (destructive) |
| `sort_screenshots` | Set the display order |
| `update_app_icon` | Replace the app icon |
| `save_video` | Attach a YouTube video for one language |

### Comments and stats

| Tool | Purpose |
| --- | --- |
| `list_app_comments` | User comments, paginated by `offset` (404 = none) |
| `reply_to_comment` | Post a public author reply |
| `get_downloads_daily` | Daily downloads by platform, language or country |
| `get_downloads_summary` | Summary table by app, platform, language or country |

Reads return the API `data`; mutations return the full envelope. Results are compact JSON prefixed
by a one-line summary and capped at 100,000 characters (a truncated result ends with an explicit
marker).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `npm run login` waits at "waiting for Chrome's debugging endpoint" | Enable remote debugging once at `chrome://inspect/#remote-debugging` (Chrome 144+). |
| `Chrome did not answer the debugging dialog` | Answer the **Allow** dialog (once per connection), or use `--helper`. |
| `Uptodown session expired or invalid` / `no usable session cookies were found` | Run `npm run login` again, then restart the server. |
| `Uptodown credentials are not configured` | Nothing set up yet: run `npm run login`, or set the session/password variables. |
| `--helper` times out or cannot launch a browser | Finish the sign-in in the window (2FA can take a while), or use `--manual`. |

Full list, including every manual-capture message: [`docs/troubleshooting.md`](docs/troubleshooting.md).

## Caveats

- **Unofficial API.** Paths and payloads mirror the console bundle at a point in time; if Uptodown
  changes the console, a tool can start returning `Uptodown API error [...]`. HTTP 429 is reported
  and **never retried** (only a stale cookie in password mode gets one re-login + retry).
- **Destructive and public writes take effect immediately.** `delete_app_file`, `remove_screenshot`,
  `set_app_name_all_languages`, `update_app_icon`, `update_profile_name`; `reply_to_comment`
  publishes a public reply; uploads publish files as soon as they return. Every tool reports
  `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` so clients can gate them.
- **Local upload paths are unrestricted by default.** Set `UPTODOWN_FILE_ROOT` to confine them.
- **Timeouts.** JSON calls abort after 90 s; uploads have no client-side timeout (large APKs).

## Development

```sh
npm run build   # tsc, NodeNext ESM, strict, output in dist/
npm test        # node:test over session + file-root
npm run start   # run the stdio server directly
```

Layout: `src/index.ts` boots the server; `src/client.ts` holds auth, HTTP and error mapping;
`src/session.ts` reads session sources; `src/chrome-attach.ts` + `src/login.ts` are the login
helper; `src/tools/*` registers the tools.

## License

[MIT](LICENSE)
