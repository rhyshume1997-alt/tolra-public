// @vitest-environment jsdom
/**
 * BOUNDARY (Quotes module 3, PREVIEW ONLY). Inputs: the exports of components/quotes/preview/QuotesPreview.tsx and the REAL lib functions
 * it mirrors (lib/quote-status, lib/list-filter, lib/quote-expiry, lib/money, lib/spreadsheet, lib/quote-versions, lib/customer-po).
 * Output: pass/fail. Pins the preview's local logic to the real functions over all 22 sample quotes, so the preview cannot drift from
 * today's Quote Generator: shown status, tile figures, Show counts, the status legend, the dashboard filters, the archive rule, export scope
 * text, accept block, expiry question, line references. Also checks the role gate, that the sample has no live records, and a few
 * interaction rules (nothing reports success, select all, status chips) by rendering the preview.
 * Must not change: never loosen these to make a change pass. No network, no Supabase. Written with createElement (no JSX) so it is a
 * .test.ts file and runs under the existing vitest.config.ts include pattern.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import QuotesPreview, {
  ARCHIVE_MONTHS, CUSTOMER_EMAIL, DEFAULT_FILTERS, QUOTE_FILTER_LABELS, SEED_QUOTES, STATUS_ORDER, TODAY, acceptBlock, canOfferSend, canRecordDecision, canUseQuotes,
  customerPoBeside, effectiveStatus, expiredMessage, figuresOf, groupsOf, legendOf, lineReference, matchesListFilter, newestFirst, phaseCounts, phaseOf, quoteRows,
  scopeTitle, totalsOf, visibleQuotes,
} from "@/components/quotes/preview/QuotesPreview";
import { phaseOf as realPhaseOf } from "@/lib/archive";
import { DEFAULT_QUOTE_VALIDITY_DAYS, canOfferSend as realCanOfferSend, canRecordDecision as realCanRecord, effectiveQuoteStatus, newestFirst as realNewest, quoteAcceptBlock, quoteFigures, statusCounts } from "@/lib/quote-status";
import { QUOTE_FILTER_LABELS as REAL_LABELS, quoteLegend, quoteMatchesFilter } from "@/lib/list-filter";
import { expiredQuoteCheck } from "@/lib/quote-expiry";
import { documentTotals, gbp as realGbp } from "@/lib/money";
import { exportScopeTitle } from "@/lib/spreadsheet";
import { lineReference as realLineRef } from "@/lib/quote-versions";
import { customerPoBeside as realPoBeside } from "@/lib/customer-po";
import { fmtDate as realFmtDate } from "@/lib/dates";
import { gbp, fmtDate } from "@/components/quotes/preview/QuotesPreview";

const NOW = new Date(`${TODAY}T12:00:00Z`);
const rows = quoteRows();
const asReal = (q: (typeof rows)[number]) => ({ ...q, status: q.status, rawStatus: q.rawStatus });
const refs = (list: Array<{ ref: string }>) => list.map((q) => q.ref);

describe("quotes preview: logic matches the real Quote Generator (lib functions as the oracle)", () => {
  it("has 22 sample quotes covering every status, newest first", () => {
    expect(SEED_QUOTES).toHaveLength(22);
    expect(new Set(rows.map((q) => q.status))).toEqual(new Set(STATUS_ORDER));
    expect(refs(newestFirst(rows))).toEqual(refs(realNewest(rows)));
  });
  it("shown status equals effectiveQuoteStatus for every quote", () => {
    for (const q of rows) expect(q.status, q.ref).toBe(effectiveQuoteStatus(q.rawStatus, q.validUntil, TODAY));
  });
  it("quote values equal documentTotals (per-line VAT) and declined value is the unordered lines", () => {
    for (const q of SEED_QUOTES) {
      const lines = q.lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice }));
      expect(totalsOf(lines, q.vatEnabled).total, q.ref).toBe(documentTotals(lines, 0, { vatEnabled: q.vatEnabled, standardRate: 20 }).total);
    }
    const dec = rows.find((q) => q.declinedValue > 0)!;
    expect(dec.ref).toBe("QUO-0428");
    expect(dec.declinedValue).toBe(documentTotals(dec.lines.filter((l) => l.declined).map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice })), 0, { standardRate: 20 }).total);
  });
  it("tile figures equal quoteFigures", () => {
    const real = quoteFigures(rows.map((q) => ({ status: q.rawStatus, valid_until: q.validUntil, total_value: q.value, declined_value: q.declinedValue })), TODAY);
    const mine = figuresOf(rows);
    expect(mine.open).toEqual(real.open);
    expect(mine.drafts).toEqual(real.drafts);
    expect(mine.accepted).toEqual(real.byStatus.accepted);
    expect(mine.winRate).toBe(real.winRate);
    expect([mine.open.count, mine.drafts.count, mine.accepted.count, mine.winRate]).toEqual([5, 2, 6, 50]);
  });
  it("Show counts equal the archive rule (12 months, manual choice wins)", () => {
    for (const q of rows) {
      const final = ["accepted", "rejected", "expired", "superseded"].includes(q.status);
      expect(phaseOf(q), q.ref).toBe(realPhaseOf({ final, finalDate: q.validUntil || q.date }, q.manual, ARCHIVE_MONTHS, NOW));
    }
    expect(phaseCounts(rows)).toEqual({ open: 7, done: 12, archived: 3 });
  });
  it("legend counts equal quoteLegend for every Show tab and both dashboard filters", () => {
    for (const phase of ["open", "done", "archived", "all"] as const) {
      const f = { ...DEFAULT_FILTERS, phase };
      const real = quoteLegend(rows.map(asReal), null, TODAY, (q) => phase === "all" || phaseOf(q) === phase, phase === "all" ? "all quotes" : `${phase[0].toUpperCase()}${phase.slice(1)}`);
      expect(legendOf(rows, f).counts, phase).toEqual(real.counts);
      expect(legendOf(rows, f).scope, phase).toBe(real.scope);
    }
    for (const lf of ["expired", "no-decision"] as const) {
      const real = quoteLegend(rows.map(asReal), lf, TODAY, () => true, "x");
      expect(legendOf(rows, { ...DEFAULT_FILTERS, listFilter: lf }).counts, lf).toEqual(real.counts);
      expect(legendOf(rows, { ...DEFAULT_FILTERS, listFilter: lf }).scope, lf).toBe(real.scope);
    }
    expect(statusCounts(rows.filter((q) => phaseOf(q) === "open"))).toEqual(legendOf(rows, DEFAULT_FILTERS).counts);
  });
  it("dashboard filters equal quoteMatchesFilter and keep their labels", () => {
    expect(QUOTE_FILTER_LABELS).toEqual(REAL_LABELS);
    for (const f of ["expired", "no-decision"] as const) for (const q of rows) expect(matchesListFilter(f, q), `${f} ${q.ref}`).toBe(quoteMatchesFilter(f, q, TODAY));
    expect(refs(visibleQuotes(rows, { ...DEFAULT_FILTERS, listFilter: "expired" }))).toEqual(["QUO-0431", "QUO-0426", "QUO-0417"]);
    expect(refs(visibleQuotes(rows, { ...DEFAULT_FILTERS, listFilter: "no-decision" }))).toEqual(["QUO-0433", "QUO-0429"]);
  });
  it("Show and status filters: open by default, chips combine, All resets", () => {
    expect(visibleQuotes(rows, DEFAULT_FILTERS)).toHaveLength(7);
    expect(refs(visibleQuotes(rows, { ...DEFAULT_FILTERS, phase: "all", statuses: new Set(["superseded"]) }))).toEqual(["QUO-0412", "QUO-0405"]);
    expect(visibleQuotes(rows, { ...DEFAULT_FILTERS, phase: "all", statuses: new Set(["draft", "expired"]) }).map((q) => q.status).sort()).toEqual(["draft", "draft", "expired", "expired", "expired"]);
    expect(visibleQuotes(rows, { ...DEFAULT_FILTERS, phase: "all" })).toHaveLength(22);
    expect(groupsOf(visibleQuotes(rows, DEFAULT_FILTERS)).map((g) => `${g.status}:${g.items.length}`)).toEqual(["draft:2", "sent:5"]);
  });
  it("send, decide, accept block, expiry question and export scope wording equal the real ones", () => {
    for (const s of STATUS_ORDER) { expect(canOfferSend(s)).toBe(realCanOfferSend(s)); expect(canRecordDecision(s)).toBe(realCanRecord(s)); }
    for (const total of [0, 0.004, 120]) for (const [n, t] of [[undefined, undefined], [0, undefined], [2, 0], [2, 55]] as const) expect(acceptBlock(total, n, t)).toBe(quoteAcceptBlock(total, n, t));
    for (const q of rows) for (const a of ["send", "accept"] as const) expect(expiredMessage(q, a), `${q.ref} ${a}`).toBe(expiredQuoteCheck(q.rawStatus, q.validUntil, TODAY, a)?.message ?? null);
    for (const [sel, n] of [[0, 7], [1, 7], [3, 1], [0, 0]]) expect(scopeTitle(sel, n)).toBe(exportScopeTitle("quote", sel, n));
  });
  it("money, dates, references", () => {
    for (const v of [0, 5.5, 4296, 12345.67]) expect(gbp(v)).toBe(realGbp(v, 2));
    for (const d of ["2026-11-20", "2025-01-02"]) expect(fmtDate(d)).toBe(realFmtDate(d, "dmy-number"));
    for (const q of SEED_QUOTES) for (const l of q.lines) expect(lineReference(l)).toBe(realLineRef({ partNumber: l.partNumber, drawingNumber: l.drawingNumber, drawingRevision: l.drawingRevision }));
    for (const po of ["", " NF-1 ", "4471"]) expect(customerPoBeside(po)).toBe(realPoBeside(po));
    expect(DEFAULT_QUOTE_VALIDITY_DAYS).toBe(30);
  });
  it("role gate: admin and office only, as the real page and middleware", () => {
    expect(["admin", "office", "workshop", "viewer"].map((r) => canUseQuotes(r as never))).toEqual([true, true, false, false]);
  });
  it("sample data is fictional: every address is on the reserved .example domain and exactly one customer has no e-mail on file", () => {
    for (const email of Object.values(CUSTOMER_EMAIL)) if (email) expect(email).toMatch(/\.example$/);
    expect(Object.values(CUSTOMER_EMAIL).filter((e) => e === null)).toHaveLength(1);
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
function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QuotesPreview)));
  return host;
}
const byText = (scope: ParentNode, sel: string, text: string | RegExp) => Array.from(scope.querySelectorAll<HTMLElement>(sel)).find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? "")));
const click = (el: Element | undefined | null) => { if (!el) throw new Error("element not found"); act(() => { (el as HTMLElement).click(); }); };

describe("quotes preview: rendered behaviour", () => {
  it("labels itself, opens on Cards with the 7 open quotes, and shows the four tiles", () => {
    const h = mount();
    expect(h.textContent).toContain("Preview, sample data, nothing is saved");
    expect(h.querySelector('[data-testid="quotes-preview"]')?.getAttribute("data-pview")).toBe("cards");
    expect(h.querySelectorAll("article[data-quote]")).toHaveLength(7);
    expect(Array.from(h.querySelectorAll('[role="group"][aria-label="Quote figures"] button')).map((b) => b.querySelector("span:nth-of-type(2)")?.textContent)).toEqual(["5", "2", "6", "50%"]);
  });
  it("a status tile filters the list to that status (as the real tiles do)", () => {
    const h = mount();
    click(h.querySelector('[data-testid="tile-open"]'));
    expect(h.querySelectorAll("article[data-quote]")).toHaveLength(5);
    expect(h.querySelector('[data-testid="tile-open"]')?.getAttribute("aria-pressed")).toBe("true");
  });
  it("Select all selects every filtered quote and the bar says how many", () => {
    const h = mount();
    click(h.querySelector('[data-testid="select-all"]'));
    expect(h.querySelector("[data-selection]")?.getAttribute("data-selection")).toBe("active");
    expect(h.querySelector("[data-selection]")?.textContent).toContain("7 quotes selected");
  });
  it("Send asks first, then asks whether it went, and only ever answers with the neutral Preview-only toast, never a success", () => {
    const h = mount();
    click(h.querySelector('article[data-quote="QUO-0438"] [data-action="Send"]'));
    expect(document.querySelector('[data-testid="dlg-send"]')?.textContent).toContain("Send QUO-0438 to purchasing@marlow-hydraulics.example?");
    click(byText(document.body, "dialog button", "Yes, send"));
    expect(document.body.textContent).toContain("Has QUO-0438 gone to the customer?");
    expect(document.body.textContent).not.toContain("Preview only. Nothing");
    click(byText(document.body, "dialog button", "I\u2019ve sent it"));
    const toastText = document.body.textContent ?? "";
    expect(toastText).toContain("Preview only");
    expect(toastText).toContain("Nothing was saved.");
    expect(toastText).not.toMatch(/sent successfully|has been sent|saved successfully/i);
  });
  it("a sheet returns focus to the control that opened it", () => {
    const h = mount();
    const trigger = h.querySelector<HTMLButtonElement>('[data-testid="new-quote"]')!;
    trigger.focus();
    click(trigger);
    expect(document.querySelector('[data-testid="dlg-builder"]')).not.toBeNull();
    click(byText(document.body, "dialog button", "Cancel"));
    expect(document.querySelector('[data-testid="dlg-builder"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it("Workshop and Viewer get Access Denied, as the real page's role gate", () => {
    const h = mount();
    click(byText(document.body, "button", /Preview controls/));
    click(byText(document.body, '[role="group"][aria-label="Role"] button', "Workshop"));
    expect(h.querySelector('[data-testid="access-denied"]')?.textContent).toContain("Access Denied");
    expect(h.querySelector('[role="group"][aria-label="Quote figures"]')).toBeNull();
  });
});
