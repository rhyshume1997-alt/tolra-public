/**
 * A small stand-in for the supabase-js client that runs the app's real queries as real SQL on the disposable loopback database
 * (no PostgREST in between). It supports exactly the calls the chase and e-mail schedule code makes: from().select/insert/update/
 * upsert/delete with eq/neq/in/is/not/order/range/limit/maybeSingle/single, the embedded `organizations!inner(status)` read of the
 * schedule list, and rpc(name, namedArgs). Every call is one transaction, run as the given database role with the given JWT claims,
 * so row level security and function grants are the database's own. Values come back the way PostgREST gives them: numeric as
 * numbers, dates as 'YYYY-MM-DD', timestamps as ISO strings.
 *
 * Not PostgREST: it does not prove PostgREST's own parsing, limits or error codes (see the report's "unproven").
 */
import { Pool, type PoolClient, types } from "pg";

import { assertLoopbackUrl } from "./isolation";

export type PgClientOptions = { role: "service_role" | "authenticated" | "anon"; claims?: Record<string, unknown> };
type Result = { data: unknown; error: { code?: string; message: string } | null };

const parsers = {
  getTypeParser: (oid: number, format?: "text" | "binary") => {
    if (oid === 1700 || oid === 701 || oid === 700) return (v: string) => Number(v);
    if (oid === 20) return (v: string) => Number(v);
    if (oid === 1082) return (v: string) => v;
    if (oid === 1184 || oid === 1114) return (v: string) => new Date(oid === 1114 ? `${v}Z` : v).toISOString();
    return types.getTypeParser(oid, format as "text");
  },
};

let shared: Pool | null = null;
export function e2Pool(): Pool {
  if (!shared) {
    const url = assertLoopbackUrl("TEST_DATABASE_URL", process.env.TEST_DATABASE_URL);
    shared = new Pool({ connectionString: url, max: 12, types: parsers as never });
  }
  return shared;
}
export async function closeE2Pool() {
  if (shared) await shared.end();
  shared = null;
}

const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`bad identifier ${name}`);
  return `"${name}"`;
};

async function inRole<T>(options: PgClientOptions, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await e2Pool().connect();
  try {
    await db.query("load 'safeupdate'"); // as the API sessions (Supabase preloads pg-safeupdate): a bare UPDATE or DELETE is refused
    await db.query("begin");
    await db.query(`set local role ${options.role}`);
    if (options.claims) {
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify(options.claims), String(options.claims.sub ?? "")]);
    }
    const out = await fn(db);
    await db.query("commit");
    return out;
  } catch (error) {
    await db.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

const toError = (e: unknown) => ({ code: (e as { code?: string }).code, message: e instanceof Error ? e.message : String(e) });

class Query implements PromiseLike<Result> {
  private action: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private columns = "*";
  private payload: Record<string, unknown> | Record<string, unknown>[] | null = null;
  private conflict: { target: string; ignore: boolean } | null = null;
  private filters: Array<{ sql: (n: number) => string; params: unknown[] }> = [];
  private orders: string[] = [];
  private from_ = 0;
  private to_: number | null = null;
  private limit_: number | null = null;
  private returning = false;
  private mode: "many" | "maybe" | "single" = "many";

  constructor(private readonly options: PgClientOptions, private readonly table: string) {}

  select(columns = "*") { if (this.action === "select") this.columns = columns; else this.returning = true; if (this.action !== "select") this.columns = columns; return this; }
  insert(rows: Record<string, unknown> | Record<string, unknown>[]) { this.action = "insert"; this.payload = rows; return this; }
  upsert(rows: Record<string, unknown>, opts: { onConflict: string; ignoreDuplicates?: boolean }) { this.action = "upsert"; this.payload = rows; this.conflict = { target: opts.onConflict, ignore: !!opts.ignoreDuplicates }; return this; }
  update(patch: Record<string, unknown>) { this.action = "update"; this.payload = patch; return this; }
  delete() { this.action = "delete"; return this; }
  private col(name: string) {
    if (name.startsWith("organizations.")) return `o.${ident(name.slice("organizations.".length))}`;
    return `t.${ident(name)}`;
  }
  eq(c: string, v: unknown) { this.filters.push({ sql: (n) => `${this.col(c)} = $${n}`, params: [v] }); return this; }
  neq(c: string, v: unknown) { this.filters.push({ sql: (n) => `${this.col(c)} <> $${n}`, params: [v] }); return this; }
  in(c: string, v: unknown[]) { this.filters.push({ sql: (n) => `${this.col(c)} = any($${n})`, params: [v] }); return this; }
  is(c: string, v: null | boolean) { this.filters.push({ sql: () => `${this.col(c)} is ${v === null ? "null" : v ? "true" : "false"}`, params: [] }); return this; }
  not(c: string, op: string, v: unknown) {
    if (op === "is") this.filters.push({ sql: () => `${this.col(c)} is not ${v === null ? "null" : String(v)}`, params: [] });
    else if (op === "in") {
      const list = String(v).replace(/^\(|\)$/g, "").split(",").map((x) => x.trim()).filter(Boolean);
      this.filters.push({ sql: (n) => `not (${this.col(c)} = any($${n}))`, params: [list] });
    } else throw new Error(`unsupported not(${op})`);
    return this;
  }
  order(c: string, o: { ascending?: boolean } = {}) { this.orders.push(`${this.col(c)} ${o.ascending === false ? "desc" : "asc"}`); return this; }
  range(from: number, to: number) { this.from_ = from; this.to_ = to; return this; }
  limit(n: number) { this.limit_ = n; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }
  single() { this.mode = "single"; return this; }

  private where(start: number) {
    const params: unknown[] = [];
    const parts = this.filters.map((f) => { const sql = f.sql(start + params.length); params.push(...f.params); return sql; });
    return { sql: parts.length ? ` where ${parts.join(" and ")}` : "", params };
  }

  private async run(): Promise<Result> {
    try {
      return await inRole(this.options, async (db) => {
        const tbl = `public.${ident(this.table)}`;
        let rows: Record<string, unknown>[];
        if (this.action === "select") {
          const embedded = /organizations!inner\(status\)/.test(this.columns);
          const cols = this.columns.replace(/,?\s*organizations!inner\(status\)/, "").trim() || "*";
          const w = this.where(1);
          const list = cols === "*" ? "t.*" : cols.split(",").map((c) => `t.${ident(c.trim())}`).join(", ");
          const text = `select ${list}${embedded ? ", jsonb_build_object('status', o.status) as organizations" : ""} from ${tbl} t${embedded ? " join public.organizations o on o.id = t.organization_id" : ""}${w.sql}${this.orders.length ? ` order by ${this.orders.join(", ")}` : ""}${this.to_ !== null ? ` limit ${this.to_ - this.from_ + 1} offset ${this.from_}` : this.limit_ !== null ? ` limit ${this.limit_}` : ""}`;
          rows = (await db.query(text, w.params)).rows;
        } else if (this.action === "insert" || this.action === "upsert") {
          const list = Array.isArray(this.payload) ? this.payload : [this.payload as Record<string, unknown>];
          const keys = Object.keys(list[0]);
          const params: unknown[] = [];
          const values = list.map((r) => `(${keys.map((k) => { params.push(r[k]); return `$${params.length}`; }).join(", ")})`).join(", ");
          const conflict = this.conflict ? ` on conflict (${this.conflict.target.split(",").map((c) => ident(c.trim())).join(", ")}) do nothing` : "";
          rows = (await db.query(`insert into ${tbl} (${keys.map(ident).join(", ")}) values ${values}${conflict} returning ${this.returning || this.action === "upsert" ? this.returningList() : "1 as _"}`, params)).rows;
        } else if (this.action === "update") {
          const patch = this.payload as Record<string, unknown>;
          const keys = Object.keys(patch);
          const set = keys.map((k, i) => `${ident(k)} = $${i + 1}`).join(", ");
          const w = this.where(keys.length + 1);
          rows = (await db.query(`update ${tbl} t set ${set}${w.sql} returning ${this.returning ? this.returningList() : "1 as _"}`, [...keys.map((k) => patch[k]), ...w.params])).rows;
        } else {
          const w = this.where(1);
          rows = (await db.query(`delete from ${tbl} t${w.sql} returning ${this.returning ? this.returningList() : "1 as _"}`, w.params)).rows;
        }
        const shown = this.action === "select" || this.returning || this.action === "upsert" ? rows : null;
        if (this.mode === "many") return { data: shown, error: null };
        if (!shown || shown.length === 0) return this.mode === "maybe" ? { data: null, error: null } : { data: null, error: { code: "PGRST116", message: "no rows" } };
        if (shown.length > 1) return { data: null, error: { code: "PGRST116", message: "more than one row" } };
        return { data: shown[0], error: null };
      });
    } catch (e) {
      return { data: null, error: toError(e) };
    }
  }
  private returningList() { return this.columns === "*" ? "*" : this.columns.split(",").map((c) => ident(c.trim())).join(", "); }

  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return this.run().then(ok, bad);
  }
}

/** Cast to SupabaseClient where the code under test wants one. */
export function pgClient(options: PgClientOptions) {
  return {
    from: (table: string) => new Query(options, table),
    rpc: async (fn: string, args: Record<string, unknown> = {}): Promise<Result> => {
      try {
        return await inRole(options, async (db) => {
          const keys = Object.keys(args);
          const call = `public.${ident(fn)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(", ")})`;
          const { rows } = await db.query(`select ${call} as r`, keys.map((k) => args[k]));
          return { data: rows[0]?.r ?? null, error: null };
        });
      } catch (e) {
        return { data: null, error: toError(e) };
      }
    },
  };
}
