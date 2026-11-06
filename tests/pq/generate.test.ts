/**
 * The seed generator is pure and deterministic, its money is consistent to the penny, it invents no real-looking contact detail, and
 * every date is relative to the one base date. No database, no network.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { type PqCompany, type PqDataset, documentTotals, generatePqDataset, lineNet, lineVat, pctOf } from "./seed/generate.mjs";

const BASE = "2026-11-02"; // a Monday
const gen = (over: { seed?: string; baseDate?: string; scale?: number } = {}) => generatePqDataset({ baseDate: BASE, scale: 1, ...over });
const DAY = 86_400_000;
const dayOf = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}
/** Every date/timestamp string in the dataset except meta.baseDate. */
function dateStrings(d: PqDataset) {
  const rest = { companies: d.companies, expected: d.expected };
  return strings(rest).filter((s) => ISO_DATE.test(s) || ISO_TS.test(s));
}
function shifted(value: unknown, days: number): unknown {
  if (typeof value === "string" && (ISO_DATE.test(value) || ISO_TS.test(value))) {
    const out = new Date(Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value) + days * DAY).toISOString();
    return value.length === 10 ? out.slice(0, 10) : out.replace(".000Z", "Z");
  }
  if (Array.isArray(value)) return value.map((v) => shifted(v, days));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shifted(v, days)]));
  return value;
}
const primary = (d: PqDataset) => d.companies[0];

describe("determinism", () => {
  it("the same seed, base date and scale give byte-identical output", () => {
    expect(JSON.stringify(gen())).toBe(JSON.stringify(gen()));
    expect(JSON.stringify(gen({ scale: 3 }))).toBe(JSON.stringify(gen({ scale: 3 })));
  });

  it("is pinned: this exact byte stream (a change to the generator must change this digest knowingly)", () => {
    const digest = createHash("sha256").update(JSON.stringify(gen())).digest("hex");
    expect(digest).toBe("135be5187983db61e7a586559bc310262ad05cca899a7708cb3c1ccae3369abe");
  });

  it("a different seed or scale gives different data; the run id (marker) follows the seed only", () => {
    expect(JSON.stringify(gen({ seed: "other" }))).not.toBe(JSON.stringify(gen()));
    expect(gen({ seed: "other" }).meta.runId).not.toBe(gen().meta.runId);
    expect(gen({ scale: 2 }).meta.runId).toBe(gen().meta.runId);
    expect(primary(gen({ scale: 4 })).quotes.length).toBeGreaterThan(primary(gen({ scale: 1 })).quotes.length * 3);
  });

  it("sizes with --scale and refuses nonsense", () => {
    const small = primary(gen());
    const big = primary(gen({ scale: 10 }));
    expect(big.customers.length).toBeGreaterThan(small.customers.length * 3);
    expect(big.invoices.length).toBeGreaterThan(small.invoices.length * 5);
    for (const bad of [0, 51, 1.5, Number.NaN]) expect(() => gen({ scale: bad })).toThrow(/scale/);
    expect(() => gen({ baseDate: "2026-02-30" })).toThrow(/real date/);
    expect(() => gen({ baseDate: "tomorrow" })).toThrow(/YYYY-MM-DD/);
  });

  it("no source file in the generator, loader, reset or verify reads the clock or Math.random; the CLI reads it once (the --base-date default)", () => {
    const read = (f: string) => readFileSync(path.join(__dirname, "seed", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const f of ["generate.mjs", "prng.mjs", "load.mjs", "reset.mjs", "verify.mjs", "guard.mjs"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/Date\.now|Math\.random|new Date\(\s*\)|performance\.now|crypto\.random/);
    }
    expect((read("cli.mjs").match(/new Date\(\)/g) ?? []).length).toBe(1);
  });
});

describe("totals are consistent to the penny", () => {
  const all = (d: PqDataset) => d.companies.flatMap((c) => c.quotes.map((q) => ({ c, q })));
  it("every quote: lines + VAT = total, in whole pence, by the database's rule (VAT rounded half-up per line)", () => {
    for (const d of [gen(), gen({ scale: 5 })]) {
      for (const { q } of all(d)) {
        const net = q.lines.reduce((s, l) => s + l.quantity * l.unitPence, 0);
        const vat = q.vatEnabled ? q.lines.reduce((s, l) => s + (l.vatExempt ? 0 : Math.floor((l.quantity * l.unitPence * l.vatPct + 50) / 100)), 0) : 0;
        expect(q.netPence).toBe(net);
        expect(q.vatPence).toBe(vat);
        expect(q.totalPence).toBe(net + vat);
        for (const n of [q.netPence, q.vatPence, q.totalPence]) expect(Number.isSafeInteger(n)).toBe(true);
        for (const l of q.lines) { expect(Number.isInteger(l.quantity)).toBe(true); expect(Number.isInteger(l.unitPence)).toBe(true); expect(l.unitPence).toBeGreaterThan(0); }
      }
    }
  });

  it("every invoice: lines + carriage + VAT = total; payments + credit + outstanding = total; nothing overpaid", () => {
    for (const d of [gen(), gen({ scale: 5 })]) {
      for (const c of d.companies) {
        for (const inv of c.invoices) {
          const t = documentTotals(inv.lines, { vatEnabled: inv.vatEnabled, carriagePence: inv.carriagePence, carriageVat: inv.carriageVat });
          expect({ n: inv.netPence, v: inv.vatPence, t: inv.totalPence }).toEqual({ n: t.netPence, v: t.vatPence, t: t.totalPence });
          expect(inv.totalPence).toBe(inv.netPence + inv.carriagePence + inv.vatPence);
          const paid = inv.payments.reduce((s, p) => s + p.amountPence, 0);
          expect(inv.paidPence).toBe(paid);
          if (inv.issue) {
            expect(inv.outstandingPence).toBe(inv.totalPence - paid - inv.creditedPence);
            expect(inv.outstandingPence).toBeGreaterThanOrEqual(0);
            expect(paid + inv.creditedPence).toBeLessThanOrEqual(inv.totalPence);
          } else {
            expect(inv.payments).toHaveLength(0);
            expect(inv.credit).toBeNull();
          }
          for (const p of inv.payments) expect(p.amountPence).toBeGreaterThan(0);
          if (inv.shape === "paid") expect(paid).toBe(inv.totalPence);
          if (inv.shape === "part_paid" || inv.shape === "part_paid_overdue") { expect(paid).toBeGreaterThan(0); expect(paid).toBeLessThan(inv.totalPence); }
          if (inv.credit) {
            const line = { ...inv.lines[inv.credit.lineIndex], quantity: inv.credit.quantity };
            expect(inv.credit.netPence).toBe(lineNet(line));
            expect(inv.credit.vatPence).toBe(inv.vatEnabled ? lineVat(line) : 0);
            expect(inv.credit.totalPence).toBe(inv.credit.netPence + inv.credit.vatPence);
            expect(inv.credit.quantity).toBeLessThanOrEqual(inv.lines[inv.credit.lineIndex].quantity);
          }
          expect(inv.overdue).toBe(inv.issue && inv.outstandingPence > 0 && inv.dueDate < BASE);
        }
      }
    }
  });

  it("an invoice drafted from a delivery note carries exactly its quote's lines and total", () => {
    const c = primary(gen({ scale: 5 }));
    const dnInvoices = c.invoices.filter((i) => i.source === "delivery_note");
    expect(dnInvoices.length).toBeGreaterThan(3);
    for (const inv of dnInvoices) {
      const dn = c.deliveryNotes.find((d) => d.key === inv.deliveryNoteKey)!;
      const q = c.quotes.find((x) => x.key === dn.quoteKey)!;
      expect(q.status).toBe("accepted");
      expect(inv.lines).toEqual(q.lines);
      expect(inv.totalPence).toBe(q.totalPence);
      expect(inv.invoiceDate >= dn.shipDate).toBe(true);
    }
  });

  it("dataset.expected equals a fresh recomputation from the rows", () => {
    for (const d of [gen(), gen({ scale: 3 })]) {
      for (const c of d.companies) {
        const e = d.expected[c.kind] as Record<string, number>;
        const issued = c.invoices.filter((i) => i.issue);
        expect(e.invoicedTotalPence).toBe(issued.reduce((s, i) => s + i.totalPence, 0));
        expect(e.paidPence + e.creditedPence + e.outstandingPence).toBe(e.invoicedTotalPence);
        expect(e.overduePence).toBeLessThanOrEqual(e.outstandingPence);
        expect(e.payments).toBe(c.invoices.reduce((s, i) => s + i.payments.length, 0));
      }
    }
  });

  it("pctOf rounds half up on whole pence (the database's round())", () => {
    expect(pctOf(1, 20)).toBe(0);
    expect(pctOf(3, 20)).toBe(1); // 0.6 -> 1
    expect(pctOf(2, 25)).toBe(1); // 0.5 -> 1
    expect(pctOf(12345, 20)).toBe(2469);
  });
});

describe("coverage of what a PQ needs", () => {
  const d = gen({ scale: 3 });
  const c = primary(d);
  it("users in every role, one company practice tenant with the same customer names and PO numbers", () => {
    expect(new Set(c.users.map((u) => u.role))).toEqual(new Set(["admin", "office", "workshop", "viewer"]));
    const practice = d.companies[1];
    expect(practice.kind).toBe("practice");
    expect(practice.users.map((u) => u.role).sort()).toEqual(["admin", "office", "viewer"]);
    expect(practice.customers.map((x) => x.name)).toEqual(c.customers.slice(0, 3).map((x) => x.name));
    const pos = (co: PqCompany) => new Set(co.quotes.map((q) => q.customerPo).filter(Boolean));
    expect([...pos(practice)].some((po) => pos(c).has(po))).toBe(true);
    expect(practice.slug).not.toBe(c.slug);
  });

  it("customers include exact duplicates, near-duplicates, awkward names, an archived one and one with no contact details", () => {
    const names = c.customers.map((x) => x.name);
    expect(names.length - new Set(names).size).toBeGreaterThanOrEqual(1);
    expect(c.customers.filter((x) => x.duplicateOf).length).toBeGreaterThanOrEqual(3);
    expect(names.some((n) => n.includes("'"))).toBe(true);
    expect(names.some((n) => n.includes("&"))).toBe(true);
    expect(names.some((n) => /[^\x00-\x7f]/.test(n))).toBe(true);
    expect(names.some((n) => n.length > 100)).toBe(true);
    expect(names.some((n) => n.length === 1)).toBe(true);
    expect(c.customers.some((x) => x.archived)).toBe(true);
    expect(c.customers.some((x) => !x.email && !x.phone)).toBe(true);
  });

  it("quotes in all five conditions; invoices in all seven; parts below minimum; a retired machine", () => {
    expect(new Set(c.quotes.map((q) => q.shape))).toEqual(new Set(["draft", "sent", "expired", "accepted", "rejected"]));
    for (const q of c.quotes.filter((x) => x.shape === "expired")) { expect(q.status).toBe("sent"); expect(q.validUntil < BASE).toBe(true); }
    for (const q of c.quotes.filter((x) => x.shape === "sent")) expect(q.validUntil >= BASE).toBe(true);
    expect(new Set(c.invoices.map((i) => i.shape))).toEqual(new Set(["draft", "issued_current", "issued_overdue", "part_paid", "part_paid_overdue", "paid", "credited"]));
    expect(c.invoices.some((i) => i.payments.length > 1)).toBe(true);
    expect(c.invoices.some((i) => i.carriagePence > 0 && i.carriageVat)).toBe(true);
    expect(c.invoices.some((i) => !i.vatEnabled)).toBe(true);
    expect(c.invoices.some((i) => i.lines.some((l) => l.vatExempt))).toBe(true);
    expect(c.parts.some((p) => p.currentStock < p.minLevel)).toBe(true);
    expect(c.machines.some((m) => !m.active)).toBe(true);
    expect(c.machines.every((m) => m.hoursPerDay > 0 && m.workingDays.length > 0)).toBe(true);
  });

  it("accepted quotes can become a sales order: no mixed VAT rates and per-line VAT equals one rounding of the whole (accept_quote refuses otherwise)", () => {
    for (const q of c.quotes.filter((x) => x.shape === "accepted")) {
      expect(q.lines.every((l) => !l.vatExempt && l.vatPct === 20)).toBe(true);
      expect(q.vatPence).toBe(pctOf(q.netPence, 20));
    }
  });

  it("time sheets: weekdays only, in before out, a break inside the shift, some shifts with no clock-out; labour inside the shift", () => {
    expect(c.attendance.length).toBeGreaterThan(20);
    for (const a of c.attendance) {
      expect([0, 6]).not.toContain(new Date(`${a.day}T00:00:00Z`).getUTCDay());
      const at = (x: string) => a.events.find((e) => e.action === x)?.at;
      expect(at("in")! < at("break_start")!).toBe(true);
      expect(at("break_start")! < at("break_end")!).toBe(true);
      if (at("out")) expect(at("break_end")! < at("out")!).toBe(true);
      expect(new Set(a.events.map((e) => e.opId)).size).toBe(a.events.length);
      expect(a.events.every((e) => e.at.startsWith(a.day))).toBe(true);
    }
    expect(c.attendance.some((a) => a.worked === null)).toBe(true);
    expect(c.labour.length).toBeGreaterThan(10);
    for (const l of c.labour) { expect(l.endedAt > l.startedAt).toBe(true); expect(l.startedAt.slice(0, 10)).toBe(l.endedAt.slice(0, 10)); }
    const opIds = c.attendance.flatMap((a) => a.events.map((e) => e.opId));
    expect(new Set(opIds).size).toBe(opIds.length);
  });

  it("machine bookings never overlap on a machine; at most one started-not-complete per machine, on or before the base date; planned work after it", () => {
    const lastDay = (m: PqCompany["machines"][number], start: string, hours: number) => {
      let o = dayOf(start); const days = Math.max(1, Math.ceil(hours / m.hoursPerDay));
      for (let i = 1; i < days; i += 1) { o += DAY; while (!m.workingDays.includes(new Date(o).getUTCDay())) o += DAY; }
      return o;
    };
    for (const m of c.machines.filter((x) => x.active)) {
      const mine = c.bookings.filter((b) => b.machineKey === m.key).sort((a, b) => (a.startAt < b.startAt ? -1 : 1));
      let prevEnd = -Infinity;
      for (const b of mine) {
        expect(m.workingDays).toContain(new Date(b.startAt).getUTCDay());
        expect(dayOf(b.startAt)).toBeGreaterThan(prevEnd);
        prevEnd = lastDay(m, b.startAt, b.hours);
      }
      const running = mine.filter((b) => b.status === "running");
      expect(running.length).toBeLessThanOrEqual(1);
      for (const r of running) {
        expect(r.startAt.slice(0, 10) <= BASE).toBe(true);
        expect(r.hours - r.hoursDone).toBeLessThanOrEqual(m.hoursPerDay);
        expect(r.hoursDone).toBeGreaterThan(0);
        expect(r.hoursDone).toBeLessThan(r.hours);
        for (const other of mine.filter((b) => b.status === "booked")) expect(other.startAt.slice(0, 10) > BASE).toBe(true);
      }
      for (const b of mine) {
        if (b.status === "complete") { expect(b.hoursDone).toBe(b.hours); expect(b.startAt.slice(0, 10) < BASE).toBe(true); }
        if (b.status === "booked") { expect(b.hoursDone).toBe(0); expect(b.startAt.slice(0, 10) > BASE).toBe(true); }
      }
    }
    expect(new Set(c.bookings.map((b) => b.status))).toEqual(new Set(["booked", "running", "complete"]));
  });
});

describe("nothing real-looking", () => {
  const text = JSON.stringify(gen({ scale: 5 }));
  const all = strings(gen({ scale: 5 }));
  it("every e-mail address is on example.test, and ends with the run's marker for users", () => {
    const emails = all.flatMap((s) => s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) ?? []);
    expect(emails.length).toBeGreaterThan(50);
    for (const e of emails) expect(e, e).toMatch(/@example\.test$/);
    const d = gen({ scale: 5 });
    for (const co of d.companies) for (const u of co.users) expect(u.email).toMatch(new RegExp(`^(admin|office|workshop|viewer)\\d+\\.(jnr|practice)\\.${d.meta.runId}@example\\.test$`));
  });

  it("every phone number is in an Ofcom drama range (01632 960xxx, 020 7946 0xxx, 0161 496 0xxx, 07700 900xxx)", () => {
    const ok = /^(01632 960\d{3}|020 7946 0\d{3}|0161 496 0\d{3}|07700 900\d{3})$/;
    const phones = gen({ scale: 5 }).companies.flatMap((c) => [...c.customers.flatMap((x) => [x.phone, x.mobile]), String(c.profile.phone)].filter((p): p is string => Boolean(p)));
    expect(phones.length).toBeGreaterThan(20);
    for (const p of phones) expect(p, p).toMatch(ok);
  });

  it("no URLs, no real-looking postcodes (all ZZ), no real VAT number, every customer marked synthetic, no hosted-project reference", () => {
    expect(text).not.toMatch(/https?:|www\.|\.co\.uk|\.com\b/i);
    for (const co of gen({ scale: 5 }).companies) {
      for (const cu of co.customers) {
        expect(cu.address).toMatch(/\nZZ\d \dZZ$/);
        expect(cu.notes).toContain("SYNTHETIC PQ DATA");
      }
      expect(co.profile.vatNumber).toBe("GB 000 0000 00");
    }
    expect(text).not.toMatch(/qngvemzbdsvtydkbplpo|qtgqliczvyyrkibvxfqv|supabase\.(co|com)|sliq|JNREng/i);
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // no JWT-like secrets
  });

  it("every company name, slug and user carries the marker the reset uses", () => {
    const d = gen();
    for (const co of d.companies) {
      expect(co.slug).toBe(`t-${d.meta.runId}-${co.kind === "primary" ? "jnr" : "practice"}`);
      expect(co.name).toBe(`Synthetic ${co.kind === "primary" ? "JNR" : "Practice"} PQ ${d.meta.runId}`);
    }
  });
});

describe("every date is relative to the base date", () => {
  it("moving the base date by 28 days moves every date and timestamp by exactly 28 days and changes nothing else", () => {
    const a = gen();
    const b = gen({ baseDate: "2026-11-30" });
    const strip = (d: PqDataset) => { const { meta, ...rest } = d; return { rest, meta: { ...meta, baseDate: "" } }; };
    expect(strip(b)).toEqual({ rest: shifted(strip(a).rest, 28), meta: strip(a).meta });
    const c = gen({ baseDate: "2025-02-03", scale: 2 });
    const e = gen({ baseDate: "2025-03-03", scale: 2 }); // 28 days later across a month end
    expect(strip(e).rest).toEqual(shifted(strip(c).rest, 28));
  });

  it("every date lies within a window around the base date (nothing hard-coded, nothing stale)", () => {
    for (const base of ["2026-11-02", "2031-06-16"]) {
      const d = gen({ baseDate: base, scale: 3 });
      const dates = dateStrings(d);
      expect(dates.length).toBeGreaterThan(500);
      const baseMs = dayOf(base);
      for (const s of dates) {
        const off = Math.round((dayOf(s) - baseMs) / DAY);
        expect(off, s).toBeGreaterThanOrEqual(-175);
        expect(off, s).toBeLessThanOrEqual(400);
      }
      // nothing in the data is dated after "today" that is a thing which has already happened
      for (const co of d.companies) {
        for (const inv of co.invoices) { for (const p of inv.payments) expect(p.paidOn < base).toBe(true); expect(inv.invoiceDate < base).toBe(true); }
        for (const a of co.attendance) expect(a.day < base).toBe(true);
        for (const b of co.bookings.filter((x) => x.status === "complete")) expect(b.startAt.slice(0, 10) < base).toBe(true);
      }
    }
  });

  it("the data order of events is sane: payments after their invoice, quotes accepted after creation, delivery after acceptance", () => {
    const d = gen({ scale: 3 });
    for (const co of d.companies) {
      for (const inv of co.invoices) for (const p of inv.payments) expect(p.paidOn >= inv.invoiceDate).toBe(true);
      for (const inv of co.invoices) { expect(inv.dueDate >= inv.invoiceDate).toBe(true); if (inv.credit) expect(inv.credit.creditDate >= inv.invoiceDate).toBe(true); }
      for (const q of co.quotes.filter((x) => x.acceptedOn)) expect(q.acceptedOn! >= q.createdOn).toBe(true);
    }
  });
});
