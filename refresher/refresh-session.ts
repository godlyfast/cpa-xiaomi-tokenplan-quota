#!/usr/bin/env bun
// Renews the collector's Xiaomi session from a signed-in loopback browser.
// Usage: bun refresh-session.ts [--check] [--force]; configuration via XQ_* env.
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
const outcome = await runRefresh(config, flags, {
  ssh: spawnRunner(),
  connectBrowser: (origin) => connectBrowser(origin),
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
});
(outcome.code === 0 ? console.log : console.error)(outcome.line);
process.exit(outcome.code);
