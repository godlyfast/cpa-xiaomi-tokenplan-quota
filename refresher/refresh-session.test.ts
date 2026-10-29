import { expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import * as lib from "./lib";

// Obviously synthetic session values; every test asserts they never reach argv or output.
const SECRETS = {
  "api-platform_serviceToken": "SYNTHETIC-svc-token-aaaa",
  "api-platform_slh": "SYNTHETIC-slh-bbbb",
  "api-platform_ph": "SYNTHETIC-ph-cccc",
  userId: "SYNTHETIC-uid-0000",
};
const PASS_TOKEN = "SYNTHETIC-passtoken-never-copied";
const HEADER =
  "api-platform_serviceToken=SYNTHETIC-svc-token-aaaa; api-platform_slh=SYNTHETIC-slh-bbbb; " +
  "api-platform_ph=SYNTHETIC-ph-cccc; userId=SYNTHETIC-uid-0000";
const ENV = {
  XQ_SSH_TARGET: "user@collector.example",
  XQ_REMOTE_DIR: "/srv/xiaomi-quota/session",
  XQ_COLLECTOR_CONTAINER: "xiaomi-quota",
  XQ_MANUAL_COMMAND: "systemctl --user start xiaomi-session-refresh.service",
};
const cfg = lib.parseConfig(ENV, "laptop");
const NOW = new Date("2030-01-02T03:04:05.678Z");
const REJECTED = "2030-01-02T01:00:00.000Z";
const PREVIOUS = "2030-01-01T01:00:00.000Z";
const T: lib.Timeouts = {
  statusSshMs: 1000,
  writeSshMs: 1000,
  connectMs: 1000,
  commandMs: 1000,
  navigationMs: 200,
  signinGraceMs: 50,
  pollMs: 5,
  vendorMs: 1000,
  launcherMs: 1000,
  launchMs: 300,
  runMs: 5000,
  closeMs: 500,
  browserCloseMs: 500,
  notifyMs: 1000,
};
const CONSOLE_DOC = "https://platform.xiaomimimo.com/";

function expectNoLeak(...texts: (string | null | undefined)[]) {
  for (const text of texts)
    for (const secret of [...Object.values(SECRETS), PASS_TOKEN])
      expect(text ?? "").not.toContain(secret);
}
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
const utc = (v: unknown) =>
  typeof v === "string" &&
  UTC.test(v) &&
  new Date(v).toISOString().slice(0, 19) === v.slice(0, 19);
// Independent strict validator for contract B.
function expectContractB(json: string) {
  expect(Buffer.byteLength(json)).toBeLessThanOrEqual(4096);
  expect(json).not.toContain("\n");
  const v = JSON.parse(json);
  expect(Object.keys(v).sort()).toEqual(
    ["checkedAt", "host", "manualCommand", "renewedAt", "result", "schemaVersion"].sort(),
  );
  expect(v.schemaVersion).toBe(1);
  expect(utc(v.checkedAt)).toBe(true);
  expect([
    "not_needed",
    "renewed",
    "signin_required",
    "browser_unavailable",
    "vendor_unavailable",
    "account_mismatch",
    "error",
  ]).toContain(v.result);
  expect(v.renewedAt === null || utc(v.renewedAt)).toBe(true);
  expect(v.host).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  expect(
    v.manualCommand === null ||
      (typeof v.manualCommand === "string" && /^[\x20-\x7e]{1,160}$/.test(v.manualCommand)),
  ).toBe(true);
  return v as {
    checkedAt: string;
    result: string;
    renewedAt: string | null;
    host: string;
    manualCommand: string | null;
  };
}

const UPDATED = "2030-01-01T00:00:00.000Z";
const collector = (error: string | null, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    error,
    stale: error !== null,
    fetchedAt: "2030-01-02T00:55:00.000Z",
    session: {
      state: error === "auth_required" ? "expired" : "ok",
      updatedAt: UPDATED,
      rejectedAt: error === "auth_required" ? REJECTED : null,
      lastAttemptAt: "2030-01-02T01:00:00.000Z",
      nextAttemptAt: "2030-01-02T01:05:00.000Z",
    },
    renewal: {
      checkedAt: PREVIOUS,
      result: "renewed",
      renewedAt: PREVIOUS,
      host: "laptop",
      manualCommand: null,
    },
    ...extra,
  });
// Collector status with some session fields replaced.
const withSession = (error: string | null, session: Record<string, unknown>) => {
  const v = JSON.parse(collector(error));
  return JSON.stringify({ ...v, session: { ...v.session, ...session } });
};
// In-memory state store that records every save.
function memState(initial: Partial<lib.RunState> = {}) {
  let current: lib.RunState = { ...lib.EMPTY_STATE, ...initial };
  const saves: lib.RunState[] = [];
  return {
    store: {
      load: () => ({ ...current }),
      save: (next: lib.RunState) => {
        current = { ...next };
        saves.push({ ...next });
        return true;
      },
    } satisfies lib.StateStore,
    get: () => current,
    saves,
  };
}
interface SshCall {
  argv: string[];
  stdin: string | null;
  kind: "read" | "push" | "rebind" | "status";
  timeoutMs: number;
}
const kindOf = (command: string): SshCall["kind"] =>
  command.startsWith("'sudo'")
    ? "read"
    : command.endsWith("'push'")
      ? "push"
      : command.endsWith("'rebind'")
        ? "rebind"
        : "status";
function fakeSsh(
  o: {
    stdout?: string;
    read?: number;
    stderr?: string;
    write?: number;
    push?: number;
    throws?: boolean;
  } = {},
) {
  const calls: SshCall[] = [];
  const run: lib.SshRunner = async (argv, stdin, timeoutMs, keepStderr) => {
    const kind = kindOf(argv[argv.length - 1]);
    calls.push({ argv: [...argv], stdin, kind, timeoutMs });
    if (o.throws) throw new Error("synthetic spawn failure");
    // Only the status read asks for stderr.
    expect(keepStderr === true).toBe(kind === "read");
    if (kind === "read")
      return {
        code: o.read ?? 0,
        stdout: o.stdout ?? collector("auth_required"),
        ...(o.stderr === undefined ? {} : { stderr: o.stderr }),
      };
    return { code: (kind === "status" ? o.write : o.push) ?? 0, stdout: "" };
  };
  return { run, calls };
}
// Status read is faked; writes run the real WRITE_SH locally against a temp directory.
function writerSsh(stdout = collector("auth_required")) {
  const calls: SshCall[] = [];
  const local = lib.spawnRunner({ env: { PATH: process.env.PATH, HOME: tmpdir() } });
  const run: lib.SshRunner = async (argv, stdin, timeoutMs) => {
    const kind = kindOf(argv[argv.length - 1]);
    calls.push({ argv: [...argv], stdin, kind, timeoutMs });
    if (kind === "read") return { code: 0, stdout };
    return local(["sh", "-c", argv[argv.length - 1]], stdin, 5000);
  };
  return { run, calls };
}

type Emit = (e: lib.CdpEvent) => void;
const nav = (
  url: string,
  frameId = "T-OWNED",
  sessionId = "S-OWNED",
  parentId?: string,
): lib.CdpEvent => ({
  method: "Page.frameNavigated",
  sessionId,
  params: { frame: { id: frameId, ...(parentId ? { parentId } : {}), loaderId: "L-1", url }, type: "Navigation" },
});
// Legacy Network-domain readiness signal; the refresher must ignore it.
const usageEvent = (sessionId = "S-OWNED"): lib.CdpEvent => ({
  method: "Network.responseReceived",
  sessionId,
  params: { type: "XHR", frameId: "T-OWNED", response: { url: lib.USAGE_URL, status: 200 } },
});
const loads = (emit: Emit, cdp: FakeCdp) => {
  emit(nav(CONSOLE_DOC));
  cdp.ready = true;
};
const jar = (over: Record<string, unknown>[] = []) => [
  { name: "passToken", value: PASS_TOKEN, domain: ".account.xiaomi.com", path: "/" },
  { name: "userId", value: "SYNTHETIC-foreign", domain: "xiaomimimo.com.evil.example", path: "/" },
  { name: "userId", value: "SYNTHETIC-lookalike", domain: ".evilxiaomimimo.com", path: "/" },
  { name: "userId", value: SECRETS.userId, domain: ".xiaomimimo.com", path: "/" },
  { name: "api-platform_ph", value: SECRETS["api-platform_ph"], domain: "platform.xiaomimimo.com", path: "/" },
  { name: "api-platform_slh", value: SECRETS["api-platform_slh"], domain: ".platform.xiaomimimo.com", path: "/" },
  { name: "api-platform_serviceToken", value: SECRETS["api-platform_serviceToken"], domain: "xiaomimimo.com", path: "/" },
  ...over,
];
interface Script {
  onNavigate?: (emit: Emit, cdp: FakeCdp) => void;
  navigate?: Record<string, unknown>;
  cookies?: unknown;
  failOn?: string;
  // Simulates an unanswered command: rejects like the real client once its timeout passes.
  hang?: string;
  evaluate?: Record<string, unknown>;
  evaluateErrors?: number;
  // Answers this command late (after ms), like a slow browser.
  delay?: { method: string; ms: number };
  onCookies?: () => void;
  // The browser process's DevTools id; another id is another browser.
  browserId?: string;
}
class FakeCdp implements lib.CdpClient {
  sent: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  timing: { method: string; ms?: number; at: number }[] = [];
  socketClosed = false;
  ready = false;
  private listeners = new Set<(e: lib.CdpEvent) => void>();
  private markClosed!: () => void;
  readonly closed = new Promise<void>((resolve) => (this.markClosed = resolve));
  readonly browserId: string;
  constructor(private script: Script = {}) {
    this.browserId = script.browserId ?? "B-SYNTHETIC";
  }
  emit: Emit = (e) => {
    for (const listener of [...this.listeners]) listener(e);
  };
  drop() {
    this.markClosed();
  }
  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string, ms?: number) {
    this.sent.push({ method, params, sessionId });
    this.timing.push({ method, ms, at: Date.now() });
    if (this.script.failOn === method) throw new Error("synthetic cdp failure");
    if (this.script.hang === method) {
      await Bun.sleep(ms ?? 60000);
      throw new lib.CdpError();
    }
    if (this.script.delay?.method === method) await Bun.sleep(this.script.delay.ms);
    switch (method) {
      case "Target.createTarget":
        return { targetId: "T-OWNED" };
      case "Target.attachToTarget":
        return { sessionId: "S-OWNED" };
      case "Page.enable":
      case "Target.closeTarget":
      case "Browser.close":
        return {};
      case "Page.navigate":
        setTimeout(() => (this.script.onNavigate ?? loads)(this.emit, this), 1);
        return this.script.navigate ?? { frameId: "T-OWNED", loaderId: "L-1" };
      case "Runtime.evaluate":
        if ((this.script.evaluateErrors ?? 0) > 0) {
          this.script.evaluateErrors!--;
          throw new lib.CdpError();
        }
        return this.script.evaluate ?? { result: { type: "boolean", value: this.ready } };
      case "Network.getCookies":
        this.script.onCookies?.();
        return { cookies: this.script.cookies ?? jar() };
    }
    throw new Error("unexpected method");
  }
  onEvent(listener: (e: lib.CdpEvent) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  close() {
    this.socketClosed = true;
  }
}
// The run may only touch the target it created, and must always close it. Browser.close
// only for a browser this run started, once, after the owned target is closed.
function expectOwnedOnly(cdp: FakeCdp, started = false) {
  // No Network.enable: the network event stream would carry account-host cookie headers.
  const allowed = [
    "Target.createTarget",
    "Target.attachToTarget",
    "Page.enable",
    "Page.navigate",
    "Runtime.evaluate",
    "Network.getCookies",
    "Target.closeTarget",
    ...(started ? ["Browser.close"] : []),
  ];
  expect(cdp.sent[0]).toEqual({
    method: "Target.createTarget",
    params: { url: "about:blank", background: true },
    sessionId: undefined,
  });
  for (const s of cdp.sent) {
    expect(allowed).toContain(s.method);
    if ("targetId" in s.params) expect(s.params.targetId).toBe("T-OWNED");
    if (s.method.startsWith("Target.") || s.method === "Browser.close") expect(s.sessionId).toBeUndefined();
    else expect(s.sessionId).toBe("S-OWNED");
    if (s.method === "Page.navigate") expect(s.params).toEqual({ url: lib.CONSOLE_URL });
    if (s.method === "Network.getCookies") expect(s.params).toEqual({ urls: [lib.USAGE_URL] });
    if (s.method === "Runtime.evaluate")
      expect(s.params).toEqual({ expression: lib.READY_JS, returnByValue: true });
  }
  expect(cdp.sent.filter((s) => s.method === "Target.closeTarget")).toEqual([
    { method: "Target.closeTarget", params: { targetId: "T-OWNED" }, sessionId: undefined },
  ]);
  expect(cdp.sent.filter((s) => s.method === "Browser.close").length).toBe(started ? 1 : 0);
  expect(cdp.sent.at(started ? -2 : -1)?.method).toBe("Target.closeTarget");
  if (started) expect(cdp.sent.at(-1)).toEqual({ method: "Browser.close", params: {}, sessionId: undefined });
  expect(cdp.socketClosed).toBe(true);
}
type Responder = () => Response | Promise<Response>;
function fakeFetch(r: { usage?: Responder; detail?: Responder } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url === "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage")
      return (r.usage ?? (() => Response.json({ code: 0, data: {} })))();
    if (url === "https://platform.xiaomimimo.com/api/v1/tokenPlan/detail")
      return (r.detail ?? (() => Response.json({ code: 0, data: {} })))();
    throw new Error("unexpected destination");
  };
  return { f, calls };
}
async function run(
  o: {
    flags?: Partial<lib.Flags>;
    ssh?: ReturnType<typeof fakeSsh>;
    cdp?: FakeCdp | "down";
    fetch?: ReturnType<typeof fakeFetch>;
    cfg?: lib.Config;
    t?: lib.Timeouts;
    signal?: AbortSignal;
    // Discovery endpoint; defaults to "up unless cdp is down" (then refused).
    probe?: (origin: string, ms: number) => Promise<lib.ProbeState>;
    // Returned by every connect after the first (default: cdp again).
    reconnect?: FakeCdp;
    launcher?: lib.Launcher;
    notify?: lib.Notifier;
    state?: lib.StateStore;
    now?: () => Date;
  } = {},
) {
  const ssh = o.ssh ?? fakeSsh();
  const cdp = o.cdp ?? new FakeCdp();
  const fetcher = o.fetch ?? fakeFetch();
  const t = o.t ?? T;
  let connects = 0,
    probes = 0;
  const out = await lib.runRefresh(
    o.cfg ?? cfg,
    { force: false, check: false, rebind: false, ...o.flags },
    {
      ssh: ssh.run,
      connectBrowser: async (origin, ms) => {
        connects++;
        expect(origin).toBe("http://127.0.0.1:9223");
        expect(ms).toBeGreaterThan(0);
        expect(ms).toBeLessThanOrEqual(t.connectMs);
        if (cdp === "down") throw new lib.BrowserUnavailable();
        return connects > 1 && o.reconnect ? o.reconnect : cdp;
      },
      probe: async (origin, ms) => {
        probes++;
        expect(origin).toBe("http://127.0.0.1:9223");
        expect(ms).toBeGreaterThan(0);
        expect(ms).toBeLessThanOrEqual(t.connectMs);
        return o.probe ? o.probe(origin, ms) : cdp !== "down" ? "up" : "refused";
      },
      fetch: fetcher.f,
      now: o.now ?? (() => NOW),
      ...(o.launcher ? { launcher: o.launcher } : {}),
      ...(o.notify ? { notify: o.notify } : {}),
      ...(o.state ? { state: o.state } : {}),
      signal: o.signal,
    },
    t,
  );
  expectNoLeak(out.line, ...ssh.calls.flatMap((c) => c.argv));
  for (const call of ssh.calls) {
    expect(call.argv.slice(0, 12)).toEqual([
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
    ]);
    if (call.kind === "read" || call.kind === "status") expectNoLeak(call.stdin);
  }
  const statusWrites = ssh.calls.filter((c) => c.kind !== "read");
  const written = statusWrites.map((c) => {
    const lines = c.stdin!.split("\n");
    expect(lines.at(-1)).toBe("");
    return expectContractB(lines.at(-2)!);
  });
  return { out, ssh, cdp, fetcher, connects, probes, written };
}

test("config: defaults, loopback CDP forms and hostname-derived label", () => {
  expect(cfg).toEqual({
    cdpOrigin: "http://127.0.0.1:9223",
    sshTarget: "user@collector.example",
    remoteDir: "/srv/xiaomi-quota/session",
    container: "xiaomi-quota",
    hostLabel: "laptop",
    manualCommand: "systemctl --user start xiaomi-session-refresh.service",
    browserLaunch: null,
    notify: "none",
    timerRun: false,
  });
  for (const [url, origin] of [
    ["http://localhost:9333", "http://localhost:9333"],
    ["http://[::1]:9222/", "http://[::1]:9222"],
    ["http://127.0.0.1", "http://127.0.0.1"],
  ])
    expect(lib.parseConfig({ ...ENV, XQ_CDP_URL: url }, "h").cdpOrigin).toBe(origin);
  const derived = lib.parseConfig(
    { ...ENV, XQ_MANUAL_COMMAND: "" },
    "--Tim's laptop.local" + "x".repeat(80),
  );
  expect(derived.hostLabel).toBe("Tim-s-laptop.local" + "x".repeat(46));
  expect(derived.manualCommand).toBeNull();
  expect(lib.parseConfig({ ...ENV, XQ_HOST_LABEL: "ws-150" }, "ignored").hostLabel).toBe("ws-150");
  expect(() => lib.parseConfig(ENV, "!!!")).toThrow(/set XQ_HOST_LABEL/);
  for (const label of ["-x", "a b", "x".repeat(65), "é"])
    expect(() => lib.parseConfig({ ...ENV, XQ_HOST_LABEL: label }, "h")).toThrow(lib.ConfigError);
});
test("config: rejects non-loopback CDP and injection attempts without echoing them", () => {
  const bad: Record<string, string[]> = {
    XQ_CDP_URL: [
      "http://192.0.2.10:9223",
      "http://127.0.0.1.evil.example:9223",
      "http://localhost.:9223",
      "https://127.0.0.1:9223",
      "ws://127.0.0.1:9223",
      "http://user:pw@127.0.0.1:9223",
      "http://127.0.0.1:9223/json",
      "http://127.0.0.1:9223/?x=1",
      "not a url",
    ],
    XQ_SSH_TARGET: [
      "",
      "collector.example",
      "-oProxyCommand=sh@x",
      "user@-oProxyCommand",
      "user@host;id",
      "user@host id",
      "$(id)@host",
      "user@host\nid",
      "@host",
      "user@",
    ],
    XQ_REMOTE_DIR: [
      "",
      "relative/dir",
      "/srv/../etc",
      "/srv/x/..",
      "/srv/x;id",
      "/srv/$(id)",
      "/srv/x'y",
      "/srv/a b",
      "/srv/x\n",
      "~/session",
      "/srv/x/",
      "/srv/x/.",
      "/srv/./x",
      "/srv//x",
      "/",
      "//",
    ],
    XQ_COLLECTOR_CONTAINER: ["", "-x", ".x", "x;id", "x y", "$(id)", "x'y", "x".repeat(129)],
    XQ_MANUAL_COMMAND: ["tab\there", "café", "x".repeat(161), "line\nbreak"],
    XQ_BROWSER_LAUNCH: ["relative/launch.sh", "~/launch.sh", "/x/launch\nid", "/x/la\x7funch", "/" + "x".repeat(4100)],
    XQ_NOTIFY: ["yes", "Desktop", "desktop,none", "notify-send"],
  };
  for (const [key, values] of Object.entries(bad))
    for (const value of values) {
      let message = "";
      try {
        lib.parseConfig({ ...ENV, [key]: value }, "laptop");
      } catch (error) {
        expect(error).toBeInstanceOf(lib.ConfigError);
        message = (error as Error).message;
      }
      expect(message).toContain(key);
      if (value.length > 5) expect(message).not.toContain(value);
    }
  for (const missing of ["XQ_SSH_TARGET", "XQ_REMOTE_DIR", "XQ_COLLECTOR_CONTAINER"])
    expect(() => lib.parseConfig({ ...ENV, [missing]: undefined }, "h")).toThrow(missing);
  expect(lib.parseConfig({ ...ENV, XQ_REMOTE_DIR: "/a/.hidden/b..c" }, "h").remoteDir).toBe(
    "/a/.hidden/b..c",
  );
});
test("flags: --check, --force and --rebind only", () => {
  expect(lib.parseArgs([])).toEqual({ force: false, check: false, rebind: false });
  expect(lib.parseArgs(["--check", "--force"])).toEqual({ force: true, check: true, rebind: false });
  expect(lib.parseArgs(["--rebind"])).toEqual({ force: false, check: false, rebind: true });
  for (const arg of ["--help", "-f", "force", "--check=1", "--rebind=1", "--re-bind"])
    expect(() => lib.parseArgs([arg])).toThrow(/usage: refresh-session.ts \[--check\] \[--force\] \[--rebind\]/);
});

async function sh(command: string, stdin: string | null = null, path = process.env.PATH!) {
  return lib.spawnRunner({ env: { PATH: path, HOME: tmpdir() } })(["sh", "-c", command], stdin, 5000);
}
test("remote commands: single-quoted words survive a POSIX login shell exactly", async () => {
  for (const s of ["a'b", "'", "$(id)", "`id`", 'a"b\\c', "; rm -rf /", "x\ny", "!$*"]) {
    const r = await sh("printf '%s\\0' " + lib.shellQuote(s));
    expect(r).toEqual({ code: 0, stdout: s + "\0" });
  }
  const dir = await mkdtemp(join(tmpdir(), "xq-sudo-"));
  try {
    await writeFile(join(dir, "sudo"), "#!/bin/sh\nprintf '%s\\0' \"$@\"\n", { mode: 0o700 });
    const r = await sh(lib.statusCommand("xiaomi-quota"), null, dir + ":" + process.env.PATH);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\0").slice(0, -1)).toEqual([
      "-n",
      "docker",
      "exec",
      "xiaomi-quota",
      "bun",
      "-e",
      lib.STATUS_JS,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  for (const name of ["x;id", "-x", "$(id)", "a b"])
    expect(() => lib.statusCommand(name)).toThrow(lib.ConfigError);
  for (const dir of ["/a/../b", "/x;id", "rel", "/a/b/", "/a/./b", "/a//b", "/a/.", "/"])
    for (const mode of ["push", "rebind", "status"] as const)
      expect(() => lib.writeCommand(dir, mode)).toThrow(lib.ConfigError);
  expect(() => lib.sshArgv("-oProxyCommand=x@h", "true")).toThrow(lib.ConfigError);
  expect(lib.sshArgv("user@collector.example", "true").slice(-3)).toEqual([
    "--",
    "user@collector.example",
    "true",
  ]);
});

async function sessionDir(fn: (dir: string, root: string) => Promise<void>, mode = 0o700) {
  const root = await mkdtemp(join(tmpdir(), "xq-remote-"));
  const dir = join(root, "session");
  await mkdir(dir, { mode });
  await chmod(dir, mode);
  try {
    await fn(dir, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const remote = (dir: string, mode: "push" | "rebind" | "status", stdin: string) =>
  sh(lib.writeCommand(dir, mode), stdin);
// Bypasses writeCommand's validation to exercise the writer's own path checks.
const rawRemote = (dir: string, stdin: string) =>
  sh(["bash", "-c", lib.WRITE_SH, "xiaomi-session-write", dir, "status"].map(lib.shellQuote).join(" "), stdin);
const modeOf = async (p: string) => (await lstat(p)).mode & 0o777;
test("remote writer: atomic owner-only replace with stdin framing and no leftovers", async () => {
  await sessionDir(async (dir) => {
    const status = '{"schemaVersion":1}';
    // First install: no session to compare with, so only rebind installs.
    expect(await remote(dir, "push", HEADER + "\n" + status + "\n")).toEqual({ code: 8, stdout: "" });
    expect(await readdir(dir)).toEqual([]);
    expect(await remote(dir, "rebind", HEADER + "\n" + status + "\n")).toEqual({ code: 0, stdout: "" });
    expect(await readFile(join(dir, "mimo_session"), "utf8")).toBe(HEADER + "\n");
    expect(await readFile(join(dir, "renewal-status.json"), "utf8")).toBe(status + "\n");
    expect(await modeOf(join(dir, "mimo_session"))).toBe(0o600);
    expect(await modeOf(join(dir, "renewal-status.json"))).toBe(0o600);
    const before = (await lstat(join(dir, "mimo_session"))).ino;
    const next = "next=SYNTHETIC-2; userId=" + SECRETS.userId;
    expect((await remote(dir, "push", next + "\n" + status + "\n")).code).toBe(0);
    expect((await lstat(join(dir, "mimo_session"))).ino).not.toBe(before);
    expect(await readFile(join(dir, "mimo_session"), "utf8")).toBe(next + "\n");
    // Status-only mode leaves the session untouched and treats all stdin as status.
    expect((await remote(dir, "status", '{"heartbeat":1}\n')).code).toBe(0);
    expect(await readFile(join(dir, "mimo_session"), "utf8")).toBe(next + "\n");
    expect(await readFile(join(dir, "renewal-status.json"), "utf8")).toBe('{"heartbeat":1}\n');
    expect((await readdir(dir)).sort()).toEqual(["mimo_session", "renewal-status.json"]);
    // Rejected input keeps both previous files and cleans its temp files.
    expect((await remote(dir, "status", "x".repeat(5000))).code).toBe(7);
    expect((await remote(dir, "status", "")).code).toBe(7);
    expect((await remote(dir, "push", "\n{}\n")).code).toBe(6);
    expect((await remote(dir, "push", "")).code).toBe(6);
    expect(await readFile(join(dir, "renewal-status.json"), "utf8")).toBe('{"heartbeat":1}\n');
    expect((await readdir(dir)).sort()).toEqual(["mimo_session", "renewal-status.json"]);
  });
});
test("remote writer: refuses missing, symlinked or group/world-accessible directories", async () => {
  await sessionDir(async (dir, root) => {
    expect((await remote(join(root, "missing"), "status", "{}\n")).code).toBe(3);
    await symlink(dir, join(root, "link"));
    expect((await remote(join(root, "link"), "status", "{}\n")).code).toBe(3);
    // test -L follows a trailing '/' or '/.'; such spellings are refused outright.
    for (const spelling of ["link/", "link/.", "link//", "session/", "session/.", "./session"])
      expect((await rawRemote(root + "/" + spelling, "{}\n")).code).toBe(3);
    expect((await rawRemote("session", "{}\n")).code).toBe(3);
    expect(await readdir(dir)).toEqual([]);
  });
  for (const mode of [0o750, 0o705, 0o770])
    await sessionDir(async (dir) => {
      expect((await remote(dir, "push", HEADER + "\n{}\n")).code).toBe(5);
      expect(await readdir(dir)).toEqual([]);
    }, mode);
  await sessionDir(async (dir) => {
    // A directory squatting on the target name is never written into.
    await mkdir(join(dir, "mimo_session"));
    expect((await remote(dir, "push", HEADER + "\n{}\n")).code).not.toBe(0);
    expect(await readdir(dir)).toEqual(["mimo_session"]);
    expect(await readdir(join(dir, "mimo_session"))).toEqual([]);
  });
});
test("spawn runner: cookie travels only on stdin; env is minimal; timeout kills", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xq-ssh-"));
  try {
    const bin = join(dir, "fake-ssh");
    await writeFile(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "$0" "$@" > "${dir}/argv"\nenv > "${dir}/env"\ncat > "${dir}/stdin"\necho synthetic-out\nexit 7\n`,
      { mode: 0o700 },
    );
    const runner = lib.spawnRunner({
      binary: bin,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        SSH_AUTH_SOCK: "/synthetic/agent.sock",
        XQ_SSH_TARGET: "user@collector.example",
        UNRELATED_SECRET: "SYNTHETIC-do-not-pass",
      },
    });
    const argv = lib.sshArgv(cfg.sshTarget, lib.writeCommand(cfg.remoteDir, "push"));
    const stdin = HEADER + "\n{}\n";
    expect(await runner(argv, stdin, 5000)).toEqual({ code: 7, stdout: "synthetic-out\n" });
    const seenArgv = await readFile(join(dir, "argv"), "utf8");
    const seenEnv = await readFile(join(dir, "env"), "utf8");
    expect(seenArgv).toContain("BatchMode=yes");
    expect(seenArgv).toContain(lib.WRITE_SH.split("\n")[0]);
    expectNoLeak(seenArgv, seenEnv);
    expect(seenEnv).toContain("SSH_AUTH_SOCK=/synthetic/agent.sock");
    expect(seenEnv).not.toContain("SYNTHETIC-do-not-pass");
    expect(seenEnv).not.toContain("XQ_");
    expect(await readFile(join(dir, "stdin"), "utf8")).toBe(stdin);
    const hang = join(dir, "hang");
    await writeFile(hang, "#!/bin/sh\nexec sleep 10\n", { mode: 0o700 });
    const started = Date.now();
    const r = await lib.spawnRunner({ binary: hang })(["ssh"], null, 100);
    expect(r.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("status script: emits only decision fields from v0.3 and v0.2 collectors", async () => {
  let body: unknown = null,
    status = 200;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json(body, { status }),
  });
  try {
    const js = lib.STATUS_JS.replace("http://127.0.0.1:8787", "http://127.0.0.1:" + server.port);
    expect(js).not.toBe(lib.STATUS_JS);
    const exec = async () => {
      const p = Bun.spawn([process.execPath, "-e", js], { stdout: "pipe", stderr: "pipe" });
      return { code: await p.exited, stdout: await new Response(p.stdout).text() };
    };
    const base = {
      schemaVersion: 1,
      region: "sgp",
      accountLabel: "Synthetic",
      planName: null,
      pools: [{ id: "plan" }],
      fetchedAt: null,
      expiresAt: null,
      expired: null,
      resetsAt: null,
      stale: true,
      error: "auth_required",
    };
    body = JSON.parse(collector("auth_required", base));
    let r = await exec();
    expect(r.code).toBe(0);
    const v3 = JSON.parse(r.stdout);
    expect(Object.keys(v3)).toEqual(["error", "stale", "fetchedAt", "session", "renewal"]);
    expect(lib.parseCollectorStatus(r.stdout)).toEqual({
      error: "auth_required",
      rejectedAt: REJECTED,
      renewedAt: PREVIOUS,
      state: "expired",
      updatedAt: UPDATED,
    });
    body = base;
    r = await exec();
    expect(JSON.parse(r.stdout)).toEqual({
      error: "auth_required",
      stale: true,
      fetchedAt: null,
      session: null,
      renewal: null,
    });
    status = 503;
    expect((await exec()).code).toBe(3);
  } finally {
    await server.stop(true);
  }
});
test("collector status parsing fails closed on shape, tolerates absent v0.3 keys", () => {
  expect(lib.parseCollectorStatus(collector(null))).toEqual({
    error: null,
    rejectedAt: null,
    renewedAt: PREVIOUS,
    state: "ok",
    updatedAt: UPDATED,
  });
  expect(
    lib.parseCollectorStatus('{"error":"unavailable","stale":true,"fetchedAt":null}\n'),
  ).toEqual({ error: "unavailable", rejectedAt: null, renewedAt: null, state: null, updatedAt: null });
  expect(
    lib.parseCollectorStatus(
      collector("auth_required", {
        session: { rejectedAt: "2030-02-30T00:00:00Z", state: "gone", updatedAt: 7 },
        renewal: { renewedAt: "yesterday" },
      }),
    ),
  ).toEqual({ error: "auth_required", rejectedAt: null, renewedAt: null, state: null, updatedAt: null });
  for (const state of ["missing", "invalid_file", "unknown"] as const)
    expect(lib.parseCollectorStatus(withSession("auth_required", { state }))).toMatchObject({ state });
  for (const bad of [
    "",
    "not json",
    "[]",
    collector("expired"),
    collector(null, { stale: "no" }),
    collector(null, { fetchedAt: 1 }),
    collector(null, { session: "ok" }),
    collector(null, { renewal: [] }),
    '{"stale":false,"fetchedAt":null}',
  ])
    expect(lib.parseCollectorStatus(bad)).toBeNull();
});
test("cookie selection: exact names, platform domains only, fixed order", () => {
  expect(lib.selectCookies(jar())).toEqual({ header: HEADER });
  expect(lib.selectCookies([...jar()].reverse())).toEqual({ header: HEADER });
  const without = (name: string) => jar().filter((c) => c.name !== name);
  for (const name of lib.COOKIE_NAMES)
    expect(lib.selectCookies(without(name))).toMatchObject({ result: "signin_required" });
  // Lookalike and foreign domains never satisfy a missing name.
  expect(
    lib.selectCookies([
      ...without("userId"),
      { name: "userId", value: "x", domain: "xiaomimimo.com.evil.example" },
      { name: "userId", value: "x", domain: "notxiaomimimo.com" },
      { name: "userId", value: "x", domain: ".account.xiaomi.com" },
    ]),
  ).toMatchObject({ result: "signin_required" });
  expect(
    lib.selectCookies(jar([{ name: "userId", value: "SYNTHETIC-2", domain: "platform.xiaomimimo.com" }])),
  ).toMatchObject({ result: "error" });
  expect(
    lib.selectCookies([...without("api-platform_ph"), { name: "api-platform_ph", value: "", domain: ".xiaomimimo.com" }]),
  ).toMatchObject({ result: "signin_required" });
  for (const value of ["a\x00b", "a\nb", "a\x7fb", "a;b", "a b", "é", 7])
    expect(
      lib.selectCookies([...without("userId"), { name: "userId", value, domain: ".xiaomimimo.com" }]),
    ).toMatchObject({ result: "error" });
  expect(
    lib.selectCookies([...without("userId"), { name: "userId", value: "x".repeat(16400), domain: ".xiaomimimo.com" }]),
  ).toMatchObject({ result: "error" });
  for (const bad of [null, {}, "cookies"])
    expect(lib.selectCookies(bad)).toMatchObject({ result: "error" });
  for (const outcome of [lib.selectCookies(without("userId")), lib.selectCookies(jar([jar()[3]]))])
    expectNoLeak(JSON.stringify(outcome));
});
test("validation: collector headers, no redirects, 401/403 vs vendor failures", async () => {
  const ok = fakeFetch();
  expect(await lib.validateSession(HEADER, ok.f, 1000)).toBe("ok");
  expect(ok.calls.map((c) => c.url)).toEqual([
    "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage",
    "https://platform.xiaomimimo.com/api/v1/tokenPlan/detail",
  ]);
  for (const { init } of ok.calls) {
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({
      Cookie: HEADER,
      Accept: "application/json",
      "x-timeZone": "Europe/Kiev",
    });
  }
  const cases: [Parameters<typeof fakeFetch>[0], string, number][] = [
    [{ usage: () => new Response(null, { status: 401 }) }, "signin_required", 1],
    [{ usage: () => new Response(null, { status: 403 }) }, "signin_required", 1],
    [{ detail: () => Response.json({ code: 401 }) }, "signin_required", 2],
    [{ usage: () => Response.json({ code: 403 }) }, "signin_required", 1],
    [{ usage: () => new Response(null, { status: 500 }) }, "vendor_unavailable", 1],
    [{ usage: () => new Response(null, { status: 302, headers: { location: "/" } }) }, "vendor_unavailable", 1],
    [{ detail: () => Response.json({ code: 500 }) }, "vendor_unavailable", 2],
    [{ usage: () => new Response("<html>") }, "vendor_unavailable", 1],
    [{ usage: () => Response.json({ data: {} }) }, "vendor_unavailable", 1],
    [{ usage: () => new Response("x".repeat(1024 * 1024 + 1)) }, "vendor_unavailable", 1],
    [{ detail: () => Promise.reject(new Error("synthetic network")) }, "vendor_unavailable", 2],
  ];
  for (const [responses, expected, calls] of cases) {
    const f = fakeFetch(responses);
    expect(await lib.validateSession(HEADER, f.f, 1000)).toBe(expected as never);
    expect(f.calls.length).toBe(calls);
  }
});

test("healthy collector: heartbeat not_needed keeps previous renewedAt, no browser", async () => {
  const r = await run({ ssh: fakeSsh({ stdout: collector(null) }) });
  expect(r.out).toEqual({ code: 0, line: "xiaomi-session-refresh: not_needed (collector ok)" });
  expect(r.ssh.calls.map((c) => c.kind)).toEqual(["read", "status"]);
  expect(r.ssh.calls[0].argv.at(-1)).toBe(lib.statusCommand("xiaomi-quota"));
  expect(r.ssh.calls[0].stdin).toBeNull();
  expect(r.ssh.calls[1].argv.at(-1)).toBe(lib.writeCommand(cfg.remoteDir, "status"));
  expect(r.written).toEqual([
    {
      schemaVersion: 1,
      checkedAt: NOW.toISOString(),
      result: "not_needed",
      renewedAt: PREVIOUS,
      host: "laptop",
      manualCommand: ENV.XQ_MANUAL_COMMAND,
    } as never,
  ]);
  expect(r.connects).toBe(0);
  expect(r.fetcher.calls).toEqual([]);
  // v0.2.x collectors have no session/renewal keys; other errors are not auth.
  const old = await run({
    ssh: fakeSsh({ stdout: '{"error":"unavailable","stale":true,"fetchedAt":null}' }),
  });
  expect(old.out).toEqual({ code: 0, line: "xiaomi-session-refresh: not_needed (collector unavailable)" });
  expect(old.written[0].renewedAt).toBeNull();
  expect(old.connects).toBe(0);
});
test("--check reports the decision without browser, vendor or writes", async () => {
  const cases: [string, Partial<lib.Flags>, string][] = [
    [collector("auth_required"), {}, "check: renewal needed (collector auth_required since " + REJECTED + "; renewal browser running)"],
    [collector(null), {}, "check: not_needed (collector ok; renewal browser running)"],
    [collector(null), { force: true }, "check: renewal needed (forced; collector ok; renewal browser running)"],
    ['{"error":"auth_required","stale":true,"fetchedAt":null}', {}, "check: renewal needed (collector auth_required; renewal browser running)"],
  ];
  for (const [stdout, flags, line] of cases) {
    const state = memState();
    const r = await run({ ssh: fakeSsh({ stdout }), flags: { check: true, ...flags }, state: state.store });
    expect(r.out).toEqual({ code: 0, line: "xiaomi-session-refresh: " + line });
    expect(r.ssh.calls.map((c) => c.kind)).toEqual(["read"]);
    expect(r.connects).toBe(0);
    expect(r.probes).toBe(1);
    expect(r.fetcher.calls).toEqual([]);
    expect(state.saves).toEqual([]);
  }
});
test("expired collector: renews from owned target and pushes once on stdin", async () => {
  const r = await run();
  expect(r.out).toEqual({
    code: 0,
    line: "xiaomi-session-refresh: renewed (collector auth_required since " + REJECTED + ")",
  });
  expectOwnedOnly(r.cdp as FakeCdp);
  expect(r.fetcher.calls.length).toBe(2);
  expect(r.ssh.calls.map((c) => c.kind)).toEqual(["read", "push"]);
  const push = r.ssh.calls[1];
  expect(push.argv.at(-1)).toBe(lib.writeCommand(cfg.remoteDir, "push"));
  const [header, status, end] = push.stdin!.split("\n");
  expect(header).toBe(HEADER);
  expect(end).toBe("");
  expect(push.stdin).not.toContain(PASS_TOKEN);
  expect(JSON.parse(status)).toEqual({
    schemaVersion: 1,
    checkedAt: NOW.toISOString(),
    result: "renewed",
    renewedAt: NOW.toISOString(),
    host: "laptop",
    manualCommand: ENV.XQ_MANUAL_COMMAND,
  });
  const forced = await run({ ssh: fakeSsh({ stdout: collector(null) }), flags: { force: true } });
  expect(forced.out).toEqual({ code: 0, line: "xiaomi-session-refresh: renewed (forced; collector ok)" });
  expectOwnedOnly(forced.cdp as FakeCdp);
});
test("sign-in page: signin_required early, owned target closed, nothing copied", async () => {
  const started = Date.now();
  const r = await run({
    cdp: new FakeCdp({
      onNavigate: (emit) => emit(nav("https://account.xiaomi.com/fe/service/login?sid=synthetic")),
    }),
  });
  expect(r.out.code).toBe(2);
  expect(r.out.line).toBe(
    "xiaomi-session-refresh: signin_required (browser redirected to Xiaomi sign-in; collector auth_required since " +
      REJECTED +
      ")",
  );
  expect(Date.now() - started).toBeLessThan(T.navigationMs);
  expectOwnedOnly(r.cdp as FakeCdp);
  expect((r.cdp as FakeCdp).sent.map((s) => s.method)).not.toContain("Network.getCookies");
  expect(r.fetcher.calls).toEqual([]);
  expect(r.ssh.calls.map((c) => c.kind)).toEqual(["read", "status"]);
  expect(r.written[0]).toMatchObject({ result: "signin_required", renewedAt: PREVIOUS });
});
test("SSO pass-through via the account host still renews", async () => {
  const r = await run({
    cdp: new FakeCdp({
      onNavigate: (emit, cdp) => {
        emit(nav("https://account.xiaomi.com/pass/serviceLogin?sid=synthetic"));
        setTimeout(() => emit(nav(CONSOLE_DOC)), 10);
        setTimeout(() => (cdp.ready = true), 100);
      },
    }),
  });
  expect(r.out.code).toBe(0);
  expect(r.out.line).toStartWith("xiaomi-session-refresh: renewed");
  expectOwnedOnly(r.cdp as FakeCdp);
});
test("foreign targets, subframes and network events are ignored; timeout still validates cookies", async () => {
  const started = Date.now();
  const r = await run({
    cdp: new FakeCdp({
      onNavigate: (emit) => {
        emit(usageEvent());
        emit(usageEvent("S-USER"));
        emit(nav("https://account.xiaomi.com/fe/service/login", "T-USER", "S-USER"));
        emit(nav("https://account.xiaomi.com/fe/service/login", "F-SUB", "S-OWNED", "T-OWNED"));
        emit({ method: "Page.frameNavigated", sessionId: "S-OWNED", params: { frame: { id: "T-OWNED", url: 7 } } });
        emit({ method: "Page.frameNavigated", sessionId: "S-OWNED", params: {} });
        emit({ method: "Target.targetDestroyed", params: { targetId: "T-USER" } });
        emit({ method: "Target.detachedFromTarget", params: { sessionId: "S-USER" } });
      },
    }),
  });
  expect(Date.now() - started).toBeGreaterThanOrEqual(T.navigationMs - 20);
  expect(r.out.code).toBe(0);
  expectOwnedOnly(r.cdp as FakeCdp);
  // Readiness polling continued until the console wait expired.
  expect((r.cdp as FakeCdp).sent.filter((s) => s.method === "Runtime.evaluate").length).toBeGreaterThan(3);
  // Only a boolean true counts as ready.
  for (const evaluate of [
    { result: { type: "string", value: "true" } },
    { result: { type: "object", value: { ready: true } } },
    { result: { type: "boolean", value: true }, exceptionDetails: { text: "synthetic" } },
    {},
  ]) {
    const t0 = Date.now();
    const odd = await run({ cdp: new FakeCdp({ evaluate }) });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(T.navigationMs - 20);
    expect(odd.out.code).toBe(0);
  }
  // Transient evaluate failures (context destroyed by navigation) keep polling.
  const t1 = Date.now();
  const flaky = await run({ cdp: new FakeCdp({ evaluateErrors: 3 }) });
  expect(flaky.out.code).toBe(0);
  expect(Date.now() - t1).toBeLessThan(T.navigationMs);
  expectOwnedOnly(flaky.cdp as FakeCdp);
  // Timeout with stale browser cookies: Xiaomi decides.
  const stale = await run({
    cdp: new FakeCdp({ onNavigate: () => {} }),
    fetch: fakeFetch({ usage: () => new Response(null, { status: 401 }) }),
  });
  expect(stale.out.code).toBe(2);
  expect(stale.out.line).toContain("signin_required (Xiaomi rejected the browser session");
  expectOwnedOnly(stale.cdp as FakeCdp);
});
test("every failure branch writes its status and closes the owned target", async () => {
  const cases: {
    name: string;
    cdp?: FakeCdp | "down";
    fetch?: ReturnType<typeof fakeFetch>;
    result: string;
    code: 0 | 1 | 2;
    reason: string;
    owned?: boolean;
  }[] = [
    { name: "browser down", cdp: "down", result: "browser_unavailable", code: 1, reason: "DevTools endpoint unreachable", owned: false },
    {
      name: "connection lost",
      cdp: new FakeCdp({ onNavigate: (_, cdp) => cdp.drop() }),
      result: "browser_unavailable",
      code: 1,
      reason: "browser connection lost",
    },
    {
      name: "navigation net error",
      cdp: new FakeCdp({ navigate: { frameId: "T-OWNED", errorText: "net::ERR_NAME_NOT_RESOLVED" }, onNavigate: () => {} }),
      result: "vendor_unavailable",
      code: 1,
      reason: "Xiaomi console unreachable",
    },
    // Console never confirmed loaded: a missing cookie means not signed in.
    { name: "missing cookie", cdp: new FakeCdp({ onNavigate: () => {}, cookies: jar().filter((c) => c.name !== "api-platform_slh") }), result: "signin_required", code: 2, reason: "Xiaomi session cookie missing in browser" },
    { name: "duplicate cookie", cdp: new FakeCdp({ cookies: jar([{ name: "api-platform_ph", value: "SYNTHETIC-dup", domain: ".xiaomimimo.com" }]) }), result: "error", code: 1, reason: "duplicate Xiaomi session cookie" },
    { name: "validation 403", cdp: new FakeCdp({ onNavigate: () => {} }), fetch: fakeFetch({ detail: () => new Response(null, { status: 403 }) }), result: "signin_required", code: 2, reason: "Xiaomi rejected the browser session" },
    { name: "validation 5xx", fetch: fakeFetch({ usage: () => new Response(null, { status: 503 }) }), result: "vendor_unavailable", code: 1, reason: "Xiaomi validation failed" },
    { name: "target destroyed", cdp: new FakeCdp({ onNavigate: (emit) => emit({ method: "Target.targetDestroyed", params: { targetId: "T-OWNED" } }) }), result: "error", code: 1, reason: "browser automation failed" },
    { name: "enable throws", cdp: new FakeCdp({ failOn: "Page.enable" }), result: "error", code: 1, reason: "browser automation failed" },
    { name: "attach throws", cdp: new FakeCdp({ failOn: "Target.attachToTarget" }), result: "error", code: 1, reason: "browser automation failed" },
    { name: "navigate throws", cdp: new FakeCdp({ failOn: "Page.navigate" }), result: "error", code: 1, reason: "browser automation failed" },
    { name: "cookies throw", cdp: new FakeCdp({ failOn: "Network.getCookies" }), result: "error", code: 1, reason: "browser automation failed" },
  ];
  for (const c of cases) {
    const r = await run({ cdp: c.cdp, fetch: c.fetch });
    expect({ name: c.name, out: r.out }).toEqual({
      name: c.name,
      out: {
        code: c.code,
        line:
          "xiaomi-session-refresh: " + c.result + " (" + c.reason + "; collector auth_required since " + REJECTED + ")",
      },
    });
    expect(r.ssh.calls.map((x) => x.kind)).toEqual(["read", "status"]);
    expect(r.written[0]).toMatchObject({ result: c.result, renewedAt: PREVIOUS, checkedAt: NOW.toISOString() });
    if (c.owned !== false) expectOwnedOnly(r.cdp as FakeCdp);
  }
  // Nothing created means nothing to close.
  const none = await run({ cdp: new FakeCdp({ failOn: "Target.createTarget" }) });
  expect(none.out.code).toBe(1);
  expect((none.cdp as FakeCdp).sent.map((s) => s.method)).toEqual(["Target.createTarget"]);
  expect((none.cdp as FakeCdp).socketClosed).toBe(true);
});
test("collector unreachable: one line with its cause, exit 1, no status write or browser", async () => {
  const cases: [Parameters<typeof fakeSsh>[0], string][] = [
    [{ read: 255, stderr: "sudo: a password is required" }, "ssh failed"],
    [{ read: lib.TIMED_OUT }, "ssh timed out or could not start"],
    [{ throws: true }, "ssh timed out or could not start"],
    [{ read: 3, stdout: "" }, "collector HTTP status not 200"],
    [{ stdout: "Error: no such container" }, "unrecognised collector status"],
    [{ stdout: collector("expired") }, "unrecognised collector status"],
    [{ read: 1, stderr: "sudo: a password is required\n" }, "sudo refused"],
    [{ read: 1, stderr: "sudo: docker: command not found\n" }, "sudo refused"],
    [{ read: 1, stderr: "Error response from daemon: No such container: xiaomi-quota\n" }, "collector container not running"],
    [{ read: 1, stderr: "Error response from daemon: container 0123 is not running\n" }, "collector container not running"],
    [{ read: 1, stdout: collector(null) }, "remote exit 1"],
    [{ read: 7, stderr: "something else" }, "remote exit 7"],
    [{ read: lib.OVERSIZED }, "collector output over 64 KiB"],
  ];
  for (const [ssh, cause] of cases)
    for (const check of [false, true]) {
      const state = memState();
      const r = await run({ ssh: fakeSsh(ssh), flags: { check }, state: state.store });
      expect(r.out).toEqual({ code: 1, line: "xiaomi-session-refresh: collector_unreachable (" + cause + ")" });
      expect(r.ssh.calls.map((c) => c.kind)).toEqual(["read"]);
      expect(r.connects).toBe(0);
      expect(r.probes).toBe(0);
      expect(state.saves).toEqual([]);
    }
  // The real runner keeps at most 4 KiB of stderr and still drains the rest.
  const dir = await mkdtemp(join(tmpdir(), "xq-stderr-"));
  try {
    const bin = join(dir, "fake-ssh");
    await writeFile(bin, "#!/bin/sh\necho 'sudo: a password is required' >&2\nhead -c 1000000 /dev/zero | tr '\\0' x >&2\nexit 1\n", { mode: 0o700 });
    const r = await lib.spawnRunner({ binary: bin })(["ssh"], null, 5000, true);
    expect(r.code).toBe(1);
    expect(r.stderr!.length).toBe(4096);
    expect(r.stderr).toStartWith("sudo: a password is required\n");
    expect(lib.collectorCause(r)).toBe("sudo refused");
    // Without the flag stderr is not even piped.
    expect("stderr" in (await lib.spawnRunner({ binary: bin })(["ssh"], null, 5000))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("write failures: push failure is error; status write failures are reported", async () => {
  const push = await run({ ssh: fakeSsh({ push: 5 }) });
  expect(push.out).toEqual({
    code: 1,
    line:
      "xiaomi-session-refresh: error (session push failed: remote session directory is group/world accessible; collector auth_required since " +
      REJECTED +
      ")",
  });
  expect(push.ssh.calls.map((c) => c.kind)).toEqual(["read", "push", "status"]);
  expect(push.written.map((w) => w.result)).toEqual(["renewed", "error"]);
  expect(push.written[1].renewedAt).toBe(PREVIOUS);
  const heartbeat = await run({ ssh: fakeSsh({ stdout: collector(null), write: 4 }) });
  expect(heartbeat.out).toEqual({
    code: 1,
    line: "xiaomi-session-refresh: not_needed (collector ok); status write failed: remote session directory not owned by ssh user",
  });
  const signin = await run({
    ssh: fakeSsh({ write: 255 }),
    cdp: new FakeCdp({ onNavigate: () => {}, cookies: [] }),
  });
  expect(signin.out.code).toBe(2);
  expect(signin.out.line).toEndWith("; status write failed: ssh failed");
  const unknown = await run({ ssh: fakeSsh({ write: 9 }), cdp: "down" });
  expect(unknown.out.line).toEndWith("; status write failed: remote exit 9");
});

interface CdpMessage {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}
function cdpServer(
  handle: (m: CdpMessage, reply: (result: unknown) => void, emit: (e: unknown) => void, drop: () => void) => void,
  versionUrl?: (port: number) => string,
) {
  const seen: CdpMessage[] = [];
  let upgrades = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      const url = new URL(request.url);
      if (url.pathname === "/json/version")
        return Response.json({
          Browser: "Synthetic/1.0",
          webSocketDebuggerUrl: versionUrl
            ? versionUrl(srv.port!)
            : "ws://127.0.0.1:" + srv.port + "/devtools/browser/synthetic-0001",
        });
      if (url.pathname === "/devtools/browser/synthetic-0001") {
        upgrades++;
        if (srv.upgrade(request, { data: undefined })) return undefined;
      }
      return new Response(null, { status: 404 });
    },
    websocket: {
      message(ws, data) {
        const m = JSON.parse(String(data)) as CdpMessage;
        seen.push(m);
        handle(
          m,
          (result) => ws.send(JSON.stringify({ id: m.id, result })),
          (e) => ws.send(JSON.stringify(e)),
          () => ws.close(),
        );
      },
    },
  });
  return {
    seen,
    origin: "http://127.0.0.1:" + server.port,
    upgrades: () => upgrades,
    // Awaiting stop() can hang once a server-closed socket existed (Bun 1.3.14).
    stop: () => void server.stop(true),
  };
}
test("CDP client: correlates replies, routes session events, fails closed on loss", async () => {
  const fake = cdpServer((m, reply, emit, drop) => {
    if (m.method === "Synthetic.echo") {
      emit({ method: "Synthetic.event", params: { n: 1 }, sessionId: "S-1" });
      reply({ echoed: m.params, sessionId: m.sessionId });
    } else if (m.method === "Synthetic.fail") emit({ id: m.id, error: { code: -32000, message: "synthetic" } });
    else if (m.method === "Synthetic.drop") drop();
  });
  try {
    const client = await lib.connectBrowser(fake.origin);
    // The browser process's id, from the discovery endpoint's /devtools/browser/<id>.
    expect(client.browserId).toBe("synthetic-0001");
    const events: lib.CdpEvent[] = [];
    const off = client.onEvent((e) => events.push(e));
    expect(await client.send("Synthetic.echo", { a: 1 }, "S-1")).toEqual({ echoed: { a: 1 }, sessionId: "S-1" });
    expect(events).toEqual([{ method: "Synthetic.event", params: { n: 1 }, sessionId: "S-1" }]);
    off();
    await expect(client.send("Synthetic.fail")).rejects.toBeInstanceOf(lib.CdpError);
    await expect(client.send("Synthetic.silent", {}, undefined, 50)).rejects.toBeInstanceOf(lib.CdpError);
    await expect(client.send("Synthetic.drop")).rejects.toBeInstanceOf(lib.BrowserUnavailable);
    await client.closed;
    await expect(client.send("Synthetic.echo")).rejects.toBeInstanceOf(lib.BrowserUnavailable);
    expect(fake.seen[0]).toEqual({ id: 1, method: "Synthetic.echo", params: { a: 1 }, sessionId: "S-1" });
    expect("sessionId" in fake.seen[1]).toBe(false);
  } finally {
    fake.stop();
  }
});
test("CDP discovery: only loopback DevTools endpoints, never a named remote host", async () => {
  for (const url of [
    (p: number) => "ws://192.0.2.10:" + p + "/devtools/browser/synthetic-0001",
    (p: number) => "wss://127.0.0.1:" + p + "/devtools/browser/synthetic-0001",
    (p: number) => "ws://127.0.0.1:" + p + "/devtools/page/synthetic-0001",
    (p: number) => "ws://127.0.0.1:" + p + "/devtools/browser/synthetic-0001?x=1",
    () => "not a url",
  ]) {
    const fake = cdpServer(() => {}, url);
    try {
      await expect(lib.connectBrowser(fake.origin)).rejects.toBeInstanceOf(lib.BrowserUnavailable);
      expect(fake.upgrades()).toBe(0);
    } finally {
      fake.stop();
    }
  }
  // The advertised port is ignored: the socket goes to the configured origin.
  const fake = cdpServer((m, reply) => reply({}), () => "ws://localhost:1/devtools/browser/synthetic-0001");
  try {
    const client = await lib.connectBrowser(fake.origin);
    expect(await client.send("Synthetic.ping")).toEqual({});
    client.close();
    expect(fake.upgrades()).toBe(1);
  } finally {
    fake.stop();
  }
  const gone = cdpServer(() => {});
  const origin = gone.origin;
  gone.stop();
  await expect(lib.connectBrowser(origin, { timeoutMs: 500 })).rejects.toBeInstanceOf(lib.BrowserUnavailable);
});
test("end to end over a synthetic DevTools socket: renewed, owned target closed", async () => {
  const fake = cdpServer((m, reply, emit) => {
    if (m.method === "Target.createTarget") return reply({ targetId: "T-OWNED" });
    if (m.method === "Target.attachToTarget") return reply({ sessionId: "S-OWNED" });
    if (m.method === "Page.navigate") {
      // Events may precede the navigate reply, as in Chrome.
      emit(nav(CONSOLE_DOC));
      return reply({ frameId: "T-OWNED", loaderId: "L-1" });
    }
    if (m.method === "Runtime.evaluate") return reply({ result: { type: "boolean", value: true } });
    if (m.method === "Network.getCookies") return reply({ cookies: jar() });
    reply({});
  });
  try {
    const ssh = fakeSsh();
    const fetcher = fakeFetch();
    const out = await lib.runRefresh(
      { ...cfg, cdpOrigin: fake.origin },
      { force: false, check: false, rebind: false },
      {
        ssh: ssh.run,
        connectBrowser: (o, ms) => lib.connectBrowser(o, { timeoutMs: ms }),
        probe: (o, ms) => lib.probeBrowser(o, ms),
        fetch: fetcher.f,
        now: () => NOW,
      },
      T,
    );
    expect(out.code).toBe(0);
    expect(ssh.calls[1].stdin!.split("\n")[0]).toBe(HEADER);
    expect(fake.seen.map((m) => [m.method, m.sessionId ?? null])).toEqual([
      ["Target.createTarget", null],
      ["Target.attachToTarget", null],
      ["Page.enable", "S-OWNED"],
      ["Page.navigate", "S-OWNED"],
      ["Runtime.evaluate", "S-OWNED"],
      ["Network.getCookies", "S-OWNED"],
      ["Target.closeTarget", null],
    ]);
    expect(fake.seen.find((m) => m.method === "Runtime.evaluate")!.params).toEqual({
      expression: lib.READY_JS,
      returnByValue: true,
    });
    expect(fake.seen.at(-1)!.params).toEqual({ targetId: "T-OWNED" });
  } finally {
    fake.stop();
  }
});
test("entrypoint refuses invalid configuration before any I/O", async () => {
  const home = await mkdtemp(join(tmpdir(), "xq-entry-"));
  try {
    const runtime = join(home, "run");
    await mkdir(runtime);
    for (const [args, env, message, rejected] of [
      [["--bogus"], ENV, "usage:", "--bogus"],
      [[], { ...ENV, XQ_SSH_TARGET: "user@host;id" }, "XQ_SSH_TARGET", "host;id"],
      [[], { ...ENV, XQ_CDP_URL: "http://192.0.2.10:9223" }, "XQ_CDP_URL", "192.0.2.10"],
      [["--check"], { XQ_REMOTE_DIR: "/srv/x" }, "XQ_SSH_TARGET", "/srv/x"],
      [[], { ...ENV, XQ_BROWSER_LAUNCH: "relative/launch-browser" }, "XQ_BROWSER_LAUNCH", "relative/launch-browser"],
      [["--force"], { ...ENV, XQ_BROWSER_LAUNCH: "/synthetic/launch\u0007bell" }, "XQ_BROWSER_LAUNCH", "bell"],
      [[], { ...ENV, XQ_NOTIFY: "email" }, "XQ_NOTIFY", "email"],
    ] as const) {
      const p = Bun.spawn([process.execPath, join(import.meta.dir, "refresh-session.ts"), ...args], {
        env: { PATH: process.env.PATH!, HOME: home, XDG_RUNTIME_DIR: runtime, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await p.exited).toBe(1);
      expect(await new Response(p.stdout).text()).toBe("");
      const err = await new Response(p.stderr).text();
      expect(err).toStartWith("xiaomi-session-refresh: invalid configuration: ");
      expect(err).toContain(message);
      expect(err).not.toContain(rejected);
      expect(err.trim().split("\n").length).toBe(1);
      // Before the run lock and the state directory: nothing created (.bun is Bun's own cache).
      expect(await readdir(runtime)).toEqual([]);
      expect((await readdir(home)).filter((name) => name !== ".bun")).toEqual(["run"]);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// Account binding: the writer compares userId of the new line with the installed session.
const OTHER = "api-platform_serviceToken=SYNTHETIC-other-svc; userId=SYNTHETIC-uid-9999";
const writerSecrets = [...Object.values(SECRETS), "SYNTHETIC-uid-9999", "SYNTHETIC-other-svc"];
async function writer(dir: string, mode: "push" | "rebind", stdin: string) {
  // Direct spawn so the writer's own stdout/stderr can be inspected for leaks.
  const p = Bun.spawn(["sh", "-c", lib.writeCommand(dir, mode)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH!, HOME: tmpdir() },
  });
  p.stdin.write(stdin);
  await p.stdin.end();
  const [code, out, err] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  for (const secret of writerSecrets) {
    expect(out).not.toContain(secret);
    expect(err).not.toContain(secret);
  }
  return code;
}
test("remote writer: push replaces only a session of the same account; rebind skips the check", async () => {
  await sessionDir(async (dir) => {
    const file = join(dir, "mimo_session");
    const put = async (content: string | Uint8Array) => {
      await rm(file, { recursive: true, force: true });
      await writeFile(file, content, { mode: 0o600 });
    };
    const status = '{"schemaVersion":1}\n';
    // Same userId, other cookies and spacing differ: replaced.
    for (const current of [
      "api-platform_serviceToken=SYNTHETIC-old; userId=" + SECRETS.userId + "\n",
      "  userId=" + SECRETS.userId + " ;api-platform_ph=SYNTHETIC-old\r\n",
      "a=1;userId=" + SECRETS.userId,
      "userId=" + SECRETS.userId + ";\t",
    ]) {
      await put(current);
      expect(await writer(dir, "push", HEADER + "\n" + status)).toBe(0);
      expect(await readFile(file, "utf8")).toBe(HEADER + "\n");
    }
    // Different, missing, ambiguous or unparseable current account: refused, file untouched.
    const refused: (string | Uint8Array)[] = [
      OTHER + "\n",
      "api-platform_serviceToken=SYNTHETIC-old\n",
      "userId=\n",
      "xuserId=" + SECRETS.userId + "\n",
      "userId=" + SECRETS.userId + "; userId=" + SECRETS.userId + "\n",
      "userId=" + SECRETS.userId + "x\n",
      "userId=" + SECRETS.userId + "; note=…\n",
      new Uint8Array([...Buffer.from("userId=" + SECRETS.userId), 0, 0x41, 0x0a]),
      "userId=" + SECRETS.userId + "; pad=" + "x".repeat(16400) + "\n",
      "\n",
    ];
    for (const current of refused) {
      await put(current);
      const before = await lstat(file);
      await writeFile(join(dir, "renewal-status.json"), '{"previous":1}\n', { mode: 0o600 });
      expect(await writer(dir, "push", HEADER + "\n" + status)).toBe(8);
      const after = await lstat(file);
      expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
      expect(Buffer.compare(await readFile(file), Buffer.from(current))).toBe(0);
      expect(await readFile(join(dir, "renewal-status.json"), "utf8")).toBe('{"previous":1}\n');
      expect((await readdir(dir)).sort()).toEqual(["mimo_session", "renewal-status.json"]);
    }
    // A missing file, a symlink or a non-regular file has no account to compare.
    await rm(file);
    expect(await writer(dir, "push", HEADER + "\n" + status)).toBe(8);
    expect(await readdir(dir)).toEqual(["renewal-status.json"]);
    const elsewhere = join(dir, "..", "elsewhere");
    await writeFile(elsewhere, "userId=" + SECRETS.userId + "\n", { mode: 0o600 });
    await symlink(elsewhere, file);
    expect(await writer(dir, "push", HEADER + "\n" + status)).toBe(8);
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    await rm(file);
    // --rebind installs over a different account and over no session at all.
    expect(await writer(dir, "rebind", HEADER + "\n" + status)).toBe(0);
    expect(await readFile(file, "utf8")).toBe(HEADER + "\n");
    await put(OTHER + "\n");
    expect(await writer(dir, "rebind", HEADER + "\n" + status)).toBe(0);
    expect(await readFile(file, "utf8")).toBe(HEADER + "\n");
    // The new line itself must name exactly one account, in both modes.
    for (const mode of ["push", "rebind"] as const)
      for (const line of [
        "api-platform_serviceToken=SYNTHETIC-x",
        "userId=a; userId=b",
        "userId=",
      ]) {
        await put(HEADER + "\n");
        expect(await writer(dir, mode, line + "\n" + status)).toBe(6);
        expect(await readFile(file, "utf8")).toBe(HEADER + "\n");
      }
    expect((await readdir(dir)).sort()).toEqual(["mimo_session", "renewal-status.json"]);
  });
}, 30000);
test("remote writer: the new line must be 1-16384 printable ASCII bytes", async () => {
  await sessionDir(async (dir) => {
    const file = join(dir, "mimo_session");
    await writeFile(file, HEADER + "\n", { mode: 0o600 });
    for (const bad of ["…", "é", "\x01", "\t", "\x7f", "\x80"]) {
      const line = HEADER.replace("SYNTHETIC-ph-cccc", "SYNTHETIC-ph" + bad);
      expect(await writer(dir, "rebind", line + "\n{}\n")).toBe(6);
      expect(await readFile(file, "utf8")).toBe(HEADER + "\n");
    }
    const max = "userId=" + SECRETS.userId + "; pad=";
    const fits = max + "x".repeat(16384 - max.length);
    expect(await writer(dir, "rebind", fits + "\n{}\n")).toBe(0);
    expect(await writer(dir, "rebind", fits + "x\n{}\n")).toBe(6);
    expect(await readFile(file, "utf8")).toBe(fits + "\n");
  });
});
test("account binding end to end: same account renews, other account is account_mismatch, --rebind switches", async () => {
  await sessionDir(async (dir) => {
    const c = { ...cfg, remoteDir: dir };
    const file = join(dir, "mimo_session");
    const statusFile = async () => JSON.parse(await readFile(join(dir, "renewal-status.json"), "utf8"));
    await writeFile(file, "api-platform_serviceToken=SYNTHETIC-old; userId=" + SECRETS.userId + "\n", { mode: 0o600 });
    let r = await run({ cfg: c, ssh: writerSsh() });
    expect(r.out).toEqual({ code: 0, line: "xiaomi-session-refresh: renewed (collector auth_required since " + REJECTED + ")" });
    expect(await readFile(file, "utf8")).toBe(HEADER + "\n");
    expect((await statusFile()).result).toBe("renewed");
    const mismatch =
      "xiaomi-session-refresh: account_mismatch (installed session missing, unusable or of another account; collector auth_required since " +
      REJECTED +
      ")";
    for (const current of [OTHER + "\n", "api-platform_serviceToken=SYNTHETIC-other-svc\n", null]) {
      await rm(file, { force: true });
      if (current !== null) await writeFile(file, current, { mode: 0o600 });
      const before = current === null ? null : (await lstat(file)).ino;
      r = await run({ cfg: c, ssh: writerSsh() });
      expect(r.out).toEqual({ code: 3, line: mismatch });
      expect(r.ssh.calls.map((x) => x.kind)).toEqual(["read", "push", "status"]);
      expect(r.written.map((w) => w.result)).toEqual(["renewed", "account_mismatch"]);
      expect(r.written[1].renewedAt).toBe(PREVIOUS);
      expect(await statusFile()).toMatchObject({ result: "account_mismatch", renewedAt: PREVIOUS });
      if (current === null) expect(await readdir(dir)).toEqual(["renewal-status.json"]);
      else {
        expect(await readFile(file, "utf8")).toBe(current);
        expect((await lstat(file)).ino).toBe(before!);
      }
      for (const secret of writerSecrets) expect(r.out.line).not.toContain(secret);
    }
    // Operator-chosen rebind: no comparison, the line records it.
    r = await run({ cfg: c, ssh: writerSsh(), flags: { rebind: true } });
    expect(r.out).toEqual({
      code: 0,
      line: "xiaomi-session-refresh: renewed (rebind; collector auth_required since " + REJECTED + ")",
    });
    expect(r.ssh.calls.map((x) => x.kind)).toEqual(["read", "rebind"]);
    expect(await readFile(file, "utf8")).toBe(HEADER + "\n");
    expect((await statusFile()).result).toBe("renewed");
    // A failed status write after a mismatch is still reported, exit code stays 3.
    const failing = await run({ ssh: fakeSsh({ push: 8, write: 5 }) });
    expect(failing.out.code).toBe(3);
    expect(failing.out.line).toEndWith("; status write failed: remote session directory is group/world accessible");
    // --check with --rebind still only reports.
    const check = await run({ ssh: fakeSsh(), flags: { check: true, rebind: true } });
    expect(check.out.line).toBe(
      "xiaomi-session-refresh: check: renewal needed (rebind; collector auth_required since " + REJECTED + "; renewal browser running)",
    );
    expect(check.ssh.calls.map((x) => x.kind)).toEqual(["read"]);
  });
}, 30000);

test("spawn runner: stdout over 64 KiB kills ssh at once instead of buffering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xq-flood-"));
  try {
    const flood = join(dir, "flood");
    await writeFile(flood, `#!/bin/sh\necho $$ > "${dir}/pid"\nhead -c 4000000 /dev/zero\nexec sleep 30\n`, { mode: 0o700 });
    const started = Date.now();
    expect(await lib.spawnRunner({ binary: flood })(["ssh"], null, 10000)).toEqual({ code: lib.OVERSIZED, stdout: "" });
    expect(Date.now() - started).toBeLessThan(3000);
    const pid = Number(await readFile(join(dir, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    // Exactly 64 KiB is still accepted.
    const edge = join(dir, "edge");
    await writeFile(edge, "#!/bin/sh\nhead -c 65536 /dev/zero | tr '\\0' x\n", { mode: 0o700 });
    const r = await lib.spawnRunner({ binary: edge })(["ssh"], null, 10000);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("x".repeat(65536));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spawn runner: a descendant that keeps stdout or stderr open cannot hold the call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xq-drain-"));
  try {
    // Like a ProxyCommand helper or wrapper left running: it inherits both pipes and
    // outlives ssh by far.
    const helper = `(sleep 8 </dev/null & echo $! >> "${dir}/pids")`;
    const exits = join(dir, "exits");
    await writeFile(exits, `#!/bin/sh
echo partial-out
echo 'sudo: a password is required' >&2
${helper}
exit 255
`, { mode: 0o700 });
    for (const keepStderr of [true, false]) {
      const started = Date.now();
      const r = await lib.spawnRunner({ binary: exits })(["ssh"], null, 5000, keepStderr);
      expect(Date.now() - started).toBeLessThan(lib.DRAIN_MS + 1500);
      expect(r.code).toBe(255);
      expect(r.stdout).toBe("partial-out\n");
      if (keepStderr) expect(lib.collectorCause(r)).toBe("ssh failed");
      if (keepStderr) expect(r.stderr).toBe("sudo: a password is required\n");
    }
    // Killed at the timeout while the helper still holds the pipes: bounded as well.
    const hangs = join(dir, "hangs");
    await writeFile(hangs, `#!/bin/sh
${helper}
exec sleep 30
`, { mode: 0o700 });
    const started = Date.now();
    const r = await lib.spawnRunner({ binary: hangs })(["ssh"], null, 300, true);
    expect(r).toEqual({ code: lib.TIMED_OUT, stdout: "" });
    expect(Date.now() - started).toBeLessThan(300 + lib.DRAIN_MS + 1500);
  } finally {
    for (const pid of (await readFile(join(dir, "pids"), "utf8").catch(() => "")).split("\n").filter(Boolean))
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // Already gone.
      }
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);

test("readiness expression: boolean only, same-origin usage URL with status 200", () => {
  const ready = (entries: unknown, type = "resource") =>
    Function("performance", "return " + lib.READY_JS)({
      getEntriesByType: (t: string) => {
        if (entries === "throw") throw new Error("synthetic");
        return t === type ? entries : [];
      },
    });
  const usage = (name: string, responseStatus: unknown = 200) => ({ name, responseStatus });
  const cases: [unknown, boolean][] = [
    [[], false],
    [[usage(lib.USAGE_URL)], true],
    [[usage(lib.USAGE_URL + "?t=1")], true],
    [[usage("not a url"), usage(lib.USAGE_URL)], true],
    [[usage(lib.USAGE_URL, 401)], false],
    [[usage(lib.USAGE_URL, 0)], false],
    [[usage(lib.USAGE_URL, "200")], false],
    [[usage("https://evil.example/api/v1/tokenPlan/usage")], false],
    [[usage(lib.USAGE_URL + "/x")], false],
    [[usage("https://platform.xiaomimimo.com/api/v1/tokenPlan/detail")], false],
    [[{ responseStatus: 200 }], false],
    ["throw", false],
    [null, false],
  ];
  for (const [entries, expected] of cases) {
    const v = ready(entries);
    expect(typeof v).toBe("boolean");
    expect(v).toBe(expected);
  }
});

test("run deadline bounds every step; the owned tab is closed and the failure recorded", async () => {
  const tight = { ...T, runMs: 150, navigationMs: 5000, commandMs: 5000, statusSshMs: 5000, vendorMs: 5000, writeSshMs: 5000 };
  const line = "xiaomi-session-refresh: error (run deadline exceeded; collector auth_required since " + REJECTED + ")";
  // Console never becomes ready.
  let started = Date.now();
  let r = await run({ t: tight, cdp: new FakeCdp({ onNavigate: () => {} }) });
  expect(Date.now() - started).toBeLessThan(1500);
  expect(r.out).toEqual({ code: 1, line });
  expect((r.cdp as FakeCdp).sent.map((s) => s.method)).not.toContain("Network.getCookies");
  expectOwnedOnly(r.cdp as FakeCdp);
  expect(r.written.map((w) => w.result)).toEqual(["error"]);
  expect(r.ssh.calls[0].timeoutMs).toBeLessThanOrEqual(150);
  // An unanswered DevTools command gets at most the remaining budget.
  for (const hang of ["Target.attachToTarget", "Page.enable", "Network.getCookies"]) {
    started = Date.now();
    r = await run({ t: tight, cdp: new FakeCdp({ hang }) });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(r.out).toEqual({ code: 1, line });
    const timed = (r.cdp as FakeCdp).timing.find((x) => x.method === hang)!;
    expect(timed.ms).toBeLessThanOrEqual(150);
    expectOwnedOnly(r.cdp as FakeCdp);
  }
  // Validation that never answers is cut at the deadline; nothing is pushed.
  const hanging: ReturnType<typeof fakeFetch> = fakeFetch({
    usage: () =>
      new Promise<Response>((_, reject) =>
        hanging.calls.at(-1)!.init.signal!.addEventListener("abort", () => reject(new Error("aborted"))),
      ),
  });
  started = Date.now();
  r = await run({ t: { ...tight, navigationMs: 50 }, cdp: new FakeCdp({ onNavigate: () => {} }), fetch: hanging });
  expect(Date.now() - started).toBeLessThan(1500);
  expect(r.out).toEqual({ code: 1, line });
  expect(hanging.calls.length).toBe(1);
  expect(r.ssh.calls.map((x) => x.kind)).toEqual(["read", "status"]);
});

test("abort (SIGTERM/SIGINT) closes the owned tab at once and writes nothing", async () => {
  const line = "xiaomi-session-refresh: interrupted";
  // During the console wait.
  let ac = new AbortController();
  let r = await run({ signal: ac.signal, cdp: new FakeCdp({ onNavigate: () => ac.abort() }), t: { ...T, navigationMs: 5000 } });
  expect(r.out).toEqual({ code: 1, line });
  expectOwnedOnly(r.cdp as FakeCdp);
  expect((r.cdp as FakeCdp).sent.map((s) => s.method)).not.toContain("Network.getCookies");
  expect(r.ssh.calls.map((x) => x.kind)).toEqual(["read"]);
  expect(r.fetcher.calls).toEqual([]);
  // While a DevTools command is unanswered: the tab is closed immediately, not after the timeout.
  ac = new AbortController();
  const cdp = new FakeCdp({ hang: "Network.getCookies" });
  const pending = run({ signal: ac.signal, cdp, t: { ...T, commandMs: 400 } });
  while (!cdp.sent.some((s) => s.method === "Network.getCookies")) await Bun.sleep(2);
  const abortedAt = Date.now();
  ac.abort();
  await Bun.sleep(20);
  const close = cdp.timing.find((x) => x.method === "Target.closeTarget");
  expect(close).toBeDefined();
  expect(close!.at - abortedAt).toBeLessThan(20);
  r = await pending;
  expect(r.out).toEqual({ code: 1, line });
  expect(cdp.sent.filter((s) => s.method === "Target.closeTarget").length).toBe(1);
  expect(r.ssh.calls.map((x) => x.kind)).toEqual(["read"]);
  // After the browser step but before the push: nothing is installed.
  ac = new AbortController();
  r = await run({
    signal: ac.signal,
    fetch: fakeFetch({
      detail: () => {
        ac.abort();
        return Response.json({ code: 0, data: {} });
      },
    }),
  });
  expect(r.out).toEqual({ code: 1, line });
  expect(r.ssh.calls.map((x) => x.kind)).toEqual(["read"]);
  // getCookies answers after the interrupt: the copied session is never sent to Xiaomi.
  ac = new AbortController();
  r = await run({ signal: ac.signal, cdp: new FakeCdp({ onCookies: () => ac.abort() }) });
  expect(r.out).toEqual({ code: 1, line });
  expect(r.fetcher.calls).toEqual([]);
  expect(r.ssh.calls.map((x) => x.kind)).toEqual(["read"]);
  // Interrupted during the first validation request: the second one never starts.
  ac = new AbortController();
  r = await run({ signal: ac.signal, fetch: fakeFetch({ usage: () => { ac.abort(); return Response.json({ code: 0, data: {} }); } }) });
  expect(r.out).toEqual({ code: 1, line });
  expect(r.fetcher.calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/v1/tokenPlan/usage"]);
  // createTarget answers after the interrupt: the late tab is still closed.
  ac = new AbortController();
  const late = new FakeCdp({ delay: { method: "Target.createTarget", ms: 60 } });
  const lateRun = run({ signal: ac.signal, cdp: late });
  while (!late.sent.some((x) => x.method === "Target.createTarget")) await Bun.sleep(2);
  ac.abort();
  r = await lateRun;
  expect(r.out).toEqual({ code: 1, line });
  expect(late.sent.filter((x) => x.method === "Target.closeTarget").map((x) => x.params.targetId)).toEqual(["T-OWNED"]);
  // Already aborted: no browser at all.
  ac = new AbortController();
  ac.abort();
  r = await run({ signal: ac.signal });
  expect(r.out).toEqual({ code: 1, line });
  expect(r.connects).toBe(0);
});

test("entrypoint: SIGTERM/SIGINT close the owned target and exit 128+signal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xq-signal-"));
  try {
    await writeFile(join(dir, "status.json"), collector("auth_required") + "\n");
    await writeFile(
      join(dir, "ssh"),
      `#!/bin/sh\ncase "$*" in *"'sudo'"*) cat "${dir}/status.json" ;; *) cat > /dev/null; echo write >> "${dir}/writes" ;; esac\n`,
      { mode: 0o700 },
    );
    for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]] as const) {
      let navigated!: () => void;
      const onNavigate = new Promise<void>((resolve) => (navigated = resolve));
      const fake = cdpServer((m, reply) => {
        if (m.method === "Target.createTarget") return reply({ targetId: "T-OWNED" });
        if (m.method === "Target.attachToTarget") return reply({ sessionId: "S-OWNED" });
        if (m.method === "Page.navigate") {
          navigated();
          return reply({ frameId: "T-OWNED", loaderId: "L-1" });
        }
        if (m.method === "Runtime.evaluate") return reply({ result: { type: "boolean", value: false } });
        reply({});
      });
      try {
        const p = Bun.spawn([process.execPath, join(import.meta.dir, "refresh-session.ts")], {
          env: { PATH: dir + ":" + process.env.PATH, HOME: dir, ...ENV, XQ_CDP_URL: fake.origin },
          stdout: "pipe",
          stderr: "pipe",
        });
        await Promise.race([onNavigate, Bun.sleep(10000)]);
        expect(fake.seen.map((m) => m.method)).toContain("Page.navigate");
        const killedAt = Date.now();
        p.kill(signal);
        expect(await p.exited).toBe(code);
        expect(Date.now() - killedAt).toBeLessThan(3000);
        expect(fake.seen.filter((m) => m.method === "Target.closeTarget").map((m) => m.params)).toEqual([
          { targetId: "T-OWNED" },
        ]);
        expect(await new Response(p.stdout).text()).toBe("");
        expect(await new Response(p.stderr).text()).toBe("xiaomi-session-refresh: interrupted\n");
        expect((await readdir(dir)).includes("writes")).toBe(false);
      } finally {
        fake.stop();
      }
    }
    // The browser answers createTarget 4.5 s after a SIGTERM: longer than a short fallback exit,
    // shorter than the command timeout. The late tab must still be closed before the process exits.
    let created!: () => void;
    const onCreate = new Promise<void>((resolve) => (created = resolve));
    const slow = cdpServer((m, reply) => {
      if (m.method === "Target.createTarget") {
        created();
        return void setTimeout(() => reply({ targetId: "T-LATE" }), 4500);
      }
      reply({});
    });
    try {
      const p = Bun.spawn([process.execPath, join(import.meta.dir, "refresh-session.ts")], {
        env: { PATH: dir + ":" + process.env.PATH, HOME: dir, ...ENV, XQ_CDP_URL: slow.origin },
        stdout: "pipe",
        stderr: "pipe",
      });
      await Promise.race([onCreate, Bun.sleep(10000)]);
      const killedAt = Date.now();
      p.kill("SIGTERM");
      expect(await p.exited).toBe(143);
      expect(Date.now() - killedAt).toBeLessThan(13000);
      expect(slow.seen.filter((m) => m.method === "Target.closeTarget").map((m) => m.params)).toEqual([
        { targetId: "T-LATE" },
      ]);
      expect((await readdir(dir)).includes("writes")).toBe(false);
    } finally {
      slow.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 45000);

// ---- v0.3.1: browser launch, early warning, notifications, backoff, lock, state ----

const LOGIN = "https://account.xiaomi.com/fe/service/login?sid=synthetic";
const signinCdp = () => new FakeCdp({ onNavigate: (emit) => emit(nav(LOGIN)) });
const cfgL = lib.parseConfig({ ...ENV, XQ_BROWSER_LAUNCH: "/synthetic/launch-browser" }, "laptop");
const MANUAL = 'run "' + ENV.XQ_MANUAL_COMMAND + '"';
// Discovery endpoint and launcher of one synthetic renewal browser.
function fakeBrowser(
  o: {
    running?: boolean;
    start?: lib.LocalResult | "unsafe";
    check?: lib.LocalResult | "unsafe";
    // Discovery probes after the start request before the endpoint answers; null = never.
    upAfter?: number | null;
    // The first n probes time out (a busy browser, or one still starting).
    unknownFor?: number;
    onStart?: () => void;
  } = {},
) {
  const b = {
    running: o.running ?? false,
    launches: [] as { check: boolean; timeoutMs: number }[],
    sinceStart: -1,
    probes: 0,
  };
  const probe = async (): Promise<lib.ProbeState> => {
    if (++b.probes <= (o.unknownFor ?? 0)) return "unknown";
    if (b.sinceStart >= 0 && o.upAfter !== null && ++b.sinceStart > (o.upAfter ?? 2)) b.running = true;
    return b.running ? "up" : "refused";
  };
  const launcher: lib.Launcher = async (check, timeoutMs) => {
    b.launches.push({ check, timeoutMs });
    if (check) return o.check ?? 0;
    const r = o.start ?? 0;
    if (r === 0) {
      b.sinceStart = 0;
      o.onStart?.();
    }
    return r;
  };
  return { b, probe, launcher };
}

test("config: launcher path, notification mode and timer trigger", () => {
  const c = lib.parseConfig(
    {
      ...ENV,
      XQ_BROWSER_LAUNCH: "/home/user/.local/share/xiaomi-session-refresh/launch browser.sh",
      XQ_NOTIFY: "desktop",
      XQ_TIMER_RUN: "1",
    },
    "h",
  );
  expect([c.browserLaunch, c.notify, c.timerRun]).toEqual([
    "/home/user/.local/share/xiaomi-session-refresh/launch browser.sh",
    "desktop",
    true,
  ]);
  expect(lib.parseConfig({ ...ENV, XQ_BROWSER_LAUNCH: "", XQ_NOTIFY: "" }, "h")).toMatchObject({
    browserLaunch: null,
    notify: "none",
  });
  expect(lib.parseConfig({ ...ENV, XQ_NOTIFY: "none" }, "h").notify).toBe("none");
  // Only the timer-triggered unit sets XQ_TIMER_RUN=1. The manual `bun` retry
  // and a leftover TRIGGER_UNIT (which sticks on the unit after its first timer
  // start) must never count as a timer run.
  for (const v of [undefined, "", "0", "2", "true", "01", " 1"])
    expect(lib.parseConfig({ ...ENV, XQ_TIMER_RUN: v }, "h").timerRun).toBe(false);
  expect(
    lib.parseConfig({ ...ENV, TRIGGER_UNIT: "xiaomi-session-refresh.timer" }, "h").timerRun,
  ).toBe(false);
});

test("launcher runner: argv only, closed stdin, allowlisted env, timeout and use-time file checks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xq-launch-"));
  try {
    const script = join(dir, "launch");
    await writeFile(join(dir, "code"), "exit 0");
    await writeFile(
      script,
      `#!/bin/sh\nprintf '%s\\n' "$#" "$@" > "${dir}/argv"\nenv > "${dir}/env"\n` +
        `if read -r line; then echo got > "${dir}/stdin"; fi\necho to-stdout; echo to-stderr >&2\n` +
        `exec sh -c "$(cat "${dir}/code")"\n`,
      { mode: 0o700 },
    );
    const env = {
      PATH: process.env.PATH,
      HOME: dir,
      WAYLAND_DISPLAY: "wayland-synthetic",
      HYPRLAND_INSTANCE_SIGNATURE: "synthetic-instance",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/synthetic/bus",
      XDG_DATA_HOME: dir + "/data",
      LD_LIBRARY_PATH: "/synthetic/lib",
      SSH_AUTH_SOCK: "/synthetic/agent.sock",
      XQ_SSH_TARGET: "user@collector.example",
      UNRELATED_SECRET: "SYNTHETIC-do-not-pass",
    };
    const launch = lib.launcherRunner(script, { env });
    expect(await launch(false, 5000)).toBe(0);
    expect(await readFile(join(dir, "argv"), "utf8")).toBe("0\n");
    expect(existsSync(join(dir, "stdin"))).toBe(false);
    const seen = (await readFile(join(dir, "env"), "utf8")).split("\n").map((l) => l.split("=")[0]);
    for (const key of ["PATH", "HOME", "WAYLAND_DISPLAY", "HYPRLAND_INSTANCE_SIGNATURE", "DBUS_SESSION_BUS_ADDRESS", "XDG_DATA_HOME"])
      expect(seen).toContain(key);
    for (const key of ["LD_LIBRARY_PATH", "SSH_AUTH_SOCK", "XQ_SSH_TARGET", "UNRELATED_SECRET"]) expect(seen).not.toContain(key);
    expect(await launch(true, 5000)).toBe(0);
    expect(await readFile(join(dir, "argv"), "utf8")).toBe("1\n--check\n");
    await writeFile(join(dir, "code"), "exit 3");
    expect(await launch(false, 5000)).toBe(3);
    // Killed at the timeout or on abort, not waited for.
    await writeFile(join(dir, "code"), "exec sleep 10");
    let started = Date.now();
    expect(await launch(false, 200)).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3000);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    started = Date.now();
    expect(await launch(true, 5000, ac.signal)).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await launch(true, 5000, ac.signal)).toBe("failed");
    // Use-time checks: symlink, group/world-writable, not executable, foreign owner, missing, directory.
    await writeFile(join(dir, "code"), "exit 0");
    await symlink(script, join(dir, "link"));
    expect(await lib.launcherRunner(join(dir, "link"), { env })(false, 1000)).toBe("unsafe");
    for (const mode of [0o720, 0o702, 0o600, 0o677]) {
      await chmod(script, mode);
      expect(await launch(false, 1000)).toBe("unsafe");
    }
    await chmod(script, 0o500);
    expect(await launch(false, 1000)).toBe(0);
    expect(await lib.launcherRunner(script, { env, uid: process.getuid!() + 1 })(false, 1000)).toBe("unsafe");
    expect(await lib.launcherRunner(join(dir, "missing"), { env })(false, 1000)).toBe("unsafe");
    expect(await lib.launcherRunner(dir, { env })(false, 1000)).toBe("unsafe");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("launch: a stopped browser is started, polled for, used and closed with Browser.close", async () => {
  const f = fakeBrowser({ upAfter: 3 });
  const started = Date.now();
  const r = await run({ cfg: cfgL, probe: f.probe, launcher: f.launcher });
  expect(r.out).toEqual({
    code: 0,
    line: "xiaomi-session-refresh: renewed (collector auth_required since " + REJECTED + ")",
  });
  expect(f.b.launches).toEqual([{ check: false, timeoutMs: T.launcherMs }]);
  // One probe before the launch, then every pollMs until the endpoint answers.
  expect(r.probes).toBe(5);
  expect(Date.now() - started).toBeGreaterThanOrEqual(3 * T.pollMs);
  expect(r.connects).toBe(1);
  expectOwnedOnly(r.cdp as FakeCdp, true);
  expect(r.ssh.calls.map((c) => c.kind)).toEqual(["read", "push"]);
  // Failure outcomes close it too, after the owned tab.
  const g = fakeBrowser({ upAfter: 0 });
  const signin = await run({ cfg: cfgL, probe: g.probe, launcher: g.launcher, cdp: signinCdp() });
  expect(signin.out.code).toBe(2);
  expectOwnedOnly(signin.cdp as FakeCdp, true);
  // Connection lost mid-run: one fresh browser-level connection to the same browser
  // process (same browser id) carries Browser.close.
  const h = fakeBrowser({ upAfter: 0 });
  const lost = await run({ cfg: cfgL, probe: h.probe, launcher: h.launcher, cdp: new FakeCdp({ onNavigate: (_, cdp) => cdp.drop() }) });
  expect(lost.out.line).toStartWith("xiaomi-session-refresh: browser_unavailable (browser connection lost;");
  expect(lost.connects).toBe(2);
  expect((lost.cdp as FakeCdp).sent.at(-1)).toEqual({ method: "Browser.close", params: {}, sessionId: undefined });
  // Lost, and another browser process answers the port by then: not this run's, never closed.
  const k = fakeBrowser({ upAfter: 0 });
  const other = new FakeCdp({ browserId: "B-OTHER" });
  const swapped = await run({
    cfg: cfgL,
    probe: k.probe,
    launcher: k.launcher,
    cdp: new FakeCdp({ onNavigate: (_, cdp) => cdp.drop() }),
    reconnect: other,
  });
  expect(swapped.out.line).toStartWith("xiaomi-session-refresh: browser_unavailable (browser connection lost;");
  expect(swapped.connects).toBe(2);
  expect(other.sent).toEqual([]);
  expect(other.socketClosed).toBe(true);
  expect((swapped.cdp as FakeCdp).sent.filter((m) => m.method === "Browser.close")).toEqual([]);
});

test("launch: a running browser that answers discovery late is never started again or closed", async () => {
  // The first probe times out while the browser runs (swap, session restore, still
  // starting): no launch, the normal connect, and no Browser.close.
  const since = "collector auth_required since " + REJECTED;
  const f = fakeBrowser({ running: true, unknownFor: 1 });
  const r = await run({ cfg: cfgL, probe: f.probe, launcher: f.launcher });
  expect(r.out).toEqual({ code: 0, line: "xiaomi-session-refresh: renewed (" + since + ")" });
  expect(f.b.launches).toEqual([]);
  expect([r.probes, r.connects]).toEqual([1, 1]);
  expectOwnedOnly(r.cdp as FakeCdp, false);
  // The connect fails too: v0.3.0's browser_unavailable, still nothing launched or closed.
  const g = fakeBrowser({ running: true, unknownFor: 99 });
  const down = await run({ cfg: cfgL, probe: g.probe, launcher: g.launcher, cdp: "down" });
  expect(down.out).toEqual({
    code: 1,
    line: "xiaomi-session-refresh: browser_unavailable (DevTools endpoint unreachable; " + since + ")",
  });
  expect(g.b.launches).toEqual([]);
  expect([down.probes, down.connects]).toEqual([1, 1]);
  // Healthy runs and --check report it as not answering, without the launcher's --check.
  for (const check of [false, true]) {
    const h = fakeBrowser({ running: true, unknownFor: 99 });
    const x = await run({ cfg: cfgL, ssh: fakeSsh({ stdout: collector(null) }), probe: h.probe, launcher: h.launcher, flags: { check } });
    expect(x.out).toEqual(
      check
        ? { code: 0, line: "xiaomi-session-refresh: check: not_needed (collector ok; renewal browser not answering)" }
        : { code: 1, line: "xiaomi-session-refresh: browser_unavailable (renewal browser not answering; collector ok)" },
    );
    expect(h.b.launches).toEqual([]);
    expect([x.probes, x.connects]).toEqual([1, 0]);
    expect(x.written.map((w) => w.result)).toEqual(check ? [] : ["browser_unavailable"]);
  }
});

test("launch: launcher failure or a browser that never comes up is browser_unavailable", async () => {
  const cases: [lib.LocalResult | "unsafe", string][] = [
    [3, "launcher exit 3"],
    ["timeout", "launcher timed out"],
    ["unsafe", "launcher missing or unsafe"],
    ["failed", "launcher could not run"],
  ];
  for (const [start, why] of cases) {
    const f = fakeBrowser({ start });
    const r = await run({ cfg: cfgL, probe: f.probe, launcher: f.launcher });
    expect(r.out).toEqual({
      code: 1,
      line:
        "xiaomi-session-refresh: browser_unavailable (renewal browser could not be started (" +
        why +
        "); collector auth_required since " +
        REJECTED +
        ")",
    });
    expect(r.connects).toBe(0);
    expect(r.probes).toBe(1);
    expect((r.cdp as FakeCdp).sent).toEqual([]);
    expect(r.written.map((w) => w.result)).toEqual(["browser_unavailable"]);
  }
  // Started but the endpoint never answers within launchMs: one bounded close attempt.
  const f = fakeBrowser({ upAfter: null });
  const started = Date.now();
  const r = await run({ cfg: cfgL, probe: f.probe, launcher: f.launcher, cdp: "down", t: { ...T, launchMs: 1000 } });
  const took = Date.now() - started;
  expect(r.out).toEqual({
    code: 1,
    line:
      "xiaomi-session-refresh: browser_unavailable (renewal browser did not come up within 1 s; collector auth_required since " +
      REJECTED +
      ")",
  });
  expect(took).toBeGreaterThanOrEqual(1000);
  expect(took).toBeLessThan(1000 + T.browserCloseMs + 500);
  expect(r.probes).toBeGreaterThan(10);
  expect(r.connects).toBe(1);
  expect(r.written.map((w) => w.result)).toEqual(["browser_unavailable"]);
  // The launch wait never outlives the run deadline.
  const g = fakeBrowser({ upAfter: null });
  const tight = await run({ cfg: cfgL, probe: g.probe, launcher: g.launcher, cdp: "down", t: { ...T, runMs: 150, launchMs: 5000 } });
  expect(tight.out.line).toStartWith("xiaomi-session-refresh: error (run deadline exceeded;");
});

test("launch: only a browser this run started is ever closed", async () => {
  // Already running: no launch, no Browser.close.
  const f = fakeBrowser({ running: true });
  let r = await run({ cfg: cfgL, probe: f.probe, launcher: f.launcher });
  expect(r.out.code).toBe(0);
  expect(f.b.launches).toEqual([]);
  expect(r.probes).toBe(1);
  expectOwnedOnly(r.cdp as FakeCdp, false);
  // No launcher configured: v0.3.0, connect directly, no probe, nothing started or closed.
  r = await run({ cdp: "down", launcher: fakeBrowser().launcher });
  expect(r.out.line).toStartWith("xiaomi-session-refresh: browser_unavailable (DevTools endpoint unreachable;");
  expect([r.probes, r.connects]).toEqual([0, 1]);
  r = await run();
  expectOwnedOnly(r.cdp as FakeCdp, false);
  expect(r.probes).toBe(0);
  // Interrupted while waiting for a launched browser: nothing written, close attempted, no delay.
  const ac = new AbortController();
  const g = fakeBrowser({ upAfter: null, onStart: () => setTimeout(() => ac.abort(), 30) });
  const started = Date.now();
  r = await run({ cfg: cfgL, probe: g.probe, launcher: g.launcher, cdp: "down", signal: ac.signal, t: { ...T, launchMs: 5000 } });
  expect(r.out).toEqual({ code: 1, line: "xiaomi-session-refresh: interrupted" });
  expect(Date.now() - started).toBeLessThan(1000);
  expect(r.ssh.calls.map((c) => c.kind)).toEqual(["read"]);
  expect(r.connects).toBe(1);
});

test("early warning: healthy runs check the browser without a tab, cookie or Xiaomi request", async () => {
  const healthy = () => fakeSsh({ stdout: collector(null) });
  const cases: {
    name: string;
    cfg: lib.Config;
    browser: ReturnType<typeof fakeBrowser>;
    line: string;
    code: 0 | 1;
    result: string;
    launches: boolean[];
  }[] = [
    { name: "running", cfg, browser: fakeBrowser({ running: true }), line: "not_needed (collector ok)", code: 0, result: "not_needed", launches: [] },
    { name: "running, launcher set", cfg: cfgL, browser: fakeBrowser({ running: true }), line: "not_needed (collector ok)", code: 0, result: "not_needed", launches: [] },
    {
      name: "startable",
      cfg: cfgL,
      browser: fakeBrowser(),
      line: "not_needed (collector ok; renewal browser not running but can be started)",
      code: 0,
      result: "not_needed",
      launches: [true],
    },
    {
      name: "launcher check fails",
      cfg: cfgL,
      browser: fakeBrowser({ check: 1 }),
      line: "browser_unavailable (renewal browser not running and cannot be started; collector ok)",
      code: 1,
      result: "browser_unavailable",
      launches: [true],
    },
    {
      name: "launcher unsafe",
      cfg: cfgL,
      browser: fakeBrowser({ check: "unsafe" }),
      line: "browser_unavailable (renewal browser not running and cannot be started; collector ok)",
      code: 1,
      result: "browser_unavailable",
      launches: [true],
    },
    {
      name: "no launcher",
      cfg,
      browser: fakeBrowser(),
      line: "browser_unavailable (renewal browser not running; no launcher configured; collector ok)",
      code: 1,
      result: "browser_unavailable",
      launches: [],
    },
  ];
  for (const c of cases) {
    const r = await run({ cfg: c.cfg, ssh: healthy(), probe: c.browser.probe, launcher: c.browser.launcher });
    expect({ name: c.name, out: r.out }).toEqual({ name: c.name, out: { code: c.code, line: "xiaomi-session-refresh: " + c.line } });
    expect(c.browser.b.launches.map((l) => l.check)).toEqual(c.launches);
    expect(r.probes).toBe(1);
    expect(r.connects).toBe(0);
    expect((r.cdp as FakeCdp).sent).toEqual([]);
    expect(r.fetcher.calls).toEqual([]);
    expect(r.ssh.calls.map((x) => x.kind)).toEqual(["read", "status"]);
    expect(r.written).toEqual([
      {
        schemaVersion: 1,
        checkedAt: NOW.toISOString(),
        result: c.result,
        renewedAt: PREVIOUS,
        host: "laptop",
        manualCommand: ENV.XQ_MANUAL_COMMAND,
      } as never,
    ]);
  }
});

test("--check reports browser readiness and the missing-session short-circuit, writes nothing", async () => {
  const since = "collector auth_required since " + REJECTED;
  const cases: [lib.Config, ReturnType<typeof fakeBrowser>, string, Partial<lib.Flags>, string][] = [
    [cfg, fakeBrowser(), collector("auth_required"), {}, "renewal needed (" + since + "; renewal browser not running; no launcher configured)"],
    [cfgL, fakeBrowser(), collector("auth_required"), {}, "renewal needed (" + since + "; renewal browser not running but can be started)"],
    [cfgL, fakeBrowser({ check: 4 }), collector(null), {}, "not_needed (collector ok; renewal browser not running and cannot be started (launcher --check exit 4))"],
    [cfgL, fakeBrowser({ check: "timeout" }), collector(null), {}, "not_needed (collector ok; renewal browser not running and cannot be started (launcher timed out))"],
    [cfgL, fakeBrowser({ check: "unsafe" }), collector(null), {}, "not_needed (collector ok; renewal browser not running and cannot be started (launcher missing or unsafe))"],
    [
      cfg,
      fakeBrowser({ running: true }),
      withSession("auth_required", { state: "missing" }),
      {},
      "account_mismatch (installed session file missing or unusable; reinstall with --rebind; " + since + "; renewal browser running)",
    ],
    [cfg, fakeBrowser({ running: true }), withSession("auth_required", { state: "invalid_file" }), { rebind: true }, "renewal needed (rebind; " + since + "; renewal browser running)"],
  ];
  for (const [c, browser, stdout, flags, line] of cases) {
    const state = memState();
    const r = await run({ cfg: c, ssh: fakeSsh({ stdout }), probe: browser.probe, launcher: browser.launcher, flags: { check: true, ...flags }, state: state.store });
    expect(r.out).toEqual({ code: 0, line: "xiaomi-session-refresh: check: " + line });
    expect(r.ssh.calls.map((x) => x.kind)).toEqual(["read"]);
    expect(browser.b.launches.every((l) => l.check)).toBe(true);
    expect(r.connects).toBe(0);
    expect(state.saves).toEqual([]);
  }
});

test("missing or unusable installed session: account_mismatch without browser or Xiaomi unless --rebind", async () => {
  for (const sessionState of ["missing", "invalid_file"]) {
    const stdout = withSession("auth_required", { state: sessionState });
    const line =
      "xiaomi-session-refresh: account_mismatch (installed session file missing or unusable; reinstall with --rebind; ";
    for (const flags of [{}, { force: true }]) {
      const r = await run({ ssh: fakeSsh({ stdout }), flags, cfg: cfgL, launcher: fakeBrowser().launcher });
      expect(r.out.code).toBe(3);
      expect(r.out.line).toBe(line + ("force" in flags ? "forced; " : "") + "collector auth_required since " + REJECTED + ")");
      expect([r.connects, r.probes, r.fetcher.calls.length]).toEqual([0, 0, 0]);
      expect(r.written.map((w) => w.result)).toEqual(["account_mismatch"]);
    }
    // Acted on even if a collector reported the state with another error.
    const odd = await run({ ssh: fakeSsh({ stdout: withSession("unavailable", { state: sessionState }) }) });
    expect(odd.out.line).toBe(line + "collector unavailable)");
    // --rebind installs from the browser instead.
    const rebind = await run({ ssh: fakeSsh({ stdout }), flags: { rebind: true } });
    expect(rebind.out).toEqual({
      code: 0,
      line: "xiaomi-session-refresh: renewed (rebind; collector auth_required since " + REJECTED + ")",
    });
    expect(rebind.ssh.calls.map((x) => x.kind)).toEqual(["read", "rebind"]);
  }
});

test("vendor change: a loaded console with missing or rejected cookies is error, not signin_required", async () => {
  const since = "; collector auth_required since " + REJECTED + ")";
  const missing = jar().filter((c) => c.name !== "api-platform_ph");
  let state = memState();
  let r = await run({ cdp: new FakeCdp({ cookies: missing }), state: state.store });
  expect(r.out).toEqual({
    code: 1,
    line: "xiaomi-session-refresh: error (browser is signed in but the expected Xiaomi cookies are missing (vendor change?)" + since,
  });
  expect(r.fetcher.calls).toEqual([]);
  expect(r.written.map((w) => w.result)).toEqual(["error"]);
  expect(state.get()).toMatchObject({ last: "vendor_changed", count: 1 });
  for (const usage of [() => new Response(null, { status: 401 }), () => Response.json({ code: 403 })]) {
    state = memState();
    r = await run({ fetch: fakeFetch({ usage }), state: state.store });
    expect(r.out).toEqual({
      code: 1,
      line: "xiaomi-session-refresh: error (browser session works but the copied cookies were rejected (vendor change?)" + since,
    });
    expect(r.ssh.calls.map((x) => x.kind)).toEqual(["read", "status"]);
    expect(state.get().last).toBe("vendor_changed");
  }
  // Without a loaded console wait: v0.3.0 sign-in classification.
  r = await run({ cdp: new FakeCdp({ onNavigate: () => {}, cookies: missing }) });
  expect(r.out).toEqual({ code: 2, line: "xiaomi-session-refresh: signin_required (Xiaomi session cookie missing in browser" + since });
  r = await run({ cdp: new FakeCdp({ onNavigate: () => {} }), fetch: fakeFetch({ usage: () => new Response(null, { status: 401 }) }) });
  expect(r.out).toEqual({ code: 2, line: "xiaomi-session-refresh: signin_required (Xiaomi rejected the browser session" + since });
  r = await run({ cdp: signinCdp() });
  expect(r.out.code).toBe(2);
});

test("notifications: one per needs-a-person episode and change, one recovery, nothing while unchanged", async () => {
  const cfgN = lib.parseConfig({ ...ENV, XQ_NOTIFY: "desktop" }, "laptop");
  const sent: { urgency: string; title: string; body: string }[] = [];
  let deliver = true;
  const notify: lib.Notifier = async (urgency, title, body, ms) => {
    expect(ms).toBe(T.notifyMs);
    sent.push({ urgency, title, body });
    return deliver;
  };
  const state = memState();
  const go = (o: Parameters<typeof run>[0] = {}) => run({ cfg: cfgN, notify, state: state.store, ...o });
  // Enters an episode.
  let r = await go({ cdp: signinCdp() });
  expect(r.out.code).toBe(2);
  expect(sent).toEqual([
    {
      urgency: "critical",
      title: "Xiaomi sign-in needed",
      body: "Sign in at " + lib.CONSOLE_URL + " in the renewal browser, then " + MANUAL + ".",
    },
  ]);
  expect(state.get()).toMatchObject({ last: "signin_required", count: 1, notified: "signin_required" });
  // Same result again: nothing.
  r = await go({ cdp: signinCdp() });
  expect(sent.length).toBe(1);
  expect(state.get()).toMatchObject({ count: 2, notified: "signin_required" });
  // Changes to another needs-a-person result.
  r = await go({ cdp: "down" });
  expect(sent.length).toBe(2);
  expect(sent[1]).toMatchObject({ urgency: "critical", title: "Xiaomi renewal browser unavailable" });
  expect(sent[1].body).toContain("XQ_BROWSER_LAUNCH");
  // A transient failure neither notifies nor ends the episode.
  r = await go({ fetch: fakeFetch({ usage: () => new Response(null, { status: 503 }) }) });
  expect(r.out.line).toStartWith("xiaomi-session-refresh: vendor_unavailable");
  expect(sent.length).toBe(2);
  expect(state.get().notified).toBe("browser_unavailable");
  // Recovery, once.
  r = await go();
  expect(r.out.code).toBe(0);
  expect(sent[2]).toEqual({ urgency: "normal", title: "Xiaomi session renewal recovered", body: "The session was renewed." });
  expect(state.get().notified).toBeNull();
  r = await go({ ssh: fakeSsh({ stdout: collector(null) }) });
  expect(r.out.code).toBe(0);
  expect(sent.length).toBe(3);
  // Undelivered: noted in the line, retried by the next run.
  deliver = false;
  r = await go({ cdp: signinCdp() });
  expect(r.out.line).toEndWith(")" + "; desktop notification failed");
  expect(state.get().notified).toBeNull();
  deliver = true;
  r = await go({ cdp: signinCdp() });
  expect(r.out.line).not.toContain("notification");
  expect(sent.length).toBe(5);
  expect(state.get().notified).toBe("signin_required");
  // A healthy run that ends the episode: recovery mentions readiness.
  r = await go({ ssh: fakeSsh({ stdout: collector(null) }) });
  expect(sent[5]).toEqual({ urgency: "normal", title: "Xiaomi session renewal recovered", body: "No renewal needed; the renewal browser is ready." });
  // Vendor change and account mismatch carry their own next step.
  r = await go({ cdp: new FakeCdp({ cookies: [] }) });
  expect(sent[6]).toMatchObject({ urgency: "critical", title: "Xiaomi renewal: cookies not accepted (vendor change?)" });
  r = await go({ ssh: fakeSsh({ stdout: withSession("auth_required", { state: "missing" }) }) });
  expect(sent[7]).toMatchObject({ urgency: "critical", title: "Xiaomi renewal refused: account mismatch" });
  expect(sent[7].body).toContain("--rebind");
  for (const n of sent) expectNoLeak(n.title, n.body);
  // Disabled (XQ_NOTIFY unset): never called, the episode is not recorded.
  const off = memState();
  const before = sent.length;
  await run({ notify, state: off.store, cdp: signinCdp() });
  expect(sent.length).toBe(before);
  expect(off.get()).toMatchObject({ last: "signin_required", notified: null });
});

test("notice text: fixed wording, manual command escaped for notification markup", () => {
  expect(lib.notice("signin_required", "signin_required", null)).toBeNull();
  expect(lib.notice("vendor_unavailable", null, null)).toBeNull();
  expect(lib.notice("error", "signin_required", null)).toBeNull();
  expect(lib.notice("not_needed", null, null)).toBeNull();
  expect(lib.notice("renewed", "account_mismatch", null)).toMatchObject({ urgency: "normal", clears: true });
  expect(lib.notice("signin_required", null, null)!.body).toBe(
    "Sign in at " + lib.CONSOLE_URL + " in the renewal browser, then run the refresher by hand.",
  );
  expect(lib.notice("browser_unavailable", "signin_required", "run <x> & 'y'")!.body).toContain(
    'then run "run &lt;x&gt; &amp; \'y\'".',
  );
});

test("notify-send: direct argv, allowlisted environment, bounded; failures are false", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xq-notify-"));
  try {
    await writeFile(join(dir, "code"), "exit 0");
    await writeFile(
      join(dir, "notify-send"),
      `#!/bin/sh\nprintf '%s\\0' "$@" > "${dir}/argv"\nenv > "${dir}/env"\nexec sh -c "$(cat "${dir}/code")"\n`,
      { mode: 0o700 },
    );
    const n = lib.notifySend({
      env: {
        PATH: dir + ":" + process.env.PATH,
        HOME: dir,
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/synthetic/bus",
        LD_LIBRARY_PATH: "/synthetic/lib",
        XQ_SSH_TARGET: "user@collector.example",
      },
    });
    expect(await n("critical", "Synthetic title", "Synthetic body", 2000)).toBe(true);
    expect((await readFile(join(dir, "argv"), "utf8")).split("\0").slice(0, -1)).toEqual([
      "--app-name=xiaomi-session-refresh",
      "--urgency=critical",
      "Synthetic title",
      "Synthetic body",
    ]);
    const env = await readFile(join(dir, "env"), "utf8");
    expect(env).toContain("DBUS_SESSION_BUS_ADDRESS=unix:path=/synthetic/bus");
    expect(env).not.toContain("LD_LIBRARY_PATH");
    expect(env).not.toContain("XQ_");
    await writeFile(join(dir, "code"), "exit 1");
    expect(await n("normal", "t", "b", 2000)).toBe(false);
    await writeFile(join(dir, "code"), "exec sleep 10");
    const started = Date.now();
    expect(await n("normal", "t", "b", 200)).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await lib.notifySend({ env: { PATH: join(dir, "empty") } })("normal", "t", "b", 1000)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("probe: discovery endpoint only; up on 200, refused only when nothing listens", async () => {
  let status = 200,
    hang = false;
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      paths.push(new URL(request.url).pathname);
      if (hang) await Bun.sleep(2000);
      if (status === 302) return new Response(null, { status, headers: { location: "/json/version" } });
      return Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/x" }, { status });
    },
  });
  const origin = "http://127.0.0.1:" + server.port;
  try {
    expect(await lib.probeBrowser(origin, 1000)).toBe("up");
    expect(paths).toEqual(["/json/version"]);
    // Something answers, but not a browser ready for DevTools: never "stopped".
    for (status of [404, 500, 302]) expect(await lib.probeBrowser(origin, 1000)).toBe("unknown");
    status = 200;
    // Listening but too slow (a busy or still starting browser): unknown, not refused.
    hang = true;
    const started = Date.now();
    expect(await lib.probeBrowser(origin, 200)).toBe("unknown");
    expect(Date.now() - started).toBeLessThan(1500);
    const ac = new AbortController();
    ac.abort();
    hang = false;
    expect(await lib.probeBrowser(origin, 1000, { signal: ac.signal })).toBe("unknown");
  } finally {
    server.stop(true);
  }
  expect(await lib.probeBrowser(origin, 500)).toBe("refused");
  // Accepts the connection, then drops it: unknown.
  const reset = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => reset.listen(0, "127.0.0.1", resolve));
  try {
    const port = (reset.address() as { port: number }).port;
    expect(await lib.probeBrowser("http://127.0.0.1:" + port, 1000)).toBe("unknown");
  } finally {
    reset.close();
  }
  // Transport errors other than a refusal are unknown too.
  const fails = (code: unknown) => async () => {
    throw Object.assign(new Error("synthetic"), { code });
  };
  expect(await lib.probeBrowser(origin, 500, { fetch: fails("ECONNREFUSED") })).toBe("refused");
  expect(await lib.probeBrowser(origin, 500, { fetch: fails("ConnectionRefused") })).toBe("refused");
  for (const code of ["ECONNRESET", "ETIMEDOUT", 111, undefined])
    expect(await lib.probeBrowser(origin, 500, { fetch: fails(code) })).toBe("unknown");
});

test("backoff: timer runs wait 15, 30, 60, 60 min after repeated sign-in failures", async () => {
  const cfgT = { ...cfg, timerRun: true };
  const state = memState();
  let now = NOW;
  const at = (min: number) => new Date(NOW.getTime() + min * 60000);
  const hhmm = (min: number) => at(min).toISOString().slice(11, 16) + "Z";
  // [minute, attempts so far after the run, backed off until (minute) or null]
  const schedule: [number, number, number | null][] = [
    [0, 1, null],
    [5, 1, 15],
    [14, 1, 15],
    [15, 2, null],
    [44, 2, 45],
    [45, 3, null],
    [104, 3, 105],
    [105, 4, null],
    [164, 4, 165],
    [165, 5, null],
  ];
  for (const [minute, count, until] of schedule) {
    now = at(minute);
    const r = await run({ cfg: cfgT, state: state.store, cdp: signinCdp(), now: () => now });
    expect(r.out.code).toBe(2);
    if (until === null) {
      expect(r.connects).toBe(1);
      expect(r.out.line).toStartWith("xiaomi-session-refresh: signin_required (browser redirected to Xiaomi sign-in;");
      expect(state.get().attemptAt).toBe(now.toISOString());
    } else {
      expect(r.connects).toBe(0);
      expect(r.fetcher.calls).toEqual([]);
      expect(r.out.line).toBe(
        "xiaomi-session-refresh: signin_required (backing off until " + hhmm(until) + " after " + count +
          (count === 1 ? " attempt; " : " attempts; ") + MANUAL + " to retry now; collector auth_required since " + REJECTED + ")",
      );
    }
    // Fresh checkedAt, same result and advice; backed-off runs do not count as attempts.
    expect(r.written).toEqual([
      {
        schemaVersion: 1,
        checkedAt: now.toISOString(),
        result: "signin_required",
        renewedAt: PREVIOUS,
        host: "laptop",
        manualCommand: ENV.XQ_MANUAL_COMMAND,
      } as never,
    ]);
    expect(state.get()).toMatchObject({ last: "signin_required", count, attemptRejectedAt: REJECTED, attemptUpdatedAt: UPDATED });
  }
});

test("backoff bypasses: manual runs, --force, a changed collector session; only person-fixable results back off", async () => {
  const later = () => new Date(NOW.getTime() + 60000);
  const after = (last: lib.Kind, over: Partial<lib.RunState> = {}) =>
    memState({ last, count: 1, attemptAt: NOW.toISOString(), attemptRejectedAt: REJECTED, attemptUpdatedAt: UPDATED, ...over });
  const go = async (o: { last?: lib.Kind; over?: Partial<lib.RunState>; timer?: boolean; force?: boolean; stdout?: string }) => {
    const state = after(o.last ?? "signin_required", o.over);
    const r = await run({
      cfg: { ...cfg, timerRun: o.timer ?? true },
      state: state.store,
      now: later,
      flags: { force: o.force ?? false },
      ssh: fakeSsh({ stdout: o.stdout ?? collector("auth_required") }),
    });
    return { r, state };
  };
  let { r, state } = await go({});
  expect(r.connects).toBe(0);
  expect(state.saves.at(-1)).toMatchObject({ count: 1, attemptAt: NOW.toISOString() });
  for (const bypass of [
    { timer: false },
    { force: true },
    { stdout: withSession("auth_required", { rejectedAt: "2030-01-02T02:00:00.000Z" }) },
    { stdout: withSession("auth_required", { updatedAt: "2030-01-02T02:00:00.000Z" }) },
    { over: { attemptAt: "2030-01-02T04:00:00.000Z" } },
    { over: { attemptAt: null } },
  ]) {
    ({ r } = await go(bypass));
    expect({ bypass, connects: r.connects }).toEqual({ bypass, connects: 1 });
    expect(r.out.code).toBe(0);
  }
  ({ r } = await go({ last: "account_mismatch" }));
  expect(r.out.code).toBe(3);
  expect(r.out.line).toStartWith("xiaomi-session-refresh: account_mismatch (backing off until 03:19Z after 1 attempt;");
  expect(r.written.map((w) => w.result)).toEqual(["account_mismatch"]);
  ({ r } = await go({ last: "vendor_changed", over: { count: 2 } }));
  expect(r.out.code).toBe(1);
  expect(r.out.line).toStartWith(
    "xiaomi-session-refresh: error (vendor change suspected; backing off until 03:34Z after 2 attempts;",
  );
  expect(r.written.map((w) => w.result)).toEqual(["error"]);
  expect(r.connects).toBe(0);
  for (const last of ["browser_unavailable", "vendor_unavailable", "error", "not_needed", "renewed"] as const) {
    ({ r } = await go({ last }));
    expect({ last, connects: r.connects }).toEqual({ last, connects: 1 });
  }
  // Without a manual command the advice stays generic.
  const quiet = await run({ cfg: { ...cfg, timerRun: true, manualCommand: null }, state: after("signin_required").store, now: later });
  expect(quiet.out.line).toContain("; run the refresher by hand to retry now;");
});

test("state file: 0700 directory, 0600 file, atomic and strict; corrupt or unwritable state is never fatal", async () => {
  const root = await mkdtemp(join(tmpdir(), "xq-state-"));
  try {
    expect(lib.stateDir({ STATE_DIRECTORY: "/srv/state", XDG_STATE_HOME: "/x", HOME: "/h" })).toBe("/srv/state");
    expect(lib.stateDir({ STATE_DIRECTORY: "relative", XDG_STATE_HOME: "/x", HOME: "/h" })).toBe("/x/xiaomi-session-refresh");
    expect(lib.stateDir({ XDG_STATE_HOME: "rel", HOME: "/h" })).toBe("/h/.local/state/xiaomi-session-refresh");
    expect(lib.stateDir({})).toBeNull();
    const dir = join(root, "state", "xiaomi-session-refresh");
    const file = join(dir, "state.json");
    const store = lib.fileStateStore(dir);
    expect(store.load()).toEqual(lib.EMPTY_STATE);
    const s1: lib.RunState = {
      schemaVersion: 1,
      last: "vendor_changed",
      count: 2,
      attemptAt: NOW.toISOString(),
      attemptRejectedAt: REJECTED,
      attemptUpdatedAt: UPDATED,
      notified: "vendor_changed",
    };
    expect(store.save(s1)).toBe(true);
    expect(store.load()).toEqual(s1);
    expect(await modeOf(dir)).toBe(0o700);
    expect(await modeOf(file)).toBe(0o600);
    expect(await readdir(dir)).toEqual(["state.json"]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(s1);
    // An existing directory with group/world bits is tightened.
    await chmod(dir, 0o755);
    expect(store.save({ ...s1, count: 3 })).toBe(true);
    expect(await modeOf(dir)).toBe(0o700);
    const bad = [
      "not json",
      "{}",
      JSON.stringify({ ...s1, extra: 1 }),
      JSON.stringify({ ...s1, schemaVersion: 2 }),
      JSON.stringify({ ...s1, count: -1 }),
      JSON.stringify({ ...s1, count: 1.5 }),
      JSON.stringify({ ...s1, last: "bogus" }),
      JSON.stringify({ ...s1, notified: "renewed" }),
      JSON.stringify({ ...s1, attemptAt: "yesterday" }),
      JSON.stringify({ ...s1, attemptUpdatedAt: "2030-02-30T00:00:00Z" }),
      JSON.stringify(s1) + " ".repeat(5000),
      new Uint8Array([0x7b, 0xff, 0x7d]),
    ];
    for (const content of bad) {
      await writeFile(file, content, { mode: 0o600 });
      expect(store.load()).toEqual(lib.EMPTY_STATE);
    }
    await rm(file);
    await writeFile(join(root, "elsewhere.json"), JSON.stringify(s1));
    await symlink(join(root, "elsewhere.json"), file);
    expect(store.load()).toEqual(lib.EMPTY_STATE);
    await rm(file);
    await mkdir(file);
    expect(store.load()).toEqual(lib.EMPTY_STATE);
    expect(store.save(s1)).toBe(false);
    await rm(file, { recursive: true });
    // Unwritable directory: save reports false, nothing thrown, no leftovers.
    expect(store.save(s1)).toBe(true);
    await chmod(dir, 0o500);
    expect(store.save({ ...s1, count: 9 })).toBe(false);
    expect(store.load()).toEqual(s1);
    await chmod(dir, 0o700);
    expect(await readdir(dir)).toEqual(["state.json"]);
    expect(lib.fileStateStore(null).load()).toEqual(lib.EMPTY_STATE);
    expect(lib.fileStateStore(null).save(s1)).toBe(false);
    // Through a run: corrupt state is empty (no backoff), an unwritable one only adds a note.
    await writeFile(file, "{corrupt", { mode: 0o600 });
    let r = await run({ cfg: { ...cfg, timerRun: true }, state: store, cdp: signinCdp() });
    expect(r.connects).toBe(1);
    expect(store.load()).toMatchObject({ last: "signin_required", count: 1 });
    await chmod(dir, 0o500);
    r = await run({ state: store });
    expect(r.out).toEqual({
      code: 0,
      line: "xiaomi-session-refresh: renewed (collector auth_required since " + REJECTED + "); state not saved",
    });
    await chmod(dir, 0o700);
  } finally {
    await chmod(join(root, "state", "xiaomi-session-refresh"), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("run lock: one run at a time, released on any exit; --check needs no lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xq-lock-"));
  try {
    expect(lib.lockPath({ XDG_RUNTIME_DIR: "/run/user/1000" }, "/s")).toBe("/run/user/1000/xiaomi-session-refresh.lock");
    expect(lib.lockPath({ XDG_RUNTIME_DIR: "relative" }, "/s")).toBe("/s/run.lock");
    expect(lib.lockPath({}, null)).toBeNull();
    expect(lib.takeRunLock(null)).toBe("failed");
    const runtime = join(dir, "runtime");
    await mkdir(runtime, { mode: 0o700 });
    const path = lib.lockPath({ XDG_RUNTIME_DIR: runtime }, null)!;
    // A holder that dies by SIGKILL releases the lock.
    const holder = Bun.spawn(
      [process.execPath, "-e", `const l = await import(${JSON.stringify(join(import.meta.dir, "lib.ts"))}); console.log(l.takeRunLock(${JSON.stringify(path)})); await Bun.sleep(20000);`],
      { stdout: "pipe", stderr: "ignore" },
    );
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("held\n");
    expect(lib.takeRunLock(path)).toBe("busy");
    holder.kill("SIGKILL");
    await holder.exited;
    expect(lib.takeRunLock(path)).toBe("held");
    expect(await modeOf(path)).toBe(0o600);
    // This test process now holds it: the entrypoint is busy before any ssh call.
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) });
    try {
      await writeFile(join(dir, "ssh"), `#!/bin/sh\necho call >> "${dir}/calls"\ncat > /dev/null\nprintf '%s\\n' '${collector(null)}'\n`, { mode: 0o700 });
      const env = { PATH: dir + ":" + process.env.PATH, HOME: dir, XDG_RUNTIME_DIR: runtime, ...ENV, XQ_CDP_URL: "http://127.0.0.1:" + server.port };
      const spawn = (args: string[]) =>
        Bun.spawn([process.execPath, join(import.meta.dir, "refresh-session.ts"), ...args], { env, stdout: "pipe", stderr: "pipe" });
      let p = spawn([]);
      expect(await p.exited).toBe(1);
      expect(await new Response(p.stdout).text()).toBe("");
      expect(await new Response(p.stderr).text()).toBe("xiaomi-session-refresh: busy (another run is in progress)\n");
      expect(existsSync(join(dir, "calls"))).toBe(false);
      p = spawn(["--check"]);
      expect(await p.exited).toBe(0);
      // Something other than a DevTools endpoint answers the port (404): not a stopped browser.
      expect(await new Response(p.stdout).text()).toBe(
        "xiaomi-session-refresh: check: not_needed (collector ok; renewal browser not answering)\n",
      );
      expect(await readFile(join(dir, "calls"), "utf8")).toBe("call\n");
      expect(existsSync(join(dir, ".local", "state", "xiaomi-session-refresh", "state.json"))).toBe(false);
    } finally {
      server.stop(true);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

// A port nothing listens on, so the discovery probe is "refused" and the launcher's --check runs.
async function closedPort(): Promise<number> {
  const s = createServer();
  const port: number = await new Promise((resolve) =>
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port)),
  );
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

// The entrypoint must wire the real state store, launcher and notifier into runRefresh.
// Dropping any one of those lines leaves every injected-double test green, so exercise them
// through a full spawn: launcher --check, a 0600 state file, and one notify on browser_unavailable.
test("entrypoint: wires state store, launcher and notifier into a full run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xq-wire-"));
  try {
    const runtime = join(dir, "run");
    await mkdir(runtime);
    // Fake ssh: the status read (no 'sudo') prints a healthy collector; nothing is pushed.
    await writeFile(
      join(dir, "ssh"),
      `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '${collector(null)}'\n`,
      { mode: 0o700 },
    );
    // Launcher records its argv; --check exit code is read from $dir/check-exit (default 0).
    await writeFile(join(dir, "check-exit"), "0");
    const launcher = join(dir, "launch.sh");
    await writeFile(
      launcher,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/launch-argv"\n[ "$1" = --check ] && exit "$(cat "${dir}/check-exit")"\nexit 0\n`,
      { mode: 0o700 },
    );
    // notify-send stub on PATH records one line per call.
    await writeFile(
      join(dir, "notify-send"),
      `#!/bin/sh\necho notify >> "${dir}/notifies"\n`,
      { mode: 0o700 },
    );
    const stateFile = join(dir, ".local", "state", "xiaomi-session-refresh", "state.json");
    const env = {
      PATH: dir + ":" + process.env.PATH,
      HOME: dir,
      XDG_RUNTIME_DIR: runtime,
      ...ENV,
      XQ_CDP_URL: "http://127.0.0.1:" + (await closedPort()),
      XQ_BROWSER_LAUNCH: launcher,
      XQ_NOTIFY: "desktop",
    };
    const spawn = () =>
      Bun.spawn([process.execPath, join(import.meta.dir, "refresh-session.ts")], { env, stdout: "pipe", stderr: "pipe" });

    // Healthy collector, port refused, launcher --check exits 0: not_needed, browser startable.
    let p = spawn();
    expect(await p.exited).toBe(0);
    expect(await new Response(p.stdout).text()).toBe(
      "xiaomi-session-refresh: not_needed (collector ok; renewal browser not running but can be started)\n",
    );
    expect(await new Response(p.stderr).text()).toBe("");
    // Launcher was called, and only with --check (no bare start on a healthy run).
    expect((await readFile(join(dir, "launch-argv"), "utf8")).trim().split("\n")).toEqual(["--check"]);
    // State was written by fileStateStore, 0600, and parses.
    expect(await modeOf(stateFile)).toBe(0o600);
    expect(await modeOf(join(dir, ".local", "state", "xiaomi-session-refresh"))).toBe(0o700);
    expect(lib.parseState(await readFile(stateFile, "utf8"))!.last).toBe("not_needed");
    // not_needed is not a needs-a-person result: no notification.
    expect(existsSync(join(dir, "notifies"))).toBe(false);

    // Now --check fails: browser_unavailable, which needs a person, so exactly one notify fires.
    await writeFile(join(dir, "check-exit"), "4");
    p = spawn();
    expect(await p.exited).toBe(1);
    expect(await new Response(p.stdout).text()).toBe("");
    expect(await new Response(p.stderr).text()).toBe(
      "xiaomi-session-refresh: browser_unavailable (renewal browser not running and cannot be started; collector ok)\n",
    );
    expect(lib.parseState(await readFile(stateFile, "utf8"))!.notified).toBe("browser_unavailable");
    expect((await readFile(join(dir, "notifies"), "utf8")).trim().split("\n")).toEqual(["notify"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

test("remote writer: a rename between reading and sizing the installed session cannot fail push", async () => {
  await sessionDir(async (dir, root) => {
    const file = join(dir, "mimo_session");
    await writeFile(file, "api-platform_serviceToken=SYNTHETIC-old; userId=" + SECRETS.userId + "\n", { mode: 0o600 });
    // A concurrent writer renames a same-account session of another size into place
    // exactly when the writer asks for the size.
    const other = join(dir, ".concurrent");
    await writeFile(other, "a=SYNTHETIC-concurrent-and-longer; userId=" + SECRETS.userId + "\n", { mode: 0o600 });
    const bin = join(root, "bin");
    await mkdir(bin);
    const realStat = Bun.which("stat")!;
    await writeFile(
      join(bin, "stat"),
      `#!/bin/sh\ncase "$*" in *%s*) [ -e "${root}/renamed" ] || { mv -fT "${other}" "${file}"; : > "${root}/renamed"; } ;; esac\nexec ${realStat} "$@"\n`,
      { mode: 0o700 },
    );
    const p = Bun.spawn(["bash", "-c", lib.WRITE_SH, "xiaomi-session-write", dir, "push"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: bin + ":" + process.env.PATH, HOME: root },
    });
    p.stdin.write(HEADER + '\n{"schemaVersion":1}\n');
    await p.stdin.end();
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect({ code, out, err }).toEqual({ code: 0, out: "", err: "" });
    expect(existsSync(join(root, "renamed"))).toBe(true);
    expect(await readFile(file, "utf8")).toBe(HEADER + "\n");
    expect((await readdir(dir)).sort()).toEqual(["mimo_session", "renewal-status.json"]);
  });
});

test("unit: TimeoutStartSec covers the deadline and every bounded step after it", async () => {
  const unit = await readFile(join(import.meta.dir, "systemd", "xiaomi-session-refresh.service"), "utf8");
  const lines = unit.split("\n").filter((l) => !l.startsWith("#"));
  const timeout = lines.filter((l) => l.startsWith("TimeoutStartSec="));
  expect(timeout.length).toBe(1);
  const seconds = Number(timeout[0].slice("TimeoutStartSec=".length));
  expect(Number.isInteger(seconds)).toBe(true);
  const d = lib.DEFAULT_TIMEOUTS;
  expect(d.runMs).toBe(120000);
  expect(lib.worstCaseMs(d)).toBe(d.runMs + d.closeMs + d.browserCloseMs + d.writeSshMs + d.notifyMs);
  // Margin for start-up, the lock and the state write.
  expect(seconds * 1000 - lib.worstCaseMs(d)).toBeGreaterThanOrEqual(15000);
  // A launch fits the deadline together with the steps before the browser.
  expect(d.statusSshMs + d.connectMs + d.launcherMs + d.launchMs + d.connectMs).toBeLessThan(d.runMs);
  expect([d.launcherMs, d.launchMs, d.browserCloseMs, d.notifyMs, d.pollMs]).toEqual([5000, 20000, 3000, 5000, 250]);
  for (const line of ["Type=oneshot", "StateDirectory=xiaomi-session-refresh", "StateDirectoryMode=0700", "NoNewPrivileges=yes"])
    expect(lines).toContain(line);
  expect(lines.find((l) => l.startsWith("ExecStart="))).not.toMatch(/--rebind|--force/);
});

const EXAMPLE = join(import.meta.dir, "examples", "launch-browser-hyprland.sh");
const CHROME =
  "/usr/bin/google-chrome-stable --user-data-dir=/home/user/.config/xq-renewal --remote-debugging-address=127.0.0.1 --remote-debugging-port=9290 --class=xq-renewal";
test("example launcher: exact Hyprland dispatch, Exec-line sanitizing and --check, without Hyprland", async () => {
  const root = await mkdtemp(join(tmpdir(), "xq-hypr-"));
  try {
    const bin = join(root, "bin"),
      apps = join(root, "data", "applications"),
      calls = join(root, "calls");
    await mkdir(bin);
    await mkdir(apps, { recursive: true });
    await mkdir(calls);
    await writeFile(
      join(bin, "hyprctl"),
      `#!/bin/sh\nn=$(ls "${calls}" | wc -l)\nprintf '%s\\0' "$@" > "${calls}/$n"\n` +
        `case $1 in version) exit "$(cat "${root}/version-rc")" ;; dispatch) cat "${root}/dispatch-out"; exit "$(cat "${root}/dispatch-rc")" ;; esac\nexit 9\n`,
      { mode: 0o700 },
    );
    const reset = async (o: { version?: string; out?: string; rc?: string } = {}) => {
      await rm(calls, { recursive: true, force: true });
      await mkdir(calls);
      await writeFile(join(root, "version-rc"), o.version ?? "0");
      await writeFile(join(root, "dispatch-out"), o.out ?? "ok\n");
      await writeFile(join(root, "dispatch-rc"), o.rc ?? "0");
    };
    const recorded = async () =>
      Promise.all(
        (await readdir(calls)).sort().map(async (f) => (await readFile(join(calls, f), "utf8")).split("\0").slice(0, -1)),
      );
    const entry = (exec: string, extra = "") =>
      writeFile(
        join(apps, "google-chrome-agents.desktop"),
        "[Desktop Entry]\nType=Application\nName=Synthetic renewal browser\n#Exec=/usr/bin/commented-out\n" +
          exec +
          "\nTerminal=false\n" +
          extra +
          "\n[Desktop Action new-window]\nName=New Window\nExec=/usr/bin/other-browser ; id\n",
      );
    const env = { PATH: bin + ":/usr/bin:/bin", HOME: root, XDG_DATA_HOME: join(root, "data") };
    const sh = async (args: string[], e: Record<string, string> = env) => {
      const p = Bun.spawn([EXAMPLE, ...args], { env: e, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      return { code: await p.exited, out: await new Response(p.stdout).text() };
    };
    const dispatch = ['hl.dsp.exec_cmd("' + CHROME + '", { workspace = "special:xiaomi-renewal silent" })'];
    await reset();
    await entry("Exec=" + CHROME + "  %U");
    expect(await sh([])).toEqual({ code: 0, out: "" });
    expect(await recorded()).toEqual([["dispatch", ...dispatch]]);
    await reset();
    expect(await sh(["--check"])).toEqual({ code: 0, out: "" });
    expect(await recorded()).toEqual([["version"]]);
    // Field codes anywhere are dropped; whitespace collapses.
    await reset();
    await entry("Exec=/usr/bin/google-chrome-stable\t%F  --user-data-dir=/home/user/p --class=xq-renewal %u");
    expect((await sh([])).code).toBe(0);
    expect(await recorded()).toEqual([
      [
        "dispatch",
        'hl.dsp.exec_cmd("/usr/bin/google-chrome-stable --user-data-dir=/home/user/p --class=xq-renewal", { workspace = "special:xiaomi-renewal silent" })',
      ],
    ]);
    // Hyprland must say "ok", and must be reachable for --check.
    for (const o of [{ out: "error: bad dispatch\n" }, { rc: "1" }, { out: "" }]) {
      await reset(o);
      await entry("Exec=" + CHROME + " %U");
      expect((await sh([])).code).not.toBe(0);
    }
    await reset({ version: "1" });
    expect((await sh(["--check"])).code).not.toBe(0);
    // Refused Exec lines: never dispatched, and --check says a start is impossible.
    for (const exec of [
      "Exec=/usr/bin/chrome; id",
      "Exec=/usr/bin/chrome $(id)",
      'Exec=/usr/bin/chrome "--x"',
      "Exec=/usr/bin/chrome '--x'",
      "Exec=/usr/bin/chrome `id`",
      "Exec=/usr/bin/chrome a\\\\b",
      "Exec=/usr/bin/chrome %%",
      "Exec=/usr/bin/chrome a&b",
      "Exec=/usr/bin/chrome a|b",
      "Exec=/usr/bin/chrome ~/x",
      'Exec=chrome") os.execute("id',
      "Exec=",
      "Exec=%U",
      "Name=No Exec in the main group",
      // The profile must be named, absolutely (the last --user-data-dir counts, as in Chrome).
      "Exec=/usr/bin/chrome --class=xq-renewal",
      "Exec=/usr/bin/chrome --user-data-dir=relative/p",
      "Exec=/usr/bin/chrome --user-data-dir=",
      "Exec=/usr/bin/chrome --user-data-dir=/",
      "Exec=/usr/bin/chrome --user-data-dir=/home/user/p --user-data-dir=relative/p",
      "Exec=/usr/bin/chrome --user-data-dir /home/user/p",
    ]) {
      await reset();
      await entry(exec);
      expect({ exec, code: (await sh([])).code === 0 }).toEqual({ exec, code: false });
      expect({ exec, code: (await sh(["--check"])).code === 0 }).toEqual({ exec, code: false });
      expect((await recorded()).filter((c) => c[0] === "dispatch")).toEqual([]);
    }
    // A valid Exec in a [Desktop Action] group, but none in [Desktop Entry], must be
    // ignored: only the main group's Exec is read. (Without the group restriction a
    // first-match grep would dispatch the action's command.)
    await reset();
    await writeFile(
      join(apps, "google-chrome-agents.desktop"),
      "[Desktop Entry]\nType=Application\nName=No main Exec\n#Exec=/usr/bin/commented-out\n" +
        "[Desktop Action new-window]\nName=New Window\n" +
        "Exec=/usr/bin/action-browser --user-data-dir=/home/user/p --class=xq-renewal\n",
    );
    expect((await sh([])).code === 0).toBe(false);
    expect((await sh(["--check"])).code === 0).toBe(false);
    expect((await recorded()).filter((c) => c[0] === "dispatch")).toEqual([]);
    // Missing entry; bad arguments.
    await reset();
    await rm(join(apps, "google-chrome-agents.desktop"));
    expect((await sh(["--check"])).code).not.toBe(0);
    expect((await sh([])).code).not.toBe(0);
    await entry("Exec=" + CHROME);
    expect((await sh(["--check", "extra"])).code).toBe(2);
    expect((await sh(["--start"])).code).toBe(2);
    expect((await sh([""])).code).toBe(2);
    // Without XDG_DATA_HOME the entry is read from ~/.local/share/applications.
    await reset();
    await mkdir(join(root, ".local", "share", "applications"), { recursive: true });
    await writeFile(
      join(root, ".local", "share", "applications", "google-chrome-agents.desktop"),
      "[Desktop Entry]\nExec=/usr/bin/fallback-browser --user-data-dir=/home/user/p --x=1\n",
    );
    expect((await sh([], { PATH: env.PATH, HOME: root })).code).toBe(0);
    expect(await recorded()).toEqual([
      [
        "dispatch",
        'hl.dsp.exec_cmd("/usr/bin/fallback-browser --user-data-dir=/home/user/p --x=1", { workspace = "special:xiaomi-renewal silent" })',
      ],
    ]);
    // Through the refresher's own runner (use-time checks and env allowlist).
    await reset();
    const copy = join(root, "launch-browser-hyprland.sh");
    await writeFile(copy, await readFile(EXAMPLE));
    await chmod(copy, 0o700);
    const launch = lib.launcherRunner(copy, { env: { ...env, LD_LIBRARY_PATH: "/synthetic/lib" } });
    expect(await launch(true, 5000)).toBe(0);
    expect(await launch(false, 5000)).toBe(0);
    expect(await recorded()).toEqual([["version"], ["dispatch", ...dispatch]]);
    // A profile already in use (its SingletonLock names a live process on this host, as
    // while Chrome starts or runs): exit 3 in both modes and nothing dispatched, so a
    // running browser never receives the start and is never closed as this run's own.
    const profile = join(root, "profile");
    await mkdir(profile);
    const own = "/usr/bin/google-chrome-stable --user-data-dir=" + profile + " --remote-debugging-port=9290";
    await entry("Exec=" + own + " %U");
    const lock = join(profile, "SingletonLock");
    for (const [target, inUse] of [
      [hostname() + "-" + process.pid, true],
      ["other-host.example-" + process.pid, true],
      ["unparsable", true],
      [hostname() + "-", true],
      // The process is gone: a stale lock that Chrome itself replaces.
      [hostname() + "-2147483646", false],
      [null, false],
    ] as const) {
      await reset();
      await rm(lock, { force: true });
      if (target !== null) await symlink(target, lock);
      const check = await sh(["--check"]),
        start = await sh([]);
      expect({ target, check: check.code, start: start.code }).toEqual({
        target,
        check: inUse ? 3 : 0,
        start: inUse ? 3 : 0,
      });
      expect(await recorded()).toEqual(
        inUse
          ? []
          : [
              ["version"],
              ["dispatch", 'hl.dsp.exec_cmd("' + own + '", { workspace = "special:xiaomi-renewal silent" })'],
            ],
      );
    }
    // Through the refresher's runner the start is refused the same way.
    await reset();
    await rm(lock, { force: true });
    await symlink(hostname() + "-" + process.pid, lock);
    expect(await launch(true, 5000)).toBe(3);
    expect(await launch(false, 5000)).toBe(3);
    expect(await recorded()).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("example launcher: shipped executable, POSIX sh syntax", async () => {
  expect((await lstat(EXAMPLE)).mode & 0o111).not.toBe(0);
  const text = await readFile(EXAMPLE, "utf8");
  expect(text).toStartWith("#!/bin/sh\n");
  expect(text).toContain("id=google-chrome-agents\n");
  for (const shell of ["sh", "dash", "bash"]) {
    const path = Bun.which(shell);
    if (!path) continue;
    const p = Bun.spawn([path, "-n", EXAMPLE], { stdout: "pipe", stderr: "pipe" });
    expect({ shell, code: await p.exited }).toEqual({ shell, code: 0 });
  }
});
