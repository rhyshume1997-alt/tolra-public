/**
 * The global search route (GET /api/search) and lib/global-search.ts:
 *   - same-origin and signed-in only; any role, but each role only gets the groups its pages allow (workshop and viewer: Jobs only);
 *     an admin's hidden page hides its group (and line text when both quotes and invoices are hidden);
 *   - reads go through the caller's own client only (the service role is never created), filtered to the caller's company;
 *   - ilike wildcards the person typed are escaped; filter-structure characters cannot add conditions; length cap 100;
 *   - under 2 characters reads nothing; at most 5 per group; groups come back in order, empty ones left out;
 *   - customer_po is asked for and, when the database has no such column yet, asked again without it;
 *   - a group that fails or times out is named in `unavailable` and the rest still answer;
 *   - every result links to the page that already opens that record.
 */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Call = { table: string; select: string; eq: Array<[string, unknown]>; or?: string; ilike?: [string, string]; limit?: number };

const db = vi.hoisted(() => ({
  calls: [] as Call[],
  rows: {} as Record<string, Row[]>,
  /** Table -> select text that fails with this error (e.g. the customer_po column is not there yet). */
  failWhen: [] as Array<{ table: string; includes: string; error: { code: string; message: string } }>,
  hang: new Set<string>(),
}));

function builder(table: string) {
  const call: Call = { table, select: "", eq: [] };
  const q = {
    select: (cols: string) => { call.select = cols; return q; },
    eq: (column: string, value: unknown) => { call.eq.push([column, value]); return q; },
    or: (filter: string) => { call.or = filter; return q; },
    ilike: (column: string, pattern: string) => { call.ilike = [column, pattern]; return q; },
    order: () => q,
    limit: (n: number) => {
      call.limit = n;
      db.calls.push(call);
      if (db.hang.has(table)) return new Promise(() => undefined);
      const failure = db.failWhen.find((f) => f.table === table && call.select.includes(f.includes));
      if (failure) return Promise.resolve({ data: null, error: failure.error });
      return Promise.resolve({ data: (db.rows[table] ?? []).slice(0, n), error: null });
    },
  };
  return q;
}
const supabase = { from: (table: string) => builder(table) };

const auth = vi.hoisted(() => ({ role: "office", secondary: null as string | null, hidden: [] as string[], support: false, sameOrigin: true, status: 200 as number }));
vi.mock("@/lib/server/auth", () => ({
  sameOrigin: () => auth.sameOrigin,
  forbiddenOrigin: () => NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  isErrorResponse: (v: unknown) => v instanceof NextResponse,
  requireProfile: vi.fn(async () => {
    if (auth.status !== 200) return NextResponse.json({ error: "Unauthorized" }, { status: auth.status });
    return {
      supabase,
      user: { id: "u-1" },
      profile: { id: "u-1", organization_id: "org-1", role: auth.role, secondary_role: auth.secondary },
      session: { support: auth.support, hidden_sections: auth.hidden },
    };
  }),
}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => { throw new Error("service role used"); } }));

import { GET } from "@/app/api/search/route";
import { allowedGroups, likePattern, missingColumn, normaliseQuery, runSearch, type SearchClient } from "@/lib/global-search";

const get = (q: string | null, init?: RequestInit) => GET(new Request(`http://localhost/api/search${q === null ? "" : `?q=${encodeURIComponent(q)}`}`, init));
type Answer = { query: string; groups: Array<{ key: string; label: string; results: Array<{ id: string; title: string; subtitle: string; href: string }> }>; unavailable: string[] };
const answer = async (q: string | null) => (await (await get(q)).json()) as Answer;

beforeEach(() => {
  db.calls = [];
  db.failWhen = [];
  db.hang = new Set();
  db.rows = {
    quotes: [{ id: "q1", quote_ref: "QUO-1001", customer: "Acme Ltd", customer_po: "PO-77" }],
    invoices: [{ id: "i1", invoice_ref: "INV-2001", customer: "Acme Ltd", customer_po: null }, { id: "i2", invoice_ref: null, customer: "Acme Ltd" }],
    jobs: [{ id: "j1", job_no: "J-3001", customer: "Acme Ltd", description: "Gland nut" }],
    purchase_orders: [{ id: "p1", po_ref: "PO-0001", po_number: "PO-0001", supplier: "Steel Co" }],
    customers: [{ id: "c1", name: "Acme Ltd", email: "buyer@acme.test" }],
    quote_line_items: [{ id: "ql1", quote_id: "q1", description: "Acme bracket", quotes: { id: "q1", quote_ref: "QUO-1001", customer: "Acme Ltd" } }],
    invoice_line_items: [{ id: "il1", invoice_id: "i1", description: "Acme bracket", invoices: [{ id: "i1", invoice_ref: "INV-2001", customer: "Acme Ltd" }] }],
  };
  auth.role = "office"; auth.secondary = null; auth.hidden = []; auth.support = false; auth.sameOrigin = true; auth.status = 200;
});

describe("guards", () => {
  it("refuses a cross-site request and an unsigned request before reading anything", async () => {
    auth.sameOrigin = false;
    expect((await get("acme")).status).toBe(403);
    auth.sameOrigin = true; auth.status = 401;
    expect((await get("acme")).status).toBe(401);
    expect(db.calls).toHaveLength(0);
  });
  it("answers uncached", async () => {
    expect((await get("acme")).headers.get("cache-control")).toBe("no-store");
  });
});

describe("what each role searches", () => {
  it("admin and office: every group, in order, with line text", async () => {
    for (const role of ["admin", "office"]) {
      auth.role = role;
      expect((await answer("acme")).groups.map((g) => g.key), role).toEqual(["quotes", "invoices", "jobs", "purchase_orders", "customers", "lines"]);
    }
  });
  it("workshop and viewer: Jobs only, and nothing else is even read", async () => {
    for (const role of ["workshop", "viewer"]) {
      auth.role = role; db.calls = [];
      expect((await answer("acme")).groups.map((g) => g.key), role).toEqual(["jobs"]);
      expect(db.calls.map((c) => c.table), role).toEqual(["jobs"]);
    }
  });
  it("a second role adds its groups", async () => {
    auth.role = "workshop"; auth.secondary = "office";
    expect((await answer("acme")).groups.map((g) => g.key)).toContain("quotes");
  });
  it("a page hidden from the person hides its group; line text needs quotes or invoices", () => {
    expect(allowedGroups(["office"], ["quotes"])).toEqual(["invoices", "jobs", "purchase_orders", "customers", "lines"]);
    expect(allowedGroups(["office"], ["quotes", "invoices"])).toEqual(["jobs", "purchase_orders", "customers"]);
    expect(allowedGroups(["office"], ["jobs", "purchase-orders", "customers"])).toEqual(["quotes", "invoices", "lines"]);
    expect(allowedGroups([null, undefined])).toEqual([]);
  });
  it("line text reads only the line tables the person may open", async () => {
    auth.hidden = ["invoices"]; db.calls = [];
    await answer("acme");
    const tables = db.calls.map((c) => c.table);
    expect(tables).toContain("quote_line_items");
    expect(tables).not.toContain("invoice_line_items");
    expect(tables).not.toContain("invoices");
  });
  it("a support session reads the same way (read only: no write method exists on the stand-in client)", async () => {
    auth.support = true;
    expect((await get("acme")).status).toBe(200);
  });
});

describe("company scoping and the caller's own client", () => {
  it("every read is filtered to the session's company, through the caller's client (the service role throws if created)", async () => {
    await answer("acme");
    expect(db.calls.length).toBeGreaterThanOrEqual(7);
    for (const call of db.calls) expect(call.eq, call.table).toContainEqual(["organization_id", "org-1"]);
  });
});

describe("query handling", () => {
  it("empty, missing and one-character queries read nothing", async () => {
    for (const q of [null, "", " ", "a", " a ", "  "]) expect(await answer(q), String(q)).toMatchObject({ groups: [], unavailable: [] });
    expect(db.calls).toHaveLength(0);
  });
  it("two characters search", async () => {
    await answer("ac");
    expect(db.calls.length).toBeGreaterThan(0);
  });
  it("ilike wildcards the person typed are escaped", () => {
    expect(likePattern("100%")).toBe("%100\\%%");
    expect(likePattern("a_b")).toBe("%a\\_b%");
    expect(likePattern("a\\b")).toBe("%a\\\\b%");
  });
  it("characters that would break the filter text cannot add conditions", async () => {
    await answer('x,customer.ilike.%)("*');
    for (const call of db.calls.filter((c) => c.or)) {
      // Only our own conditions: one per column, joined by commas; nothing from the typed text adds a comma, bracket or quote.
      const conditions = call.or!.split(",");
      for (const condition of conditions) expect(condition).toMatch(/^[a-z_]+\.ilike\.%[^,()"*]*%$/);
    }
  });
  it("the text is cut to 100 characters", async () => {
    expect(normaliseQuery("x".repeat(500))).toHaveLength(100);
    expect(normaliseQuery("  a   b  ")).toBe("a b");
    await answer("x".repeat(500));
    for (const call of db.calls.filter((c) => c.or)) expect(call.or).not.toContain("x".repeat(101));
  });
  it("each read asks for at most 5", async () => {
    await answer("acme");
    for (const call of db.calls) expect(call.limit, call.table).toBe(5);
  });
});

describe("grouping and links", () => {
  it("each result opens the page that already opens that record", async () => {
    const { groups } = await answer("acme");
    const href = (key: string) => groups.find((g) => g.key === key)!.results.map((r) => r.href);
    expect(href("quotes")).toEqual(["/quotes?quote=q1"]);
    expect(href("invoices")).toEqual(["/invoices?invoice=i1", "/invoices?invoice=i2"]);
    expect(href("jobs")).toEqual(["/jobs?job=j1"]);
    expect(href("purchase_orders")).toEqual(["/purchase-orders?po=p1"]);
    expect(href("customers")).toEqual(["/customers?customer=c1"]);
    // Line text points at the parent document, quote or invoice.
    expect(href("lines")).toEqual(["/quotes?quote=q1", "/invoices?invoice=i1"]);
  });
  it("shows the ref, the customer and the customer's PO; a draft invoice has no number", async () => {
    const { groups } = await answer("acme");
    expect(groups.find((g) => g.key === "quotes")!.results[0]).toMatchObject({ title: "QUO-1001", subtitle: "Acme Ltd · PO PO-77" });
    expect(groups.find((g) => g.key === "invoices")!.results.map((r) => r.title)).toEqual(["INV-2001", "Draft invoice"]);
    expect(groups.find((g) => g.key === "lines")!.results[0]).toMatchObject({ title: "Acme bracket", subtitle: "Quote QUO-1001 · Acme Ltd" });
  });
  it("groups with no match are left out; labels are the page names", async () => {
    db.rows.quotes = []; db.rows.customers = [];
    const { groups } = await answer("acme");
    expect(groups.map((g) => g.key)).not.toContain("quotes");
    expect(groups.find((g) => g.key === "purchase_orders")!.label).toBe("Supplier purchase orders");
  });
  it("never more than 5 in a group, and line text totals 5 across quotes and invoices", async () => {
    db.rows.jobs = Array.from({ length: 9 }, (_, i) => ({ id: `j${i}`, job_no: `J-${i}` }));
    db.rows.quote_line_items = Array.from({ length: 5 }, (_, i) => ({ id: `ql${i}`, quote_id: `q${i}`, description: "d", quotes: { id: `q${i}`, quote_ref: `Q${i}` } }));
    const { groups } = await answer("acme");
    expect(groups.find((g) => g.key === "jobs")!.results).toHaveLength(5);
    expect(groups.find((g) => g.key === "lines")!.results).toHaveLength(5);
  });
});

describe("before migration 123 (no customer_po column)", () => {
  it("asks with customer_po, then again without it, and still answers", async () => {
    db.failWhen = [{ table: "quotes", includes: "customer_po", error: { code: "42703", message: "column quotes.customer_po does not exist" } }];
    const { groups, unavailable } = await answer("acme");
    expect(unavailable).toEqual([]);
    expect(groups.find((g) => g.key === "quotes")!.results[0]).toMatchObject({ title: "QUO-1001" });
    const quoteCalls = db.calls.filter((c) => c.table === "quotes");
    expect(quoteCalls[0].select).toContain("customer_po");
    expect(quoteCalls[1].select).not.toContain("customer_po");
    expect(quoteCalls[1].or).not.toContain("customer_po");
  });
  it("PostgREST's own wording counts too; other errors do not trigger the fallback", () => {
    expect(missingColumn({ code: "PGRST204", message: "Could not find the 'customer_po' column of 'quotes' in the schema cache" })).toBe(true);
    expect(missingColumn({ code: "42501", message: "permission denied" })).toBe(false);
    expect(missingColumn(null)).toBe(false);
  });
});

describe("failure and time-out", () => {
  it("a failing group is named; the others still answer", async () => {
    db.failWhen = [{ table: "jobs", includes: "job_no", error: { code: "XX000", message: "boom" } }];
    const { groups, unavailable } = await answer("acme");
    expect(unavailable).toEqual(["jobs"]);
    expect(groups.map((g) => g.key)).toContain("quotes");
  });
  it("a read that never answers is given up on", async () => {
    db.hang = new Set(["customers"]);
    const result = await runSearch(supabase as unknown as SearchClient, "org-1", "acme", allowedGroups(["office"]), 20);
    expect(result.unavailable).toEqual(["customers"]);
    expect(result.groups.map((g) => g.key)).toContain("quotes");
  });
  it("line text is unavailable only when every line read failed", async () => {
    db.failWhen = [{ table: "quote_line_items", includes: "id", error: { code: "XX000", message: "boom" } }];
    expect((await answer("acme")).groups.map((g) => g.key)).toContain("lines");
    db.failWhen.push({ table: "invoice_line_items", includes: "id", error: { code: "XX000", message: "boom" } });
    expect((await answer("acme")).unavailable).toEqual(["lines"]);
  });
});
