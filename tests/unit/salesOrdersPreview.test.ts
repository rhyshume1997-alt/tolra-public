// @vitest-environment jsdom
/**
 * BOUNDARY (Sales Orders module 3, PREVIEW ONLY). Inputs: the exports of components/sales-orders/preview/SalesOrdersPreview.tsx, the REAL lib functions it uses or
 * mirrors (lib/archive, lib/sales-order-convert, lib/list-card-counts, lib/accept-quote, lib/so-machines, lib/order-from-quote, lib/status-colours, lib/spreadsheet,
 * lib/validation/schemas, lib/dates, lib/money) and the SOURCE TEXT of app/(dashboard)/sales-orders/page.tsx, components/so-machines-dialog.tsx and
 * components/customer-select.tsx (read as files, never run). Output: pass/fail. Pins the preview to today's Sales Orders screen: the phase of every sample order (the
 * real phaseOf), the tile and Show counts, the list filter, the toolbar's disabled reasons, which row buttons an order gets, the order-from-quote terms, the machine plan
 * sums, the form's checks and the words. Also checks the sample holds no live record, that the preview imports nothing that could read or write, and a few interaction
 * rules (nothing reports success, role gate, the row menu, the Machines sheet) by rendering the preview.
 * v3 (owner-approved structure): also pins the Filters popover with its count and removable chips, the bulk bar that exists only with a selection (Print, Export, Convert and Despatch Selected, each
 * with its real reason), Export in the toolbar, the one-primary-plus-shared-More row split (every real row action still reachable), and the title tooltip that replaced the generic sentence.
 * Must not change: never loosen these to make a change pass. No network, no Supabase. Written with createElement (no JSX) so it is a .test.ts file and runs under the
 * existing vitest.config.ts include pattern.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import SalesOrdersPreview, * as P from "@/components/sales-orders/preview/SalesOrdersPreview";
import { awaitsCustomerPo, customerPoInput } from "@/lib/accept-quote";
import { phaseOf as realPhaseOf } from "@/lib/archive";
import { fmtDate as realFmtDate } from "@/lib/dates";
import { salesOrdersEmptyHint } from "@/lib/empty-hints";
import { SALES_ORDER_OPEN_CARD_NOTE, SALES_ORDER_OPEN_CARD_STATUSES, countPhases, salesOrderCardCounts } from "@/lib/list-card-counts";
import { documentTotals, gbp } from "@/lib/money";
import { orderTermsFromQuote } from "@/lib/order-from-quote";
import { quoteAcceptBlock } from "@/lib/quote-status";
import { canDespatch, editBlockedReason, isConverted, ordersToConvert, ordersToDespatch } from "@/lib/sales-order-convert";
import { describeMachines, sumMachineHours, totalHours } from "@/lib/so-machines";
import { exportScopeTitle } from "@/lib/spreadsheet";
import { STATUS_MAP, salesOrderStatusKey } from "@/lib/status-colours";
import { customerName, moneyAmount, salesOrderSaveSchema } from "@/lib/validation/schemas";

const root = path.resolve(__dirname, "../..");
const PAGE = readFileSync(path.join(root, "app/(dashboard)/sales-orders/page.tsx"), "utf8");
const MACHINES_SRC = readFileSync(path.join(root, "components/so-machines-dialog.tsx"), "utf8");
const PICKER_SRC = readFileSync(path.join(root, "components/customer-select.tsx"), "utf8");
const PREVIEW_SRC = readFileSync(path.join(root, "components/sales-orders/preview/SalesOrdersPreview.tsx"), "utf8");
const CSS_SRC = readFileSync(path.join(root, "components/sales-orders/preview/SalesOrdersPreview.module.css"), "utf8");
const NOW = new Date(`${P.TODAY}T12:00:00Z`);
const order = (id: string) => P.SEED_ORDERS.find((o) => o.id === id)!;
const refs = (rows: Array<{ ref: string }>) => rows.map((o) => o.ref);

describe("sales orders preview: phase, counts and filters equal the real rules", () => {
  it("the REAL convert, despatch, edit-block and card-count functions are the ones used", () => {
    expect(P.isConverted).toBe(isConverted);
    expect(P.canDespatch).toBe(canDespatch);
    expect(P.editBlockedReason).toBe(editBlockedReason);
    expect(P.ordersToConvert).toBe(ordersToConvert);
    expect(P.ordersToDespatch).toBe(ordersToDespatch);
    expect(P.salesOrderCardCounts).toBe(salesOrderCardCounts);
    expect(P.countPhases).toBe(countPhases);
    expect(P.awaitsCustomerPo).toBe(awaitsCustomerPo);
    expect(P.orderTermsFromQuote).toBe(orderTermsFromQuote);
  });
  it("16 sample orders cover every status, and the phase of each equals lib/archive phaseOf", () => {
    expect(P.SEED_ORDERS).toHaveLength(16);
    expect(new Set(P.SEED_ORDERS.map((o) => o.status))).toEqual(new Set(["open", "confirmed", "in_production", "despatched", "converted", "closed"]));
    for (const o of P.SEED_ORDERS) {
      const final = ["despatched", "converted", "closed"].includes(o.status) && !awaitsCustomerPo(o);
      expect(P.phaseFor(o), o.ref).toBe(realPhaseOf({ final, finalDate: o.delivery || o.date }, o.manual, 12, NOW));
    }
    expect(PAGE).toContain('phaseOf({ final: ["despatched", "converted", "closed"].includes(order.status) && !awaitsCustomerPo(order), finalDate: order.delivery || order.date }, order.id ? archive.manual.get(String(order.id)) : undefined, archive.months)');
  });
  it("an order made from a quote that is still waiting for its customer PO stays Open even when converted", () => {
    expect(awaitsCustomerPo(order("so16"))).toBe(true);
    expect(order("so16").status).toBe("converted");
    expect(P.phaseFor(order("so16"))).toBe("open");
    expect(P.phaseFor(order("so15"))).toBe("done");
  });
  it("Show counts: 7 open, 7 done, 2 archived (one by hand, one by the 12 month rule); an order archived by hand beats the rule, one kept active is never archived", () => {
    expect(P.countPhases(P.SEED_ORDERS, (o) => P.phaseFor(o))).toEqual({ open: 7, done: 7, archived: 2 });
    expect(P.phaseFor(order("so09"))).toBe("archived");
    expect(P.phaseFor(order("so07"))).toBe("archived");
    expect(P.phaseFor({ ...order("so07"), manual: "active" })).toBe("done");
  });
  it("tile figures: Open 6 (open phase, not converted), Confirmed 2, Despatched 4, with the page's note", () => {
    expect(P.salesOrderCardCounts(P.SEED_ORDERS, (o) => P.phaseFor(o))).toEqual({ open: 6, confirmed: 2, despatched: 4 });
    expect(P.NOTE_OPEN_CARD).toBe(SALES_ORDER_OPEN_CARD_NOTE);
    expect(PAGE).toContain("SALES_ORDER_OPEN_CARD_NOTE");
    expect([...P.OPEN_CARD_FILTER].sort()).toEqual([...SALES_ORDER_OPEN_CARD_STATUSES].sort());
  });
  it("the visible rows follow the page's filter expression, newest order date first", () => {
    expect(PAGE).toContain('orders.filter((order) => (phase === "all" || phaseFor(order) === phase) && (filters.has("all") || filters.has(order.status)))');
    expect(PAGE).toContain('const [phase, setPhase] = useState<PhaseFilterValue>("open");');
    const vis = (f: Partial<P.Filters>) => refs(P.visibleOrders(P.SEED_ORDERS, { ...P.DEFAULT_FILTERS, ...f }));
    expect(vis({})).toHaveLength(7);
    expect(vis({})[0]).toBe("BW-5530");
    expect(vis({ phase: "all" })).toHaveLength(16);
    expect(vis({ phase: "done" })).toHaveLength(7);
    expect(vis({ phase: "open", statuses: P.OPEN_CARD_FILTER })).toHaveLength(6);
    expect(vis({ phase: "all", statuses: new Set(["confirmed"]) })).toEqual(["NF-88213", "HP-7710"]);
    // the Despatched tile keeps the phase it is in (as the real card does): under Open there is nothing despatched
    expect(vis({ statuses: new Set(["despatched"]) })).toEqual([]);
  });
  it("the tiles, chips and Show options are the page's, in order", () => {
    expect(PAGE).toContain('[["Open", counts.open, "open", "text-brand-accent"], ["Confirmed", counts.confirmed, "confirmed", "text-green-600 dark:text-green-400"], ["Despatched", counts.despatched, "despatched", "text-teal-600 dark:text-teal-400"]]');
    expect(PAGE).toContain('options={[{ label: "All", value: "all" }, { label: "Open", value: "open" }, { label: "Confirmed", value: "confirmed" }, { label: "In Production", value: "in_production" }, { label: "Despatched", value: "despatched" }, { label: "Converted", value: "converted" }, { label: "Closed", value: "closed" }]}');
    expect(P.STATUS_CHIPS.map((c) => [c.label, c.value])).toEqual([["All", "all"], ["Open", "open"], ["Confirmed", "confirmed"], ["In Production", "in_production"], ["Despatched", "despatched"], ["Converted", "converted"], ["Closed", "closed"]]);
    expect(PAGE).toContain('<h1 className="page-title">Sales Orders</h1>');
    expect(PAGE).toContain("A sales order is a customer&apos;s confirmed order. Turn it into a job when work starts.");
    expect(P.EMPTY_HINT).toBe(salesOrdersEmptyHint());
    expect(PAGE).toContain('"No sales orders match this filter" : "No sales orders yet"');
  });
  it("status colours come from the real map: blue is info, green is ok, an unmapped status is plain", () => {
    for (const s of ["open", "confirmed", "in_production", "despatched", "converted", "closed"]) {
      const key = salesOrderStatusKey(s);
      const colour = key ? STATUS_MAP[key].colour : null;
      expect(P.statusTone(s), s).toBe(colour === "blue" ? "info" : colour === "green" ? "ok" : "neutral");
    }
    expect(P.statusTone("confirmed")).toBe("ok");
    expect(P.statusTone("converted")).toBe("neutral");
    expect(P.statusLabel("in_production")).toBe("in production");
    expect(PAGE).toContain('label={order.status.replaceAll("_", " ")}');
  });
});

describe("sales orders preview: the toolbar and row buttons follow the page", () => {
  it("the toolbar's disabled reasons are the page's words", () => {
    const none: never[] = [];
    expect(P.convertReason(none, 0)).toBe("Select at least one sales order");
    expect(P.convertReason([order("so15")], 1)).toBe("The selected orders already have jobs");
    expect(P.convertReason([order("so19")], 1)).toBeUndefined();
    expect(P.despatchReason(none, 0)).toBe("Select at least one sales order");
    expect(P.despatchReason([order("so15"), order("so13")], 2)).toBe("None of the selected orders can be despatched (already converted, despatched or closed)");
    expect(P.despatchReason([order("so19")], 1)).toBeUndefined();
    expect(P.printReason(0)).toBe("Select at least one sales order");
    for (const text of ["Select at least one sales order", "The selected orders already have jobs", "None of the selected orders can be despatched (already converted, despatched or closed)"]) expect(PAGE).toContain(text);
    for (const label of ["Convert Selected to Jobs", "Despatch Selected", "Convert to Job", "Despatch", "Add customer PO", "Machines", "Customer not linked", "Not set", "Not received yet", "None planned"]) expect(PAGE, label).toContain(label);
  });
  it("export scope text is lib/spreadsheet's", () => {
    expect(P.scopeTitle(0, 7)).toBe(exportScopeTitle("sales order", 0, 7));
    expect(P.scopeTitle(2, 7)).toBe("Exports the 2 sales orders selected");
    expect(PAGE).toContain('exportScopeTitle("sales order", selectedOrders.length, visible.length)');
    expect(PAGE).toContain('label: "CSV"');
    expect(PAGE).toContain('label: "Excel"');
  });
  it("Convert to Job is offered until the order has a job; Despatch only while open, confirmed or in production; Edit is blocked with the real reason", () => {
    expect(isConverted(order("so15"))).toBe(true);
    expect(canDespatch(order("so17"))).toBe(true);
    expect(canDespatch(order("so13"))).toBe(false);
    expect(editBlockedReason(order("so15"))).toBe("Converted to J-1043: change the job, not the order.");
    expect(editBlockedReason(order("so19"))).toBeNull();
    expect(PAGE).toContain("{isConverted(order) ? null : <Button size=\"sm\" disabled={saving} onClick={() => void convertOrders([order])}");
    expect(PAGE).toContain("{canDespatch(order) ? <Button variant=\"outline\" size=\"sm\" disabled={saving} onClick={() => void despatchOrders([order])}>Despatch</Button> : null}");
    expect(PAGE).toContain('{order.id && !order.customerPo ? <Button variant="outline" size="sm" aria-label={`Add customer PO to ${order.ref}`}');
  });
  it("the convert toast says what the machines carry, worked out with the real sums", () => {
    expect(P.planText(order("so17"))).toBe(describeMachines(sumMachineHours([
      { machine_id: "m2", estimated_hours: 6, line_key: 1, sales_order_line_id: "l1", position: 0 }, { machine_id: "m1", estimated_hours: 2.5, line_key: 1, sales_order_line_id: "l1", position: 1 },
    ]).map((m) => ({ name: P.MACHINES.find((x) => x.id === m.machine_id)!.name, hours: m.hours }))));
    expect(P.planText(order("so17"))).toBe("Doosan Lynx lathe 6 h, Haas VF-2 mill 2.5 h");
    expect(P.carriedText(order("so17"))).toBe(`; carried 2 machines (${totalHours([{ hours: 6 }, { hours: 2.5 }])} h)`);
    expect(P.carriedText(order("so19"))).toBe("; carried 1 machine (2 h)");
    expect(P.carriedText(order("so21"))).toBe("");
    expect(PAGE).toContain("carried ${links.length} machine${links.length === 1 ? \"\" : \"s\"}");
  });
  it("only admin and office may open the screen and archive", () => {
    expect(PAGE).toContain('<RoleGate allowed={["admin", "office"]}>');
    expect(["admin", "office", "workshop", "viewer"].map((r) => P.canUseSalesOrders(r as P.Role))).toEqual([true, true, false, false]);
    expect(P.canArchive("office")).toBe(true);
    expect(P.canArchive("viewer")).toBe(false);
  });
  it("the table columns are the real ones", () => {
    expect(P.COLUMNS.map((c) => [c.key, c.label, Boolean(c.locked)])).toEqual([["ref", "SO Ref", true], ["customer", "Customer", false], ["date", "Order Date", false], ["delivery", "Expected Delivery", false], ["value", "Value", false], ["status", "Status", false]]);
    expect(PAGE).toContain("<TableHead>SO Ref</TableHead>");
    expect(PAGE).toContain("<TableHead>Expected Delivery</TableHead>");
  });
});

describe("sales orders preview: the forms", () => {
  it("the order form's checks say what the real schema says, one message per field", () => {
    const parsed = salesOrderSaveSchema.safeParse({ customer: "", customerPo: "x".repeat(101), quoteRef: "", orderDate: "", deliveryDate: "nope", totalValue: Number.NaN });
    const real = Object.fromEntries((parsed.success ? [] : parsed.error.issues).map((i) => [String(i.path[0]), i.message]));
    const mine = P.orderErrors({ customer: "", customerPo: "x".repeat(101), orderDate: "", deliveryDate: "nope", value: "" });
    expect(mine.customer).toBe(real.customer);
    expect(mine.customerPo).toBe(real.customerPo);
    expect(mine.orderDate).toBe(real.orderDate);
    expect(mine.deliveryDate).toBe(real.deliveryDate);
    expect(mine.value).toBe(real.totalValue);
    expect(P.orderErrors({ customer: "A", customerPo: "", orderDate: "2026-11-23", deliveryDate: "", value: "-1" }).value).toBe(moneyAmount("Value").safeParse(-1).error?.issues[0].message);
    expect(P.orderErrors({ customer: "A", customerPo: "", orderDate: "2026-11-23", deliveryDate: "", value: "1.234" }).value).toBe(moneyAmount("Value").safeParse(1.234).error?.issues[0].message);
    expect(P.orderErrors({ customer: "A", customerPo: "", orderDate: "2026-11-23", deliveryDate: "", value: "125.5" })).toEqual({});
    expect(customerName.safeParse("").error?.issues[0].message).toBe("Customer is required");
    expect(P.ORDER_FIELD_ORDER).toEqual(["customer", "customerPo", "orderDate", "deliveryDate", "value"]);
  });
  it("a customer PO is trimmed and an empty one means none yet (the real customerPoInput)", () => {
    expect(P.customerPoInput).toBe(customerPoInput);
    expect(P.customerPoInput("  NF-1 ")).toBe("NF-1");
    expect(P.customerPoInput("   ")).toBeNull();
  });
  it("linking an accepted quote carries over what the real orderTermsFromQuote allows", () => {
    const [a, mixed, declined, zero] = P.ACCEPTED_QUOTES;
    const t = (q: P.AcceptedQuote) => P.termsFor(q, true);
    expect(t(a)).toEqual({ ok: true, value: 3436, vatOn: true, vat: "20" });
    const m = t(mixed);
    expect(m.ok).toBe(false);
    expect(m.ok ? "" : m.reason).toContain("different VAT rates");
    // only the ordered lines count: 60 pins and 60 carriers, the 20 spare pins are declined
    expect(t(declined)).toEqual({ ok: true, value: 1668, vatOn: true, vat: "20" });
    expect(t(zero)).toMatchObject({ ok: true, value: 0 });
    expect(quoteAcceptBlock(zero.total)).toBe("A quote for £0.00 can't be accepted. Add a price or decline it.");
    // a company that is not VAT registered cannot hold a quote that charged VAT: the real function refuses it (to the penny), and the sheet says why
    expect(P.termsFor(a, false)).toEqual(orderTermsFromQuote({ vat_enabled: true, total_value: a.total }, a.lines, false));
    expect(PAGE).toContain("orderTermsFromQuote(head, (lines ?? []) as unknown as QuoteLineRow[], vat.registered)");
    expect(PAGE).toContain("const zeroQuote = quoteAcceptBlock(quote.total);");
  });
  it("the New sales order sheet's words, the VAT totals and the customer picker are the real ones", () => {
    for (const text of ["New Sales Order", "Create from an accepted quote, or enter the customer&apos;s order by hand.", "Customer order number (their PO)", "Not received yet? Leave it empty: the order gets a provisional number and you add the PO later.", "Order value (ex VAT)", "Save Sales Order", "Loading the quote&apos;s lines...", "Order total", "No linked quote", "No accepted quotes"]) expect(PAGE, text).toContain(text);
    expect(PAGE).toContain("Couldn't load that quote's lines. Choose it again, or choose");
    expect(PAGE).toContain("Couldn't load accepted quotes. You can still enter the order by hand.");
    expect(PICKER_SRC).toContain("+ Add new customer");
    expect(PICKER_SRC).toContain('Select customer...');
    expect(PICKER_SRC).toContain("Saved to your customer list and selected automatically.");
    expect(P.PICKER_LOAD_FAILED).toBe("Couldn't load the customer list, so no customer can be picked. Nothing was changed.");
    expect(PICKER_SRC).toContain(`export const PICKER_LOAD_FAILED = "${P.PICKER_LOAD_FAILED}";`);
    const totals = documentTotals([{ quantity: 1, unitPrice: 100, vatPct: 20, vatExempt: false }], 0, { vatEnabled: true, standardRate: 20 });
    expect(totals.total).toBe(120);
  });
  it("Edit, Add customer PO and Machines words are today's", () => {
    for (const text of ["Update customer order information.", "Save Changes", "Save customer PO", "The customer&apos;s order number. A provisional SO number is replaced by it, and a job made from this order that isn&apos;t finished gets it on its worksheet."]) expect(PAGE, text).toContain(text);
    for (const text of ["As ordered. This order has been converted: the job holds the plan now, and it is changed on the Job Board.", "Nothing is booked on the schedule until you book it from the job.", "Save machines", "Add machine", "A machine can carry at most 1000 hours across the order&apos;s lines:"]) expect(MACHINES_SRC, text).toContain(text);
    expect(MACHINES_SRC).toContain("Choose a machine");
    expect(MACHINES_SRC).toContain("No machine yet.");
  });
  it("dates and money read as the real page prints them", () => {
    expect(P.fmtDate("2026-11-21")).toBe(realFmtDate("2026-11-21"));
    expect(P.money(4184)).toBe(gbp(4184, 2));
    expect(PAGE).toContain("const currency = (value: number) => gbp(value, 2);");
  });
});

describe("sales orders preview: it is only a picture", () => {
  it("every name is fictional and no sample is a live record", () => {
    const text = JSON.stringify([P.SEED_ORDERS, P.ACCEPTED_QUOTES, P.MACHINES]);
    expect(text).not.toMatch(/@|https?:\/\//);
    expect(P.SEED_ORDERS.some((o) => !o.customer)).toBe(true);
    expect(P.SEED_ORDERS.some((o) => o.vat === "exempt")).toBe(true);
  });
  it("imports nothing that can read, write, print, download or navigate", () => {
    const imports = PREVIEW_SRC.match(/from "[^"]+"/g) ?? [];
    expect([...new Set(imports)].sort()).toEqual([
      'from "./SalesOrdersPreview.module.css"', 'from "@/components/ui/premium"', 'from "@/lib/accept-quote"', 'from "@/lib/dates"', 'from "@/lib/empty-hints"', 'from "@/lib/list-card-counts"', 'from "@/lib/money"', 'from "@/lib/order-from-quote"',
      'from "@/lib/quote-status"', 'from "@/lib/sales-order-convert"', 'from "@/lib/so-machines"', 'from "@/lib/spreadsheet"', 'from "@/lib/status-colours"', 'from "@/lib/vat"', 'from "react"',
    ].sort());
    expect(PREVIEW_SRC).not.toMatch(/supabase|fetch\(|XMLHttpRequest|window\.open|window\.location|downloadPdf|openPrintPack|exportSpreadsheet|next\/navigation|useRouter|\.rpc\(/);
  });
  it("no gradient, blur or glass", () => {
    expect(CSS_SRC.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/gradient|backdrop-filter|blur\(/);
  });
});

/* ---------------- rendered behaviour ---------------- */

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
  proto.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  proto.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as never;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement | null = null;
let rootEl: ReturnType<typeof createRoot> | null = null;
afterEach(() => { act(() => rootEl?.unmount()); host?.remove(); document.body.innerHTML = ""; host = null; rootEl = null; window.localStorage.clear(); vi.restoreAllMocks(); });
function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  rootEl = createRoot(host);
  act(() => rootEl!.render(createElement(SalesOrdersPreview)));
  return host;
}
const byText = (scope: ParentNode, sel: string, text: string | RegExp) => Array.from(scope.querySelectorAll<HTMLElement>(sel)).find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? "")));
const click = (el: Element | undefined | null) => { if (!el) throw new Error("element not found"); act(() => { (el as HTMLElement).click(); }); };
const menuItem = (ref: string, label: string | RegExp) => byText(document.querySelector(`[role="menu"][aria-label="More actions for ${ref}"]`)!, '[role="menuitem"]', label);
const pickRole = (label: string) => { click(byText(document.body, "button", /Preview controls/)); click(byText(document.body, '[role="radiogroup"][aria-label="Role"] [role="radio"]', label)); };

describe("sales orders preview: rendered behaviour", () => {
  it("labels itself, opens on the Table with the 7 open orders and the three tiles, and calls nothing", () => {
    const fetchSpy = vi.fn(() => { throw new Error("no network in the preview"); });
    vi.stubGlobal("fetch", fetchSpy);
    const h = mount();
    expect(h.textContent).toContain("Preview, sample data, nothing is saved");
    expect(h.querySelector('[data-testid="sales-orders-preview"]')?.getAttribute("data-pview")).toBe("table");
    expect(h.querySelectorAll("tbody tr[data-order]")).toHaveLength(7);
    expect(Array.from(h.querySelectorAll('[role="group"][aria-label="Sales order figures"] button')).map((b) => b.querySelector("span:nth-of-type(2)")?.textContent)).toEqual(["6", "2", "4"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("the Open tile applies the page's open-card filter and presses itself; Confirmed shows its status", () => {
    const h = mount();
    click(h.querySelector('[data-testid="tile-open"]'));
    expect(h.querySelectorAll("tbody tr[data-order]")).toHaveLength(6);
    expect(h.querySelector('[data-testid="tile-open"]')?.getAttribute("aria-pressed")).toBe("true");
    click(h.querySelector('[data-testid="tile-confirmed"]'));
    expect(h.querySelectorAll("tbody tr[data-order]")).toHaveLength(2);
    click(h.querySelector('[data-testid="tile-despatched"]'));
    expect(h.querySelector("section[aria-label='No sales orders match this filter']")).not.toBeNull();
  });
  it("the bulk buttons exist only while a row is ticked; then they follow the page's rules and every one answers with the neutral Preview-only toast", () => {
    const h = mount();
    expect(h.querySelector('[data-testid="convert-selected"]')).toBeNull();
    expect(h.querySelector("[data-selection]")?.getAttribute("data-selection")).toBe("idle");
    click(h.querySelector('tr[data-order="SO-0149"] [data-testid="select-row"]'));
    expect(h.querySelector<HTMLButtonElement>('[data-testid="convert-selected"]')?.disabled).toBe(true);
    expect(h.querySelector<HTMLButtonElement>('[data-testid="convert-selected"]')?.title).toBe("The selected orders already have jobs");
    expect(h.querySelector<HTMLButtonElement>('[data-testid="despatch-selected"]')?.disabled).toBe(true);
    expect(h.querySelector<HTMLButtonElement>('[data-testid="print-selected"]')?.disabled).toBe(false);
    click(h.querySelector('tr[data-order="NF-88213"] [data-testid="select-row"]'));
    expect(h.querySelector("[data-selection]")?.textContent).toContain("2 selected of 7 filtered records");
    const convert = h.querySelector<HTMLButtonElement>('[data-testid="convert-selected"]')!;
    expect(convert.disabled).toBe(false);
    click(convert);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Preview only");
    expect(text).toContain("A job would be created from sales order NF-88213; carried 1 machine (2 h).");
    expect(text).toContain("Nothing was saved.");
    expect(text).not.toMatch(/saved successfully|job .* created\b(?! from)|moved to Despatched\./i);
    click(byText(h, "button", "Select all 7 filtered"));
    expect(h.querySelector("[data-selection]")?.textContent).toContain("7 selected of 7 filtered records");
    click(byText(h, "button", "Clear selection"));
    expect(h.querySelector("[data-selection]")?.getAttribute("data-selection")).toBe("idle");
  });
  it("Despatch, Archive, Print and Export are previews too", () => {
    const h = mount();
    click(h.querySelector('tr[data-order="HP-7710"] [data-testid="row-more"]'));
    click(menuItem("HP-7710", "Despatch"));
    expect(document.body.textContent).toContain("1 sales order(s) would move to Despatched. Nothing was saved.");
    click(h.querySelector('[data-testid="export-trigger"]'));
    click(byText(document.body, '[role="menuitem"]', "CSV"));
    expect(document.body.textContent).toContain("The CSV export would cover all 7 sales orders in the current filter. No file was downloaded.");
  });
  it("the row menu is named for its order; Edit is disabled with its reason shown as text for a converted order", () => {
    const h = mount();
    click(h.querySelector('tr[data-order="SO-0149"] [data-testid="row-more"]'));
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.getAttribute("aria-label")).toBe("More actions for SO-0149");
    expect(Array.from(menu!.querySelectorAll('[role="menuitem"]')).map((e) => e.firstElementChild?.firstElementChild?.textContent ?? e.textContent)).toEqual(["Edit", "Add customer PO", "Machines", "Archive"]);
    const edit = byText(menu!, '[role="menuitem"]', /^Edit/);
    expect(edit?.getAttribute("aria-disabled")).toBe("true");
    expect(edit?.textContent).toContain("Converted to J-1041: change the job, not the order.");
    expect(byText(menu!, '[role="menuitem"]', "Add customer PO")).toBeDefined();
    expect(byText(menu!, '[role="menuitem"]', "Machines")).toBeDefined();
    expect(byText(menu!, '[role="menuitem"]', "Archive")).toBeDefined();
  });
  it("Add customer PO is disabled until something is typed, then answers with a toast", () => {
    const h = mount();
    click(h.querySelector('tr[data-order="SO-0158"] [data-testid="row-more"]'));
    click(menuItem("SO-0158", "Add customer PO"));
    const save = byText(document.body, "dialog button", "Save customer PO") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const input = document.querySelector<HTMLInputElement>('[data-testid="dlg-po"] input')!;
    act(() => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; setter.call(input, " WC-5100 "); input.dispatchEvent(new Event("input", { bubbles: true })); });
    click(byText(document.body, "dialog button", "Save customer PO"));
    expect(document.querySelector('[data-testid="dlg-po"]')).toBeNull();
    expect(document.body.textContent).toContain("Customer PO WC-5100 would be added to SO-0158. Nothing was saved.");
  });
  it("the Machines sheet is read only for a converted order and editable for an open one, with the real sums", () => {
    const h = mount();
    click(h.querySelector('tr[data-order="SO-0149"] [data-testid="row-more"]'));
    click(menuItem("SO-0149", "Machines"));
    expect(document.querySelector('[data-testid="dlg-machines"]')?.textContent).toContain("As ordered. This order has been converted");
    expect(document.querySelector('[data-testid="dlg-machines"] select[disabled]')).not.toBeNull();
    expect(document.querySelector('[data-testid="so-machines-summary"]')?.textContent).toBe("On the job: Doosan Lynx lathe 5 h (5 h in all)");
    click(byText(document.body, "dialog button", "Close"));
    click(h.querySelector('tr[data-order="NF-88213"] [data-testid="row-more"]'));
    click(menuItem("NF-88213", "Machines"));
    expect((byText(document.body, "dialog button", "Save machines") as HTMLButtonElement).disabled).toBe(true);
    click(byText(document.body, "dialog button", "Add machine"));
    expect(document.querySelector('[data-testid="so-machines-summary"]')?.textContent).toContain("Bandsaw 1 2 h");
  });
  it("New sales order: errors beside each field with a summary, a quote that cannot be linked says why, nothing is saved", () => {
    vi.useFakeTimers();
    const h = mount();
    click(h.querySelector('[data-testid="new-order"]'));
    click(byText(document.body, "dialog button", "Save Sales Order"));
    expect(document.querySelector('[data-testid="error-summary"]')?.textContent).toContain("There are 2 problems with this sales order");
    expect(document.querySelectorAll('dialog [aria-invalid="true"]')).toHaveLength(2);
    const select = document.querySelector<HTMLSelectElement>('[data-testid="dlg-create"] select[name="quote"]')!;
    act(() => { select.value = "aq2"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(document.querySelector('[data-testid="dlg-create"]')?.textContent).toContain("Loading the quote's lines...");
    act(() => { vi.advanceTimersByTime(700); });
    expect(document.querySelector('[data-testid="dlg-create"] [role="alert"]:not([data-testid])')?.textContent).toContain("different VAT rates");
    expect((byText(document.body, "dialog button", "Save Sales Order") as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).not.toContain("Preview only");
    vi.useRealTimers();
  });
  it("Workshop and Viewer get Access Denied, as the real page's role gate", () => {
    const h = mount();
    pickRole("Viewer");
    expect(h.querySelector('[data-testid="access-denied"]')?.textContent).toContain("Access Denied");
    expect(h.querySelector('[role="group"][aria-label="Sales order figures"]')).toBeNull();
    expect(h.querySelector('[data-testid="new-order"]')).toBeNull();
  });
});

/* ---------------- v3 structure (owner-approved items 1, 2, 4, 7, 10, 11) ---------------- */

describe("sales orders preview v3: pure structure rules", () => {
  it("Filters (n) counts only the status chips; Show is not a chip; Clear filters shows only off the default", () => {
    expect(P.activeChips(P.DEFAULT_FILTERS)).toEqual([]);
    expect(P.popoverFilterCount({ ...P.DEFAULT_FILTERS, statuses: new Set(["open", "in_production"]) })).toBe(2);
    expect(P.activeChips({ ...P.DEFAULT_FILTERS, statuses: new Set(["in_production"]) }).map((c) => c.label)).toEqual(["Status: In Production"]);
    expect(P.popoverFilterCount({ ...P.DEFAULT_FILTERS, phase: "done" })).toBe(0);
    expect(P.isFiltered(P.DEFAULT_FILTERS)).toBe(false);
    expect(P.isFiltered({ ...P.DEFAULT_FILTERS, phase: "all" })).toBe(true);
    expect(P.isFiltered({ ...P.DEFAULT_FILTERS, statuses: new Set(["open"]) })).toBe(true);
    expect([...P.toggleStatusIn(new Set(["all"]), "open")]).toEqual(["open"]);
    expect([...P.toggleStatusIn(new Set(["open"]), "open")]).toEqual(["all"]);
  });
  it("one primary per row (Convert to Job while there is no job, else View) and every real action still reachable in More, in the real order", () => {
    expect(P.rowActionPlan(order("so18"), "admin")).toEqual({ primary: "convert", more: ["view", "despatch", "edit", "machines", "archive"] });
    expect(P.rowActionPlan(order("so20"), "admin")).toEqual({ primary: "convert", more: ["view", "despatch", "edit", "po", "machines", "archive"] });
    expect(P.rowActionPlan(order("so16"), "office")).toEqual({ primary: "view", more: ["edit", "po", "machines", "archive"] });
    for (const o of P.SEED_ORDERS) {
      const plan = P.rowActionPlan(o, "admin");
      const expected = ["view", ...(P.isConverted(o) ? [] : ["convert"]), ...(P.canDespatch(o) ? ["despatch"] : []), "edit", ...(o.id && !o.customerPo ? ["po"] : []), ...(o.id ? ["machines"] : []), "archive"];
      expect([plan.primary, ...plan.more].sort(), o.ref).toEqual(expected.sort());
    }
    expect(P.rowActionPlan(order("so18"), "workshop").more).not.toContain("archive");
  });
  it("the generic sentence is kept as the title tooltip", () => {
    expect(P.SO_INTRO).toBe("A sales order is a customer's confirmed order. Turn it into a job when work starts.");
  });
});

describe("sales orders preview v3: rendered structure", () => {
  it("one PreviewBar, the title tooltip, and no placeholder-sounding names", () => {
    const h = mount();
    expect(h.querySelector('[data-testid="preview-bar"]')?.textContent).toContain("Preview, sample data, nothing is saved");
    expect(h.querySelector('[data-testid="so-title"]')?.getAttribute("title")).toBe(P.SO_INTRO);
    expect(h.querySelectorAll("h1")).toHaveLength(1);
    expect(JSON.stringify(P.SEED_ORDERS) + P.CUSTOMERS.join()).not.toMatch(/placeholder|testfield|mockridge|sampleford|dummerby|exampleton/i);
  });
  it("the filter toolbar is one row with a Filters popover holding the real status chips, a count, removable chips and one Clear filters", () => {
    const h = mount();
    const trigger = h.querySelector<HTMLElement>('[data-testid="filters-trigger"]')!;
    expect(trigger.textContent?.trim()).toBe("Filters");
    expect(h.querySelector('[data-testid="clear-filters"]')).toBeNull();
    click(trigger);
    expect(Array.from(document.querySelectorAll('[role="dialog"][aria-label="Filters"] [aria-pressed]')).map((b) => b.textContent)).toEqual(["All", "Open", "Confirmed", "In Production", "Despatched", "Converted", "Closed"]);
    click(document.querySelector('[data-testid="chip-confirmed"]'));
    click(document.querySelector('[data-testid="chip-open"]'));
    expect(trigger.textContent?.trim()).toBe("Filters (2)");
    expect(Array.from(h.querySelectorAll('[data-testid="active-chips"] button')).map((b) => b.getAttribute("aria-label"))).toEqual(["Remove filter Status: Open", "Remove filter Status: Confirmed"]);
    click(h.querySelector('[data-chip="open"]'));
    expect(trigger.textContent?.trim()).toBe("Filters (1)");
    expect(h.querySelectorAll("tbody tr[data-order]")).toHaveLength(2);
    click(h.querySelector('[data-testid="clear-filters"]'));
    expect(trigger.textContent?.trim()).toBe("Filters");
    expect(h.querySelectorAll("tbody tr[data-order]")).toHaveLength(7);
  });
  it("Export of all rows is a toolbar menu that names its scope; the selection's Export sits in the bar once a row is ticked", () => {
    const h = mount();
    expect(h.querySelector('[data-testid="export-trigger"]')?.getAttribute("aria-label")).toBe("Export. Exports all 7 sales orders in the current filter (nothing is selected)");
    expect(h.querySelector('[data-testid="export-selected-trigger"]')).toBeNull();
    click(h.querySelector('tr[data-order="NF-88213"] [data-testid="select-row"]'));
    expect(h.querySelector('[data-testid="export-selected-trigger"]')?.getAttribute("aria-label")).toBe("Export. Exports the 1 sales order selected");
    expect(h.querySelector('[data-testid="print-selected"]')).not.toBeNull();
  });
  it("each row has exactly one primary action and a More menu naming its order; the header checkbox selects all", () => {
    const h = mount();
    const rows = Array.from(h.querySelectorAll("tbody tr[data-order]"));
    for (const r of rows) {
      expect(r.querySelectorAll('[data-testid="row-primary"]')).toHaveLength(1);
      expect(r.querySelector('[data-testid="row-more"]')?.getAttribute("aria-label")).toBe(`More actions for ${r.getAttribute("data-order")}`);
    }
    expect(h.querySelector('tr[data-order="HP-7710"] [data-testid="row-primary"]')?.textContent).toBe("Convert to Job");
    expect(h.querySelector('tr[data-order="SO-0149"] [data-testid="row-primary"]')?.textContent).toBe("View");
    click(h.querySelector('tr[data-order="SO-0149"] [data-testid="row-primary"]'));
    expect(document.querySelector('[data-testid="dlg-view"]')?.textContent).toContain("SO-0149");
    click(byText(document.body, "dialog button", "Close"));
    click(h.querySelector<HTMLInputElement>('thead input[type="checkbox"]'));
    expect(h.querySelector("[data-selection]")?.textContent).toContain("7 selected of 7 filtered records");
  });
  it("Cards view keeps the same split, and the primary Convert to Job is still a Preview-only toast", () => {
    const h = mount();
    click(h.querySelector('[data-testid="view-cards-btn"]'));
    const card = h.querySelector('article[data-order="HP-7710"]')!;
    expect(card.querySelectorAll('[data-testid="row-primary"]')).toHaveLength(1);
    click(card.querySelector('[data-testid="row-primary"]'));
    expect(document.body.textContent).toContain("A job would be created from sales order HP-7710; carried 2 machines (10.5 h). Nothing was saved.");
  });
  it("a Show count is an em dash while the list loads, never a stale number", () => {
    const h = mount();
    click(byText(document.body, "button", /Preview controls/));
    click(byText(document.body, '[role="dialog"][aria-label="Preview controls"] [aria-pressed]', "Loading"));
    expect(h.querySelector('[data-testid="show-open"]')?.textContent).toMatch(/\(—\)$/);
  });
});
