import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

// Run the actual resource script, mocking only browser/network boundaries.
// Assertions concern UI behavior, never calls to the mock.
class Element {
  textContent = ""; value = ""; hidden = false; className = ""; children: Element[] = [];
  listeners = new Map<string, () => void>();
  replaceChildren() { this.children = []; }
  append(...children: Element[]) { this.children.push(...children); }
  setAttribute() {}
  addEventListener(name: string, cb: () => void) { this.listeners.set(name, cb); }
}
const source = readFileSync(new URL("./quota.html", import.meta.url), "utf8").match(/<script>([\s\S]*?)<\/script>/)![1];
function page(fetch: typeof globalThis.fetch) {
  const elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  get("status").textContent = "Management authentication required. No quota is public.";
  const context = createContext({ fetch, document: { hidden: false, getElementById: get, createElement: () => new Element(), addEventListener() {} }, window: { addEventListener() {} }, AbortSignal, AbortController, setInterval() {} });
  runInContext(source, context);
  const login = () => { get("key").value = "synthetic-management"; runInContext("byId('login').listeners.get('submit')({preventDefault(){}})", context); };
  return { get, context, login };
}
const fixture = { schemaVersion: 1, region: "sgp", accountLabel: "Synthetic account", planName: "Pro", pools: [{ label: "Plan", used: "60", limit: "100", remaining: "40", remainingPercent: "40.00" }], stale: false, error: null, expired: false, fetchedAt: "2026-10-27T12:00:00Z", expiresAt: null };
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

test("disconnect prevents deferred private quota from reappearing", async () => {
  let resolve!: (r: Response) => void;
  const p = page(() => new Promise<Response>(r => { resolve = r; }));
  p.login(); runInContext("disconnect()", p.context);
  resolve(Response.json(fixture)); await settle();
  expect(p.get("status").textContent).toContain("Disconnected");
  expect(p.get("quota").children).toHaveLength(0);
  expect(p.get("login").hidden).toBe(false);
  expect(p.get("key").value).toBe("");
});
test("an old authentication failure cannot disconnect a newer connection", async () => {
  let resolve!: (r: Response) => void;
  let calls = 0;
  const p = page(() => ++calls === 1 ? new Promise<Response>(r => { resolve = r; }) : Promise.resolve(Response.json(fixture)));
  p.login(); runInContext("disconnect()", p.context); p.login(); await settle();
  expect(p.get("status").textContent).toContain("Synthetic account");
  resolve(new Response(null, { status: 401 })); await settle();
  expect(p.get("status").textContent).toContain("Synthetic account");
  expect(p.get("login").hidden).toBe(true);
});
test("a failed refresh clears prior balance and labels it unavailable", async () => {
  let failed = false;
  const p = page(() => Promise.resolve(failed ? new Response(null, { status: 503 }) : Response.json(fixture)));
  p.login(); await settle(); expect(p.get("quota").children.length).toBeGreaterThan(0);
  failed = true; await runInContext("refresh()", p.context);
  expect(p.get("quota").children).toHaveLength(0); expect(p.get("status").textContent).toContain("unavailable");
});
