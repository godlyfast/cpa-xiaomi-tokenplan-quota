export type QuotaErrorCode = "auth_required" | "unavailable" | "schema_changed";
export interface QuotaPool {
  id: "plan" | "monthly" | "compensation";
  label: string;
  unit: "credits";
  used: string;
  limit: string;
  remaining: string;
  remainingPercent: string | null;
}
export interface QuotaSnapshot {
  schemaVersion: 1;
  region: "sgp";
  accountLabel: string;
  planName: string | null;
  pools: QuotaPool[];
  fetchedAt: string | null;
  expiresAt: string | null;
  expired: boolean | null;
  resetsAt: null;
  stale: boolean;
  error: QuotaErrorCode | null;
}
