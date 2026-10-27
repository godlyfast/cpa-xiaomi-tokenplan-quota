import { mkdir, mkdtemp, copyFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (Bun.version !== "1.3.14")
  throw new Error("Run with Bun 1.3.14 (packageManager pin).");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pins = await Bun.file(join(root, "upstream.json")).json();
await mkdir(join(root, ".build"), { recursive: true });
const work = await mkdtemp(join(root, ".build", "panel-"));
const logs = join(work, "logs");
await mkdir(logs);
const cleanEnv = {
  PATH: process.env.PATH!,
  HOME: process.env.HOME!,
  LANG: "C.UTF-8",
  TZ: "UTC",
  CI: "true",
  VERSION: "v1.26.7-xiaomi.0.1.0",
};
async function run(name: string, cmd: string[], allowedFailure = false) {
  const result = Bun.spawnSync(cmd, {
    cwd: work,
    env: cleanEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const log = result.stdout.toString() + result.stderr.toString();
  await Bun.write(join(logs, name + ".log"), log);
  if (result.exitCode !== 0 && !allowedFailure)
    throw new Error(name + " failed; see " + join(logs, name + ".log"));
  return { exitCode: result.exitCode, log };
}
function failures(log: string): string[] {
  return [
    ...new Set(
      [...log.matchAll(/^\(fail\) (.+?)(?: \[[^\]]+\])?$/gm)].map((m) => m[1]),
    ),
  ].sort();
}
function passes(log: string): number {
  return Number(log.match(/\n\s*(\d+) pass\n/)?.[1] ?? NaN);
}
await run("init", ["git", "init"]);
await run("remote", ["git", "remote", "add", "origin", pins.panel.repository]);
await run("fetch", [
  "git",
  "fetch",
  "--depth",
  "1",
  "origin",
  pins.panel.commit,
]);
await run("checkout", ["git", "checkout", "--detach", "FETCH_HEAD"]);
const head = await run("head", ["git", "rev-parse", "HEAD"]);
if (head.log.trim() !== pins.panel.commit)
  throw new Error("Panel source pin mismatch");
await run("install", [process.execPath, "install", "--frozen-lockfile"]);
const baseline = await run("baseline-tests", [process.execPath, "test"], true);
const baselineFailures = failures(baseline.log);
if (
  (baselineFailures.length > 0 &&
    JSON.stringify(baselineFailures) !==
      JSON.stringify(pins.acceptedUpstreamTestFailures)) ||
  baseline.exitCode !== (baselineFailures.length ? 1 : 0) ||
  baseline.log.includes("Unhandled error") ||
  !Number.isFinite(passes(baseline.log))
)
  throw new Error("Unexpected baseline; inspect logs, never bypass tests.");
await run("baseline-lint", [process.execPath, "run", "lint"]);
await run("baseline-types", [process.execPath, "run", "type-check"]);
await run("baseline-build", [process.execPath, "run", "build"]);
const patch = join(root, "panel/patches/0001-xiaomi-quota.patch");
await run("patch-check", ["git", "apply", "--check", patch]);
await run("patch", ["git", "apply", patch]);
const patched = await run("patched-tests", [process.execPath, "test"], true);
if (
  patched.exitCode !== baseline.exitCode ||
  JSON.stringify(failures(patched.log)) !== JSON.stringify(baselineFailures) ||
  patched.log.includes("Unhandled error") ||
  passes(patched.log) <= passes(baseline.log)
)
  throw new Error("New/missing test results; inspect logs.");
await run("xiaomi-tests", [
  process.execPath,
  "test",
  "tests/xiaomiQuota.test.ts",
]);
await run("patched-lint", [process.execPath, "run", "lint"]);
await run("patched-types", [process.execPath, "run", "type-check"]);
await run("patched-build", [process.execPath, "run", "build"]);
const out = join(root, "dist");
await mkdir(out, { recursive: true });
await copyFile(join(work, "dist/index.html"), join(out, "management.html"));
await copyFile(join(work, "LICENSE"), join(out, "UPSTREAM-PANEL-LICENSE"));
let notices = await Bun.file(join(root, "THIRD_PARTY_NOTICES.md")).text();
const licensePaths: string[] = [];
for await (const path of new Bun.Glob(
  "**/{LICENSE,LICENSE.*,LICENSE-*,license,license.*,COPYING,NOTICE,NOTICE.*}",
).scan({ cwd: join(work, "node_modules"), onlyFiles: true }))
  licensePaths.push(path);
for (const path of licensePaths.sort()) {
  notices +=
    "\n\n--- " +
    path +
    " ---\n" +
    (await Bun.file(join(work, "node_modules", path)).text());
}
await Bun.write(join(out, "panel-third-party-licenses.txt"), notices);
const source = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
});
const status = Bun.spawnSync(["git", "status", "--porcelain"], {
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
});
if (source.exitCode !== 0 || status.exitCode !== 0)
  throw new Error("Cannot establish project provenance");
const sha = (data: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(data).digest("hex");
const hashes: Record<string, string> = {};
for (const name of [
  "management.html",
  "UPSTREAM-PANEL-LICENSE",
  "panel-third-party-licenses.txt",
])
  hashes[name] = sha(
    new Uint8Array(await Bun.file(join(out, name)).arrayBuffer()),
  );
const manifest = {
  schemaVersion: 1,
  project: "godlyfast/cpa-xiaomi-tokenplan-quota",
  sourceCommit: source.stdout.toString().trim(),
  sourceTreeClean: status.stdout.toString().trim() === "",
  panel: pins.panel,
  gateway: pins.gateway,
  bun: Bun.version,
  version: cleanEnv.VERSION,
  patchSha256: sha(new Uint8Array(await Bun.file(patch).arrayBuffer())),
  baseline: { passed: passes(baseline.log), failures: baselineFailures },
  patched: { passed: passes(patched.log), failures: failures(patched.log) },
  lint: "pass",
  types: "pass",
  build: "pass",
  liveDeploymentVerified: false,
  artifacts: hashes,
};
await Bun.write(
  join(out, "panel-manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
hashes["panel-manifest.json"] = sha(
  new Uint8Array(
    await Bun.file(join(out, "panel-manifest.json")).arrayBuffer(),
  ),
);
await Bun.write(
  join(out, "SHA256SUMS"),
  Object.entries(hashes)
    .map(([name, hash]) => hash + "  " + name)
    .join("\n") + "\n",
);
console.log(
  JSON.stringify(
    {
      output: out,
      logs,
      baseline: manifest.baseline,
      patched: manifest.patched,
      sha256: hashes["management.html"],
    },
    null,
    2,
  ),
);
