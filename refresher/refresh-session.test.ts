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
import { tmpdir } from "node:os";
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
  XQ_SSH_TARGET: "tim@collector.example",
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
  runMs: 5000,
  closeMs: 500,
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

const collector = (error: string | null, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    error,
    stale: error !== null,
    fetchedAt: "2030-01-02T00:55:00.000Z",
    session: {
      state: error === "auth_required" ? "expired" : "ok",
      updatedAt: "2030-01-01T00:00:00.000Z",
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
  o: { stdout?: string; read?: number; write?: number; push?: number; throws?: boolean } = {},
) {
  const calls: SshCall[] = [];
  const run: lib.SshRunner = async (argv, stdin, timeoutMs) => {
    const kind = kindOf(argv[argv.length - 1]);
    calls.push({ argv: [...argv], stdin, kind, timeoutMs });
    if (o.throws) throw new Error("synthetic spawn failure");
    if (kind === "read")
      return { code: o.read ?? 0, stdout: o.stdout ?? collector("auth_required") };
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
}
class FakeCdp implements lib.CdpClient {
  sent: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  timing: { method: string; ms?: number; at: number }[] = [];
  socketClosed = false;
  ready = false;
  private listeners = new Set<(e: lib.CdpEvent) => void>();
  private markClosed!: () => void;
  readonly closed = new Promise<void>((resolve) => (this.markClosed = resolve));
  constructor(private script: Script = {}) {}
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
// The run may only touch the target it created, and must always close it.
function expectOwnedOnly(cdp: FakeCdp) {
  // No Network.enable: the network event stream would carry account-host cookie headers.
  const allowed = [
    "Target.createTarget",
    "Target.attachToTarget",
    "Page.enable",
    "Page.navigate",
    "Runtime.evaluate",
    "Network.getCookies",
    "Target.closeTarget",
  ];
  expect(cdp.sent[0]).toEqual({
    method: "Target.createTarget",
    params: { url: "about:blank", background: true },
    sessionId: undefined,
  });
  for (const s of cdp.sent) {
    expect(allowed).toContain(s.method);
    if ("targetId" in s.params) expect(s.params.targetId).toBe("T-OWNED");
    if (s.method.startsWith("Target.")) expect(s.sessionId).toBeUndefined();
    else expect(s.sessionId).toBe("S-OWNED");
    if (s.method === "Page.navigate") expect(s.params).toEqual({ url: lib.CONSOLE_URL });
    if (s.method === "Network.getCookies") expect(s.params).toEqual({ urls: [lib.USAGE_URL] });
    if (s.method === "Runtime.evaluate")
      expect(s.params).toEqual({ expression: lib.READY_JS, returnByValue: true });
  }
  expect(cdp.sent.filter((s) => s.method === "Target.closeTarget")).toEqual([
    { method: "Target.closeTarget", params: { targetId: "T-OWNED" }, sessionId: undefined },
  ]);
  expect(cdp.sent.at(-1)?.method).toBe("Target.closeTarget");
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
  } = {},
) {
  const ssh = o.ssh ?? fakeSsh();
  const cdp = o.cdp ?? new FakeCdp();
  const fetcher = o.fetch ?? fakeFetch();
  const t = o.t ?? T;
  let connects = 0;
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
        return cdp;
      },
      fetch: fetcher.f,
      now: () => NOW,
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
  return { out, ssh, cdp, fetcher, connects, written };
}

test("config: defaults, loopback CDP forms and hostname-derived label", () => {
  expect(cfg).toEqual({
    cdpOrigin: "http://127.0.0.1:9223",
    sshTarget: "tim@collector.example",
    remoteDir: "/srv/xiaomi-quota/session",
    container: "xiaomi-quota",
    hostLabel: "laptop",
    manualCommand: "systemctl --user start xiaomi-session-refresh.service",
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
      "http://192.168.55.100:9223",
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
      "tim@-oProxyCommand",
      "tim@host;id",
      "tim@host id",
      "$(id)@host",
      "tim@host\nid",
      "@host",
      "tim@",
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
  expect(lib.sshArgv("tim@collector.example", "true").slice(-3)).toEqual([
    "--",
    "tim@collector.example",
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
        XQ_SSH_TARGET: "tim@collector.example",
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
  });
  expect(
    lib.parseCollectorStatus('{"error":"unavailable","stale":true,"fetchedAt":null}\n'),
  ).toEqual({ error: "unavailable", rejectedAt: null, renewedAt: null });
  expect(
    lib.parseCollectorStatus(
      collector("auth_required", {
        session: { rejectedAt: "2030-02-30T00:00:00Z" },
        renewal: { renewedAt: "yesterday" },
      }),
    ),
  ).toEqual({ error: "auth_required", rejectedAt: null, renewedAt: null });
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
    [collector("auth_required"), {}, "check: renewal needed (collector auth_required since " + REJECTED + ")"],
    [collector(null), {}, "check: not_needed (collector ok)"],
    [collector(null), { force: true }, "check: renewal needed (forced; collector ok)"],
    ['{"error":"auth_required","stale":true,"fetchedAt":null}', {}, "check: renewal needed (collector auth_required)"],
  ];
  for (const [stdout, flags, line] of cases) {
    const r = await run({ ssh: fakeSsh({ stdout }), flags: { check: true, ...flags } });
    expect(r.out).toEqual({ code: 0, line: "xiaomi-session-refresh: " + line });
    expect(r.ssh.calls.map((c) => c.kind)).toEqual(["read"]);
    expect(r.connects).toBe(0);
    expect(r.fetcher.calls).toEqual([]);
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
    { name: "missing cookie", cdp: new FakeCdp({ cookies: jar().filter((c) => c.name !== "api-platform_slh") }), result: "signin_required", code: 2, reason: "Xiaomi session cookie missing in browser" },
    { name: "duplicate cookie", cdp: new FakeCdp({ cookies: jar([{ name: "api-platform_ph", value: "SYNTHETIC-dup", domain: ".xiaomimimo.com" }]) }), result: "error", code: 1, reason: "duplicate Xiaomi session cookie" },
    { name: "validation 403", fetch: fakeFetch({ detail: () => new Response(null, { status: 403 }) }), result: "signin_required", code: 2, reason: "Xiaomi rejected the browser session" },
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
test("collector unreachable: one line, exit 1, no status write or browser", async () => {
  for (const ssh of [
    fakeSsh({ read: 255 }),
    fakeSsh({ read: 1, stdout: collector(null) }),
    fakeSsh({ stdout: "Error: no such container" }),
    fakeSsh({ stdout: collector("expired") }),
    fakeSsh({ throws: true }),
  ]) {
    const r = await run({ ssh });
    expect(r.out).toEqual({ code: 1, line: "xiaomi-session-refresh: collector_unreachable" });
    expect(r.ssh.calls.map((c) => c.kind)).toEqual(["read"]);
    expect(r.connects).toBe(0);
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
    cdp: new FakeCdp({ cookies: [] }),
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
    for (const [args, env, message] of [
      [["--bogus"], ENV, "usage:"],
      [[], { ...ENV, XQ_SSH_TARGET: "tim@host;id" }, "XQ_SSH_TARGET"],
      [[], { ...ENV, XQ_CDP_URL: "http://192.168.55.100:9223" }, "XQ_CDP_URL"],
      [["--check"], { XQ_REMOTE_DIR: "/srv/x" }, "XQ_SSH_TARGET"],
    ] as const) {
      const p = Bun.spawn([process.execPath, join(import.meta.dir, "refresh-session.ts"), ...args], {
        env: { PATH: process.env.PATH!, HOME: home, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await p.exited).toBe(1);
      expect(await new Response(p.stdout).text()).toBe("");
      const err = await new Response(p.stderr).text();
      expect(err).toStartWith("xiaomi-session-refresh: invalid configuration: ");
      expect(err).toContain(message);
      expect(err.trim().split("\n").length).toBe(1);
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
    expect(check.out.line).toBe("xiaomi-session-refresh: check: renewal needed (rebind; collector auth_required since " + REJECTED + ")");
    expect(check.ssh.calls.map((x) => x.kind)).toEqual(["read"]);
  });
}, 30000);

test("spawn runner: stdout over 64 KiB kills ssh at once instead of buffering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xq-flood-"));
  try {
    const flood = join(dir, "flood");
    await writeFile(flood, `#!/bin/sh\necho $$ > "${dir}/pid"\nhead -c 4000000 /dev/zero\nexec sleep 30\n`, { mode: 0o700 });
    const started = Date.now();
    expect(await lib.spawnRunner({ binary: flood })(["ssh"], null, 10000)).toEqual({ code: 1, stdout: "" });
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
