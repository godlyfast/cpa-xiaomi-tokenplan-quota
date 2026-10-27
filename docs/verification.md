# Verification receipt — 2026-10-27

## Scope

Implementation and public publication approved. No live installation, cookie extraction/provisioning/replay, vendor calls, inference or billing change performed by the implementation. Discovery was a separate, earlier explicitly approved read-only action; see [discovery](discovery.md).

## Automated evidence

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

## Browser proof (synthetic only)

Served the **built management.html** on a task-owned ephemeral loopback server, with a synthetic management backend and fake preview-only key. Used an owned tab in the approved Agents browser; no live CPA or vendor requests.

- Actual quota route rendered Xiaomi plan/monthly/compensation Credits despite **zero OAuth credentials**.
- Remaining **5,000,000,000 Credits (45.45%)** matched the synthetic fixture, with explicit Singapore/account/source/UTC validity labels and no clipping at the tested desktop viewport.
- Changed the fake backend to auth-required/stale; clicked the real Refresh cached snapshot button. Session-required and stale warnings appeared while the last known balance was preserved.
- Clicked real Logout; prior quota and account disappeared.
- Closed the exact owned tab/session and task-owned server; the original seven browser pages remained. A first preview-port collision was detected; no service was changed, and the verified preview used an OS-allocated free port.

![Synthetic quota page, not live account data](images/dashboard-synthetic.png)

## Unverified / deployment gates

Production network/auth boundaries, independent cookie recipe/replay/lifecycle, account-to-CPA-key binding, regional entitlement, same-time live accuracy, production image digests, restart and rollback. No browser layout claim for mobile or all languages; all six locale files are populated, but human translation review remains useful. Source/release provenance and final checksums are emitted by the builder; see the release manifest, not a guessed latest version.
