import { balance } from "./credit";
import type { QuotaErrorCode, QuotaPool, QuotaSnapshot } from "./types";

export class QuotaError extends Error {
  constructor(public readonly code: QuotaErrorCode) {
    super(code);
    this.name = "QuotaError";
  }
}
const schema = (): never => {
  throw new QuotaError("schema_changed");
};
export const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
function data(body: unknown): Record<string, unknown> {
  if (!record(body) || typeof body.code !== "number") return schema();
  if (body.code === 401 || body.code === 403)
    throw new QuotaError("auth_required");
  if (body.code !== 0) throw new QuotaError("unavailable");
  if (!record(body.data)) return schema();
  return body.data;
}
function items(group: unknown): Record<string, unknown>[] {
  if (
    !record(group) ||
    !Array.isArray(group.items) ||
    !group.items.every(record)
  )
    return schema();
  return group.items;
}
function pool(
  values: Record<string, unknown>[],
  name: string,
  id: QuotaPool["id"],
  label: string,
  required = true,
): QuotaPool[] {
  const found = values.filter((v) => v.name === name);
  if (found.length > 1 || (required && found.length !== 1)) return schema();
  if (!found.length) return [];
  try {
    return [
      { id, label, unit: "credits", ...balance(found[0].used, found[0].limit) },
    ];
  } catch {
    return schema();
  }
}
export function parseMimoUsage(body: unknown): QuotaPool[] {
  const d = data(body),
    usage = items(d.usage),
    month = items(d.monthUsage);
  return [
    ...pool(usage, "plan_total_token", "plan", "Plan Credits"),
    ...pool(
      month,
      "month_total_token",
      "monthly",
      "Monthly Credits (overlapping)",
    ),
    ...pool(
      usage,
      "compensation_total_token",
      "compensation",
      "Compensation Credits",
      false,
    ),
  ];
}
export function parseMimoDetail(body: unknown) {
  const d = data(body);
  if (typeof d.expired !== "boolean") return schema();
  let expiresAt: string | null = null;
  if (d.currentPeriodEnd !== undefined && d.currentPeriodEnd !== null) {
    // Discovery compared this exact zone-less field with the console's explicit UTC label.
    if (
      typeof d.currentPeriodEnd !== "string" ||
      !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(d.currentPeriodEnd)
    )
      return schema();
    const iso = d.currentPeriodEnd.replace(" ", "T") + ".000Z";
    if (
      !Number.isFinite(Date.parse(iso)) ||
      new Date(iso).toISOString() !== iso
    )
      return schema();
    expiresAt = iso;
  }
  // Do not echo arbitrary upstream text, identifiers or errors.
  const names: Record<string, string> = {
    lite: "Lite",
    standard: "Standard",
    pro: "Pro",
    max: "Max",
    ultra: "Ultra",
  };
  const planName =
    typeof d.planCode === "string" && Object.hasOwn(names, d.planCode)
      ? names[d.planCode]
      : null;
  return { planName, expiresAt, expired: d.expired };
}
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
export interface FetchOptions {
  accountLabel: string;
  fetch?: Fetcher;
  signal?: AbortSignal;
  timeoutMs?: number;
}
// A sendable session: 1-16384 printable ASCII characters (a valid Cookie header value).
export const SESSION_COOKIE = /^[\x20-\x7e]{1,16384}$/;
const ORIGIN = "https://platform.xiaomimimo.com";
const MAX_BODY = 1024 * 1024;
export async function fetchMimoSnapshot(
  cookie: string,
  now: Date,
  options: FetchOptions,
): Promise<QuotaSnapshot> {
  if (typeof cookie !== "string" || !SESSION_COOKIE.test(cookie))
    throw new QuotaError("auth_required");
  const fetcher = options.fetch ?? fetch;
  const signal = options.signal
    ? AbortSignal.any([
        options.signal,
        AbortSignal.timeout(options.timeoutMs ?? 10000),
      ])
    : AbortSignal.timeout(options.timeoutMs ?? 10000);
  async function get(path: "usage" | "detail"): Promise<unknown> {
    try {
      const response = await fetcher(ORIGIN + "/api/v1/tokenPlan/" + path, {
        method: "GET",
        redirect: "error",
        signal,
        headers: {
          Cookie: cookie,
          Accept: "application/json",
          "x-timeZone": "Europe/Kiev",
        },
      });
      if (response.status === 401 || response.status === 403)
        throw new QuotaError("auth_required");
      if (!response.ok) throw new QuotaError("unavailable");
      if (
        !(response.headers.get("content-type") ?? "").includes(
          "application/json",
        )
      )
        return schema();
      const declared = Number(response.headers.get("content-length"));
      if (declared > MAX_BODY) {
        await response.body?.cancel();
        return schema();
      }
      if (!response.body) return schema();
      const reader = response.body.getReader();
      let total = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_BODY) {
            await reader.cancel();
            return schema();
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      try {
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          (key: string, value: unknown, context?: { source?: string }) => {
            // Bun 1.3.14 provides JSON.parse source context. Validate the ORIGINAL
            // counter token, not a float that may already have rounded to an integer.
            if (
              (key === "used" || key === "limit") &&
              typeof value === "number" &&
              (!context?.source || !/^(0|[1-9]\d*)$/.test(context.source))
            )
              return schema();
            return value;
          },
        );
      } catch {
        return schema();
      }
    } catch (error) {
      if (error instanceof QuotaError) throw error;
      throw new QuotaError("unavailable");
    }
  }
  const pools = parseMimoUsage(await get("usage"));
  const detail = parseMimoDetail(await get("detail"));
  return {
    schemaVersion: 1,
    region: "sgp",
    accountLabel: options.accountLabel,
    pools,
    ...detail,
    fetchedAt: now.toISOString(),
    resetsAt: null,
    stale: false,
    error: null,
  };
}
