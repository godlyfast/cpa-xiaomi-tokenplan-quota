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
// Vendor-derived part of the snapshot, as produced by fetchMimoSnapshot.
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
export type SessionState =
  | "unknown"
  | "ok"
  | "expired"
  | "missing"
  | "invalid_file";
export interface SessionInfo {
  state: SessionState;
  updatedAt: string | null;
  rejectedAt: string | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
}
export type RenewalResult =
  | "not_needed"
  | "renewed"
  | "signin_required"
  | "browser_unavailable"
  | "vendor_unavailable"
  | "account_mismatch"
  | "error";
// renewal-status.json schema v1 without schemaVersion.
export interface RenewalStatus {
  checkedAt: string;
  result: RenewalResult;
  renewedAt: string | null;
  host: string;
  manualCommand: string | null;
}
// GET /v1/quota body (v0.3.0+).
export interface CollectorSnapshot extends QuotaSnapshot {
  session: SessionInfo;
  renewal: RenewalStatus | null;
}
