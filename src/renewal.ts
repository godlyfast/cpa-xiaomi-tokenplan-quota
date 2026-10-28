import { readOwnedFile } from "./owned-file";
import { record } from "./mimo";
import type { RenewalResult, RenewalStatus } from "./types";

export const RENEWAL_MAX_BYTES = 4096;
const KEYS = [
  "checkedAt",
  "host",
  "manualCommand",
  "renewedAt",
  "result",
  "schemaVersion",
];
const RESULTS: readonly RenewalResult[] = [
  "not_needed",
  "renewed",
  "signin_required",
  "browser_unavailable",
  "vendor_unavailable",
  "error",
];
const UTC = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3}))?Z$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMAND = /^[\x20-\x7e]{1,160}$/;

// Accepts what Date#toISOString() produces (optionally fewer fraction digits) and
// rejects anything that does not round-trip, e.g. Feb 30, 24:00 or offsets.
export function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = UTC.exec(value);
  if (!match) return false;
  const canonical = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  const ms = Date.parse(canonical);
  return Number.isFinite(ms) && new Date(ms).toISOString() === canonical;
}
// Strict schema v1: exact key set, closed enums, bounded printable strings.
export function parseRenewalStatus(text: string): RenewalStatus | null {
  if (typeof text !== "string" || text.length > RENEWAL_MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!record(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== KEYS.length || keys.some((key, i) => key !== KEYS[i]))
    return null;
  const { schemaVersion, checkedAt, result, renewedAt, host, manualCommand } =
    value;
  if (
    schemaVersion !== 1 ||
    !isUtcTimestamp(checkedAt) ||
    !RESULTS.includes(result as RenewalResult) ||
    (renewedAt !== null && !isUtcTimestamp(renewedAt)) ||
    typeof host !== "string" ||
    !HOST.test(host) ||
    (manualCommand !== null &&
      (typeof manualCommand !== "string" || !COMMAND.test(manualCommand)))
  )
    return null;
  return {
    checkedAt,
    result: result as RenewalResult,
    renewedAt: renewedAt as string | null,
    host,
    manualCommand: manualCommand as string | null,
  };
}
// Never throws; absent, unsafe or invalid files all read as null.
export async function readRenewalStatus(
  path: string,
): Promise<RenewalStatus | null> {
  const file = await readOwnedFile(path, RENEWAL_MAX_BYTES, 0o022);
  if (!file.ok) return null;
  let text: string;
  try {
    // ignoreBOM keeps a BOM in the text so JSON.parse rejects it (strict UTF-8 JSON).
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      file.bytes,
    );
  } catch {
    return null;
  }
  return parseRenewalStatus(text);
}
