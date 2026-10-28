import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { QuotaError, SESSION_COOKIE } from "./mimo";
import { readOwnedFile } from "./owned-file";
import { readRenewalStatus } from "./renewal";
import type {
  CollectorSnapshot,
  QuotaErrorCode,
  QuotaSnapshot,
  RenewalStatus,
  SessionState,
} from "./types";

export interface CollectorOptions {
  cookieFile: string;
  accountLabel: string;
  fetchSnapshot: (
    cookie: string,
    now: Date,
    signal: AbortSignal,
  ) => Promise<QuotaSnapshot>;
  now?: () => Date;
  pollIntervalMs?: number;
  // While blocked, how often to look for a replaced session file.
  sessionCheckIntervalMs?: number;
  // Minimum spacing between retries of an unchanged rejected session.
  authRetryIntervalMs?: number;
  // Defaults to renewal-status.json beside cookieFile.
  renewalStatusFile?: string;
  // One line per session-state transition; never secrets, bodies or error text.
  log?: (line: string) => void;
}
// Canonical Date#toISOString() form only, so consumers can parse strictly.
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
function isoOrNull(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return null;
  const iso = date.toISOString();
  return ISO_UTC.test(iso) ? iso : null;
}
type SessionRead =
  | { kind: "ok"; cookie: string; fingerprint: string; updatedAt: string | null }
  | {
      kind: "missing" | "invalid_file";
      fingerprint: "missing" | "invalid";
      updatedAt: string | null;
    };
// Never throws. mtime is reported only for an observed regular file.
async function readSession(path: string): Promise<SessionRead> {
  const file = await readOwnedFile(path, 16385, 0o077);
  const updatedAt = file.stat?.isFile() ? isoOrNull(file.stat.mtimeMs) : null;
  if (!file.ok)
    return file.reason === "missing"
      ? { kind: "missing", fingerprint: "missing", updatedAt }
      : { kind: "invalid_file", fingerprint: "invalid", updatedAt };
  let cookie: string;
  try {
    cookie = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(file.bytes)
      .trim();
  } catch {
    cookie = "";
  }
  // Strict UTF-8 that trims to printable ASCII; anything else could not be sent.
  if (!SESSION_COOKIE.test(cookie))
    return { kind: "invalid_file", fingerprint: "invalid", updatedAt };
  // The content hash also catches same-inode rewrites within mtime granularity.
  // Fingerprints stay in memory only.
  const { dev, ino, size, mtimeMs } = file.stat;
  const digest = createHash("sha256").update(cookie).digest("hex");
  return {
    kind: "ok",
    cookie,
    fingerprint: `${dev}:${ino}:${size}:${mtimeMs}:${digest}`,
    updatedAt,
  };
}
export function createCollector(options: CollectorOptions): {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
} {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((line: string) => console.error(line));
  const pollMs = options.pollIntervalMs ?? 300000,
    checkMs = options.sessionCheckIntervalMs ?? 15000,
    retryMs = options.authRetryIntervalMs ?? 3600000;
  const renewalFile =
    options.renewalStatusFile ??
    join(dirname(options.cookieFile), "renewal-status.json");
  let snapshot: QuotaSnapshot = {
    schemaVersion: 1,
    region: "sgp",
    accountLabel: options.accountLabel,
    planName: null,
    pools: [],
    fetchedAt: null,
    expiresAt: null,
    expired: null,
    resetsAt: null,
    stale: true,
    error: "unavailable",
  };
  let state: SessionState = "unknown",
    updatedAt: string | null = null,
    rejectedAt: string | null = null,
    // Fingerprint the blocking verdict applies to (the content sent, or a file sentinel).
    blockedFingerprint: string | null = null,
    lastAttempt: number | null = null,
    renewal: RenewalStatus | null = null;
  let closed = false,
    pending: Promise<void> | null = null,
    checking: Promise<void> | null = null;
  const controller = new AbortController();
  const blocked = () =>
    state === "expired" || state === "missing" || state === "invalid_file";
  function enter(next: SessionState) {
    if (next === state) return;
    try {
      log(`session state ${state} -> ${next}`);
    } catch {}
    state = next;
  }
  function block(next: SessionState, fingerprint: string) {
    // rejectedAt marks the FIRST rejection of this exact session content.
    if (!blocked() || blockedFingerprint !== fingerprint || rejectedAt === null)
      rejectedAt = isoOrNull(now().getTime());
    blockedFingerprint = fingerprint;
    enter(next);
  }
  function unblock(next: SessionState) {
    rejectedAt = blockedFingerprint = null;
    enter(next);
  }
  async function refresh() {
    if (closed || pending) return;
    pending = (async () => {
      try {
        const read = await readSession(options.cookieFile);
        if (closed) return;
        updatedAt = read.updatedAt;
        if (read.kind !== "ok") {
          // A missing or invalid file never reaches Xiaomi.
          block(read.kind, read.fingerprint);
          snapshot = { ...snapshot, stale: true, error: "auth_required" };
        } else {
          const started = now();
          lastAttempt = started.getTime();
          let next: QuotaSnapshot | null = null,
            code: QuotaErrorCode = "unavailable";
          try {
            next = await options.fetchSnapshot(
              read.cookie,
              started,
              controller.signal,
            );
          } catch (error) {
            if (error instanceof QuotaError) code = error.code;
          }
          if (closed) return;
          if (next) {
            snapshot = next;
            unblock("ok");
          } else {
            if (code === "auth_required") block("expired", read.fingerprint);
            // Non-auth failures keep the verdict, unless it was about a session
            // that has since been replaced: that one is unverified, not rejected.
            else if (blocked() && blockedFingerprint !== read.fingerprint)
              unblock("unknown");
            snapshot = {
              ...snapshot,
              stale: true,
              error: blocked() ? "auth_required" : code,
            };
          }
        }
        const status = await readRenewalStatus(renewalFile);
        if (!closed) renewal = status;
      } catch {
        if (!closed)
          snapshot = {
            ...snapshot,
            stale: true,
            error: blocked() ? "auth_required" : "unavailable",
          };
      }
    })();
    try {
      await pending;
    } finally {
      pending = null;
    }
  }
  // Session-check tick: renewal status always; the session file only while blocked.
  async function check() {
    if (closed || pending || checking) return;
    let changed = false;
    checking = (async () => {
      try {
        if (blocked()) {
          const read = await readSession(options.cookieFile);
          if (closed || pending) return;
          updatedAt = read.updatedAt;
          changed = read.fingerprint !== blockedFingerprint;
        }
        const status = await readRenewalStatus(renewalFile);
        if (!closed) renewal = status;
      } catch {}
    })();
    try {
      await checking;
    } finally {
      checking = null;
    }
    if (changed) await refresh();
  }
  function poll() {
    if (closed) return;
    const elapsed =
      lastAttempt === null ? Infinity : now().getTime() - lastAttempt;
    // An unchanged rejected session waits for retryMs; replacements go through check().
    if (blocked() && elapsed >= 0 && elapsed < retryMs) return;
    void refresh();
  }
  const initial = refresh();
  const timers = [
    setInterval(() => {
      try {
        poll();
      } catch {}
    }, pollMs),
    setInterval(() => {
      check().catch(() => {});
    }, checkMs),
  ];
  return {
    async fetch(request) {
      const url = new URL(request.url);
      const headers = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      };
      if (request.method !== "GET")
        return new Response(null, {
          status: 405,
          headers: { ...headers, Allow: "GET" },
        });
      if (url.search || !["/healthz", "/v1/quota"].includes(url.pathname))
        return new Response(null, { status: 404, headers });
      if (url.pathname === "/healthz")
        return Response.json({ ok: true }, { headers });
      await initial;
      const age =
        snapshot.fetchedAt === null
          ? Infinity
          : now().getTime() - Date.parse(snapshot.fetchedAt);
      const isBlocked = blocked();
      const body: CollectorSnapshot = {
        ...snapshot,
        stale: snapshot.stale || age > 600000 || age < 0,
        session: {
          state,
          updatedAt,
          rejectedAt: isBlocked ? rejectedAt : null,
          lastAttemptAt: isoOrNull(lastAttempt),
          // A missing or unusable file is never sent; only a file change triggers a fetch.
          nextAttemptAt:
            lastAttempt === null ||
            state === "missing" ||
            state === "invalid_file"
              ? null
              : isoOrNull(lastAttempt + (isBlocked ? retryMs : pollMs)),
        },
        renewal,
      };
      return Response.json(body, { headers });
    },
    async close() {
      closed = true;
      for (const timer of timers) clearInterval(timer);
      controller.abort();
      await Promise.all([pending, checking]);
    },
  };
}
