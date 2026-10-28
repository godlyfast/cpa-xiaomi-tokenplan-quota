import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

// Run the actual resource script, mocking only browser/network boundaries.
// Assertions concern UI behavior, never calls to the mock.
class Element {
  constructor(readonly tagName = "") {}
  textContent = ""; value = ""; hidden = false; className = ""; children: Element[] = [];
  listeners = new Map<string, () => void>();
  replaceChildren() { this.children = []; }
  append(...children: Element[]) { this.children.push(...children); }
  setAttribute() {}
  addEventListener(name: string, cb: () => void) { this.listeners.set(name, cb); }
}
const source = readFileSync(new URL("./quota.html", import.meta.url), "utf8").match(/<script>([\s\S]*?)<\/script>/)![1];
function page(fetch: () => Promise<Response>, embedded = false) {
  const elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  get("status").textContent = "Management authentication required. No quota is public.";
  const messages: Record<string, unknown>[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const timeouts = new Map<number, () => void>(); let nextTimer = 0;
  const parent = { location: { origin: 'http://127.0.0.1:8317' }, postMessage: (data: Record<string, unknown>) => messages.push(data) };
  const window = { location: { origin: 'http://127.0.0.1:8317' }, parent: embedded ? parent : undefined, addEventListener: (name: string, cb: (event: unknown) => void) => listeners.set(name, cb) };
  const context = createContext({ fetch, document: { hidden: false, getElementById: get, createElement: (tag: string) => new Element(tag), addEventListener() {} }, window, crypto: { getRandomValues: (bytes: Uint8Array) => { bytes.fill(++nextTimer); return bytes; } }, AbortSignal, AbortController, setInterval() {}, clearInterval() {}, setTimeout: (cb: () => void) => { const id = ++nextTimer; timeouts.set(id, cb); return id; }, clearTimeout: (id: number) => timeouts.delete(id) });
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

// v0.3.0 session/renewal guidance. Times are relative to the real clock the page script also reads.
const MIN = 60000, H = 60 * MIN;
const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
const text = (e: Element): string => [e.textContent, ...e.children.map(text)].filter(Boolean).join(" ");
const codes = (e: Element): Element[] => [...(e.tagName === "code" ? [e] : []), ...e.children.flatMap(codes)];
const agent = (result: string, checkedAt = iso(-2 * MIN), manualCommand: string | null = "bun refresher/refresh-session.ts --synthetic") => ({ checkedAt, result, renewedAt: iso(-2 * MIN), host: "synthetic-host", manualCommand });
const v3 = (over: Record<string, unknown> = {}) => ({ ...fixture, fetchedAt: iso(-2 * MIN), session: { state: "ok", updatedAt: iso(-3 * H), rejectedAt: null, lastAttemptAt: iso(-2 * MIN), nextAttemptAt: iso(3 * MIN) }, renewal: { ...agent("not_needed", iso(-4 * MIN), null), renewedAt: iso(-3 * H) }, ...over });
const rejected = (renewal: unknown, state = "expired", rejectedAt = iso(-1 * H)) => v3({ stale: true, error: "auth_required", fetchedAt: iso(-2 * H), session: { state, updatedAt: iso(-25 * H), rejectedAt, lastAttemptAt: rejectedAt, nextAttemptAt: null }, renewal });
async function render(snapshot: unknown) {
  const p = page(() => Promise.resolve(Response.json(snapshot)));
  p.login(); await settle();
  const help = text(p.get("help"));
  for (const bad of ["undefined", "null", "NaN", "Invalid Date", "[object", "log out", "logout", "sign out"]) expect(help.toLowerCase()).not.toContain(bad.toLowerCase());
  return { ...p, help, status: p.get("status").textContent };
}

test("healthy session shows a compact session and renewal summary", async () => {
  const p = await render(v3());
  expect(p.help).toContain("Session & renewal"); expect(p.help).toContain("Session OK");
  expect(p.help).toContain("session file updated 3 h ago ("); expect(p.help).toContain("about 24 h");
  expect(p.help).toContain("Renewal agent on synthetic-host: last check 4 min ago ("); expect(p.help).toContain("last renewal 3 h ago");
  expect(p.help).not.toContain("What to do"); expect(p.status).toContain("Fresh");
  expect(p.get("quota").children.length).toBeGreaterThan(0);
});
test("healthy session without a renewal agent says nothing renews it", async () => {
  for (const renewal of [null, undefined]) {
    const p = await render(v3({ renewal }));
    expect(p.help).toContain("No renewal agent reporting"); expect(p.help).toContain("Session OK");
  }
});
test("healthy session warns early when the renewal agent cannot renew", async () => {
  let p = await render(v3({ renewal: agent("not_needed", iso(-40 * MIN)) }));
  expect(p.help).toContain("40 min ago"); expect(p.help).toContain("asleep");
  p = await render(v3({ renewal: agent("signin_required") }));
  expect(p.help).toContain("Sign in at the Xiaomi console"); expect(p.help).toContain("synthetic-host before the current session expires");
  p = await render(v3({ renewal: agent("browser_unavailable") }));
  expect(p.help).toContain("Start the renewal browser on synthetic-host");
});
test("rejected session explains what happened and what to do for every renewal state", async () => {
  const cases: [string, unknown, string[]][] = [
    ["no agent", null, ["No renewal agent is reporting", "refresher/refresh-session.ts", "signed in to the Xiaomi console", "replace the session file by hand"]],
    ["renewed", agent("renewed"), ["installed a new session 2 min ago", "waiting for the collector to pick it up", "whole session directory"]],
    ["signin", agent("signin_required"), ["At its last check 2 min ago (", "found its browser not signed in to Xiaomi", "On synthetic-host, sign in at the Xiaomi console", "then rerun the session refresher there", "Run on synthetic-host:"]],
    ["browser", agent("browser_unavailable"), ["could not reach the renewal browser", "Start the renewal browser on synthetic-host"]],
    ["vendor", agent("vendor_unavailable"), ["could not reach Xiaomi", "next run"]],
    ["error", agent("error"), ["failed unexpectedly", "output on synthetic-host"]],
    ["not needed", agent("not_needed"), ["found its browser session healthy", "Xiaomi rejected the collector's copy", "with --force", "Run on synthetic-host, adding --force:"]],
    ["not needed, forced command", agent("not_needed", iso(-2 * MIN), "bun refresher/refresh-session.ts --force"), ["with --force", "Run on synthetic-host: "]],
    ["stale agent", agent("signin_required", iso(-40 * MIN)), ["last reported 40 min ago (", "— browser not signed in to Xiaomi", "asleep or its renewal timer stopped"]],
  ];
  for (const [name, renewal, wants] of cases) {
    const p = await render(rejected(renewal));
    for (const want of ["What happened", "What to do", "Xiaomi rejected the collector's console session 1 h ago (", "last replaced 25 h ago (", "about 24 h", "last known, fetched 2 h ago", ...wants]) {
      if (!p.help.includes(want)) throw Error(`${name}: missing ${JSON.stringify(want)} in ${p.help}`);
    }
    expect(p.status).toContain("Xiaomi session rejected");
    expect(p.get("quota").children.length).toBeGreaterThan(0);
    if (name !== "renewed") expect(p.help).toContain("reloads a replaced session file within about 15 s");
  }
  const pending = await render(rejected(agent("not_needed", iso(-8 * MIN)), "expired", iso(-5 * MIN)));
  expect(pending.help).toContain("last checked 8 min ago"); expect(pending.help).toContain("its next run should install a new session");
  const retry = await render({ ...rejected(null), session: { ...rejected(null).session, nextAttemptAt: iso(4 * MIN) } });
  expect(retry.help).toContain("otherwise it next contacts Xiaomi in 4 min (");
});
test("manual renewal command renders verbatim as code text", async () => {
  const command = `bun refresher/refresh-session.ts --label "<b>synthetic</b>" && echo '&amp;'`;
  const p = await render(rejected(agent("signin_required", iso(-2 * MIN), command)));
  const blocks = codes(p.get("help"));
  expect(blocks).toHaveLength(1); expect(blocks[0].textContent).toBe(command); expect(blocks[0].children).toHaveLength(0);
  expect(p.help).toContain("Run on synthetic-host:");
  expect(codes((await render(rejected(agent("signin_required", iso(-2 * MIN), null)))).get("help"))).toHaveLength(0);
});
test("missing and unusable session files explain the file requirements", async () => {
  let p = await render(rejected(agent("not_needed"), "missing"));
  expect(p.status).toContain("Session file missing");
  expect(p.help).toContain("cannot find its Xiaomi session file. First noticed 1 h ago ("); expect(p.help).toContain("owner-only"); expect(p.help).toContain("the collector has no session file");
  p = await render(rejected(null, "invalid_file"));
  expect(p.status).toContain("Session file unusable");
  expect(p.help).toContain("cannot use its Xiaomi session file"); expect(p.help).toContain("not a symlink"); expect(p.help).toContain("one Cookie header line");
});
test("older collectors without session details get generic restart guidance", async () => {
  const { session: _s, renewal: _r, ...old } = rejected(null);
  let p = await render(old);
  expect(p.help).toContain("predates 0.3.0"); expect(p.help).toContain("Restart the collector"); expect(p.status).toContain("Xiaomi session rejected");
  p = await render(fixture);
  expect(p.help).toContain("Session details not reported"); expect(p.help).not.toContain("What to do"); expect(p.help).not.toContain("No renewal agent");
});
test("vendor, network, staleness and subscription problems get specific guidance", async () => {
  let p = await render(v3({ stale: true, error: "schema_changed" }));
  expect(p.help).toContain("does not understand"); expect(p.help).toContain("updated collector release"); expect(p.help).toContain("Session OK"); expect(p.status).toContain("Vendor response changed");
  p = await render(v3({ stale: true, error: "unavailable" }));
  expect(p.help).toContain("on its last attempt, 2 min ago ("); expect(p.help).toContain("retries every 5 min; next attempt in 3 min ("); expect(p.status).toContain("Xiaomi unreachable");
  p = await render(v3({ stale: true, fetchedAt: iso(-20 * MIN) }));
  expect(p.help).toContain("more than 10 min"); expect(p.help).toContain("20 min ago"); expect(p.status).toContain("STALE");
  p = await render(v3({ expired: true, expiresAt: iso(-1 * H) }));
  expect(p.help).toContain("expired 1 h ago"); expect(p.help).toContain("Renew the Token Plan in the Xiaomi console"); expect(p.status).toContain("Subscription expired");
});
test("snapshot failures explain the collector problem without asserting a balance", async () => {
  for (const fetch of [() => Promise.resolve(new Response(null, { status: 503 })), () => Promise.reject(TypeError("network")), () => Promise.resolve(Response.json({ schemaVersion: 2 }))]) {
    const p = page(fetch);
    p.login(); await settle();
    const help = text(p.get("help"));
    expect(p.get("status").textContent).toContain("Quota unavailable"); expect(p.get("status").textContent).toContain("no current balance");
    for (const want of ["What happened", "collector", "not attached to the gateway", "every 60 s", "Refresh"]) expect(help).toContain(want);
    expect(p.get("quota").children).toHaveLength(0);
  }
});
test("disconnect removes session guidance along with private quota", async () => {
  const p = await render(rejected(agent("signin_required")));
  runInContext("disconnect()", p.context);
  expect(p.get("help").children).toHaveLength(0); expect(p.get("quota").children).toHaveLength(0);
});
test("page source never writes HTML and links only to the Xiaomi console", () => {
  const html = readFileSync(new URL("./quota.html", import.meta.url), "utf8");
  for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "Function(", "localStorage", "sessionStorage", "document.cookie", ".href", "setAttribute('href"]) expect(html).not.toContain(sink);
  expect(html.match(/href=/g)).toHaveLength(1);
  expect(html.match(/https?:\/\//g)).toHaveLength(1);
  expect(html).toContain('<a href="https://platform.xiaomimimo.com/#/console/plan-manage" target="_blank" rel="noopener noreferrer">Xiaomi console</a>');
  expect(html).not.toContain("Reauthentication of the Xiaomi session is a separate operator action");
});
test("relative times cover just now, minutes, hours and days alongside UTC", async () => {
  const updatedAt = iso(-10_000), renewedAt = iso(-3 * 24 * H);
  const p = await render(v3({ session: { ...v3().session, updatedAt }, renewal: { ...agent("not_needed", iso(-12 * MIN), null), renewedAt } }));
  expect(p.help).toContain(`updated just now (${updatedAt})`); expect(p.help).toContain("last check 12 min ago (");
  expect(p.help).toContain(`last renewal 3 d ago (${renewedAt})`);
});
