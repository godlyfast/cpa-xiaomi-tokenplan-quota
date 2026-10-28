# Deployment proposal and acceptance gates

**Unapplied proposal. Source publication is not production approval.** Nothing in the builder changes a gateway, stack, firewall, provider, session, browser login or live service.

1. Operator confirms Singapore region and that the intended CPA inference credential belongs to this exact console subscription. A provider alias or matching base URL alone is not identity proof. Set a non-secret explicit account label and binding acknowledgement only after that confirmation.
2. Obtain separate approval for protected session provisioning and a read-only replay. Provision either by hand ([manual fallback](session-renewal.md#manual-fallback)) or, with separate approval, through the optional [browser-assisted refresher](session-renewal.md), which uses a dedicated signed-in browser profile — never a personal browsing profile — and copies only the four platform cookies. Do not create keys or test inference. The four-cookie set is validated against both endpoints before every refresher install; it is not a vendor-documented recipe. Verify the selected timezone/header behaviour and expiry display during replay.
3. Review the exact Portainer stack delta, image digests, dedicated network membership, source/artifact checksums, static-file mount, previous panel SHA256 and rollback. Resolve the Dockerfile's official Bun image tag to a reviewed digest and build/pin the collector image digest. The checked-in compose is only a partial overlay proposal, not a complete existing gateway stack.
4. Attach **only CPA and the collector** to a dedicated bridge with outbound HTTPS. The collector listens on 8787 inside its own namespace and must resolve as `xiaomi-quota` from CPA. Do not use host loopback, publish ports, open LAN/WAN routes or attach unrelated containers. Docker `expose` does not restrict access. Enforce/inspect network membership and host firewall reachability; egress is necessary for the verified vendor HTTPS host. The collector has no internal auth, so dedicated-network isolation and the gateway's outer management authentication are mandatory.
5. Mount the dedicated session **directory** read-only (see [below](#session-directory-mount)): directory 0700 and files 0600/0400, all owned by the collector UID (1000 in the proposal). Never mount a whole browser profile or a shared secret directory. Keep the collector filesystem read-only, capabilities dropped and privilege escalation disabled. Do not distribute session values, provider keys or management credentials with an artifact.
6. Stage with synthetic data first. Prove from CPA's **container namespace**: management unauthenticated api-call denied; authenticated api-call can GET only a sanitized cached snapshot; collector not reachable from LAN/WAN or unrelated containers. Inspect request bodies and bounded logs for no vendor cookie, inference key, `authIndex` or `$TOKEN$`. Test vendor 401/schema drift/stale age with synthetic responses, not by logging out a real account. In staging, replace the session file atomically while the collector is blocked and confirm it resumes without restart.
7. After separate installation approval, add the collector/network via the existing Portainer-managed stack and install the native plugin per [native install](../native/README.md#install--operator-approved-maintenance-only) (the static panel bind is replaced only for the optional login-bridge panel or, legacy v0.1.0 only, the patched card). Keep gateway image/version, routing, provider keys, management restrictions, auto-update setting and public exposure unchanged.
8. Compare one read-only refreshed card with the operator's Singapore console at the same time: account, region, Credits, counters, separate compensation, UTC validity, stale/error semantics. Provider data can lag five minutes and collector polls every five minutes. Do not claim live acceptance from unit tests or screenshots using fixtures.
9. Rehearse rollback in staging: restore the previous management.html and digest, remove only this collector and its dedicated network attachment, redeploy through Portainer, and confirm existing management/routing remain functional. Record a sanitized receipt.

## Session directory mount

The collector reads `MIMO_COOKIE_FILE` from a dedicated directory bind-mounted read-only, e.g. host `/srv/xiaomi-quota/session` → `/run/secrets/xiaomi-quota` with `MIMO_COOKIE_FILE=/run/secrets/xiaomi-quota/mimo_session` (the [compose proposal](../deploy/compose.yaml) takes the host path from `MIMO_SESSION_DIR`). Safe replacement writes a temporary file and renames it, which creates a new inode; a **single-file bind mount keeps the old inode** until the container restarts, so v0.3.0 would never see the new session. The directory holds only `mimo_session` and `renewal-status.json`, is owned by the collector UID with mode 0700 (the refresher refuses any group/other bit), and its files are 0600. `RENEWAL_STATUS_FILE` defaults to `renewal-status.json` beside the session file; keep that default when using the refresher, which always writes these two names.

## Session renewal

A rejected, missing or unusable session blocks the collector: it reports `auth_required`, marks the last known balance stale, never sends a missing/invalid file to Xiaomi, checks the session file every 15 s and resumes **without restart** when it changes, and retries an unchanged rejected session at most once per hour. The plugin page and `quota.fetch` errors say what happened and what to do. Renewal is either the optional [refresher](session-renewal.md) or an atomic [manual replacement](session-renewal.md#manual-fallback). No automatic credential entry, sign-in or real-account logout is performed. Liveness `/healthz` is not quota/session readiness.

## Upgrading a v0.2.x deployment

v0.2.x uses a single-file mount and halts after a rejection; the v0.3.0 collector would keep working with that mount but could not see an atomically replaced (renamed) file until restart.

1. Record the current stack revision, collector image digest and session-file owner/mode/path privately (never its value).
2. Create the dedicated directory on the host, owned by the collector UID (1000/1000), mode 0700. Copy the current session into it as `mimo_session`, owner 1000, mode 0600, through a temporary file and rename. Remove the old single-file copy once the upgrade is verified.
3. In the Portainer-managed stack, replace the single-file bind with the read-only directory bind, set `MIMO_COOKIE_FILE` to `<mount>/mimo_session`, leave `RENEWAL_STATUS_FILE` unset, and pin the reviewed v0.3.0 collector image digest. Redeploy.
4. Upgrade the plugin to v0.3.0 ([native](../native/README.md)); either component may be upgraded first.
5. Verify the plugin page shows the session state (a v0.2.x collector produces the legacy guidance instead) and that with no refresher yet it reports no renewal agent.
6. Optionally install the [refresher](session-renewal.md#installation) and run `--check`, then one normal run, before enabling its timer.

## Rollback

- **Plugin:** independent of the collector. The v0.2.1 plugin ignores the new snapshot fields; the v0.3.0 plugin shows legacy guidance for a v0.2.x collector.
- **Collector:** disable the refresher timer first (a v0.2.x collector does not reload pushed sessions). Redeploy the previous image digest, keeping the directory mount with `MIMO_COOKIE_FILE` at the file inside it (or restoring a single-file bind of that same, newest file); either way v0.2.x needs a restart after each replacement. `renewal-status.json` is ignored by v0.2.x and can stay.
- Never restore an older session file over a newer one; the newest valid session is the one to keep.

## Rollback information to capture before approval

- Existing stack definition/revision and exact service/network membership.
- Gateway image digest, old panel source version and SHA256, bind path/owner/mode.
- New collector image digest, pinned source commit, management.html SHA256 and license artifacts.
- Protected session-directory and session-file owner/mode/path recorded privately, never the value.
- Refresher host, ssh user/key identity, sudoers rule and timer state, if installed.
- Old panel recovery and removal of this feature's network/container changes proven in staging.
