# Native Xiaomi Token Plan plugin (v0.2.1)

A real CLIProxyAPI C ABI plugin (ABI **1**, schema **6**) with `ManagementAPI` and `QuotaProvider`. It registers in **Plugins**, exposes a **Xiaomi Token Plan** resource/menu, and supports either the stock panel's manual login or the optional scoped dashboard-login bridge. It does not register inference executors, schedulers, translators, auth providers, or request hooks.

Tested with the unmodified CLIProxyAPI **v8.0.44** (`1f917e77c4562623aa49e9804d999524151a2f96`) and Management Center **v1.26.7** (`714de0760a3ce86094b178fb46f834d34bc4a2a5`). No compatibility is claimed for another ABI, gateway version, OS/architecture/libc combination, or a different provider name.

## Architecture and authentication

The existing collector still owns the Xiaomi console session, polls the vendor, and returns sanitized Credits snapshots. The native plugin reads exactly its configured `/v1/quota` URL (2-second deadline, 32 KiB response cap, no redirects, environment proxy, Cookie, Authorization, or forwarded request headers). It has no access to the vendor session file. **Native code shares the gateway process's authority**: installing it is a trust decision, not a sandbox.

CPA resource routes are **public**. `/v0/resource/plugins/xiaomi-tokenplan-quota/quota` returns only an HTML/JS shell: no account data, quota or credential is embedded. The optional `bun run build:login-panel` variant lets the current same-origin plugin document request only its own snapshot through the dashboard's existing authenticated API client. The bridge returns quota or a fixed error, never keys or raw headers, and invalidates requests on navigation/logout/connection changes. It adds no credential storage. With an unchanged stock panel or standalone page, enter the CPA management key separately; it is held only in page memory, never URL parameters, browser storage or cookies. Reopening the standalone/manual fallback requires login again. See [bridge design](../docs/dashboard-login-bridge.md). The page reads `/v0/management/plugins/xiaomi-tokenplan-quota/snapshot` with the management Authorization header; the host's existing management authentication protects this route. It is same-origin trusted plugin code, not isolated from the broader management origin. Use HTTPS outside the existing trusted LAN; do not publish the service.

The collector has **no endpoint authentication**. Its unpublished network must contain only CPA and the collector. Do not put the collector on a shared/default multi-service network, publish a port, or place a Cookie in plugin configuration.

The page shows independent Credits pools, used/limit/remaining, last successful fetch and subscription expiry. Monthly Credits **overlap** plan Credits: never sum pools. Subscription expiry is **not** a quota reset. Quota is marked stale after ten minutes and the prior snapshot retains error/session status. Expired/stale/error snapshots are not returned as fresh normalized quota. Resource page polling (60 seconds while visible) only reads cache; vendor polling remains five minutes.

## Build/test

Requires Go **1.26+**, a C compiler, Python 3 for integration, and a matching runtime libc. The initial Linux/amd64 release was built with Go 1.27.3; its ELF dependencies require glibc **2.34+** and were acceptance-tested in the actual Debian 12/glibc 2.36 CPA image. **Not an Alpine/musl, ARM, macOS or Windows artifact**. Build separately for those targets and test before claiming support. The only module dependency is `gopkg.in/yaml.v3 v3.0.1` (checksums in `go.sum`). Preserve the notices/licenses shipped alongside the library.

```sh
cd native
go mod download
go test -race ./...
go vet ./...
mkdir -p ../dist/native
CGO_ENABLED=1 go build -trimpath -buildvcs=false -buildmode=c-shared \
  -o ../dist/native/xiaomi-tokenplan-quota-v0.2.1.so .
cd ..
CPA_BINARY=/path/to/pinned/CLIProxyAPI \
  NATIVE_PLUGIN="$PWD/dist/native/xiaomi-tokenplan-quota-v0.2.1.so" \
  python3 native/integration_test.py
```

The integration test starts isolated loopback-only processes with a temporary, empty auth directory and synthetic keys/counters. It checks real C ABI discovery/registration, exact management/public route boundaries, native quota normalization and stale/session-failure recovery. It does not contact Xiaomi or run inference. Never point it at a running production server/config.

## Install — operator-approved maintenance only

1. Preserve the current gateway config, panel, compose, auth files and collector/session. Record hashes and stop/start dependencies. Confirm the collector's account belongs to the **one** intended CPA Xiaomi key. No automatic ownership proof is available.
2. Install the reviewed `.so` into an owner-controlled directory and mount it read-only into CPA at `/CLIProxyAPI/plugins`. This plugin's ID is `xiaomi-tokenplan-quota`; the versioned filename is `xiaomi-tokenplan-quota-v0.2.1.so`.
3. Merge the following into the existing configuration; **do not replace other settings or provider credentials**. Use the target key's `auth_index` from authenticated `GET /v8/management/config/api-keys/openai-compatibility` (`name: XIAOMI`, `keys[].auth_index`). Indices are identity labels, not keys. A changed key/index requires renewed binding/configuration.

```yaml
plugins:
  enabled: true
  dir: /CLIProxyAPI/plugins
  configs:
    xiaomi-tokenplan-quota:
      enabled: true
      collector_url: http://xiaomi-quota:8787/v1/quota
      auth_index: REPLACE_WITH_CONFIRMED_XIAOMI_AUTH_INDEX
```

4. Install the reviewed login-bridge `management.html` if automatic reuse is desired; otherwise restore the pinned **official** panel when migrating from v0.1.0. Preserve the old panel for atomic rollback; never install the legacy Xiaomi-card variant by accident. Keep panel automatic updating disabled as before. Change mounts/compose and briefly recreate the gateway only via its operator's supported deployment path (Portainer in Tim's environment); preserve its original image digest, LAN bind, auth/config mounts and routing. Never stop/remove its network while the dependent collector is running.
5. Verify health, client `/v1/models` authentication, all provider identities/settings, plugin registration/effective enablement/menu, public shell with no private data, unauthenticated snapshot denial, authenticated fresh/stale/session states, native quota, exact intended panel artifact hash and unrelated containers unchanged. No inference is needed. With the login bridge, sign into the dashboard once and open **Plugins → Xiaomi Token Plan** without entering another key; verify navigation, logout, restore and forged-message boundaries. With the stock panel, enter the key separately and Disconnect when done.

Native read-only quota also works through `POST /v0/management/quota/fetch` with `{"auth_index":"…"}` (management authentication required). The plugin supports the exact names `xiaomi` and CPA's internal config-provider key `openai-compatible-xiaomi`; it refuses other providers/accounts. This does not make stock-panel OAuth quota tabs automatically list config-backed credentials. No reset/write capability is implemented.

## Rollback

Keep the collector and its protected session unchanged. Disable this plugin/global plugin mode if it was previously off; remove only its mount through the deployment owner and recreate the gateway. Remove only the plugin configuration added by this migration, preserving current live provider/config changes. Restore the previous patched panel only if returning to the legacy v0.1.0 integration, or leave the official panel with no Xiaomi quota page. Keep reviewed binaries and private receipts for recovery; do not delete state or networks. A config-only rollback can disable the plugin without a restart, but **unloading native Go runtime images is not supported**: a gateway restart is required to remove it from the process fully.
