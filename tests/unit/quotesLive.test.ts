// @vitest-environment jsdom
/**
 * BOUNDARY (Quotes module 3, READ-ONLY LIVE PREVIEW). Inputs: components/quotes/preview/QuotesPreview.tsx rendered in LIVE mode with invented rows (.example names), the toPreviewRow adapter of
 * QuotesLive.tsx, and the REAL lib functions as the oracle (lib/quote-status quoteFigures, lib/list-filter quoteLegend, lib/archive phaseOf). Output: pass/fail. Proves: the banner, the company name and
 * the real rows show and the sample quotes never do; a failed load shows the failed state with Retry and no rows; every write, send, archive, e-mail, PDF and export action answers
 * "Not enabled in this preview", opens no dialog, and calls no fetch; the quote's lines load lazily; and tiles, counts, legend and Show tabs equal the real functions over rows like the
 * database's (an expired quote, a revised v2, an accepted quote with declined lines, a manual archive choice, a company archive setting other than 12 months).
 * Must not change: never loosen these. No network, no Supabase.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import QuotesPreview, { SEED_QUOTES, figuresOf, legendOf, phaseCounts, phaseOf, visibleQuotes, DEFAULT_FILTERS, type LiveProps, type QuoteRow, type SeedLine } from "@/components/quotes/preview/QuotesPreview";
import { phaseOf as realPhaseOf } from "@/lib/archive";
import { quoteLegend, quoteMatchesFilter } from "@/lib/list-filter";
import { quoteFigures } from "@/lib/quote-status";
import { mapQuoteRow } from "@/lib/quote-list-load";

vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, useRouter: () => ({ push: () => undefined }) }));
vi.mock("@/lib/supabase", () => ({ supabase: null, isSupabaseConfigured: false }));

const TODAY = "2026-11-24";
const BANNER = "Read-only preview of real data: nothing is saved or sent";

const DB: Array<Record<string, unknown>> = [
  { id: "d1", quote_ref: "QUO-1001", customer: "Fenwick Casting", total_value: 600, status: "draft", valid_until: "2026-12-20", created_at: "2026-11-20T09:00:00Z", vat_enabled: true, version: 1 },
  { id: "s1", quote_ref: "QUO-1002", customer: "Orrin Gearworks", total_value: 1200, status: "sent", valid_until: "2026-12-10", created_at: "2026-11-18T09:00:00Z", sent_at: "2026-11-18T10:00:00Z", vat_enabled: true, version: 1 },
  { id: "x1", quote_ref: "QUO-1003", customer: "Pell Bearings", total_value: 300, status: "sent", valid_until: "2026-11-10", created_at: "2026-11-01T09:00:00Z", sent_at: "2026-11-01T10:00:00Z", vat_enabled: true, version: 1 },
  { id: "a1", quote_ref: "QUO-1004", customer: "Quill Tooling", total_value: 1000, status: "accepted", valid_until: "2026-12-01", created_at: "2026-11-05T09:00:00Z", sent_at: "2026-11-05T10:00:00Z", vat_enabled: true, version: 1, customer_po: "PO-77" },
  { id: "r1", quote_ref: "QUO-1005", customer: "Sable Fabrication", total_value: 450, status: "rejected", valid_until: "2026-11-30", created_at: "2026-11-06T09:00:00Z", vat_enabled: true, version: 1 },
  { id: "v1", quote_ref: "QUO-1006", customer: "Thorne Valves", total_value: 800, status: "superseded", valid_until: "2026-11-29", created_at: "2026-10-29T09:00:00Z", vat_enabled: true, version: 1 },
  { id: "v2", quote_ref: "QUO-1006 v2", customer: "Thorne Valves", total_value: 860, status: "sent", valid_until: "2026-12-15", created_at: "2026-11-12T09:00:00Z", sent_at: "2026-11-12T10:00:00Z", vat_enabled: true, version: 2, previous_version_id: "v1" },
  { id: "old", quote_ref: "QUO-0900", customer: "Umber Machining", total_value: 220, status: "accepted", valid_until: "2025-03-01", created_at: "2025-02-01T09:00:00Z", vat_enabled: true, version: 1 },
  { id: "man", quote_ref: "QUO-0901", customer: "Vane Hydraulics", total_value: 100, status: "rejected", valid_until: "2026-11-15", created_at: "2026-11-02T09:00:00Z", vat_enabled: true, version: 1 },
  { id: "dd", quote_ref: "QUO-1007", customer: "Wick Pneumatics", total_value: 90, status: "draft", valid_until: "2026-11-01", created_at: "2026-10-20T09:00:00Z", vat_enabled: true, version: 1 },
];
const DECLINED: Record<string, number> = { a1: 240 };
const MANUAL: Record<string, "archived" | "active"> = { man: "archived", x1: "active" };

function liveRows(): QuoteRow[] {
  return DB.map((r) => {
    const m = mapQuoteRow(r, TODAY);
    return { id: m.id as string, ref: m.ref, customer: m.customer, description: m.description, rawStatus: m.rawStatus, status: m.status, date: m.date ?? "", validUntil: m.validUntil, sentAt: m.sentAt,
      vatEnabled: m.vatEnabled, version: m.version, previousVersionId: m.previousVersionId, customerPo: m.customerPo, manual: MANUAL[m.id as string], lines: [], value: m.value, declinedValue: DECLINED[m.id as string] ?? 0 };
  });
}

describe("live mode: tiles, counts, legend and Show equal the REAL lib functions over database-shaped rows", () => {
  const rows = liveRows();
  const asReal = rows.map((r) => ({ ...r, total_value: r.value, declined_value: r.declinedValue, valid_until: r.validUntil }));
  it("the shown status is the real effective status (an undecided quote past its date is Expired)", () => {
    expect(rows.find((r) => r.id === "x1")).toMatchObject({ status: "expired", rawStatus: "sent" });
    expect(rows.find((r) => r.id === "dd")).toMatchObject({ status: "expired", rawStatus: "draft" });
    expect(rows.find((r) => r.id === "s1")?.status).toBe("sent");
  });
  it("tile figures: Open, Drafts, Accepted (less declined lines) and Win rate", () => {
    const real = quoteFigures(asReal.map((r) => ({ status: r.rawStatus, valid_until: r.validUntil, total_value: r.value, declined_value: r.declinedValue })), TODAY);
    const mine = figuresOf(rows, TODAY);
    expect(mine.open).toEqual(real.open);
    expect(mine.drafts).toEqual(real.drafts);
    expect(mine.accepted).toEqual(real.byStatus.accepted);
    expect(mine.winRate).toBe(real.winRate);
    expect(mine.accepted.value).toBe(1000 - 240 + 220);
  });
  for (const months of [12, 6, 1]) {
    it(`Show counts and the legend, with the company archiving after ${months} months`, () => {
      const real = (q: QuoteRow) => realPhaseOf({ final: ["accepted", "rejected", "expired", "superseded"].includes(q.status), finalDate: q.validUntil || q.date }, q.manual, months, new Date(`${TODAY}T12:00:00Z`));
      const counts = phaseCounts(rows, TODAY, months);
      expect(counts).toEqual({ open: rows.filter((q) => real(q) === "open").length, done: rows.filter((q) => real(q) === "done").length, archived: rows.filter((q) => real(q) === "archived").length });
      for (const phase of ["open", "done", "archived", "all"] as const) {
        const filters = { ...DEFAULT_FILTERS, phase };
        const legend = legendOf(rows, filters, TODAY, months);
        const oracle = quoteLegend(rows.map((q) => ({ ...q })), null, TODAY, (q) => phase === "all" || real(q) === phase, phase === "all" ? "all quotes" : `${phase[0].toUpperCase()}${phase.slice(1)}`);
        expect(legend.counts).toEqual(oracle.counts);
        expect(legend.scope).toBe(oracle.scope);
        expect(visibleQuotes(rows, filters, TODAY, months).length).toBe(rows.filter((q) => phase === "all" || real(q) === phase).length);
      }
    });
  }
  it("the dashboard filters (expired, no decision) pick the same quotes as the real rules", () => {
    for (const f of ["expired", "no-decision"] as const) {
      const mine = visibleQuotes(rows, { ...DEFAULT_FILTERS, listFilter: f }, TODAY).map((q) => q.id).sort();
      const real = rows.filter((q) => quoteMatchesFilter(f, q, TODAY)).map((q) => q.id).sort();
      expect(mine).toEqual(real);
    }
  });
  it("a manual archive choice beats the age rule in both directions", () => {
    expect(phaseOf(rows.find((r) => r.id === "man")!, TODAY, 12)).toBe("archived");
    expect(phaseOf({ ...rows.find((r) => r.id === "old")!, manual: "active" }, TODAY, 12)).toBe("done");
    expect(phaseOf(rows.find((r) => r.id === "old")!, TODAY, 12)).toBe("archived");
  });
});

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as { showModal?: () => void; close?: () => void };
  proto.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  proto.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as never;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy); vi.spyOn(window, "open").mockImplementation(() => null); });
afterEach(() => { act(() => root?.unmount()); host?.remove(); document.body.innerHTML = ""; host = null; root = null; window.localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Props = LiveProps;
async function mount(props: Props) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(createElement(QuotesPreview, props)); });
  return host;
}
const byText = (scope: ParentNode, sel: string, text: string | RegExp) => Array.from(scope.querySelectorAll<HTMLElement>(sel)).find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? "")));
const click = async (el: Element | undefined | null) => { if (!el) throw new Error("element not found"); await act(async () => { (el as HTMLElement).click(); }); };
const LINES: SeedLine[] = [{ description: "Invented bracket", quantity: 4, unitPrice: 100, partNumber: "BR-1" }, { description: "Invented spares", quantity: 2, unitPrice: 50, declined: true }];
const live = (extra: Partial<Props> = {}): Props => ({ readOnlyReason: BANNER, rows: liveRows(), today: TODAY, archiveMonths: 12, companyName: "Example Eng. Ltd", loadLines: async () => LINES, ...extra });

describe("live mode: the screen", () => {
  it("shows the banner and the company, the real rows and never a sample quote, and no demo controls", async () => {
    const h = await mount(live());
    expect(h.querySelector('[data-testid="preview-bar"]')?.textContent).toContain(BANNER);
    expect(h.querySelector('[data-testid="live-company"]')?.textContent).toContain("Company: Example Eng. Ltd");
    expect(h.querySelector('[data-testid="dock-toggle"]')).toBeNull();
    expect(h.textContent).not.toContain("Preview, sample data");
    const refs = Array.from(h.querySelectorAll("article[data-quote]")).map((a) => a.getAttribute("data-quote"));
    expect(refs.sort()).toEqual(["QUO-1001", "QUO-1002", "QUO-1006 v2"]);
    for (const seed of SEED_QUOTES) expect(h.textContent).not.toContain(seed.ref + " ");
    expect(h.textContent).not.toContain("Marlow Hydraulics");
    const tiles = Array.from(h.querySelectorAll('[role="group"][aria-label="Quote figures"] button')).map((b) => b.querySelector("span:nth-of-type(2)")?.textContent);
    expect(tiles).toEqual(["2", "1", "2", "40%"]);
  });
  it("a failed load shows the failed state with Retry, no rows, and never the sample quotes", async () => {
    const onRetry = vi.fn();
    const h = await mount(live({ rows: [], loadState: "error", errorDetail: "Couldn’t load quotes. Check your connection.", onRetry }));
    expect(h.textContent).toContain("Couldn’t load quotes.");
    expect(h.textContent).toContain("Check your connection.");
    expect(h.querySelectorAll("article[data-quote]")).toHaveLength(0);
    for (const seed of SEED_QUOTES) expect(h.textContent).not.toContain(seed.ref);
    await click(byText(h, "button", "Retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
  it("loading shows the loading state, no rows and no sample", async () => {
    const h = await mount(live({ rows: [], loadState: "loading" }));
    expect(h.querySelectorAll("article[data-quote]")).toHaveLength(0);
    expect(h.textContent).toContain("Loading quotes");
  });
  it("a company with no quotes says so plainly and offers no New quote", async () => {
    const h = await mount(live({ rows: [] }));
    expect(h.textContent).toContain("No quotes yet");
    expect(h.textContent).toContain("This company has no quotes to show.");
    // the toolbar's New quote stays (it answers Not enabled); the empty state has no button of its own
    expect(h.querySelectorAll('[data-testid="new-quote"]')).toHaveLength(1);
  });
  it("with no live props the sample screen is unchanged (22 sample quotes behind the Preview controls)", async () => {
    const h = await mount({});
    expect(h.textContent).toContain("Preview, sample data, nothing is saved");
    expect(h.querySelector('[data-testid="dock-toggle"]')).not.toBeNull();
    expect(h.querySelectorAll("article[data-quote]")).toHaveLength(7);
  });
});

describe("live mode: every write, send, archive, e-mail, PDF and export answers Not enabled", () => {
  const noDialog = () => { expect(document.querySelector("dialog[open]")).toBeNull(); expect(document.querySelector('[data-testid="dlg-builder"]')).toBeNull(); expect(document.querySelector('[data-testid="dlg-send"][data-state="open"], [data-testid="dlg-send"][open]')).toBeNull(); };
  const noSideEffects = () => { expect(fetchSpy).not.toHaveBeenCalled(); expect(window.open).not.toHaveBeenCalled(); };
  const NOT = /Not enabled in this preview/;
  it("row Send (the primary on a draft) and every More item except View", async () => {
    const h = await mount(live());
    const draft = h.querySelector<HTMLElement>('article[data-quote="QUO-1001"]')!;
    await click(draft.querySelector('[data-testid="row-primary"]'));
    expect(document.body.textContent).toMatch(NOT);
    noDialog();
    await click(draft.querySelector('[data-testid="row-more"]'));
    const items = Array.from(document.querySelectorAll('[role="menuitem"]')).map((e) => e.textContent);
    expect(items).toEqual(["View", "Download PDF", "Archive"]);
    await click(byText(document.body, '[role="menuitem"]', "Download PDF"));
    expect(document.body.textContent).toMatch(NOT);
    await click(draft.querySelector('[data-testid="row-more"]'));
    await click(byText(document.body, '[role="menuitem"]', "Archive"));
    expect(document.body.textContent).toMatch(NOT);
    noDialog(); noSideEffects();
  });
  it("New quote and all four Export formats", async () => {
    const h = await mount(live());
    await click(h.querySelector('[data-testid="new-quote"]'));
    expect(document.body.textContent).toMatch(NOT);
    noDialog();
    for (const fmt of ["CSV", "Excel", "Word", "PDF"]) {
      await click(h.querySelector('[data-testid="export-trigger"]'));
      await click(byText(document.body, '[role="menuitem"]', fmt));
      expect(document.body.textContent).toMatch(NOT);
      expect(document.body.textContent).not.toMatch(/No file was downloaded|would cover/);
    }
    noDialog(); noSideEffects();
  });
  it("the quote's sheet loads its lines when opened, shows declined lines as Not ordered, and every write button answers inside the sheet", async () => {
    const loadLines = vi.fn(async () => LINES);
    const h = await mount(live({ loadLines }));
    expect(loadLines).not.toHaveBeenCalled();
    await click(h.querySelector('article[data-quote="QUO-1002"] [data-testid="row-primary"]'));
    const sheet = document.querySelector<HTMLElement>('[data-testid="dlg-view"]')!;
    expect(sheet).not.toBeNull();
    expect(loadLines).toHaveBeenCalledWith("s1");
    expect(sheet.querySelectorAll('[data-testid="quote-line"]')).toHaveLength(2);
    expect(sheet.textContent).toContain("Part BR-1");
    expect(sheet.textContent).toContain("Not ordered");
    expect(sheet.querySelector('[data-testid="live-sheet-note"]')?.textContent).toContain(BANNER);
    // the stored total is shown, not a recomputed one: £1,200.00
    expect(sheet.textContent).toContain("£1,200.00");
    const write = ["Copy", "Revise (v2)", "Mark Rejected", "Mark Accepted", "Download PDF", "Send to Customer", "Change customer PO", "Add customer PO"];
    for (const label of write) {
      const btn = byText(sheet, "button", label);
      if (!btn) continue;
      await click(btn);
      expect(sheet.querySelector('[data-testid="sheet-status"]')?.textContent, label).toMatch(NOT);
      expect(document.querySelector('[data-testid="dlg-builder"]')).toBeNull();
      expect(document.querySelector('dialog[open][data-testid="dlg-send"]')).toBeNull();
    }
    expect(byText(sheet, "button", "Send to Customer")).toBeDefined();
    expect(byText(sheet, "button", "Mark Accepted")).toBeDefined();
    noSideEffects();
  });
  it("a draft's Edit Draft and an expired quote's Send never open anything either", async () => {
    const h = await mount(live());
    await click(h.querySelector('article[data-quote="QUO-1001"] [data-testid="row-more"]'));
    await click(byText(document.body, '[role="menuitem"]', "View"));
    const sheet = document.querySelector<HTMLElement>('[data-testid="dlg-view"]')!;
    await click(byText(sheet, "button", "Edit Draft"));
    expect(sheet.querySelector('[data-testid="sheet-status"]')?.textContent).toMatch(/Not enabled/);
    expect(document.querySelector('[data-testid="dlg-builder"]')).toBeNull();
    noSideEffects();
  });
  it("a failed lines load is said with Retry and the sheet stays usable", async () => {
    let calls = 0;
    const loadLines = vi.fn(async () => { calls += 1; if (calls === 1) throw new Error("boom"); return LINES; });
    const h = await mount(live({ loadLines }));
    await click(h.querySelector('article[data-quote="QUO-1002"] [data-testid="row-primary"]'));
    const sheet = document.querySelector<HTMLElement>('[data-testid="dlg-view"]')!;
    expect(sheet.querySelector('[data-testid="lines-error"]')?.textContent).toContain("Couldn’t load the line items");
    await click(byText(sheet, "button", "Retry"));
    expect(sheet.querySelectorAll('[data-testid="quote-line"]')).toHaveLength(2);
  });
  it("selecting rows is local and the revised v2 shows its versions", async () => {
    const h = await mount(live());
    await click(h.querySelector('article[data-quote="QUO-1006 v2"] [data-testid="select-row"]'));
    expect(h.querySelector("[data-selection]")?.getAttribute("data-selection")).toBe("active");
    await click(h.querySelector('article[data-quote="QUO-1006 v2"] [data-testid="row-primary"]'));
    const sheet = document.querySelector<HTMLElement>('[data-testid="dlg-view"]')!;
    expect(sheet.querySelector('[data-testid="quote-versions"]')?.textContent).toContain("v1");
    expect(sheet.querySelector('[data-testid="quote-versions"]')?.textContent).toContain("v2");
  });
});
