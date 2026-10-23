/**
 * Admin > Data: which kind a sheet is, and which column is which field (lib/import-detect.ts, lib/import-synonyms.ts, lib/import-columns.ts).
 */
import { describe, expect, it } from "vitest";

import { IMPORT_COLUMNS } from "@/lib/import-columns";
import {
  type ParsedSheet, type SavedMapping, chooseKind, chooseTarget, detectKind, findKindColumn, headerSignature, kindFromWord,
  mapColumns, mappingToSave, missingKeyField, normaliseHeader, peopleColumns, planSheet, unrecognisedColumns,
} from "@/lib/import-detect";
import { FIELD_SYNONYMS } from "@/lib/import-synonyms";
import { IMPORT_KINDS, type ImportKind, targetsFor } from "@/lib/import-targets";

const sheet = (name: string, headers: string[], rows: (string | number | null)[][] = [], numbers?: number[]): ParsedSheet => ({
  name, headers, rows, rowNumbers: numbers ?? rows.map((_, i) => i + 2),
});
const target = (kind: ImportKind, headers: string[], header: string) => mapColumns(headers, [], kind, null).find((c) => c.header === header)?.target;

describe("normaliseHeader", () => {
  it("compares words, not punctuation or case", () => {
    expect(normaliseHeader("Inv No.")).toBe("inv no");
    expect(normaliseHeader("  INV-NO ")).toBe("inv no");
    expect(normaliseHeader("VAT %")).toBe("vat pct");
    expect(normaliseHeader("Quote #")).toBe("quote no");
    expect(normaliseHeader("Terms & Conditions")).toBe("terms and conditions");
  });
});

describe("synonyms", () => {
  it("the agreed examples: Client = Customer, PO Ref = PO number, Inv No = Invoice number", () => {
    expect(target("quotes", ["Client"], "Client")).toBe("customer");
    expect(target("invoices", ["Client"], "Client")).toBe("customer");
    expect(target("customers", ["Client"], "Client")).toBe("name");
    expect(target("purchase_orders", ["PO Ref"], "PO Ref")).toBe("po_ref");
    expect(target("invoices", ["PO Ref"], "PO Ref")).toBe("customer_po"); // an invoice's PO is the customer's
    expect(target("invoices", ["Inv No"], "Inv No")).toBe("invoice_ref");
    expect(target("payments", ["Inv No."], "Inv No.")).toBe("invoice_ref");
  });

  it("no word means two fields of the same kind (the list stays unambiguous)", () => {
    for (const kind of IMPORT_KINDS) {
      const seen = new Map<string, string>();
      for (const [field, words] of Object.entries(FIELD_SYNONYMS[kind])) {
        for (const word of words) {
          const key = normaliseHeader(word).replace(/ /g, "");
          const other = seen.get(key);
          expect(other === undefined || other === field, `${kind}: "${word}" is both ${other} and ${field}`).toBe(true);
          seen.set(key, field);
        }
      }
    }
  });

  it("every synonym names a field that exists for its kind", () => {
    for (const kind of IMPORT_KINDS) {
      const keys = new Set(targetsFor(kind).map((t) => t.key));
      for (const field of Object.keys(FIELD_SYNONYMS[kind])) expect(keys.has(field), `${kind}.${field}`).toBe(true);
    }
  });
});

describe("our own export columns (lib/import-columns.ts)", () => {
  it("every header of every export is understood: it fills a field, or is calculated in Tolra (never unknown)", () => {
    for (const [kind, specs] of Object.entries(IMPORT_COLUMNS)) {
      const headers = specs.map((s) => s.header);
      const columns = mapColumns(headers, [["x"]], kind as ImportKind, null);
      for (const c of columns) expect(c.target !== null || c.reason === "derived", `${kind}: ${c.header}`).toBe(true);
    }
  });

  it("the invoice export's Stored Status fills the status, its page Status does not", () => {
    const headers = IMPORT_COLUMNS.invoices.map((c) => c.header);
    const columns = mapColumns(headers, [], "invoices", null);
    expect(columns.find((c) => c.header === "Stored Status")?.target).toBe("status");
    expect(columns.find((c) => c.header === "Status")?.target).toBeNull();
    expect(columns.find((c) => c.header === "Balance Due")?.reason).toBe("derived");
    expect(columns.find((c) => c.header === "Net")?.target).toBe("subtotal");
    expect(columns.find((c) => c.header === "Invoice No")?.target).toBe("invoice_ref");
  });

  it("each export is recognised as its own kind (customers and suppliers by their sheet name too)", () => {
    for (const [kind, specs] of Object.entries(IMPORT_COLUMNS)) {
      const detected = detectKind({ name: kind.replace("_", " "), headers: specs.map((s) => s.header), rows: [] });
      expect(detected.kind, kind).toBe(kind);
    }
  });
});

describe("detectKind", () => {
  it("recognises a plain invoices sheet by its headers", () => {
    const found = detectKind(sheet("Sheet1", ["Inv No", "Client", "Date", "Due", "Net", "VAT", "Total"]));
    expect(found.kind).toBe("invoices");
  });

  it("a payments sheet is payments, not invoices", () => {
    expect(detectKind(sheet("Sheet1", ["Invoice No", "Paid On", "Amount", "Method", "Reference"])).kind).toBe("payments");
  });

  it("customers and suppliers share their headers, so the sheet's name decides, and without one it is left to the admin", () => {
    const headers = ["Name", "Contact", "Email", "Phone", "Address"];
    expect(detectKind(sheet("Customers", headers)).kind).toBe("customers");
    expect(detectKind(sheet("Suppliers", headers)).kind).toBe("suppliers");
    const unnamed = detectKind(sheet("Sheet1", headers));
    expect(unnamed.kind).toBeNull();
    expect(unnamed.suggestion).not.toBeNull();
  });

  it("a sheet with no match key is not guessed", () => {
    expect(detectKind(sheet("Sheet1", ["Colour", "Weight", "Notes"]))).toEqual({ kind: null, suggestion: null });
  });
});

describe("credit notes and delivery notes (085)", () => {
  it("are recognised by their headers: the number, the invoice credited, the items", () => {
    expect(detectKind(sheet("Credit notes", ["Credit Note No", "Invoice No", "Customer", "Credit Date", "Total"])).kind).toBe("credit_notes");
    expect(detectKind(sheet("Delivery notes", ["DN No", "Customer", "Job No", "Delivery Date", "Signed By", "Qty", "Description"])).kind).toBe("delivery_notes");
    // Its number column decides, also next to an invoice number or a job number (an invoice or job sheet never has one).
    expect(detectKind(sheet("Sheet1", ["DN No", "Customer", "Job No", "Delivery Date", "Qty"])).kind).toBe("delivery_notes");
    expect(detectKind(sheet("Sheet2", ["Credit Note No", "Invoice No", "Customer", "Total"])).kind).toBe("credit_notes");
  });

  it("CRD- / DLN- numbers or the sheet's name only suggest the kind; the admin chooses", async () => {
    const [crd] = await planSheet(sheet("Sheet3", ["Ref", "Customer"], [["CRD-0166", "A"], ["CRD-2166", "B"]]), []);
    expect(crd).toMatchObject({ kind: null, suggestion: "credit_notes" });
    const [dln] = await planSheet(sheet("Sheet4", ["Ref", "Customer"], [["DLN-0001", "A"]]), []);
    expect(dln).toMatchObject({ kind: null, suggestion: "delivery_notes" });
    const [named] = await planSheet(sheet("Credit notes", ["Ref", "Customer"], [["X-1", "A"]]), []);
    expect(named).toMatchObject({ kind: null, suggestion: "credit_notes" });
    // Chosen, its columns are read for that kind.
    expect(chooseKind(crd, "credit_notes", []).columns.map((c) => c.target)).toEqual([null, "customer"]);
  });

  it("the invoice export's Credited column does not make an invoices sheet a credit note sheet", () => {
    expect(detectKind(sheet("Invoices", IMPORT_COLUMNS.invoices.map((c) => c.header), [["INV-0001", "A"]])).kind).toBe("invoices");
  });

  it("a credit note's and a delivery note's lines are read like an invoice's", () => {
    expect(target("credit_notes", ["Credit Note No", "Description", "Qty", "Price"], "Qty")).toBe("lines.quantity");
    expect(target("delivery_notes", ["DN No", "Description", "Qty"], "Description")).toBe("lines.description");
    expect(target("delivery_notes", ["DN No", "Signed By"], "Signed By")).toBe("signed_by");
  });
});

describe("a mixed sheet needs a Kind column", () => {
  const mixed = sheet("Everything", ["Kind", "Name", "Invoice No", "Customer", "Total"], [
    ["Customer", "Acme Ltd", null, null, null],
    ["Invoice", null, "INV-1", "Acme Ltd", 100],
    ["Credit note", null, "CRD-1", "Acme Ltd", 10],
    ["Widget", "??", null, null, null],
  ]);

  it("finds the Kind column", () => {
    expect(findKindColumn(mixed)).toBe(0);
  });

  it("splits the rows by kind, keeping each row's place in the file, and never guesses an unknown Kind", async () => {
    const plans = await planSheet(mixed, []);
    expect(plans.map((p) => p.kind)).toEqual(["customers", "invoices", "credit_notes"]);
    expect(plans[1].rowNumbers).toEqual([3]);
    expect(plans[0].unplaced).toEqual([{ row: 5, value: "Widget" }]);
    // The Kind column itself is not a field.
    expect(plans[1].columns.find((c) => c.header === "Kind")?.reason).toBe("kind");
  });

  it("our payments export's Type column (Payment or Reversal) is not a Kind column", () => {
    const payments = sheet("Payments", ["Invoice No", "Paid On", "Amount", "Type"], [["INV-1", "2026-10-01", 5, "Payment"], ["INV-1", "2026-10-02", -5, "Reversal"]]);
    expect(findKindColumn(payments)).toBeNull();
  });
});

describe("kindFromWord", () => {
  it("reads singular, plural and short forms", () => {
    expect(kindFromWord("Invoices")).toBe("invoices");
    expect(kindFromWord("po")).toBe("purchase_orders");
    expect(kindFromWord("Credit Note")).toBe("credit_notes");
    expect(kindFromWord("nonsense")).toBeNull();
  });
});

describe("saved mappings come first", () => {
  const headers = ["Ref", "Who", "Gross"];
  it("a layout saved for a kind fixes the kind and the columns, over the synonyms", async () => {
    const signature = await headerSignature(headers);
    const saved: SavedMapping[] = [{ kind: "invoices", header_signature: signature, mapping: { ref: "invoice_ref", who: "customer", gross: "" } }];
    const [plan] = await planSheet(sheet("Sheet1", headers), saved);
    expect(plan.kind).toBe("invoices");
    expect(plan.kindSource).toBe("saved");
    expect(plan.columns.map((c) => c.target)).toEqual(["invoice_ref", "customer", null]);
    // "Gross" was saved as ignore: it is not offered again.
    expect(unrecognisedColumns(plan)).toHaveLength(0);
  });

  it("the layout does not depend on the order of the columns or the case of a header", async () => {
    expect(await headerSignature(["Ref", "Who", "Gross"])).toBe(await headerSignature(["gross", "REF", "who"]));
    expect(await headerSignature(["Ref", "Who"])).not.toBe(await headerSignature(["Ref", "Who", "Gross"]));
  });
});

describe("headers nobody recognised, and people columns", () => {
  const headers = ["Invoice No", "Customer", "Total", "Weird Column", "Delivery note signed by"];
  const rows = [["INV-1", "Acme", 10, "x", "Jo"]];

  it("are offered for mapping, and a chosen target is kept as the admin's choice", async () => {
    const [plan] = await planSheet(sheet("Invoices", headers, rows), []);
    expect(plan.kind).toBe("invoices");
    expect(unrecognisedColumns(plan).map((c) => c.header)).toEqual(["Weird Column"]);
    const chosen = chooseTarget(plan, 3, "description");
    expect(chosen.columns[3]).toMatchObject({ target: "description", source: "manual" });
    expect(mappingToSave(chosen)).toEqual({ "invoice no": "invoice_ref", customer: "customer", total: "total", "weird column": "description", "delivery note signed by": "" });
  });

  it("nothing is saved when the admin chose nothing", async () => {
    const [plan] = await planSheet(sheet("Invoices", headers, rows), []);
    expect(mappingToSave(plan)).toBeNull();
  });

  it("a person of another kind of document is reported, not imported; a sheet's own person is its field (085)", async () => {
    const [plan] = await planSheet(sheet("Invoices", headers, rows), []);
    expect(peopleColumns(plan).map((c) => [c.header, c.detail])).toEqual([["Delivery note signed by", "Delivery note signed by"]]);
    expect(plan.columns[4].target).toBeNull();
    expect(target("invoices", ["Invoice No", "Invoice sent by"], "Invoice sent by")).toBe("sent_by");
    expect(target("purchase_orders", ["PO Number", "PO sent by"], "PO sent by")).toBe("sent_by");
    expect(target("purchase_orders", ["PO Number", "Sent by"], "Sent by")).toBe("sent_by");
  });

  it("the contact person is a field of customers (free text), not a person column", () => {
    expect(target("customers", ["Contact"], "Contact")).toBe("contact_name");
    expect(target("suppliers", ["Contact Person"], "Contact Person")).toBe("contact_name");
  });
});

describe("choosing by hand", () => {
  it("a sheet nothing could place stays unchosen until the admin picks, then reads its columns for that kind", async () => {
    const [plan] = await planSheet(sheet("Sheet1", ["Name", "Email"], [["Acme", "a@b.c"]]), []);
    expect(plan.kind).toBeNull();
    const chosen = chooseKind(plan, "suppliers", []);
    expect(chosen.kind).toBe("suppliers");
    expect(chosen.columns.map((c) => c.target)).toEqual(["name", "email"]);
    expect(mappingToSave(chosen)).toEqual({ name: "name", email: "email" });
  });

  it("says when the match key has no column", async () => {
    const [plan] = await planSheet(sheet("Invoices", ["Customer", "Total", "Invoice date"], [["A", 1, "2026-01-01"]]), []);
    const forced = chooseKind(plan, "invoices", []);
    expect(missingKeyField(forced)).toBe("Invoice number");
  });
});

describe("a bare Description on a sheet with quantity and price is the line's", () => {
  it("invoices", () => {
    const columns = mapColumns(["Invoice No", "Customer", "Description", "Qty", "Unit Price"], [], "invoices", null);
    expect(columns.map((c) => c.target)).toEqual(["invoice_ref", "customer", "lines.description", "lines.quantity", "lines.unit_price"]);
  });
  it("and the invoice's own without them", () => {
    expect(mapColumns(["Invoice No", "Description"], [], "invoices", null)[1].target).toBe("description");
  });
});
