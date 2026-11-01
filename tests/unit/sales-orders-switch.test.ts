import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { acceptOutcome, type AcceptQuoteResult } from "@/lib/accept-quote";
import { canOpenDestination } from "@/lib/destinations";
import { isNavHidden, NAV_TOGGLES } from "@/lib/org-settings";
import { isSalesOrdersPath, SALES_ORDERS_ON_MARKER, salesOrdersEnabled, salesOrdersSwitchChange } from "@/lib/sales-orders-switch";

const base: AcceptQuoteResult = {
  quote_id: "q1", quote_ref: "QUO-0101", accepted: true, so_id: "s1", so_number: "SO-0007", so_created: true, provisional: true,
  job_id: "j1", job_no: "J-0101", job_created: true, auto_convert: true, needs: null, reason: null, job_reason: null,
};
const office = (hiddenNav?: string[]) => ({ activeRole: "office" as const, hiddenSections: [] as string[], hiddenNav });

describe("Sales Orders is off by default", () => {
  it("is off for an empty, missing or unrelated menu list (a new company, John)", () => {
    expect(salesOrdersEnabled([])).toBe(false);
    expect(salesOrdersEnabled(undefined)).toBe(false);
    expect(salesOrdersEnabled(null)).toBe(false);
    expect(salesOrdersEnabled(["customers"])).toBe(false);
  });

  it("the menu item and every Sales Orders page are not offered, for admin and office, even with no settings passed", () => {
    for (const hiddenNav of [[], undefined, ["customers"]] as (string[] | undefined)[]) {
      for (const activeRole of ["admin", "office"] as const) {
        for (const href of ["/sales-orders", "/sales-orders/abc/print", "/sales-orders?filter=open"]) {
          expect(canOpenDestination(href, { activeRole, hiddenSections: [], hiddenNav }), `${activeRole} ${href}`).toBe(false);
        }
      }
    }
    expect(isNavHidden({ hiddenNav: [] }, "/sales-orders")).toBe(true);
  });

  it("other menu items are unaffected by the default", () => {
    for (const href of ["/quotes", "/jobs", "/invoices", "/delivery-notes", "/customers"]) expect(canOpenDestination(href, office([])), href).toBe(true);
    expect(isNavHidden({ hiddenNav: [] }, "/quotes")).toBe(false);
  });
});

describe("Sales Orders switched on", () => {
  const on = [SALES_ORDERS_ON_MARKER];

  it("opens everything as before", () => {
    expect(salesOrdersEnabled(on)).toBe(true);
    expect(canOpenDestination("/sales-orders", office(on))).toBe(true);
    expect(canOpenDestination("/sales-orders/abc/print", office(on))).toBe(true);
    expect(isNavHidden({ hiddenNav: on }, "/sales-orders")).toBe(false);
  });

  it("still follows the role and the per-person page access", () => {
    expect(canOpenDestination("/sales-orders", { activeRole: "workshop", hiddenSections: [], hiddenNav: on })).toBe(false);
    expect(canOpenDestination("/sales-orders", { activeRole: "office", hiddenSections: ["sales-orders"], hiddenNav: on })).toBe(false);
  });

  it("an old plain hide of the item still wins", () => {
    expect(salesOrdersEnabled([SALES_ORDERS_ON_MARKER, "sales-orders"])).toBe(false);
  });

  it("the switch change adds the marker (and clears the old hide), or removes it", () => {
    expect(salesOrdersSwitchChange(true)).toEqual({ add: [SALES_ORDERS_ON_MARKER], remove: ["sales-orders"] });
    expect(salesOrdersSwitchChange(false)).toEqual({ add: [], remove: [SALES_ORDERS_ON_MARKER] });
  });

  it("is still one of the Menu Sections toggles", () => {
    expect(NAV_TOGGLES.find((item) => item.key === "sales-orders")).toMatchObject({ href: "/sales-orders", label: "Sales Orders" });
  });
});

describe("isSalesOrdersPath", () => {
  it("matches the list and its sub-pages only", () => {
    expect(isSalesOrdersPath("/sales-orders")).toBe(true);
    expect(isSalesOrdersPath("/sales-orders/1/print")).toBe(true);
    expect(isSalesOrdersPath("/sales-orders#x")).toBe(true);
    expect(isSalesOrdersPath("/sales-orders-archive")).toBe(false);
    expect(isSalesOrdersPath("/quotes")).toBe(false);
  });
});

describe("the page guard", () => {
  it("wraps the list and the print page through one layout, and redirects to /quotes with a notice once settings have loaded", () => {
    const layout = readFileSync("app/(dashboard)/sales-orders/layout.tsx", "utf8");
    expect(layout).toContain("SalesOrdersGate");
    const gate = readFileSync("components/sales-orders-gate.tsx", "utf8");
    expect(gate).toContain('router.replace("/quotes")');
    expect(gate).toContain("toast.info(SALES_ORDERS_OFF_NOTICE)");
    expect(gate).toMatch(/const off = loaded && !on;/);
  });
});

describe("accepting a quote with Sales Orders off", () => {
  it("job made: says the job only, links to the job, never to Sales Orders", () => {
    const told = acceptOutcome(base, "QUO-0101", false);
    expect(told.message).toBe("QUO-0101 accepted. Job J-0101 made, not started. Its customer PO can be added once Sales Orders is switched on.");
    expect(told.link).toEqual({ label: "Open job J-0101", href: "/jobs?job=j1" });
    expect(told.message).not.toMatch(/sales order SO/i);
  });

  it("with the PO known, no PO note", () => {
    expect(acceptOutcome({ ...base, provisional: false }, "QUO-0101", false).message).toBe("QUO-0101 accepted. Job J-0101 made, not started.");
  });

  it("a quote one order can't hold: accepted, tells the admin to switch Sales Orders on, no link to a screen nobody can open", () => {
    const reason = "That quote has lines at different VAT rates. A sales order holds one VAT rate.";
    const told = acceptOutcome({ ...base, so_id: null, so_number: null, so_created: false, provisional: false, job_id: null, job_no: null, job_created: false, needs: "sales_order_by_hand", reason }, "QUO-0101", false);
    expect(told.tone).toBe("warning");
    expect(told.link).toBeNull();
    expect(told.message).toBe(`QUO-0101 accepted, but its order has to be entered by hand. ${reason} An admin needs to switch Sales Orders on in Settings > Menu first.`);
  });

  it("jobs made by hand: no dead end, says how to carry on", () => {
    const told = acceptOutcome({ ...base, job_id: null, job_no: null, job_created: false, auto_convert: false, provisional: false }, "QUO-0101", false);
    expect(told.link).toBeNull();
    expect(told.message).toContain("An admin needs to switch Sales Orders on in Settings > Menu first.");
  });

  it("the job couldn't be made: database reason kept, with the same hint", () => {
    const told = acceptOutcome({ ...base, job_id: null, job_no: null, job_created: false, job_reason: "Use Convert to Job on the order." }, "QUO-0101", false);
    expect(told.message).toBe("QUO-0101 accepted, but its job was not made. Use Convert to Job on the order. An admin needs to switch Sales Orders on in Settings > Menu first.");
    expect(told.link).toBeNull();
  });

  it("already accepted keeps the job link and hides the order number", () => {
    const told = acceptOutcome({ ...base, accepted: false }, "QUO-0101", false);
    expect(told.message).toBe("QUO-0101 was already accepted: it has job J-0101. Nothing was changed.");
    expect(told.link).toEqual({ label: "Open job J-0101", href: "/jobs?job=j1" });
  });

  it("on (the default argument) is exactly as before", () => {
    expect(acceptOutcome(base).message).toBe("QUO-0101 accepted. Sales order SO-0007 created (a provisional number: add the customer's PO on Sales Orders when it arrives) and job J-0101 made, not started.");
    expect(acceptOutcome({ ...base, job_id: null, job_no: null, auto_convert: false }).link).toEqual({ label: "Open Sales Orders", href: "/sales-orders" });
  });
});
