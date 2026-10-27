import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { QuotaError } from './mimo';
import type { QuotaSnapshot, QuotaErrorCode } from './types';

export interface CollectorOptions {
  cookieFile: string;
  accountLabel: string;
  fetchSnapshot: (cookie: string, now: Date, signal: AbortSignal) => Promise<QuotaSnapshot>;
  now?: () => Date;
  pollIntervalMs?: number;
}
async function readCookie(path: string): Promise<string> {
  // Open first with O_NOFOLLOW; fstat the same descriptor to avoid symlink/permission races.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || stat.size > 16385) throw new Error('Invalid secret');
    const cookie = (await file.readFile('utf8')).trim();
    if (!cookie || cookie.length > 16384 || /[\x00-\x1f\x7f]/.test(cookie)) throw new Error('Invalid secret');
    return cookie;
  } finally { await file.close(); }
}
export function createCollector(options: CollectorOptions): {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
} {
  const now = options.now ?? (() => new Date());
  let snapshot: QuotaSnapshot = {
    schemaVersion: 1, region: 'sgp', accountLabel: options.accountLabel, planName: null,
    pools: [], fetchedAt: null, expiresAt: null, expired: null, resetsAt: null, stale: true, error: 'unavailable',
  };
  let closed = false, halted = false, pending: Promise<void> | null = null;
  const controller = new AbortController();
  async function refresh() {
    if (closed || halted || pending) return;
    pending = (async () => {
      try {
        let cookie: string;
        try { cookie = await readCookie(options.cookieFile); }
        catch { throw new QuotaError('auth_required'); }
        const next = await options.fetchSnapshot(cookie, now(), controller.signal);
        if (!closed) snapshot = next;
      } catch (error) {
        const code: QuotaErrorCode = error instanceof QuotaError ? error.code : 'unavailable';
        if (code === 'auth_required') halted = true;
        if (!closed) snapshot = { ...snapshot, stale: true, error: code };
      }
    })();
    try { await pending; } finally { pending = null; }
  }
  const initial = refresh();
  const timer = setInterval(() => { void refresh(); }, options.pollIntervalMs ?? 300000);
  return {
    async fetch(request) {
      const url = new URL(request.url);
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      if (request.method !== 'GET') return new Response(null, { status: 405, headers: {...headers, Allow: 'GET'} });
      if (url.search || !['/healthz', '/v1/quota'].includes(url.pathname)) return new Response(null, { status: 404, headers });
      if (url.pathname === '/healthz') return Response.json({ ok: true }, { headers });
      await initial;
      const age = snapshot.fetchedAt === null ? Infinity : now().getTime() - Date.parse(snapshot.fetchedAt);
      return Response.json({ ...snapshot, stale: snapshot.stale || age > 600000 || age < 0 }, { headers });
    },
    async close() {
      closed = true;
      clearInterval(timer);
      controller.abort();
      await pending;
    },
  };
}
