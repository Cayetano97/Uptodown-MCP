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

- Node.js >= 20, and any stdio MCP client
- An Uptodown Developers Console account with apps of your own.

## Install

**Paste this into your AI agent** (Claude Code, Cursor, Copilot, OpenCode, Codex…). One click to
copy, and it registers the server for you instead of cloning the repo:

```text
Add the "uptodown" MCP server to this AI client:

  command: npx
  args:    ["-y", "--allow-git=all", "github:Cayetano97/Uptodown-MCP"]

Register it as "uptodown" and run it remotely through npx — do NOT clone, copy or npm install
this repository into my project: dist/ is already committed and npx runs it from the npm cache.
Once registered, call the "whoami" tool to confirm it works.
```

**Do it yourself instead:** one click, one line, or the JSON below.

[![Add to VS Code](https://img.shields.io/badge/VS_Code-Install_MCP-007ACC?logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522uptodown%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522--allow-git%253Dall%2522%252C%2522github%253ACayetano97%252FUptodown-MCP%2522%255D%257D)
[![Add to Cursor](https://img.shields.io/badge/Cursor-Install_MCP-black?logo=cursor&logoColor=white)](https://cursor.com/link/anysphere.cursor-deeplink/mcp/install?name=uptodown&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi0tYWxsb3ctZ2l0PWFsbCIsImdpdGh1YjpDYXlldGFubzk3L1VwdG9kb3duLU1DUCJdfQ)

| Client | Command |
| --- | --- |
| Claude Code | `claude mcp add uptodown -- npx -y --allow-git=all github:Cayetano97/Uptodown-MCP` |
| Codex | `codex mcp add uptodown -- npx -y --allow-git=all github:Cayetano97/Uptodown-MCP` |
| OpenCode | `opencode mcp add uptodown -- npx -y --allow-git=all github:Cayetano97/Uptodown-MCP` |

Or paste this into any client that reads `mcpServers` (Claude Desktop and friends; VS Code's
`.vscode/mcp.json` wants the key `servers`, Codex wants `command` + `args` at the top level of
its TOML):

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

First run installs (≈1 min), later runs start from the npm cache. `--allow-git=all` is required by
npm 12; older npm ignores it. The server speaks protocol revisions `2024-10-07`…`2025-11-25` and
always boots: without auth every tool answers with setup instructions.

Now [authenticate](#authentication) and run `whoami` as the first tool call.

## Authentication

Two modes, chosen by `UPTODOWN_AUTH_MODE` (`auto` by default): **session** (captured once, below)
or **password** (`UPTODOWN_EMAIL` + `UPTODOWN_PASSWORD`). `auto` prefers the session.

### Capture a session once

```sh
npm run login                                   # from a clone
npx -y --allow-git=all -p github:Cayetano97/Uptodown-MCP uptodown-mcp-login   # no clone
```

The helper does everything itself: it reuses a session that still works, otherwise attaches to your
running Chrome 144+ (answer **Allow** once per run; one-time setup: enable remote debugging at
`chrome://inspect/#remote-debugging`) and only if Chrome is unusable opens a helper window you sign
in to once.

| Flag | What it does |
| --- | --- |
| `--helper` | force the helper window (alias: `--playwright`) |
| `--manual` | capture by hand with DevTools "Copy as cURL" (never reuses the saved session) |
| `--force` | capture again even when the saved session still works |

Session file lookup: `UPTODOWN_SESSION_COOKIE` → `UPTODOWN_SESSION_FILE` → `.uptodown-session.json`
at the package root. Cookies are dropped on load when they expire; a rejected session never falls
back silently — you get an actionable error. **Under npx the package lives in the npm cache, so set
`UPTODOWN_SESSION_FILE` to a stable path (e.g. `~/.uptodown-session.json`) both when capturing and
in the client's env.** Details: [`docs/api-map.md`](docs/api-map.md).

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

## Local clone

Only for working on the server itself — to *use* it, see [Install](#install). OpenCode
(`opencode.jsonc` or `~/.config/opencode/opencode.jsonc`):

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

Use your own absolute path (Windows: `C:\\path\\to\\uptodown-mcp\\dist\\index.js`). No
`environment` block is needed with a captured session; for env auth add
`"environment": { "UPTODOWN_AUTH_MODE": "session", "UPTODOWN_SESSION_COOKIE": "{env:UPTODOWN_SESSION_COOKIE}" }`.

Check the connection with `opencode mcp list` (or `/mcps`); protocol check without a client:

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

Full list: [`docs/troubleshooting.md`](docs/troubleshooting.md). On the npx install (no clone),
`npm run login` above means the npx login command from [Authentication](#authentication).

## Caveats

- **Unofficial API.** Endpoints mirror the console bundle at a point in time: `Uptodown API error
  [...]` means it changed. HTTP 429 is reported and **never retried** (one re-login + retry only
  for a stale cookie in password mode).
- **Destructive and public writes take effect immediately.** `delete_app_file`, `remove_screenshot`,
  `set_app_name_all_languages`, `update_app_icon`, `update_profile_name`; `reply_to_comment`
  publishes a public reply; uploads publish files as soon as they return. Every tool reports
  `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` so clients can gate them.
- **Local upload paths are unrestricted by default.** Set `UPTODOWN_FILE_ROOT` to confine them.
- **Timeouts.** JSON calls abort after 90 s; uploads have no client-side timeout (large APKs).

## Development

```sh
npm install
npm run build   # tsc, NodeNext ESM, strict, output in dist/
npm test        # node:test over session + file-root
npm run start   # run the stdio server directly
npm run login   # capture a session once — see Authentication
```

`dist/` is committed and must stay in sync with `src/` (`npm run build`, then commit both): npx
installs run from `dist/`. Optional read-only smoke test with real credentials: `npm run smoke`.

Layout: `src/index.ts` boots the server · `src/client.ts` auth, HTTP and errors · `src/session.ts`
session sources · `src/chrome-attach.ts` + `src/login.ts` login helper · `src/tools/*` tools.
Rules for AI agents touching the repo: [`AGENTS.md`](AGENTS.md).

## License

[MIT](LICENSE)
