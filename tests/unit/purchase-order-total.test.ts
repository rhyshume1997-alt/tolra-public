/**
 * The PO list shows the VAT-inclusive total (a £50 ex VAT PO with 20% VAT is £60), the same figure the printed PO and the year-end
 * export work out. total_value stays ex VAT in the database and in the list export's Net column.
 */
import { describe, expect, it } from "vitest";

import { PURCHASE_ORDER_COLUMNS } from "@/lib/import-columns";
import { COLUMN_TABLES } from "@/lib/org-settings";
import { PO_TOTAL_LABEL, purchaseOrderTotalIncVat } from "@/lib/purchase-order-total";
import { purchaseOrderExportTotals } from "@/lib/year-end-export";

const vat = { registered: true, standardRate: 20 };
const line = { description: "Bar", qty: 1, unit_price: 50 };

describe("purchaseOrderTotalIncVat", () => {
  it("adds VAT to the ex VAT value when the PO has VAT on (50 -> 60)", () => {
    expect(purchaseOrderTotalIncVat({ value: 50, vatEnabled: true, items: [line] }, vat)).toBe(60);
  });

  it("is the ex VAT value when VAT is off, or the company is not VAT registered", () => {
    expect(purchaseOrderTotalIncVat({ value: 50, vatEnabled: false, items: [line] }, vat)).toBe(50);
    expect(purchaseOrderTotalIncVat({ value: 50, vatEnabled: true, items: [line] }, { registered: false, standardRate: 20 })).toBe(50);
  });

  it("uses each line's own rate, exempt lines, and the company rate for lines with none", () => {
    const items = [{ ...line, vat_pct: 5 }, { description: "Exempt", qty: 2, unit_price: 10, vat_exempt: true }, { description: "Std", qty: 1, unit_price: 100 }];
    expect(purchaseOrderTotalIncVat({ value: 170, vatEnabled: true, items }, vat)).toBe(192.5);
  });

  it("a PO with no saved lines is one line for the stored value", () => {
    expect(purchaseOrderTotalIncVat({ value: 50, vatEnabled: true }, vat)).toBe(60);
    expect(purchaseOrderTotalIncVat({ value: 50, vatEnabled: true, items: [] }, vat)).toBe(60);
  });

  it("matches the year-end export's gross for the same PO", () => {
    const row = { po_ref: "PO-1", supplier: "S", total_value: 50, vat_enabled: true, items: [{ ...line, vat_pct: 20 }] };
    const company = { vatRegistered: true, defaultVatRate: 20 };
    expect(purchaseOrderTotalIncVat({ value: 50, vatEnabled: true, items: row.items }, vat)).toBe(purchaseOrderExportTotals(row, company).gross);
  });
});

describe("the column", () => {
  it("is labelled Total (inc VAT) in the list and in the column chooser", () => {
    expect(PO_TOTAL_LABEL).toBe("Total (inc VAT)");
    const po = COLUMN_TABLES.find((page) => page.key === "purchase-orders")!;
    expect(po.columns.find((column) => column.key === "value")!.label).toBe(PO_TOTAL_LABEL);
  });

  it("the list export keeps its Net column on the ex VAT value", () => {
    const net = PURCHASE_ORDER_COLUMNS.find((column) => column.key === "net")!;
    expect(net.header).toBe("Net");
    expect(net.value({ ref: "PO-1", value: 50, vatEnabled: true } as never)).toBe(50);
  });
});
