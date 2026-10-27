import { createCollector } from "./collector";
import { fetchMimoSnapshot } from "./mimo";

// Fail closed rather than imply a provider alias proves identity or regional entitlement.
const label = process.env.ACCOUNT_LABEL?.trim();
if (
  process.env.ACCOUNT_REGION !== "sgp" ||
  process.env.ACCOUNT_BINDING_CONFIRMED !== "true" ||
  !label ||
  label.length > 80 ||
  /[\x00-\x1f\x7f]/.test(label)
) {
  console.error(
    "Set ACCOUNT_LABEL, ACCOUNT_REGION=sgp and ACCOUNT_BINDING_CONFIRMED=true after operator verification.",
  );
  process.exit(1);
}
const collector = createCollector({
  accountLabel: label,
  cookieFile: process.env.MIMO_COOKIE_FILE ?? "/run/secrets/mimo_session",
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
