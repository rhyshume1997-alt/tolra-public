/**
 * (2) INVOICE TOTALS. Every imported invoice's net, VAT and gross equal the SOURCE figures to the penny (the source side is the generator's own
 * pence, not the importer's parse), its lines add up to its net, the VAT worked out line by line agrees with the header (or is a listed
 * rounding difference), and every mismatch the data contains is LISTED, in the importer's pre-write report and in the post-write reconciliation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { reconcileReadOnly } from "./reconcile";
import { withClient } from "./support/db";
import { buildWorld, type World } from "./support/world";

let w: World;
type Row = { ref: string; subtotal: string; vat: string; total: string; n: string; line_net: string; line_vat: string };
let rows: Row[];
const p = (s: string) => Math.round(Number(s) * 100);

beforeAll(async () => {
  w = await buildWorld("totals");
  rows = await withClient(w.db.url, async (db) =>
    (
      await db.query(
        `select i.invoice_ref as ref, i.subtotal::text, i.vat::text, i.total::text,
                (select count(*) from public.invoice_line_items l where l.invoice_id = i.id)::text as n,
                (select coalesce(sum(l.quantity * l.unit_price), 0) from public.invoice_line_items l where l.invoice_id = i.id)::text as line_net,
                (select coalesce(sum(round(l.quantity * l.unit_price * l.vat_pct / 100, 2)), 0) from public.invoice_line_items l where l.invoice_id = i.id)::text as line_vat
           from public.invoices i where i.organization_id = $1`,
        [w.orgId],
      )
    ).rows,
  );
});
afterAll(async () => {
  await w?.db.drop();
});

const src = (ref: string) => w.scenario.invoices.find((i) => i.number === ref)!;
const db = (ref: string) => rows.find((r) => r.ref === ref)!;

describe("imported invoice figures equal the source to the penny", () => {
  it("every designed-to-be-imported invoice is there, and nothing else (no invoice invented, none lost)", () => {
    expect(rows.map((r) => r.ref).sort()).toEqual([...w.expectedImported].sort());
    expect(rows.length).toBeGreaterThanOrEqual(60);
  });

  it("net, VAT and gross of every imported invoice equal the source, invoice by invoice", () => {
    const bad = [...w.expectedImported].filter((ref) => p(db(ref).subtotal) !== src(ref).netP || p(db(ref).vat) !== src(ref).vatP || p(db(ref).total) !== src(ref).grossP);
    expect(bad).toEqual([]);
  });

  it("the sum over all imported invoices equals the source sum (net, VAT, gross)", () => {
    const sum = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0);
    const want = (f: (i: ReturnType<typeof src>) => number) => [...w.expectedImported].reduce((a, ref) => a + f(src(ref)), 0);
    expect(sum((r) => p(r.subtotal))).toBe(want((i) => i.netP));
    expect(sum((r) => p(r.vat))).toBe(want((i) => i.vatP));
    expect(sum((r) => p(r.total))).toBe(want((i) => i.grossP));
  });

  it("whole-pound and awkward amounts survive exactly: 2.5 x 12.40, three lines at three rates, 3 x 29.99, 0.5 x 33.34", () => {
    expect([p(db("INV-0120").subtotal), p(db("INV-0120").vat), p(db("INV-0120").total)]).toEqual([3100, 620, 3720]);
    expect([p(db("INV-0121").subtotal), p(db("INV-0121").vat), p(db("INV-0121").total)]).toEqual([17500, 2250, 19750]);
    expect([p(db("INV-0125").subtotal), p(db("INV-0125").vat), p(db("INV-0125").total)]).toEqual([8997, 1799, 10796]);
    expect([p(db("INV-0126").subtotal), p(db("INV-0126").vat), p(db("INV-0126").total)]).toEqual([1667, 333, 2000]);
  });
});

describe("lines", () => {
  it("every imported invoice has its source lines (same count) and they add up to its net exactly, except where the source header disagrees with its own lines", () => {
    const expectedDisagree = new Set(w.scenario.facts.headerLineMismatch.filter((n) => w.expectedImported.has(n)));
    const bad: string[] = [];
    for (const ref of w.expectedImported) {
      const lines = w.scenario.lines.filter((l) => l.doc === ref).length;
      if (Number(db(ref).n) !== lines) bad.push(`${ref}: ${db(ref).n} lines, source ${lines}`);
      const diff = Math.round((Number(db(ref).line_net) - Number(db(ref).subtotal)) * 100000) / 1000;
      if (diff !== 0 && !expectedDisagree.has(ref)) bad.push(`${ref}: lines differ from net by ${diff}p`);
    }
    expect(bad).toEqual([]);
  });

  it("VAT worked out line by line equals the header VAT, apart from the one designed rounding case (INV-0122: 0.60 against 0.59)", () => {
    const differ = rows.filter((r) => p(r.line_vat) !== p(r.vat)).map((r) => r.ref).sort();
    // INV-0123 keeps header VAT 20.00 = lines' 20.00; only its GROSS is off by a penny, so it is not in this list.
    expect(differ).toEqual(w.scenario.facts.withinRounding);
    expect([p(db("INV-0122").line_vat), p(db("INV-0122").vat)]).toEqual([60, 59]);
  });
});

describe("every mismatch in the data is listed", () => {
  const mism = () => w.run.report.documentAmounts.mismatches as { number: string; field: string; stated: number; fromLines: number; withinRounding: boolean }[];

  it("the importer's pre-write report lists INV-0123 (header net + VAT is 120.00, gross says 120.01), INV-0124 (net 99.00 against lines 100.00) and INV-0122 as within rounding", () => {
    const m123 = mism().filter((m) => m.number === "INV-0123");
    expect(m123.map((m) => [m.field, m.stated, m.fromLines])).toEqual([["gross", 12001, 12000], ["header net + VAT vs gross", 12001, 12000]]);
    const m124 = mism().filter((m) => m.number === "INV-0124");
    expect(m124.some((m) => m.field === "net" && m.stated === 9900 && m.fromLines === 10000)).toBe(true);
    const m122 = mism().filter((m) => m.number === "INV-0122");
    expect(m122.length).toBeGreaterThan(0);
    expect(m122.every((m) => m.withinRounding)).toBe(true);
  });

  it("no clean invoice is on the list (the list is the mismatches, not noise); INV-0110 is there only because SliQ gave two invoices that number, so both documents' lines pool against each header", () => {
    const listed = new Set(mism().map((m) => m.number));
    expect([...listed].sort()).toEqual(["INV-0110", "INV-0122", "INV-0123", "INV-0124"]);
  });

  it("INV-0124 (a possible discount: net under its lines) is held back from the write until the operator excludes it, so it is not in the database", () => {
    expect(w.run.report.needsReview.some((n: { number: string }) => n.number === "INV-0124")).toBe(true);
    expect(rows.find((r) => r.ref === "INV-0124")).toBeUndefined();
  });

  it("INV-0123 IS written as stated (total 120.01 against net 100.00 + VAT 20.00): the importer lists it but does not block it, and the post-write reconciliation reports it", async () => {
    expect(p(db("INV-0123").total)).toBe(12001);
    const rep = await reconcileReadOnly(w.db.url, w.snapshot, { organizationId: w.orgId });
    const hits = rep.discrepancies.filter((d) => d.key === "INV-0123");
    expect(hits.map((d) => d.check)).toContain("invoice_internal_total");
  });

  it("the post-write reconciliation finds the same figure problems and no others: only INV-0123 (internal total) and INV-0122 (VAT rounding)", async () => {
    const rep = await reconcileReadOnly(w.db.url, w.snapshot, { organizationId: w.orgId });
    const figureChecks = new Set(["invoice_total", "invoice_internal_total", "invoice_lines_vs_net", "invoice_vat_vs_lines", "invoice_vat_rounding", "invoice_line_count"]);
    const figures = rep.discrepancies.filter((d) => figureChecks.has(d.check)).map((d) => `${d.check}:${d.key}`).sort();
    expect(figures).toEqual(["invoice_internal_total:INV-0123", "invoice_vat_rounding:INV-0122"]);
  });
});
