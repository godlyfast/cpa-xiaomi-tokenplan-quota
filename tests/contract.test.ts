import { expect, test } from "bun:test";
import { HOST_RE, statusJson, type RenewalResult } from "../refresher/lib";
import { parseRenewalStatus } from "../src/renewal";

// Cross-component contract: everything the refresher writes must pass the collector's strict reader.
const results: RenewalResult[] = ["not_needed", "renewed", "signin_required", "browser_unavailable", "vendor_unavailable", "account_mismatch", "error"];
const configs = [
  { hostLabel: "workstation", manualCommand: "systemctl --user start xiaomi-session-refresh.service" },
  { hostLabel: "h".repeat(64), manualCommand: "~".repeat(160) },
  { hostLabel: "a.b_c-d", manualCommand: null },
];

test("every refresher status is accepted verbatim by the collector parser", () => {
  const now = new Date("2026-10-28T19:13:39.255Z");
  for (const cfg of configs)
    for (const result of results)
      for (const renewedAt of [null, "2026-10-28T19:13:39.255Z"]) {
        // The remote writer appends a newline; the collector reads the file as written.
        const parsed = parseRenewalStatus(statusJson(cfg, result, now, renewedAt) + "\n");
        expect(parsed).toEqual({ checkedAt: now.toISOString(), result, renewedAt, host: cfg.hostLabel, manualCommand: cfg.manualCommand });
      }
});

test("refresher host label rule matches the collector's", () => {
  for (const host of ["workstation", "h".repeat(65), "-lead", "ok.host_1-2", "sp ace"])
    expect(parseRenewalStatus(statusJson({ hostLabel: host, manualCommand: null }, "renewed", new Date(0), null)) !== null).toBe(HOST_RE.test(host));
});
