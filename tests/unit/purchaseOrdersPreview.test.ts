// @vitest-environment jsdom
/**
 * BOUNDARY (Purchase orders, Invoices module 4, PREVIEW ONLY). Inputs: the exports of components/purchase-orders/preview/PurchaseOrdersPreview.tsx and the
 * REAL lib functions it uses or mirrors (lib/purchase-order-total, lib/money, lib/archive phaseOf, lib/list-filter purchaseOrderMatchesFilter, lib/status-colours,
 * lib/spreadsheet). Output: pass/fail. Pins the Total (inc VAT) column, the form totals, tile figures, Show counts, the dashboard filter, the archive rule and
 * the row action rules to the real functions over the 12 sample orders, and checks by rendering that nothing reports success and the role gate holds.
 * v2 adds: the structural items (Filters (n) popover with removable chips, bulk actions and the selection bar only once a row is ticked, Export of all rows kept in the toolbar, one primary action
 * plus More per row, the explainer sentence as a tooltip and a description, the PreviewBar, plausible sample names, no !important) and a proof that every real row control is still reachable.
 * Must not change: never loosen these to make a change pass. No network, no Supabase. Written with createElement (no JSX).
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import PurchaseOrdersPreview, {
  CHIPS, DEFAULT_FILTERS, PO_TITLE_TIP, SEED_POS, SUPPLIERS, TODAY, VAT, allRowActions, canIssue, canMarkReceived, canRecordSent, canUsePurchaseOrders, matchesListFilter, phaseCounts, phaseFor, rowActionPlan, scopeTitle,
  statsOf, toneOf, totalOf, visiblePos,
} from "@/components/purchase-orders/preview/PurchaseOrdersPreview";
import { phaseOf as realPhaseOf } from "@/lib/archive";
import { purchaseOrderMatchesFilter } from "@/lib/list-filter";
import { documentTotals, gbp, toPence } from "@/lib/money";
import { PO_TOTAL_LABEL, purchaseOrderTotalIncVat } from "@/lib/purchase-order-total";
import { exportScopeTitle } from "@/lib/spreadsheet";
import { purchaseOrderStatusKey } from "@/lib/status-colours";

const NOW = new Date(`${TODAY}T12:00:00Z`);

describe("purchase orders preview: logic matches the real page", () => {
  it("has 12 sample orders covering every status", () => {
    expect(SEED_POS).toHaveLength(12);
    expect(new Set(SEED_POS.map((p) => p.status))).toEqual(new Set(["draft", "issued", "sent", "confirmed", "awaiting", "received", "cancelled"]));
  });
  it("the Total (inc VAT) column is lib/purchase-order-total for every order, exact to the penny", () => {
    for (const p of SEED_POS) {
      expect(totalOf(p), p.ref).toBe(purchaseOrderTotalIncVat({ value: p.value, vatEnabled: p.vatEnabled, items: p.items }, VAT));
      if (p.items?.length && p.vatEnabled) {
        const net = p.items.reduce((s, i) => s + toPence(documentTotals([{ quantity: i.qty, unitPrice: i.unit_price, vatPct: 0 }]).subtotal), 0);
        expect(toPence(totalOf(p)), p.ref).toBeGreaterThanOrEqual(net);
      }
    }
    expect(PO_TOTAL_LABEL).toBe("Total (inc VAT)");
    expect(totalOf(SEED_POS.find((p) => p.ref === "PO-0112")!)).toBe(4152);
    expect(totalOf(SEED_POS.find((p) => p.ref === "PO-0109")!)).toBe(742.4);
  });
  it("phase equals lib/archive phaseOf for every order; Show counts add up", () => {
    for (const p of SEED_POS) expect(phaseFor(p), p.ref).toBe(realPhaseOf({ final: ["received", "cancelled"].includes(p.status), finalDate: p.delivery || p.date }, p.manual, 12, NOW));
    const c = phaseCounts(SEED_POS);
    expect(c.open + c.done + c.archived).toBe(SEED_POS.length);
    expect(visiblePos(SEED_POS, DEFAULT_FILTERS)).toHaveLength(c.open);
  });
  it("the late dashboard link equals lib/list-filter purchaseOrderMatchesFilter", () => {
    for (const p of SEED_POS) expect(matchesListFilter("late", p, TODAY), p.ref).toBe(purchaseOrderMatchesFilter("late", p, TODAY));
    expect(SEED_POS.some((p) => matchesListFilter("late", p))).toBe(true);
  });
  it("tile figures follow the page: open is not received, overdue is open with a past delivery, received this month", () => {
    const st = statsOf(SEED_POS);
    const open = SEED_POS.filter((p) => p.status !== "received");
    expect(st).toEqual({ open: open.length, overdue: open.filter((p) => p.delivery && p.delivery < TODAY).length, receivedMonth: SEED_POS.filter((p) => p.status === "received" && p.receivedAt?.slice(0, 7) === "2026-11").length });
  });
  it("row actions: Issue on a draft only, Record Sent when issued and not yet sent, Mark Received not on draft or received", () => {
    expect(SEED_POS.filter(canIssue).every((p) => p.status === "draft")).toBe(true);
    expect(canRecordSent({ status: "issued" })).toBe(true); expect(canRecordSent({ status: "issued", sentAt: "x" })).toBe(false); expect(canRecordSent({ status: "draft" })).toBe(false); expect(canRecordSent({ status: "received" })).toBe(false);
    expect([canMarkReceived({ status: "draft" }), canMarkReceived({ status: "received" }), canMarkReceived({ status: "sent" })]).toEqual([false, false, true]);
  });
  it("badge tones follow purchaseOrderStatusKey; export scope text equals lib/spreadsheet; role gate is admin and office", () => {
    for (const p of SEED_POS) { const k = purchaseOrderStatusKey(p.status); expect(toneOf(p.status)).toBe(k === "delivered" ? "ok" : k === "waiting_on_supplier" ? "warn" : k === "issued" || k === "sent" ? "info" : "neutral"); }
    for (const [sel, n] of [[0, 7], [2, 7]]) expect(scopeTitle(sel, n)).toBe(exportScopeTitle("purchase order", sel, n));
    expect(["admin", "office", "workshop", "viewer"].map((r) => canUsePurchaseOrders(r as never))).toEqual([true, true, false, false]);
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
afterEach(() => { act(() => root?.unmount()); host?.remove(); document.body.innerHTML = ""; host = null; root = null; window.localStorage.clear(); });
function mount() { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root!.render(createElement(PurchaseOrdersPreview))); return host; }
const byText = (scope: ParentNode, sel: string, text: string | RegExp) => Array.from(scope.querySelectorAll<HTMLElement>(sel)).find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? "")));
const click = (el: Element | undefined | null) => { if (!el) throw new Error("element not found"); act(() => { (el as HTMLElement).click(); }); };

describe("purchase orders preview: rendered behaviour", () => {
  it("labels itself, shows the real total in the table, and Issue asks first then only answers Preview only", () => {
    const h = mount();
    expect(h.textContent).toContain("Preview, sample data, nothing is saved");
    expect(h.querySelector('tr[data-po="PO-0112"]')?.textContent).toContain(gbp(4152));
    click(h.querySelector('tr[data-po="PO-0112"] [data-action="Issue"]'));
    expect(document.body.textContent).toContain("Issuing fixes the supplier, items and value.");
    click(byText(document.body, "dialog button", "Issue Purchase Order"));
    const t = document.body.textContent ?? "";
    expect(t).toContain("Preview only"); expect(t).toContain("Nothing was saved."); expect(t).not.toMatch(/issued successfully|has been issued/i);
  });
  it("Workshop and Viewer get Access Denied, as the real page's role gate", () => {
    const h = mount();
    click(byText(document.body, "button", /Preview controls/));
    click(byText(document.body, '[role="radiogroup"][aria-label="Role"] [role="radio"], [role="group"][aria-label="Role"] button', "Workshop"));
    expect(h.querySelector('[data-testid="access-denied"]')?.textContent).toContain("Access Denied");
  });
});

describe("purchase orders preview v2: structure (owner-approved items 1, 2, 4, 7, 9, 10, 11)", () => {
  it("every real row control stays reachable: one primary action, the rest in More, for every order", () => {
    for (const p of SEED_POS) {
      const plan = rowActionPlan(p);
      const all = allRowActions(p);
      expect([plan.primary.id, ...plan.more.map((a) => a.id)].sort(), p.ref).toEqual(all.map((a) => a.id).sort());
      expect(plan.primary.disabled).toBeFalsy();
      for (const id of ["view", "edit", "receive", "print", "archive"]) expect(all.some((a) => a.id === id), `${p.ref} ${id}`).toBe(true);
      expect(all.some((a) => a.id === "issue")).toBe(canIssue(p));
      expect(all.some((a) => a.id === "sent")).toBe(canRecordSent(p));
      expect(all.find((a) => a.id === "receive")?.disabled).toBe(!canMarkReceived(p));
    }
    expect(rowActionPlan(SEED_POS.find((p) => p.status === "draft" && canIssue(p))!).primary.id).toBe("issue");
    expect(rowActionPlan(SEED_POS.find((p) => p.status === "issued")!).primary.id).toBe("sent");
    expect(rowActionPlan(SEED_POS.find((p) => p.status === "awaiting")!).primary.id).toBe("receive");
    expect(rowActionPlan(SEED_POS.find((p) => p.status === "received")!).primary.id).toBe("view");
  });
  it("each table row shows exactly two buttons in its actions cell (the next step and More)", () => {
    const h = mount();
    const rowsEls = h.querySelectorAll("tbody tr[data-po]");
    expect(rowsEls.length).toBeGreaterThan(3);
    rowsEls.forEach((tr) => { expect(tr.querySelectorAll("td:last-child button")).toHaveLength(2); });
  });
  it("a disabled Mark Received stays in More and says why", () => {
    const h = mount();
    click(h.querySelector('tr[data-po="PO-0112"] [data-testid="more-trigger"]'));
    const item = byText(document.body, '[role="menuitem"]', /Mark Received/)!;
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain("A draft cannot be received yet");
  });
  it("Export of all rows stays in the toolbar at rest; ticking a row swaps the toolbar for the selection bar with Print, Export and Mark Selected Received", () => {
    const h = mount();
    expect(h.querySelector("[data-selection]")).toBeNull();
    const idle = h.querySelector('[data-testid="export-trigger"]')!;
    expect(idle.getAttribute("aria-label")).toContain("Exports all");
    expect(byText(h, "button", "Print Selected")).toBeUndefined();
    click(h.querySelectorAll('[data-testid="select-row"]')[0]);
    const bar = h.querySelector("[data-selection]")!;
    expect(bar.textContent).toContain("1 selected of");
    for (const label of ["Print Selected", "Mark Selected Received", "Clear selection"]) expect(byText(bar, "button", label), label).toBeTruthy();
    expect(bar.querySelector('[data-testid="export-trigger"]')?.getAttribute("aria-label")).toContain("Exports the 1 purchase order selected");
    expect(h.querySelector('[role="group"][aria-label="List controls"]')).toBeNull();
    click(byText(bar, "button", "Mark Selected Received"));
    expect(document.body.textContent).toContain("Preview only");
    click(byText(bar, "button", "Clear selection"));
    expect(h.querySelector("[data-selection]")).toBeNull();
  });
  it("Filters (n) popover holds every status chip; active filters show as removable chips with one Clear filters", () => {
    const h = mount();
    const trigger = () => h.querySelector<HTMLElement>('[data-testid="filters-trigger"]')!;
    expect(trigger().textContent?.trim()).toBe("Filters");
    click(trigger());
    for (const c of CHIPS) expect(document.querySelector(`[data-testid="chip-${c.v}"]`), c.label).not.toBeNull();
    click(document.querySelector('[data-testid="chip-draft"]')); click(document.querySelector('[data-testid="chip-issued"]'));
    expect(trigger().textContent).toContain("Filters (2)");
    const active = h.querySelector('[data-testid="active-filters"]')!;
    expect(active.querySelectorAll("[data-active-chip]")).toHaveLength(2);
    click(active.querySelector('[aria-label="Remove filter Draft"]'));
    expect(trigger().textContent).toContain("Filters (1)");
    click(h.querySelector('[data-testid="clear-filters"]'));
    expect(h.querySelector('[data-testid="active-filters"]')).toBeNull();
  });
  it("the explainer is a tooltip and a description of the title; one preview strip; plausible sample names; no !important", () => {
    const h = mount();
    const holder = h.querySelector("h1 [title]")!;
    expect(holder.getAttribute("title")).toBe(PO_TITLE_TIP);
    expect(document.getElementById(holder.getAttribute("aria-describedby") ?? "")?.textContent).toBe(PO_TITLE_TIP);
    expect(h.querySelector("h1")?.textContent).toBe("Purchase Orders");
    expect(h.querySelector('[role="group"][aria-label="Preview information"] [data-testid="dock-toggle"]')).not.toBeNull();
    expect(JSON.stringify(SEED_POS) + SUPPLIERS.join()).not.toMatch(/placeholder|testfield|mockridge|sampleford|dummerby|exampleton/i);
    expect(SUPPLIERS).toContain("Clydeside Metals Ltd");
    for (const f of ["components/purchase-orders/preview/PurchaseOrdersPreview.module.css", "components/purchase-orders/preview/PurchaseOrdersPreview.tsx"]) expect(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""), f).not.toMatch(/!important/);
  });
  it("New purchase order: a failed save lists every problem in a summary and answers nothing saved", () => {
    const h = mount();
    click(h.querySelector('[data-testid="new-po"]'));
    click(byText(document.body, "dialog button", "Save PO"));
    const summary = document.querySelector("dialog[open] section[aria-labelledby]")!;
    expect(summary.textContent).toContain("Choose a supplier.");
    expect(summary.textContent).toContain("Enter a quantity.");
    expect(summary.textContent).toContain("Enter a unit price.");
    expect(document.body.textContent).not.toMatch(/saved successfully|has been created/i);
  });
});
