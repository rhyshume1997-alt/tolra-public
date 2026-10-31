// A small in-memory stand-in for the Supabase query builder, for the e-mail schedule tests: only the calls those modules make
// (select/eq/neq/lt/not/in/or/order/range/limit, upsert with ignoreDuplicates, update, delete, maybeSingle). Rows are plain objects.
export type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;
type Result = { data: unknown; error: { code?: string; message: string } | null };

export class FakeDb {
  tables: Record<string, Row[]>;
  /** table -> error returned for every call on it (e.g. a missing table). */
  failing: Record<string, { code: string; message: string }> = {};
  /** Every write, in order, for assertions. */
  log: Array<{ table: string; op: string; value?: unknown }> = [];
  /** uniqueness: table -> columns. */
  unique: Record<string, string[]> = {};

  constructor(tables: Record<string, Row[]> = {}) {
    this.tables = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  }

  from(table: string) {
    return new Query(this, table);
  }
  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }
}

class Query implements PromiseLike<Result> {
  private filters: Filter[] = [];
  private mode: "select" | "update" | "delete" | "upsert" = "select";
  private patch: Row = {};
  private upsertRow: Row = {};
  private upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private orderBy: Array<{ col: string }> = [];
  private slice: [number, number] | null = null;
  private single = false;
  private wantRows = false;

  constructor(private db: FakeDb, private table: string) {}

  select(...columns: unknown[]) {
    void columns;
    if (this.mode === "select" || this.mode === "update" || this.mode === "upsert") this.wantRows = true;
    return this;
  }
  eq(col: string, value: unknown) {
    // "organizations.status": a join the real query makes; the fake looks the company up.
    if (col.includes(".")) {
      const [joined, field] = col.split(".");
      this.filters.push((r) => this.db.rows(joined).find((o) => o.id === r.organization_id)?.[field] === value);
    } else this.filters.push((r) => r[col] === value);
    return this;
  }
  neq(col: string, value: unknown) { this.filters.push((r) => r[col] !== value); return this; }
  lt(col: string, value: string) { this.filters.push((r) => r[col] != null && String(r[col]) < value); return this; }
  in(col: string, values: unknown[]) { this.filters.push((r) => values.includes(r[col])); return this; }
  not(col: string, op: string, value: unknown) {
    if (op === "is") this.filters.push((r) => (value === null ? r[col] !== null && r[col] !== undefined : r[col] !== value));
    else if (op === "in") {
      const list = String(value).replace(/^\(|\)$/g, "").split(",");
      this.filters.push((r) => r[col] !== null && r[col] !== undefined && !list.includes(String(r[col])));
    }
    return this;
  }
  or(expr: string) {
    const parts = expr.split(",").map((p) => p.split("."));
    this.filters.push((r) => parts.some(([col, op, value]) => op === "eq" && r[col] === value));
    return this;
  }
  order(col: string) { this.orderBy.push({ col }); return this; }
  range(from: number, to: number) { this.slice = [from, to]; return this; }
  limit(n: number) { this.slice = [0, n - 1]; return this; }
  maybeSingle() { this.single = true; return this; }
  update(patch: Row) { this.mode = "update"; this.patch = patch; return this; }
  delete() { this.mode = "delete"; return this; }
  upsert(row: Row, opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}) { this.mode = "upsert"; this.upsertRow = row; this.upsertOpts = opts; return this; }

  private run(): Result {
    const failure = this.db.failing[this.table];
    if (failure) return { data: null, error: failure };
    const rows = this.db.rows(this.table);
    const match = (r: Row) => this.filters.every((f) => f(r));
    if (this.mode === "upsert") {
      const keys = (this.upsertOpts.onConflict ?? "").split(",").filter(Boolean);
      const existing = keys.length ? rows.find((r) => keys.every((k) => r[k] === this.upsertRow[k])) : undefined;
      this.db.log.push({ table: this.table, op: "upsert", value: this.upsertRow });
      if (existing && this.upsertOpts.ignoreDuplicates) return { data: this.wantRows ? [] : null, error: null };
      if (existing) { Object.assign(existing, this.upsertRow); return { data: this.wantRows ? [{ ...existing }] : null, error: null }; }
      const row = { ...this.upsertRow };
      rows.push(row);
      return { data: this.wantRows ? [{ ...row }] : null, error: null };
    }
    if (this.mode === "update") {
      const hit = rows.filter(match);
      for (const r of hit) Object.assign(r, this.patch);
      this.db.log.push({ table: this.table, op: "update", value: this.patch });
      return { data: this.wantRows ? hit.map((r) => ({ ...r })) : null, error: null };
    }
    if (this.mode === "delete") {
      const hit = rows.filter(match);
      this.db.tables[this.table] = rows.filter((r) => !hit.includes(r));
      this.db.log.push({ table: this.table, op: "delete" });
      return { data: null, error: null };
    }
    let out = rows.filter(match).map((r) => ({ ...r }));
    for (const { col } of [...this.orderBy].reverse()) out = out.sort((a, b) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")));
    if (this.slice) out = out.slice(this.slice[0], this.slice[1] + 1);
    return { data: this.single ? (out[0] ?? null) : out, error: null };
  }

  then<R1 = Result, R2 = never>(onfulfilled?: ((value: Result) => R1 | PromiseLike<R1>) | null, onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null): PromiseLike<R1 | R2> {
    return Promise.resolve().then(() => this.run()).then(onfulfilled, onrejected);
  }
}
