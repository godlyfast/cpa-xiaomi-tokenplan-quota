# Verification receipts

## v0.3.0 — 2026-10-28 (branch `feat/session-renewal`, code at `cecc085`)

Refreshed after the round-1 review fixes (`93d2fef..cecc085`): account binding for renewals (`account_mismatch`, `--rebind`), no DevTools Network domain, a 100 s run deadline with SIGTERM/SIGINT tab cleanup, a streaming 64 KiB ssh stdout cap, stricter `XQ_REMOTE_DIR` spelling, strict printable-ASCII session files, `nextAttemptAt: null` for missing/unusable files, and the matching page and `quota.fetch` guidance.

### Scope

Synthetic local checks of the integrated branch only. **No live vendor, production gateway, Portainer, collector-host or agents-browser verification is claimed in this section.** No Xiaomi request, real session or cookie, ssh to a real host, Docker change or systemd unit installation was performed.

### Automated evidence

- Bun **1.3.14**: `bun test` **88 pass / 0 fail** across 8 files: collector 15, mimo 10, credit 3, renewal-status 5, contract 2, main 1, refresher 32 and native page 20. Three runs counted 11881, 11878 and 11878 `expect()` calls; the count varies slightly because some tests poll.
- `bun run verify` (tests, `tsc --noEmit`, collector bundle `main.js` 18.61 KB): pass, same 88 / 0.
- Go **1.27.3** linux/amd64 in `native/`: `gofmt -l` clean; `go test -count=1 ./...` pass (13 top-level tests, 25 subtests); `go test -race ./...` pass; `go vet ./...` clean.
- `CGO_ENABLED=1 go build -trimpath -buildvcs=false -buildmode=c-shared` produced a local test library `xiaomi-tokenplan-quota-v0.3.0.so` (SHA-256 `255970cfb179884c899585b1dac7cbf1cc963adb59bdad9d578fca94b54ea352`; local build, not a release artifact).
- `native/integration_test.py` with that library and an unmodified CPA **v8.0.44** (`1f917e7`) binary: pass (`realCABI`, `registeredAndLoaded`, `publicShellOnly`, `unauthenticatedSnapshot` 401, `quotaFraction` 0.4, `authFailureRecovery`, `sessionRenewalPassThrough`, `expiredSessionGuidance`, `accountMismatchGuidance`, `invalidRenewalFailsClosed`, `oldCollectorShape`, `syntheticOnly`). The checks:
  - real C ABI registration; public shell only; unauthenticated snapshot 401; native quota; auth-failure recovery; session/renewal passthrough;
  - expired-session guidance through `quota.fetch` (HTTP 502; message within 400 bytes plus CPA's prefix, naming the renewal host and manual command);
  - **new:** a missing session file with `nextAttemptAt: null` and renewal result `account_mismatch`, which passes through the snapshot route; its `quota.fetch` message names the missing file, the different Xiaomi account, the missing account id and `--rebind` within the same bound;
  - invalid renewal data failing closed (snapshot 503, `quota.fetch` 502) and native quota from the older collector shape.

  Synthetic collector, keys and counters only.

Coverage, by test name:

- **Collector:**
  - atomic session replacement and same-inode rewrite recover without restart;
  - an unchanged rejected session is retried exactly once per auth retry interval;
  - a missing file never reaches Xiaomi and recovers;
  - a missing or unusable file schedules no Xiaomi attempt (`nextAttemptAt: null`);
  - an unusable replacement (invalid UTF-8 or non-printable-ASCII content) stays blocked and watched and is never sent, and `fetchMimoSnapshot` refuses such a Cookie without sending it;
  - non-auth failures do not mark a replaced session rejected;
  - renewal status is validated and re-read every tick;
  - malformed collector environment fails before serving.
- **Renewal status:** parsing enforces the exact schema (including `account_mismatch`), canonical UTC, bounded fields and owner/mode/type/size/UTF-8; every refresher status is accepted verbatim by the collector parser.
- **Refresher:**
  - configuration refusal without echo, including `XQ_REMOTE_DIR` spellings with `.`/`..`, `//` or a trailing `/`; flags limited to `--check`, `--force` and `--rebind`;
  - remote command quoting through a POSIX login shell;
  - the remote writer run locally against temporary directories: atomic owner-only replace; refusal of missing, symlinked, group/world-accessible or symlink-suffixed (`link/`, `link/.`) directories; `push` only over a session with the same single `userId`, `rebind` without that check; new lines limited to 1–16384 printable ASCII bytes with one `userId`;
  - account binding end to end: same account renews; another account is `account_mismatch`, exit 3, with the file untouched; `--rebind` switches;
  - cookie only on stdin with a minimal environment; ssh killed as soon as stdout passes 64 KiB;
  - v0.3/v0.2 status shapes; exact cookie selection; validation headers, redirect refusal and 401/403 mapping;
  - heartbeat, `--check`, sign-in page, SSO pass-through; foreign targets, subframes and network events ignored; readiness expression boolean-only and same-origin;
  - every failure branch writes its status and closes the owned target; the run deadline bounds every step and records `run deadline exceeded`; SIGTERM/SIGINT close the owned target at once, write nothing and make the entrypoint exit 128+signal;
  - loopback-only DevTools discovery; end to end over a synthetic DevTools socket.
- **Native page:** healthy summary (including the no-agent single-file-mount caveat and early `account_mismatch`/sign-in warnings), every rejected-session renewal state (including `account_mismatch` and the stale-agent ssh/sudo/Docker cause), manual command as code text, file problems with no Xiaomi contact while missing/unusable, legacy collectors, vendor/stale/subscription guidance, snapshot failures, cleanup on disconnect, no HTML sinks, relative times.
- **Go:** strict session/renewal validation (including `account_mismatch`), passthrough, and specific bounded `quota.fetch` messages without leaking collector errors. These cover `account_mismatch`, a stale agent, `not_needed` after a rejection, and a next attempt omitted when `null` or due.

### Synthetic DevTools observation

Throwaway headless Chrome **156.0.8078.73** with a temporary profile, an OS-assigned loopback DevTools port and `--host-resolver-rules` mapping `platform.xiaomimimo.com` and `account.xiaomi.com` to a local self-signed TLS server; every other host was unresolvable. No Xiaomi contact and no agents browser. The probe drove the branch's real `connectBrowser` and `readBrowserSession` and recorded every DevTools event and command. It is an ad hoc probe, not in the repository; it printed cookie names and event method names only, never values.

| Scenario | Result | DevTools traffic |
| --- | --- | --- |
| Signed in (synthetic `passToken` seeded), SSO via server-side redirects | Exactly the four cookie names, in order | Commands: `Target.createTarget`, `Target.attachToTarget`, `Page.enable`, `Page.navigate`, `Runtime.evaluate`, `Network.getCookies`, `Target.closeTarget`. Zero `Network.*` events; no `passToken`, platform cookie value, `Set-Cookie` or callback ticket in any event |
| Signed out | `signin_required` after the 8 s grace, tab closed | Same event types, zero `Network.*` events |
| Signed in, account page forwarding to the callback by script | Renewed as above | Zero `Network.*` events and no cookie value in any event. The callback URL's synthetic one-time ticket appeared in `Page.frameRequestedNavigation`, `Page.frameScheduledNavigation` and `Page.frameStartedNavigating` |

This is the residual the [security model](session-renewal.md#security-model) states: Page events can carry navigation URLs with their queries, but no cookie or header values. The refresher reads only the main-frame hostname from `Page.frameNavigated`. The round-1 fix verification of refresher commit `db59eda` reported the same findings with Chrome 156: zero `Network.*` events, `passToken` in no event, and the callback ticket visible in Page events.

### Interrupt against a real browser

The real entrypoint `refresher/refresh-session.ts` (Bun 1.3.14) ran against the same kind of throwaway Chrome, with the fake hosts never answering. A stub `ssh` on `PATH` reported a rejected session and recorded write calls; no real ssh was used. SIGTERM and SIGINT were sent while the owned console tab was open. Each run printed `xiaomi-session-refresh: interrupted` on stderr and exited 143 and 130 respectively, within 0.3 s. Each time the owned tab was gone afterwards (page targets back to the one pre-existing tab), and no status or session write was attempted.

### Manual fallback snippet

The guarded block in [manual fallback](session-renewal.md#manual-fallback) was run in bash 5.3 and zsh 5.9 against a temporary directory holding a synthetic session. An empty line and EOF each printed `not installed` and left the old file (mode 0600) and no temporary file. A synthetic value was installed with mode 0600. With the block and the value fed as one script on stdin, simulating a paste without bracketed paste, the line after the block was read as the value, not a line of the block.

### Unverified

Real Chrome against the Xiaomi console, the real SSO page's forwarding method, cookie re-minting and the about-24 h lifetime (observations only); real ssh, sudo and `docker exec` on a collector host; the systemd units (installation, and SIGTERM delivery by the 150 s start timeout; the signal path itself is covered above); the compose proposal (not rendered or started in this pass); image digests; production network/auth boundaries and live acceptance.

## Earlier receipt — 2026-10-27 (collector and legacy v0.1.0 panel)

### Scope

Implementation and public publication approved. No live installation, cookie extraction/provisioning/replay, vendor calls, inference or billing change performed by the implementation. Discovery was a separate, earlier explicitly approved read-only action; see [discovery](discovery.md).

### Automated evidence

- Bun **1.3.14**, locked dev dependencies: core **17 tests pass**, TypeScript `tsc --noEmit` pass, collector bundle pass.
- Tests observed RED before initial parser/collector/panel implementations. An independent reviewer identified a P1 risk, reproduced by the implementation regression: ordinary JSON decoding could round a fractional raw numeric Credit into a safe integer before validation. A raw-body fetch regression was observed failing, then fixed with Bun's original numeric-token source context. Fractional/exponential numeric counter tokens fail closed; decimal strings retain exact precision.
- Additional RED→GREEN regression prevents prototype-key plan metadata from escaping the tier allowlist.
- Pinned panel fresh clone: baseline **1656 pass / 0 fail**; patched **1662 pass / 0 fail**. Focused Xiaomi **6 pass**. Clean and patched lint, type-check and production single-file build pass.
- Original research checkout had **1655 pass / 1 inherited fail**: `cooldown section rendering > keeps the reset action contextual and exposes pending state`, `tests/authFileCooldowns.test.ts:228`; literal apostrophe expectation versus HTML-escaped apostrophe. The operator chose no upstream fix. Its result is environment/order-sensitive; the builder records the actual clean baseline and rejects added failures. No test or hook is bypassed.
- Parser checks: named/reordered/duplicate/missing pools; overlapping monthly/plan semantics; zero/over-limit/fractional/huge Credits; original raw JSON numeric tokens; UTC expiry validation; unknown tier; business/HTTP auth errors, HTML, malformed/oversized bodies, redirects and deadline/transport failures.
- Collector checks: process-owned regular secret file; permission/symlink/missing/empty rejection; no secret/error leakage; concurrent cached readers; stale-success preservation; auth retry halt; shutdown abort; method/query/path denial.
- The unapplied compose proposal passes local `compose config --quiet` with synthetic required variables; no container was built or started. Active TypeScript diagnostics found no errors. A generic AST rule flags `new URL(request.url)` as potentially throwing; the handler receives a platform-created `Request` with a valid absolute URL, not a raw caller string. That advisory is not a compiler error.
- Independent read-only review found no remaining issues after the two regressions were fixed. The reviewer inspected source and existing logs, but did not independently execute commands or live checks.
- Panel checks: exact Singapore config-backed source with no auth file; no credential fields in fixed management transport; strict sanitized contract and independent balance validation; real card rendering; page mounts card while OAuth files are empty; unconfigured/auth/unavailable/stale/expired/exhausted states. Server rendering substitutes only Vite CSS Module loading, not application components.

### Browser proof (synthetic only)

Served the **built management.html** on a task-owned ephemeral loopback server, with a synthetic management backend and fake preview-only key. Used an owned tab in the approved Agents browser; no live CPA or vendor requests.

- Actual quota route rendered Xiaomi plan/monthly/compensation Credits despite **zero OAuth credentials**.
- Remaining **5,000,000,000 Credits (45.45%)** matched the synthetic fixture, with explicit Singapore/account/source/UTC validity labels and no clipping at the tested desktop viewport.
- Changed the fake backend to auth-required/stale; clicked the real Refresh cached snapshot button. Session-required and stale warnings appeared while the last known balance was preserved.
- Clicked real Logout; prior quota and account disappeared.
- Closed the exact owned tab/session and task-owned server; the original seven browser pages remained. A first preview-port collision was detected; no service was changed, and the verified preview used an OS-allocated free port.

![Synthetic quota page, not live account data](images/dashboard-synthetic.png)

### Unverified / deployment gates

Production network/auth boundaries, independent cookie recipe/replay/lifecycle, account-to-CPA-key binding, regional entitlement, same-time live accuracy, production image digests, restart and rollback. No browser layout claim for mobile or all languages; all six locale files are populated, but human translation review remains useful. Source/release provenance and final checksums are emitted by the builder; see the release manifest, not a guessed latest version.
