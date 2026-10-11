# AGENTS.md

Instructions for AI agents working with or using this repository.

## Using the server — do NOT clone

Register the MCP server with your client instead of copying this repository into the project you
are working on:

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

OpenCode shape:

```json
{
  "mcp": {
    "servers": {
      "uptodown": {
        "type": "local",
        "command": ["npx", "-y", "--allow-git=all", "github:Cayetano97/Uptodown-MCP"]
      }
    }
  }
}
```

Why no clone: the compiled `dist/` is committed, so the server needs no install or build step, and
a clone adds tens of megabytes, a second git repository and a duplicated session file to the caller's
project.

Authentication (pick one):

- Session, once: `npx -y --allow-git=all -p github:Cayetano97/Uptodown-MCP uptodown-mcp-login`,
  then set `UPTODOWN_SESSION_FILE` to a stable path (for example `~/.uptodown-session.json`) in
  both the capture and the server's env block — under npx the package lives in the npm cache, so
  the default location is not stable.
- Password: `UPTODOWN_AUTH_MODE=password` with `UPTODOWN_EMAIL` and `UPTODOWN_PASSWORD` — no files.

Without auth the server still starts: every tool answers with setup instructions. Always call
`whoami` first to confirm the session is alive. Client matrix (Claude Code, VS Code, Codex) lives
in `README.md` → *Install*.

## Working on the server

```sh
npm install
npm run build   # tsc -> dist/ (committed; npx installs run from it)
npm test        # node:test over session + file-root
npm run smoke   # optional read-only check with real credentials
```

Rules:

- Keep `dist/` in sync with `src/` and commit both — releases install from `dist/`.
- Never commit credentials: `.uptodown-session.json`, `.env`, `.uptodown-browser/`.
- The API is unofficial (Uptodown Developers Console): endpoints can change without notice and
  HTTP 429 is never retried. Destructive tools are flagged with `destructiveHint` in `tools/list`.

See `README.md` for the full tool list, auth modes and caveats.
