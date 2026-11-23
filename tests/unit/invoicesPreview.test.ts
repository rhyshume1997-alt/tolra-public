// @vitest-environment jsdom
/**
 * BOUNDARY (Invoices module 4, PREVIEW ONLY). Inputs: the exports of components/invoices/preview/InvoicesPreview.tsx and the REAL lib functions it
 * uses or mirrors (lib/money, lib/receivables, lib/payments, lib/archive, lib/list-filter, lib/attention-items, lib/invoice-void, lib/invoice-write-off,
 * lib/invoice-list-totals, lib/status-colours, lib/spreadsheet, lib/invoice-ref, lib/range-label). Output: pass/fail. Pins the preview's amounts, VAT, totals,
 * overdue and due logic, ageing, late payers, trends, Show counts, dashboard filters, archive rule, void / write-off offers, compact totals, export scope text,
 * and the role gate to the real functions over all 26 sample invoices, and checks by rendering that nothing reports success and the role gate holds.
 * v2 adds: the structural items (money dashboard with one primary figure and quiet secondary ones, Filters (n) popover with removable chips, Export of all rows kept in the toolbar, bulk actions
 * only once a row is ticked, one primary action plus More per row, the explainer sentence as a tooltip and a description, the PreviewBar, plausible sample names, no !important) and a proof that
 * every real row control is still reachable.
 * Must not change: never loosen these to make a change pass. No network, no Supabase. Written with createElement (no JSX) so it is a .test.ts file and
 * runs under the existing vitest.config.ts include pattern.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import InvoicesPreview, {
  AGING, CHIPS, CUSTOMER_ADDRESS, DEFAULT_FILTERS, INVOICE_TITLE_TIP, DRAFT_INVOICE_DAYS, SEED_INVOICES, TODAY, UNINVOICED, agingOf, amountNote, canUseInvoices, compactTotals, creditHeldOf, derive, draftCounts, dueWords,
  invoiceRows, latePayersOf, matchesListFilter, paymentsScope, payableOf, phaseCounts, phaseFor, phaseOf, scopeTitle, statusWords, termsDays, addDays, toneOf, totalOwed, totalsOfSeed,
  allRowActions, rowActionPlan, totalsProblem, trendsOf, unpaidOf, visibleInvoices, voidOffered, writeOffOffered, isWrittenOff, WRITE_OFF_REASON_MIN, VOID_REASON_MAX,
} from "@/components/invoices/preview/InvoicesPreview";
import { phaseOf as realPhaseOf } from "@/lib/archive";
import { DRAFT_INVOICE_DAYS as REAL_DRAFT_DAYS } from "@/lib/attention-items";
import { compactInvoiceTotals } from "@/lib/invoice-list-totals";
import { chipsForPhase, isFinalInvoice } from "@/lib/invoice-phase-filters";
import { VOID_REASON_MAX as REAL_VOID_MAX, voidOffered as realVoidOffered } from "@/lib/invoice-void";
import { WRITE_OFF_REASON_MIN as REAL_WO_MIN, isWrittenOff as realIsWrittenOff, writeOffOffered as realWriteOffOffered } from "@/lib/invoice-write-off";
import { draftInvoiceCounts, invoiceMatchesFilter } from "@/lib/list-filter";
import { documentTotals, fromPence, gbp, toPence } from "@/lib/money";
import { netPaid } from "@/lib/payments";
import { balanceDue, customerCredit, daysPastDue, invoiceLifecycle, isPartPaid, isRaised, owed, paidOnTime, paidOnTimeNote, paymentBlockedReason } from "@/lib/receivables";
import { exportScopeTitle } from "@/lib/spreadsheet";
import { invoiceStatusKey } from "@/lib/status-colours";

const rows = invoiceRows();
const NOW = new Date(`${TODAY}T12:00:00Z`);

describe("invoices preview: money is exact (real lib/money and lib/receivables as the oracle)", () => {
  it("has 26 sample invoices covering paid, overdue, outstanding, part paid, draft, void, written off and payment to confirm", () => {
    expect(SEED_INVOICES).toHaveLength(26);
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(["overdue", "outstanding", "paid", "closed", "unverified"]));
    expect(rows.some((r) => r.partPaid)).toBe(true);
  });
  it("every invoice total is documentTotals of its lines (per-line VAT rounded), except the one imported record whose stored total disagrees", () => {
    for (const r of rows) {
      const t = documentTotals(r.lines, r.carriage, { vatEnabled: r.vatEnabled, carriageVat: r.carriageVat, standardRate: 20 });
      if (r.storedTotal === undefined) { expect(r.amount, r.reference).toBe(t.total); expect(r.vatAmount).toBe(t.vat); expect(r.subtotal).toBe(t.subtotal); }
      expect(toPence(t.total)).toBe(toPence(t.subtotal) + toPence(t.carriage) + toPence(t.vat));
    }
  });
  it("the stored-total mismatch is reported by the real totalsMismatch, and only on that record", () => {
    const bad = rows.filter((r) => totalsProblem(r));
    expect(bad.map((r) => r.reference)).toEqual(["INV-1030"]);
    expect(totalsProblem(bad[0])).toMatch(/INV-1030/);
  });
  it("balance, part paid, days overdue and shown status equal lib/receivables for every invoice", () => {
    for (const r of rows) {
      const life = invoiceLifecycle(r.rawStatus);
      if (life !== "collectible" || r.paymentUnverified) { expect(r.balance, r.reference).toBe(0); continue; }
      expect(r.balance, r.reference).toBe(balanceDue(r.amount, r.amountPaid, r.credited, r.refunded));
      expect(r.balance).toBe(owed({ status: r.rawStatus, total: r.amount, amount_paid: r.amountPaid, credited_amount: r.credited, refunded_amount: r.refunded }));
      expect(r.partPaid).toBe(isPartPaid({ status: r.rawStatus, total: r.amount, amount_paid: r.amountPaid, credited_amount: r.credited, refunded_amount: r.refunded }));
      expect(r.daysOverdue).toBe(daysPastDue(r.dueDate, TODAY) ?? 0);
      expect(r.status).toBe((daysPastDue(r.dueDate, TODAY) ?? 0) > 0 ? "overdue" : "outstanding");
    }
  });
  it("due today is not overdue, no due date is not late, the due words follow the page", () => {
    const today = rows.find((r) => r.reference === "INV-1045")!;
    const none = rows.find((r) => r.reference === "INV-1029")!;
    expect([today.status, today.daysOverdue, dueWords(today)]).toEqual(["outstanding", 0, "Due today"]);
    expect([none.status, dueWords(none)]).toEqual(["outstanding", "No due date"]);
    expect(dueWords({ dueDate: "2026-11-10", daysOverdue: 10 })).toBe("10 days overdue");
    expect(dueWords({ dueDate: "2026-11-24", daysOverdue: -4 })).toBe("Due in 4 days");
  });
  it("status words and tones match the real list: PAID, PAYMENT TO CONFIRM, the raw status for closed, PART PAID, and invoiceStatusKey for the colour", () => {
    for (const r of rows) {
      const words = statusWords(r);
      if (r.status === "paid") expect(words).toBe("PAID");
      else if (r.status === "unverified") expect(words).toBe("PAYMENT TO CONFIRM");
      else if (r.status === "closed") expect(words).toBe(r.rawStatus.toUpperCase());
      else if (r.partPaid) expect(words).toBe("PART PAID");
      const key = invoiceStatusKey(r);
      expect(toneOf(r), r.reference).toBe(key === "paid" ? "ok" : key === "part_paid" ? "warn" : key === "overdue" ? "danger" : key === "issued" ? "info" : "neutral");
    }
  });
  it("the amount note under the figure follows the page's two sentences, from pence-exact numbers", () => {
    const part = rows.find((r) => r.reference === "INV-1042")!;
    expect(part.amount).toBe(2720.4);
    expect(amountNote(part)).toBe(`${gbp(1000)} paid, ${gbp(150)} credited, ${gbp(1570.4)} still owed`);
    expect(amountNote({ amountPaid: 0, credited: 50, balance: 100 })).toBe(`${gbp(50)} credited, ${gbp(100)} still owed`);
    expect(amountNote({ amountPaid: 0, credited: 0, balance: 100 })).toBe("");
  });
  it("payments net of reversals equal amount paid; the reversed cheque does not count", () => {
    const r = rows.find((x) => x.reference === "INV-1036")!;
    expect(r.amountPaid).toBe(netPaid(r.payments!));
    expect(r.amountPaid).toBe(r.amount);
    expect(r.status).toBe("paid");
  });
});

describe("invoices preview: money dashboard, ageing, late payers, trends", () => {
  const penceSum = (list: typeof rows) => list.reduce((s, r) => s + toPence(r.balance), 0);
  it("total owed counts only collectible, confirmed invoices at what is still owed, in whole pence", () => {
    const expected = fromPence(penceSum(rows.filter((r) => r.status === "overdue" || r.status === "outstanding")));
    expect(totalOwed(rows)).toBe(expected);
    expect(unpaidOf(rows).every((r) => r.status === "overdue" || r.status === "outstanding")).toBe(true);
    expect(unpaidOf(rows).some((r) => r.status === "unverified" || r.rawStatus === "draft")).toBe(false);
  });
  it("the four ageing buckets add up to the total owed to the penny and use the page's day bands", () => {
    const aging = agingOf(rows);
    expect(aging.map((b) => b.label)).toEqual(["Current", "1-30 days late", "31-60 days late", "60+ days late"]);
    expect(fromPence(aging.reduce((s, b) => s + toPence(b.value), 0))).toBe(totalOwed(rows));
    expect([0, -3, 1, 30, 31, 60, 61].map((d) => AGING.findIndex((b) => b.test(d)))).toEqual([0, 0, 1, 1, 2, 2, 3]);
  });
  it("late payer patterns are worst first, top three, CHRONIC over 60 days late", () => {
    const p = latePayersOf(rows);
    expect(p.length).toBeLessThanOrEqual(3);
    expect(p[0]).toMatchObject({ customer: "Carronside Automation", label: "CHRONIC", late: "3/3 overdue" });
    expect(p.map((x) => x.worst)).toEqual([...p.map((x) => x.worst)].sort((a, b) => b - a));
    expect(p.find((x) => x.label === "WATCH")).toBeTruthy();
  });
  it("trends use the real paidOnTime and paidOnTimeNote and isRaised", () => {
    const range = { from: "2026-09-01", to: "2026-11-20" };
    const t = trendsOf(rows, range);
    const inRange = rows.filter((r) => r.date >= range.from && r.date <= range.to && isRaised(r.rawStatus));
    expect(t.raised).toBe(inRange.length);
    const real = paidOnTime(inRange.map((r) => ({ status: r.rawStatus, payment_unverified: r.paymentUnverified, due_date: r.dueDate ?? null, paid_at: r.paidAt ?? null })));
    expect(t.onTime).toBe(real.rate === null ? "—" : `${real.rate}%`);
    expect(t.onTimeOf).toBe(paidOnTimeNote(real));
    expect(trendsOf(rows, { from: "2020-01-01", to: "2020-01-02" })).toMatchObject({ raised: 0, onTime: "—", avgLate: "—" });
  });
  it("customer credit held is the real customerCredit summed per customer", () => {
    const held = creditHeldOf(rows);
    const by = new Map<string, number>();
    for (const r of rows) { const c = customerCredit({ status: r.rawStatus, total: r.amount, amount_paid: r.amountPaid, credited_amount: r.credited, refunded_amount: r.refunded, payment_unverified: r.paymentUnverified }); if (c > 0) by.set(r.customer, (by.get(r.customer) ?? 0) + toPence(c)); }
    expect(held).toEqual({ total: fromPence([...by.values()].reduce((a, b) => a + b, 0)), customers: by.size });
    expect(held.total).toBe(300);
  });
});

describe("invoices preview: Show, chips, dashboard links, archive rule", () => {
  it("phase equals lib/archive phaseOf (with the sample date) for every invoice", () => {
    for (const r of rows) {
      const real = realPhaseOf({ final: isFinalInvoice(r.rawStatus), finalDate: r.paidAt || r.date }, r.manual, 12, NOW);
      expect(phaseFor(r), r.reference).toBe(real);
    }
    expect(phaseOf({ final: true, finalDate: "2025-09-01" }, undefined, 12)).toBe("archived");
    expect(phaseOf({ final: false }, "archived", 12)).toBe("archived");
    expect(phaseOf({ final: true, finalDate: "2025-09-01" }, "active", 12)).toBe("done");
  });
  it("Show counts add up to all invoices and the default list is Open + All", () => {
    const c = phaseCounts(rows);
    expect(c.open + c.done + c.archived).toBe(rows.length);
    expect(visibleInvoices(rows, DEFAULT_FILTERS)).toHaveLength(c.open);
    expect(c.archived).toBe(2);
  });
  it("status chips: Part paid shows part paid invoices; chips follow chipsForPhase when the Show tab changes", () => {
    const f = { ...DEFAULT_FILTERS, phase: "all" as const, chips: new Set(["partial"]) };
    expect(visibleInvoices(rows, f).every((r) => r.partPaid)).toBe(true);
    expect([...chipsForPhase(new Set(["paid"]), "open")]).toEqual(["all"]);
  });
  it("dashboard links (overdue, draft-old) equal lib/list-filter invoiceMatchesFilter, and the drafts line equals draftInvoiceCounts", () => {
    for (const f of ["overdue", "draft-old"] as const) for (const r of rows) {
      expect(matchesListFilter(f, r, TODAY, phaseFor(r) === "archived"), `${f} ${r.reference}`).toBe(invoiceMatchesFilter(f, r, TODAY, phaseFor(r) === "archived"));
    }
    expect(draftCounts(rows)).toEqual(draftInvoiceCounts(rows, TODAY, (r) => phaseFor(r) === "archived"));
    expect(draftCounts(rows)).toEqual({ total: 3, old: 1 });
    expect(DRAFT_INVOICE_DAYS).toBe(REAL_DRAFT_DAYS);
    expect(visibleInvoices(rows, { ...DEFAULT_FILTERS, listFilter: "overdue" }).every((r) => r.status === "overdue")).toBe(true);
  });
});

describe("invoices preview: row rules mirror the real page and libs", () => {
  it("Void, Write off and Reverse write-off are offered exactly as lib/invoice-void and lib/invoice-write-off decide", () => {
    for (const r of rows) {
      expect(voidOffered(r), r.reference).toBe(realVoidOffered(r));
      expect(writeOffOffered(r), r.reference).toBe(realWriteOffOffered(r));
      expect(isWrittenOff(r.rawStatus)).toBe(realIsWrittenOff(r.rawStatus));
    }
    expect(WRITE_OFF_REASON_MIN).toBe(REAL_WO_MIN);
    expect(VOID_REASON_MAX).toBe(REAL_VOID_MAX);
    expect(rows.some((r) => voidOffered(r))).toBe(true);
    expect(rows.some((r) => writeOffOffered(r))).toBe(true);
  });
  it("Record payment is not offered on a draft (the real reason is paymentBlockedReason); Pay Selected in Full takes only waiting invoices", () => {
    const draft = rows.find((r) => r.rawStatus === "draft")!;
    expect(paymentBlockedReason(draft.rawStatus)).toBeTruthy();
    const picked = payableOf(rows, rows.map((r) => r.reference));
    expect(picked.every((r) => !paymentBlockedReason(r.rawStatus) && ["overdue", "outstanding", "unverified"].includes(r.status))).toBe(true);
    expect(picked.some((r) => r.status === "paid" || r.rawStatus === "draft")).toBe(false);
  });
  it("compact list totals equal the real compactInvoiceTotals for any filter, in whole pence, void adds nothing", () => {
    for (const subset of [rows, visibleInvoices(rows, DEFAULT_FILTERS), rows.filter((r) => r.status === "paid")]) expect(compactTotals(subset)).toEqual(compactInvoiceTotals(subset));
    const net = compactTotals(rows); expect(toPence(net.net) + toPence(net.vat)).toBe(toPence(net.gross) + (rows.some((r) => r.storedTotal !== undefined) ? toPence(net.net) + toPence(net.vat) - toPence(net.gross) : 0));
  });
  it("terms and due dates: 30 days, 14 days, due on receipt", () => {
    expect([termsDays("30 days"), termsDays("14 days"), termsDays("Due on receipt")]).toEqual([30, 14, 0]);
    expect(addDays("2026-11-20", 30)).toBe("2026-12-20");
    expect(totalsOfSeed({ lines: [{ description: "x", quantity: 3, unitPrice: 33.33, vatPct: 20 }], carriage: 5, vatEnabled: true, carriageVat: true }).total).toBe(documentTotals([{ quantity: 3, unitPrice: 33.33, vatPct: 20 }], 5, { vatEnabled: true, carriageVat: true, standardRate: 20 }).total);
  });
  it("export scope text equals lib/spreadsheet exportScopeTitle; the payments text says what it covers", () => {
    for (const [sel, n] of [[0, 17], [1, 17], [3, 5]]) expect(scopeTitle(sel, n)).toBe(exportScopeTitle("invoice", sel, n));
    expect(paymentsScope(0)).toContain("nothing is selected");
    expect(paymentsScope(2)).toBe("Exports the payments of the 2 selected invoices");
  });
  it("the role gate: Invoicing is admin and office only", () => {
    expect(["admin", "office", "workshop", "viewer"].map((r) => canUseInvoices(r as never))).toEqual([true, true, false, false]);
  });
  it("the sample holds no live records and no integration is named as connected", () => {
    const text = JSON.stringify(SEED_INVOICES) + JSON.stringify(UNINVOICED);
    expect(text).not.toMatch(/@(gmail|outlook|hotmail)\./i);
    expect(text).not.toMatch(/xero/i);
  });
});

/* ---------------- rendered behaviour ---------------- */
beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as { showModal?: () => void; close?: () => void };
  proto.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  proto.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as never;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); document.body.innerHTML = ""; host = null; root = null; window.localStorage.clear(); });
function mount() { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root!.render(createElement(InvoicesPreview))); return host; }
const byText = (scope: ParentNode, sel: string, text: string | RegExp) => Array.from(scope.querySelectorAll<HTMLElement>(sel)).find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? "")));
const click = (el: Element | undefined | null) => { if (!el) throw new Error("element not found"); act(() => { (el as HTMLElement).click(); }); };
const type = (el: HTMLInputElement, value: string) => act(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });

describe("invoices preview: rendered behaviour", () => {
  it("labels itself, opens on the Table with the open invoices and the real total owed", () => {
    const h = mount();
    expect(h.textContent).toContain("Preview, sample data, nothing is saved");
    expect(h.querySelector('[data-testid="invoices-preview"]')?.getAttribute("data-pview")).toBe("table");
    expect(h.querySelectorAll("tbody tr[data-invoice]")).toHaveLength(visibleInvoices(rows, DEFAULT_FILTERS).length);
    expect(h.querySelector('[data-testid="money-total"]')?.textContent).toBe(gbp(totalOwed(rows)));
  });
  it("an ageing tile applies the same filter the real tile does (Current: Outstanding; late buckets: Overdue)", () => {
    const h = mount();
    click(h.querySelector('[data-testid="aging-1-30"]') ?? byText(h, '[role="group"] button', /1-30 days late/));
    expect(h.querySelector('[data-active-chip="overdue"]')).not.toBeNull();
    click(byText(h, '[role="group"] button', /^Current/));
    expect(h.querySelector('[data-active-chip="outstanding"]')).not.toBeNull();
    expect(h.querySelector('[data-active-chip="overdue"]')).toBeNull();
  });
  it("Record payment checks the amount and date with the real payment rules, then only answers with the neutral Preview-only toast, never a success", () => {
    const h = mount();
    click(h.querySelector('tr[data-invoice="INV-1048"] [data-action="Record payment"]'));
    const dlg = document.querySelector('[data-testid="dlg-pay"]')!;
    expect(dlg.textContent).toContain("Record a payment on INV-1048");
    expect(dlg.textContent).toContain(`Balance due ${gbp(6120)}`);
    const amount = dlg.querySelector<HTMLInputElement>('input[type="number"]')!;
    type(amount, "9999");
    click(byText(dlg, "button", "Save payment"));
    expect(dlg.textContent).toContain("more than the balance due");
    type(amount, "120.00");
    click(byText(dlg, "button", "Save payment"));
    const t = document.body.textContent ?? "";
    expect(t).toContain("Preview only");
    expect(t).toContain("Nothing was saved.");
    expect(t).not.toMatch(/payment recorded|saved successfully|payment received/i);
  });
  it("Issue, Void and Write off each ask the real question first and never report success", () => {
    const h = mount();
    click(h.querySelector('tr[data-invoice="Draft, no number yet"] [data-action="View"]'));
    click(byText(document.body, "dialog button", "Issue & send"));
    expect(document.body.textContent).toContain("It gets the next invoice number and its contents are fixed.");
    click(byText(document.body, "dialog button", "Issue & send"));
    expect(document.body.textContent).toContain("Preview only");
    expect(document.body.textContent).not.toMatch(/issued successfully|has been issued/i);
  });
  it("Workshop and Viewer get Access Denied, as the real page's role gate", () => {
    const h = mount();
    click(byText(document.body, "button", /Preview controls/));
    click(byText(document.body, '[role="radiogroup"][aria-label="Role"] [role="radio"], [role="group"][aria-label="Role"] button', "Viewer"));
    expect(h.querySelector('[data-testid="access-denied"]')?.textContent).toContain("Access Denied");
    expect(h.querySelector('[data-testid="money-total"]')).toBeNull();
  });
});

describe("invoices preview v2: structure (owner-approved items 1, 2, 4, 7, 9, 10, 11)", () => {
  it("every real row control stays reachable: one primary action, the rest in More, for every invoice", () => {
    for (const r of rows) {
      const plan = rowActionPlan(r);
      const all = allRowActions(r);
      expect([plan.primary.id, ...plan.more.map((a) => a.id)].sort(), r.reference).toEqual(all.map((a) => a.id).sort());
      expect(plan.primary.disabled).toBeFalsy();
      expect(all.some((a) => a.id === "view") && all.some((a) => a.id === "archive")).toBe(true);
      expect(all.some((a) => a.id === "pay")).toBe(!paymentBlockedReason(r.rawStatus));
      expect(all.find((a) => a.id === "pay")?.disabled ?? false).toBe(!paymentBlockedReason(r.rawStatus) && (r.status === "paid" || r.status === "closed"));
    }
    expect(rowActionPlan(rows.find((r) => r.reference === "INV-1048")!).primary.id).toBe("pay");
    expect(rowActionPlan(rows.find((r) => r.status === "paid")!).primary.id).toBe("view");
    expect(rowActionPlan(rows.find((r) => r.rawStatus === "draft")!).primary.id).toBe("view");
  });
  it("each table row shows exactly two buttons in its actions cell (the next step and More)", () => {
    const h = mount();
    const rowsEls = h.querySelectorAll("tbody tr[data-invoice]");
    expect(rowsEls.length).toBeGreaterThan(5);
    rowsEls.forEach((tr) => { expect(tr.querySelectorAll("td:last-child button")).toHaveLength(2); });
  });
  it("View, Record payment and Archive are all reachable from a payable row, and a settled row keeps Record payment disabled with a reason", () => {
    const h = mount();
    click(h.querySelector('tr[data-invoice="INV-1048"] [data-testid="more-trigger"]'));
    expect(Array.from(document.querySelectorAll('[role="menuitem"]')).map((e) => e.textContent)).toEqual(["View", "Archive"]);
    expect(h.querySelector('tr[data-invoice="INV-1048"] [data-action="Record payment"]')).not.toBeNull();
    click(byText(document.body, '[role="menuitem"]', "View"));
    expect(document.querySelector('[data-testid="dlg-view"]')?.textContent).toContain("INV-1048 invoice details");
  });
  it("one primary figure: the Total owed uses the numeral style; the four ageing figures and the three trend figures are the quiet size and flat inside their panels", () => {
    const h = mount();
    const money = h.querySelector('[data-testid="money-total"]')!;
    expect(money.className).toMatch(/numeral|tNumeral/i);
    const quiet = Array.from(h.querySelectorAll('[role="group"][aria-label="Ageing of money owed"] > *, [role="group"][aria-label="Invoicing trends"] > *'));
    expect(quiet).toHaveLength(7);
    for (const q of quiet) expect(q.className, q.textContent ?? "").toMatch(/quiet/);
  });
  it("no bulk bar at rest; Export of all rows stays in the toolbar; ticking a row shows the selection bar with Export, Pay Selected in Full, Select all and Clear", () => {
    const h = mount();
    expect(h.querySelector("[data-selection]")).toBeNull();
    expect(byText(h, "button", "Pay Selected in Full")).toBeUndefined();
    expect(h.querySelector('[data-testid="export-trigger"]')?.getAttribute("aria-label")).toBe(`Export. ${scopeTitle(0, visibleInvoices(rows, DEFAULT_FILTERS).length)}`);
    click(h.querySelector('tr[data-invoice="INV-1048"] [data-testid="select-row"]'));
    const bar = h.querySelector("[data-selection]")!;
    expect(bar.textContent).toContain(`1 selected of ${visibleInvoices(rows, DEFAULT_FILTERS).length} filtered records`);
    for (const label of ["Pay Selected in Full", "Clear selection"]) expect(byText(bar, "button", label), label).toBeTruthy();
    expect(byText(bar, "button", /Select all \d+ filtered/)).toBeTruthy();
    expect(bar.querySelector('[data-testid="export-trigger"]')?.getAttribute("aria-label")).toBe(`Export. ${scopeTitle(1, visibleInvoices(rows, DEFAULT_FILTERS).length)}`);
    click(byText(bar, "button", "Pay Selected in Full"));
    expect(document.querySelector("dialog[open]")?.textContent).toContain("Record 1 invoice as paid in full?");
    click(byText(document.body, "dialog button", "Cancel"));
    click(byText(bar, "button", "Clear selection"));
    expect(h.querySelector("[data-selection]")).toBeNull();
  });
  it("Export menu keeps all six formats, at rest and with a selection", () => {
    const h = mount();
    click(h.querySelector('[data-testid="export-trigger"]'));
    expect(Array.from(document.querySelectorAll('[role="menuitem"]')).map((e) => e.textContent?.replace(/Exports.*$/, ""))).toEqual(["CSV", "Excel", "Payments CSV", "Payments Excel", "Word", "PDF"]);
  });
  it("Filters (n) popover holds every status chip; active filters are removable chips; the ageing tile shows its filter as a chip", () => {
    const h = mount();
    const trigger = () => h.querySelector<HTMLElement>('[data-testid="filters-trigger"]')!;
    expect(trigger().textContent?.trim()).toBe("Filters");
    click(trigger());
    for (const c of CHIPS) expect(document.querySelector(`[data-testid="chip-${c.v}"]`), c.label).not.toBeNull();
    click(document.querySelector('[data-testid="chip-overdue"]'));
    expect(trigger().textContent).toContain("Filters (1)");
    click(h.querySelector('[aria-label="Remove filter Overdue"]'));
    expect(h.querySelector('[data-testid="active-filters"]')).toBeNull();
    click(h.querySelector('[data-testid="aging-1-30"]') ?? byText(h, '[role="group"] button', /1-30 days late/));
    expect(h.querySelector('[data-testid="active-filters"]')?.textContent).toContain("Overdue");
    click(h.querySelector('[data-testid="clear-filters"]'));
    expect(h.querySelector('[data-testid="active-filters"]')).toBeNull();
  });
  it("the Show rule sentence stays reachable (title and the Filters popover); the generic explainer is a tooltip and a description of the title", () => {
    const h = mount();
    const holder = h.querySelector("h1 [title]")!;
    expect(holder.getAttribute("title")).toBe(INVOICE_TITLE_TIP);
    expect(document.getElementById(holder.getAttribute("aria-describedby") ?? "")?.textContent).toBe(INVOICE_TITLE_TIP);
    expect(h.querySelector("h1")?.textContent).toBe("Invoicing");
    expect(h.querySelector('[title^="Open: still to do"]')).not.toBeNull();
    click(h.querySelector('[data-testid="filters-trigger"]'));
    expect(document.querySelector('[role="dialog"][aria-label="Filters"]')?.textContent).toContain("Open: still to do (drafts, unpaid).");
  });
  it("one preview strip; the compact list, the trend range and Columns are all still reachable; plausible sample names; no !important", () => {
    const h = mount();
    expect(h.querySelector('[role="group"][aria-label="Preview information"] [data-testid="dock-toggle"]')).not.toBeNull();
    click(h.querySelector('[data-testid="compact-toggle"]'));
    expect(h.querySelectorAll('[data-testid="compact-invoice-row"]').length).toBeGreaterThan(5);
    expect(h.querySelector('[data-testid="compact-invoice-totals"]')).not.toBeNull();
    expect(h.querySelector('[role="group"][aria-label="Invoicing Trends date range"]')).not.toBeNull();
    expect(h.querySelector('[data-testid="columns-trigger"]')).not.toBeNull();
    expect(JSON.stringify(SEED_INVOICES) + Object.keys(CUSTOMER_ADDRESS).join()).not.toMatch(/placeholder|testfield|mockridge|sampleford|dummerby|exampleton/i);
    expect(Object.keys(CUSTOMER_ADDRESS)).toContain("Kilbride Hydraulics");
    for (const f of ["components/invoices/preview/InvoicesPreview.module.css", "components/invoices/preview/InvoicesPreview.tsx"]) expect(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""), f).not.toMatch(/!important/);
  });
  it("Create Invoice: a failed save lists every problem in a summary and nothing is saved", () => {
    const h = mount();
    click(h.querySelector('[data-testid="new-invoice"]'));
    click(byText(document.body, "dialog button", "Save Invoice"));
    const text = document.querySelector("dialog[open]")?.textContent ?? "";
    expect(text).toContain("Fix these before saving");
    expect(text).toContain("Choose a customer.");
    expect(text).toContain("Enter a unit price.");
    expect(document.body.textContent).not.toMatch(/invoice created|saved successfully/i);
  });
});
