// @vitest-environment jsdom
/**
 * BOUNDARY (Delivery notes, Invoices module 4, PREVIEW ONLY). Inputs: the exports of components/delivery-notes/preview/DeliveryNotesPreview.tsx and the
 * REAL lib functions it uses or mirrors (lib/archive phaseOf, lib/list-filter deliveryNoteMatchesFilter, lib/list-card-counts, lib/status-colours, lib/attention-items).
 * Output: pass/fail. Pins the preview's tile figures, Show counts, dashboard filters, archive rule and role rules to the real functions over the 14 sample notes,
 * and checks by rendering that nothing reports success and the role gate holds (admin, office, workshop in; viewer out; workshop gets no E-mail or Archive).
 * v2 adds: the structural items (Filters (n) popover with removable chips, bulk actions only once a row is ticked, one primary action plus More per row, the explainer sentence
 * moved into a tooltip and a description, the PreviewBar, plausible sample names, no !important) and a proof that every real row control is still reachable.
 * Must not change: never loosen these to make a change pass. No network, no Supabase. Written with createElement (no JSX).
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import DeliveryNotesPreview, {
  CHIPS, CUSTOMERS, DEFAULT_FILTERS, DELIVERY_AWAITING_DAYS, DN_TITLE_TIP, SEED_NOTES, TODAY, allRowActions, asRow, canArchive, canEdit, canEmail, canUseDeliveryNotes, matchesListFilter, phaseCounts, phaseFor, phaseOf,
  rowActionPlan, sourcesFor, statsOf, toneOf, visibleNotes,
} from "@/components/delivery-notes/preview/DeliveryNotesPreview";
import { phaseOf as realPhaseOf } from "@/lib/archive";
import { DELIVERY_AWAITING_DAYS as REAL_DAYS } from "@/lib/attention-items";
import { deliveryNoteMatchesFilter } from "@/lib/list-filter";
import { AWAITING_SIGNATURE_STATUSES, countAwaitingSignature } from "@/lib/list-card-counts";
import { deliveryNoteStatusKey } from "@/lib/status-colours";

const NOW = new Date(`${TODAY}T12:00:00Z`);

describe("delivery notes preview: logic matches the real page", () => {
  it("has 14 sample notes covering every status", () => {
    expect(SEED_NOTES).toHaveLength(14);
    expect(new Set(SEED_NOTES.map((n) => n.status))).toEqual(new Set(["awaiting", "despatched", "delivered", "signed"]));
  });
  it("phase equals lib/archive phaseOf for every note; Show counts add up", () => {
    for (const n of SEED_NOTES) expect(phaseFor(n), n.ref).toBe(realPhaseOf({ final: ["delivered", "signed"].includes(n.status), finalDate: n.signedAt || n.date }, n.manual, 12, NOW));
    const c = phaseCounts(SEED_NOTES);
    expect(c.open + c.done + c.archived).toBe(SEED_NOTES.length);
    expect(visibleNotes(SEED_NOTES, DEFAULT_FILTERS)).toHaveLength(c.open);
    expect(phaseOf({ final: true, finalDate: "2025-01-01" }, undefined, 12)).toBe("archived");
  });
  it("dashboard links equal lib/list-filter deliveryNoteMatchesFilter and the one-day rule equals lib/attention-items", () => {
    for (const f of ["awaiting-old", "not-invoiced"]) for (const n of SEED_NOTES) expect(matchesListFilter(f, asRow(n), TODAY), `${f} ${n.ref}`).toBe(deliveryNoteMatchesFilter(f, asRow(n), TODAY));
    expect(DELIVERY_AWAITING_DAYS).toBe(REAL_DAYS);
    expect(SEED_NOTES.some((n) => matchesListFilter("awaiting-old", asRow(n)))).toBe(true);
    expect(SEED_NOTES.some((n) => matchesListFilter("not-invoiced", asRow(n)))).toBe(true);
  });
  it("tile figures: week and month by the page's rule, awaiting signature equals countAwaitingSignature", () => {
    const st = statsOf(SEED_NOTES);
    expect(st.awaitingSignature).toBe(countAwaitingSignature(SEED_NOTES));
    expect(st.awaitingSignature).toBe(SEED_NOTES.filter((n) => (AWAITING_SIGNATURE_STATUSES as readonly string[]).includes(n.status)).length);
    expect(st.week).toBe(SEED_NOTES.filter((n) => ["despatched", "delivered", "signed"].includes(n.status) && n.date >= "2026-11-13" && n.date <= TODAY).length);
    expect(st.signedMonth).toBe(SEED_NOTES.filter((n) => n.status === "signed" && (n.signedAt || n.date).slice(0, 7) === "2026-11").length);
  });
  it("roles: viewer out; E-mail and Archive are admin and office only; workshop has no sales-order source; a despatched note cannot be edited", () => {
    expect(["admin", "office", "workshop", "viewer"].map((r) => canUseDeliveryNotes(r as never))).toEqual([true, true, true, false]);
    expect(["admin", "office", "workshop"].map((r) => [canEmail(r as never), canArchive(r as never)])).toEqual([[true, true], [true, true], [false, false]]);
    expect(sourcesFor("workshop").map((x) => x.v)).toEqual(["job", "manual"]);
    expect(sourcesFor("office").map((x) => x.v)).toEqual(["order", "job", "manual"]);
    expect([canEdit("awaiting"), canEdit("despatched"), canEdit("signed")]).toEqual([true, false, false]);
  });
  it("badge tones follow deliveryNoteStatusKey (sent blue, delivered and signed green, others grey)", () => {
    for (const n of SEED_NOTES) { const k = deliveryNoteStatusKey(n.status); expect(toneOf(n.status)).toBe(k === "sent" ? "info" : k === "delivered" ? "ok" : "neutral"); }
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
function mount() { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root!.render(createElement(DeliveryNotesPreview))); return host; }
const byText = (scope: ParentNode, sel: string, text: string | RegExp) => Array.from(scope.querySelectorAll<HTMLElement>(sel)).find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? "")));
const click = (el: Element | undefined | null) => { if (!el) throw new Error("element not found"); act(() => { (el as HTMLElement).click(); }); };

describe("delivery notes preview: rendered behaviour", () => {
  it("labels itself and opens on the Table with the open notes", () => {
    const h = mount();
    expect(h.textContent).toContain("Preview, sample data, nothing is saved");
    expect(h.querySelectorAll("tbody tr[data-note]")).toHaveLength(visibleNotes(SEED_NOTES, DEFAULT_FILTERS).length);
  });
  it("Mark Despatched and Mark Signed only ever answer with the neutral Preview-only toast, never a success", () => {
    const h = mount();
    click(h.querySelector('tr[data-note="DLN-0210"] [data-action="Mark Despatched"]'));
    let t = document.body.textContent ?? "";
    expect(t).toContain("Preview only"); expect(t).toContain("Nothing was saved."); expect(t).not.toMatch(/marked despatched successfully|has been despatched/i);
    click(h.querySelector('tr[data-note="DLN-0210"] [data-testid="more-trigger"]'));
    click(byText(document.body, '[role="menuitem"]', "Mark Signed"));
    click(byText(document.body, "dialog button", "Confirm Signed"));
    t = document.body.textContent ?? "";
    expect(t).toContain("Preview only"); expect(t).not.toMatch(/signed successfully/i);
  });
  it("Workshop keeps the list but has no Email or Archive; Viewer gets Access Denied", () => {
    const h = mount();
    click(byText(document.body, "button", /Preview controls/));
    click(byText(document.body, '[role="radiogroup"][aria-label="Role"] [role="radio"], [role="group"][aria-label="Role"] button', "Workshop"));
    expect(h.querySelector('[data-testid="access-denied"]')).toBeNull();
    click(h.querySelector('tr[data-note="DLN-0210"] [data-testid="more-trigger"]'));
    const items = Array.from(document.querySelectorAll('[role="menuitem"]')).map((e) => e.textContent);
    expect(items.some((x) => /Email/.test(x ?? ""))).toBe(false);
    expect(items.some((x) => /Archive/.test(x ?? ""))).toBe(false);
    click(byText(document.body, '[role="radiogroup"][aria-label="Role"] [role="radio"], [role="group"][aria-label="Role"] button', "Viewer"));
    expect(h.querySelector('[data-testid="access-denied"]')?.textContent).toContain("Access Denied");
  });
});

describe("delivery notes preview v2: structure (owner-approved items 1, 2, 4, 7, 9, 10, 11)", () => {
  const ROLES = ["admin", "office", "workshop"] as const;
  it("every real row control stays reachable: one primary action, the rest in More, for every note and role", () => {
    for (const n of SEED_NOTES) for (const r of ROLES) {
      const plan = rowActionPlan(n, r);
      const all = allRowActions(n, r);
      const ids = [plan.primary.id, ...plan.more.map((a) => a.id)].sort();
      expect(ids, `${n.ref} ${r}`).toEqual(all.map((a) => a.id).sort());
      expect(plan.more.some((a) => a.id === plan.primary.id)).toBe(false);
      expect(plan.primary.disabled).toBeFalsy();
      expect(all.some((a) => a.id === "view") && all.some((a) => a.id === "print") && all.some((a) => a.id === "edit")).toBe(true);
      expect(all.some((a) => a.id === "despatch")).toBe(n.status === "awaiting");
      expect(all.some((a) => a.id === "sign")).toBe(n.status !== "signed");
      expect(all.some((a) => a.id === "email")).toBe(canEmail(r));
      expect(all.some((a) => a.id === "archive")).toBe(canArchive(r));
      expect(all.find((a) => a.id === "edit")?.disabled).toBe(!canEdit(n.status));
    }
    expect(rowActionPlan(SEED_NOTES.find((n) => n.status === "awaiting")!, "admin").primary.id).toBe("despatch");
    expect(rowActionPlan(SEED_NOTES.find((n) => n.status === "despatched")!, "admin").primary.id).toBe("sign");
    expect(rowActionPlan(SEED_NOTES.find((n) => n.status === "signed")!, "admin").primary.id).toBe("view");
  });
  it("each table row shows exactly two buttons in its actions cell (the next step and More), never more", () => {
    const h = mount();
    const rowsEls = h.querySelectorAll("tbody tr[data-note]");
    expect(rowsEls.length).toBeGreaterThan(3);
    rowsEls.forEach((tr) => {
      const cell = tr.querySelector("td:last-child")!;
      expect(cell.querySelectorAll("button")).toHaveLength(2);
      expect(cell.querySelector('[data-testid="more-trigger"]')).not.toBeNull();
    });
  });
  it("the More menu holds the other real actions and gives the reason for the disabled Edit", () => {
    const h = mount();
    click(h.querySelector('tr[data-note="DLN-0211"] [data-testid="more-trigger"]'));
    const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
    expect(items.map((e) => e.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "View", "Edit" + "A delivery note that has been despatched can't be edited", "Print", "Email Customer", "Archive",
    ]);
    expect(items[1].getAttribute("aria-disabled")).toBe("true");
  });
  it("no bulk bar at rest; ticking a row shows the selection bar with every bulk action, Select all and Clear; Clear brings the toolbar back", () => {
    const h = mount();
    expect(h.querySelector("[data-selection]")).toBeNull();
    expect(byText(h, "button", "Print Selected")).toBeUndefined();
    expect(h.querySelector('[role="group"][aria-label="List controls"]')).not.toBeNull();
    click(h.querySelectorAll('[data-testid="select-row"]')[0]);
    const bar = h.querySelector("[data-selection]")!;
    expect(bar.getAttribute("data-selection")).toBe("active");
    expect(bar.textContent).toContain(`1 selected of ${visibleNotes(SEED_NOTES, DEFAULT_FILTERS).length} filtered records`);
    for (const label of ["Print Selected", "Mark Selected Signed", "Clear selection"]) expect(byText(bar, "button", label), label).toBeTruthy();
    expect(byText(bar, "button", /Select all \d+ filtered/)).toBeTruthy();
    expect(h.querySelector('[role="group"][aria-label="List controls"]')).toBeNull();
    click(byText(bar, "button", "Clear selection"));
    expect(h.querySelector("[data-selection]")).toBeNull();
    expect(h.querySelector('[role="group"][aria-label="List controls"]')).not.toBeNull();
  });
  it("the header checkbox still selects every filtered note (Select all stays reachable)", () => {
    const h = mount();
    click(h.querySelector('thead input[type="checkbox"]'));
    expect(h.querySelector("[data-selection]")?.textContent).toContain(`${visibleNotes(SEED_NOTES, DEFAULT_FILTERS).length} selected of`);
  });
  it("Filters (n) popover: every status chip is inside it, the count and removable chips appear only when a filter is active, Clear filters resets", () => {
    const h = mount();
    const trigger = () => h.querySelector<HTMLElement>('[data-testid="filters-trigger"]')!;
    expect(trigger().textContent?.trim()).toBe("Filters");
    expect(h.querySelector('[data-testid="active-filters"]')).toBeNull();
    expect(h.querySelector('[data-testid="chip-awaiting"]')).toBeNull();
    click(trigger());
    for (const c of CHIPS) expect(document.querySelector(`[data-testid="chip-${c.v}"]`), c.label).not.toBeNull();
    click(document.querySelector('[data-testid="chip-awaiting"]'));
    expect(trigger().textContent).toContain("Filters (1)");
    const active = h.querySelector('[data-testid="active-filters"]')!;
    expect(active.textContent).toContain("Awaiting");
    expect(h.querySelectorAll("tbody tr[data-note]").length).toBe(visibleNotes(SEED_NOTES, { ...DEFAULT_FILTERS, chips: new Set(["awaiting"]) }).length);
    click(active.querySelector('[aria-label="Remove filter Awaiting"]'));
    expect(h.querySelector('[data-testid="active-filters"]')).toBeNull();
    expect(trigger().textContent?.trim()).toBe("Filters");
    click(document.querySelector('[data-testid="chip-signed"]')); click(document.querySelector('[data-testid="chip-despatched"]'));
    expect(trigger().textContent).toContain("Filters (2)");
    click(h.querySelector('[data-testid="clear-filters"]'));
    expect(h.querySelector('[data-testid="active-filters"]')).toBeNull();
  });
  it("the generic explainer is not on the page as visible copy: it is a tooltip and a description of the title", () => {
    const h = mount();
    const h1 = h.querySelector("h1")!;
    const holder = h1.querySelector("[title]")!;
    expect(holder.getAttribute("title")).toBe(DN_TITLE_TIP);
    const described = document.getElementById(holder.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe(DN_TITLE_TIP);
    expect(h1.textContent).toBe("Delivery Notes");
    expect(h.querySelector("header p")).toBeNull();
  });
  it("one 28 px preview strip replaces the yellow tag and the controls button beside the title", () => {
    const h = mount();
    const bar = h.querySelector('[role="group"][aria-label="Preview information"]')!;
    expect(bar.textContent).toContain("Preview, sample data, nothing is saved");
    expect(bar.querySelector('[data-testid="dock-toggle"]')).not.toBeNull();
    expect(h.querySelector("header [data-testid=dock-toggle]")).toBeNull();
  });
  it("the sample data reads as real Scottish and UK firms, and the styles hold no !important", () => {
    expect(JSON.stringify(SEED_NOTES) + CUSTOMERS.join()).not.toMatch(/placeholder|testfield|mockridge|sampleford|dummerby|exampleton/i);
    expect(CUSTOMERS).toContain("Kilbride Hydraulics");
    for (const f of ["components/delivery-notes/preview/DeliveryNotesPreview.module.css", "components/delivery-notes/preview/DeliveryNotesPreview.tsx"]) expect(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""), f).not.toMatch(/!important/);
  });
});
