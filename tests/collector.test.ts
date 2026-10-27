import { expect, test } from "bun:test";
import { mkdtemp, writeFile, chmod, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "../fixtures/singapore-plan.json";
import { createCollector } from "../src/collector";
import { fetchMimoSnapshot, QuotaError } from "../src/mimo";

async function secret(fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "mimo-test-"));
  const path = join(dir, "cookie");
  await writeFile(path, "session=synthetic-secret\n", { mode: 0o600 });
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const request = () => new Request("http://xiaomi-quota:8787/v1/quota");
const snap = () =>
  fetchMimoSnapshot("s=synthetic", new Date("2030-01-01T00:00:00Z"), {
    accountLabel: "Test",
    fetch: async (input) =>
      Response.json(input.endsWith("/usage") ? fixture.usage : fixture.detail),
  });

test("concurrent readers share poll and cannot submit URLs, cookies or methods", async () => {
  await secret(async (path) => {
    let calls = 0;
    const c = createCollector({
      cookieFile: path,
      accountLabel: "Test",
      fetchSnapshot: async (cookie) => {
        expect(cookie).toBe("session=synthetic-secret");
        calls++;
        return snap();
      },
    });
    try {
      const responses = await Promise.all(
        Array.from({ length: 20 }, () => c.fetch(request())),
      );
      expect(calls).toBe(1);
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.text()).not.toContain("synthetic-secret");
      }
      expect(
        (await c.fetch(new Request("http://q/v1/quota", { method: "POST" })))
          .status,
      ).toBe(405);
      expect(
        (
          await c.fetch(
            new Request("http://q/v1/quota?url=https://evil.invalid"),
          )
        ).status,
      ).toBe(404);
      const health = await c.fetch(new Request("http://q/healthz"));
      expect(await health.json()).toEqual({ ok: true });
    } finally {
      await c.close();
    }
  });
});
test("missing, public-readable, empty or symlinked secrets fail closed without upstream requests", async () => {
  await secret(async (path) => {
    const link = path + "-link";
    await symlink(path, link);
    for (const [candidate, mode, body] of [
      [path + "missing", 0o600, "x"],
      [path, 0o644, "x"],
      [path, 0o600, ""],
      [link, 0o600, "x"],
    ] as const) {
      await chmod(path, mode);
      await writeFile(path, body);
      let calls = 0;
      const c = createCollector({
        cookieFile: candidate,
        accountLabel: "Test",
        fetchSnapshot: async () => {
          calls++;
          return snap();
        },
      });
      try {
        const result = await (await c.fetch(request())).json();
        expect(result.error).toBe("auth_required");
        expect(result.pools).toEqual([]);
        expect(calls).toBe(0);
        expect(JSON.stringify(result)).not.toContain(candidate);
      } finally {
        await c.close();
      }
    }
  });
});
test("stale cache preserves last success; poll failure is sanitized and retains real age", async () => {
  await secret(async (path) => {
    let now = new Date("2030-01-01T00:00:00Z"),
      calls = 0;
    const c = createCollector({
      cookieFile: path,
      accountLabel: "Test",
      now: () => now,
      pollIntervalMs: 10,
      fetchSnapshot: async () => {
        calls++;
        if (calls > 1) throw new Error("private-cookie-error");
        return snap();
      },
    });
    try {
      expect((await (await c.fetch(request())).json()).stale).toBe(false);
      now = new Date("2030-01-01T00:10:01Z");
      const old = await (await c.fetch(request())).json();
      expect(old.stale).toBe(true);
      expect(old.fetchedAt).toBe("2030-01-01T00:00:00.000Z");
      await Bun.sleep(30);
      const failed = await (await c.fetch(request())).json();
      expect(failed.error).toBe("unavailable");
      expect(failed.stale).toBe(true);
      expect(failed.pools[0].remaining).toBe("5000000000");
      expect(JSON.stringify(failed)).not.toContain("private-cookie-error");
    } finally {
      await c.close();
    }
  });
});
test("auth expiry halts poll retries until restart; close aborts work", async () => {
  await secret(async (path) => {
    let calls = 0;
    const c = createCollector({
      cookieFile: path,
      accountLabel: "Test",
      pollIntervalMs: 5,
      fetchSnapshot: async () => {
        calls++;
        throw new QuotaError("auth_required");
      },
    });
    expect((await (await c.fetch(request())).json()).error).toBe(
      "auth_required",
    );
    await Bun.sleep(25);
    expect(calls).toBe(1);
    await c.close();
    await Bun.sleep(10);
    expect(calls).toBe(1);
    let signal: AbortSignal | undefined;
    const running = createCollector({
      cookieFile: path,
      accountLabel: "Test",
      fetchSnapshot: async (_cookie, _now, s) => {
        signal = s;
        await new Promise<void>((resolve) =>
          s.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw new QuotaError("unavailable");
      },
    });
    await Bun.sleep(10);
    await running.close();
    expect(signal?.aborted).toBe(true);
  });
});
