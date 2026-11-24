// @vitest-environment jsdom
/**
 * BOUNDARY (Customers, Module 5, PREVIEW ONLY). Inputs: the exports of components/customers/preview/CustomersPreview.tsx, the REAL lib functions it uses
 * (lib/validation/schemas customerSchema and parseOrThrow, lib/spreadsheet exportAllTitle, lib/status-colours, lib/email/chase/steps pauseActive, lib/empty-hints,
 * lib/org-settings COLUMN_TABLES) and, for the rules that live inline in the real files, the SOURCE of app/(dashboard)/customers/page.tsx, lib/archive.ts and
 * components/chase/chase-pause.tsx. Output: pass/fail. Pins the preview's validation, archive rule, role gate, columns and wording to what the real page does, and
 * checks by rendering that nothing reports success and that the sample data is obviously fictional.
 * Must not change: never loosen these to make a change pass; if a real rule changes, this test is the alarm. No network, no Supabase. Written with createElement (no JSX).
 */
import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import CustomersPreview, {
  CUSTOMERS_TITLE_TIP, rowActionPlan,
  COLUMNS, DOCUMENT_NAMES_TRUNCATED, NAME_REQUIRED, NOT_SAVED_LABEL, SEED_CUSTOMERS, TODAY, canManageArchive, canUseCustomers, chasePaused, draftFor, exportable, phaseCounts, phaseFor,
  toneOf, validateCustomer, validatePause, visibleCustomers, withFeatures,
} from "@/components/customers/preview/CustomersPreview";
import { pauseActive } from "@/lib/email/chase/steps";
import { customersEmptyHint } from "@/lib/empty-hints";
import { COLUMN_TABLES } from "@/lib/org-settings";
import { exportAllTitle } from "@/lib/spreadsheet";
import { deliveryNoteStatusKey } from "@/lib/status-colours";
import { ValidationError, customerSchema, parseOrThrow } from "@/lib/validation/schemas";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const PAGE = read("app/(dashboard)/customers/page.tsx");
const ARCHIVE = read("lib/archive.ts");
const CHASE = read("components/chase/chase-pause.tsx");

describe("customers preview: the real source still says what the preview mirrors", () => {
  it("page: role gate, the empty-name rule, the archive rule, the empty and archived wording", () => {
    expect(PAGE).toContain('<RoleGate allowed={["admin", "office"]}>');
    expect(PAGE).toContain('if (!next.name) { toast.error("Enter a customer name."); return; }');
    expect(NAME_REQUIRED).toBe("Enter a customer name.");
    expect(PAGE).toContain('customer.id && archive.manual.get(customer.id) === "archived" ? "archived" : "open"');
    expect(PAGE).toContain("open: customers.length - archived");
    expect(PAGE).toContain("No archived customers.");
    expect(PAGE).toContain("Every customer is archived: see Show > Archived.");
    expect(PAGE).toContain(NOT_SAVED_LABEL);
    expect(PAGE).toContain(DOCUMENT_NAMES_TRUNCATED);
    expect(customersEmptyHint()).toBe("Press New customer to add your first one.");
    expect(PAGE).toContain('labels={{ open: "Active" }}');
    expect(PAGE).toContain('phases={["open", "archived", "all"]}');
  });
  it("page: an export holds saved customers only, with the real 'Exports all N customers' words", () => {
    expect(PAGE).toContain("savedCustomers = customers.filter((customer) => !customer.notSaved)");
    expect(PAGE).toContain('exportAllTitle("customer", savedCustomers.length)');
    expect(exportAllTitle("customer", 12)).toBe("Exports all 12 customers");
    expect(exportAllTitle("customer", 1)).toBe("Exports all 1 customer");
  });
  it("archive: Admin and Office manage it; the page offers Mobile and Traceable only when they were read", () => {
    expect(ARCHIVE).toContain('const canManage = activeRole === "admin" || activeRole === "office";');
    expect(["admin", "office", "workshop", "viewer"].map((r) => canManageArchive(r as never))).toEqual([true, true, false, false]);
    expect(PAGE).toContain("editing.mobile !== undefined");
    expect(PAGE).toContain("editing.traceableDefault !== undefined");
    expect(PAGE).toContain("New jobs for this customer need the material cert no. and heat/cast no. before the inspection can pass.");
  });
  it("columns equal the real Columns menu (Name is locked)", () => {
    const real = COLUMN_TABLES.find((t) => t.key === "customers")!;
    expect(COLUMNS.map((c) => [c.key, c.label, Boolean(c.locked)])).toEqual(real.columns.map((c) => [c.key, c.label, Boolean(("locked" in c) && c.locked)]));
  });
  it("chase pause: the three checks and their words are the real ones", () => {
    expect(CHASE).toContain('if (!text) return void toast.error("Enter a reason for pausing.");');
    expect(CHASE).toContain('if (text.length > 300) return void toast.error("The reason can be up to 300 characters.");');
    expect(CHASE).toContain('if (until && until < todayUk()) return void toast.error("The last day can\'t be in the past.");');
    expect(validatePause({ reason: "  ", until: "" })).toEqual({ reason: "Enter a reason for pausing." });
    expect(validatePause({ reason: "x".repeat(301), until: "" })).toEqual({ reason: "The reason can be up to 300 characters." });
    expect(validatePause({ reason: "x".repeat(300), until: "" })).toEqual({});
    expect(validatePause({ reason: "Query", until: "2026-11-19" })).toEqual({ until: "The last day can't be in the past." });
    expect(validatePause({ reason: "Query", until: TODAY })).toEqual({});
    expect(validatePause({ reason: "Query", until: "" })).toEqual({});
  });
});

describe("customers preview: the form's checks are the real validator", () => {
  const cases = [
    { name: "Marlow Hydraulics", email: "a@b.example", phone: "01632 960101", mobile: "07700 900101" },
    { name: "A", email: "", phone: "", mobile: "" },
    { name: "A", email: "not-an-email", phone: "", mobile: "" },
    { name: "A", email: "  spaced@b.example  ", phone: "", mobile: "" },
    { name: "A", email: "", phone: "x".repeat(51), mobile: "" },
    { name: "A", email: "", phone: "x".repeat(50), mobile: "" },
    { name: "A", email: "", phone: "", mobile: "y".repeat(41) },
    { name: "A".repeat(201), email: "", phone: "", mobile: undefined },
    { name: "A".repeat(200), email: "", phone: "", mobile: undefined },
    { name: "  A  ", email: "", phone: "", mobile: undefined },
  ];
  it.each(cases.map((c, i) => [i, c] as const))("case %i: the preview's messages equal what saveCustomer's customerSchema says", (_i, c) => {
    const mine = validateCustomer({ ...c, contactName: "", address: "", notes: "" });
    const real = customerSchema.safeParse({ name: c.name.trim(), email: c.email.trim(), phone: c.phone, mobile: c.mobile });
    const realByField: Record<string, string> = {};
    if (!real.success) for (const issue of real.error.issues) { const k = String(issue.path[0]); if (!realByField[k]) realByField[k] = issue.message; }
    expect(mine).toEqual(realByField);
    if (real.success) expect(() => parseOrThrow(customerSchema, { name: c.name.trim(), email: c.email.trim(), phone: c.phone, mobile: c.mobile })).not.toThrow();
    else expect(() => parseOrThrow(customerSchema, { name: c.name.trim(), email: c.email.trim(), phone: c.phone, mobile: c.mobile })).toThrow(ValidationError);
  });
  it("an empty name gets the page's own words (it checks before saveCustomer runs), the rest the schema's", () => {
    expect(validateCustomer({ ...draftFor("   ", true), email: "nope" })).toEqual({ name: "Enter a customer name.", email: "Enter a valid email address" });
    expect(validateCustomer(draftFor("A", false))).toEqual({});
    expect(validateCustomer({ ...draftFor("A", true), mobile: "7".repeat(41) })).toEqual({ mobile: "The mobile number is at most 40 characters." });
  });
  it("a new customer's draft offers Mobile and Traceable only when the database has them (newCustomerDraft)", () => {
    expect(draftFor("X", true)).toMatchObject({ mobile: "", traceableDefault: false });
    expect("mobile" in draftFor("X", false)).toBe(false);
    expect("traceableDefault" in draftFor("X", false)).toBe(false);
  });
});

describe("customers preview: logic over the sample", () => {
  it("has 14 names: 12 saved (2 archived by hand) and 2 found only on documents", () => {
    expect(SEED_CUSTOMERS).toHaveLength(14);
    expect(SEED_CUSTOMERS.filter((c) => c.notSaved)).toHaveLength(2);
    expect(exportable(SEED_CUSTOMERS)).toHaveLength(12);
    expect(phaseCounts(SEED_CUSTOMERS)).toEqual({ open: 12, archived: 2 });
    expect(visibleCustomers(SEED_CUSTOMERS, "open")).toHaveLength(12);
    expect(visibleCustomers(SEED_CUSTOMERS, "archived").map((c) => c.name)).toEqual(["Old Mill Castings", "Dunmore Gearworks"]);
    expect(visibleCustomers(SEED_CUSTOMERS, "all")).toHaveLength(14);
  });
  it("a name found only on documents (no id) is never archived, even if it were marked", () => {
    expect(phaseFor({ id: undefined, manual: "archived" })).toBe("open");
    expect(phaseFor({ id: "c1", manual: "archived" })).toBe("archived");
    expect(phaseFor({ id: "c1" })).toBe("open");
  });
  it("chasing is paused only while the pause is in force (no last day, or today or later)", () => {
    expect(SEED_CUSTOMERS.filter((c) => chasePaused(c)).map((c) => c.name)).toEqual(["Ashby Rail Services", "Wren & Calder"]);
    for (const u of [null, "2026-11-19", TODAY, "2026-12-04"]) expect(chasePaused({ pause: { reason: "x", until: u } })).toBe(pauseActive(u, TODAY));
  });
  it("role gate: Admin and Office in, Workshop and Viewer out", () => {
    expect(["admin", "office", "workshop", "viewer"].map((r) => canUseCustomers(r as never))).toEqual([true, true, false, false]);
  });
  it("delivery note badges follow deliveryNoteStatusKey (sent blue, delivered green, others grey)", () => {
    for (const st of ["awaiting", "despatched", "delivered", "signed"]) { const k = deliveryNoteStatusKey(st); expect(toneOf(st)).toBe(k === "sent" ? "info" : k === "delivered" ? "ok" : "neutral"); }
  });
  it("with the optional database fields off, no sample customer carries Mobile or Traceable", () => {
    for (const c of SEED_CUSTOMERS) { const w = withFeatures(c, false); expect("mobile" in w).toBe(false); expect("traceableDefault" in w).toBe(false); expect(withFeatures(c, true)).toBe(c); }
  });
  it("privacy: every address is on a reserved .example domain and every number is in an Ofcom drama range", () => {
    for (const c of SEED_CUSTOMERS) {
      if (c.email) expect(c.email, c.name).toMatch(/@[a-z0-9-]+(\.[a-z0-9-]+)*\.example$/);
      if (c.phone) expect(c.phone, c.name).toMatch(/^(01632 960\d{3}|0(131|141) 496 0\d{3})$/);
      if (c.mobile) expect(c.mobile, c.name).toMatch(/^07700 900\d{3}$/);
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
function mount() { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root!.render(createElement(CustomersPreview))); return host; }
const byText = (scope: ParentNode, sel: string, text: string | RegExp) => Array.from(scope.querySelectorAll<HTMLElement>(sel)).find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? "")));
const click = (el: Element | undefined | null) => { if (!el) throw new Error("element not found"); act(() => { (el as HTMLElement).click(); }); };
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => { set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
};
const moreItem = (h: HTMLElement, customer: string, label: string) => { click(h.querySelector(`tr[data-customer="${customer}"] [data-testid="more-trigger"]`)); click(byText(document, '[role="menuitem"]', label)); };
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 250)); });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 5)); });
const openDock = () => click(byText(document.body, "button", /Preview controls/));
const pickRole = (name: string) => click(byText(document.body, '[role="radiogroup"][aria-label="Role"] [role="radio"]', name));

describe("customers preview: rendered behaviour", () => {
  it("labels itself, opens on the table with the 12 active customers, and shows the real notes under a name", () => {
    const h = mount();
    expect(h.textContent).toContain("Preview, sample data, nothing is saved");
    expect(h.querySelectorAll("tbody tr[data-customer]")).toHaveLength(12);
    expect(h.querySelector('tr[data-customer="Tern Marine Engineering"] [data-testid="customer-credit"]')?.textContent).toBe("Customer credit £1,250.00");
    expect(h.querySelector('tr[data-customer="Riverside Fabrications"] [data-testid="customer-not-saved"]')?.textContent).toBe(NOT_SAVED_LABEL);
    expect(h.querySelector('tr[data-customer="Ashby Rail Services"] [data-testid="chase-paused-badge"]')?.textContent).toBe("Chasing paused");
    expect(h.querySelector('tr[data-customer="Riverside Fabrications"] [data-action="Add customer"]')).not.toBeNull();
    expect(h.querySelector('tr[data-customer="Riverside Fabrications"] [data-action="Edit"]')).toBeNull();
  });
  it("Draft statement, Archive and the exports only ever answer with the neutral Preview-only toast, never a success", async () => {
    const h = mount();
    moreItem(h, "Marlow Hydraulics", "Draft statement");
    let t = document.body.textContent ?? "";
    expect(t).toContain("Preview only"); expect(t).toContain("Nothing was saved."); expect(t).not.toMatch(/Statement saved in Approvals|archived \(nothing is deleted|moved out of the archive\b(?! would)/i);
    await settle();
    moreItem(h, "Marlow Hydraulics", "Archive");
    await settle();
    t = document.body.textContent ?? ""; expect(t).toContain("would be archived"); expect(t).toContain("Nothing was saved.");
    click(h.querySelector('[data-testid="export-trigger"]'));
    expect(Array.from(document.querySelectorAll('[role="menuitem"]')).map((e) => e.textContent)).toEqual(["CSV, all 12 customers", "Excel, all 12 customers"]);
    click(document.querySelector('[role="menuitem"]'));
    t = document.body.textContent ?? ""; expect(t).toContain("A CSV of 12 customers would download. No file was made."); expect(t).toContain("Nothing was saved.");
  });
  it("Show filter: Archived lists the two archived (Unarchive offered), All lists 14; the counts match", () => {
    const h = mount();
    click(h.querySelector('[data-testid="show-archived"]'));
    expect(Array.from(h.querySelectorAll("tbody tr[data-customer]")).map((r) => r.getAttribute("data-customer"))).toEqual(["Old Mill Castings", "Dunmore Gearworks"]);
    click(h.querySelector('tr[data-customer="Old Mill Castings"] [data-testid="more-trigger"]'));
    expect(Array.from(document.querySelectorAll('[role="menuitem"]')).map((e) => e.textContent)).toEqual(["Draft statement", "Unarchive"]);
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    click(h.querySelector('[data-testid="show-all"]'));
    expect(h.querySelectorAll("tbody tr[data-customer]")).toHaveLength(14);
  });
  it("Add customer: an empty save shows each real message beside its field, focuses the first, saves nothing and shows no toast", async () => {
    const h = mount();
    click(h.querySelector('[data-testid="new-customer"]'));
    expect(h.querySelector('input[name="mobile"]')).not.toBeNull();
    expect(h.querySelector('input[name="traceable_default"]')).not.toBeNull();
    const email = h.querySelector<HTMLInputElement>('input[name="email"]')!;
    type(email, "nope");
    click(h.querySelector('[data-testid="save-customer"]'));
    await flush();
    const summary = h.querySelector('[data-testid="form-summary"]')?.textContent ?? "";
    expect(summary).toBe("2 fields need attention: Customer name, Email.");
    expect(h.querySelector('input[name="name"]')?.getAttribute("aria-invalid")).toBe("true");
    expect(h.textContent).toContain("Enter a customer name.");
    expect(h.textContent).toContain("Enter a valid email address");
    expect(document.activeElement).toBe(h.querySelector('input[name="name"]'));
    expect(h.querySelector("dialog[open]")).not.toBeNull();
    expect(document.body.textContent).not.toContain("Nothing was saved.");
  });
  it("Add customer: a valid save closes the form and answers Preview only, 'would be added', Nothing was saved", () => {
    const h = mount();
    click(h.querySelector('[data-testid="new-customer"]'));
    type(h.querySelector<HTMLInputElement>('input[name="name"]')!, "Fictional Test Works Ltd");
    click(h.querySelector('[data-testid="save-customer"]'));
    expect(h.querySelector("dialog[open]")).toBeNull();
    const t = document.body.textContent ?? "";
    expect(t).toContain("Preview only"); expect(t).toContain("Fictional Test Works Ltd would be added as a customer. Nothing was saved."); expect(t).not.toMatch(/Customer added|saved successfully/i);
  });
  it("Edit: the form carries the real fields, delivery notes and the chase pause; a pause needs a reason and answers Preview only", async () => {
    const h = mount();
    click(h.querySelector('tr[data-customer="Marlow Hydraulics"] [data-action="Edit"]'));
    expect((h.querySelector('input[name="name"]') as HTMLInputElement).value).toBe("Marlow Hydraulics");
    expect(document.activeElement).toBe(h.querySelector('input[name="name"]'));
    expect((h.querySelector('input[name="traceable_default"]') as HTMLInputElement).checked).toBe(true);
    expect(Array.from(h.querySelectorAll('[data-testid="delivery-notes-list"] li')).map((l) => l.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("DLN-0212")]));
    click(byText(document.body, "button", "Pause chasing"));
    click(byText(document.body, "button", "Pause"));
    await flush();
    expect(document.body.textContent).toContain("Enter a reason for pausing.");
    expect(document.body.textContent).not.toContain("Nothing was saved.");
  });
  it("Edit of a customer with a pause shows the real wording and Resume answers Preview only", () => {
    const h = mount();
    click(h.querySelector('tr[data-customer="Ashby Rail Services"] [data-action="Edit"]'));
    expect(h.querySelector('[data-testid="chase-pause-status"]')?.textContent).toBe("Chasing paused until 04/12/2026");
    expect(h.textContent).toContain("No chase e-mails are drafted for this customer while it is paused.");
    click(byText(document.body, "button", "Resume chasing"));
    expect(document.body.textContent).toContain("Chasing would resume for Ashby Rail Services. Nothing was saved.");
  });
  it("Workshop and Viewer get Access Denied (the page's RoleGate), with no list and no New customer", () => {
    const h = mount();
    openDock();
    for (const r of ["Workshop", "Viewer"]) {
      pickRole(r);
      expect(h.querySelector('[data-testid="access-denied"]')?.textContent).toContain("Access Denied");
      expect(h.querySelector("tbody tr")).toBeNull();
      expect(h.querySelector('[data-testid="new-customer"]')).toBeNull();
    }
    pickRole("Office");
    expect(h.querySelector('[data-testid="access-denied"]')).toBeNull();
    expect(h.querySelectorAll("tbody tr[data-customer]")).toHaveLength(12);
  });
  it("with Mobile and Traceable off the form does not offer them", () => {
    const h = mount();
    click(byText(document.body, "button", /Preview controls/));
    click(h.ownerDocument.querySelector('[data-testid="dock-features"]'));
    click(h.querySelector('[data-testid="new-customer"]'));
    expect(h.querySelector('input[name="mobile"]')).toBeNull();
    expect(h.querySelector('input[name="traceable_default"]')).toBeNull();
  });

});

describe("customers preview v2: structural items (PreviewBar, one toolbar row, one action plus More, type scale, plausible data)", () => {
  it("rowActionPlan: one primary action per row, every other real control in More", () => {
    expect(rowActionPlan({ id: "c1", manual: undefined }, true)).toEqual({ primary: { id: "edit", label: "Edit" }, more: [{ id: "statement", label: "Draft statement" }, { id: "archive", label: "Archive" }] });
    expect(rowActionPlan({ id: "c1", manual: "archived" }, true).more.map((m) => m.label)).toEqual(["Draft statement", "Unarchive"]);
    expect(rowActionPlan({ id: "c1" }, false).more.map((m) => m.label)).toEqual(["Draft statement"]);
    expect(rowActionPlan({ notSaved: true }, true)).toEqual({ primary: { id: "add", label: "Add customer" }, more: [] });
  });
  it("one PreviewBar, no yellow pill beside the title; the explainer is a title tooltip and an aria description, not a line under the title", () => {
    const h = mount();
    expect(h.querySelectorAll('[role="group"][aria-label="Preview information"]')).toHaveLength(1);
    expect(h.querySelector("h1")?.textContent).toBe("Customers");
    expect(h.querySelector("header")?.textContent).not.toContain("The companies we sell to");
    const tip = h.querySelector("h1 span[title]")!;
    expect(tip.getAttribute("title")).toBe(CUSTOMERS_TITLE_TIP);
    expect(document.getElementById(tip.getAttribute("aria-describedby")!)?.textContent).toBe(CUSTOMERS_TITLE_TIP);
  });
  it("a single toolbar row holds Show, Export, Columns and View; every row has Edit plus More and a fixed-width actions column; no bulk bar exists", () => {
    const h = mount();
    const bar = h.querySelector('[role="group"][aria-label="List controls"]')!;
    for (const sel of ['[data-testid="show-open"]', '[data-testid="export-trigger"]', '[data-testid="columns-trigger"]', '[data-testid="view-table-btn"]']) expect(bar.querySelector(sel), sel).not.toBeNull();
    expect(h.querySelectorAll('tbody tr[data-customer]:not([data-customer^="Riverside"]):not([data-customer^="Cobalt"]) [data-testid="more-trigger"]')).toHaveLength(10);
    expect(h.querySelectorAll('tbody [data-action="Edit"]')).toHaveLength(10);
    expect(h.querySelectorAll('tbody [data-action="Add customer"]')).toHaveLength(2);
    expect(h.querySelector('[data-selection]')).toBeNull();
  });
  it("Edit still opens the real form from the primary button", () => {
    const h = mount();
    click(h.querySelector('tr[data-customer="Marlow Hydraulics"] [data-action="Edit"]'));
    expect(h.querySelector('input[name="name"]')).not.toBeNull();
  });
  it("sample data is plausible Scottish and UK, with no placeholder-sounding names", () => {
    const text = JSON.stringify(SEED_CUSTOMERS);
    for (const bad of ["Placeholder", "Testfield", "Mockridge", "Sampleford", "Dummerby", "Exampleton", "Testford", "Testwell", "Alex Sample"]) expect(text).not.toContain(bad);
    expect(SEED_CUSTOMERS.some((c) => /MacLeod|Drummond|Campbell/.test(c.contactName))).toBe(true);
  });
});
