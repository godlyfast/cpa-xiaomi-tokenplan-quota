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
function page(fetch: typeof globalThis.fetch, embedded = false) {
  const elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  get("status").textContent = "Management authentication required. No quota is public.";
  const messages: Record<string, unknown>[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const timeouts = new Map<number, () => void>(); let nextTimer = 0;
  const parent = { location: { origin: 'http://127.0.0.1:8317' }, postMessage: (data: Record<string, unknown>) => messages.push(data) };
  const window = { location: { origin: 'http://127.0.0.1:8317' }, parent: embedded ? parent : undefined, addEventListener: (name: string, cb: (event: unknown) => void) => listeners.set(name, cb) };
  const context = createContext({ fetch, document: { hidden: false, getElementById: get, createElement: () => new Element(), addEventListener() {} }, window, crypto: { getRandomValues: (bytes: Uint8Array) => { bytes.fill(++nextTimer); return bytes; } }, AbortSignal, AbortController, setInterval() {}, clearInterval() {}, setTimeout: (cb: () => void) => { const id = ++nextTimer; timeouts.set(id, cb); return id; }, clearTimeout: (id: number) => timeouts.delete(id) });
  runInContext(source, context);
  const login = () => { get("key").value = "synthetic-management"; runInContext("byId('login').listeners.get('submit')({preventDefault(){}})", context); };
  const reply = (snapshot: unknown = fixture, origin = window.location.origin, source: unknown = parent, requestId = messages.at(-1)?.requestId) => listeners.get('message')?.({ origin, source, data: { type: 'cpa.plugin.snapshot.response.v1', requestId, snapshot } });
  return { get, context, login, messages, reply, dispatch: (name: string, event: unknown = {}) => listeners.get(name)?.(event), timeout: () => { for (const cb of [...timeouts.values()]) cb(); } };
}
const fixture = { schemaVersion: 1, region: "sgp", accountLabel: "Synthetic account", planName: "Pro", pools: [{ label: "Plan", used: "60", limit: "100", remaining: "40", remainingPercent: "40.00" }], stale: false, error: null, expired: false, fetchedAt: "2026-10-27T12:00:00Z", expiresAt: null };
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

test("embedded page renders dashboard quota without requesting or storing a key", async () => {
  let reads = 0;
  const p = page(() => { reads++; return Promise.reject(Error('must not fetch directly')); }, true);
  expect(p.get('login').hidden).toBe(true);
  p.reply(); await settle();
  expect(p.get('status').textContent).toContain('Synthetic account');
  expect(p.get('quota').children.length).toBeGreaterThan(0);
  expect(p.get('key').value).toBe(''); expect(reads).toBe(0);
});
test("foreign, unrelated and stale replies cannot populate dashboard quota", async () => {
  const p = page(() => Promise.reject(Error('must not fetch')), true);
  p.reply(fixture, 'https://attacker.invalid'); p.reply(fixture, undefined, {}); p.reply(fixture, undefined, undefined, 'wrong-id'); await settle();
  expect(p.get('quota').children).toHaveLength(0);
  runInContext('disconnect()', p.context); p.reply(); await settle();
  expect(p.get('quota').children).toHaveLength(0); expect(p.get('login').hidden).toBe(false);
});
test("stock panels time out to the explicit manual login without inventing quota", async () => {
  const p = page(() => Promise.reject(Error('must not fetch')), true);
  p.timeout(); await settle();
  expect(p.get('login').hidden).toBe(false);
  expect(p.get('status').textContent).toContain('unavailable');
  expect(p.get('quota').children).toHaveLength(0);
});
test("a dashboard refresh failure clears previously displayed private balance", async () => {
  const p = page(() => Promise.reject(Error('must not fetch')), true);
  p.reply(); await settle(); expect(p.get('quota').children.length).toBeGreaterThan(0);
  const refresh = runInContext('refresh()', p.context); p.timeout(); await refresh;
  expect(p.get('quota').children).toHaveLength(0);
  expect(p.get('status').textContent).toContain('unavailable');
});

test("persisted page restoration reuses dashboard login after clearing private state", async () => {
  const p = page(() => Promise.reject(Error('must not fetch')), true);
  p.reply(); await settle(); expect(p.get('quota').children.length).toBeGreaterThan(0);
  p.dispatch('pagehide'); expect(p.get('quota').children).toHaveLength(0);
  p.dispatch('pageshow', { persisted: true }); p.reply(); await settle();
  expect(p.get('login').hidden).toBe(true);
  expect(p.get('status').textContent).toContain('Synthetic account');
});

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
