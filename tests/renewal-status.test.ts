import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRenewalStatus, readRenewalStatus } from "../src/renewal";

const valid = {
  schemaVersion: 1,
  checkedAt: "2030-01-01T00:00:00.000Z",
  result: "renewed",
  renewedAt: "2030-01-01T00:00:00Z",
  host: "synthetic-laptop.lan_1",
  manualCommand: "synthetic-refresher --once",
} as const;
const text = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ ...valid, ...overrides });
const { schemaVersion: _, ...expected } = valid;
const dirs: string[] = [];
const getuid = process.getuid;
afterEach(async () => {
  process.getuid = getuid;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function dir() {
  const path = await mkdtemp(join(tmpdir(), "renewal-test-"));
  dirs.push(path);
  return path;
}

test("valid status parses exactly, without schemaVersion", () => {
  expect(parseRenewalStatus(text())).toEqual(expected);
  expect(Object.keys(parseRenewalStatus(text())!)).toEqual([
    "checkedAt",
    "result",
    "renewedAt",
    "host",
    "manualCommand",
  ]);
  for (const result of [
    "not_needed",
    "renewed",
    "signin_required",
    "browser_unavailable",
    "vendor_unavailable",
    "error",
  ])
    expect(
      parseRenewalStatus(text({ result, renewedAt: null, manualCommand: null })),
    ).toEqual({
      ...expected,
      result,
      renewedAt: null,
      manualCommand: null,
    } as never);
  const short = "2030-01-01T00:00:00.5Z",
    host = "a".repeat(64),
    command = "x".repeat(159) + "~";
  expect(parseRenewalStatus(text({ checkedAt: short }))?.checkedAt).toBe(short);
  expect(parseRenewalStatus(text({ host }))?.host).toBe(host);
  expect(
    parseRenewalStatus(text({ manualCommand: command }))?.manualCommand,
  ).toBe(command);
  expect(parseRenewalStatus(" \n" + text() + "\n")).toEqual(expected);
});
test("malformed JSON, shapes and key sets are rejected", () => {
  const { host: _host, ...missing } = valid;
  for (const candidate of [
    "",
    "{",
    "null",
    "[]",
    '"x"',
    "1",
    "﻿" + text(),
    text({ extra: true }),
    '{"__proto__":{},' + text().slice(1),
    JSON.stringify(missing),
    JSON.stringify({ ...valid, host: undefined }),
    text({ schemaVersion: 2 }),
    text({ schemaVersion: "1" }),
    text({ result: "RENEWED" }),
    text({ result: null }),
    text({ host: "x".repeat(4096) }),
  ])
    expect(parseRenewalStatus(candidate)).toBeNull();
});
test("timestamps must be canonical valid UTC", () => {
  for (const value of [
    "2030-01-01T00:00:00+00:00",
    "2030-01-01T00:00:00",
    "2030-01-01 00:00:00Z",
    "2030-01-01T00:00:00.1234Z",
    "2030-01-01T00:00Z",
    "2030-02-30T00:00:00Z",
    "2030-13-01T00:00:00Z",
    "2030-01-01T24:00:00Z",
    "2030-01-01T00:60:00Z",
    "+012030-01-01T00:00:00.000Z",
    "2030-01-01T00:00:00.000z",
    1893456000000,
    "",
  ]) {
    expect(parseRenewalStatus(text({ checkedAt: value }))).toBeNull();
    expect(parseRenewalStatus(text({ renewedAt: value }))).toBeNull();
  }
  expect(parseRenewalStatus(text({ checkedAt: null }))).toBeNull();
});
test("host label and manual command are strictly bounded", () => {
  for (const host of ["", "-x", ".x", "x y", "a".repeat(65), "x/y", "é", 1, null])
    expect(parseRenewalStatus(text({ host }))).toBeNull();
  for (const manualCommand of [
    "",
    "x".repeat(161),
    "run\tit",
    "run\nit",
    "run\x7fit",
    "naïve",
    1,
    false,
  ])
    expect(parseRenewalStatus(text({ manualCommand }))).toBeNull();
});
test("reader enforces owner, mode, type, size and strict UTF-8", async () => {
  const d = await dir(),
    path = join(d, "renewal-status.json");
  await writeFile(path, text(), { mode: 0o600 });
  expect(await readRenewalStatus(path)).toEqual(expected);
  await chmod(path, 0o644);
  expect(await readRenewalStatus(path)).toEqual(expected);
  for (const mode of [0o664, 0o646, 0o622]) {
    await chmod(path, mode);
    expect(await readRenewalStatus(path)).toBeNull();
  }
  await chmod(path, 0o600);
  await symlink(path, join(d, "link"));
  expect(await readRenewalStatus(join(d, "link"))).toBeNull();
  expect(await readRenewalStatus(join(d, "missing"))).toBeNull();
  await mkdir(join(d, "dir"), { mode: 0o700 });
  expect(await readRenewalStatus(join(d, "dir"))).toBeNull();
  const padded = text() + " ".repeat(4096 - text().length);
  await writeFile(path, padded);
  expect(await readRenewalStatus(path)).toEqual(expected);
  await writeFile(path, padded + " ");
  expect(await readRenewalStatus(path)).toBeNull();
  const [head, tail] = text({ host: "x@" }).split("@");
  await writeFile(
    path,
    Buffer.concat([Buffer.from(head), Buffer.from([0xff]), Buffer.from(tail)]),
  );
  expect(await readRenewalStatus(path)).toBeNull();
  await writeFile(path, Buffer.from(text({ manualCommand: "\ufffd" })));
  expect(await readRenewalStatus(path)).toBeNull();
  await writeFile(path, text());
  process.getuid = () => 4242;
  expect(await readRenewalStatus(path)).toBeNull();
});
