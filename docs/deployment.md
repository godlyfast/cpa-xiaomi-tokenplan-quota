# Deployment proposal and acceptance gates

**Unapplied proposal. Source publication is not production approval.** Nothing in the builder changes a gateway, stack, firewall, provider, session, browser login or live service.

1. Operator confirms Singapore region and that the intended CPA inference credential belongs to this exact console subscription. A provider alias or matching base URL alone is not identity proof. Set a non-secret explicit account label and binding acknowledgement only after that confirmation.
2. Obtain separate approval for protected independent session-secret provisioning and a read-only replay. No cookie exporter is supplied; do not collect cookies automatically, use a personal browser, create keys or test inference. The complete required cookie set remains unqualified. Verify the selected timezone/header behaviour and expiry display during replay.
3. Review the exact Portainer stack delta, image digests, dedicated network membership, source/artifact checksums, static-file mount, previous panel SHA256 and rollback. Resolve the Dockerfile's official Bun image tag to a reviewed digest and build/pin the collector image digest. The checked-in compose is only a partial overlay proposal, not a complete existing gateway stack.
4. Attach **only CPA and the collector** to a dedicated bridge with outbound HTTPS. The collector listens on 8787 inside its own namespace and must resolve as `xiaomi-quota` from CPA. Do not use host loopback, publish ports, open LAN/WAN routes or attach unrelated containers. Docker `expose` does not restrict access. Enforce/inspect network membership and host firewall reachability; egress is necessary for the verified vendor HTTPS host. The collector has no internal auth, so dedicated-network isolation and the gateway's outer management authentication are mandatory.
5. Mount the cookie file read-only, mode 0400/0600, process-owned (UID 1000 in proposal). Mount only its value, not a whole browser profile or secret directory. Keep the collector filesystem read-only, capabilities dropped and privilege escalation disabled. Do not distribute session values, provider keys or management credentials with an artifact.
6. Stage with synthetic data first. Prove from CPA's **container namespace**: management unauthenticated api-call denied; authenticated api-call can GET only a sanitized cached snapshot; collector not reachable from LAN/WAN or unrelated containers. Inspect request bodies and bounded logs for no vendor cookie, inference key, `authIndex` or `$TOKEN$`. Test vendor 401/schema drift/stale age with synthetic responses, not by logging out a real account.
7. After separate installation approval, replace the pinned static panel bind and add the collector/network via the existing Portainer-managed stack. Keep gateway image/version, routing, provider keys, management restrictions, auto-update setting and public exposure unchanged. Never enable native gateway plugins for this feature.
8. Compare one read-only refreshed card with the operator's Singapore console at the same time: account, region, Credits, counters, separate compensation, UTC validity, stale/error semantics. Provider data can lag five minutes and collector polls every five minutes. Do not claim live acceptance from unit tests or screenshots using fixtures.
9. Rehearse rollback in staging: restore the previous management.html and digest, remove only this collector and its dedicated network attachment, redeploy through Portainer, and confirm existing management/routing remain functional. Record a sanitized receipt.

## Session replacement

Authentication failure halts upstream retries. The panel shows an explicit session-required state and any last known balance as stale. An authorized operator replaces the protected session file and restarts the collector through Portainer. No automatic sign-in, cookie refresh or real-account logout is performed. Liveness `/healthz` is not quota/session readiness.

## Rollback information to capture before approval

- Existing stack definition/revision and exact service/network membership.
- Gateway image digest, old panel source version and SHA256, bind path/owner/mode.
- New collector image digest, pinned source commit, management.html SHA256 and license artifacts.
- Protected session-file owner/mode/path recorded privately, never its value.
- Old panel recovery and removal of this feature's network/container changes proven in staging.
