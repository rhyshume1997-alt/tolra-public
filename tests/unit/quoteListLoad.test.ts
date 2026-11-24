/**
 * BOUNDARY (Quotes module 3, READ-ONLY LIVE PREVIEW). Inputs: lib/quote-list-load.ts, a fake read-only client, and the SOURCE TEXT of the real Quote Generator page
 * (app/(dashboard)/quotes/page.tsx) and lib/archive.ts. Output: pass/fail. Proves the loader maps a database row exactly as the real page does, pages through a server cap smaller
 * than the page size, reads the declined lines only when 068 is there, throws (never returns sample rows) on a database error, and that the copied text still equals the real
 * page's text: when the real page's mapper, selects or paging change, the "pinned to the real source" tests fail and this copy must be updated with it.
 * Must not change: never loosen the pin tests to let a drift through. No network, no Supabase.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadArchiveState, loadQuoteLines, loadQuoteList, mapQuoteRow, type ReadClient } from "@/lib/quote-list-load";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const between = (src: string, start: string, end: string) => {
  const a = src.indexOf(start);
  expect(a, `start marker not found: ${start}`).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(end, a + start.length);
  expect(b, `end marker not found: ${end}`).toBeGreaterThan(a);
  return squash(src.slice(a, b));
};

type Row = Record<string, unknown>;
/** A fake client that records every table and call, supports select/eq/order/range/maybeSingle, and caps a page like a hosted server does. */
function fakeClient(tables: Record<string, Row[]>, opts: { cap?: number; fail?: string; noDeclined?: boolean } = {}) {
  const calls: string[] = [];
  const client = {
    from(table: string) {
      const f = { eq: [] as Array<[string, unknown]>, range: undefined as [number, number] | undefined, cols: "*" };
      const run = async () => {
        calls.push(`${table}:${f.cols}`);
        if (opts.fail === table) return { data: null, error: { message: "boom", code: "XX000" } };
        let rows = [...(tables[table] ?? [])];
        for (const [c, v] of f.eq) rows = rows.filter((r) => r[c] === v);
        if (f.range) rows = rows.slice(f.range[0], Math.min(f.range[1] + 1, f.range[0] + (opts.cap ?? 1000)));
        return { data: rows, error: null };
      };
      const b: Record<string, unknown> = {
        select: (c: string) => { f.cols = c; return b; }, eq: (c: string, v: unknown) => { f.eq.push([c, v]); return b; }, order: () => b,
        range: (a: number, z: number) => { f.range = [a, z]; return b; }, maybeSingle: async () => { const r = await run(); return { data: (r.data as Row[] | null)?.[0] ?? null, error: r.error }; },
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
      };
      return b;
    },
  };
  return { client: client as unknown as ReadClient, calls };
}

const TODAY = "2026-11-24";
const dbRow = (over: Row = {}): Row => ({
  id: "q1", quote_ref: "QUO-0001", customer: "Marlow Hydraulics", total_value: "120.5", status: "sent", description: "Invented", updated_at: "2026-11-01T10:00:00Z", valid_until: "2026-12-01",
  internal_notes: "n", customer_notes: "c", terms: "t", created_at: "2026-11-01T09:00:00Z", sent_at: "2026-11-01T11:00:00Z", vat_enabled: true, version: 1, previous_version_id: null, customer_po: "  PO-9 ", ...over,
});

describe("mapQuoteRow: one database row to the list row, as the real page does", () => {
  it("maps every field", () => {
    expect(mapQuoteRow(dbRow(), TODAY)).toEqual({
      id: "q1", ref: "QUO-0001", customer: "Marlow Hydraulics", value: 120.5, rawStatus: "sent", status: "sent", description: "Invented", updatedAt: "2026-11-01T10:00:00Z", validUntil: "2026-12-01",
      internalNotes: "n", customerNotes: "c", terms: "t", date: "2026-11-01T09:00:00Z", sentAt: "2026-11-01T11:00:00Z", vatEnabled: true, issuerSnapshot: undefined, customerSnapshot: undefined,
      version: 1, previousVersionId: null, customerPo: "PO-9",
    });
  });
  it("shows a sent or draft quote past its date as expired, keeps the stored status, and never expires an accepted one", () => {
    expect(mapQuoteRow(dbRow({ valid_until: "2026-11-23" }), TODAY)).toMatchObject({ status: "expired", rawStatus: "sent" });
    expect(mapQuoteRow(dbRow({ valid_until: "2026-11-23", status: "draft" }), TODAY)).toMatchObject({ status: "expired", rawStatus: "draft" });
    expect(mapQuoteRow(dbRow({ valid_until: "2026-11-24" }), TODAY).status).toBe("sent");
    expect(mapQuoteRow(dbRow({ valid_until: "2026-11-23", status: "accepted" }), TODAY)).toMatchObject({ status: "accepted", rawStatus: "accepted" });
  });
  it("copes with empty and missing fields and an unknown status", () => {
    const r = mapQuoteRow({ id: "x", status: "weird", vat_enabled: false, version: "2", previous_version_id: "p" }, TODAY);
    expect(r).toMatchObject({ ref: "", customer: "", value: 0, rawStatus: "draft", validUntil: "", vatEnabled: false, version: 2, previousVersionId: "p", customerPo: "", date: undefined, sentAt: undefined });
    expect(mapQuoteRow({ id: "x", version: 0 }, TODAY).version).toBe(1);
  });
});

describe("loadQuoteList: SELECT only, paged, with the declined value of accepted quotes", () => {
  const many = Array.from({ length: 250 }, (_, i) => dbRow({ id: `q${i}`, quote_ref: `QUO-${i}`, status: i % 2 ? "accepted" : "sent" }));
  it("pages through a server cap smaller than the page size and returns every row once", async () => {
    const { client, calls } = fakeClient({ quotes: many, quote_line_items: [] }, { cap: 100 });
    const out = await loadQuoteList(client, TODAY, async () => true);
    expect(out.rows).toHaveLength(250);
    expect(new Set(out.rows.map((r) => r.id)).size).toBe(250);
    expect(out.truncated).toBe(false);
    expect(calls.filter((c) => c.startsWith("quotes:")).length).toBeGreaterThanOrEqual(3);
    expect(calls.every((c) => c.startsWith("quotes:") || c.startsWith("quote_line_items:"))).toBe(true);
  });
  it("attaches the declined value (with VAT as the quote has it) and counts only declined lines", async () => {
    const { client } = fakeClient({
      quotes: [dbRow({ id: "a", status: "accepted" }), dbRow({ id: "b", status: "accepted", vat_enabled: false }), dbRow({ id: "c", status: "sent" })],
      quote_line_items: [
        { id: "l1", quote_id: "a", quantity: 2, unit_price: 50, vat_pct: 20, vat_exempt: false, declined: true },
        { id: "l2", quote_id: "a", quantity: 9, unit_price: 9, vat_pct: 20, vat_exempt: false, declined: false },
        { id: "l3", quote_id: "b", quantity: 1, unit_price: 40, vat_pct: 20, vat_exempt: false, declined: true },
      ],
    });
    const out = await loadQuoteList(client, TODAY, async () => true);
    const by = Object.fromEntries(out.rows.map((r) => [r.id, r.declinedValue]));
    expect(by).toEqual({ a: 120, b: 40, c: undefined });
    expect(out.declinedLoaded).toBe(true);
  });
  it("does not read quote_line_items at all before 068", async () => {
    const { client, calls } = fakeClient({ quotes: [dbRow()], quote_line_items: [{ quote_id: "q1", declined: true }] });
    const out = await loadQuoteList(client, TODAY, async () => false);
    expect(out.declinedLoaded).toBe(false);
    expect(out.rows[0].declinedValue).toBeUndefined();
    expect(calls.some((c) => c.startsWith("quote_line_items"))).toBe(false);
  });
  it("throws on a database error (the screen shows a failed state, never sample rows) and returns an empty list for a company with no quotes", async () => {
    await expect(loadQuoteList(fakeClient({ quotes: [] }, { fail: "quotes" }).client, TODAY, async () => true)).rejects.toMatchObject({ message: "boom" });
    await expect(loadQuoteList(fakeClient({ quotes: [], quote_line_items: [] }).client, TODAY, async () => true)).resolves.toMatchObject({ rows: [], truncated: false });
  });
});

describe("loadQuoteLines and loadArchiveState", () => {
  it("reads one quote's lines (068 columns only when present) and maps them", async () => {
    const lines = [{ id: "l1", quote_id: "q1", description: "A", quantity: "3", unit_price: "2.5", source: null, vat_pct: null, vat_exempt: null, part_number: "P", drawing_number: null, drawing_revision: "B", declined: true }, { id: "l2", quote_id: "other" }];
    const on = fakeClient({ quote_line_items: lines });
    expect(await loadQuoteLines(on.client, "q1", async () => true)).toEqual([{ id: "l1", description: "A", quantity: 3, unitPrice: 2.5, source: "manual", vatPct: undefined, vatExempt: false, partNumber: "P", drawingNumber: null, drawingRevision: "B", declined: true }]);
    expect(on.calls[0]).toContain("part_number, drawing_number, drawing_revision, declined");
    const off = fakeClient({ quote_line_items: lines });
    await loadQuoteLines(off.client, "q1", async () => false);
    expect(off.calls[0]).not.toContain("declined");
    await expect(loadQuoteLines(fakeClient({}, { fail: "quote_line_items" }).client, "q1", async () => true)).rejects.toBeTruthy();
  });
  it("reads the archive months (default 12, ignores nonsense) and the manual choices for quotes only", async () => {
    const t = { organization_settings: [{ archive_after_months: 6 }], record_archive_state: [{ record_id: "a", record_table: "quotes", state: "archived" }, { record_id: "b", record_table: "jobs", state: "active" }] };
    const out = await loadArchiveState(fakeClient(t).client);
    expect(out.months).toBe(6);
    expect([...out.manual]).toEqual([["a", "archived"]]);
    expect((await loadArchiveState(fakeClient({ organization_settings: [{ archive_after_months: 0 }], record_archive_state: [] }).client)).months).toBe(12);
    expect((await loadArchiveState(fakeClient({ organization_settings: [], record_archive_state: [] }).client)).months).toBe(12);
    await expect(loadArchiveState(fakeClient({}, { fail: "organization_settings" }).client)).rejects.toBeTruthy();
  });
});

describe("pinned to the real source: this copy fails when the real page drifts", () => {
  const page = read("app/(dashboard)/quotes/page.tsx");
  const copy = read("lib/quote-list-load.ts");
  const fromPage = (start: string, end: string) => between(page, start, end);
  const fromCopy = (start: string, end: string) => between(copy, start, end);

  it("row mapper: the object literal is identical (today replaces toDateInput(new Date()))", () => {
    const real = fromPage("id: quote.id ? String(quote.id) : undefined,", 'customerPo: customerPoText(quote.customer_po ? String(quote.customer_po) : "") ?? "",').replace("toDateInput(new Date())", "today");
    const mine = fromCopy("id: quote.id ? String(quote.id) : undefined,", 'customerPo: customerPoText(quote.customer_po ? String(quote.customer_po) : "") ?? "",');
    expect(mine).toBe(real);
  });
  it("list select, order, paging and the truncation cap", () => {
    expect(fromPage("fetchAll((from, to) => supabase!.from(\"quotes\")", ".range(from, to));")).toBe(fromCopy("fetchAll((from, to) => supabase!.from(\"quotes\")", ".range(from, to));"));
  });
  it("declined lines: the 068 guard, columns, filter and order", () => {
    const start = "await databaseHas068()";
    const real = fromPage(start, ": { rows: [], truncated: false };");
    expect(real).toContain('.select("quote_id, quantity, unit_price, vat_pct, vat_exempt").eq("declined", true).order("id").range(from, to)');
    expect(copy).toContain('.select("quote_id, quantity, unit_price, vat_pct, vat_exempt").eq("declined", true).order("id").range(from, to)');
    expect(fromPage("const vatOn = new Map(", "setQuotes(rows);")).toBe(fromCopy("const vatOn = new Map(", "return { rows, truncated"));
  });
  it("quote lines: columns, filter, order and mapper", () => {
    const realMap = fromPage("return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((row) => ({", "}));\n  }");
    const mineMap = fromCopy("return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((row) => ({", "}));\n}");
    expect(mineMap).toBe(realMap);
    const norm = (s: string) => s.replace("databaseHas068()", "has068()").replace("quote.id", "quoteId");
    expect(norm(fromPage("const columns: string =", "if (error) throw error;"))).toBe(norm(fromCopy("const columns: string =", "if (error) throw error;")));
  });
  it("archive reads: the same two selects as lib/archive.ts useArchive", () => {
    const real = read("lib/archive.ts");
    const a = 'supabase!.from("organization_settings").select("archive_after_months").maybeSingle()';
    const b = 'fetchAll((from, to) => supabase!.from("record_archive_state").select("record_id, state").eq("record_table", table).order("record_id").range(from, to), { maxRows: Number.MAX_SAFE_INTEGER })';
    expect(squash(real)).toContain(a);
    expect(squash(real)).toContain(b);
    expect(squash(copy)).toContain(a);
    expect(squash(copy)).toContain(b.replace("eq(\"record_table\", table)", 'eq("record_table", "quotes")'));
  });
});
