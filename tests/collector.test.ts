import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  writeFile,
  chmod,
  rm,
  symlink,
  rename,
  stat,
  mkdir,
} from "node:fs/promises";
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
const getuid = process.getuid;
afterEach(() => {
  process.getuid = getuid;
});
const quiet = () => {};
const request = () => new Request("http://xiaomi-quota:8787/v1/quota");
const snap = () =>
  fetchMimoSnapshot("s=synthetic", new Date("2030-01-01T00:00:00Z"), {
    accountLabel: "Test",
    fetch: async (input) =>
      Response.json(input.endsWith("/usage") ? fixture.usage : fixture.detail),
  });
const quota = async (c: { fetch(r: Request): Promise<Response> }) =>
  (await c.fetch(request())).json();
const at = (ms: number) => new Date(Date.parse("2030-01-01T00:00:00Z") + ms);
const iso = (ms: number) => at(ms).toISOString();
const mtime = async (path: string) =>
  new Date((await stat(path)).mtimeMs).toISOString();
// Atomic replacement: a new inode renamed over the old name, as the refresher does.
async function replace(path: string, body: string, mode = 0o600) {
  await writeFile(path + ".tmp", body);
  await chmod(path + ".tmp", mode); // Not subject to umask, unlike writeFile's mode.
  await rename(path + ".tmp", path);
}
async function until(condition: () => Promise<boolean> | boolean) {
  const end = Date.now() + 3000;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error("condition not reached");
    await Bun.sleep(2);
  }
}

test("concurrent readers share poll and cannot submit URLs, cookies or methods", async () => {
  await secret(async (path) => {
    let calls = 0;
    const c = createCollector({
      cookieFile: path,
      accountLabel: "Test",
      log: quiet,
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
test("missing, public-readable, empty, oversized, foreign or symlinked secrets fail closed without upstream requests", async () => {
  await secret(async (path) => {
    const link = path + "-link",
      dir = path + "-dir";
    await symlink(path, link);
    await mkdir(dir, { mode: 0o700 });
    for (const [candidate, mode, body, state, regular, uid] of [
      [path + "missing", 0o600, "x", "missing", false, null],
      [path, 0o644, "x", "invalid_file", true, null],
      [path, 0o640, "x", "invalid_file", true, null],
      [path, 0o600, "", "invalid_file", true, null],
      [path, 0o600, " \n\t ", "invalid_file", true, null],
      [path, 0o600, "a=b\x01c", "invalid_file", true, null],
      [path, 0o600, "a=" + "b".repeat(16384), "invalid_file", true, null],
      [path, 0o600, "x", "invalid_file", true, 4242],
      [link, 0o600, "x", "invalid_file", false, null],
      [dir, 0o600, "x", "invalid_file", false, null],
    ] as const) {
      await chmod(path, mode);
      await writeFile(path, body);
      process.getuid = uid === null ? getuid : () => uid;
      let calls = 0;
      const c = createCollector({
        cookieFile: candidate,
        accountLabel: "Test",
        now: () => at(0),
        log: quiet,
        fetchSnapshot: async () => {
          calls++;
          return snap();
        },
      });
      try {
        const result = await quota(c);
        expect(result.error).toBe("auth_required");
        expect(result.pools).toEqual([]);
        expect(calls).toBe(0);
        expect(JSON.stringify(result)).not.toContain(candidate);
        expect(result.session).toEqual({
          state,
          updatedAt: regular ? await mtime(path) : null,
          rejectedAt: iso(0),
          lastAttemptAt: null,
          nextAttemptAt: null,
        });
        expect(result.renewal).toBeNull();
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
      log: quiet,
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
      // Non-auth failures keep the last session verdict.
      expect(failed.session.state).toBe("ok");
      expect(failed.session.rejectedAt).toBeNull();
    } finally {
      await c.close();
    }
  });
});
test("auth expiry stops poll retries until the auth retry interval; close aborts work", async () => {
  await secret(async (path) => {
    let calls = 0;
    const c = createCollector({
      cookieFile: path,
      accountLabel: "Test",
      pollIntervalMs: 5,
      log: quiet,
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
      log: quiet,
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
test("rejected session recovers automatically after atomic replacement, without restart", async () => {
  await secret(async (path) => {
    let now = at(0);
    const sent: string[] = [],
      lines: string[] = [];
    const c = createCollector({
      cookieFile: path,
      accountLabel: "Test",
      now: () => now,
      pollIntervalMs: 3600000,
      sessionCheckIntervalMs: 2,
      log: (line) => lines.push(line),
      fetchSnapshot: async (cookie) => {
        sent.push(cookie);
        if (cookie === "session=synthetic-secret")
          throw new QuotaError("auth_required");
        return snap();
      },
    });
    try {
      const expired = await quota(c);
      expect(expired.error).toBe("auth_required");
      expect(expired.stale).toBe(true);
      expect(expired.session).toEqual({
        state: "expired",
        updatedAt: await mtime(path),
        rejectedAt: iso(0),
        lastAttemptAt: iso(0),
        nextAttemptAt: iso(3600000),
      });
      await Bun.sleep(20);
      expect(sent.length).toBe(1);
      const inode = (await stat(path)).ino;
      now = at(60000);
      await replace(path, "session=synthetic-renewed\n");
      expect((await stat(path)).ino).not.toBe(inode);
      await until(async () => (await quota(c)).session.state === "ok");
      const ok = await quota(c);
      expect(ok.error).toBeNull();
      expect(ok.stale).toBe(false);
      expect(ok.pools[0].remaining).toBe("5000000000");
      expect(ok.session).toEqual({
        state: "ok",
        updatedAt: await mtime(path),
        rejectedAt: null,
        lastAttemptAt: iso(60000),
        nextAttemptAt: iso(60000 + 3600000),
      });
      await Bun.sleep(20);
      expect(sent).toEqual([
        "session=synthetic-secret",
        "session=synthetic-renewed",
      ]);
      expect(lines).toEqual([
        "session state unknown -> expired",
        "session state expired -> ok",
      ]);
      expect(JSON.stringify(ok)).not.toContain("synthetic");
    } finally {
      await c.close();
    }
  });
});
test("in-place rewrite of a rejected session (same inode) also triggers one refresh", async () => {
  await secret(async (path) => {
    const sent: string[] = [];
    const c = createCollector({
      cookieFile: path,
      accountLabel: "Test",
      now: () => at(0),
      pollIntervalMs: 3600000,
      sessionCheckIntervalMs: 2,
      log: quiet,
      fetchSnapshot: async (cookie) => {
        sent.push(cookie);
        if (cookie === "session=synthetic-secret")
          throw new QuotaError("auth_required");
        return snap();
      },
    });
    try {
      expect((await quota(c)).session.state).toBe("expired");
      const inode = (await stat(path)).ino;
      await writeFile(path, "session=synthetic-renewed\n");
      expect((await stat(path)).ino).toBe(inode);
      await until(async () => (await quota(c)).session.state === "ok");
      await Bun.sleep(20);
      expect(sent).toEqual([
        "session=synthetic-secret",
        "session=synthetic-renewed",
      ]);
    } finally {
      await c.close();
    }
  });
});
test("unchanged rejected session is retried exactly once per auth retry interval", async () => {
  await secret(async (path) => {
    let now = at(0),
      calls = 0;
    const c = createCollector({
      cookieFile: path,
      accountLabel: "Test",
      now: () => now,
      pollIntervalMs: 2,
      sessionCheckIntervalMs: 2,
      authRetryIntervalMs: 1000,
      log: quiet,
      fetchSnapshot: async () => {
        // Third attempt models a transient 401 that has cleared.
        if (++calls < 3) throw new QuotaError("auth_required");
        return snap();
      },
    });
    try {
      expect((await quota(c)).session.nextAttemptAt).toBe(iso(1000));
      await Bun.sleep(30);
      now = at(999);
      await Bun.sleep(30);
      expect(calls).toBe(1);
      now = at(1000);
      await until(() => calls === 2);
      await Bun.sleep(30);
      expect(calls).toBe(2);
      const again = await quota(c);
      expect(again.error).toBe("auth_required");
      expect(again.session).toEqual({
        state: "expired",
        updatedAt: await mtime(path),
        rejectedAt: iso(0),
        lastAttemptAt: iso(1000),
        nextAttemptAt: iso(2000),
      });
      now = at(2000);
      await until(async () => (await quota(c)).session.state === "ok");
      const ok = await quota(c);
      expect(ok.error).toBeNull();
      expect(ok.session.rejectedAt).toBeNull();
      expect(ok.session.lastAttemptAt).toBe(iso(2000));
      expect(ok.session.nextAttemptAt).toBe(iso(2002));
    } finally {
      await c.close();
    }
  });
});
test("missing session file never reaches Xiaomi and recovers when it appears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mimo-test-"));
  const path = join(dir, "mimo_session");
  try {
    let now = at(0);
    const sent: string[] = [];
    const c = createCollector({
      cookieFile: path,
      accountLabel: "Test",
      now: () => now,
      pollIntervalMs: 2,
      sessionCheckIntervalMs: 2,
      authRetryIntervalMs: 1,
      log: quiet,
      fetchSnapshot: async (cookie) => {
        sent.push(cookie);
        return snap();
      },
    });
    try {
      const missing = await quota(c);
      expect(missing.error).toBe("auth_required");
      expect(missing.session).toEqual({
        state: "missing",
        updatedAt: null,
        rejectedAt: iso(0),
        lastAttemptAt: null,
        nextAttemptAt: null,
      });
      now = at(5000);
      await Bun.sleep(30);
      expect(sent).toEqual([]);
      expect((await quota(c)).session.rejectedAt).toBe(iso(0));
      await replace(path, "session=synthetic-secret\n");
      await until(async () => (await quota(c)).session.state === "ok");
      const ok = await quota(c);
      expect(ok.error).toBeNull();
      expect(ok.session).toEqual({
        state: "ok",
        updatedAt: await mtime(path),
        rejectedAt: null,
        lastAttemptAt: iso(5000),
        nextAttemptAt: iso(5002),
      });
      expect(sent[0]).toBe("session=synthetic-secret");
    } finally {
      await c.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("fixing an invalid session file triggers a refresh", async () => {
  await secret(async (path) => {
    await chmod(path, 0o644);
    let calls = 0;
    const c = createCollector({
      cookieFile: path,
      accountLabel: "Test",
      now: () => at(0),
      pollIntervalMs: 3600000,
      sessionCheckIntervalMs: 2,
      log: quiet,
      fetchSnapshot: async () => {
        calls++;
        return snap();
      },
    });
    try {
      expect((await quota(c)).session.state).toBe("invalid_file");
      await Bun.sleep(20);
      expect(calls).toBe(0);
      await chmod(path, 0o600);
      await until(async () => (await quota(c)).session.state === "ok");
      expect(calls).toBe(1);
    } finally {
      await c.close();
    }
  });
});
test("non-auth failures keep the verdict for the same session; a replaced session is unknown until verified", async () => {
  await secret(async (path) => {
    let now = at(0);
    const outcomes: ("auth" | "down" | "schema")[] = ["auth", "down", "schema"];
    const c = createCollector({
      cookieFile: path,
      accountLabel: "Test",
      now: () => now,
      pollIntervalMs: 2,
      sessionCheckIntervalMs: 2,
      authRetryIntervalMs: 1000,
      log: quiet,
      fetchSnapshot: async () => {
        const next = outcomes.shift();
        if (next === "auth") throw new QuotaError("auth_required");
        if (next === "down") throw new QuotaError("unavailable");
        if (next === "schema") throw new QuotaError("schema_changed");
        return snap();
      },
    });
    try {
      expect((await quota(c)).session.state).toBe("expired");
      now = at(1000);
      await until(() => outcomes.length === 1);
      await Bun.sleep(20);
      const retried = await quota(c);
      expect(retried.error).toBe("auth_required");
      expect(retried.session).toMatchObject({
        state: "expired",
        rejectedAt: iso(0),
        lastAttemptAt: iso(1000),
        nextAttemptAt: iso(2000),
      });
      expect(outcomes.length).toBe(1);
      await replace(path, "session=synthetic-renewed\n");
      await until(() => outcomes.length === 0);
      await until(async () => (await quota(c)).session.state === "ok");
    } finally {
      await c.close();
    }
  });
  await secret(async (path) => {
    let calls = 0;
    const c = createCollector({
      cookieFile: path,
      accountLabel: "Test",
      now: () => at(0),
      pollIntervalMs: 3600000,
      sessionCheckIntervalMs: 2,
      log: quiet,
      fetchSnapshot: async () => {
        if (++calls === 1) throw new QuotaError("auth_required");
        throw new QuotaError("unavailable");
      },
    });
    try {
      expect((await quota(c)).session.state).toBe("expired");
      await replace(path, "session=synthetic-renewed\n");
      await until(() => calls === 2);
      await until(async () => (await quota(c)).session.state === "unknown");
      const unknown = await quota(c);
      expect(unknown.error).toBe("unavailable");
      expect(unknown.session).toEqual({
        state: "unknown",
        updatedAt: await mtime(path),
        rejectedAt: null,
        lastAttemptAt: iso(0),
        nextAttemptAt: iso(3600000),
      });
      await Bun.sleep(20);
      expect(calls).toBe(2);
    } finally {
      await c.close();
    }
  });
});
test("renewal status is validated, exposed and re-read on every session-check tick", async () => {
  await secret(async (path) => {
    const status = join(path, "..", "renewal-status.json");
    const body = (result: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        schemaVersion: 1,
        checkedAt: "2030-01-01T00:00:00.000Z",
        result,
        renewedAt: null,
        host: "synthetic-laptop",
        manualCommand: "synthetic-refresher --once",
        ...extra,
      });
    await replace(status, body("not_needed"));
    const c = createCollector({
      cookieFile: path,
      accountLabel: "Test",
      now: () => at(0),
      pollIntervalMs: 3600000,
      sessionCheckIntervalMs: 2,
      log: quiet,
      fetchSnapshot: async () => snap(),
    });
    try {
      const first = await quota(c);
      expect(first.session.state).toBe("ok");
      expect(first.renewal).toEqual({
        checkedAt: "2030-01-01T00:00:00.000Z",
        result: "not_needed",
        renewedAt: null,
        host: "synthetic-laptop",
        manualCommand: "synthetic-refresher --once",
      });
      await replace(
        status,
        body("renewed", { renewedAt: "2030-01-01T00:00:01Z" }),
      );
      await until(async () => (await quota(c)).renewal?.result === "renewed");
      expect((await quota(c)).renewal.renewedAt).toBe("2030-01-01T00:00:01Z");
      for (const [text, mode] of [
        [body("renewed", { extra: 1 }), 0o600],
        [body("signin_required", { host: "bad host" }), 0o600],
        [body("signin_required"), 0o664],
      ] as const) {
        await replace(status, body("signin_required"));
        await until(
          async () => (await quota(c)).renewal?.result === "signin_required",
        );
        await replace(status, text, mode);
        await until(async () => (await quota(c)).renewal === null);
      }
      await replace(status, body("browser_unavailable"));
      await until(
        async () => (await quota(c)).renewal?.result === "browser_unavailable",
      );
      await rm(status);
      await until(async () => (await quota(c)).renewal === null);
    } finally {
      await c.close();
    }
  });
});
test("close stops every timer and file re-read", async () => {
  await secret(async (path) => {
    let calls = 0;
    const lines: string[] = [];
    const c = createCollector({
      cookieFile: path,
      accountLabel: "Test",
      pollIntervalMs: 2,
      sessionCheckIntervalMs: 2,
      authRetryIntervalMs: 1,
      log: (line) => lines.push(line),
      fetchSnapshot: async () => {
        calls++;
        throw new QuotaError("auth_required");
      },
    });
    expect((await quota(c)).session.state).toBe("expired");
    await c.close();
    const before = calls;
    await replace(path, "session=synthetic-renewed\n");
    await replace(
      join(path, "..", "renewal-status.json"),
      JSON.stringify({
        schemaVersion: 1,
        checkedAt: "2030-01-01T00:00:00.000Z",
        result: "renewed",
        renewedAt: "2030-01-01T00:00:00.000Z",
        host: "synthetic-laptop",
        manualCommand: null,
      }),
    );
    await Bun.sleep(30);
    expect(calls).toBe(before);
    const after = await quota(c);
    expect(after.renewal).toBeNull();
    expect(after.session.state).toBe("expired");
    expect(lines).toEqual(["session state unknown -> expired"]);
  });
});
