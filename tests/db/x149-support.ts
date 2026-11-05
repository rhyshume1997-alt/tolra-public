/**
 * X149 test support (adapted from the W-X proof) (not a test file): a supabase-js-shaped client backed directly by a disposable PostgreSQL (service role or a signed-in
 * user, as PostgREST would run each call: one transaction, `set local role`, JWT claims), and a STUBBED Xero HTTP transport that records
 * every call and keeps a tiny in-memory Xero. No network: any host other than loopback, api.xero.com and identity.xero.com is refused.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

/** `recentCode`: the user entered an authenticator code that many seconds ago (aal2 with a totp amr entry, as GoTrue issues it). */
export type Who = { kind: "service" } | { kind: "user"; id: string; recentCode?: number };

const parsers = (oid: number, format?: "text" | "binary") => {
  if (oid === 1700 || oid === 20) return (v: string) => Number(v);
  if (oid === 1184) return (v: string) => new Date(v).toISOString();
  if (oid === 1082) return (v: string) => v;
  return pg.types.getTypeParser(oid, format as "text");
};

type Filter = [op: string, col: string, val: unknown];

class Query implements PromiseLike<{ data: unknown; error: { message: string; code?: string; hint?: string } | null }> {
  private filters: Filter[] = [];
  private orders: Array<[string, boolean]> = [];
  private lim: number | null = null;
  private cols = "*";
  private mode: "select" | "upsert" = "select";
  private row: Record<string, unknown> | null = null;
  private conflict: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private one: "maybe" | "single" | null = null;
  constructor(private url: string, private who: Who, private table: string) {}
  select(cols = "*") { this.cols = cols; return this; }
  eq(c: string, v: unknown) { this.filters.push(["=", c, v]); return this; }
  neq(c: string, v: unknown) { this.filters.push(["<>", c, v]); return this; }
  lte(c: string, v: unknown) { this.filters.push(["<=", c, v]); return this; }
  gt(c: string, v: unknown) { this.filters.push([">", c, v]); return this; }
  in(c: string, v: unknown[]) { this.filters.push(["in", c, v]); return this; }
  order(c: string, o: { ascending?: boolean } = {}) { this.orders.push([c, o.ascending !== false]); return this; }
  limit(n: number) { this.lim = n; return this; }
  maybeSingle() { this.one = "maybe"; return this; }
  upsert(row: Record<string, unknown>, o: { onConflict?: string; ignoreDuplicates?: boolean } = {}) { this.mode = "upsert"; this.row = row; this.conflict = o; return this; }
  then<R1, R2>(ok?: (v: { data: unknown; error: { message: string; code?: string; hint?: string } | null }) => R1 | PromiseLike<R1>, bad?: (e: unknown) => R2 | PromiseLike<R2>) {
    return this.run().then(ok, bad);
  }
  private async run() {
    const params: unknown[] = [];
    let sql: string;
    if (this.mode === "upsert") {
      const keys = Object.keys(this.row!);
      keys.forEach((k) => params.push(this.row![k]));
      sql = `insert into public.${this.table} (${keys.map((k) => `"${k}"`).join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")}) on conflict (${this.conflict.onConflict}) ${this.conflict.ignoreDuplicates ? "do nothing" : "do update set " + keys.map((k) => `"${k}"=excluded."${k}"`).join(",")}`;
    } else {
      const where = this.filters.map(([op, c, v]) => {
        params.push(v);
        return op === "in" ? `"${c}" = any($${params.length})` : `"${c}" ${op} $${params.length}`;
      });
      sql = `select ${this.cols} from public.${this.table}${where.length ? " where " + where.join(" and ") : ""}`
        + (this.orders.length ? " order by " + this.orders.map(([c, a]) => `"${c}" ${a ? "asc" : "desc"}`).join(",") : "")
        + (this.lim !== null ? ` limit ${this.lim}` : "");
    }
    try {
      const rows = await inRole(this.url, this.who, async (db) => (await db.query(sql, params)).rows);
      if (this.mode === "upsert") return { data: null, error: null };
      if (this.one) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    } catch (e) {
      const err = e as { message: string; code?: string; hint?: string };
      return { data: null, error: { message: err.message, code: err.code, hint: err.hint } };
    }
  }
}

export async function inRole<T>(url: string, who: Who, fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: url, types: { getTypeParser: parsers } as never });
  await db.connect();
  try {
    await db.query("begin");
    if (who.kind === "service") await db.query("set local role service_role");
    else {
      await db.query("set local role authenticated");
      const code = who.recentCode === undefined ? {} : { aal: "aal2", amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) - who.recentCode }] };
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: who.id, role: "authenticated", aud: "authenticated", session_id: randomUUID(), aal: "aal1", ...code })]);
    }
    const out = await fn(db);
    await db.query("commit");
    return out;
  } catch (e) {
    await db.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    await db.end();
  }
}

/** The supabase-js subset the Xero server code uses, over the disposable database at `url`. */
export function pgSupabase(url: string, who: Who): SupabaseClient {
  if (!/^postgresql:\/\/[^@]*@127\.0\.0\.1:(?:54322|54[5-9]\d\d)\//.test(url)) throw new Error("x149-support: refusing a database that is not loopback 54322 (the test stack) or 545xx to 549xx");
  return {
    from: (table: string) => new Query(url, who, table),
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      const keys = Object.keys(args);
      const sql = `select public.${fn}(${keys.map((k, i) => `${k} := $${i + 1}`).join(",")}) as r`;
      try {
        const rows = await inRole(url, who, async (db) => (await db.query(sql, keys.map((k) => args[k]))).rows);
        const v = rows[0]?.r;
        return { data: v === "" ? null : v, error: null };
      } catch (e) {
        const err = e as { message: string; code?: string; hint?: string };
        return { data: null, error: { message: err.message, code: err.code, hint: err.hint } };
      }
    },
  } as unknown as SupabaseClient;
}

// ---------------------------------------------------------------- the stubbed Xero

export type XeroCall = { host: string; method: string; path: string; headers: Record<string, string>; body: unknown; tenant: string | null };

export function createXeroStub(realFetch: typeof fetch) {
  const calls: XeroCall[] = [];
  const contacts = new Map<string, Map<string, string>>(); // tenant -> name -> id
  const docs = new Map<string, Map<string, Record<string, unknown>>>(); // tenant -> number -> doc
  const byKey = new Map<string, unknown>();
  const hold = { failWith: null as null | { status: number } };
  const hook = { onCall: null as null | ((c: XeroCall) => Promise<void>) };
  const tenantMap = <T>(m: Map<string, Map<string, T>>, t: string) => { if (!m.has(t)) m.set(t, new Map()); return m.get(t)!; };
  const r2 = (n: number) => Math.round(n * 100) / 100;

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
    if (url.hostname === "127.0.0.1") return realFetch(input as never, init);
    if (url.hostname !== "api.xero.com" && url.hostname !== "identity.xero.com") throw new Error(`x149 stub: blocked host ${url.hostname}`);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } } else if (init?.body instanceof URLSearchParams) body = Object.fromEntries(init.body);
    const tenant = headers["xero-tenant-id"] ?? null;
    const path = url.pathname + url.search;
    const rec = { host: url.hostname, method, path, headers, body, tenant };
    calls.push(rec);
    if (hook.onCall) await hook.onCall(rec);
    if (hold.failWith) return json(hold.failWith.status, {});
    if (url.hostname === "identity.xero.com") {
      return json(200, { access_token: `acc-${randomUUID()}`, refresh_token: `ref-${randomUUID()}`, expires_in: 1800 });
    }
    const t = tenant ?? "none";
    const p = url.pathname.replace("/api.xro/2.0", "");
    if (method === "GET" && p === "/Contacts") {
      const name = /Name=="(.*)"/.exec(url.searchParams.get("where") ?? "")?.[1] ?? "";
      const id = tenantMap(contacts, t).get(name);
      return json(200, { Contacts: id ? [{ ContactID: id, Name: name, ContactStatus: "ACTIVE" }] : [] });
    }
    if (method === "PUT" && p === "/Contacts") {
      const name = (body as { Contacts: Array<{ Name: string }> }).Contacts[0].Name;
      const id = randomUUID(); tenantMap(contacts, t).set(name, id);
      return json(200, { Contacts: [{ ContactID: id, Name: name }] });
    }
    if (method === "PUT" && (p === "/Invoices" || p === "/CreditNotes")) {
      const invoice = p === "/Invoices";
      const key = headers["idempotency-key"];
      if (key && byKey.has(key)) return json(200, byKey.get(key));
      const doc = (invoice ? (body as { Invoices: Array<Record<string, unknown>> }).Invoices : (body as { CreditNotes: Array<Record<string, unknown>> }).CreditNotes)[0];
      const lines = (doc.LineItems as Array<{ Quantity?: number; UnitAmount?: number; TaxAmount?: number }>);
      const sub = r2(lines.reduce((s, l) => s + (l.Quantity !== undefined ? l.Quantity * (l.UnitAmount ?? 0) : 0), 0));
      const tax = r2(lines.reduce((s, l) => s + (l.TaxAmount ?? 0), 0));
      const number = String(invoice ? doc.InvoiceNumber : doc.CreditNoteNumber);
      const stored = invoice
        ? { InvoiceID: randomUUID(), InvoiceNumber: number, Type: "ACCREC", Status: "AUTHORISED", SubTotal: sub, TotalTax: tax, Total: r2(sub + tax) }
        : { CreditNoteID: randomUUID(), CreditNoteNumber: number, Type: "ACCRECCREDIT", Status: "AUTHORISED", SubTotal: sub, TotalTax: tax, Total: r2(sub + tax) };
      tenantMap(docs, t).set(`${p}:${number}`, stored);
      const answer = invoice ? { Invoices: [stored] } : { CreditNotes: [stored] };
      if (key) byKey.set(key, answer);
      return json(200, answer);
    }
    if (method === "POST" && p.startsWith("/Invoices/")) {
      const id = decodeURIComponent(p.split("/")[2]);
      for (const d of tenantMap(docs, t).values()) if (d.InvoiceID === id) { d.Status = "VOIDED"; return json(200, { Invoices: [d] }); }
      return json(404, { Message: "not found" });
    }
    if (method === "GET" && p === "/Invoices") {
      const n = url.searchParams.get("InvoiceNumbers") ?? "";
      const d = tenantMap(docs, t).get(`/Invoices:${n}`);
      return json(200, { Invoices: d ? [d] : [] });
    }
    if (method === "GET" && p === "/CreditNotes") {
      const n = /CreditNoteNumber=="(.*)"/.exec(url.searchParams.get("where") ?? "")?.[1] ?? "";
      const d = tenantMap(docs, t).get(`/CreditNotes:${n}`);
      return json(200, { CreditNotes: d ? [d] : [] });
    }
    if (method === "GET" && p === "/Accounts") return json(200, { Accounts: [] });
    if (method === "GET" && p === "/TaxRates") return json(200, { TaxRates: [] });
    return json(404, { Message: `x149 stub: not implemented ${method} ${p}` });
  }) as typeof fetch;

  return {
    stub, calls, docs, contacts, hold, hook,
    writes: () => calls.filter((c) => c.host === "api.xero.com" && c.method !== "GET"),
    identity: () => calls.filter((c) => c.host === "identity.xero.com"),
    reset: () => { calls.length = 0; },
  };
}
