/**
 * Admin > Data with SliQ's customers and suppliers exports: their exact header rows (as the JNR controller's export gives them), every value made up.
 * Business is the name, Address1 ... Address6 are one address (a line that only repeats the name left out), and the columns Tolra has no
 * place for yet (delivery address, credit limit, VAT, website, payment terms) go into the notes, never dropped and never sent on their own.
 */
import { describe, expect, it } from "vitest";

import { buildImport, partyFields } from "@/lib/import-build";
import { type Cell, type ParsedSheet, chooseTarget, mapColumns, planSheet } from "@/lib/import-detect";
import { parseCsv, sheetFromRows } from "@/lib/import-file";

/** SliQ "customers export": the header row exactly. */
const CUSTOMER_HEADERS = [
  "Account Number", "Business", "Title", "First Name", "Last Name", "Phone", "Mobile", "Email", "Fax", "Use Credit Limit", "Credit Limit",
  "Address1", "Address2", "Address3", "Address4", "Address5", "Address6", "Delivery1", "Delivery2", "Delivery3", "Delivery4", "Delivery5",
  "Delivery6", "Website", "VAT", "Terms (Message)", "Terms (Days)",
];
/** SliQ "suppliers export": the header row exactly. */
const SUPPLIER_HEADERS = [
  "Business", "Title", "First Name", "Last Name", "Phone", "Mobile", "Email", "Fax", "Account Number", "Address1", "Address2", "Address3",
  "Address4", "Address5", "Address6", "Address7", "Delivery1", "Delivery2", "Delivery3", "Delivery4", "Delivery5", "Delivery6", "Website",
  "Bank Account Name", "Bank Sort Code", "Bank Account Number", "Make Payments To", "VAT",
];

/** A made-up customer row in the export's own cell types (the .xlsx gives Use Credit Limit as a boolean, the limit and the days as numbers). */
function customerRow(values: Partial<Record<(typeof CUSTOMER_HEADERS)[number], Cell>>): Cell[] {
  return CUSTOMER_HEADERS.map((h) => values[h] ?? null);
}
const ACME = {
  "Account Number": "101", Business: "Acme Test Engineering Ltd", "First Name": "Pat", "Last Name": "Example", Phone: "01000 000001",
  Email: "pat@acme.example", "Use Credit Limit": false, "Credit Limit": 0,
  Address1: "Acme Test Engineering Ltd", Address2: "1 Test Lane", Address3: "Testville", Address4: "Testshire", Address5: "TE1 1ST",
  Delivery1: "Acme Test Engineering Ltd", Delivery2: "1 Test Lane", Delivery3: "Testville", Delivery4: "Testshire", Delivery5: "TE1 1ST",
  "Terms (Message)": "30 days", "Terms (Days)": 30,
};
const sheet = (name: string, headers: string[], rows: Cell[][]): ParsedSheet => ({ name, headers, rows, rowNumbers: rows.map((_, i) => i + 2) });
const FILE = { name: "customers export.xlsx", sha256: "b".repeat(64) };
const targets = (headers: string[], kind: "customers" | "suppliers") => Object.fromEntries(mapColumns(headers, [], kind, null).map((c) => [c.header, c.target]));

async function customers(rows: Cell[][]) {
  const [plan] = await planSheet(sheet("Customers", CUSTOMER_HEADERS, rows), []);
  return { plan, built: buildImport([plan], FILE) };
}

describe("SliQ customers export: which column is which", () => {
  it("every header that has a place is matched; the rest are offered for mapping", () => {
    expect(targets(CUSTOMER_HEADERS, "customers")).toEqual({
      "Account Number": "external_ref", Business: "name", Title: null, "First Name": null, "Last Name": null, Phone: "phone", Mobile: "mobile",
      Email: "email", Fax: null, "Use Credit Limit": "credit_limit_used", "Credit Limit": "credit_limit",
      Address1: "address", Address2: "address", Address3: "address", Address4: "address", Address5: "address", Address6: "address",
      Delivery1: "delivery_address", Delivery2: "delivery_address", Delivery3: "delivery_address", Delivery4: "delivery_address",
      Delivery5: "delivery_address", Delivery6: "delivery_address",
      Website: "website", VAT: "vat_number", "Terms (Message)": "terms_message", "Terms (Days)": "terms_days",
    });
  });

  it("the six address columns all fill the address: none is set aside as a second match", () => {
    const columns = mapColumns(CUSTOMER_HEADERS, [], "customers", null);
    expect(columns.filter((c) => c.reason === "duplicate")).toEqual([]);
  });

  it("read from a CSV with the export's header row, the sheet is found and its header row is the first line", () => {
    const csv = `${CUSTOMER_HEADERS.join(",")}\n101,Acme Test Engineering Ltd,,,,,,,,False,0,Acme Test Engineering Ltd,1 Test Lane,,,,,,,,,,,,,30 days,30\n`;
    const parsed = sheetFromRows("Customers", parseCsv(csv));
    expect(parsed?.headers).toEqual(CUSTOMER_HEADERS);
    expect(parsed?.rowNumbers).toEqual([2]);
  });
});

describe("SliQ customers export: what is imported", () => {
  it("Business is the name; the address is one line per part, without the line that repeats the name", async () => {
    const { built } = await customers([customerRow(ACME)]);
    expect(built.problems).toEqual([]);
    expect(built.payload.customers).toEqual([{
      row: 2, external_ref: "101", name: "Acme Test Engineering Ltd", phone: "01000 000001", email: "pat@acme.example",
      address: "1 Test Lane\nTestville\nTestshire\nTE1 1ST",
      notes: "Payment terms: 30 days",
    }]);
  });

  it("a delivery address the same as the address, and a credit limit not in use at zero, add nothing", async () => {
    const { built } = await customers([customerRow(ACME)]);
    const notes = String(built.payload.customers?.[0].notes);
    expect(notes).not.toMatch(/Delivery address|Credit limit/);
  });

  it("a different delivery address, a credit limit, the VAT number and the website go into the notes, labelled", async () => {
    const { built } = await customers([customerRow({
      ...ACME, Delivery1: "Acme Test Engineering Ltd", Delivery2: "Unit 9 Yard Road", Delivery3: "Otherton", Delivery4: "OT9 9ZZ", Delivery5: null,
      "Use Credit Limit": true, "Credit Limit": 5000, VAT: "GB 123 4567 89", Website: "www.acme.example",
    })]);
    expect(built.payload.customers?.[0].notes).toBe([
      "Delivery address: Unit 9 Yard Road, Otherton, OT9 9ZZ", "Credit limit: £5000", "VAT number: GB 123 4567 89", "Website: www.acme.example",
      "Payment terms: 30 days",
    ].join("\n"));
  });

  it("the notes-only fields are never sent on their own (076 has no column for them)", async () => {
    const { built } = await customers([customerRow({ ...ACME, VAT: "123456789", Website: "acme.example", "Use Credit Limit": true, "Credit Limit": 100 })]);
    const keys = Object.keys(built.payload.customers?.[0] ?? {});
    for (const key of ["delivery_address", "credit_limit_used", "credit_limit", "vat_number", "website", "terms_days", "terms_message"]) expect(keys).not.toContain(key);
  });

  it("the admin is told where those columns go", async () => {
    const { built } = await customers([customerRow({ ...ACME, VAT: "123456789", Website: "acme.example" })]);
    const notice = built.notices.find((n) => n.message.includes("notes"));
    expect(notice?.message).toBe("Customers: delivery address, credit limit, VAT number, website and payment terms have no place of their own in Tolra yet, so they go into each customer's notes.");
  });

  it("a row with no address and no extras sends neither (nothing empty is written)", async () => {
    const { built } = await customers([customerRow({ "Account Number": "102", Business: "Bare Test Co", "Use Credit Limit": false, "Credit Limit": 0 })]);
    expect(built.payload.customers).toEqual([{ row: 2, external_ref: "102", name: "Bare Test Co" }]);
  });
});

describe("the notes lines (partyFields)", () => {
  it("payment terms: the message, with the days added only when it does not already say them", () => {
    expect(partyFields({ name: "A", terms_message: "30 days", terms_days: "30" }, {}).notes).toBe("Payment terms: 30 days");
    expect(partyFields({ name: "A", terms_message: "Payment on receipt", terms_days: "0" }, {}).notes).toBe("Payment terms: Payment on receipt (0 days)");
    expect(partyFields({ name: "A", terms_days: "45" }, {}).notes).toBe("Payment terms: 45 days");
    expect(partyFields({ name: "A", terms_message: "End of month" }, {}).notes).toBe("Payment terms: End of month");
  });

  it("credit limit: in use, not in use but set, not in use and zero, and in use with no amount", () => {
    expect(partyFields({ name: "A", credit_limit_used: "true", credit_limit: "2500" }, {}).notes).toBe("Credit limit: £2500");
    expect(partyFields({ name: "A", credit_limit_used: "false", credit_limit: "2500" }, {}).notes).toBe("Credit limit: £2500 (not in use)");
    expect(partyFields({ name: "A", credit_limit_used: "false", credit_limit: "0" }, {}).notes).toBeUndefined();
    expect(partyFields({ name: "A", credit_limit_used: "Yes" }, {}).notes).toBe("Credit limit: in use, no amount given");
  });

  it("the file's own notes come first; a name line is matched whatever its case or punctuation", () => {
    const out = partyFields({ name: "Acme Ltd", notes: "Gate code 1234", website: "acme.example" }, { address: ["ACME LTD.", "1 Lane"] });
    expect(out).toEqual({ name: "Acme Ltd", notes: "Gate code 1234\nWebsite: acme.example", address: "1 Lane" });
  });

  it("only a line that is the whole name is left out, not one that contains it", () => {
    expect(partyFields({ name: "Acme" }, { address: ["Acme House", "1 Lane"] }).address).toBe("Acme House\n1 Lane");
  });
});

describe("choosing by hand", () => {
  it("picking the address for one more column keeps the other address columns", async () => {
    const headers = ["Business", "Street", "Town", "Postcode"];
    const [plan] = await planSheet(sheet("Customers", headers, [["Acme", "1 Lane", "Town", "TE1 1ST"]]), []);
    let next = chooseTarget(plan, 1, "address");
    next = chooseTarget(next, 2, "address");
    next = chooseTarget(next, 3, "address");
    expect(next.columns.map((c) => c.target)).toEqual(["name", "address", "address", "address"]);
    expect(buildImport([next], FILE).payload.customers?.[0].address).toBe("1 Lane\nTown\nTE1 1ST");
  });

  it("a field that is not joined still moves to the column picked last", async () => {
    const headers = ["Business", "Phone", "Office"];
    const [plan] = await planSheet(sheet("Customers", headers, [["Acme", "1", "2"]]), []);
    expect(chooseTarget(plan, 2, "phone").columns.map((c) => c.target)).toEqual(["name", null, "phone"]);
  });
});

describe("SliQ suppliers export", () => {
  it("Business, Address1 ... Address7 and the VAT number; the bank columns are left for the admin", () => {
    const t = targets(SUPPLIER_HEADERS, "suppliers");
    expect(t.Business).toBe("name");
    for (let i = 1; i <= 7; i += 1) expect(t[`Address${i}`]).toBe("address");
    expect(t.VAT).toBe("vat_number");
    for (const h of ["Bank Account Name", "Bank Sort Code", "Bank Account Number", "Make Payments To"]) expect(t[h]).toBeNull();
  });

  it("a supplier's joined address goes to 076 as the address (076 writes it into the supplier's notes), its VAT number into the notes", async () => {
    const row = SUPPLIER_HEADERS.map((h) => ({ Business: "Steel Test Supplies", "Account Number": "S1", Address1: "Steel Test Supplies", Address2: "2 Forge Way", Address7: "FO2 2RG", VAT: "987654321" } as Record<string, Cell>)[h] ?? null);
    const [plan] = await planSheet(sheet("Suppliers", SUPPLIER_HEADERS, [row]), []);
    expect(buildImport([plan], { ...FILE, name: "suppliers export.xlsx" }).payload.suppliers).toEqual([
      { row: 2, name: "Steel Test Supplies", external_ref: "S1", address: "2 Forge Way\nFO2 2RG", notes: "VAT number: 987654321" },
    ]);
  });
});
