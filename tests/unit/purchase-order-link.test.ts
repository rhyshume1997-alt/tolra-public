/**
 * A supplier purchase order linked to the customer quote or job it was bought for (migration 124; lib/purchase-order-link.ts): the picker's
 * search (quotes and jobs, by number or customer, in the database), the line suggestion, and the Bought in / Profit maths: pence-exact, ex
 * VAT on both sides, part-orders (an allocated amount), several orders, cancelled orders, and credit notes SUBTRACTED from the invoiced sell.
 */
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  LINK_PICKER_LIMIT, type LinkClient, boughtIn, boughtInText, findLinkTargets, invoicedSellPence, linkColumns, linkKey, linkLabel, linkedPoPence,
  parseLinkKey, profitOf, profitText, quoteSellPence, sanitiseLinkTerm, suggestQuotesForItem,
} from "@/lib/purchase-order-link";

type Rows = Record<string, Record<string, unknown>[]>;
function fakeClient(rows: Rows, failing: string[] = []) {
  const calls: string[] = [];
  const from = (table: string) => {
    const query = {
      select: (c: string) => { calls.push(`${table} select ${c}`); return query; },
      eq: (c: string, v: unknown) => { calls.push(`${table} eq ${c} ${String(v)}`); return query; },
      neq: (c: string, v: unknown) => { calls.push(`${table} neq ${c} ${String(v)}`); return query; },
      in: (c: string, v: unknown[]) => { calls.push(`${table} in ${c} ${v.join(",")}`); return query; },
      or: (f: string) => { calls.push(`${table} or ${f}`); return query; },
      ilike: (c: string, p: string) => { calls.push(`${table} ilike ${c} ${p}`); return query; },
      order: (c: string, o: { ascending: boolean }) => { calls.push(`${table} order ${c} ${o.ascending ? "asc" : "desc"}`); return query; },
      limit: async (n: number) => { calls.push(`${table} limit ${n}`); return failing.includes(table) ? { data: null, error: { message: "x" } } : { data: rows[table] ?? [], error: null }; },
    };
    return query;
  };
  return { client: { from } as unknown as LinkClient, calls };
}

const QUOTE = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";

describe("the link value", () => {
  it("is quote:<id> or job:<id>, and anything else is no link", () => {
    expect(linkKey({ kind: "quote", id: QUOTE })).toBe(`quote:${QUOTE}`);
    expect(parseLinkKey(`job:${JOB}`)).toEqual({ kind: "job", id: JOB });
    expect(parseLinkKey(`QUOTE:${QUOTE.toUpperCase()}`)).toEqual({ kind: "quote", id: QUOTE });
    for (const bad of ["", null, undefined, "quote:", `invoice:${QUOTE}`, `quote:${QUOTE}x`, "job:1; drop"]) expect(parseLinkKey(bad)).toBeNull();
  });

  it("writes exactly one of the two columns, or neither", () => {
    expect(linkColumns({ kind: "quote", id: QUOTE })).toEqual({ quote_id: QUOTE, job_id: null });
    expect(linkColumns({ kind: "job", id: JOB })).toEqual({ quote_id: null, job_id: JOB });
    expect(linkColumns(null)).toEqual({ quote_id: null, job_id: null });
    expect(linkLabel({ kind: "job", ref: "J-12", customer: "Acme" })).toBe("Job J-12 - Acme");
    expect(linkLabel({ kind: "quote", ref: "QUO-3", customer: "" })).toBe("Quote QUO-3");
  });
});

describe("the picker's search", () => {
  it("asks for quotes (not superseded versions) and jobs (not internal), by number or customer, newest first, one more than the limit", async () => {
    const { client, calls } = fakeClient({ quotes: [{ id: "q1", quote_ref: "QUO-1", customer: "Acme" }], jobs: [{ id: "j1", job_no: "J-1", customer: "Acme" }] });
    const found = await findLinkTargets(client, " acme, (ltd) ");
    expect(sanitiseLinkTerm(" acme, (ltd) ")).toBe("acme ltd");
    expect(calls).toEqual([
      "quotes select id, quote_ref, customer", "quotes neq status superseded", "quotes or quote_ref.ilike.%acme ltd%,customer.ilike.%acme ltd%",
      "jobs select id, job_no, customer", "jobs eq is_internal false", "jobs or job_no.ilike.%acme ltd%,customer.ilike.%acme ltd%",
      "quotes order created_at desc", `quotes limit ${LINK_PICKER_LIMIT + 1}`, "jobs order created_at desc", `jobs limit ${LINK_PICKER_LIMIT + 1}`,
    ]);
    expect(found).toEqual({ failed: false, truncated: false, targets: [{ kind: "quote", id: "q1", ref: "QUO-1", customer: "Acme" }, { kind: "job", id: "j1", ref: "J-1", customer: "Acme" }] });
  });

  it("an empty search lists the newest of each; more than the limit says so; a failure is reported, not shown as nothing", async () => {
    const many = Array.from({ length: LINK_PICKER_LIMIT + 1 }, (_, i) => ({ id: `q${i}`, quote_ref: `QUO-${i}`, customer: "" }));
    const { client, calls } = fakeClient({ quotes: many, jobs: [] });
    const found = await findLinkTargets(client, "");
    expect(calls.some((c) => c.includes(" or "))).toBe(false);
    expect(found.targets).toHaveLength(LINK_PICKER_LIMIT);
    expect(found.truncated).toBe(true);
    expect(await findLinkTargets(fakeClient({}, ["jobs"]).client, "x")).toEqual({ targets: [], truncated: false, failed: true });
  });

  it("suggests a quote with a line like the item (3 characters or more), never a superseded or rejected one, at most 3", async () => {
    const rows = {
      quote_line_items: [{ quote_id: "q1" }, { quote_id: "q2" }, { quote_id: "q1" }, { quote_id: "q3" }, { quote_id: "q4" }, { quote_id: "q5" }],
      quotes: [
        { id: "q1", quote_ref: "QUO-1", customer: "Acme", status: "sent" }, { id: "q2", quote_ref: "QUO-2", customer: "B", status: "superseded" },
        { id: "q3", quote_ref: "QUO-3", customer: "C", status: "Rejected" }, { id: "q4", quote_ref: "QUO-4", customer: "D", status: "accepted" },
        { id: "q5", quote_ref: "QUO-5", customer: "E", status: "draft" }, { id: "q6", quote_ref: "QUO-6", customer: "F", status: "sent" },
      ],
    };
    const { client, calls } = fakeClient(rows);
    const found = await suggestQuotesForItem(client, "316 stainless bar");
    expect(calls).toContain("quote_line_items ilike description %316 stainless bar%");
    expect(calls).toContain("quotes in id q1,q2,q3,q4,q5");
    expect(found.map((t) => t.ref)).toEqual(["QUO-1", "QUO-4", "QUO-5"]);
    const short = fakeClient(rows);
    expect(await suggestQuotesForItem(short.client, " b ")).toEqual([]);
    expect(short.calls).toEqual([]);
    expect(await suggestQuotesForItem(fakeClient(rows, ["quote_line_items"]).client, "bar")).toEqual([]);
  });

  it("the picker is the job picker's pattern: searched in the database, the chosen one kept in the list, internal only", () => {
    const src = readFileSync(path.resolve(__dirname, "../../components/purchase-order-link-picker.tsx"), "utf8");
    expect(src).toContain("findLinkTargets(");
    expect(src).toContain("selected && !targets.some");
    expect(src).toContain("Not for a particular quote or job");
  });
});

describe("Bought in: the linked supplier orders, ex VAT", () => {
  it("an order's whole ex-VAT value, pence-exact (VAT is never in total_value)", () => {
    expect(linkedPoPence({ id: "a", status: "issued", total_value: 0.1 })).toBe(10);
    expect(linkedPoPence({ id: "a", status: "issued", total_value: "1234.56" })).toBe(123456);
    expect(boughtIn([{ id: "a", total_value: 0.1 }, { id: "b", total_value: 0.2 }])).toEqual({ pence: 30, count: 2 });
  });

  it("only part of an order (several jobs on one order, or some lines): its allocated amount, never above the order or below 0", () => {
    expect(linkedPoPence({ id: "a", total_value: 300, linked_net: 120.35 })).toBe(12035);
    expect(linkedPoPence({ id: "a", total_value: 300, linked_net: 0 })).toBe(0);
    expect(linkedPoPence({ id: "a", total_value: 300, linked_net: 450 })).toBe(30000);
    expect(linkedPoPence({ id: "a", total_value: 300, linked_net: -5 })).toBe(0);
    expect(linkedPoPence({ id: "a", total_value: 300, linked_net: null })).toBe(30000);
  });

  it("several orders add up; an order linked both to the quote and to its job counts once; a cancelled one not at all", () => {
    const pos = [
      { id: "a", status: "issued", total_value: 100 }, { id: "b", status: "draft", total_value: 50.5, linked_net: 20.25 },
      { id: "a", status: "issued", total_value: 100 }, { id: "c", status: "Cancelled", total_value: 999 },
    ];
    expect(boughtIn(pos)).toEqual({ pence: 12025, count: 2 });
    expect(boughtInText({ buyPence: 12025, count: 2 })).toBe("Bought in £120.25 (2 POs)");
    expect(boughtInText({ buyPence: 5000, count: 1 })).toBe("Bought in £50.00 (1 PO)");
    expect(boughtInText({ buyPence: boughtIn([]).pence, count: boughtIn([]).count })).toBe("Bought in £0.00 (no purchase orders linked)");
  });
});

describe("Sell, ex VAT", () => {
  it("a quote: its ordered lines, quantity x unit price, pence-exact; a declined line is not counted; VAT and carriage play no part", () => {
    const lines = [{ quantity: 3, unitPrice: 0.335 }, { quantity: "2.5", unit_price: "10.10" }, { quantity: 1, unitPrice: 500, declined: true }];
    expect(quoteSellPence(lines)).toBe(101 + 2525);
    expect(quoteSellPence([])).toBe(0);
  });

  it("a job once invoiced: the issued invoices' net MINUS the issued credit notes against them; drafts, voids and draft credits do not count", () => {
    const invoices = [
      { id: "i1", status: "sent", subtotal: 1000 }, { id: "i2", status: "paid", subtotal: "250.50" }, { id: "i3", status: "draft", subtotal: 9999 },
      { id: "i4", status: "void", subtotal: 9999 }, { id: "i5", status: "credited", subtotal: 100 },
    ];
    const credits = [
      { invoice_id: "i1", status: "issued", subtotal: 200.25 }, { invoice_id: "i1", status: "draft", subtotal: 50 },
      { invoice_id: "i3", status: "issued", subtotal: 70 }, { invoice_id: "i5", status: "issued", subtotal: 100 }, { invoice_id: "other", status: "issued", subtotal: 1 },
    ];
    expect(invoicedSellPence(invoices, credits)).toBe(100000 + 25050 + 10000 - 20025 - 10000);
    expect(invoicedSellPence([{ id: "d", status: "draft", subtotal: 5 }], [])).toBeNull();
    expect(invoicedSellPence([], [])).toBeNull();
  });
});

describe("Profit", () => {
  it("sell minus buy and the margin on sell, one decimal place", () => {
    const p = profitOf(20000, { pence: 12025, count: 2 }, "quote");
    expect(p).toEqual({ sellPence: 20000, buyPence: 12025, count: 2, profitPence: 7975, marginPct: 39.9, basis: "quote" });
    expect(profitText(p)).toBe("Profit £79.75 (39.9%)");
  });

  it("zero and a loss are shown as they are", () => {
    expect(profitText(profitOf(5000, { pence: 5000, count: 1 }, "quote"))).toBe("Profit £0.00 (0.0%)");
    expect(profitText(profitOf(10000, { pence: 11000, count: 1 }, "invoiced"))).toBe("Profit -£10.00 (-10.0%)");
  });

  it("no sell price (0 or none yet): no % is made up", () => {
    expect(profitText(profitOf(0, { pence: 3000, count: 1 }, "quote"))).toBe("Profit -£30.00");
    const none = profitOf(null, { pence: 3000, count: 1 }, "quote");
    expect(none.basis).toBe("none");
    expect(profitText(none)).toBe("Profit: no sell price yet");
  });

  it("a fully credited job reads as no sell, and its whole buy as the loss", () => {
    const sell = invoicedSellPence([{ id: "i", status: "credited", subtotal: 100 }], [{ invoice_id: "i", status: "issued", subtotal: 100 }]);
    expect(profitText(profitOf(sell, { pence: 4000, count: 1 }, "invoiced"))).toBe("Profit -£40.00");
  });
});

describe("what the pages do with it", () => {
  const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");

  it("the supplier's PDF never carries the link (the PDF builder and the print page do not mention it)", () => {
    const po = read("app/(dashboard)/purchase-orders/page.tsx");
    const pdf = po.slice(po.indexOf("async function buildPurchaseOrderPdf"), po.indexOf("const editHasItems"));
    expect(pdf).not.toMatch(/link|quote|job/i);
    expect(read("app/(dashboard)/purchase-orders/[id]/print/page.tsx")).not.toMatch(/quote_id|job_id|linked_net/);
    expect(read("components/pdf/PurchaseOrderPDF.tsx")).not.toMatch(/quote_id|job_id|linked_net/);
  });

  it("Bought in / Profit is for office and admin only, and on the quote's details and the job's worksheet", () => {
    const panel = read("components/bought-in-profit.tsx");
    expect(panel).toContain('const OFFICE = new Set(["admin", "office"]);');
    expect(panel).toContain("if (!office || !has124 || !id");
    expect(read("app/(dashboard)/quotes/page.tsx")).toContain('<BoughtInProfit kind="quote"');
    expect(read("app/(dashboard)/jobs/page.tsx")).toContain('<BoughtInProfit kind="job"');
  });
});
