# Session renewal (v0.3.0)

The collector replays a Xiaomi console Cookie header. v0.3.0 makes a replaced session take effect without a restart and adds an **optional** laptop-side refresher that installs fresh platform cookies from a signed-in browser. Everything below about Xiaomi's sign-in behaviour is an **observation from one deployment, not vendor documentation or a guarantee**; the console API is undocumented and can change.

## Why

Xiaomi console authentication has two tiers:

- **Platform session** on `platform.xiaomimimo.com`: the cookies `api-platform_serviceToken`, `api-platform_slh`, `api-platform_ph` and `userId`. These authenticate `GET /api/v1/tokenPlan/{usage,detail}`. They are browser-session cookies; in one deployment Xiaomi rejected them server-side after **about 24 h**.
- **Account sign-in** on `account.xiaomi.com` (`passToken`, observed as a roughly 30-day sliding sign-in). When a signed-in browser loads the console after the platform session has ended, it passes through the account host and receives new platform cookies without a password prompt.

v0.2.x halted permanently after the first rejection, and its single-file bind mount hid an atomically replaced file until the container restarted. v0.3.0 changes both: the collector watches a mounted **directory** and resumes on its own, and the refresher lets the browser re-mint the platform session and copies only its four cookies to the collector host. `passToken` is never copied or forwarded.

## Data flow

```text
dedicated signed-in browser profile (laptop; DevTools on loopback only)
  │  one owned background tab loads the console; URL-scoped Network.getCookies
  ▼
refresher (Bun, systemd user timer, every 5 min)
  │  1. ssh: sudo -n docker exec <container> bun -e <fixed status script>   → collector status
  │  2. only if the collector reports auth_required (or --force): read 4 cookies, validate read-only
  │  3. ssh stdin: Cookie line + renewal-status.json → remote writer (atomic rename)
  ▼
collector host: dedicated owner-only directory (0700, owner = collector UID)
  │  mimo_session (0600)   renewal-status.json (0600)
  │  read-only DIRECTORY bind mount
  ▼
collector container → GET /v1/quota (+ sanitized session and renewal objects)
  ▼
native plugin (validated passthrough; quota.fetch guidance) → Plugins → Xiaomi Token Plan page
```

A run in detail:

1. **Status read.** Over ssh, `sudo -n docker exec <container> bun -e <script>`. The fixed script fetches `http://127.0.0.1:8787/v1/quota` inside the container (12 s) and prints only `error`, `stale`, `fetchedAt`, `session` and `renewal` — no Credits, account label or session material. Any failure (ssh, sudo, container, non-200, unparsable) ends the run as `collector_unreachable`; nothing is written.
2. **Decision.** Renewal is needed only when the collector reports `error: "auth_required"` (session rejected, missing or unusable) or with `--force`. Otherwise a `not_needed` heartbeat status is written and the browser is not touched.
3. **Browser.** `GET <XQ_CDP_URL>/json/version` (3 s, redirects refused) must name a `ws://` loopback `/devtools/browser/<id>` endpoint; the refresher connects to that path on the **configured** host, never a host named by the endpoint. It creates one `about:blank` background target, attaches to it, enables the Network domain on that session only and navigates to `https://platform.xiaomimimo.com/#/console/plan-manage`.
4. **Wait.** Up to 45 s for that tab's `GET /api/v1/tokenPlan/usage` to return 200. A top-level document on `account.xiaomi.com` (or a subdomain) that is not followed by another top-level document within 8 s counts as a sign-in page (`signin_required`); SSO pass-through that continues to the console still renews. A navigation error other than `net::ERR_ABORTED` is `vendor_unavailable`. If neither signal arrives within 45 s, the refresher still reads the cookies and lets validation decide.
5. **Cookies.** `Network.getCookies` with `urls: [https://platform.xiaomimimo.com/api/v1/tokenPlan/usage]`, then exactly the four names above on `xiaomimimo.com` or a subdomain. Other cookies returned for that URL are discarded. Missing or empty → `signin_required`; duplicates or values outside printable ASCII without space/`;` → `error`. The header is `name=value; …` in fixed order. The owned tab is closed in a `finally` block.
6. **Validation.** From the laptop, `GET usage` then `GET detail` with that Cookie, `Accept: application/json` and `x-timeZone: Europe/Kiev`; redirects refused, 10 s total, bodies capped at 1 MiB. HTTP 401/403 or body `code` 401/403 → `signin_required`; any other non-200, `code` ≠ 0 or transport failure → `vendor_unavailable`. Nothing is installed unless both succeed.
7. **Install.** One ssh call carries the Cookie line and the status JSON on stdin; the remote writer replaces `mimo_session`, then `renewal-status.json`. A blocked collector loads the new session within its session-check interval (15 s by default).

## Security model

- **What is copied.** Only the four platform cookies, selected by URL-scoped `Network.getCookies` plus an exact name/domain filter. Values exist only in refresher memory, the two validation requests to Xiaomi and ssh **stdin** — never argv, environment, laptop files, logs, the status file or the page. `passToken` and other sites' cookies are never selected, copied or forwarded.
- **What the DevTools stream can carry.** DevTools is all-or-nothing. With the Network domain enabled on its tab, Chrome also delivers that tab's raw request/response header events, which during an SSO pass-through can include account-host `Cookie`/`Set-Cookie` values such as `passToken` (reproduced with synthetic hosts; see [verification](verification.md)). The refresher reads only the fields it needs (event method, session/target IDs, response URL and status, resource type, frame ID) and does not store, log or forward event data.
- **Loopback DevTools only.** `XQ_CDP_URL` must be `http://` on `127.0.0.1`, `[::1]` or `localhost`. DevTools has **no authentication**: any local process that can reach that port controls the whole profile, including `passToken`, independent of this tool. Use a dedicated profile used only for the Xiaomi console, never a personal browsing profile, and never expose the port beyond loopback.
- **One owned tab.** The refresher creates one background target, never lists, activates or navigates other tabs, and closes its target in `finally`. A process killed before cleanup (for example by the unit's start timeout) can leave that tab open; close it by hand.
- **ssh.** `ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o ForwardAgent=no -o ForwardX11=no -o ClearAllForwardings=yes -- <user@host> <command>`: key authentication with an already trusted host key, no prompts, no forwarding. The child environment contains only `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG` and `SSH_AUTH_SOCK`; stderr is discarded (it may echo remote errors) and stdout over 64 KiB counts as failure. Remote command words are POSIX single-quoted. A dedicated key is recommended; OpenSSH's `restrict` key option fits because no PTY or forwarding is requested (not exercised by this repository's tests).
- **Remote writer** (`bash -c` with a fixed script, `umask 077`). It refuses a directory that is missing or a symlink (exit 3), not owned by the ssh user (4) or has any group/other permission bit (5). `push` requires one non-empty Cookie line of at most 16384 characters (6); the status must be 2–4096 bytes (7). Each file is written to a temporary file in the same directory, set to 0600 and renamed over the target (`mv -fT`), so readers see the old or the new file, never a partial one; temporary files are removed on exit. Requires bash and GNU coreutils (`stat -c`, `mktemp`, `head -c`, `mv -T`) on the collector host.
- **Remote privilege.** The status read always runs `sudo -n docker exec`. Passwordless sudo for Docker is root-equivalent on the collector host; restrict the sudoers rule to that exact command where possible. The writer itself needs no sudo.
- **Status file.** `renewal-status.json` has exactly the keys `schemaVersion` (1), `checkedAt`, `result`, `renewedAt`, `host` and `manualCommand` — no cookies, URLs, error text or vendor data. The collector opens it with `O_NOFOLLOW` and accepts only a regular file owned by its UID, without group/world write, at most 4096 bytes, strict UTF-8 JSON with the exact key set, a closed `result` enum, canonical UTC timestamps (`checkedAt` required, `renewedAt` or `null`), `host` matching `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` and `manualCommand` of 1–160 printable ASCII characters or `null`. An absent or invalid file reads as `renewal: null`. The plugin re-validates both objects and rejects the **whole** snapshot if either is invalid.
- **Displayed text.** The page renders `host` and `manualCommand` as text (the command in a `<code>` element), never as HTML or links. Whoever can write the session directory can still choose the bounded advice shown to operators; treat it as operator-trusted.
- **If the laptop or its DevTools port is compromised**, the attacker can read the full browser profile including `passToken` (this tool adds no protection there), push any session content and status to the collector host with the ssh key, and run whatever the ssh user may run there — including the Docker sudo rule. **If the collector host is compromised**, root and the collector UID can read the current platform cookies (about one day of console access in the observed deployment), but not `passToken`.

## Configuration

Environment only; no configuration file. Invalid values stop the run with exit 1 and a fixed message (`invalid configuration: …`) before any network or browser access; the rejected value is never echoed.

| Variable | Default | Validation |
| --- | --- | --- |
| `XQ_CDP_URL` | `http://127.0.0.1:9223` | `http:` with host `127.0.0.1`, `[::1]` or `localhost`, optional port; no credentials, path, query or fragment |
| `XQ_SSH_TARGET` | required | `user@host`; user `[A-Za-z0-9._-]+`, host `[A-Za-z0-9.-]+`; neither part may start with `-`. Set ports and keys in `~/.ssh/config` |
| `XQ_REMOTE_DIR` | required | Absolute path of `[A-Za-z0-9._/-]` without a `..` segment; the collector's session directory on the host |
| `XQ_COLLECTOR_CONTAINER` | required | `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}`; the actual container name for `docker exec` (Compose names containers `<project>-<service>-<n>` unless `container_name` is set) |
| `XQ_HOST_LABEL` | hostname, other characters → `-`, leading non-alphanumerics removed, 64 characters | `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`; shown on the page as the renewal host |
| `XQ_MANUAL_COMMAND` | none | 1–160 printable ASCII characters; shown verbatim on the page as the command to run on that host |

Empty `XQ_CDP_URL`, `XQ_HOST_LABEL` or `XQ_MANUAL_COMMAND` means unset. Flags: `--check` and `--force`; anything else is a usage error (exit 1). Timeouts and URLs are fixed: status ssh 25 s, write ssh 20 s, DevTools discovery and connect 3 s each, DevTools command 10 s, console load 45 s, sign-in grace 8 s, validation 10 s.

The refresher always writes the file names `mimo_session` and `renewal-status.json` in `XQ_REMOTE_DIR`. The collector's `MIMO_COOKIE_FILE` must therefore be `<mounted dir>/mimo_session`, with `RENEWAL_STATUS_FILE` at its default.

## Installation

Prerequisites:

- **Collector host:** a v0.3.0 collector with the directory mount from [deployment](deployment.md#session-directory-mount); an ssh user whose UID equals the collector's (1000 in the proposal) and who owns the 0700 session directory; bash and GNU coreutils; `sudo -n docker exec <container> …` permitted for that user.
- **Laptop:** Bun (1.3.14 is the tested version), the OpenSSH client with the host key already in `known_hosts`, and a dedicated Chrome profile started with a loopback `--remote-debugging-port` and signed in to the Xiaomi console. Recent Chrome versions refuse remote debugging on the default profile directory, so use a dedicated `--user-data-dir`.

Install a copy of `refresher/` (both files; `refresh-session.ts` imports `./lib`) and the example units:

```sh
install -d -m 700 ~/.local/share/xiaomi-session-refresh
install -m 600 refresher/lib.ts refresher/refresh-session.ts ~/.local/share/xiaomi-session-refresh/
install -d ~/.config/systemd/user
install -m 644 refresher/systemd/xiaomi-session-refresh.service \
  refresher/systemd/xiaomi-session-refresh.timer ~/.config/systemd/user/
```

Edit the service's `Environment=` placeholders (`XQ_SSH_TARGET`, `XQ_REMOTE_DIR`, `XQ_COLLECTOR_CONTAINER`, `XQ_CDP_URL`, `XQ_MANUAL_COMMAND`, optionally `XQ_HOST_LABEL`) and its `PATH` so `bun` resolves. `BatchMode=yes` needs an unencrypted key or an agent whose `SSH_AUTH_SOCK` is visible to the user manager (`systemctl --user import-environment SSH_AUTH_SOCK`, or an `Environment=` line). Then run once by hand before enabling the timer:

```sh
systemctl --user daemon-reload
systemctl --user start xiaomi-session-refresh.service
journalctl --user -u xiaomi-session-refresh.service -n 5 --no-pager
systemctl --user enable --now xiaomi-session-refresh.timer
```

The service is `Type=oneshot`, `TimeoutStartSec=120`, `NoNewPrivileges=yes`. The timer fires every 5 minutes (`OnCalendar=*:0/5`) with `Persistent=true`, so runs missed during suspend fire on resume. A failed run marks the service failed; the timer keeps firing. To upgrade, copy both files again. To remove, `systemctl --user disable --now xiaomi-session-refresh.timer` and delete the units and the copy.

## Operation

Manual run with the same environment: `systemctl --user start xiaomi-session-refresh.service`, or `bun ~/.local/share/xiaomi-session-refresh/refresh-session.ts [--check] [--force]`.

- `--check` reads the collector status and prints the decision only: no browser, no Xiaomi request, no write.
- `--force` renews even when the collector is healthy. A healthy collector reads the replaced file on its next 5-minute poll; a blocked one within the session-check interval.

Each run prints one line prefixed `xiaomi-session-refresh: ` — stdout on exit 0, stderr otherwise — as `<result> (<reason>; <context>)`, where context is `collector ok` or `collector <error>[ since <rejectedAt>]`, prefixed `forced; ` with `--force`. A failed status write appends `; status write failed: <reason>` (`remote session directory missing`, `… not owned by ssh user`, `… is group/world accessible`, `ssh failed`, or `remote exit <n>`). Failure statuses keep the previous `renewedAt` the collector reported.

| Result | Meaning | Exit |
| --- | --- | --- |
| `not_needed` | Collector not rejected; heartbeat status written. If that write fails the run exits 1 | 0 |
| `renewed` | Validated session and status installed | 0 |
| `check: not_needed` / `check: renewal needed` | `--check` decision only | 0 |
| `signin_required` | An account sign-in page stayed for 8 s, a required cookie is missing/empty, or Xiaomi rejected the browser's cookies | 2 |
| `browser_unavailable` | DevTools endpoint unreachable/invalid or connection lost | 1 |
| `vendor_unavailable` | Console navigation failed, or validation got a non-auth failure or timeout | 1 |
| `error` | Duplicate or malformed cookie, tab crash/detach, DevTools command failure, session push failure, unexpected failure | 1 |
| `collector_unreachable` | Status read failed (ssh, sudo, container, collector); nothing written | 1 |
| `invalid configuration: …` | Environment or flags invalid; no I/O | 1 |

## Collector behaviour

| `session.state` | Meaning | Xiaomi contact |
| --- | --- | --- |
| `unknown` | No verdict yet (startup, or only non-auth failures so far), or a replaced session whose first attempt failed for a non-auth reason | Every 300 s poll |
| `ok` | A fetch with this session succeeded; later non-auth failures keep `ok` and report their own error | Every 300 s poll |
| `expired` | Xiaomi returned HTTP 401/403 or body `code` 401/403 for this exact session content | Unchanged session: at most once per `AUTH_RETRY_INTERVAL_MS` |
| `missing` | Session file absent | Never |
| `invalid_file` | Not a regular file (or a symlink), not owned by the collector UID, any group/other permission bit, over 16 KiB, empty, or control characters | Never |

`expired`, `missing` and `invalid_file` are **blocked**: the snapshot reports `error: "auth_required"`, `stale: true` and keeps the last good pools.

- **Session check** (every `SESSION_CHECK_INTERVAL_MS`, default 15 s): always re-reads `renewal-status.json`; while blocked, also re-reads the session file and compares an in-memory fingerprint (device, inode, size, mtime and SHA-256 of the trimmed content). Any change triggers one immediate fetch, so a rename (even with identical content) or an in-place rewrite with new content is noticed. Fingerprints and content are never exposed.
- **Poll** (fixed 300 s tick): while blocked, skipped until `AUTH_RETRY_INTERVAL_MS` (default 1 h) has passed since the last vendor attempt, so an unchanged rejected session is retried at most once per interval, on the first tick after it elapses. A healthy collector re-reads the session file on every poll.
- After a replacement, a non-auth failure leaves the new content `unknown` (not rejected) and reports that error instead of `auth_required`.
- One stderr line per transition: `session state <from> -> <to>`; never secrets, bodies or error text.

`GET /v1/quota` adds:

- `session`: `state`; `updatedAt` (mtime of the observed regular file); `rejectedAt` (first rejection, or first observation of a missing/invalid file, for the current content; `null` unless blocked); `lastAttemptAt` (start of the last Xiaomi request); `nextAttemptAt` = `lastAttemptAt` + 300 s, or + `AUTH_RETRY_INTERVAL_MS` while blocked. `nextAttemptAt` is cadence-derived scheduling metadata, not a promise: attempts run on the poll tick, a replaced file is tried sooner, and a missing or invalid file is never sent.
- `renewal`: the validated status file without `schemaVersion`, or `null`.

| Variable | Default | Bounds |
| --- | --- | --- |
| `MIMO_COOKIE_FILE` | `/run/secrets/mimo_session` (v0.2.x single-file compatibility); the compose proposal sets `/run/secrets/xiaomi-quota/mimo_session` | Absolute path, no control characters |
| `RENEWAL_STATUS_FILE` | `renewal-status.json` beside `MIMO_COOKIE_FILE` | Absolute path, no control characters |
| `SESSION_CHECK_INTERVAL_MS` | `15000` | Whole milliseconds, 1000–3600000 |
| `AUTH_RETRY_INTERVAL_MS` | `3600000` | Whole milliseconds, 60000–86400000 |

A set but malformed value, including an empty one, stops the collector at start (exit 1).

## What the page shows and what to do

The page and `quota.fetch` errors are generated from the validated snapshot; a renewal report older than 15 minutes counts as stale.

| Refresher / collector | Page shows | Operator action |
| --- | --- | --- |
| `not_needed`, collector `ok` | Session OK; renewal agent last check and last renewal | None |
| Any recent result checked **before** `rejectedAt` | Session rejected; agent's next run should install a new session | Wait up to 5 min, or run it now |
| `renewed` after the rejection | New session installed, waiting for the collector | None; if it persists over a minute, check the directory mount and the file owner/mode |
| `signin_required` | Browser not signed in to Xiaomi | Sign in at the console in the renewal browser on that host, then rerun |
| `browser_unavailable` | Renewal browser not running | Start the dedicated browser (signed in), then rerun |
| `vendor_unavailable` | Agent could not reach Xiaomi | Usually transient; check that host's internet access |
| `error` | Agent failed unexpectedly | Read the unit journal, then rerun |
| `not_needed` after the rejection | Agent saw a healthy collector (race or clock difference) | Wait for the next run, or run it now |
| Report older than 15 min | Host likely asleep or timer stopped | Wake the host or restart its timer |
| `collector_unreachable` | Nothing new is written, so the last report ages into the stale row | Run `--check` on the laptop; check ssh, sudo, Docker and the container |
| No status file (`renewal: null`) | No renewal agent reporting | Install the refresher, or replace the session by hand |
| `missing` / `invalid_file` | Session file missing / unusable, with file requirements | Let the refresher push, or replace by hand; fix owner (collector UID) and mode (0600) |
| Collector before 0.3.0 (no `session`) | Legacy guidance | Replace the file and restart the collector; upgrade to 0.3.0 |

While the session is blocked and `manualCommand` is set, the page and `quota.fetch` add “Run on `<host>`: `<command>`”, except while a `renewed` session awaits pickup.

## Manual fallback

Install a session by hand on the collector host, as the user that owns the session directory (the collector UID). Use only the platform cookies as one Cookie header value (`api-platform_serviceToken=…; api-platform_slh=…; api-platform_ph=…; userId=…`), taken from a browser signed in to the Xiaomi console; never include `account.xiaomi.com` cookies. `read -rs` keeps the value out of argv, shell history and the terminal echo:

```sh
umask 077
d=/srv/xiaomi-quota/session   # the dedicated session directory
t=$(mktemp "$d/.mimo_session.XXXXXXXX")
IFS= read -rs c && printf '%s\n' "$c" > "$t"; unset c
chmod 600 "$t" && mv -fT "$t" "$d/mimo_session"
```

A blocked collector loads it within the session-check interval; no restart.

## Limitations

- Renewal happens only while the laptop is awake, the user's systemd manager and the timer are running, and the dedicated browser is running and signed in.
- Renewal is reactive: it starts after the collector reports a rejection. Each expiry leaves a stale window of up to one collector poll (5 min) to notice, up to one timer interval (5 min) to renew, plus run time and one session check (15 s). This is derived from the cadences, not measured.
- Cookie names, the about-24 h lifetime, silent re-minting through the account sign-in and the response codes are undocumented vendor behaviour observed in one deployment. Validation gates every install but cannot prevent future breakage.
- Sign-in detection is a heuristic (8 s grace on an account-host document; 45 s console wait). A slow SSO hop or a changed console can be misclassified as `signin_required` or `vendor_unavailable`; validation still prevents installing a rejected session.
- When the account sign-in lapses or Xiaomi requires interactive verification (password, MFA, captcha), someone must sign in again in the renewal browser. The refresher never enters credentials.
- The internal worst-case timeouts can exceed the unit's 120 s `TimeoutStartSec`; such a run is killed and may leave its tab open.
- One refresher configuration serves one collector and one session directory. A v0.2.x collector can be pushed to but does not reload without a restart.
