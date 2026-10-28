// Laptop-side Xiaomi session refresher. Pure, dependency-injected logic; the
// entrypoint wires real ssh, CDP, fetch and clock. Cookie values only ever
// travel browser -> memory -> Xiaomi validation -> ssh stdin.

export const CONSOLE_URL =
  "https://platform.xiaomimimo.com/#/console/plan-manage";
const ORIGIN = "https://platform.xiaomimimo.com";
export const USAGE_URL = ORIGIN + "/api/v1/tokenPlan/usage";
export const COOKIE_NAMES = [
  "api-platform_serviceToken",
  "api-platform_slh",
  "api-platform_ph",
  "userId",
] as const;
export type RenewalResult =
  | "not_needed"
  | "renewed"
  | "signin_required"
  | "browser_unavailable"
  | "vendor_unavailable"
  | "account_mismatch"
  | "error";
type Failure = Exclude<RenewalResult, "not_needed" | "renewed">;
export const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UTC_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
const TARGET_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/;
// Non-empty segments only: a trailing '/' or '/.' would make the writer's test -L follow a symlink.
const DIR_RE = /^(\/[A-Za-z0-9._-]+)+$/;
const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MANUAL_RE = /^[\x20-\x7e]{1,160}$/;
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);
const PREFIX = "xiaomi-session-refresh: ";

export const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export function isUtc(v: unknown): v is string {
  if (typeof v !== "string" || !UTC_RE.test(v)) return false;
  const ms = Date.parse(v);
  // Round-trip rejects calendar overflow such as 02-30 that some parsers roll over.
  return (
    Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === v.slice(0, 19)
  );
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
export interface Config {
  cdpOrigin: string;
  sshTarget: string;
  remoteDir: string;
  container: string;
  hostLabel: string;
  manualCommand: string | null;
}
export interface Flags {
  force: boolean;
  check: boolean;
  // Install even if the browser's Xiaomi account differs from the installed session's.
  rebind: boolean;
}
export function parseArgs(argv: readonly string[]): Flags {
  const flags = { force: false, check: false, rebind: false };
  for (const arg of argv) {
    if (arg === "--force") flags.force = true;
    else if (arg === "--check") flags.check = true;
    else if (arg === "--rebind") flags.rebind = true;
    else throw new ConfigError("usage: refresh-session.ts [--check] [--force] [--rebind]");
  }
  return flags;
}
export function validSshTarget(v: string): boolean {
  // ssh also gets "--", but never let either half look like an option.
  return TARGET_RE.test(v) && !v.startsWith("-") && !v.includes("@-");
}
export const validRemoteDir = (v: string): boolean =>
  DIR_RE.test(v) && !v.split("/").some((s) => s === "." || s === "..");
export const validContainer = (v: string): boolean => CONTAINER_RE.test(v);
export function parseConfig(
  env: Record<string, string | undefined>,
  hostname: string,
): Config {
  let cdp: URL;
  try {
    cdp = new URL(env.XQ_CDP_URL || "http://127.0.0.1:9223");
  } catch {
    throw new ConfigError("XQ_CDP_URL must be an http:// loopback URL");
  }
  if (
    cdp.protocol !== "http:" ||
    !LOOPBACK.has(cdp.hostname) ||
    cdp.username ||
    cdp.password ||
    cdp.pathname !== "/" ||
    cdp.search ||
    cdp.hash
  )
    throw new ConfigError(
      "XQ_CDP_URL must be http://127.0.0.1|[::1]|localhost[:port] with no path",
    );
  const sshTarget = env.XQ_SSH_TARGET ?? "";
  if (!validSshTarget(sshTarget))
    throw new ConfigError("XQ_SSH_TARGET must be user@host ([A-Za-z0-9._-])");
  const remoteDir = env.XQ_REMOTE_DIR ?? "";
  if (!validRemoteDir(remoteDir))
    throw new ConfigError(
      "XQ_REMOTE_DIR must be an absolute path of [A-Za-z0-9._-] segments, no '.', '..', '//' or trailing '/'",
    );
  const container = env.XQ_COLLECTOR_CONTAINER ?? "";
  if (!validContainer(container))
    throw new ConfigError(
      "XQ_COLLECTOR_CONTAINER must match [A-Za-z0-9][A-Za-z0-9_.-]{0,127}",
    );
  const hostLabel =
    env.XQ_HOST_LABEL ||
    hostname
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .replace(/^[^A-Za-z0-9]+/, "")
      .slice(0, 64);
  if (!HOST_RE.test(hostLabel))
    throw new ConfigError(
      env.XQ_HOST_LABEL
        ? "XQ_HOST_LABEL must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}"
        : "hostname gives no valid label; set XQ_HOST_LABEL",
    );
  const manualCommand = env.XQ_MANUAL_COMMAND || null;
  if (manualCommand !== null && !MANUAL_RE.test(manualCommand))
    throw new ConfigError(
      "XQ_MANUAL_COMMAND must be 1-160 printable ASCII characters",
    );
  return {
    cdpOrigin: cdp.origin,
    sshTarget,
    remoteDir,
    container,
    hostLabel,
    manualCommand,
  };
}

// POSIX single-quote; also correct for bash, zsh and fish login shells.
export const shellQuote = (s: string): string =>
  "'" + s.replaceAll("'", "'\\''") + "'";
export const sshArgv = (target: string, command: string): string[] => {
  if (!validSshTarget(target)) throw new ConfigError("invalid ssh target");
  return [
    "ssh",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ClearAllForwardings=yes",
    "--",
    target,
    command,
  ];
};
// Runs inside the collector; emits only the fields the decision needs.
export const STATUS_JS =
  'const r=await fetch("http://127.0.0.1:8787/v1/quota",{signal:AbortSignal.timeout(12000)});' +
  "if(r.status!==200)process.exit(3);const j=await r.json();" +
  "console.log(JSON.stringify({error:j.error,stale:j.stale,fetchedAt:j.fetchedAt,session:j.session??null,renewal:j.renewal??null}))";
export function statusCommand(container: string): string {
  if (!validContainer(container)) throw new ConfigError("invalid container");
  return ["sudo", "-n", "docker", "exec", container, "bun", "-e", STATUS_JS]
    .map(shellQuote)
    .join(" ");
}
// stdin: push/rebind = cookie line + status JSON; status = status JSON only.
// LC_ALL=C makes lengths byte counts and [!\ -~] exactly "outside printable ASCII".
// push installs only over a session naming the same userId (rebind skips that check);
// values stay in shell variables and builtins, never argv or output.
// Exit 3 bad/missing dir, 4 foreign owner, 5 group/world access, 6/7 bad input,
// 8 installed session missing, unparseable or of another account.
export const WRITE_SH = `set -eu
LC_ALL=C
umask 077
d=$1 m=$2 t1= t2=
trap 'rm -f -- \${t1:+"$t1"} \${t2:+"$t2"}' EXIT
case $m in push|rebind|status) ;; *) exit 2 ;; esac
case $d in /*) ;; *) exit 3 ;; esac
case $d/ in *//*|*/./*|*/../*) exit 3 ;; esac
[ -d "$d" ] && [ ! -L "$d" ] || exit 3
[ "$(stat -c %u -- "$d")" = "$(id -u)" ] || exit 4
case $(stat -c %a -- "$d") in *00) ;; *) exit 5 ;; esac
uid() {
  local IFS=';' p k=0
  u=
  set -f
  for p in $1; do
    p=\${p#"\${p%%[![:space:]]*}"}
    p=\${p%"\${p##*[![:space:]]}"}
    case $p in userId=?*) k=$((k + 1)) u=\${p#userId=} ;; esac
  done
  set +f
  [ "$k" = 1 ]
}
if [ "$m" != status ]; then
  IFS= read -r c || exit 6
  [ -n "$c" ] && [ "\${#c}" -le 16384 ] || exit 6
  case $c in *[!\\ -~]*) exit 6 ;; esac
  uid "$c" || exit 6
  if [ "$m" = push ]; then
    n=$u f=$d/mimo_session
    [ -f "$f" ] && [ ! -L "$f" ] || exit 8
    o=$(head -c 16386 -- "$f"; echo .)
    [ "\${#o}" = "$(($(stat -c %s -- "$f") + 1))" ] || exit 8
    o=\${o%.}
    o=\${o#"\${o%%[![:space:]]*}"}
    o=\${o%"\${o##*[![:space:]]}"}
    [ -n "$o" ] && [ "\${#o}" -le 16384 ] || exit 8
    case $o in *[!\\ -~]*) exit 8 ;; esac
    uid "$o" && [ "$u" = "$n" ] || exit 8
    o= n=
  fi
  t1=$(mktemp "$d/.mimo_session.XXXXXXXX")
  printf '%s\\n' "$c" > "$t1"
  c= u=
fi
t2=$(mktemp "$d/.renewal-status.XXXXXXXX")
head -c 4097 > "$t2"
s=$(wc -c < "$t2")
[ "$s" -ge 2 ] && [ "$s" -le 4096 ] || exit 7
chmod 600 -- "$t2" \${t1:+"$t1"}
if [ -n "$t1" ]; then mv -fT -- "$t1" "$d/mimo_session"; t1=; fi
mv -fT -- "$t2" "$d/renewal-status.json"
t2=
`;
export function writeCommand(dir: string, mode: "push" | "rebind" | "status"): string {
  if (!validRemoteDir(dir)) throw new ConfigError("invalid remote directory");
  return ["bash", "-c", WRITE_SH, "xiaomi-session-write", dir, mode]
    .map(shellQuote)
    .join(" ");
}

export type SshRunner = (
  argv: readonly string[],
  stdin: string | null,
  timeoutMs: number,
) => Promise<{ code: number; stdout: string }>;
const SSH_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "SSH_AUTH_SOCK"];
const MAX_STDOUT = 65536;
export function spawnRunner(
  options: { binary?: string; env?: Record<string, string | undefined> } = {},
): SshRunner {
  return async (argv, stdin, timeoutMs) => {
    const source = options.env ?? process.env,
      env: Record<string, string> = {};
    for (const key of SSH_ENV) if (source[key]) env[key] = source[key]!;
    // stderr is discarded: it may echo remote errors, which are never logged.
    const proc = Bun.spawn([options.binary ?? argv[0], ...argv.slice(1)], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env,
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    try {
      try {
        if (stdin !== null) proc.stdin.write(stdin);
        await proc.stdin.end();
      } catch {
        // Early exit closes the pipe; the exit code reports the failure.
      }
      // Counted while reading: a hostile remote must not grow laptop memory.
      const chunks: Uint8Array[] = [];
      let total = 0,
        over = false;
      const read = async () => {
        const reader = proc.stdout.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) return;
            total += value.byteLength;
            if (total > MAX_STDOUT) {
              over = true;
              proc.kill("SIGKILL");
              await reader.cancel().catch(() => undefined);
              return;
            }
            chunks.push(value);
          }
        } catch {
          over = true;
          proc.kill("SIGKILL");
        }
      };
      const [, code] = await Promise.all([read(), proc.exited]);
      return over
        ? { code: 1, stdout: "" }
        : { code, stdout: new TextDecoder().decode(Buffer.concat(chunks)) };
    } finally {
      clearTimeout(timer);
    }
  };
}

export class BrowserUnavailable extends Error {
  constructor() {
    super("browser_unavailable");
    this.name = "BrowserUnavailable";
  }
}
export class CdpError extends Error {
  constructor() {
    super("cdp_error");
    this.name = "CdpError";
  }
}
export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}
export interface CdpClient {
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  onEvent(listener: (event: CdpEvent) => void): () => void;
  readonly closed: Promise<void>;
  close(): void;
}
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
export interface ConnectOptions {
  fetch?: Fetcher;
  WebSocket?: typeof WebSocket;
  timeoutMs?: number;
  commandTimeoutMs?: number;
}
export async function connectBrowser(
  origin: string,
  options: ConnectOptions = {},
): Promise<CdpClient> {
  // One budget for discovery and socket open together.
  const timeoutMs = options.timeoutMs ?? 3000,
    end = Date.now() + timeoutMs;
  let path: string;
  try {
    const response = await (options.fetch ?? fetch)(origin + "/json/version", {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) throw new BrowserUnavailable();
    const body: unknown = JSON.parse(await response.text());
    if (!record(body) || typeof body.webSocketDebuggerUrl !== "string")
      throw new BrowserUnavailable();
    const ws = new URL(body.webSocketDebuggerUrl);
    if (
      ws.protocol !== "ws:" ||
      !LOOPBACK.has(ws.hostname) ||
      ws.username ||
      ws.password ||
      ws.search ||
      ws.hash ||
      !/^\/devtools\/browser\/[A-Za-z0-9-]{1,128}$/.test(ws.pathname)
    )
      throw new BrowserUnavailable();
    path = ws.pathname;
  } catch {
    throw new BrowserUnavailable();
  }
  // Reconnect to the configured loopback origin, never a host the endpoint names.
  let socket: WebSocket;
  try {
    socket = new (options.WebSocket ?? WebSocket)(
      "ws://" + new URL(origin).host + path,
    );
  } catch {
    throw new BrowserUnavailable();
  }
  const listeners = new Set<(event: CdpEvent) => void>();
  const pending = new Map<
    number,
    {
      resolve: (v: Record<string, unknown>) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let nextId = 0,
    isClosed = false,
    markClosed!: () => void;
  const closed = new Promise<void>((resolve) => (markClosed = resolve));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        socket.close();
        reject(new BrowserUnavailable());
      },
      Math.max(1, end - Date.now()),
    );
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      isClosed = true;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new BrowserUnavailable());
      }
      pending.clear();
      markClosed();
      reject(new BrowserUnavailable());
    });
  });
  socket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    let message: unknown;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!record(message)) return;
    if (typeof message.id === "number") {
      const p = pending.get(message.id);
      if (!p) return;
      pending.delete(message.id);
      clearTimeout(p.timer);
      if (message.error !== undefined || !record(message.result))
        p.reject(new CdpError());
      else p.resolve(message.result);
    } else if (typeof message.method === "string") {
      const e: CdpEvent = {
        method: message.method,
        params: record(message.params) ? message.params : {},
        ...(typeof message.sessionId === "string"
          ? { sessionId: message.sessionId }
          : {}),
      };
      for (const listener of [...listeners])
        try {
          listener(e);
        } catch {
          // A faulty listener must not break protocol dispatch.
        }
    }
  });
  return {
    closed,
    send(method, params = {}, sessionId, ms) {
      if (isClosed) return Promise.reject(new BrowserUnavailable());
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new CdpError());
        }, ms ?? options.commandTimeoutMs ?? 10000);
        pending.set(id, { resolve, reject, timer });
        try {
          socket.send(
            JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
          );
        } catch {
          pending.delete(id);
          clearTimeout(timer);
          reject(new BrowserUnavailable());
        }
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    close() {
      socket.close();
    },
  };
}

export interface Timeouts {
  statusSshMs: number;
  writeSshMs: number;
  connectMs: number;
  commandMs: number;
  navigationMs: number;
  signinGraceMs: number;
  pollMs: number;
  vendorMs: number;
  // Budget for every step up to and including the install. After it only the owned-tab
  // close (closeMs) and one final status write (writeSshMs) may run.
  runMs: number;
  closeMs: number;
}
export const DEFAULT_TIMEOUTS: Timeouts = {
  statusSshMs: 25000,
  writeSshMs: 20000,
  connectMs: 3000,
  commandMs: 10000,
  navigationMs: 45000,
  signinGraceMs: 8000,
  pollMs: 250,
  vendorMs: 10000,
  runMs: 100000,
  closeMs: 2000,
};
const DEADLINE = "run deadline exceeded";
const INTERRUPTED = "interrupted";
export interface RunContext {
  // Timeout for the next step: its own cap, never past the run deadline.
  budget(capMs: number): number;
  // True within 20 ms of the deadline, so a step cut by budget() always counts as expired.
  expired(): boolean;
  // Aborted on SIGTERM/SIGINT.
  signal?: AbortSignal;
}
export function runContext(runMs: number, signal?: AbortSignal): RunContext {
  const end = performance.now() + runMs;
  return {
    budget: (capMs) => Math.max(1, Math.min(capMs, end - performance.now())),
    expired: () => performance.now() >= end - 20,
    signal,
  };
}
const stopped = (run: RunContext): string | null =>
  run.signal?.aborted ? INTERRUPTED : run.expired() ? DEADLINE : null;
type Outcome = { header: string } | { result: Failure; reason: string };
const signinHost = (h: string) =>
  h === "account.xiaomi.com" || h.endsWith(".account.xiaomi.com");

export function selectCookies(cookies: unknown): Outcome {
  if (!Array.isArray(cookies))
    return { result: "error", reason: "browser returned no cookie list" };
  const parts: string[] = [];
  for (const name of COOKIE_NAMES) {
    const found = cookies.filter(
      (c) =>
        record(c) &&
        c.name === name &&
        typeof c.domain === "string" &&
        (c.domain.replace(/^\./, "") === "xiaomimimo.com" ||
          c.domain.replace(/^\./, "").endsWith(".xiaomimimo.com")),
    );
    if (found.length > 1)
      return { result: "error", reason: "duplicate Xiaomi session cookie" };
    const value = found[0]?.value;
    if (found.length === 0 || value === "")
      return {
        result: "signin_required",
        reason: "Xiaomi session cookie missing in browser",
      };
    // Printable ASCII without space or ';' keeps the header unambiguous.
    if (typeof value !== "string" || !/^[\x21-\x3a\x3c-\x7e]+$/.test(value))
      return { result: "error", reason: "malformed Xiaomi session cookie" };
    parts.push(name + "=" + value);
  }
  const header = parts.join("; ");
  // The collector accepts only 1-16384 printable ASCII characters.
  if (!/^[\x20-\x7e]{1,16384}$/.test(header))
    return { result: "error", reason: "malformed Xiaomi session cookie" };
  return { header };
}

// Evaluated in the owned tab; yields only a boolean, never page data.
export const READY_JS =
  "(()=>{try{return performance.getEntriesByType('resource').some(e=>{try{const u=new URL(e.name);" +
  "return u.origin+u.pathname===" +
  JSON.stringify(USAGE_URL) +
  "&&e.responseStatus===200}catch{return false}})===true}catch{return false}})()";
type Wait = "loaded" | "timeout" | "signin" | "nav_failed" | "detached" | "closed";
// The Network domain stays disabled: its event stream would carry every request's
// Cookie headers, including account-host passToken during the SSO hop. Readiness comes
// from main-frame Page.frameNavigated (sign-in grace) and a boolean poll of the tab's
// resource timing for the usage API (responseStatus 200, same origin).
function waitForConsole(
  client: CdpClient,
  targetId: string,
  sessionId: string,
  t: Timeouts,
  run: RunContext,
): Promise<Wait> {
  return new Promise((resolve) => {
    let grace: ReturnType<typeof setTimeout> | undefined,
      poll: ReturnType<typeof setTimeout> | undefined,
      settled = false;
    const done = (v: Wait) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      clearTimeout(poll);
      off();
      run.signal?.removeEventListener("abort", interrupt);
      resolve(v);
    };
    // Interrupt or deadline end the wait like a timeout; the caller then stops.
    const interrupt = () => done("timeout");
    const timer = setTimeout(interrupt, run.budget(t.navigationMs));
    const off = client.onEvent(({ method, params, sessionId: sid }) => {
      if (
        (method === "Target.detachedFromTarget" && params.sessionId === sessionId) ||
        ((method === "Target.targetDestroyed" || method === "Target.targetCrashed") &&
          params.targetId === targetId) ||
        (method === "Inspector.targetCrashed" && sid === sessionId)
      )
        return done("detached");
      if (sid !== sessionId || method !== "Page.frameNavigated") return;
      // Main frame only: its id is the target id and it has no parent.
      const frame = params.frame;
      if (
        !record(frame) ||
        frame.id !== targetId ||
        frame.parentId !== undefined ||
        typeof frame.url !== "string"
      )
        return;
      let host: string;
      try {
        host = new URL(frame.url).hostname;
      } catch {
        return;
      }
      // SSO pass-through may briefly commit on the account host; a login page stays.
      if (signinHost(host)) grace ??= setTimeout(() => done("signin"), t.signinGraceMs);
      else {
        clearTimeout(grace);
        grace = undefined;
      }
    });
    run.signal?.addEventListener("abort", interrupt);
    if (run.signal?.aborted) return interrupt();
    void client.closed.then(() => done("closed"));
    const tick = async () => {
      try {
        const r = await client.send(
          "Runtime.evaluate",
          { expression: READY_JS, returnByValue: true },
          sessionId,
          run.budget(t.commandMs),
        );
        if (
          record(r.result) &&
          r.result.type === "boolean" &&
          r.result.value === true &&
          r.exceptionDetails === undefined
        )
          return done("loaded");
      } catch (error) {
        if (error instanceof BrowserUnavailable) return done("closed");
        // A navigation can destroy the context mid-call; keep polling.
      }
      if (!settled) poll = setTimeout(tick, t.pollMs);
    };
    client
      .send("Page.navigate", { url: CONSOLE_URL }, sessionId, t.navigationMs + 5000)
      .then(
        (r) => {
          // ERR_ABORTED: superseded by a redirect navigation, keep waiting.
          if (
            typeof r.errorText === "string" &&
            r.errorText &&
            r.errorText !== "net::ERR_ABORTED"
          )
            done("nav_failed");
        },
        (e) => done(e instanceof BrowserUnavailable ? "closed" : "detached"),
      );
    poll = setTimeout(tick, t.pollMs);
  });
}
export async function readBrowserSession(
  client: CdpClient,
  t: Timeouts,
  run: RunContext,
): Promise<Outcome> {
  let targetId: string | null = null,
    closing: Promise<unknown> | undefined;
  // Once, bounded by closeMs: immediately on interrupt, otherwise in finally.
  const closeOwned = () =>
    targetId === null
      ? undefined
      : (closing ??= client
          .send("Target.closeTarget", { targetId }, undefined, t.closeMs)
          .catch(() => undefined));
  const onInterrupt = () => void closeOwned();
  run.signal?.addEventListener("abort", onInterrupt);
  // Timeout for the next command; none once interrupted or past the deadline.
  const ms = () => {
    if (stopped(run)) throw new CdpError();
    return run.budget(t.commandMs);
  };
  try {
    // Task-owned target only: never list, activate or navigate other targets.
    const created = await client.send(
      "Target.createTarget",
      { url: "about:blank", background: true },
      undefined,
      ms(),
    );
    if (typeof created.targetId !== "string" || !created.targetId)
      throw new CdpError();
    targetId = created.targetId;
    const attached = await client.send(
      "Target.attachToTarget",
      { targetId, flatten: true },
      undefined,
      ms(),
    );
    if (typeof attached.sessionId !== "string" || !attached.sessionId)
      throw new CdpError();
    const sessionId = attached.sessionId;
    await client.send("Page.enable", {}, sessionId, ms());
    const wait = await waitForConsole(client, targetId, sessionId, t, run);
    if (wait === "signin")
      return {
        result: "signin_required",
        reason: "browser redirected to Xiaomi sign-in",
      };
    if (wait === "nav_failed")
      return { result: "vendor_unavailable", reason: "Xiaomi console unreachable" };
    if (wait === "closed") throw new BrowserUnavailable();
    if (wait === "detached") throw new CdpError();
    // A command, not the event stream: works without Network.enable. Scoped to the
    // platform URL so account.xiaomi.com cookies never leave the browser.
    const got = await client.send(
      "Network.getCookies",
      { urls: [USAGE_URL] },
      sessionId,
      ms(),
    );
    return selectCookies(got.cookies);
  } catch (error) {
    const stop = stopped(run);
    if (stop) return { result: "error", reason: stop };
    return error instanceof BrowserUnavailable
      ? { result: "browser_unavailable", reason: "browser connection lost" }
      : { result: "error", reason: "browser automation failed" };
  } finally {
    run.signal?.removeEventListener("abort", onInterrupt);
    await closeOwned();
  }
}

const MAX_BODY = 1024 * 1024;
async function bodyCode(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const body: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    return record(body) ? body.code : undefined;
  } catch {
    return undefined;
  }
}
export async function validateSession(
  header: string,
  fetcher: Fetcher,
  timeoutMs: number,
): Promise<"ok" | "signin_required" | "vendor_unavailable"> {
  const signal = AbortSignal.timeout(timeoutMs);
  for (const path of ["usage", "detail"]) {
    try {
      const response = await fetcher(ORIGIN + "/api/v1/tokenPlan/" + path, {
        method: "GET",
        redirect: "error",
        signal,
        headers: {
          Cookie: header,
          Accept: "application/json",
          "x-timeZone": "Europe/Kiev",
        },
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        return "signin_required";
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        return "vendor_unavailable";
      }
      const code = await bodyCode(response);
      if (code === 401 || code === 403) return "signin_required";
      if (code !== 0) return "vendor_unavailable";
    } catch {
      return "vendor_unavailable";
    }
  }
  return "ok";
}

export interface CollectorStatus {
  error: "auth_required" | "unavailable" | "schema_changed" | null;
  rejectedAt: string | null;
  renewedAt: string | null;
}
// v0.2.x collectors omit session/renewal; absent and null are equivalent.
export function parseCollectorStatus(stdout: string): CollectorStatus | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (
    !record(v) ||
    !(
      v.error === null ||
      v.error === "auth_required" ||
      v.error === "unavailable" ||
      v.error === "schema_changed"
    ) ||
    typeof v.stale !== "boolean" ||
    !(v.fetchedAt === null || typeof v.fetchedAt === "string") ||
    !(v.session == null || record(v.session)) ||
    !(v.renewal == null || record(v.renewal))
  )
    return null;
  return {
    error: v.error,
    rejectedAt:
      record(v.session) && isUtc(v.session.rejectedAt) ? v.session.rejectedAt : null,
    renewedAt:
      record(v.renewal) && isUtc(v.renewal.renewedAt) ? v.renewal.renewedAt : null,
  };
}
export function statusJson(
  cfg: Pick<Config, "hostLabel" | "manualCommand">,
  result: RenewalResult,
  now: Date,
  renewedAt: string | null,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    checkedAt: now.toISOString(),
    result,
    renewedAt,
    host: cfg.hostLabel,
    manualCommand: cfg.manualCommand,
  });
}

export interface Deps {
  ssh: SshRunner;
  connectBrowser: (origin: string, timeoutMs: number) => Promise<CdpClient>;
  fetch: Fetcher;
  now: () => Date;
  // Aborted on SIGTERM/SIGINT: close the owned tab, write nothing more.
  signal?: AbortSignal;
}
export interface RunOutcome {
  code: 0 | 1 | 2 | 3;
  line: string;
}
const REMOTE_EXIT: Record<number, string> = {
  3: "remote session directory missing",
  4: "remote session directory not owned by ssh user",
  5: "remote session directory is group/world accessible",
  8: "installed session belongs to another account",
  255: "ssh failed",
};
const exitCode = (r: RenewalResult): 0 | 1 | 2 | 3 =>
  r === "not_needed" || r === "renewed"
    ? 0
    : r === "signin_required"
      ? 2
      : r === "account_mismatch"
        ? 3
        : 1;
export async function runRefresh(
  cfg: Config,
  flags: Flags,
  deps: Deps,
  t: Timeouts = DEFAULT_TIMEOUTS,
): Promise<RunOutcome> {
  const run = runContext(t.runMs, deps.signal);
  const interrupted = (): RunOutcome => ({ code: 1, line: PREFIX + INTERRUPTED });
  if (deps.signal?.aborted) return interrupted();
  let status: CollectorStatus | null = null;
  try {
    const r = await deps.ssh(
      sshArgv(cfg.sshTarget, statusCommand(cfg.container)),
      null,
      run.budget(t.statusSshMs),
    );
    if (r.code === 0) status = parseCollectorStatus(r.stdout);
  } catch {
    status = null;
  }
  if (deps.signal?.aborted) return interrupted();
  if (!status) return { code: 1, line: PREFIX + "collector_unreachable" };
  const s = status;
  const needed = flags.force || s.error === "auth_required";
  const context =
    (flags.force ? "forced; " : "") +
    (flags.rebind ? "rebind; " : "") +
    (s.error === null
      ? "collector ok"
      : "collector " + s.error + (s.rejectedAt && s.error === "auth_required" ? " since " + s.rejectedAt : ""));
  if (flags.check)
    return {
      code: 0,
      line: PREFIX + "check: " + (needed ? "renewal needed" : "not_needed") + " (" + context + ")",
    };
  async function write(
    result: RenewalResult,
    renewedAt: string | null,
    now: Date,
    cookieHeader: string | null = null,
    timeoutMs = t.writeSshMs,
  ): Promise<number> {
    const json = statusJson(cfg, result, now, renewedAt);
    try {
      const mode = cookieHeader === null ? "status" : flags.rebind ? "rebind" : "push";
      const r = await deps.ssh(
        sshArgv(cfg.sshTarget, writeCommand(cfg.remoteDir, mode)),
        (cookieHeader === null ? "" : cookieHeader + "\n") + json + "\n",
        timeoutMs,
      );
      return r.code;
    } catch {
      return -1;
    }
  }
  const why = (code: number) => REMOTE_EXIT[code] ?? "remote exit " + code;
  // The one status write allowed after the deadline (bounded by writeSshMs).
  async function fail(result: Failure, reason: string): Promise<RunOutcome> {
    if (deps.signal?.aborted) return interrupted();
    // Best effort: the collector page shows this; the exit code still reports it.
    const code = await write(result, s.renewedAt, deps.now());
    return {
      code: exitCode(result),
      line:
        PREFIX + result + " (" + reason + "; " + context + ")" +
        (code === 0 ? "" : "; status write failed: " + why(code)),
    };
  }
  try {
    if (!needed) {
      const code = await write("not_needed", s.renewedAt, deps.now());
      // A heartbeat that cannot be recorded is surfaced as a unit failure.
      return code === 0
        ? { code: 0, line: PREFIX + "not_needed (" + context + ")" }
        : {
            code: 1,
            line: PREFIX + "not_needed (" + context + "); status write failed: " + why(code),
          };
    }
    if (run.expired()) return fail("error", DEADLINE);
    let client: CdpClient;
    try {
      client = await deps.connectBrowser(cfg.cdpOrigin, run.budget(t.connectMs));
    } catch {
      const stop = stopped(run);
      return stop ? fail("error", stop) : fail("browser_unavailable", "DevTools endpoint unreachable");
    }
    let outcome: Outcome;
    try {
      outcome = await readBrowserSession(client, t, run);
    } finally {
      client.close();
    }
    if ("result" in outcome) return fail(outcome.result, outcome.reason);
    if (run.expired()) return fail("error", DEADLINE);
    const valid = await validateSession(outcome.header, deps.fetch, run.budget(t.vendorMs));
    const stop = stopped(run);
    if (stop) return fail("error", stop);
    if (valid === "signin_required")
      return fail("signin_required", "Xiaomi rejected the browser session");
    if (valid === "vendor_unavailable")
      return fail("vendor_unavailable", "Xiaomi validation failed");
    const now = deps.now();
    const code = await write("renewed", now.toISOString(), now, outcome.header, run.budget(t.writeSshMs));
    if (code === 8)
      return fail("account_mismatch", "browser account does not match the installed session");
    if (code !== 0) return fail("error", "session push failed: " + why(code));
    return { code: 0, line: PREFIX + "renewed (" + context + ")" };
  } catch {
    return fail("error", "unexpected failure");
  }
}
