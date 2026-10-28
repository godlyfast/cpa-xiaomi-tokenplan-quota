#!/usr/bin/env bun
// Renews the collector's Xiaomi session from a signed-in loopback browser.
// Usage: bun refresh-session.ts [--check] [--force] [--rebind]; configuration via XQ_* env.
import { hostname } from "node:os";
import {
  ConfigError,
  connectBrowser,
  parseArgs,
  parseConfig,
  runRefresh,
  spawnRunner,
} from "./lib";

const PREFIX = "xiaomi-session-refresh: ";
let flags, config;
try {
  flags = parseArgs(process.argv.slice(2));
  config = parseConfig(process.env, hostname());
} catch (error) {
  // Messages are fixed strings; never echo the rejected value.
  console.error(
    PREFIX +
      "invalid configuration: " +
      (error instanceof ConfigError ? error.message : "unreadable environment"),
  );
  process.exit(1);
}
// SIGTERM (unit stop or start timeout), SIGINT and SIGHUP (terminal closed): the run closes its owned tab
// and writes nothing more; exit 128+signal. The fallback exit waits out one
// pending DevTools command (10 s) plus the tab close (2 s), so a tab whose
// createTarget reply arrives after the signal is still closed.
const interrupt = new AbortController();
let signalled = 0;
const finish = (code: number): never => {
  console.error(PREFIX + "interrupted");
  process.exit(code);
};
for (const [name, code] of [
  ["SIGTERM", 143],
  ["SIGINT", 130],
  ["SIGHUP", 129],
] as const)
  process.on(name, () => {
    if (signalled) return;
    signalled = code;
    interrupt.abort();
    setTimeout(() => finish(code), 13000);
  });
const outcome = await runRefresh(config, flags, {
  ssh: spawnRunner(),
  connectBrowser: (origin, timeoutMs) => connectBrowser(origin, { timeoutMs }),
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  signal: interrupt.signal,
});
if (signalled) finish(signalled);
(outcome.code === 0 ? console.log : console.error)(outcome.line);
process.exit(outcome.code);
