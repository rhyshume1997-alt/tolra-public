// @vitest-environment jsdom
/**
 * BOUNDARY (Delivery notes, Invoices module 4, PREVIEW ONLY). Inputs: the exports of components/delivery-notes/preview/DeliveryNotesPreview.tsx and the
 * REAL lib functions it uses or mirrors (lib/archive phaseOf, lib/list-filter deliveryNoteMatchesFilter, lib/list-card-counts, lib/status-colours, lib/attention-items).
 * Output: pass/fail. Pins the preview's tile figures, Show counts, dashboard filters, archive rule and role rules to the real functions over the 14 sample notes,
 * and checks by rendering that nothing reports success and the role gate holds (admin, office, workshop in; viewer out; workshop gets no E-mail or Archive).
 * Must not change: never loosen these to make a change pass. No network, no Supabase. Written with createElement (no JSX).
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import DeliveryNotesPreview, {
  DEFAULT_FILTERS, DELIVERY_AWAITING_DAYS, SEED_NOTES, TODAY, asRow, canArchive, canEdit, canEmail, canUseDeliveryNotes, matchesListFilter, phaseCounts, phaseFor, phaseOf, sourcesFor, statsOf, toneOf, visibleNotes,
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
    click(h.querySelector('tr[data-note="DLN-0210"] [data-action="Mark Signed"]'));
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
