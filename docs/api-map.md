# Uptodown Developers Console — Internal API Map

Reverse-engineered from the console's Angular bundle (`app.937f3b0b85ace28c.js`, analyzed 2026-09-29).
This is the API the official console UI itself calls. There is **no official public API** for the
Developers Console; treat this map as unofficial and subject to upstream change.

- **Base URL:** `https://www.uptodown.dev`
- **Auth:** session cookie. `POST /developers/author/login` (JSON `{mail, password}`) sets it;
  every subsequent request must send the cookie. Unauthenticated calls answer
  `401 {"success":0,"errorCode":-37,"errorMsg":"Editor cookie checking failed: Missing cookie"}`.
- **Response envelope:** `{"success": 0|1, "data": ..., "errorCode": ..., "errorMsg": ...}` (JSON)
- **Rate limiting:** HTTP 429 is handled by the console with a dedicated message. Keep call rates low.
- **Uploads:** multipart `FormData`; JSON body for a few endpoints (marked below).

## Verified request contracts

### Auth / account
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/developers/author/login` | JSON `{mail, password}` | 401 `{errorCode:-123}` = author not found; 429 = rate limited |
| GET | `/developers/author/logged-data` | — | `{success:1, data:{name,...}}`; session probe |
| POST | `/developers/author/logout` | — | |
| PUT | `/developers/author` | JSON `{name}` | update profile name |
| GET | `/developers/author/organizations` | — | |
| GET | `/developers/author/organization-info` | — | |

### Apps
| Method | Path | Params/body | Notes |
|---|---|---|---|
| GET | `/developers/author/app/list` | query params (e.g. `order`, `type`, `organizationWithPublishedApps`) | returns `data: []` of apps; on accounts with review privileges this is the review queue, NOT "my apps" |
| GET | `/developers/author/organization/apps` | query `{page?, query?}` | the console's "My apps" table: page starts at 1, `query` filters by name; 404 (`errorCode -35`) = no apps on that page; `page=0` is rejected |
| GET | `/developers/author/total-apps` | — | `{success:1, data:{total:N}}`; app count of the profile (console dashboard) |
| GET | `/developers/search/app/list` | query `packagename` | same-origin; console hook: `{packagename}` |
| GET | `/developers/organization/apps` | — | |
| GET | `/developers/app/{appID}/icon` | — | `{success, data}` icon info; 204 when none |
| GET | `/developers/screenshot-video-author/{appID}` | — | per-language screenshots/videos counts |
| POST | `/developers/app/{appID}/deactivate` | FormData | (payload built in console: appID + reason) |

### Descriptions / names / release notes
| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/developers/author/{appID}/description/list` | — | per-language descriptions (`languageID`, `language`, `url`, ...) |
| POST | `/developers/author/description/save` | JSON `{appID, languageID, authorShortDescription, authorFullDescription}` | goes under editorial review |
| POST | `/developers/description/generate-ai` | JSON `{appID}` | queues AI description generation |
| PUT | `/developers/app/saveNameAllLanguages` | JSON `{appID, name}` | overwrites name in ALL languages |
| GET | `/developers/author/file/{fileID}/language/{languageID}/news` | — | 204 = empty; else `{data:{news}}` |
| POST | `/developers/author/file/{fileID}/news/{languageID}` | JSON `{news}` | release notes for a version |

### Files / versions
| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/developers/file/check-exists-sha256` | query `sha256` | duplicate check |
| POST | `/developers/file/add-from-upload` | FormData `{appID, sha256, file, version?}` | sync upload; response may carry `data.warnings` |
| POST | `/developers/file/add-from-upload-async` | FormData `{file}` | async upload (big files) |
| GET | `/developers/file/async-status` | query `{sha256, time, url?}` | 204 pending; else `{success,data}` |
| POST | `/developers/file/add-from-url` | JSON `{url, useProxy}` | add from remote URL |
| POST | `/developers/author/file/save` | FormData `{fileID, appID, version, phaseID, minSDK, maxSDK}` | version metadata |
| POST | `/developers/file/save` | FormData (versionCode, minSDK, maxSDK, phase, languageID, downloadURL, filename, readyToUpload, ...) | editor-side file save (larger contract; see bundle) |
| POST | `/developers/app/file/delete` | FormData `{fileID, appID}` | delete a file |

### Media (screenshots, icon, video)
| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/developers/screenshot/getappscreenshots` | query `appID`, `languageID` | |
| POST | `/developers/screenshot/addappscreenshots` | FormData `{languageID, appID, multifile[]}` | multiple images |
| POST | `/developers/author/screenshot/feature` | FormData `{languageID, appID, multifile[]}` | feature graphic |
| POST | `/developers/screenshot/removeappscreenshot` | FormData `{screenshotID, appID}` | |
| POST | `/developers/screenshot/sortappscreenshots` | FormData `{appID, screenshotsID[]}` | order |
| POST | `/developers/screenshot/movetolanguage` | FormData `{appID, originLanguageID, targetLanguageID}` | |
| POST | `/developers/app/updateicon` | FormData `{appID, icon}` | |
| POST | `/developers/author/app/{appID}/video/save` | FormData `{appID, youtubeURL, languageID}` | |
| POST | `/developers/video` | FormData `{appID, youtubeID, description, title, languageID}` | editor-side |

### Comments
| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/developers/comments/{appID}` | query `offset` | author-facing comment list |
| POST | `/developers/comment/{commentID}/answer` | FormData `{replyText}` | author reply |
| GET | `/developers/moderation/comments` | query `{platformID, rating, appID, text, page, ...}` | editor moderation |

### Stats (query params to verify per endpoint in bundle before use)
| Path | Purpose |
|---|---|
| `/developers/stats/downloads/daily` | daily downloads |
| `/developers/stats/downloads/app-summary-table` | per-app summary |
| `/developers/stats/downloads/country-summary-table` | by country |
| `/developers/stats/downloads/language-summary-table` | by language |
| `/developers/stats/app-downloads/daily-by-country`, `/daily-by-language` | breakdowns |
| CSV variants: append `-csv` to several of the above | |

### Reference data
`/developers/languages`, `/developers/active-languages`, `/developers/all-languages`,
`/developers/category`, `/developers/licenses`, `/developers/development-stages`,
`/developers/distribution-models`, `/developers/distribution-details`, `/developers/device-types`,
`/developers/feature-tags`, `/developers/resources/platforms`, `/developers/resources/prefixes`

## Auth flows

Three ways in, all ending in the same session cookie. The MCP server supports the last two
(`session` mode reuses a captured cookie; `password` mode performs the JSON login).

### 1. Google Identity Services (Google accounts)

- The console loads Google Identity Services with the web `client_id`
  `72171959204-8b8ho4ps4p6ph28qdveb5j32rd592v1i.apps.googleusercontent.com`.
- The GIS callback POSTs `{accessToken}` to `https://www.uptodown.dev/developers/social-sign-up`
  (axios `withCredentials: false`); the backend validates the token and responds with the session
  cookie(s), exactly like a password login does.
- The sign-in view is the site root: the console route table maps `login: "/"`.
- **This flow cannot be reproduced outside a real browser.** Google restricts a web client ID to its
  authorized JavaScript origins (Uptodown's own site), so a headless script cannot obtain the token.
  That is why `npm run login` signs in (or reuses a signed-in session) in a real browser and captures
  the cookie instead of automating credentials. The same capture covers GitHub and email logins.

### 2. GitHub / social sign-up

Same shape as Google: the social callback hits `/developers/social-sign-up` and the backend sets the
session cookie(s). Provider-agnostic from this server's point of view.

### 3. Email + password (JSON)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/developers/author/login` | JSON `{mail, password}` | `withCredentials: false`; sets the session cookie(s); 401 `{errorCode:-123}` = author not found; 429 = rate limited |

### Session cookie reuse

Every subsequent request must send the captured cookie(s) in a `Cookie` header. An unauthenticated or
stale request answers:

```
401 {"success":0,"errorCode":-37,"errorMsg":"Editor cookie checking failed: Missing cookie"}
```

Cookie **names** observed in the wild for a signed-in author session: `uptodown_edi` (the author
session token) and `uptodown_admin_front` (a console flag). Chrome also copies Google's `g_state`
cookie alongside them; it is unrelated to Uptodown. Values are never documented, logged or committed —
only names.

The MCP server's behaviour on that answer depends on the auth mode: `password` re-logs in once and
retries once; `session` raises an actionable "run npm run login" error and never attempts a login.
Captured sessions live in `.uptodown-session.json` or in `UPTODOWN_SESSION_COOKIE`; expired cookies
are filtered before use, so freshness is decided by the cookies themselves — there is no age limit
on the capture file.

### Capturing the session cookie from a browser

`npm run login` (see the README) is browser-first and captures the session automatically:

1. **Reuse** — a saved session that still answers `logged-data` is kept; nothing opens.
2. **The user's Chrome (Chrome 144+)** — after the user enables remote debugging once at
   `chrome://inspect/#remote-debugging`, Chrome writes `DevToolsActivePort` (line 1: port, line 2:
   websocket path) into its user-data directory. The helper re-reads that file on every attempt
   (a stale endpoint or a changed port is a normal case), connects to `ws://127.0.0.1:<port><path>`
   with the built-in Node `WebSocket` and keeps ONE connection open: Chrome shows its
   per-connection consent dialog once. On that connection it calls CDP `Storage.getCookies`
   (keeping only cookies for the console host) and, when no signed-in session exists yet, opens the
   site in that same Chrome with `Target.createTarget` and keeps polling until the sign-in lands.
   When Chrome is not running, the helper launches it first (`UPTODOWN_CHROME_EXECUTABLE` override,
   standard-path detection). This is the only supported route into the default profile — Chrome
   136+ refuses `--remote-debugging-port` / pipe on it, and App-Bound Encryption (Chrome 127+)
   rules out direct cookie-database reads.
3. **Helper browser window** — only when Chrome cannot be launched: a dedicated
   `.uptodown-browser/` profile, one sign-in, cookies captured by polling `logged-data`. The
   window closes itself on capture.

By hand (`npm run login -- --manual`), every DevTools "Copy as cURL" flavour is supported, including
Chrome on Windows (`Copy as cURL (cmd)`), which escapes quotes as `^"`, ends lines with ` ^` and puts
the session cookie in a `-b` argument:

```
curl --url ^"https://www.uptodown.dev/developers/resources/platforms^" ^
  -H ^"accept: application/json, text/plain, */*^" ^
  -b ^"g_state=^{^\^"i_l^\^":0^}; uptodown_edi=<token>; uptodown_admin_front=3^" ^
  -H ^"priority: u=1, i^"
```

The parser strips the outer `^"` delimiters, joins continuation lines, and keeps inner `^"` sequences
that belong to a value, so the `-b` pairs reach the API intact. The helper also accumulates
line-by-line pastes across prompts, because a multi-line cURL is often pasted one line at a time.

## Items to confirm in the bundle before coding

1. Exact query params for `stats/downloads/daily` and `stats/downloads/app-summary-table`.
2. Exact params for `/developers/author/app/list` (which are safe pass-throughs).
3. `/developers/get-apps-by-name` params (alternative name search).
4. Full FormData field list of `/developers/file/save` (editor-side) — only needed if exposed.
5. Whether any endpoint the MCP wraps sets `XSRF-TOKEN` (axios default xsrf cookie) — bundle shows none.

## Bundle verification results (2026-09-29, second pass during implementation)

All of the above were re-checked against `app.937f3b0b85ace28c.js` before coding. Findings that change
or sharpen the map:

1. **There is no plain `stats/downloads/daily`.** The console only calls
   `stats/downloads/daily-platform`, `stats/downloads/daily-language` and `stats/downloads/daily-country`,
   all with `params: {since, until}` where both values are `Math.floor(date / 1000)` (unix **seconds**).
   The `get_downloads_daily` tool therefore takes a `groupBy` dimension instead of a single path.
2. **`stats/downloads/app-summary-table`** takes `platformID` (only when truthy) and `directoryID[]`
   (array built from the console's `optionId` values). The response payload is `data.data`.
   `platform-summary-table`, `language-summary-table` and `country-summary-table` take **no** params.
3. **`/developers/author/app/list`** is called with
   `{platformID, languageID, country, withAuthor, autoinsert, type, order}` — all defaulted to `null` and
   therefore omitted by axios — plus `organizationWithPublishedApps`, which is only sent when truthy and
   not `"0"`. Verified option values: `order` = `download-desc|download-asc|date-desc|date-asc|name-desc|name-asc`;
   `type` = `new|image|updated|description|video`; `withAuthor` = `1` (with author) or `3` (preregister);
   `autoinsert` = `1|0`.
4. **`/developers/get-apps-by-name`** takes `params: {name}` and answers 204 when there are no matches.
   The name-search tool is implemented against this endpoint (it is fully verified).
5. **`/developers/file/add-from-url` is NOT the only URL import.** Both flows exist and are implemented:
   - sync: `POST /developers/file/add-from-url` as **FormData** with
     `appID`, `controller=file`, `op=urlToFiles`, `downloadURL=<base64 of the UTF-8 URL>`, optional
     `version`, optional `useProxy=1`;
   - async: `POST /developers/file/add-from-url-async` as **JSON** `{url, useProxy}` (numeric, default `0`).
6. **`/developers/file/async-status`** params are `{sha256, time, url}` where `time` is
   `Math.round(Date.now() / 1000)` captured when the async job starts; the console polls it every 3 s and
   treats `204` as "still pending".
7. **`/developers/file/check-exists-sha256`** answers `success: 0` (not an HTTP error) when no file
   matches. The tool treats that as a normal "not found" answer rather than an API error.
8. **Comments list** is `GET /developers/comments/{appID}?offset=N`, reads `data.comments`, and the
   console treats **404 as "no comments"** (empty list). `POST /developers/comment/{commentID}/answer`
   sends FormData `{replyText}`.
9. **Descriptions**: the author-facing save is `POST /developers/author/description/save` (JSON
   `{appID, languageID, authorShortDescription, authorFullDescription}`); the similarly named
   `POST /developers/description/save` is the editor-side endpoint and is not exposed.
10. **No XSRF anywhere.** Confirmed again: no `xsrf`/`X-XSRF-TOKEN` handling in the bundle's HTTP layer,
    so cookie-only auth is sufficient.
11. **"My apps" is not `/developers/author/app/list`.** On accounts with review privileges that
    endpoint returns the review queue with every filter variant, while the console's "My apps"
    table uses `author/organization/apps`
    (`{appID, name, platformName, publishedDate, lastUpdate, status, url, version, iconURL}`) and the
    dashboard count comes from `author/total-apps` (`{total}`). The MCP exposes `list_my_apps` for the
    profile table and documents `list_apps` as the raw console table.


Bundle copy for grep: download the console's bundle asset once and keep the copy outside the repo
(it is a hashed JS file served by the site) for searching request contracts.
