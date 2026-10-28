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
  navigationMs: 200,
  signinGraceMs: 50,
  vendorMs: 1000,
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
  kind: "read" | "push" | "status";
}
function fakeSsh(
  o: { stdout?: string; read?: number; write?: number; push?: number; throws?: boolean } = {},
) {
  const calls: SshCall[] = [];
  const run: lib.SshRunner = async (argv, stdin) => {
    const command = argv[argv.length - 1];
    const kind = command.startsWith("'sudo'")
      ? "read"
      : command.endsWith("'push'")
        ? "push"
        : "status";
    calls.push({ argv: [...argv], stdin, kind });
    if (o.throws) throw new Error("synthetic spawn failure");
    if (kind === "read")
      return { code: o.read ?? 0, stdout: o.stdout ?? collector("auth_required") };
    return { code: (kind === "push" ? o.push : o.write) ?? 0, stdout: "" };
  };
  return { run, calls };
}

type Emit = (e: lib.CdpEvent) => void;
const doc = (url: string, frameId = "T-OWNED", sessionId = "S-OWNED"): lib.CdpEvent => ({
  method: "Network.responseReceived",
  sessionId,
  params: { type: "Document", frameId, response: { url, status: 200 } },
});
const usage = (status = 200, sessionId = "S-OWNED"): lib.CdpEvent => ({
  method: "Network.responseReceived",
  sessionId,
  params: { type: "XHR", frameId: "T-OWNED", response: { url: lib.USAGE_URL, status } },
});
const loads = (emit: Emit) => {
  emit(doc(CONSOLE_DOC));
  emit(usage());
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
}
class FakeCdp implements lib.CdpClient {
  sent: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  socketClosed = false;
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
  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    this.sent.push({ method, params, sessionId });
    if (this.script.failOn === method) throw new Error("synthetic cdp failure");
    switch (method) {
      case "Target.createTarget":
        return { targetId: "T-OWNED" };
      case "Target.attachToTarget":
        return { sessionId: "S-OWNED" };
      case "Network.enable":
      case "Target.closeTarget":
        return {};
      case "Page.navigate":
        setTimeout(() => (this.script.onNavigate ?? loads)(this.emit, this), 1);
        return this.script.navigate ?? { frameId: "T-OWNED", loaderId: "L-1" };
      case "Network.getCookies":
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
  const allowed = [
    "Target.createTarget",
    "Target.attachToTarget",
    "Network.enable",
    "Page.navigate",
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
  } = {},
) {
  const ssh = o.ssh ?? fakeSsh();
  const cdp = o.cdp ?? new FakeCdp();
  const fetcher = o.fetch ?? fakeFetch();
  let connects = 0;
  const out = await lib.runRefresh(
    cfg,
    { force: false, check: false, ...o.flags },
    {
      ssh: ssh.run,
      connectBrowser: async (origin) => {
        connects++;
        expect(origin).toBe("http://127.0.0.1:9223");
        if (cdp === "down") throw new lib.BrowserUnavailable();
        return cdp;
      },
      fetch: fetcher.f,
      now: () => NOW,
    },
    T,
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
    if (call.kind !== "push") expectNoLeak(call.stdin);
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
test("flags: --check and --force only", () => {
  expect(lib.parseArgs([])).toEqual({ force: false, check: false });
  expect(lib.parseArgs(["--check", "--force"])).toEqual({ force: true, check: true });
  for (const arg of ["--help", "-f", "force", "--check=1"])
    expect(() => lib.parseArgs([arg])).toThrow(/usage/);
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
  for (const dir of ["/a/../b", "/x;id", "rel"])
    expect(() => lib.writeCommand(dir, "push")).toThrow(lib.ConfigError);
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
const remote = (dir: string, mode: "push" | "status", stdin: string) =>
  sh(lib.writeCommand(dir, mode), stdin);
const modeOf = async (p: string) => (await lstat(p)).mode & 0o777;
test("remote writer: atomic owner-only replace with stdin framing and no leftovers", async () => {
  await sessionDir(async (dir) => {
    const status = '{"schemaVersion":1}';
    expect(await remote(dir, "push", HEADER + "\n" + status + "\n")).toEqual({ code: 0, stdout: "" });
    expect(await readFile(join(dir, "mimo_session"), "utf8")).toBe(HEADER + "\n");
    expect(await readFile(join(dir, "renewal-status.json"), "utf8")).toBe(status + "\n");
    expect(await modeOf(join(dir, "mimo_session"))).toBe(0o600);
    expect(await modeOf(join(dir, "renewal-status.json"))).toBe(0o600);
    const before = (await lstat(join(dir, "mimo_session"))).ino;
    expect((await remote(dir, "push", "next=SYNTHETIC-2\n" + status + "\n")).code).toBe(0);
    expect((await lstat(join(dir, "mimo_session"))).ino).not.toBe(before);
    expect(await readFile(join(dir, "mimo_session"), "utf8")).toBe("next=SYNTHETIC-2\n");
    // Status-only mode leaves the session untouched and treats all stdin as status.
    expect((await remote(dir, "status", '{"heartbeat":1}\n')).code).toBe(0);
    expect(await readFile(join(dir, "mimo_session"), "utf8")).toBe("next=SYNTHETIC-2\n");
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
      onNavigate: (emit) => emit(doc("https://account.xiaomi.com/fe/service/login?sid=synthetic")),
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
      onNavigate: (emit) => {
        emit(doc("https://account.xiaomi.com/pass/serviceLogin?sid=synthetic"));
        setTimeout(() => emit(doc(CONSOLE_DOC)), 10);
        setTimeout(() => emit(usage()), 100);
      },
    }),
  });
  expect(r.out.code).toBe(0);
  expect(r.out.line).toStartWith("xiaomi-session-refresh: renewed");
  expectOwnedOnly(r.cdp as FakeCdp);
});
test("foreign targets and sessions are ignored; timeout still validates cookies", async () => {
  const started = Date.now();
  const r = await run({
    cdp: new FakeCdp({
      onNavigate: (emit) => {
        emit(usage(200, "S-USER"));
        emit(doc("https://account.xiaomi.com/fe/service/login", "T-USER", "S-USER"));
        emit({ method: "Target.targetDestroyed", params: { targetId: "T-USER" } });
        emit({ method: "Target.detachedFromTarget", params: { sessionId: "S-USER" } });
        emit(usage(401));
      },
    }),
  });
  expect(Date.now() - started).toBeGreaterThanOrEqual(T.navigationMs - 20);
  expect(r.out.code).toBe(0);
  expectOwnedOnly(r.cdp as FakeCdp);
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
    { name: "enable throws", cdp: new FakeCdp({ failOn: "Network.enable" }), result: "error", code: 1, reason: "browser automation failed" },
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
      for (const e of [doc(CONSOLE_DOC), usage()]) emit(e);
      return reply({ frameId: "T-OWNED", loaderId: "L-1" });
    }
    if (m.method === "Network.getCookies") return reply({ cookies: jar() });
    reply({});
  });
  try {
    const ssh = fakeSsh();
    const fetcher = fakeFetch();
    const out = await lib.runRefresh(
      { ...cfg, cdpOrigin: fake.origin },
      { force: false, check: false },
      { ssh: ssh.run, connectBrowser: (o) => lib.connectBrowser(o), fetch: fetcher.f, now: () => NOW },
      T,
    );
    expect(out.code).toBe(0);
    expect(ssh.calls[1].stdin!.split("\n")[0]).toBe(HEADER);
    expect(fake.seen.map((m) => [m.method, m.sessionId ?? null])).toEqual([
      ["Target.createTarget", null],
      ["Target.attachToTarget", null],
      ["Network.enable", "S-OWNED"],
      ["Page.navigate", "S-OWNED"],
      ["Network.getCookies", "S-OWNED"],
      ["Target.closeTarget", null],
    ]);
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
