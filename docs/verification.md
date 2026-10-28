# Verification receipts

## v0.3.0 — 2026-10-28 (branch `feat/session-renewal`, code at `95c898c`)

### Scope

Synthetic local checks of the integrated branch only. **No live vendor, production gateway, Portainer, collector-host or agents-browser verification is claimed in this section.** No Xiaomi request, real session or cookie, ssh to a real host, Docker change or systemd unit installation was performed.

### Automated evidence

- Bun **1.3.14**: `bun test` **77 pass / 0 fail**, 6831 `expect()` calls across 8 files (collector 12, mimo 10, credit 3, renewal-status 5, contract 2, main 1, refresher 24, native page 20).
- `bun run verify` (tests, `tsc --noEmit`, collector bundle): pass, same 77 / 0.
- Go **1.27.3** linux/amd64 in `native/`: `go test -count=1 ./...` pass (13 top-level tests, 22 subtests); `go test -race ./...` pass; `go vet ./...` clean.
- `CGO_ENABLED=1 go build -trimpath -buildvcs=false -buildmode=c-shared` produced a local test library `xiaomi-tokenplan-quota-v0.3.0.so` (SHA-256 `4fdba7b5a34af00aa09ef1433818cf8c229dc687c46393fa13ae514f5c39c7f0`; local build, not a release artifact).
- `native/integration_test.py` with that library and an unmodified CPA **v8.0.44** (`1f917e7`) binary: pass. Real C ABI registration, public shell only, unauthenticated snapshot 401, native quota, auth-failure recovery, session/renewal passthrough, expired-session guidance through `quota.fetch` (HTTP 502; message within 400 bytes plus CPA's prefix, naming the renewal host and manual command), invalid renewal data failing closed (snapshot 503, `quota.fetch` 502) and native quota from the older collector shape. Synthetic collector, keys and counters only.

Coverage, by test name: atomic session replacement and same-inode rewrite recover without restart; an unchanged rejected session is retried exactly once per auth retry interval; a missing file never reaches Xiaomi and recovers; non-auth failures do not mark a replaced session rejected; renewal status is validated and re-read every tick; malformed collector environment fails before serving. Renewal-status parsing enforces the exact schema, canonical UTC, bounded fields and owner/mode/type/size/UTF-8; every refresher status is accepted verbatim by the collector parser. Refresher: configuration refusal without echo; remote command quoting through a POSIX login shell; the remote writer run locally against temporary directories (atomic owner-only replace, refusal of missing, symlinked or group/world-accessible directories); cookie only on stdin with a minimal environment; v0.3/v0.2 status shapes; exact cookie selection; validation headers, redirect refusal and 401/403 mapping; heartbeat, `--check`, sign-in page, SSO pass-through, foreign targets ignored; every failure branch writes its status and closes the owned target; loopback-only DevTools discovery; end to end over a synthetic DevTools socket. Native page: healthy summary, every rejected-session renewal state, manual command as code text, file problems, legacy collectors, vendor/stale/subscription guidance, snapshot failures, cleanup on disconnect, no HTML sinks, relative times. Go: strict session/renewal validation, passthrough, specific bounded `quota.fetch` messages without leaking collector errors.

### Synthetic DevTools observation

Throwaway headless Chrome 156 with a temporary profile on a random loopback port and two synthetic loopback hosts (no Xiaomi, no agents browser; ad hoc probe, not in the repository). With the Network domain enabled on one owned target, navigating through a host with a cookie delivered that cookie value to the DevTools client in `Network.requestWillBeSentExtraInfo` and `Network.responseReceivedExtraInfo`; URL-scoped `Network.getCookies` for the other host returned none of it. This is why the [security model](session-renewal.md#security-model) distinguishes what the refresher copies from what its DevTools connection can see.

### Unverified

Real Chrome against the Xiaomi console, SSO pass-through, cookie re-minting and the about-24 h lifetime (observations only); real ssh, sudo and `docker exec` on a collector host; the systemd units; the compose proposal (not rendered or started in this pass); image digests; production network/auth boundaries and live acceptance.

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
