# Xiaomi Token Plan quota for CLIProxyAPI

An unofficial **Singapore Xiaomi MiMo Token Plan Credits** collector and a **native CLIProxyAPI plugin**. No inference requests, arbitrary upstream proxy, or browser automation service; the optional session refresher drives only one owned tab in a dedicated local browser profile.

**v0.3.0: automatic session recovery and optional browser-assisted renewal.** Xiaomi console sessions were observed to expire after about 24 h. The collector no longer halts after a rejection: it reads its session from a read-only mounted **directory**, loads a replaced session within about 15 s without a restart, and retries an unchanged rejected session at most hourly. `GET /v1/quota` adds sanitized `session` and `renewal` status. The native plugin passes both through and explains on its page and in `quota.fetch` errors what happened, when, what the renewal agent did and what to do. An optional laptop-side refresher copies only the four short-lived platform cookies from a dedicated signed-in browser profile on loopback DevTools, validates them read-only and installs them over ssh. See [session renewal](docs/session-renewal.md). Upgrading from v0.2.x requires moving the session file into a dedicated directory: see [deployment](docs/deployment.md#upgrading-a-v02x-deployment).

**Native plugin with optional dashboard login reuse (since v0.2.1; the login bridge is unchanged in v0.3.0).** It registers under Plugins and supplies its own authenticated quota page plus native quota-provider API. Build the optional `build:login-panel` variant to reuse an existing dashboard login without passing the management key to the iframe or storing another copy. An unchanged stock panel still supports explicit manual login. See [login bridge design](docs/dashboard-login-bridge.md) and [native build, tests, installation and rollback](native/README.md). The former v0.1.0 Xiaomi-card patch remains separate and is **not applied** by the login-bridge build.

The collector was operator-approved and live-validated on the intended Singapore account; the native implementation has separate unit/race and real-gateway synthetic tests. v0.3.0 renewal and recovery are verified with synthetic tests only; see [verification](docs/verification.md). Installation still requires explicit account binding, protected session provisioning, an isolated gateway/collector network and deployment approval. The console API is undocumented and can change.

## Why a collector?

No ready-to-install Xiaomi quota plugin compatible with the pinned official dashboard was verified. Public implementations found during research used console-session authentication, not a supported inference-key quota API. Read-only discovery of the Singapore console confirmed `GET /api/v1/tokenPlan/usage` and `/detail`; removing browser credentials returned 401. This does **not** establish the minimum cookie recipe, cookie lifetime, replay viability, or which CPA key belongs to the console account. Later operation observed a platform-session lifetime of about 24 h; see [session renewal](docs/session-renewal.md) (an observation, not a vendor guarantee).

The vendor session stays in an owner-only file in a dedicated directory mounted read-only into the collector. The native plugin reads its configurable private collector URL without forwarding any credentials; the stock dashboard loads only the plugin resource shell. The optional same-origin dashboard bridge performs only the mounted plugin's snapshot GET using the dashboard's existing authenticated client and returns quota, never the key. Without that bridge, the standalone page asks for the CPA management key and retains it only in page memory. Quota data is served through a host-authenticated plugin management route, never the public resource route. See [native architecture](native/README.md#architecture-and-authentication).

For **legacy v0.1.0 only**, the patched dashboard sends:

```json
{"method":"GET","url":"http://xiaomi-quota:8787/v1/quota","proxy_url":"direct"}
```

through the gateway's authenticated `/v8/management/requests/api-call`. No Cookie, inference key, `authIndex`, `$TOKEN$`, or collector management key is sent by the panel. The collector itself has **no endpoint authentication**: its security boundary is a dedicated container network with **only the gateway and collector**, plus the gateway's outer management authentication. Anyone on that network could read quota; do not attach unrelated containers, publish a port, or expose the collector to LAN/WAN. Docker `expose` is not access control.

## Legacy v0.1.0 patched dashboard

The existing quota page always mounts a separate Xiaomi section; it checks enabled OpenAI-compatible configuration for the exact Singapore Token Plan base URL, not OAuth auth files or provider aliases. That check identifies a configured route, **not account ownership**. Operator confirmation and the collector's explicit account label provide the required account binding. Refresh retrieves the cached collector snapshot, not an inference request. Existing OAuth tab counts are unchanged; this is a separate config-backed section above them.

The card shows:

- Plan Credits used, limit, remaining and counter-derived percentage.
- Monthly Credits separately, explicitly overlapping: **never sum them with plan Credits**.
- Separate compensation Credits, including a zero-limit pool without division by zero.
- Singapore, explicit account label, known plan tier, last fetched time, UTC **valid until**, source warning and official-console link.
- Distinct unconfigured, unavailable, auth-required, schema-changed, expired and stale states; exhausted quota is not an error or full balance.

Credits are not raw tokens, requests, dollars, PAYG balance, or CPA-observed usage. Decimal arithmetic uses strings/BigInt, not floating-point balances. JSON numbers must be nonnegative safe integers; fractional/large counters require exact decimal strings. Maximum counter length is 128 characters with up to 18 decimal places. Unknown pool identity/duplicates/invalid counters fail closed; unknown extra pools are ignored. Percentages round to two decimals. Over-limit usage retains used/limit and clamps remaining to zero.

## Collector and legacy panel build/test

For the current native plugin, follow [native build/test](native/README.md#buildtest). For automatic dashboard login reuse run `bun run build:login-panel`; it applies only the scoped read-only snapshot bridge, not the legacy quota-card patch. No custom panel is needed for manual login.

Requires Git and **Bun 1.3.14**. Node-compatible tooling can run TypeScript's CLI via the pinned toolchain. No production dependencies.

```sh
bun install --frozen-lockfile
bun run verify
bun run build:panel
(cd dist && sha256sum -c SHA256SUMS)
```

If another Bun is installed, invoke `bunx bun@1.3.14` instead of `bun`. The panel builder refuses a different Bun version, fetches the exact public source commit in `upstream.json` into a fresh `.build/` directory, installs the upstream frozen lockfile, checks the clean baseline, applies the patch, reruns tests/lint/type-check/build, and emits:

- `dist/management.html` (single-file dashboard)
- `dist/panel-manifest.json` (source pins, project commit, patch SHA256, check results, artifact hashes)
- `dist/SHA256SUMS`, `dist/UPSTREAM-PANEL-LICENSE`, `dist/panel-third-party-licenses.txt`

An environment/order-sensitive inherited HTML-escaping assertion failed in the original research checkout (1655 pass / 1 fail). The operator chose to document it, not alter unrelated upstream code. In the builder's fresh clean-environment checkout, the actual baseline was **1656 pass / 0 fail**, and the patched panel was **1662 pass / 0 fail**. The builder runs the complete suites, accepts either a green baseline or only that exact known inherited failure, and requires the patched failure set and exit code to match the actual baseline; focused Xiaomi tests must always pass. See [verification](docs/verification.md). No upstream test is skipped or fixed. Build logs remain in the scratch directory printed at completion. Builds do not deploy or upload artifacts. Keep all supplied license files when redistributing the dashboard.

## Collector runtime — only after separate deployment approval

See [deployment gates](docs/deployment.md), the unapplied [compose proposal](deploy/compose.yaml) and [Dockerfile](deploy/Dockerfile). The image tag must be resolved to a reviewed digest before production use.

Required non-secret configuration:

| Variable | Meaning |
| --- | --- |
| `ACCOUNT_LABEL` | Explicit operator-approved label, 1–80 characters; returned in the snapshot |
| `ACCOUNT_REGION=sgp` | Explicit region assertion; no regional credential probing |
| `ACCOUNT_BINDING_CONFIRMED=true` | Operator has confirmed the intended CPA credential belongs to this console subscription |
| `MIMO_COOKIE_FILE` | Protected Cookie header-value file; defaults to `/run/secrets/mimo_session` for v0.2.x single-file mounts. v0.3.0 deployments mount a directory and set e.g. `/run/secrets/xiaomi-quota/mimo_session` |

Optional (unset uses the default; a set but malformed or empty value stops the collector at start):

| Variable | Meaning |
| --- | --- |
| `RENEWAL_STATUS_FILE` | Renewal status written by the refresher; defaults to `renewal-status.json` beside `MIMO_COOKIE_FILE`. Absolute path |
| `SESSION_CHECK_INTERVAL_MS` | Renewal-status re-read and, while blocked, session-file check; default `15000`, 1000–3600000 |
| `AUTH_RETRY_INTERVAL_MS` | Minimum spacing between retries of an unchanged rejected session; default `3600000`, 60000–86400000 |

The secret must be a regular owner-only file (0600/0400), owned by the process UID; symlinks, group/world access, empty content, control characters and oversized contents are rejected. The container runs as UID/GID 1000. Mount the dedicated session **directory** (0700, owned by UID 1000), not the file: atomic replacement creates a new inode, which a single-file bind mount hides until restart. Do not put the cookie in environment variables, commands, Git, frontend storage, CPA inference config, debug output, or this repository.

**Session provisioning.** Either replace the file by hand (temporary file in the same directory, 0600, rename) or use the optional [browser-assisted refresher](docs/session-renewal.md) in `refresher/`. It runs on a machine with a dedicated, signed-in browser profile exposing DevTools on loopback only, as a systemd user timer every 5 minutes. It reads collector status over ssh (`sudo -n docker exec`), and only after a rejection (or with `--force`) opens one owned background tab on the console, copies exactly `api-platform_serviceToken`, `api-platform_slh`, `api-platform_ph` and `userId` via URL-scoped `Network.getCookies`, validates them with the two read-only GETs and writes them plus `renewal-status.json` over ssh stdin into the owner-only directory. `passToken` and other sites' cookies are never copied or forwarded; it never enters credentials, signs in, logs out or makes inference requests. It needs the laptop awake and the browser signed in; an unauthenticated DevTools port and passwordless Docker sudo are trust decisions documented in its [security model](docs/session-renewal.md#security-model).

After a rejection (or a missing/unusable file) the collector is **blocked**: it reports `auth_required` with the last good balance marked stale, never sends a missing/invalid file to Xiaomi, re-checks the session file every 15 s and resumes without restart when it changes, and retries an unchanged rejected session at most once per hour.

The collector immediately polls once and then every 300 seconds, with no overlapping polls, a 10-second combined fetch deadline, a 1 MiB response limit and redirect refusal. Only the two fixed HTTPS vendor GET paths are allowed. It preserves the observed discovery timezone header `Europe/Kiev`; validity timestamps are normalized as UTC solely because discovery explicitly matched that field to a UTC console label. The intended account's replay and UTC validity were operator-approved and compared with its console during initial deployment; cross-account/region behaviour is not established, and platform sessions were observed to be rejected after about 24 h. Unsupported dates/schema fail closed. No reset timestamp is fabricated.

`GET /v1/quota` returns a strict sanitized schema, from v0.3.0 including `session` (state and timestamps) and `renewal` (validated refresher status or `null`); reads do not poll the vendor. Old successes survive failures with explicit error/stale flags. Data older than 600 seconds is stale. The panel recalculates age as time passes, and hides prior snapshots on session changes. `GET /healthz` reports process liveness only, **not** a valid vendor session or current quota. All other routes/query strings/methods are denied. No CORS access is added. The provider itself may lag up to five minutes; collector timestamp is not proof counters are instantaneous.

## Pins / limitations

- Official panel **v1.26.7**: `714de0760a3ce86094b178fb46f834d34bc4a2a5`.
- Unmodified backend **v8.0.44**: `1f917e77c4562623aa49e9804d999524151a2f96`.
- v0.3.0 is a native C ABI plugin plus sidecar and an optional laptop-side session refresher. Its optional custom-panel variant adds only a read-only same-origin snapshot bridge; the stock-panel manual fallback remains. The v0.1.0 quota-card source patch is legacy only. Future panel/gateway versions require compatibility review.
- Session renewal depends on undocumented vendor behaviour, an awake laptop and a signed-in browser; see [limitations](docs/session-renewal.md#limitations).
- Synthetic fixtures only. No live vendor session, inference key, management key, user ID or captured account balance is shipped.
- MIT; preserve [third-party notices](THIRD_PARTY_NOTICES.md). No Xiaomi endorsement or warranty.
