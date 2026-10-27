# Dashboard login reuse

Approved scope: keep the standalone Xiaomi page, automatically reuse an existing dashboard login, and build/deploy a small custom panel. No authentication bypass, raw-key handoff, new credential persistence, provider/config/catalog changes, or arbitrary management proxy.

The panel grants only a same-origin, currently mounted plugin iframe a read of its own `/v0/management/plugins/<active-plugin-id>/snapshot` extension. This path is an explicit plugin extension, not a legacy management fallback. The panel's existing authenticated API client makes the request. The iframe receives snapshot JSON or a fixed generic error; never credentials, headers, connection configuration, or raw error bodies.

Messages have a fixed versioned operation and bounded request ID. Validate exact origin, current iframe source, shape, and active login/connection. Limit to one outstanding request. Disposal, navigation, logout, and connection changes invalidate responses. The iframe validates source/origin/request ID, times out, clears old quota on failures, and ignores late replies. The existing explicit manual-key flow remains a standalone/stock-panel compatibility fallback; no browser storage is added.

Implementation starts from panel v1.26.7 commit `714de0760a3ce86094b178fb46f834d34bc4a2a5`, NOT the archived Xiaomi-specific quota-card patch. The approved native backend discovery image remains unchanged. Changes are a separate panel patch and updated native plugin resource; the collector and protected Xiaomi session remain untouched.

Verification: regression tests first (successful reuse, spoof rejection, redacted failures, connection/disposal races, page fallback and late replies), pinned clean baseline comparison, full suites/lint/types/build, native ABI/integration test, independent review, isolated browser proof, publication and Portainer-managed rollout with rollback and exact provider/catalog/config/auth preservation. A native library reload requires a gateway recreate; panel replacement must be atomic and recoverable.

## Verified before release

- Pinned clean panel: 1,656 tests pass; login-bridge variant: 1,665 pass. Full lint, types and build pass. Project: 25 tests pass, including eight native-page regressions. Native Go race tests/vet and real C ABI integration pass.
- Follow-up independent read-only review: no remaining findings after current-Document/navigation and persisted-pageshow corrections.
- Real Chrome with an isolated loopback CPA, native library, synthetic key and synthetic collector: automatic quota with zero visible credential inputs; no key persistence; forged top-window and same-WindowProxy navigated-document requests ignored; iframe back navigation reconnected; dashboard logout removed the frame; standalone manual fallback worked. No vendor or inference request was made. Browser BFCache restoration itself was not observed; persisted-pageshow recovery has regression coverage.
- LSP probe returned no errors (three paths confirmed clean, four inconclusive); complete CLI type checks passed independently.
