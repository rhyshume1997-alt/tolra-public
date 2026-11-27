import { describe, expect, it } from "vitest";
import { type PaymentExportReader, fetchPaymentsForExport } from "@/lib/invoice-payment-export";
import { MAX_LIST_ROWS } from "@/lib/fetch-all";

type Row = { id: string; invoice_id: string; amount: number; paid_on: string; created_at: string };

function makeReader(allRows: Row[]) {
  const queries: Array<{ filterIds: string[] | null; from: number; to: number }> = [];
  const client: PaymentExportReader = {
    from: () => ({
      select: () => {
        const makeOrdered = (filterIds: string[] | null) => ({
          order: () => ({
            order: () => ({
              range: (from: number, to: number) => {
                queries.push({ filterIds, from, to });
                const matching = filterIds
                  ? allRows.filter((r) => filterIds.includes(r.invoice_id))
                  : allRows;
                return Promise.resolve({ data: matching.slice(from, to + 1), error: null });
              },
            }),
          }),
        });
        return {
          ...makeOrdered(null),
          in: (_col: "invoice_id", values: string[]) => makeOrdered([...values]),
        };
      },
    }),
  };
  return { client, queries };
}

describe("fetchPaymentsForExport (CR-018)", () => {
  it("scopes database queries to selected invoice IDs instead of loading every org payment first", async () => {
    // Org has more than MAX_LIST_ROWS total payments, which would truncate an unscoped query.
    const bulkOther: Row[] = Array.from({ length: MAX_LIST_ROWS + 5 }, (_, i) => ({
      id: `other-${i}`,
      invoice_id: "inv-other",
      amount: 10,
      paid_on: "2026-01-01",
      created_at: "2026-01-01T00:00:00Z",
    }));
    const target: Row[] = [
      { id: "p-2", invoice_id: "inv-2", amount: 50, paid_on: "2026-02-02", created_at: "2026-02-02T10:00:00Z" },
      { id: "p-1", invoice_id: "inv-1", amount: 25, paid_on: "2026-02-01", created_at: "2026-02-01T10:00:00Z" },
    ];
    const { client, queries } = makeReader([...bulkOther, ...target]);

    // Unscoped export truncates as expected when total org payments exceed MAX_LIST_ROWS.
    const unscoped = await fetchPaymentsForExport(client, null);
    expect(unscoped.truncated).toBe(true);

    queries.length = 0;
    // Selected export succeeds and NEVER issues an unscoped query.
    const scoped = await fetchPaymentsForExport(client, ["inv-1", "inv-2", "inv-1"]);
    expect(scoped.truncated).toBe(false);
    expect(scoped.payments.map((p) => p.id)).toEqual(["p-1", "p-2"]);
    expect(queries.every((q) => q.filterIds !== null)).toBe(true);
    expect(queries[0].filterIds).toEqual(["inv-1", "inv-2"]);
  });

  it("chunks large selections and sorts combined payments by created_at then id", async () => {
    const rows: Row[] = [
      { id: "p-b", invoice_id: "inv-3", amount: 30, paid_on: "2026-03-01", created_at: "2026-03-01T09:00:00Z" },
      { id: "p-a", invoice_id: "inv-1", amount: 10, paid_on: "2026-02-01", created_at: "2026-02-01T09:00:00Z" },
      { id: "p-c", invoice_id: "inv-2", amount: 20, paid_on: "2026-03-01", created_at: "2026-03-01T09:00:00Z" },
    ];
    const { client, queries } = makeReader(rows);

    const res = await fetchPaymentsForExport(client, ["inv-1", "inv-2", "inv-3"], 2);
    expect(res.truncated).toBe(false);
    expect(res.payments.map((p) => p.id)).toEqual(["p-a", "p-b", "p-c"]);
    expect(queries.filter((q) => q.from === 0).map((q) => q.filterIds)).toEqual([["inv-1", "inv-2"], ["inv-3"]]);
  });

  it("issues zero queries when selected invoice ID list is empty", async () => {
    const { client, queries } = makeReader([]);
    const res = await fetchPaymentsForExport(client, []);
    expect(res).toEqual({ payments: [], truncated: false });
    expect(queries).toHaveLength(0);
  });
});
