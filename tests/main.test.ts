import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Only failing configurations are exercised: each must exit before any server or
// vendor request. The session path never exists, so a wrongly accepted value still
// could not reach Xiaomi, and the timeout kills a process that started serving.
test("malformed environment fails closed with a clear message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mimo-main-"));
  const base = {
    PATH: process.env.PATH ?? "",
    ACCOUNT_LABEL: "Test",
    ACCOUNT_REGION: "sgp",
    ACCOUNT_BINDING_CONFIRMED: "true",
    MIMO_COOKIE_FILE: join(dir, "absent", "mimo_session"),
  };
  try {
    for (const [env, message] of [
      [{ ACCOUNT_BINDING_CONFIRMED: "yes" }, "Set ACCOUNT_LABEL"],
      [{ MIMO_COOKIE_FILE: "relative/mimo_session" }, "MIMO_COOKIE_FILE must be an absolute path."],
      [{ MIMO_COOKIE_FILE: "" }, "MIMO_COOKIE_FILE must be an absolute path."],
      [{ RENEWAL_STATUS_FILE: "status.json" }, "RENEWAL_STATUS_FILE must be an absolute path."],
      ...["", "0", "999", "1.5", "1e4", "015000", "abc", "3600001", "-1"].map(
        (value) => [
          { SESSION_CHECK_INTERVAL_MS: value },
          "SESSION_CHECK_INTERVAL_MS must be a whole number of milliseconds from 1000 to 3600000.",
        ],
      ),
      ...["", "59999", "86400001", "60000ms"].map((value) => [
        { AUTH_RETRY_INTERVAL_MS: value },
        "AUTH_RETRY_INTERVAL_MS must be a whole number of milliseconds from 60000 to 86400000.",
      ]),
    ] as [Record<string, string>, string][]) {
      const child = Bun.spawn([process.execPath, "src/main.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: { ...base, ...env },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10000,
      });
      const [code, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect({ env, code }).toEqual({ env, code: 1 });
      expect(stderr).toContain(message);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
