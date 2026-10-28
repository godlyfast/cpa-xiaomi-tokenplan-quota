# Session renewal (v0.3.0)

The collector replays a Xiaomi console Cookie header. v0.3.0 makes a replaced session take effect without a restart and adds an **optional** laptop-side refresher that installs fresh platform cookies from a signed-in browser. Everything below about Xiaomi's sign-in behaviour is an **observation from one deployment, not vendor documentation or a guarantee**; the console API is undocumented and can change.

## Why

Xiaomi console authentication has two tiers:

- **Platform session** on `platform.xiaomimimo.com`: the cookies `api-platform_serviceToken`, `api-platform_slh`, `api-platform_ph` and `userId`. These authenticate `GET /api/v1/tokenPlan/{usage,detail}`. They are browser-session cookies; in one deployment Xiaomi rejected them server-side after **about 24 h**.
- **Account sign-in** on `account.xiaomi.com` (`passToken`, observed as a roughly 30-day sliding sign-in). When a signed-in browser loads the console after the platform session has ended, it passes through the account host and receives new platform cookies without a password prompt.

v0.2.x halted permanently after the first rejection, and its single-file bind mount hid an atomically replaced file until the container restarted. v0.3.0 changes both: the collector watches a mounted **directory** and resumes on its own, and the refresher lets the browser re-mint the platform session and copies only its four cookies to the collector host, and only for the Xiaomi account (`userId`) the collector already uses. `passToken` is never copied or forwarded, and the refresher never enables DevTools network monitoring, so cookie headers do not reach it as events either.

## Data flow

```text
dedicated browser profile, signed in only to the bound Xiaomi account (laptop; DevTools on loopback only)
  │  one owned background tab loads the console: Page events + a boolean readiness poll
  │  (Network domain never enabled); then a URL-scoped Network.getCookies command
  ▼
refresher (Bun, systemd user timer, every 5 min; whole run capped at 100 s)
  │  1. ssh: sudo -n docker exec <container> bun -e <fixed status script>   → collector status
  │  2. only if the collector reports auth_required (or --force): read 4 cookies, validate read-only
  │  3. ssh stdin: Cookie line + renewal-status.json → remote writer
  │     (same-userId check unless --rebind, then atomic rename)
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

1. **Status read.** Over ssh, `sudo -n docker exec <container> bun -e <script>`. The fixed script fetches `http://127.0.0.1:8787/v1/quota` inside the container (12 s) and prints only `error`, `stale`, `fetchedAt`, `session` and `renewal`: no Credits, account label or session material. Any failure (ssh, sudo, container, non-200, unparsable, stdout over 64 KiB) ends the run as `collector_unreachable`; nothing is written.
2. **Decision.** Renewal is needed only when the collector reports `error: "auth_required"` (session rejected, missing or unusable) or with `--force`. Otherwise a `not_needed` heartbeat status is written and the browser is not touched. A normal run against a healthy collector, like `--check`, therefore never exercises the browser, cookie, validation or install path; only `--force` (or a real rejection) does.
3. **Browser.** `GET <XQ_CDP_URL>/json/version` (redirects refused) must name a `ws://` loopback `/devtools/browser/<id>` endpoint; the refresher connects to that path on the **configured** host, never a host named by the endpoint. Discovery and socket open share one 3 s budget. It creates one `about:blank` background target, attaches to it, enables only the **Page** domain on that session (never `Network.enable`) and navigates to `https://platform.xiaomimimo.com/#/console/plan-manage`.
4. **Wait.** Up to 45 s for the console to be ready. Every 250 ms the refresher evaluates a fixed expression in the tab (`Runtime.evaluate`) that can only return a boolean: whether the tab's Resource Timing entries contain the usage API URL (`https://platform.xiaomimimo.com/api/v1/tokenPlan/usage`, same origin and path) with response status 200. The sign-in check uses main-frame `Page.frameNavigated` events, which report committed navigations only (redirect hops do not commit): a main-frame document on `account.xiaomi.com` (or a subdomain) not followed within 8 s by a main-frame document on another host counts as a sign-in page (`signin_required`); SSO pass-through that continues to the console still renews. A navigation error other than `net::ERR_ABORTED` is `vendor_unavailable`. If neither signal arrives within 45 s, the refresher still reads the cookies and lets validation decide.
5. **Cookies.** `Network.getCookies` (a command, which works without enabling the Network domain) with `urls: [https://platform.xiaomimimo.com/api/v1/tokenPlan/usage]`, then exactly the four names above on `xiaomimimo.com` or a subdomain. Other cookies returned for that URL are discarded. Missing or empty → `signin_required`; duplicates, values outside printable ASCII without space/`;`, or a header that is not 1–16384 printable ASCII characters (0x20–0x7E) → `error`. The header is `name=value; …` in fixed order. The owned tab is closed in a `finally` block (2 s).
6. **Validation.** From the laptop, `GET usage` then `GET detail` with that Cookie, `Accept: application/json` and `x-timeZone: Europe/Kiev`; redirects refused, 10 s for both, bodies capped at 1 MiB. HTTP 401/403 or body `code` 401/403 → `signin_required`; any other non-200, `code` ≠ 0 or transport failure → `vendor_unavailable`. Nothing is installed unless both succeed.
7. **Install.** One ssh call carries the Cookie line and the status JSON on stdin. A normal run uses the writer's `push` mode: it replaces `mimo_session` only if the installed file holds exactly one `userId` cookie and it equals the new session's. Otherwise that call writes nothing, the run reports `account_mismatch` (exit 3) through a separate status-only write, and the installed session stays as it was. `--rebind` uses `rebind` mode, which skips the comparison. On success the writer replaces `mimo_session`, then `renewal-status.json`. A blocked collector loads the new session within its session-check interval (15 s by default); a healthy one on its next 5-minute poll.

## Account binding

The collector's account binding (`ACCOUNT_LABEL`, `ACCOUNT_BINDING_CONFIRMED=true` and the plugin's `auth_index`) is a one-time operator check. Whatever account the renewal browser is signed in to is the account whose cookies the refresher would install. To keep renewals from silently switching accounts, the remote writer compares the `userId` cookie of the new session with the one in the installed `mimo_session`:

- **Renewals keep the binding.** A normal run (timer or manual) installs only a session with the same `userId`. If the installed file is missing, a symlink, larger than 16386 bytes, not printable ASCII, or does not contain exactly one non-empty `userId`, the comparison is impossible and the run also reports `account_mismatch`. The collector and the plugin do not compare accounts themselves.
- **Use a browser profile signed in only to the bound account.** If the renewal browser is signed in to a different Xiaomi account, nothing is visible while the current session is healthy, because normal runs do not open the browser. After the next rejection, every run loads the console, validates that other account's cookies with Xiaomi, sends them over ssh stdin to the writer, and the writer refuses them before creating any file. The result is `account_mismatch`, the session file is unchanged, and the collector stays blocked (quota unavailable) until someone signs the renewal browser into the bound account or deliberately rebinds. The page and `quota.fetch` say so.
- **First install or a deliberate account switch.** Run the refresher once by hand with `--rebind` (add `--force` if the collector is currently healthy; `--rebind` does not imply it). Then set `ACCOUNT_LABEL` for the new account, reconfirm `ACCOUNT_BINDING_CONFIRMED` and the plugin's `auth_index` for it, and redeploy the collector. The timer never passes `--rebind`; never add it to the unit.

The check compares the vendor's `userId` cookie value only. It guards against mistakes and a mis-signed-in browser, not against a compromised laptop: the refresher's ssh key can run the writer in `rebind` mode.

## Security model

- **What is copied.** Only the four platform cookies, selected by URL-scoped `Network.getCookies` plus an exact name/domain filter. Values exist only in refresher memory, the two validation requests to Xiaomi and ssh **stdin**: never argv, environment, laptop files, logs, the status file or the page. On the collector host the writer keeps them in shell variables and builtins (never argv or output) until it writes `mimo_session`. `passToken` and other sites' cookies are never selected, copied or forwarded.
- **What the DevTools connection sees.** The refresher never enables the Network domain, so Chrome sends it no request or response events and no `Cookie`/`Set-Cookie` headers. `passToken` and other sites' cookies therefore do not reach the refresher through DevTools events. The only cookie data it receives is the `Network.getCookies` reply for the usage URL. What remains is the **Page** domain on its own tab. Page events carry, with full query strings, the URLs of navigations that tab starts (`Page.frameRequestedNavigation`, `frameScheduledNavigation`, `frameStartedNavigating`) and of documents it commits (`Page.frameNavigated`). Server-side redirect hops are not reported. If an SSO page forwards to its callback by script, the callback URL, including a one-time ticket in its query, therefore reaches the refresher process. The refresher reads only the main-frame hostname from `Page.frameNavigated` and stores, logs and forwards nothing from events. The readiness poll returns only a boolean. Synthetic Chrome 156 runs showed zero `Network.*` events and no cookie value or `Set-Cookie` in any event, and the ticket only in those three navigation events when the account page forwarded by script (see [verification](verification.md#synthetic-devtools-observation)). This narrows what the refresher process sees. It does not narrow what the DevTools port grants (next bullet).
- **Loopback DevTools only.** `XQ_CDP_URL` must be `http://` on `127.0.0.1`, `[::1]` or `localhost`. DevTools has **no authentication**: any local process that can reach that port controls the whole profile, including `passToken`, independent of this tool. Use a dedicated profile used only for the Xiaomi console and signed in only to the bound account ([account binding](#account-binding)), never a personal browsing profile, and never expose the port beyond loopback.
- **One owned tab.** The refresher creates one background target, never lists, activates or navigates other tabs, and closes its target in `finally`. On SIGTERM, SIGINT or SIGHUP (a unit stop, systemd's start timeout, Ctrl-C or a closed terminal) it closes the owned tab at once (bounded by 2 s), starts no further browser step, Xiaomi validation request or status write, and exits 143, 130 or 129. If the signal arrives while `Target.createTarget` is unanswered, it waits for that reply (at most the 10 s command timeout) and closes the late tab, so the exit can take up to about 13 s. An ssh write already running is not killed. Only SIGKILL (for example after `TimeoutStopSec`) or a browser that answers `createTarget` more than 10 s late can leave the tab open; close it by hand.
- **ssh.** `ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o ForwardAgent=no -o ForwardX11=no -o ClearAllForwardings=yes -- <user@host> <command>`: key authentication with an already trusted host key, no prompts, no forwarding. The child environment contains only `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG` and `SSH_AUTH_SOCK`. stderr is discarded (it may echo remote errors). stdout is counted while it is read: as soon as it passes 64 KiB, ssh is killed and the call counts as failed, so a hostile remote cannot make the refresher buffer more. Remote command words are POSIX single-quoted. A dedicated key is recommended; OpenSSH's `restrict` key option fits because no PTY or forwarding is requested (not exercised by this repository's tests).
- **Remote writer** (`bash -c` with a fixed script, `umask 077`, `LC_ALL=C`, so lengths are bytes). Exit codes:
  - **3:** relative path; a path containing `//`, `/./` or `/../` or ending in `/`; directory missing or a symlink.
  - **4:** directory not owned by the ssh user.
  - **5:** directory has any group/other permission bit.
  - **6:** `push` and `rebind` need one Cookie line of 1–16384 printable ASCII bytes (0x20–0x7E) containing exactly one non-empty `userId=` cookie.
  - **7:** the status must be 2–4096 bytes.
  - **8:** `push` also needs the existing `mimo_session` to be a regular file (not a symlink) of at most 16386 bytes without NUL bytes. Its content, trimmed of ASCII whitespace, must be 1–16384 printable ASCII bytes with exactly one non-empty `userId` equal to the new line's. This check runs before any temporary file is created or the status is read.

  `rebind` skips the exit-8 comparison. Each file is written to a temporary file in the same directory, set to 0600 and renamed over the target (`mv -fT`), so readers see the old or the new file, never a partial one; temporary files are removed on exit. Requires bash and GNU coreutils (`stat -c`, `mktemp`, `head -c`, `wc`, `mv -T`) on the collector host.
- **Remote privilege.** The status read always runs `sudo -n docker exec`. Passwordless sudo for Docker is root-equivalent on the collector host; restrict the sudoers rule to that exact command where possible. The writer itself needs no sudo.
- **Status file.** `renewal-status.json` has exactly the keys `schemaVersion` (1), `checkedAt`, `result`, `renewedAt`, `host` and `manualCommand`: no cookies, URLs, error text or vendor data. The collector opens it with `O_NOFOLLOW` and accepts only a regular file owned by its UID, without group/world write, at most 4096 bytes, strict UTF-8 JSON with the exact key set, a closed `result` enum (`not_needed`, `renewed`, `signin_required`, `browser_unavailable`, `vendor_unavailable`, `account_mismatch`, `error`), canonical UTC timestamps (`checkedAt` required, `renewedAt` or `null`), `host` matching `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` and `manualCommand` of 1–160 printable ASCII characters or `null`. An absent or invalid file reads as `renewal: null`. The plugin re-validates both objects and rejects the **whole** snapshot if either is invalid.
- **Displayed text.** The page renders `host` and `manualCommand` as text (the command in a `<code>` element), never as HTML or links. Whoever can write the session directory can still choose the bounded advice shown to operators; treat it as operator-trusted.
- **If the laptop or its DevTools port is compromised**, the attacker owns the browser anyway. They can read the full profile including `passToken` (this tool adds no protection there). With the ssh key they can push any session content and status to the collector host, in either writer mode. They can run whatever the ssh user may run there, including the Docker sudo rule. **If the collector host is compromised**, root and the collector UID can read the current platform cookies (about one day of console access in the observed deployment), but not `passToken`.

## Configuration

Environment only; no configuration file. Invalid values stop the run with exit 1 and a fixed message (`invalid configuration: …`) before any network or browser access; the rejected value is never echoed.

| Variable | Default | Validation |
| --- | --- | --- |
| `XQ_CDP_URL` | `http://127.0.0.1:9223` | `http:` with host `127.0.0.1`, `[::1]` or `localhost`, optional port; no credentials, path, query or fragment |
| `XQ_SSH_TARGET` | required | `user@host`; user `[A-Za-z0-9._-]+`, host `[A-Za-z0-9.-]+`; neither part may start with `-`. Set ports and keys in `~/.ssh/config` |
| `XQ_REMOTE_DIR` | required | One or more `/segment` parts, each `[A-Za-z0-9._-]+`; no `.` or `..` segment, no empty segment (`//`) and no trailing `/`. The collector's session directory on the host |
| `XQ_COLLECTOR_CONTAINER` | required | `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}`; the actual container name for `docker exec` (Compose names containers `<project>-<service>-<n>` unless `container_name` is set) |
| `XQ_HOST_LABEL` | hostname, other characters → `-`, leading non-alphanumerics removed, 64 characters | `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`; shown on the page as the renewal host |
| `XQ_MANUAL_COMMAND` | none | 1–160 printable ASCII characters; shown verbatim on the page as the command to run on that host |

Empty `XQ_CDP_URL`, `XQ_HOST_LABEL` or `XQ_MANUAL_COMMAND` means unset. Flags: `--check`, `--force` and `--rebind`; anything else is a usage error (exit 1).

Timeouts and URLs are fixed:

| Step | Limit |
| --- | --- |
| Status ssh | 25 s |
| Write ssh | 20 s |
| DevTools discovery and socket open | 3 s together |
| Each DevTools command | 10 s (the navigation itself is bounded by the console wait) |
| Readiness poll | every 250 ms |
| Console load | 45 s |
| Sign-in grace | 8 s |
| Validation | 10 s for both requests |
| Tab close | 2 s |

A **run deadline of 100 s** caps every step up to and including the install push. A step that reaches it ends the run as `error (run deadline exceeded; …)`. The exception is an install push cut off by it, which is reported as `error (session push failed: …)`. Only the local ssh client is killed then, so the remote rename may still have happened; the collector picks up such a session normally. After the deadline only the owned-tab close (2 s) and one final status write (20 s) can still run. A run therefore ends within about 122 s plus process start-up, inside the unit's `TimeoutStartSec=150`.

The refresher always writes the file names `mimo_session` and `renewal-status.json` in `XQ_REMOTE_DIR`. The collector's `MIMO_COOKIE_FILE` must therefore be `<mounted dir>/mimo_session`, with `RENEWAL_STATUS_FILE` at its default.

## Installation

Prerequisites:

- **Collector host:** a v0.3.0 collector with the directory mount from [deployment](deployment.md#session-directory-mount); an ssh user whose UID equals the collector's (1000 in the proposal) and who owns the 0700 session directory; bash and GNU coreutils; `sudo -n docker exec <container> …` permitted for that user.
- **Laptop:** Bun (1.3.14 is the tested version), the OpenSSH client with the host key already in `known_hosts`, and a dedicated Chrome profile started with a loopback `--remote-debugging-port` and signed in to the Xiaomi console **with the bound account only**. Recent Chrome versions refuse remote debugging on the default profile directory, so use a dedicated `--user-data-dir`.

Install a copy of `refresher/` (both files; `refresh-session.ts` imports `./lib`) and the example units:

```sh
install -d -m 700 ~/.local/share/xiaomi-session-refresh
install -m 600 refresher/lib.ts refresher/refresh-session.ts ~/.local/share/xiaomi-session-refresh/
install -d ~/.config/systemd/user
install -m 644 refresher/systemd/xiaomi-session-refresh.service \
  refresher/systemd/xiaomi-session-refresh.timer ~/.config/systemd/user/
```

Edit the service's `Environment=` placeholders (`XQ_SSH_TARGET`, `XQ_REMOTE_DIR`, `XQ_COLLECTOR_CONTAINER`, `XQ_CDP_URL`, `XQ_MANUAL_COMMAND`, optionally `XQ_HOST_LABEL`) and its `PATH` so `bun` resolves. `BatchMode=yes` needs an unencrypted key or an agent whose `SSH_AUTH_SOCK` is visible to the user manager (`systemctl --user import-environment SSH_AUTH_SOCK`, or an `Environment=` line).

Before enabling the timer, run an **end-to-end smoke test**. `--check` and a normal run against a healthy collector never touch the browser: they prove only ssh, sudo, `docker exec` and (normal run) the status write. A wrong `XQ_CDP_URL`, a browser that is not running or not signed in, or changed cookie names would then surface only at the first real expiry. In a shell with the same `XQ_*` variables exported as in the unit:

```sh
r=~/.local/share/xiaomi-session-refresh/refresh-session.ts
bun "$r" --check            # expect: check: not_needed (collector ok), or renewal needed
bun "$r" --force            # collector already holds a session of the bound account
bun "$r" --force --rebind   # instead: first install or account switch, collector healthy
bun "$r" --rebind           # instead: first install, collector has no usable session yet
```

Run `--check`, then exactly one of the other three:

- **Existing session of the bound account** (exactly one `userId`): use `--force`. Require `renewed (forced; collector ok)`, exit 0.
- **First install or deliberate account switch:** the installed file is missing or does not hold exactly one `userId`, or you are switching accounts. Use `--force --rebind` when the collector is healthy, or `--rebind` when it reports `auth_required`. Require `renewed (forced; rebind; collector ok)` or `renewed (rebind; collector auth_required …)`. Then update `ACCOUNT_LABEL` and the binding ([account binding](#account-binding)).
- **`account_mismatch` (exit 3) from `--force`:** the browser is signed in to a different account than the installed session, or that session has no single `userId`. Sign the browser into the bound account and retry; use `--rebind` only for a deliberate switch.

A healthy collector picks up a forced session on its next 5-minute poll; the page then shows the agent's last renewal. Then check the unit's own environment and enable the timer:

```sh
systemctl --user daemon-reload
systemctl --user start xiaomi-session-refresh.service
journalctl --user -u xiaomi-session-refresh.service -n 5 --no-pager
systemctl --user enable --now xiaomi-session-refresh.timer
```

The service is `Type=oneshot`, `TimeoutStartSec=150`, `NoNewPrivileges=yes`. The timer fires every 5 minutes (`OnCalendar=*:0/5`) with `Persistent=true`, so runs missed during suspend fire on resume. A failed run marks the service failed; the timer keeps firing.

**Upgrade:** copy both files again, compare the installed units with the new examples (this version's service sets `TimeoutStartSec=150`), run `systemctl --user daemon-reload`, then repeat `--check` and the `--force` smoke run.

**Removal:**

1. `systemctl --user disable --now xiaomi-session-refresh.timer`.
2. Delete the units and the copy, then run `systemctl --user daemon-reload`.
3. On the collector host, delete `<session dir>/renewal-status.json`.

Without step 3, a v0.3.0 collector keeps serving the last report. After 15 minutes the page and `quota.fetch` would keep pointing at the removed agent (wake it, restart its timer, run its stored command). Once the file is gone, the collector reports `renewal: null` within one session-check interval (15 s by default). The page then shows the no-agent guidance, including by-hand replacement.

## Operation

Manual run with the same environment: `systemctl --user start xiaomi-session-refresh.service`, or `bun ~/.local/share/xiaomi-session-refresh/refresh-session.ts [--check] [--force] [--rebind]`.

- `--check` reads the collector status and prints the decision only: no browser, no Xiaomi request, no write.
- `--force` renews even when the collector is healthy. A healthy collector reads the replaced file on its next 5-minute poll; a blocked one within the session-check interval. It is the only way to exercise the browser path while the collector is healthy.
- `--rebind` installs the browser's session even if its `userId` differs from the installed session's, or the installed file is missing or has no single `userId`. It does not imply `--force`. Use it only for the first install or a deliberate account switch, then update `ACCOUNT_LABEL` and the binding. The timer never passes it.

Each run prints one line prefixed `xiaomi-session-refresh: `, on stdout for exit 0 and on stderr otherwise. The forms are:

- failures: `<result> (<reason>; <context>)`;
- success: `renewed (<context>)` or `not_needed (<context>)`;
- `--check`: `check: <decision> (<context>)`;
- bare `collector_unreachable` or `interrupted`.

The context is `collector ok` or `collector <error>[ since <rejectedAt>]`, prefixed `forced; ` with `--force` and `rebind; ` with `--rebind`. A failed status write appends `; status write failed: <reason>`, where the reason is one of:

- `remote session directory missing`
- `remote session directory not owned by ssh user`
- `remote session directory is group/world accessible`
- `ssh failed`
- `remote exit <n>`

Failure statuses keep the previous `renewedAt` the collector reported.

| Result | Meaning | Exit |
| --- | --- | --- |
| `not_needed` | Collector not rejected; heartbeat status written. If that write fails the run exits 1 | 0 |
| `renewed` | Validated session and status installed | 0 |
| `check: not_needed` / `check: renewal needed` | `--check` decision only | 0 |
| `signin_required` | An account sign-in page stayed for 8 s, a required cookie is missing/empty, or Xiaomi rejected the browser's cookies | 2 |
| `account_mismatch` | The browser session's `userId` differs from the installed session's, or the installed file is missing, a symlink, unusable or without exactly one `userId` (writer exit 8). Session file untouched; status written. Sign the browser into the bound account, or deliberately rerun with `--rebind` | 3 |
| `browser_unavailable` | DevTools endpoint unreachable/invalid or connection lost | 1 |
| `vendor_unavailable` | Console navigation failed, or validation got a non-auth failure or timeout | 1 |
| `error` | Duplicate or malformed cookie, tab crash/detach, DevTools command failure, `run deadline exceeded`, session push failure (`session push failed: …`), unexpected failure | 1 |
| `collector_unreachable` | Status read failed (ssh, sudo, container, collector, oversized output); nothing written | 1 |
| `interrupted` | SIGTERM or SIGINT: owned tab closed, no further status write | 143 / 130 |
| `invalid configuration: …` | Environment or flags invalid; no I/O | 1 |

## Collector behaviour

| `session.state` | Meaning | Xiaomi contact |
| --- | --- | --- |
| `unknown` | No verdict yet (startup, or only non-auth failures so far), or a replaced session whose first attempt failed for a non-auth reason. The page labels it "Session not verified yet" | Every 300 s poll |
| `ok` | A fetch with this session succeeded; later non-auth failures keep `ok` and report their own error | Every 300 s poll |
| `expired` | Xiaomi returned HTTP 401/403 or body `code` 401/403 for this exact session content | Unchanged session: at most once per `AUTH_RETRY_INTERVAL_MS` |
| `missing` | Session file absent | Never |
| `invalid_file` | Not a regular file (or a symlink), not owned by the collector UID, any group/other permission bit, over 16385 bytes, not strict UTF-8, or not 1–16384 printable ASCII characters (0x20–0x7E) after trimming. Typographic punctuation or Latin-1 letters pasted into the file make it unusable | Never |

`expired`, `missing` and `invalid_file` are **blocked**: the snapshot reports `error: "auth_required"`, `stale: true` and keeps the last good pools. An unusable file is never sent, so it stays `invalid_file` (and watched) rather than appearing as a Xiaomi network failure.

- **Session check** (every `SESSION_CHECK_INTERVAL_MS`, default 15 s): always re-reads `renewal-status.json`; while blocked, also re-reads the session file and compares an in-memory fingerprint (device, inode, size, mtime and SHA-256 of the trimmed content). Any change triggers one immediate fetch, so a rename (even with identical content) or an in-place rewrite with new content is noticed. Fingerprints and content are never exposed.
- **Poll** (fixed 300 s tick): while blocked, skipped until `AUTH_RETRY_INTERVAL_MS` (default 1 h) has passed since the last vendor attempt, so an unchanged rejected session is retried at most once per interval, on the first tick after it elapses. A healthy collector re-reads the session file on every poll.
- After a replacement, a non-auth failure leaves the new content `unknown` (not rejected) and reports that error instead of `auth_required`.
- One stderr line per transition: `session state <from> -> <to>`; never secrets, bodies or error text.

`GET /v1/quota` adds:

- `session`:
  - `state`.
  - `updatedAt`: mtime of the observed regular file.
  - `rejectedAt`: first rejection, or first observation of a missing/invalid file, for the current content; `null` unless blocked.
  - `lastAttemptAt`: start of the last Xiaomi request.
  - `nextAttemptAt`: `null` before the first attempt and while `missing` or `invalid_file`, because no Xiaomi attempt is scheduled then; only a change to the file triggers one. For `expired` it is `lastAttemptAt` + `AUTH_RETRY_INTERVAL_MS`, and the retry runs on the first 300 s poll at or after that time; a replaced file is tried within the session-check interval. Otherwise it is `lastAttemptAt` + 300 s. It is cadence-derived scheduling metadata, not a promise. In session guidance the page gives a next-contact time only for `expired`, and reads a due or past value as "at its next 5-minute poll". The vendor-failure guidance shows the next attempt only while it is still at least 30 s ahead.
- `renewal`: the validated status file without `schemaVersion`, or `null`.

| Variable | Default | Bounds |
| --- | --- | --- |
| `MIMO_COOKIE_FILE` | `/run/secrets/mimo_session` (v0.2.x single-file compatibility); the compose proposal sets `/run/secrets/xiaomi-quota/mimo_session` | Absolute path, no control characters |
| `RENEWAL_STATUS_FILE` | `renewal-status.json` beside `MIMO_COOKIE_FILE` | Absolute path, no control characters |
| `SESSION_CHECK_INTERVAL_MS` | `15000` | Whole milliseconds, 1000–3600000 |
| `AUTH_RETRY_INTERVAL_MS` | `3600000` | Whole milliseconds, 60000–86400000 |

A set but malformed value, including an empty one, stops the collector at start (exit 1).

## What the page shows and what to do

The page and `quota.fetch` errors are generated from the validated snapshot; a renewal report older than 15 minutes counts as stale. The wording below assumes the default cadences (15 s session check, 5-minute poll).

| Refresher / collector | Page shows | Operator action |
| --- | --- | --- |
| `not_needed`, collector `ok` | Session OK; renewal agent last check, "no renewal needed (no rejection reported)", last renewal | None |
| Any recent result checked **before** `rejectedAt` | Session rejected; agent's next run should install a new session | Wait up to 5 min, or run it now |
| `renewed` after the rejection | New session installed, waiting for the collector | None; if it persists over a minute, check the directory mount and the file owner/mode |
| `signin_required` | Browser not signed in to Xiaomi | Sign in at the console in the renewal browser on that host, then rerun |
| `browser_unavailable` | Renewal browser not running | Start the dedicated browser (signed in), then rerun |
| `vendor_unavailable` | Agent could not reach Xiaomi | Usually transient; check that host's internet access |
| `account_mismatch` (session `expired`) | Renewal refused: the renewal browser is signed in to a different Xiaomi account than the collector's current session, or that session has no account id; the session file was not changed | Sign the renewal browser into the bound account at the console, then rerun. Only for a deliberate switch: rerun with `--rebind` and update `ACCOUNT_LABEL` and the binding |
| `account_mismatch` while the session file is `missing` | No installed file to compare accounts with; the refresher never creates one automatically | Check the renewal browser's account at the console; if it is the bound account, run the refresher once with `--rebind` |
| `account_mismatch` while the session file is `invalid_file` | The installed file is unusable, or names another account than the browser; file unchanged | Check the browser's account first; if bound, `--rebind` once; otherwise sign in to the bound account, or switch deliberately and update `ACCOUNT_LABEL` |
| `error` | Agent failed unexpectedly | Read the unit journal, then rerun |
| `not_needed` after the rejection | Agent saw no session rejection (race or clock difference) | Wait for the next run, or run it now |
| Report older than 15 min | Host asleep or timer stopped, **or** the agent runs but cannot reach the collector or write its status (ssh, sudo, Docker or the remote session directory) | Wake the host or restart its timer. If it is awake and the timer runs, run the refresher with `--check` there and read its unit journal (ssh access, sudo rule, container name, session directory). Or replace the session by hand |
| `collector_unreachable` | Nothing new is written, so the last report ages into the stale row | Run `--check` on the laptop; check ssh, sudo, Docker and the container |
| No status file (`renewal: null`) | No renewal agent reporting | Install the refresher, or replace the session by hand. A collector that still mounts the single file (pre-0.3.0 layout) does not see a renamed file until it restarts: switch to the directory mount or restart it |
| `missing` / `invalid_file` | Session file missing / unusable, with file requirements (regular owner-only file, one printable-ASCII Cookie header line); the collector does not contact Xiaomi until the file changes | Let the refresher push, or replace by hand; fix owner (collector UID) and mode (0600) |
| Collector before 0.3.0 (no `session`) | Legacy guidance | Replace the file and restart the collector; upgrade to 0.3.0 |

While the session is blocked and `manualCommand` is set, the page adds “Run on `<host>`: `<command>`”, except while a `renewed` session awaits pickup. `quota.fetch` adds the same sentence when it fits its 400-byte limit.

## Manual fallback

Install a session by hand on the collector host, as the user that owns the session directory (the collector UID). Use only the platform cookies as one Cookie header value (`api-platform_serviceToken=…; api-platform_slh=…; api-platform_ph=…; userId=…`), taken from a browser signed in to the bound Xiaomi account; never include `account.xiaomi.com` cookies. The value must be printable ASCII on one line and contain exactly one `userId=…` cookie. Otherwise the collector rejects the file as `invalid_file`, or the refresher's next renewal reports `account_mismatch` instead of replacing it.

Use bash or zsh. `read -rs` keeps the value out of argv, shell history and the terminal echo. The block reads first, before it creates anything, and installs only a value that looks like a usable session (a `userId=` cookie, printable ASCII only); anything else prints `not installed` and leaves the current session and directory unchanged. It contains no `!` (interactive history expansion) and no inline comments (zsh without `INTERACTIVE_COMMENTS`). Set `d` to the dedicated session directory:

```sh
umask 077; d=/srv/xiaomi-quota/session; t=
printf 'Cookie header value: ' >&2
if IFS= read -rs c && case $c in *userId=?*) true;; *) false;; esac &&
  printf '%s' "$c" | LC_ALL=C grep -qv '[^ -~]' &&
  t=$(mktemp "$d/.mimo_session.XXXXXXXX") && printf '%s\n' "$c" > "$t" &&
  chmod 600 "$t" && mv -fT "$t" "$d/mimo_session"
then echo; echo installed; else echo; [ -z "$t" ] || rm -f "$t"; echo 'not installed' >&2; fi; unset c t
```

Paste the block and press Enter. When it prints `Cookie header value:` and waits without echo, paste the value and press Enter. Ctrl-D, an empty line or an unusable value prints `not installed`. The check is a shape check only: Xiaomi has not validated the value, and the collector still applies its own file rules. Verified in interactive bash 5.3 and zsh 5.9 (C and UTF-8 locales): a synthetic value was installed with mode 0600 and appeared in neither the terminal output nor the history file.

A blocked collector loads it within the session-check interval and a healthy one on its next poll; no restart (with the directory mount).

## Limitations

- Renewal happens only while the laptop is awake, the user's systemd manager and the timer are running, and the dedicated browser is running and signed in to the bound account.
- Renewal is reactive: it starts after the collector reports a rejection. Each expiry leaves a stale window of up to one collector poll (5 min) to notice, up to one timer interval (5 min) to renew, plus run time and one session check (15 s). This is derived from the cadences, not measured.
- Cookie names, the about-24 h lifetime, silent re-minting through the account sign-in and the response codes are undocumented vendor behaviour observed in one deployment. Validation gates every install but cannot prevent future breakage.
- Sign-in detection is a heuristic (8 s grace on a main-frame account-host document; 45 s console wait). A slow SSO hop or a changed console can be misclassified as `signin_required` or `vendor_unavailable`; validation still prevents installing a rejected session.
- Readiness relies on the tab's Resource Timing entries. `responseStatus` needs Chrome 109 or later, and the default buffer holds 250 entries. If the usage request is not recorded, the refresher waits the full 45 s and then reads and validates the cookies anyway.
- A run takes at most about 122 s plus start-up (100 s deadline, 2 s tab close, 20 s final status write), under the unit's `TimeoutStartSec=150`.
- When the account sign-in lapses or Xiaomi requires interactive verification (password, MFA, captcha), someone must sign in again in the renewal browser. The refresher never enters credentials.
- The account check compares the vendor's `userId` cookie only. The first install and every deliberate account switch need a manual `--rebind`. The collector trims Unicode whitespace such as a UTF-8 BOM or a no-break space around a hand-installed session, but the writer trims only ASCII whitespace. Such a file therefore works for the collector, while renewals report `account_mismatch` until it is rewritten or `--rebind` is used.
- One refresher configuration serves one collector and one session directory. A v0.2.x collector can be pushed to but does not reload without a restart.
