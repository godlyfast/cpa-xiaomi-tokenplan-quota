// Laptop-side Xiaomi session refresher. Pure, dependency-injected logic; the
// entrypoint wires real ssh, CDP, fetch and clock. Cookie values only ever
// travel browser -> memory -> Xiaomi validation -> ssh stdin.
import { dlopen, FFIType } from "bun:ffi";
import {
  closeSync,
  chmodSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

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
const CONTROL_RE = /[\x00-\x1f\x7f]/;
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
  // Launcher that can start the renewal browser; null keeps v0.3.0 behaviour.
  browserLaunch: string | null;
  notify: "desktop" | "none";
  // systemd 251+ sets TRIGGER_UNIT for timer-activated runs; only those back off.
  timerRun: boolean;
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
  const browserLaunch = env.XQ_BROWSER_LAUNCH || null;
  if (
    browserLaunch !== null &&
    (!browserLaunch.startsWith("/") ||
      browserLaunch.length > 4096 ||
      CONTROL_RE.test(browserLaunch))
  )
    throw new ConfigError(
      "XQ_BROWSER_LAUNCH must be an absolute path without control characters",
    );
  const notify = env.XQ_NOTIFY || "none";
  if (notify !== "desktop" && notify !== "none")
    throw new ConfigError("XQ_NOTIFY must be desktop or none");
  return {
    cdpOrigin: cdp.origin,
    sshTarget,
    remoteDir,
    container,
    hostLabel,
    manualCommand,
    browserLaunch,
    notify,
    timerRun: (env.TRIGGER_UNIT ?? "").endsWith(".timer"),
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
// 8 installed session missing, unparseable or of another account. push reads the
// installed session and its size through one descriptor (fd 3), so a concurrent
// rename cannot pair one file's content with another's size.
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
    exec 3< "$f" || exit 8
    [ -f /dev/fd/3 ] || exit 8
    o=$(head -c 16386 <&3; echo .)
    [ "\${#o}" = "$(($(stat -L -c %s /dev/fd/3) + 1))" ] || exit 8
    exec 3<&-
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
  // Keep up to 4 KiB of stderr, only to classify a failed status read; never printed.
  keepStderr?: boolean,
) => Promise<{ code: number; stdout: string; stderr?: string }>;
// Codes for runs that produced no exit code of their own.
export const TIMED_OUT = -1;
export const OVERSIZED = -2;
const SSH_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "SSH_AUTH_SOCK"];
// Launcher and notify-send: enough to reach the graphical session, nothing else.
export const SESSION_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "XDG_RUNTIME_DIR",
  "XDG_DATA_HOME",
  "XDG_DATA_DIRS",
  "XDG_CONFIG_HOME",
  "DBUS_SESSION_BUS_ADDRESS",
  "WAYLAND_DISPLAY",
  "DISPLAY",
  "HYPRLAND_INSTANCE_SIGNATURE",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_TYPE",
];
const pickEnv = (
  source: Record<string, string | undefined>,
  keys: readonly string[],
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of keys) if (source[key]) env[key] = source[key]!;
  return env;
};
const MAX_STDOUT = 65536;
const MAX_STDERR = 4096;
// After ssh exits, what it wrote is already buffered: a pipe that a descendant (a
// ProxyCommand helper, a wrapper) keeps open must not hold the call past this.
export const DRAIN_MS = 250;
export function spawnRunner(
  options: { binary?: string; env?: Record<string, string | undefined> } = {},
): SshRunner {
  return async (argv, stdin, timeoutMs, keepStderr = false) => {
    const env = pickEnv(options.env ?? process.env, SSH_ENV);
    // stderr may echo remote errors: discarded, or kept bounded for fixed classification only.
    const proc = Bun.spawn([options.binary ?? argv[0], ...argv.slice(1)], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: keepStderr ? "pipe" : "ignore",
      env,
    });
    const out = proc.stdout.getReader();
    const err =
      proc.stderr instanceof ReadableStream
        ? (proc.stderr as ReadableStream<Uint8Array>).getReader()
        : null;
    let timedOut = false,
      drained = false,
      drain: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      // Exited already (pipes still draining): its own exit code stands.
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    // Exit (or the kill) ends the call within DRAIN_MS, whoever still holds a pipe.
    const exited = proc.exited.then((code) => {
      drain = setTimeout(() => {
        drained = true;
        void out.cancel().catch(() => undefined);
        void err?.cancel().catch(() => undefined);
      }, DRAIN_MS);
      return code;
    });
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
        try {
          while (true) {
            const { value, done } = await out.read();
            if (done) return;
            total += value.byteLength;
            if (total > MAX_STDOUT) {
              over = true;
              proc.kill("SIGKILL");
              await out.cancel().catch(() => undefined);
              return;
            }
            chunks.push(value);
          }
        } catch {
          if (drained) return;
          over = true;
          proc.kill("SIGKILL");
        }
      };
      // Drained to the end so a chatty remote never blocks on a full pipe.
      const kept: Uint8Array[] = [];
      let keptBytes = 0;
      const readErr = async () => {
        if (!err) return;
        try {
          while (true) {
            const { value, done } = await err.read();
            if (done) return;
            if (keptBytes < MAX_STDERR) {
              const part = value.subarray(0, MAX_STDERR - keptBytes);
              kept.push(part);
              keptBytes += part.byteLength;
            }
          }
        } catch {
          // The exit code still reports the failure.
        }
      };
      const [, , code] = await Promise.all([read(), readErr(), exited]);
      if (over) return { code: OVERSIZED, stdout: "" };
      if (timedOut) return { code: TIMED_OUT, stdout: "" };
      return {
        code,
        stdout: new TextDecoder().decode(Buffer.concat(chunks)),
        ...(keepStderr ? { stderr: new TextDecoder().decode(Buffer.concat(kept)) } : {}),
      };
    } finally {
      clearTimeout(timer);
      clearTimeout(drain);
    }
  };
}

// Local helpers (launcher, notify-send): argv without a shell, stdin closed, output
// discarded, killed at the timeout or on abort.
export type LocalResult = number | "timeout" | "failed";
export async function runLocal(
  argv: readonly string[],
  env: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<LocalResult> {
  if (signal?.aborted) return "failed";
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...argv], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env });
  } catch {
    return "failed";
  }
  let killed = false;
  const kill = () => {
    killed = true;
    proc.kill("SIGKILL");
  };
  const timer = setTimeout(kill, timeoutMs);
  signal?.addEventListener("abort", kill);
  try {
    const code = await proc.exited;
    return killed ? "timeout" : code;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
  }
}
// No arguments: request a browser start (exit 0 = requested). check: exit 0 iff a start
// is possible now, without side effects.
export type Launcher = (
  check: boolean,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<LocalResult | "unsafe">;
// Checked at every use: a regular file (not a symlink) owned by this user, not group- or
// world-writable, owner-executable.
export function launcherSafe(path: string, uid: number): boolean {
  try {
    const s = lstatSync(path);
    return s.isFile() && s.uid === uid && (s.mode & 0o022) === 0 && (s.mode & 0o100) !== 0;
  } catch {
    return false;
  }
}
export function launcherRunner(
  path: string,
  options: { env?: Record<string, string | undefined>; uid?: number } = {},
): Launcher {
  return async (check, timeoutMs, signal) => {
    if (!launcherSafe(path, options.uid ?? process.getuid?.() ?? -1)) return "unsafe";
    return runLocal(
      check ? [path, "--check"] : [path],
      pickEnv(options.env ?? process.env, SESSION_ENV),
      timeoutMs,
      signal,
    );
  };
}
const launcherText = (r: LocalResult | "unsafe"): string =>
  typeof r === "number"
    ? "launcher exit " + r
    : r === "timeout"
      ? "launcher timed out"
      : r === "unsafe"
        ? "launcher missing or unsafe"
        : "launcher could not run";
export type Notifier = (
  urgency: "critical" | "normal",
  title: string,
  body: string,
  timeoutMs: number,
) => Promise<boolean>;
export function notifySend(
  options: { binary?: string; env?: Record<string, string | undefined> } = {},
): Notifier {
  return async (urgency, title, body, timeoutMs) =>
    (await runLocal(
      [
        options.binary ?? "notify-send",
        "--app-name=xiaomi-session-refresh",
        "--urgency=" + urgency,
        title,
        body,
      ],
      pickEnv(options.env ?? process.env, SESSION_ENV),
      timeoutMs,
    )) === 0;
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
  // The <id> of /devtools/browser/<id>: new for every browser process.
  readonly browserId: string;
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
  let path: string, browserId: string;
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
    browserId = path.slice("/devtools/browser/".length);
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
    browserId,
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
// Discovery only, no socket, tab or cookie: "up" when <origin>/json/version answers 200,
// "refused" when nothing listens on the port, "unknown" for anything else (a timeout, another
// status): a busy browser is not a stopped one.
export type ProbeState = "up" | "refused" | "unknown";
// Bun 1.3 reports a refused connection as ConnectionRefused, 1.4 as ECONNREFUSED.
const REFUSED = new Set(["ECONNREFUSED", "ConnectionRefused"]);
export async function probeBrowser(
  origin: string,
  timeoutMs: number,
  options: { fetch?: Fetcher; signal?: AbortSignal } = {},
): Promise<ProbeState> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await (options.fetch ?? fetch)(origin + "/json/version", {
      method: "GET",
      redirect: "error",
      signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status === 200 ? "up" : "unknown";
  } catch (error) {
    const code = record(error) ? error.code : undefined;
    return typeof code === "string" && REFUSED.has(code) ? "refused" : "unknown";
  }
}

export interface Timeouts {
  statusSshMs: number;
  writeSshMs: number;
  connectMs: number;
  commandMs: number;
  navigationMs: number;
  signinGraceMs: number;
  // Console readiness poll; also the discovery poll after a launch.
  pollMs: number;
  vendorMs: number;
  // One launcher run (start request or --check).
  launcherMs: number;
  // Wait for a launched browser's discovery endpoint.
  launchMs: number;
  // Budget for every step up to and including the install. After it only the owned-tab
  // close (closeMs), Browser.close of a browser this run started (browserCloseMs), one
  // final status write (writeSshMs) and one desktop notification (notifyMs) may run.
  runMs: number;
  closeMs: number;
  browserCloseMs: number;
  notifyMs: number;
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
  launcherMs: 5000,
  launchMs: 20000,
  runMs: 120000,
  closeMs: 2000,
  browserCloseMs: 3000,
  notifyMs: 5000,
};
// Longest run after start-up; the unit's TimeoutStartSec must exceed it with margin.
export const worstCaseMs = (t: Timeouts): number =>
  t.runMs + t.closeMs + t.browserCloseMs + t.writeSshMs + t.notifyMs;
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
// loaded: the console wait ended with the tab's own usage call answered 200.
type Session = Outcome & { loaded: boolean };
const COOKIE_MISSING = "Xiaomi session cookie missing in browser";
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
      return { result: "signin_required", reason: COOKIE_MISSING };
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
): Promise<Session> {
  let targetId: string | null = null,
    closing: Promise<unknown> | undefined,
    loaded = false;
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
    loaded = wait === "loaded";
    if (wait === "signin")
      return {
        result: "signin_required",
        reason: "browser redirected to Xiaomi sign-in",
        loaded,
      };
    if (wait === "nav_failed")
      return { result: "vendor_unavailable", reason: "Xiaomi console unreachable", loaded };
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
    return { ...selectCookies(got.cookies), loaded };
  } catch (error) {
    const stop = stopped(run);
    if (stop) return { result: "error", reason: stop, loaded };
    return error instanceof BrowserUnavailable
      ? { result: "browser_unavailable", reason: "browser connection lost", loaded }
      : { result: "error", reason: "browser automation failed", loaded };
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
  interrupt?: AbortSignal,
): Promise<"ok" | "signin_required" | "vendor_unavailable"> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = interrupt ? AbortSignal.any([timeout, interrupt]) : timeout;
  for (const path of ["usage", "detail"]) {
    // Never start a cookie-bearing request after SIGTERM/SIGINT.
    if (interrupt?.aborted) return "vendor_unavailable";
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

const SESSION_STATES = ["unknown", "ok", "expired", "missing", "invalid_file"] as const;
export type SessionState = (typeof SESSION_STATES)[number];
export interface CollectorStatus {
  error: "auth_required" | "unavailable" | "schema_changed" | null;
  rejectedAt: string | null;
  renewedAt: string | null;
  // session.state and the session file's mtime; null from v0.2.x collectors.
  state: SessionState | null;
  updatedAt: string | null;
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
  const session = record(v.session) ? v.session : {};
  return {
    error: v.error,
    rejectedAt: isUtc(session.rejectedAt) ? session.rejectedAt : null,
    renewedAt:
      record(v.renewal) && isUtc(v.renewal.renewedAt) ? v.renewal.renewedAt : null,
    state: SESSION_STATES.includes(session.state as SessionState)
      ? (session.state as SessionState)
      : null,
    updatedAt: isUtc(session.updatedAt) ? session.updatedAt : null,
  };
}
// Why a status read failed. stderr only selects a fixed phrase; it is never printed.
export function collectorCause(
  r: { code: number; stderr?: string } | null,
): string {
  if (r === null || r.code === TIMED_OUT) return "ssh timed out or could not start";
  if (r.code === 0) return "unrecognised collector status";
  if (r.code === 255) return "ssh failed";
  if (r.code === 3) return "collector HTTP status not 200";
  if (r.code === OVERSIZED) return "collector output over 64 KiB";
  const err = r.stderr ?? "";
  if (err.includes("a password is required") || err.includes("sudo:")) return "sudo refused";
  if (err.includes("No such container") || err.includes("is not running"))
    return "collector container not running";
  return "remote exit " + r.code;
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

// Local run state. A result kind is a status result, or vendor_changed (reported as
// error) when the browser is signed in but its cookies are missing or rejected.
export type Kind = RenewalResult | "vendor_changed";
const KINDS: readonly Kind[] = [
  "not_needed",
  "renewed",
  "signin_required",
  "browser_unavailable",
  "vendor_unavailable",
  "account_mismatch",
  "error",
  "vendor_changed",
];
const NEEDS_PERSON: readonly Kind[] = [
  "signin_required",
  "account_mismatch",
  "browser_unavailable",
  "vendor_changed",
];
const BACKS_OFF: readonly Kind[] = ["signin_required", "account_mismatch", "vendor_changed"];
const MAX_COUNT = 1000000;
// No secrets and no userId: results, counts and collector timestamps only.
export interface RunState {
  schemaVersion: 1;
  // Last run's result and how many consecutive runs ended with it.
  last: Kind | null;
  count: number;
  // Last browser-path attempt and the collector's session timestamps seen then.
  attemptAt: string | null;
  attemptRejectedAt: string | null;
  attemptUpdatedAt: string | null;
  // Needs-a-person result last notified; null after a delivered recovery notice.
  notified: Kind | null;
}
export const EMPTY_STATE: RunState = {
  schemaVersion: 1,
  last: null,
  count: 0,
  attemptAt: null,
  attemptRejectedAt: null,
  attemptUpdatedAt: null,
  notified: null,
};
const STATE_KEYS = Object.keys(EMPTY_STATE).sort();
const STATE_MAX = 4096;
export function parseState(text: string): RunState | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!record(v)) return null;
  const keys = Object.keys(v).sort();
  if (keys.length !== STATE_KEYS.length || keys.some((k, i) => k !== STATE_KEYS[i]))
    return null;
  const time = (x: unknown) => x === null || isUtc(x);
  if (
    v.schemaVersion !== 1 ||
    !(v.last === null || KINDS.includes(v.last as Kind)) ||
    typeof v.count !== "number" ||
    !Number.isSafeInteger(v.count) ||
    v.count < 0 ||
    v.count > MAX_COUNT ||
    !time(v.attemptAt) ||
    !time(v.attemptRejectedAt) ||
    !time(v.attemptUpdatedAt) ||
    !(v.notified === null || NEEDS_PERSON.includes(v.notified as Kind))
  )
    return null;
  return v as unknown as RunState;
}
export interface StateStore {
  load(): RunState;
  // False when the state could not be saved; never throws.
  save(state: RunState): boolean;
}
const absolute = (v: string | undefined): v is string =>
  typeof v === "string" && v.startsWith("/") && !CONTROL_RE.test(v);
// systemd StateDirectory=, else XDG_STATE_HOME or ~/.local/state (direct runs).
export function stateDir(env: Record<string, string | undefined>): string | null {
  const unit = env.STATE_DIRECTORY?.split(":")[0];
  if (absolute(unit)) return unit;
  if (absolute(env.XDG_STATE_HOME)) return join(env.XDG_STATE_HOME, "xiaomi-session-refresh");
  if (absolute(env.HOME)) return join(env.HOME, ".local", "state", "xiaomi-session-refresh");
  return null;
}
// Directory 0700, file 0600 written via a temporary file and rename. Unreadable, unsafe
// or corrupt state reads as empty.
export function fileStateStore(dir: string | null): StateStore {
  const file = dir === null ? null : join(dir, "state.json");
  return {
    load() {
      if (file === null) return { ...EMPTY_STATE };
      let fd = -1;
      try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const st = fstatSync(fd);
        if (!st.isFile() || st.size > STATE_MAX) return { ...EMPTY_STATE };
        const buf = Buffer.alloc(STATE_MAX + 1);
        let n = 0,
          got: number;
        while (n < buf.length && (got = readSync(fd, buf, n, buf.length - n, null)) > 0) n += got;
        if (n > STATE_MAX) return { ...EMPTY_STATE };
        const text = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, n));
        return parseState(text) ?? { ...EMPTY_STATE };
      } catch {
        return { ...EMPTY_STATE };
      } finally {
        if (fd >= 0) closeSync(fd);
      }
    },
    save(state) {
      if (dir === null || file === null) return false;
      const tmp = file + "." + process.pid + "." + Math.random().toString(36).slice(2, 10);
      let fd = -1;
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const st = lstatSync(dir);
        if (!st.isDirectory()) return false;
        if (st.mode & 0o077) chmodSync(dir, 0o700);
        fd = openSync(
          tmp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        writeSync(fd, JSON.stringify(state) + "\n");
        fsyncSync(fd);
        closeSync(fd);
        fd = -1;
        renameSync(tmp, file);
        return true;
      } catch {
        if (fd >= 0)
          try {
            closeSync(fd);
          } catch {}
        try {
          rmSync(tmp, { force: true });
        } catch {}
        return false;
      }
    },
  };
}

// Run lock: XDG_RUNTIME_DIR, else the state directory.
export function lockPath(
  env: Record<string, string | undefined>,
  dir: string | null,
): string | null {
  if (absolute(env.XDG_RUNTIME_DIR)) return join(env.XDG_RUNTIME_DIR, "xiaomi-session-refresh.lock");
  return dir === null ? null : join(dir, "run.lock");
}
const LOCK_EX = 2,
  LOCK_NB = 4,
  // Linux; Bun's fs.constants has no O_CLOEXEC. Children must not inherit the lock.
  O_CLOEXEC = 0o2000000;
const openLibc = () =>
  dlopen("libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
let libc: ReturnType<typeof openLibc> | null = null;
const heldLocks: number[] = [];
// Non-blocking flock(2) on a descriptor kept open for the life of the process: the
// kernel releases it on any exit, including SIGKILL. Any flock failure counts as busy.
export function takeRunLock(path: string | null): "held" | "busy" | "failed" {
  if (path === null) return "failed";
  let fd = -1;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    fd = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | O_CLOEXEC,
      0o600,
    );
    libc ??= openLibc();
    if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0) {
      heldLocks.push(fd);
      return "held";
    }
    closeSync(fd);
    return "busy";
  } catch {
    if (fd >= 0)
      try {
        closeSync(fd);
      } catch {}
    return "failed";
  }
}

// Desktop notice for a result, given the needs-a-person result last notified. Fixed text
// plus the configured manual command; never cookies, userIds or file contents.
export interface Notice {
  urgency: "critical" | "normal";
  title: string;
  body: string;
  // Delivered: the episode is over (recovery), else it records this kind.
  clears: boolean;
}
const markup = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export function notice(
  kind: Kind,
  notified: Kind | null,
  manualCommand: string | null,
): Notice | null {
  const rerun = manualCommand
    ? 'then run "' + manualCommand + '".'
    : "then run the refresher by hand.";
  if (kind === "renewed" || kind === "not_needed")
    return notified === null
      ? null
      : {
          urgency: "normal",
          title: "Xiaomi session renewal recovered",
          body: kind === "renewed" ? "The session was renewed." : "No renewal needed; the renewal browser is ready.",
          clears: true,
        };
  if (!NEEDS_PERSON.includes(kind) || kind === notified) return null;
  const [title, body] =
    kind === "signin_required"
      ? ["Xiaomi sign-in needed", "Sign in at " + CONSOLE_URL + " in the renewal browser, " + rerun]
      : kind === "account_mismatch"
        ? [
            "Xiaomi renewal refused: account mismatch",
            "The installed session is missing, unusable or of another Xiaomi account than the renewal browser. Sign the renewal browser into the bound account at " +
              CONSOLE_URL +
              ", " +
              rerun +
              " For a first install or a deliberate switch run the refresher once with --rebind.",
          ]
        : kind === "browser_unavailable"
          ? [
              "Xiaomi renewal browser unavailable",
              "Start the renewal browser (signed in at " + CONSOLE_URL + ") or fix XQ_BROWSER_LAUNCH, " + rerun,
            ]
          : [
              "Xiaomi renewal: cookies not accepted (vendor change?)",
              "The renewal browser is signed in, but its Xiaomi cookies were missing or rejected. Check the sign-in at " +
                CONSOLE_URL +
                ", " +
                rerun +
                " If it persists, the refresher needs an update.",
            ];
  return { urgency: "critical", title, body: markup(body), clears: false };
}

export interface Deps {
  ssh: SshRunner;
  connectBrowser: (origin: string, timeoutMs: number) => Promise<CdpClient>;
  // GET <origin>/json/version (loopback discovery only).
  probe: (origin: string, timeoutMs: number) => Promise<ProbeState>;
  fetch: Fetcher;
  now: () => Date;
  // Used only when XQ_BROWSER_LAUNCH is set.
  launcher?: Launcher;
  // Used only when XQ_NOTIFY=desktop.
  notify?: Notifier;
  state?: StateStore;
  // Aborted on SIGTERM/SIGINT: close the owned tab, write nothing more.
  signal?: AbortSignal;
}
export interface RunOutcome {
  code: 0 | 1 | 2 | 3;
  line: string;
}
const REMOTE_EXIT: Record<number, string> = {
  [TIMED_OUT]: "ssh timed out or could not start",
  [OVERSIZED]: "ssh output over 64 KiB",
  3: "remote session directory missing",
  4: "remote session directory not owned by ssh user",
  5: "remote session directory is group/world accessible",
  8: "installed session missing, unusable or of another account",
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
const statusResult = (k: Kind): RenewalResult => (k === "vendor_changed" ? "error" : k);
const UNUSABLE = "installed session file missing or unusable; reinstall with --rebind";
const RUNNING = "renewal browser running";
const NOT_ANSWERING = "renewal browser not answering";
const STARTABLE = "renewal browser not running but can be started";
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });
export async function runRefresh(
  cfg: Config,
  flags: Flags,
  deps: Deps,
  t: Timeouts = DEFAULT_TIMEOUTS,
): Promise<RunOutcome> {
  const run = runContext(t.runMs, deps.signal);
  const interrupted = (): RunOutcome => ({ code: 1, line: PREFIX + INTERRUPTED });
  if (deps.signal?.aborted) return interrupted();
  let status: CollectorStatus | null = null,
    cause = collectorCause(null);
  try {
    const r = await deps.ssh(
      sshArgv(cfg.sshTarget, statusCommand(cfg.container)),
      null,
      run.budget(t.statusSshMs),
      true,
    );
    if (r.code === 0) status = parseCollectorStatus(r.stdout);
    cause = collectorCause(r);
  } catch {
    status = null;
  }
  if (deps.signal?.aborted) return interrupted();
  if (!status) return { code: 1, line: PREFIX + "collector_unreachable (" + cause + ")" };
  const s = status;
  // The collector reports these as auth_required too; push can never replace them.
  const unusable = s.state === "missing" || s.state === "invalid_file";
  const needed = flags.force || s.error === "auth_required" || unusable;
  const context =
    (flags.force ? "forced; " : "") +
    (flags.rebind ? "rebind; " : "") +
    (s.error === null
      ? "collector ok"
      : "collector " + s.error + (s.rejectedAt && s.error === "auth_required" ? " since " + s.rejectedAt : ""));
  const launcher = cfg.browserLaunch !== null ? deps.launcher : undefined;
  // Discovery endpoint first, then the launcher's side-effect-free --check. Only a refused
  // port counts as stopped: a renewal never launches over a browser that is merely slow.
  async function readiness(): Promise<{ ok: boolean; text: string; detail?: string }> {
    const probe = await deps.probe(cfg.cdpOrigin, run.budget(t.connectMs));
    if (probe === "up") return { ok: true, text: RUNNING };
    if (probe === "unknown") return { ok: false, text: NOT_ANSWERING };
    if (!launcher) return { ok: false, text: "renewal browser not running; no launcher configured" };
    if (deps.signal?.aborted) return { ok: false, text: INTERRUPTED };
    const r = await launcher(true, run.budget(t.launcherMs), run.signal);
    return r === 0
      ? { ok: true, text: STARTABLE }
      : {
          ok: false,
          text: "renewal browser not running and cannot be started",
          detail: typeof r === "number" ? "launcher --check exit " + r : launcherText(r),
        };
  }
  if (flags.check) {
    const b = await readiness();
    if (deps.signal?.aborted) return interrupted();
    const verdict = !needed
      ? "not_needed"
      : unusable && !flags.rebind
        ? "account_mismatch"
        : "renewal needed";
    const parts = [context, b.text + (b.detail ? " (" + b.detail + ")" : "")];
    if (verdict === "account_mismatch") parts.unshift(UNUSABLE);
    return { code: 0, line: PREFIX + "check: " + verdict + " (" + parts.join("; ") + ")" };
  }
  const state = deps.state?.load() ?? { ...EMPTY_STATE };
  let attemptAt: Date | null = null;
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
      return TIMED_OUT;
    }
  }
  const why = (code: number) => REMOTE_EXIT[code] ?? "remote exit " + code;
  // After the status write: at most one notification, then the local state.
  async function settle(kind: Kind, out: RunOutcome, backedOff = false): Promise<RunOutcome> {
    if (deps.signal?.aborted) return interrupted();
    // A backed-off run is not an attempt: counts and attempt data stay as they were.
    const next: RunState = backedOff
      ? { ...state }
      : {
          ...state,
          last: kind,
          count: state.last === kind ? Math.min(state.count + 1, MAX_COUNT) : 1,
          ...(attemptAt
            ? {
                attemptAt: attemptAt.toISOString(),
                attemptRejectedAt: s.rejectedAt,
                attemptUpdatedAt: s.updatedAt,
              }
            : {}),
        };
    let line = out.line;
    const n =
      cfg.notify === "desktop" && deps.notify
        ? notice(kind, state.notified, cfg.manualCommand)
        : null;
    if (n) {
      let sent = false;
      try {
        sent = await deps.notify!(n.urgency, n.title, n.body, t.notifyMs);
      } catch {
        sent = false;
      }
      // Undelivered: the next run tries again.
      if (sent) next.notified = n.clears ? null : kind;
      else line += "; desktop notification failed";
    }
    if (deps.state && !deps.state.save(next)) line += "; state not saved";
    return { code: out.code, line };
  }
  // The one status write allowed after the deadline (bounded by writeSshMs).
  async function fail(
    kind: Exclude<Kind, "not_needed" | "renewed">,
    reason: string,
  ): Promise<RunOutcome> {
    if (deps.signal?.aborted) return interrupted();
    const result = statusResult(kind);
    // Best effort: the collector page shows this; the exit code still reports it.
    const code = await write(result, s.renewedAt, deps.now());
    return settle(kind, {
      code: exitCode(result),
      line:
        PREFIX + result + " (" + reason + "; " + context + ")" +
        (code === 0 ? "" : "; status write failed: " + why(code)),
    });
  }
  // Timer runs only, after a failure only a person can fix, unless the collector's
  // session changed since that attempt: min(60, 15 * 2^(n-1)) minutes after it.
  function backoffUntil(): number | null {
    if (!cfg.timerRun || flags.force) return null;
    if (state.last === null || !BACKS_OFF.includes(state.last)) return null;
    if (state.attemptAt === null || state.count < 1) return null;
    if (state.attemptRejectedAt !== s.rejectedAt || state.attemptUpdatedAt !== s.updatedAt)
      return null;
    const at = Date.parse(state.attemptAt),
      now = deps.now().getTime();
    const until = at + Math.min(60, 15 * 2 ** (state.count - 1)) * 60000;
    // A clock that went backwards never extends the wait.
    return now >= at && now < until ? until : null;
  }
  async function waitForEndpoint(windowMs: number): Promise<boolean> {
    const end = performance.now() + windowMs;
    while (!stopped(run)) {
      const left = end - performance.now();
      if (left <= 0) return false;
      if ((await deps.probe(cfg.cdpOrigin, Math.max(1, Math.min(t.connectMs, left)))) === "up")
        return true;
      const pause = Math.min(t.pollMs, end - performance.now());
      if (pause > 0) await sleep(pause, run.signal);
    }
    return false;
  }
  // Best effort within browserCloseMs: Browser.close on the run's browser-level
  // connection, or on one fresh connection if that one is gone or was never opened. After a
  // lost connection only the same browser process (same browser id) is closed: whatever
  // answers the port by then may be a browser someone else started.
  async function closeStarted(client: CdpClient | null, lost: boolean) {
    const end = performance.now() + t.browserCloseMs;
    const left = () => Math.max(1, end - performance.now());
    if (client && !lost) {
      await client.send("Browser.close", {}, undefined, left()).catch(() => undefined);
      return;
    }
    let fresh: CdpClient | null = null;
    try {
      fresh = await deps.connectBrowser(cfg.cdpOrigin, Math.min(t.connectMs, left()));
      if (client && fresh.browserId !== client.browserId) return;
      await fresh.send("Browser.close", {}, undefined, left());
    } catch {
      // Nothing more to do within the bound.
    } finally {
      fresh?.close();
    }
  }
  async function browserStep(): Promise<Outcome & { loaded?: boolean }> {
    let started = false,
      client: CdpClient | null = null,
      lost = false;
    try {
      // Without a launcher this is v0.3.0: connect directly. With one, launch only when
      // nothing listens: a busy browser would take the start request over and then be closed
      // as this run's own. Before a starting browser opens its port, the launcher must refuse
      // while the profile is in use (the example does).
      if (launcher && (await deps.probe(cfg.cdpOrigin, run.budget(t.connectMs))) === "refused") {
        let stop = stopped(run);
        if (stop) return { result: "error", reason: stop };
        const r = await launcher(false, run.budget(t.launcherMs), run.signal);
        started = r === 0;
        stop = stopped(run);
        if (stop) return { result: "error", reason: stop };
        if (!started)
          return {
            result: "browser_unavailable",
            reason: "renewal browser could not be started (" + launcherText(r) + ")",
          };
        const windowMs = run.budget(t.launchMs);
        const up = await waitForEndpoint(windowMs);
        stop = stopped(run);
        if (stop) return { result: "error", reason: stop };
        if (!up)
          return {
            result: "browser_unavailable",
            reason:
              "renewal browser did not come up within " +
              Math.max(1, Math.round(windowMs / 1000)) +
              " s",
          };
      }
      try {
        client = await deps.connectBrowser(cfg.cdpOrigin, run.budget(t.connectMs));
      } catch {
        const stop = stopped(run);
        return stop
          ? { result: "error", reason: stop }
          : { result: "browser_unavailable", reason: "DevTools endpoint unreachable" };
      }
      void client.closed.then(() => (lost = true));
      return await readBrowserSession(client, t, run);
    } finally {
      // After the owned tab is closed; a browser that was already running is never closed.
      if (started) await closeStarted(client, lost);
      client?.close();
    }
  }
  try {
    if (!needed) {
      // Early warning: no tab, cookie or Xiaomi request; loopback discovery only.
      const b = await readiness();
      if (deps.signal?.aborted) return interrupted();
      if (!b.ok) return await fail("browser_unavailable", b.text);
      const note = b.text === STARTABLE ? "; " + STARTABLE : "";
      const code = await write("not_needed", s.renewedAt, deps.now());
      // A heartbeat that cannot be recorded is surfaced as a unit failure.
      return await settle(
        "not_needed",
        code === 0
          ? { code: 0, line: PREFIX + "not_needed (" + context + note + ")" }
          : {
              code: 1,
              line: PREFIX + "not_needed (" + context + note + "); status write failed: " + why(code),
            },
      );
    }
    if (unusable && !flags.rebind) return await fail("account_mismatch", UNUSABLE);
    const until = backoffUntil();
    if (until !== null) {
      if (deps.signal?.aborted) return interrupted();
      const kind = state.last!,
        result = statusResult(kind),
        n = state.count;
      const code = await write(result, s.renewedAt, deps.now());
      return await settle(
        kind,
        {
          code: exitCode(result),
          line:
            PREFIX + result + " (" +
            (kind === "vendor_changed" ? "vendor change suspected; " : "") +
            "backing off until " + new Date(until).toISOString().slice(11, 16) + "Z after " +
            n + (n === 1 ? " attempt; " : " attempts; ") +
            (cfg.manualCommand ? 'run "' + cfg.manualCommand + '"' : "run the refresher by hand") +
            " to retry now; " + context + ")" +
            (code === 0 ? "" : "; status write failed: " + why(code)),
        },
        true,
      );
    }
    if (run.expired()) return await fail("error", DEADLINE);
    attemptAt = deps.now();
    const outcome = await browserStep();
    if ("result" in outcome) {
      if (outcome.loaded && outcome.result === "signin_required" && outcome.reason === COOKIE_MISSING)
        return await fail(
          "vendor_changed",
          "browser is signed in but the expected Xiaomi cookies are missing (vendor change?)",
        );
      return await fail(outcome.result, outcome.reason);
    }
    const pre = stopped(run);
    if (pre) return await fail("error", pre);
    const valid = await validateSession(outcome.header, deps.fetch, run.budget(t.vendorMs), run.signal);
    const stop = stopped(run);
    if (stop) return await fail("error", stop);
    if (valid === "signin_required")
      return await (outcome.loaded
        ? fail("vendor_changed", "browser session works but the copied cookies were rejected (vendor change?)")
        : fail("signin_required", "Xiaomi rejected the browser session"));
    if (valid === "vendor_unavailable")
      return await fail("vendor_unavailable", "Xiaomi validation failed");
    const now = deps.now();
    const code = await write("renewed", now.toISOString(), now, outcome.header, run.budget(t.writeSshMs));
    if (code === 8)
      return await fail("account_mismatch", "installed session missing, unusable or of another account");
    if (code !== 0) return await fail("error", "session push failed: " + why(code));
    return await settle("renewed", { code: 0, line: PREFIX + "renewed (" + context + ")" });
  } catch {
    return fail("error", "unexpected failure");
  }
}
