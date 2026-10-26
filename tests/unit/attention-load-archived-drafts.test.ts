/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";

import { loadAttention, withoutArchivedDrafts } from "@/lib/attention-load";

// Created 10 days ago: over the 2-day draft rule and inside the dashboard's age cutoff.
const OLD = new Date(Date.now() - 10 * 86_400_000).toISOString();
const invoices = [
  { id: "a", invoice_ref: "A", customer: "C", status: "draft", created_at: OLD },
  { id: "b", invoice_ref: "B", customer: "C", status: null, created_at: OLD },
  { id: "c", invoice_ref: "C", customer: "C", status: "draft", created_at: OLD },
  { id: "d", invoice_ref: "D", customer: "C", status: "sent", total: 10, due_date: OLD.slice(0, 10), created_at: OLD },
];

// Minimal Supabase stand-in: builder methods return the builder; .range(from) decides the page (rows on the first page, then empty).
function fakeDb(tables: Record<string, unknown[] | Error>) {
  return {
    from(table: string) {
      const result = tables[table] ?? [];
      let offset = 0;
      const builder: any = new Proxy({}, {
        get: (_t, prop) => {
          if (prop === "then") return (resolve: (v: unknown) => void) => resolve(result instanceof Error ? { data: null, error: result } : { data: offset === 0 ? result : [], error: null });
          if (prop === "range") return (from: number) => { offset = from; return builder; };
          return () => builder;
        },
      });
      return builder;
    },
  } as any;
}

describe("withoutArchivedDrafts", () => {
  it("drops archived drafts (including a missing status) and keeps everything else", () => {
    const out = withoutArchivedDrafts(invoices, new Set(["a", "b", "d"]));
    expect(out.map((r) => r.id)).toEqual(["c", "d"]);
  });
});

describe("the dashboard's old-drafts count matches Invoicing's open drafts", () => {
  it("3 old drafts with 2 archived show 1", async () => {
    const db = fakeDb({ invoices, record_archive_state: [{ record_id: "a" }, { record_id: "b" }] });
    const sections = await loadAttention(db, "admin");
    const draft = sections.find((s: any) => s.id === "invoices-draft") as any;
    expect(draft.count).toBe(1);
    expect(draft.items[0].key).toBe("id-c");
  });

  it("a failed archive read reports the invoice sections as not loaded", async () => {
    const db = fakeDb({ invoices, record_archive_state: new Error("boom") });
    const sections = await loadAttention(db, "admin");
    const draft = sections.find((s: any) => s.id === "invoices-draft") as any;
    expect(draft.failed).toBe(true);
  });
});
