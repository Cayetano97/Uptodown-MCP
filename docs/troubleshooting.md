# Troubleshooting

Every known message of `uptodown-mcp`, `npm run login` and the MCP tools, and what to do about it.
The short list lives in the [README](../README.md#troubleshooting); this page has all of them.

## Login helper

| Symptom | Fix |
| --- | --- |
| `Already signed in as "…" — reused the captured session (…)` and nothing opens | Expected: the saved session still authenticates. Run `npm run login -- --force` (or `--helper` / `--manual`) to capture a fresh one anyway. |
| `Chrome did not answer the debugging dialog. …` | The **Allow** dialog was not answered in time. Run `npm run login` again and click **Allow**; Chrome asks once per connection, so every new run shows it again. |
| `Chrome's debugging server did not accept the connection. …` | Chrome is listening but refused the connection: the **Allow** dialog was dismissed or denied (it appears once per connection, with no "remember"). Run `npm run login` again and click **Allow** — or use `npm run login -- --helper`. |
| `The saved Chrome debugging endpoint is not responding — waiting for a fresh one.` | Normal recovery after a Chrome restart or crash left a stale `DevToolsActivePort`; the helper waits for a fresh endpoint. If it keeps happening, restart Chrome and confirm remote debugging is enabled at `chrome://inspect/#remote-debugging`. |
| `Chrome did not accept the debugging connection after 3 attempts. …` | Chrome kept refusing the endpoint. Restart Chrome, check the one-time toggle, or use `npm run login -- --helper`. |
| `waiting for Chrome's debugging endpoint (Ns). If remote debugging is off, enable it once at chrome://inspect/#remote-debugging.` | A launched Chrome is not publishing `DevToolsActivePort`: the one-time toggle is off. Enable it in Chrome (144+); the helper picks the endpoint up as soon as it appears. |
| `The session was not captured within Ns.` | Nothing was captured before the timeout; the message lists what to check: Chrome running in the profile you are signed in to, remote debugging enabled (one-time, it persists), **Allow** clicked. Retry, or use `--helper` / `--manual`. |
| `You are not signed in to … in Chrome yet — sign in in the page that just opened…` | Expected: the page was opened in your Chrome for the sign-in. Finish it there; the session is captured automatically. |
| `The session in Chrome looks stale — sign in again in the page that just opened…` | Chrome's Uptodown cookies were rejected; sign in again in the page that just opened. |
| `The connection to Chrome closed before the session was captured (Chrome was closed?).` | Chrome was closed while `npm run login` was waiting. Keep it open during the capture, then retry. |
| `Chrome was not found on this machine — using the helper browser window instead.` | No Chrome install was found at the standard location. Set `UPTODOWN_CHROME_EXECUTABLE` to its full path, or let the helper window finish the capture. |
| `Could not open Chrome — using the helper browser window instead.` | Chrome was found but could not be started (a bad `UPTODOWN_CHROME_EXECUTABLE`, a permission problem, or a broken install). Fix the path, or let the helper window finish the capture. |
| `The helper browser window was closed before the sign-in completed` | Expected when you close the window before signing in; run `npm run login` again when you are ready. |
| `npm run login -- --helper` times out | Finish the sign-in in the window that opened (Google/GitHub may ask for 2FA); if it keeps failing, use `npm run login -- --manual`. |
| `npm run login -- --helper` cannot launch a browser | Install Chrome or Edge, or set `UPTODOWN_BROWSER_CHANNEL`; or use `npm run login -- --manual`. |

## Manual capture (`--manual`)

| Symptom | Fix |
| --- | --- |
| `Could not find a cookie header in that text` | Copy the request again with DevTools → Network → right-click → **Copy as cURL**. A cURL line, a `cookie: …` header, `name=value; …`, Chrome's Windows `Copy as cURL (cmd)` output (with `^"` quotes) and multi-line pastes all work. |
| `That looks like the start of a cURL command without a cookie header yet` | Normal for a line-by-line paste: keep pasting the remaining lines (the cookie usually arrives in the `-b` line), then press Enter. `r` clears the accumulated text, `q` quits. |
| `No usable cookie header after 5 attempts` | Five pastes could not be parsed. Re-copy the request (right-click → Copy as cURL on a request to `www.uptodown.dev`) and run `npm run login -- --manual` again. |
| `The clipboard is empty` / clipboard unreadable | Copy the request again, or paste the cURL text directly at the prompt. |
| `Those cookies were rejected by Uptodown` | Make sure you are signed in in that browser and copied a request to `https://www.uptodown.dev` (not another site), then try again. |

## Server and session

| Symptom | Fix |
| --- | --- |
| `Uptodown session expired or invalid …` | Run `npm run login` again, then restart the MCP server. |
| `no usable session cookies were found` | The session file exists but every cookie expired (or the file is malformed); re-run `npm run login`. |
| `Uptodown credentials are not configured` | Nothing is set up yet: run `npm run login`, or set the session/password variables. |
