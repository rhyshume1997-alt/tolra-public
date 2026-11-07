/**
 * (4) DOCUMENT NUMBERING. Imported numbers are kept exactly as SliQ printed them (prefixes, leading zeros, odd styles). The company's own
 * numbering (public.next_doc_number, the only way the app takes a number) continues AFTER the highest imported number and never lands on an
 * existing document. A number the company already used is never overwritten: the SliQ document is held and reported. Gaps and duplicate
 * numbers in the source are reported. Another company's counters and documents are never touched.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { reconcileReadOnly } from "./reconcile";
import { createRehearsalDb, makeOrg, nextDocNumber, runImport, withClient } from "./support/db";
import { buildScenario } from "./support/synthetic";
import { buildWorld, type World } from "./support/world";

let w: World;
const q = <T = Record<string, unknown>>(url: string, sql: string, p: unknown[] = []) => withClient(url, async (db) => (await db.query(sql, p)).rows as T[]);
const counters = async (url: string, org: string) => Object.fromEntries((await q<{ prefix: string; last: number }>(url, "select prefix, last from public.doc_counters where organization_id = $1", [org])).map((r) => [r.prefix, Number(r.last)]));
const seqNo = (ref: string) => Number(/^INV-(\d+)$/.exec(ref)?.[1] ?? NaN);

beforeAll(async () => {
  w = await buildWorld("numbering");
});
afterAll(async () => {
  await w?.db.drop();
});

describe("imported numbers are preserved exactly", () => {
  it("every imported invoice and quote carries the number SliQ printed, byte for byte, including non-standard styles", async () => {
    const refs = (await q<{ r: string }>(w.db.url, "select invoice_ref as r from public.invoices where organization_id = $1", [w.orgId])).map((x) => x.r).sort();
    expect(refs).toEqual([...w.expectedImported].sort());
    for (const odd of w.scenario.facts.nonStandardNumbers) expect(refs).toContain(odd);
    expect(refs).toContain("00045"); // leading zeros survive: not 45
    const quotes = (await q<{ r: string }>(w.db.url, "select quote_ref as r from public.quotes where organization_id = $1", [w.orgId])).map((x) => x.r).sort();
    expect(quotes).toEqual(w.scenario.quotes.map((x) => x.number).sort());
  });

  it("no number was altered: the source number set minus what was held equals the database set, and nothing in the database is a renamed copy (no -B suffix)", async () => {
    const refs = (await q<{ r: string }>(w.db.url, "select invoice_ref as r from public.invoices where organization_id = $1", [w.orgId])).map((x) => x.r);
    expect(refs.filter((r) => /-[A-Z]$/.test(r))).toEqual([]);
  });

  it("PINNED, NOT YET WIRED: release 140's header says the importer keeps a duplicate's SliQ number in invoices.source_ref and gives it a -B number; the importer does neither (it holds duplicates), so source_ref is empty on every row", async () => {
    const n = (await q<{ n: string }>(w.db.url, "select count(*)::text as n from public.invoices where organization_id = $1 and source_ref is not null", [w.orgId]))[0].n;
    expect(n).toBe("0");
    // If the importer is later wired to source_ref this test fails on purpose: decide then whether duplicates are held or renumbered, and update README.md.
  });
});

describe("the company's own numbering continues after the import", () => {
  it("the INV and QUO counters sit at the highest imported number (INV-0339, QUO-0053); numbers in other styles do not move them", async () => {
    const c = await counters(w.db.url, w.orgId);
    expect(c.INV).toBe(339);
    expect(c.QUO).toBe(53);
  });

  it("the next numbers the company takes are INV-0340 and QUO-0054, in order, and none of them exists", async () => {
    const taken = new Set((await q<{ r: string }>(w.db.url, "select invoice_ref as r from public.invoices where organization_id = $1", [w.orgId])).map((x) => x.r));
    const a = await nextDocNumber(w.db.url, w.userId, "INV");
    const b = await nextDocNumber(w.db.url, w.userId, "INV");
    expect([a, b]).toEqual(["INV-0340", "INV-0341"]);
    expect(taken.has(a) || taken.has(b)).toBe(false);
    expect(await nextDocNumber(w.db.url, w.userId, "QUO")).toBe("QUO-0054");
  });

  it("taking the company's number does not hand out a number that an imported document already holds, even if the counter is wound back (restored afterwards)", async () => {
    const was = (await counters(w.db.url, w.orgId)).INV;
    await q(w.db.url, "update public.doc_counters set last = 105 where organization_id = $1 and prefix = 'INV'", [w.orgId]);
    try {
      const n = await nextDocNumber(w.db.url, w.userId, "INV");
      const taken = (await q<{ r: string }>(w.db.url, "select invoice_ref as r from public.invoices where organization_id = $1", [w.orgId])).map((x) => x.r);
      expect(taken).not.toContain(n);
      expect(seqNo(n)).toBeGreaterThan(105); // INV-0106.. exist, so next_doc_number skips forward to the first free number
    } finally {
      await q(w.db.url, "update public.doc_counters set last = $2 where organization_id = $1 and prefix = 'INV'", [w.orgId, was]);
    }
  });
});

describe("gaps and duplicates in the source are reported", () => {
  it("the importer's report lists INV-0110 as a duplicate number with both rows, and holds both", () => {
    const dup = w.run.report.duplicates.documents.find((d: { number: string }) => d.number === "INV-0110");
    expect(dup.rows).toHaveLength(2);
    expect(w.run.report.held.filter((h: { number: string }) => h.number === "INV-0110")).toHaveLength(2);
  });

  it("the post-write reconciliation reports the gaps in the invoice sequence, separating SliQ's own gaps (not in the file) from numbers that were in the file but not written", async () => {
    const rep = await reconcileReadOnly(w.db.url, w.snapshot, { organizationId: w.orgId });
    const gap = rep.discrepancies.find((d) => d.check === "number_gap" && d.key === "invoice:INV")!;
    const inDb = new Set(w.expectedImported);
    const inSrc = new Set(w.scenario.invoices.map((i) => i.number));
    const want: number[] = [];
    const wantNotInSource: number[] = [];
    for (let n = 100; n <= 339; n++) {
      const ref = `INV-${String(n).padStart(4, "0")}`;
      if (!inDb.has(ref)) {
        want.push(n);
        if (!inSrc.has(ref)) wantNotInSource.push(n);
      }
    }
    expect(gap.actual).toBe(want.length);
    expect(gap.detail).toContain(`of these ${wantNotInSource.length} are not in the source either`);
    expect(wantNotInSource).toContain(105); // SliQ's own gap
    expect(want).toContain(110); // in the file twice, held
    expect(want).toContain(111); // unknown customer, held
    expect(want).toContain(124); // excluded by the operator
    const dups = rep.discrepancies.filter((d) => d.check === "invoice_duplicate_in_source");
    expect(dups.map((d) => d.key)).toEqual(["INV-0110"]);
  });

  it("no counter is behind and no duplicate number exists in the database", async () => {
    const rep = await reconcileReadOnly(w.db.url, w.snapshot, { organizationId: w.orgId });
    expect(rep.discrepancies.filter((d) => d.entity === "counter" || d.check === "number_duplicate_in_database")).toEqual([]);
  });
});

describe("a number the company already used", () => {
  it("is never overwritten: the SliQ document with the same number is held and reported, the company's own is untouched, and counters still move past the import", async () => {
    const r = await createRehearsalDb("numcollide");
    try {
      const { orgId, userId } = await makeOrg(r.url, "t-numcollide");
      await q(r.url, "insert into public.invoices (organization_id, invoice_ref, customer, status, subtotal, vat, total) values ($1,'INV-0001','Own Customer','draft',1,0.2,1.2), ($1,'INV-0100','Own Customer','draft',50,10,60)", [orgId]);
      await q(r.url, "insert into public.doc_counters (organization_id, prefix, last) values ($1,'INV',100) on conflict (organization_id, prefix) do update set last = 100", [orgId]);
      const run = await runImport({ url: r.url, orgId, scenario: buildScenario() });
      expect(run.report.collisions.invoices.map((c: { number: string }) => c.number)).toEqual(["INV-0100"]);
      expect(run.report.held.find((h: { number: string }) => h.number === "INV-0100").reasons.join(" ")).toMatch(/already used by a different Tolra record/);
      const own = (await q(r.url, "select customer, status, total::text from public.invoices where organization_id = $1 and invoice_ref = 'INV-0100'", [orgId]))[0];
      expect(own).toEqual({ customer: "Own Customer", status: "draft", total: "60.00" });
      expect((await q(r.url, "select 1 from public.invoices where organization_id = $1 and invoice_ref = 'INV-0001'", [orgId])).length).toBe(1);
      expect((await counters(r.url, orgId)).INV).toBe(339);
      const rep = await reconcileReadOnly(r.url, (await import("./support/world")).snapshotFromScenario(buildScenario()), { organizationId: orgId, held: (await import("./reconcile")).heldFromReport(run.report) });
      const miss = rep.discrepancies.find((d) => d.check === "invoice_missing" && d.key === "INV-0100")!;
      expect(miss.explained).toMatch(/already used/); // listed AND explained by the importer's own report
      expect(await nextDocNumber(r.url, userId, "INV")).toBe("INV-0340");
    } finally {
      await r.drop();
    }
  });

  it("a counter already AHEAD of the import stays where it is, and another company's counter and documents are never touched", async () => {
    const r = await createRehearsalDb("numahead");
    try {
      const a = await makeOrg(r.url, "t-numahead-a");
      const b = await makeOrg(r.url, "t-numahead-b");
      for (const org of [a.orgId]) await q(r.url, "insert into public.doc_counters (organization_id, prefix, last) values ($1,'INV',500) on conflict (organization_id, prefix) do update set last = 500", [org]);
      await q(r.url, "insert into public.invoices (organization_id, invoice_ref, customer, status, subtotal, vat, total) values ($1,'INV-0100','Other Company Customer','draft',5,1,6)", [b.orgId]);
      await q(r.url, "insert into public.doc_counters (organization_id, prefix, last) values ($1,'INV',7) on conflict (organization_id, prefix) do update set last = 7", [b.orgId]);
      const before = await counters(r.url, b.orgId);
      const run = await runImport({ url: r.url, orgId: a.orgId, scenario: buildScenario() });
      expect(run.report.collisions.invoices).toEqual([]); // company B's INV-0100 is not company A's
      expect((await counters(r.url, a.orgId)).INV).toBe(500);
      expect(await nextDocNumber(r.url, a.userId, "INV")).toBe("INV-0501");
      expect(await counters(r.url, b.orgId)).toEqual(before);
      expect((await q(r.url, "select customer from public.invoices where organization_id = $1", [b.orgId])).map((x) => x.customer)).toEqual(["Other Company Customer"]);
      expect((await q(r.url, "select count(*)::int as n from public.customers where organization_id = $1", [b.orgId]))[0].n).toBe(0);
    } finally {
      await r.drop();
    }
  });
});
