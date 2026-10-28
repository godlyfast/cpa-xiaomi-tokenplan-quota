import { dirname, isAbsolute, join } from "node:path";
import { createCollector } from "./collector";
import { fetchMimoSnapshot } from "./mimo";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
// Fail closed rather than imply a provider alias proves identity or regional entitlement.
const label = process.env.ACCOUNT_LABEL?.trim();
if (
  process.env.ACCOUNT_REGION !== "sgp" ||
  process.env.ACCOUNT_BINDING_CONFIRMED !== "true" ||
  !label ||
  label.length > 80 ||
  /[\x00-\x1f\x7f]/.test(label)
)
  fail(
    "Set ACCOUNT_LABEL, ACCOUNT_REGION=sgp and ACCOUNT_BINDING_CONFIRMED=true after operator verification.",
  );
function path(name: string, fallback: string): string {
  const value = process.env[name] ?? fallback;
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value))
    fail(`${name} must be an absolute path.`);
  return value;
}
// Set-but-malformed values (including empty) fail closed; unset uses the default.
function interval(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= min && value <= max))
    fail(`${name} must be a whole number of milliseconds from ${min} to ${max}.`);
  return value;
}
// Default keeps old single-file mounts working; v0.3.0 mounts the session directory.
const cookieFile = path("MIMO_COOKIE_FILE", "/run/secrets/mimo_session");
const renewalStatusFile = path(
  "RENEWAL_STATUS_FILE",
  join(dirname(cookieFile), "renewal-status.json"),
);
const sessionCheckIntervalMs = interval(
  "SESSION_CHECK_INTERVAL_MS",
  15000,
  1000,
  3600000,
);
const authRetryIntervalMs = interval(
  "AUTH_RETRY_INTERVAL_MS",
  3600000,
  60000,
  86400000,
);
const collector = createCollector({
  accountLabel: label,
  cookieFile,
  renewalStatusFile,
  sessionCheckIntervalMs,
  authRetryIntervalMs,
  fetchSnapshot: (cookie, now, signal) =>
    fetchMimoSnapshot(cookie, now, { accountLabel: label, signal }),
});
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: 8787,
  fetch: collector.fetch,
});
async function stop() {
  await collector.close();
  await server.stop(true);
}
process.once("SIGTERM", () => {
  void stop();
});
process.once("SIGINT", () => {
  void stop();
});
