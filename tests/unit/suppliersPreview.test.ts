// @vitest-environment jsdom
/**
 * BOUNDARY (Suppliers, Module 5, PREVIEW ONLY). Inputs: the exports of components/suppliers/preview/SuppliersPreview.tsx, the REAL lib functions it uses
 * (lib/supplier-status, lib/status-colours, lib/spreadsheet exportAllTitle, lib/empty-hints, lib/org-settings COLUMN_TABLES) and, for the two form checks that live
 * inline in the real page, the SOURCE of app/(dashboard)/suppliers/page.tsx. Output: pass/fail. Pins the preview's validation, status rules, role gate, columns and
 * wording to what the real page does, and checks by rendering that nothing reports success and that the sample data is obviously fictional.
 * Must not change: never loosen these to make a change pass; if a real rule changes, this test is the alarm. No network, no Supabase. Written with createElement (no JSX).
 */
import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import SuppliersPreview, {
  COLUMNS, EMAIL_INVALID, NAME_REQUIRED, SEED_SUPPLIERS, STATUS_HINT, SUPPLIERS_TITLE_TIP, rowActionPlan, canSetStatus, canUseSuppliers, statusAvailable, statusField, toneOf, validateSupplier, withoutStatus,
} from "@/components/suppliers/preview/SuppliersPreview";
import { suppliersEmptyHint } from "@/lib/empty-hints";
import { COLUMN_TABLES } from "@/lib/org-settings";
import { exportAllTitle } from "@/lib/spreadsheet";
import { STATUS_MAP } from "@/lib/status-colours";
import { SUPPLIER_STATUS_BADGE, SUPPLIER_STATUS_LABELS, SUPPLIER_STATUSES, canChangeSupplierStatus } from "@/lib/supplier-status";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const PAGE = read("app/(dashboard)/suppliers/page.tsx");

describe("suppliers preview: the real source still says what the preview mirrors", () => {
  it("page: role gate and the two inline form checks, word for word", () => {
    expect(PAGE).toContain('<RoleGate allowed={["admin", "office"]}>');
    expect(PAGE).toContain('if (!name) { toast.error("Enter a supplier name."); return; }');
    expect(PAGE).toContain('if (email && !email.includes("@")) { toast.error("Enter a valid email address."); return; }');
    expect(PAGE).toContain('const name = String(form.get("name") || "").trim();');
    expect(PAGE).toContain('const email = String(form.get("email") || "").trim();');
    expect(NAME_REQUIRED).toBe("Enter a supplier name.");
    expect(EMAIL_INVALID).toBe("Enter a valid email address.");
  });
  it("page: the delete question, the empty hint, the export wording and the status words", () => {
    expect(PAGE).toContain("Delete supplier \"${supplier.name}\"? This can't be undone.");
    expect(suppliersEmptyHint()).toBe("Press New supplier to add your first one.");
    expect(PAGE).toContain('exportAllTitle("supplier", suppliers.length)');
    expect(exportAllTitle("supplier", 10)).toBe("Exports all 10 suppliers");
    expect(PAGE).toContain(STATUS_HINT.replace("'", "&apos;")); // JSX writes the apostrophe as &apos;
    expect(PAGE).toContain("Only an admin changes it.");
    expect(PAGE).toContain("const statusAvailable = suppliers.some((supplier) => supplier.supplierStatus !== undefined);");
    expect(PAGE).toContain("const canSetStatus = canChangeSupplierStatus(activeRole);");
    expect(PAGE).toContain('canSetStatus && (editing.supplierStatus !== undefined || (!editing.id && statusAvailable))');
    expect(PAGE).toContain("!canSetStatus && editing.supplierStatus !== undefined");
  });
  it("columns equal the real Columns menu (Name is locked)", () => {
    const real = COLUMN_TABLES.find((t) => t.key === "suppliers")!;
    expect(COLUMNS.map((c) => [c.key, c.label, Boolean(c.locked)])).toEqual(real.columns.map((c) => [c.key, c.label, Boolean(("locked" in c) && c.locked)]));
  });
});

describe("suppliers preview: logic", () => {
  it("the form's checks: a name is needed; an e-mail, when given, must contain @ (trimmed first)", () => {
    expect(validateSupplier({ name: "  ", email: "" })).toEqual({ name: "Enter a supplier name." });
    expect(validateSupplier({ name: "A", email: "nope" })).toEqual({ email: "Enter a valid email address." });
    expect(validateSupplier({ name: "", email: "nope" })).toEqual({ name: "Enter a supplier name.", email: "Enter a valid email address." });
    expect(validateSupplier({ name: " A ", email: "  a@b.example  " })).toEqual({});
    expect(validateSupplier({ name: "A", email: "   " })).toEqual({});
    expect(validateSupplier({ name: "A", email: "a@b" })).toEqual({});
  });
  it("only an admin changes a status (canChangeSupplierStatus); the form offers the select, read only, or nothing exactly as the page decides", () => {
    expect(["admin", "office", "workshop", "viewer"].map((r) => [canSetStatus(r as never), canChangeSupplierStatus(r)])).toEqual([[true, true], [false, false], [false, false], [false, false]]);
    expect(statusField("admin", { id: "x", supplierStatus: "blocked" }, true)).toBe("select");
    expect(statusField("admin", { id: "x" }, true)).toBe("none");
    expect(statusField("admin", {}, true)).toBe("select");
    expect(statusField("admin", {}, false)).toBe("none");
    expect(statusField("office", { id: "x", supplierStatus: "conditional" }, true)).toBe("readonly");
    expect(statusField("office", {}, true)).toBe("none");
  });
  it("badge tones follow the one status map: approved green, conditional yellow, blocked red", () => {
    for (const st of SUPPLIER_STATUSES) expect(STATUS_MAP[SUPPLIER_STATUS_BADGE[st]].colour).toBe({ approved: "green", conditional: "yellow", blocked: "red" }[st]);
    expect(SUPPLIER_STATUSES.map(toneOf)).toEqual(["ok", "warn", "danger"]);
  });
  it("the sample: 10 suppliers, all three statuses, the status column exists only while some supplier has one", () => {
    expect(SEED_SUPPLIERS).toHaveLength(10);
    expect(new Set(SEED_SUPPLIERS.map((x) => x.supplierStatus))).toEqual(new Set(["approved", "conditional", "blocked"]));
    expect(statusAvailable(SEED_SUPPLIERS)).toBe(true);
    expect(statusAvailable(SEED_SUPPLIERS.map(withoutStatus))).toBe(false);
  });
  it("role gate: Admin and Office in, Workshop and Viewer out", () => {
    expect(["admin", "office", "workshop", "viewer"].map((r) => canUseSuppliers(r as never))).toEqual([true, true, false, false]);
  });
  it("privacy: every address is on a reserved .example domain and every number is in an Ofcom drama range", () => {
    for (const x of SEED_SUPPLIERS) {
      if (x.email) expect(x.email, x.name).toMatch(/@[a-z0-9-]+(\.[a-z0-9-]+)*\.example$/);
      if (x.phone) expect(x.phone, x.name).toMatch(/^(01632 960\d{3}|0(131|141) 496 0\d{3})$/);
    }
  });
});

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as { showModal?: () => void; close?: () => void };
  proto.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  proto.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as never;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0)) as never;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); document.body.innerHTML = ""; host = null; root = null; window.localStorage.clear(); });
function mount() { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root!.render(createElement(SuppliersPreview))); return host; }
const byText = (scope: ParentNode, sel: string, text: string | RegExp) => Array.from(scope.querySelectorAll<HTMLElement>(sel)).find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? "")));
const click = (el: Element | undefined | null) => { if (!el) throw new Error("element not found"); act(() => { (el as HTMLElement).click(); }); };
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const set = Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!;
  act(() => { set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
};
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 5)); });
const openDock = () => click(byText(document.body, "button", /Preview controls/));
const pickRole = (name: string) => click(byText(document.body, '[role="radiogroup"][aria-label="Role"] [role="radio"]', name));

describe("suppliers preview: rendered behaviour", () => {
  it("labels itself, opens on the table with all 10 suppliers and a status badge each", () => {
    const h = mount();
    expect(h.textContent).toContain("Preview, sample data, nothing is saved");
    expect(h.querySelectorAll("tbody tr[data-supplier]")).toHaveLength(10);
    expect(Array.from(h.querySelectorAll('tbody [data-testid="supplier-status"]')).map((e) => e.textContent)).toContain(SUPPLIER_STATUS_LABELS.blocked);
    expect(h.querySelectorAll('tbody tr [data-action="Edit"]')).toHaveLength(10);
    expect(h.querySelectorAll('tbody tr [data-testid="more-trigger"]')).toHaveLength(10);
  });
  it("Delete asks the real question, then answers only with the neutral Preview-only toast, never a success", () => {
    const h = mount();
    click(h.querySelector('tr[data-supplier="Fenwick Fasteners"] [data-testid="more-trigger"]'));
    click(byText(document, '[role="menuitem"]', "Delete"));
    const d = h.ownerDocument.querySelector('[data-testid="dlg-delete"]');
    expect(d?.textContent).toContain('Delete supplier "Fenwick Fasteners"?');
    expect(d?.textContent).toContain("This can't be undone.");
    click(h.ownerDocument.querySelector('[data-testid="confirm-delete"]'));
    const t = document.body.textContent ?? "";
    expect(t).toContain("Preview only"); expect(t).toContain("Fenwick Fasteners would be deleted. Nothing was saved."); expect(t).not.toMatch(/Fenwick Fasteners deleted\b|deleted successfully/i);
    expect(h.querySelectorAll("tbody tr[data-supplier]")).toHaveLength(10);
  });
  it("Export lists CSV and Excel with the real scope words and answers Preview only", () => {
    const h = mount();
    click(h.querySelector('[data-testid="export-trigger"]'));
    expect(Array.from(document.querySelectorAll('[role="menuitem"]')).map((e) => e.textContent)).toEqual(["CSV, all 10 suppliers", "Excel, all 10 suppliers"]);
    click(document.querySelectorAll('[role="menuitem"]')[1]);
    expect(document.body.textContent).toContain("An Excel file of 10 suppliers would download. No file was made.");
  });
  it("Add supplier: an empty save shows each real message beside its field, saves nothing and shows no toast; Admin has the status select", async () => {
    const h = mount();
    click(h.querySelector('[data-testid="new-supplier"]'));
    expect(h.querySelector('select[name="supplier_status"]')).not.toBeNull();
    type(h.querySelector<HTMLInputElement>('input[name="email"]')!, "nope");
    click(h.querySelector('[data-testid="save-supplier"]'));
    await flush();
    expect(h.querySelector('[data-testid="form-summary"]')?.textContent).toBe("2 fields need attention: Supplier name, Email.");
    expect(h.textContent).toContain("Enter a supplier name.");
    expect(h.textContent).toContain("Enter a valid email address.");
    expect(document.activeElement).toBe(h.querySelector('input[name="name"]'));
    expect(document.body.textContent).not.toContain("Nothing was saved.");
  });
  it("Add supplier: a valid save closes the form and answers Preview only", () => {
    const h = mount();
    click(h.querySelector('[data-testid="new-supplier"]'));
    type(h.querySelector<HTMLInputElement>('input[name="name"]')!, "Fictional Steel Co");
    click(h.querySelector('[data-testid="save-supplier"]'));
    expect(h.querySelector("dialog[open]")).toBeNull();
    const t = document.body.textContent ?? "";
    expect(t).toContain("Fictional Steel Co would be added as a supplier. Nothing was saved."); expect(t).not.toMatch(/Supplier added|saved successfully/i);
  });
  it("Office sees the status read only with 'Only an admin changes it.'; Admin gets the select with the real hint", () => {
    const h = mount();
    click(h.querySelector('tr[data-supplier="Redfern Surface Treatments"] [data-action="Edit"]'));
    expect((h.querySelector('select[name="supplier_status"]') as HTMLSelectElement).value).toBe("conditional");
    expect(h.textContent).toContain(STATUS_HINT);
    click(byText(document.body, "button", "Cancel"));
    openDock(); pickRole("Office");
    click(h.querySelector('tr[data-supplier="Redfern Surface Treatments"] [data-action="Edit"]'));
    expect(h.querySelector('select[name="supplier_status"]')).toBeNull();
    expect(h.querySelector('[data-testid="supplier-status-read-only"]')?.textContent).toContain("Conditional");
    expect(h.querySelector('[data-testid="supplier-status-read-only"]')?.textContent).toContain("Only an admin changes it.");
  });
  it("Workshop and Viewer get Access Denied (the page's RoleGate)", () => {
    const h = mount();
    openDock();
    for (const r of ["Workshop", "Viewer"]) {
      pickRole(r);
      expect(h.querySelector('[data-testid="access-denied"]')?.textContent).toContain("Access Denied");
      expect(h.querySelector("tbody tr")).toBeNull();
      expect(h.querySelector('[data-testid="new-supplier"]')).toBeNull();
    }
  });
  it("without the database's supplier status there is no Status column and no status field", () => {
    const h = mount();
    openDock();
    click(h.ownerDocument.querySelector('[data-testid="dock-features"]'));
    expect(Array.from(h.querySelectorAll("thead th")).map((e) => e.textContent)).not.toContain("Status");
    click(h.querySelector('[data-testid="new-supplier"]'));
    expect(h.querySelector('select[name="supplier_status"]')).toBeNull();
  });
});

describe("suppliers preview v2: structural items", () => {
  it("one primary action (Edit) per row, Delete in More", () => {
    expect(rowActionPlan()).toEqual({ primary: "Edit", more: ["Delete"] });
    const h = mount();
    click(h.querySelector('tr[data-supplier="Fenwick Fasteners"] [data-testid="more-trigger"]'));
    expect(Array.from(document.querySelectorAll('[role="menuitem"]')).map((e) => e.textContent)).toEqual(["Delete"]);
  });
  it("one PreviewBar and a clean title row; the explainer is the title tooltip and aria description; one toolbar row holds Export, Columns and View", () => {
    const h = mount();
    expect(h.querySelectorAll('[role="group"][aria-label="Preview information"]')).toHaveLength(1);
    expect(h.querySelector("header")?.textContent).not.toContain("The companies we buy from");
    const tip = h.querySelector("h1 span[title]")!;
    expect(tip.getAttribute("title")).toBe(SUPPLIERS_TITLE_TIP);
    expect(document.getElementById(tip.getAttribute("aria-describedby")!)?.textContent).toBe(SUPPLIERS_TITLE_TIP);
    const bar = h.querySelector('[role="group"][aria-label="List controls"]')!;
    for (const sel of ['[data-testid="export-trigger"]', '[data-testid="columns-trigger"]', '[data-testid="view-table-btn"]']) expect(bar.querySelector(sel), sel).not.toBeNull();
  });
  it("sample data has no placeholder-sounding names", () => {
    const text = JSON.stringify(SEED_SUPPLIERS);
    for (const bad of ["Placeholder", "Testfield", "Mockridge", "Dummerby", "Exampleton", "Testwell", "Alex Sample"]) expect(text).not.toContain(bad);
  });
});
