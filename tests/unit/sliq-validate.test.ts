import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseDate, parsePence, validateSliqExportWith, type SliqMapping, type SourceFiles, type ValidateInput } from "../../lib/sliq-validate";

const nodeSha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const validateSliqExport = (input: ValidateInput) => validateSliqExportWith(input, nodeSha);

const enc = (s: string) => new TextEncoder().encode(s);

const MAPPING: SliqMapping = {
  version: 1,
  confirmed: true,
  dateFormat: "DD/MM/YYYY",
  entities: {
    customers: { file: "customers.csv", columns: { key: "Code", name: "Name" } },
    suppliers: { file: "suppliers.csv", columns: { key: "Code", name: "Name" } },
    invoices: { file: "invoices.csv", columns: { ref: "Inv", customerKey: "Cust", date: "Date", gross: "Gross", net: "Net", vat: "VAT" } },
    payments: { file: "payments.csv", columns: { invoiceRef: "Inv", date: "Date", amount: "Amount" } },
  },
};

const CUSTOMERS = "Code,Name\nC1,Acme\nC2,Beta\n";
const SUPPLIERS = "Code,Name\nS1,Steel Co\n";
const INVOICES = "Inv,Cust,Date,Net,VAT,Gross\nS1001,C1,01/03/2026,100.00,20.00,120.00\nS1002,C2,02/03/2026,500.00,100.00,600.00\n";
// One date with a day above 12, so DD/MM/YYYY is not ambiguous for the base set (the ambiguous case has its own tests).
const PAYMENTS = "Inv,Date,Amount\nS1001,05/03/2026,120.00\nS1002,15/03/2026,100.00\n";

function files(over: Partial<Record<"customers" | "suppliers" | "invoices" | "payments", string | Uint8Array>> = {}): SourceFiles {
  const pick = (k: keyof typeof over, def: string) => {
    const v = over[k] ?? def;
    return typeof v === "string" ? enc(v) : v;
  };
  return {
    customers: { name: "customers.csv", bytes: pick("customers", CUSTOMERS) },
    suppliers: { name: "suppliers.csv", bytes: pick("suppliers", SUPPLIERS) },
    invoices: { name: "invoices.csv", bytes: pick("invoices", INVOICES) },
    payments: { name: "payments.csv", bytes: pick("payments", PAYMENTS) },
  };
}

const run = (over: Parameters<typeof files>[0] = {}, mapping: unknown = MAPPING) => validateSliqExport({ files: files(over), mapping });
const reasons = (r: ReturnType<typeof run>) => r.errors.map((e) => `${e.file}:${e.row}:${e.field}:${e.reason}`);

describe("valid set", () => {
  it("is ok with hashes, row counts and integer-pence totals", () => {
    const r = run();
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.mappingConfirmed).toBe(true);
    const t = r.totals.entities;
    expect(t.customers?.rows).toBe(2);
    expect(t.suppliers?.rows).toBe(1);
    expect(t.invoices?.rows).toBe(2);
    expect(t.payments?.rows).toBe(2);
    expect(t.invoices?.moneyPence).toEqual({ gross: 72000, net: 60000, vat: 12000 });
    expect(t.payments?.moneyPence).toEqual({ amount: 22000 });
    expect(t.invoices?.sha256).toBe(createHash("sha256").update(INVOICES).digest("hex"));
    expect(t.invoices?.bytes).toBe(enc(INVOICES).length);
    expect(t.customers).toMatchObject({ encoding: "utf-8", bom: false, delimiter: ",", lineEnding: "LF" });
  });
});

describe("mapping must be explicit and confirmed", () => {
  it("is never ok when confirmed is false", () => {
    const r = run({}, { ...MAPPING, confirmed: false });
    expect(r.ok).toBe(false);
    expect(r.mappingConfirmed).toBe(false);
    expect(reasons(r).join()).toContain("mapping.confirmed must be true");
  });
  it("refuses a missing version, a missing/invalid date format, and non-objects", () => {
    expect(run({}, { ...MAPPING, version: undefined }).ok).toBe(false);
    expect(run({}, { ...MAPPING, dateFormat: undefined }).ok).toBe(false);
    expect(run({}, { ...MAPPING, dateFormat: "D/M/Y" }).ok).toBe(false);
    expect(run({}, null).ok).toBe(false);
    expect(run({}, "x").ok).toBe(false);
  });
  it("refuses an entity or required column missing from the mapping", () => {
    const m = structuredClone(MAPPING) as unknown as { entities: Record<string, { columns: Record<string, string> }> };
    delete m.entities.payments.columns.amount;
    expect(reasons(run({}, m)).join()).toContain("mapping.entities.payments.columns.amount is required");
    const m2 = structuredClone(MAPPING) as unknown as { entities: Record<string, unknown> };
    delete m2.entities.suppliers;
    expect(run({}, m2).ok).toBe(false);
  });
  it("refuses an unknown field and a bad invoiceRefPattern", () => {
    const m = structuredClone(MAPPING) as unknown as { entities: Record<string, { columns: Record<string, string> }> };
    m.entities.customers.columns.bogus = "X";
    expect(reasons(run({}, m)).join()).toContain("not a known field");
    expect(run({}, { ...MAPPING, invoiceRefPattern: "(" }).ok).toBe(false);
  });
  it("true is the only accepted confirmed value", () => {
    expect(run({}, { ...MAPPING, confirmed: "true" }).ok).toBe(false);
    expect(run({}, { ...MAPPING, confirmed: 1 }).ok).toBe(false);
  });
});

describe("encoding, BOM, delimiter, line endings", () => {
  it("accepts a UTF-8 BOM and strips it from the header", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc(CUSTOMERS)]);
    const r = run({ customers: bom });
    expect(r.ok).toBe(true);
    expect(r.totals.entities.customers).toMatchObject({ bom: true, encoding: "utf-8" });
  });
  it("accepts CRLF and reports it", () => {
    const r = run({ invoices: INVOICES.replace(/\n/g, "\r\n") });
    expect(r.ok).toBe(true);
    expect(r.totals.entities.invoices?.lineEnding).toBe("CRLF");
  });
  it("accepts CR-only and a missing final newline", () => {
    expect(run({ customers: "Code,Name\rC1,Acme\rC2,Beta" }).ok).toBe(true);
  });
  it("detects semicolon and tab delimiters", () => {
    const semi = run({ customers: "Code;Name\nC1;Acme\nC2;Beta\n" });
    expect(semi.ok).toBe(true);
    expect(semi.totals.entities.customers?.delimiter).toBe(";");
    const tab = run({ customers: "Code\tName\nC1\tAcme\nC2\tBeta\n" });
    expect(tab.totals.entities.customers?.delimiter).toBe("\t");
  });
  it("errors when the mapping's delimiter disagrees with the file", () => {
    const r = run({}, { ...MAPPING, delimiter: ";" });
    expect(r.ok).toBe(false);
  });
  it("errors when the header has no detectable delimiter", () => {
    expect(reasons(run({ customers: "CodeName\nC1\n" })).join()).toContain("cannot detect a single delimiter");
  });
  it("decodes Windows-1252 (e-acute byte 0xE9) and flags a mismatch with a stated encoding", () => {
    const bytes = new Uint8Array([...enc("Code,Name\nC2,Beta\nC1,Caf"), 0xe9, ...enc("\n")]);
    const r = run({ customers: bytes });
    expect(r.ok).toBe(true);
    expect(r.totals.entities.customers?.encoding).toBe("windows-1252");
    expect(run({ customers: bytes }, { ...MAPPING, encoding: "utf-8" }).ok).toBe(false);
  });
  it("decodes UTF-16 LE with BOM", () => {
    const text = CUSTOMERS;
    const b = new Uint8Array(2 + text.length * 2);
    b[0] = 0xff;
    b[1] = 0xfe;
    for (let i = 0; i < text.length; i++) b[2 + i * 2] = text.charCodeAt(i);
    const r = run({ customers: b });
    expect(r.ok).toBe(true);
    expect(r.totals.entities.customers?.encoding).toBe("utf-16le");
  });
  it("refuses UTF-16 BE and an empty file", () => {
    expect(run({ customers: new Uint8Array([0xfe, 0xff, 0, 65]) }).ok).toBe(false);
    expect(reasons(run({ customers: new Uint8Array() })).join()).toContain("file is empty");
  });
  it("handles quoted fields with commas, doubled quotes and embedded newlines", () => {
    const r = run({ customers: 'Code,Name\nC1,"Acme, ""Ltd""\nSecond line"\nC2,Beta\n' });
    expect(r.ok).toBe(true);
    expect(r.totals.entities.customers?.rows).toBe(2);
  });
  it("reports an unterminated quote", () => {
    expect(reasons(run({ customers: 'Code,Name\nC1,"Acme\n' })).join()).toContain("unterminated quoted field");
  });
});

describe("required columns and shape", () => {
  it("names each missing required column", () => {
    const r = run({ invoices: "Inv,Cust,Date,Net,VAT\nS1001,C1,01/03/2026,1.00,0.20\n" });
    expect(r.ok).toBe(false);
    expect(r.errors).toContainEqual({ file: "invoices.csv", row: 1, field: "gross", reason: 'required column "Gross" is not in the header' });
  });
  it("is exact about header names (no guessing)", () => {
    expect(run({ customers: "code,name\nC1,Acme\n" }).ok).toBe(false);
  });
  it("rejects a duplicated header column", () => {
    expect(run({ customers: "Code,Name,Name\nC1,A,B\n" }).ok).toBe(false);
  });
  it("rejects a ragged row", () => {
    const r = run({ customers: "Code,Name\nC1,Acme\nC2\n" });
    expect(r.errors).toContainEqual({ file: "customers.csv", row: 3, field: null, reason: "row has 1 fields but the header has 2" });
  });
  it("rejects a missing file and a wrong file name", () => {
    const f = files();
    delete f.payments;
    expect(reasons(validateSliqExport({ files: f, mapping: MAPPING })).join()).toContain("file for payments was not supplied");
    f.payments = { name: "pay.csv", bytes: enc(PAYMENTS) };
    expect(reasons(validateSliqExport({ files: f, mapping: MAPPING })).join()).toContain("does not match the mapping");
  });
  it("rejects blank required values", () => {
    const r = run({ customers: "Code,Name\nC1,\n" });
    expect(r.errors).toContainEqual({ file: "customers.csv", row: 2, field: "name", reason: "required value is blank" });
  });
});

describe("duplicates", () => {
  it("rejects duplicate customer keys", () => {
    const r = run({ customers: "Code,Name\nC1,Acme\nC1,Other\nC2,Beta\n" });
    expect(r.errors).toContainEqual({ file: "customers.csv", row: 3, field: "key", reason: 'duplicate key "C1" (first at row 2)' });
  });
  it("rejects duplicate supplier keys", () => {
    expect(run({ suppliers: "Code,Name\nS1,A\nS1,B\n" }).ok).toBe(false);
  });
  it("rejects duplicate invoice refs, case-insensitively", () => {
    const r = run({ invoices: INVOICES + "s1001,C1,03/03/2026,1.00,0.20,1.20\n" });
    expect(r.ok).toBe(false);
    expect(reasons(r).join()).toContain("duplicate ref");
  });
  it("rejects an exact duplicate payment row", () => {
    const r = run({ payments: PAYMENTS + "S1002,15/03/2026,100.00\n" });
    expect(reasons(r).join()).toContain("duplicate payment row");
  });
  it("uses a mapped payment key for duplicates instead of the whole-row rule", () => {
    const m = structuredClone(MAPPING);
    m.entities.payments.columns.key = "Ref";
    const p = "Inv,Date,Amount,Ref\nS1002,15/03/2026,100.00,R1\nS1002,15/03/2026,100.00,R2\n";
    expect(run({ payments: p }, m).ok).toBe(true);
    expect(run({ payments: p.replace("R2", "R1") }, m).ok).toBe(false);
  });
});

describe("dates", () => {
  it("rejects a date in another format", () => {
    const r = run({ invoices: INVOICES.replace("01/03/2026", "2026-03-01") });
    expect(r.errors).toContainEqual({ file: "invoices.csv", row: 2, field: "date", reason: 'date "2026-03-01" does not match DD/MM/YYYY' });
  });
  it("rejects an impossible calendar date, accepts a leap day", () => {
    expect(reasons(run({ invoices: INVOICES.replace("01/03/2026", "31/02/2026") })).join()).toContain("not a real calendar date");
    expect(run({ invoices: INVOICES.replace("01/03/2026", "29/02/2028") }).ok).toBe(true);
    expect(run({ invoices: INVOICES.replace("01/03/2026", "29/02/2026") }).ok).toBe(false);
  });
  it("is day-first or month-first only as the mapping says", () => {
    expect(parseDate("13/01/2026", "DD/MM/YYYY")).toEqual({ ok: true, value: "2026-01-13" });
    expect(parseDate("13/01/2026", "MM/DD/YYYY").ok).toBe(false);
    expect(parseDate("01/13/2026", "MM/DD/YYYY")).toEqual({ ok: true, value: "2026-01-13" });
    expect(parseDate("2026-01-13", "YYYY-MM-DD")).toEqual({ ok: true, value: "2026-01-13" });
  });
  it("validates payment dates too", () => {
    expect(run({ payments: PAYMENTS.replace("05/03/2026", "99/03/2026") }).ok).toBe(false);
  });
});

describe("money as integer pence", () => {
  it("parses exactly with no float drift", () => {
    expect(parsePence("0.1")).toEqual({ ok: true, value: 10 });
    expect(parsePence("0.2")).toEqual({ ok: true, value: 20 });
    expect(parsePence("0.30")).toEqual({ ok: true, value: 30 });
    expect(parsePence("1,234.50")).toEqual({ ok: true, value: 123450 });
    expect(parsePence("£12.5")).toEqual({ ok: true, value: 1250 });
    expect(parsePence("(5.00)")).toEqual({ ok: true, value: -500 });
    expect(parsePence("-0.07")).toEqual({ ok: true, value: -7 });
    expect(parsePence("19.99")).toEqual({ ok: true, value: 1999 });
    expect(parsePence("1.005").ok).toBe(false);
    expect(parsePence("1,234").ok).toBe(false);
    expect(parsePence("1.234,50").ok).toBe(false);
    expect(parsePence("1e3").ok).toBe(false);
    expect(parsePence("").ok).toBe(false);
    expect(parsePence("12abc").ok).toBe(false);
    expect(parsePence("9999999999999999").ok).toBe(false);
  });
  it("0.1 + 0.2 paid against a 0.30 invoice is exactly 30 pence and passes", () => {
    const r = run({ invoices: "Inv,Cust,Date,Net,VAT,Gross\nS1001,C1,01/03/2026,0.25,0.05,0.30\n", payments: "Inv,Date,Amount\nS1001,05/03/2026,0.1\nS1001,16/03/2026,0.2\n" });
    expect(r.errors).toEqual([]);
    expect(r.totals.entities.payments?.moneyPence.amount).toBe(30);
    expect(r.totals.entities.invoices?.moneyPence.gross).toBe(30);
  });
  it("refuses sub-penny amounts instead of rounding", () => {
    const r = run({ invoices: INVOICES.replace("120.00", "120.005") });
    expect(reasons(r).join()).toContain("more than two decimal places");
  });
  it("rejects net + vat not equal to gross by one penny", () => {
    const r = run({ invoices: INVOICES.replace("20.00,120.00", "20.00,120.01") });
    expect(reasons(r).join()).toContain("does not equal gross");
  });
  it("rejects negative invoices and non-positive payments", () => {
    expect(run({ invoices: "Inv,Cust,Date,Net,VAT,Gross\nS1001,C1,01/03/2026,-1.00,-0.20,-1.20\n", payments: "Inv,Date,Amount\n" }).ok).toBe(false);
    expect(run({ payments: PAYMENTS.replace("120.00", "0.00") }).ok).toBe(false);
    expect(run({ payments: PAYMENTS.replace("120.00", "-1.00") }).ok).toBe(false);
  });
  it("sums many penny values exactly", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => `S${2000 + i},C1,01/03/2026,0.10,0.00,0.10`).join("\n");
    const r = run({ invoices: `Inv,Cust,Date,Net,VAT,Gross\n${rows}\n`, payments: "Inv,Date,Amount\n" });
    expect(r.totals.entities.invoices?.moneyPence.gross).toBe(10000);
  });
});

describe("cross-file checks", () => {
  it("rejects a payment for an invoice not in the file", () => {
    const r = run({ payments: PAYMENTS + "S9999,11/03/2026,1.00\n" });
    expect(r.errors).toContainEqual({ file: "payments.csv", row: 4, field: "invoiceRef", reason: 'payment references invoice "S9999" which is not in the invoices file' });
  });
  it("accepts payments up to exactly the invoice total, rejects over", () => {
    const ok = run({ payments: "Inv,Date,Amount\nS1002,10/03/2026,300.00\nS1002,13/03/2026,300.00\n" });
    expect(ok.ok).toBe(true);
    const over = run({ payments: "Inv,Date,Amount\nS1002,10/03/2026,300.00\nS1002,13/03/2026,300.01\n" });
    expect(over.errors).toContainEqual({
      file: "payments.csv",
      row: 3,
      field: "amount",
      reason: 'payments for invoice "S1002" total 60001 pence, more than the invoice total 60000 pence',
    });
  });
  it("rejects an invoice for a customer not in the customers file", () => {
    expect(reasons(run({ invoices: INVOICES + "S1003,C9,03/03/2026,1.00,0.20,1.20\n" })).join()).toContain('customer "C9" is not in the customers file');
  });
});

describe("invoice ref format", () => {
  it("rejects a ref with a different prefix from the rest", () => {
    const r = run({ invoices: INVOICES + "X1003,C1,03/03/2026,1.00,0.20,1.20\n" });
    expect(reasons(r).join()).toContain('has prefix "X" but most refs use "S"');
  });
  it("rejects a ref that is not prefix + digits", () => {
    expect(reasons(run({ invoices: INVOICES + "S10-03,C1,03/03/2026,1.00,0.20,1.20\n" })).join()).toContain("not a prefix followed by digits");
  });
  it("uses a confirmed pattern when the mapping gives one", () => {
    const m = { ...MAPPING, invoiceRefPattern: "S\\d{4}" };
    expect(run({}, m).ok).toBe(true);
    expect(run({ invoices: INVOICES + "S10031,C1,03/03/2026,1.00,0.20,1.20\n" }, m).ok).toBe(false);
  });
});

describe("review D1 fixes (validate)", () => {
  it("normalises the payment duplicate key: 10 and 10.00, 5/3/2026 and 05/03/2026 are the same payment", () => {
    const r = run({ payments: "Inv,Date,Amount\nS1002,15/03/2026,100\nS1002,15/3/2026,100.00\n" });
    expect(reasons(r).join()).toContain("duplicate payment row");
  });
  it("refuses customer keys that differ only in case, and two accounts with the same name as Tolra matches names", () => {
    expect(reasons(run({ customers: "Code,Name\nC1,Acme\nc1,Other\nC2,Beta\n" })).join()).toContain('duplicate key "c1"');
    expect(reasons(run({ customers: "Code,Name\nC1,Acme Limited\nC2,ACME Ltd.\n" })).join()).toContain('duplicate name "ACME Ltd."');
  });
  it("an all-ambiguous date set needs a signed-off example that reads as stated and is in the file", () => {
    const amb = { payments: "Inv,Date,Amount\nS1001,05/03/2026,120.00\nS1002,10/03/2026,100.00\n" };
    expect(reasons(run(amb)).join()).toContain("every date could be day-first or month-first");
    const m = { ...structuredClone(MAPPING), dateSample: { file: "payments.csv", row: 2, raw: "05/03/2026", means: "2026-03-05", confirmedBy: "John" } };
    const ok = run(amb, m);
    expect(ok.errors).toEqual([]);
    expect(ok.dateSample).toEqual({ raw: "05/03/2026", means: "2026-03-05", confirmedBy: "John" });
    expect(reasons(run(amb, { ...m, dateSample: { ...m.dateSample, means: "2026-05-03" } })).join()).toContain("does not read as 2026-05-03");
    expect(reasons(run(amb, { ...m, dateSample: { ...m.dateSample, row: 3 } })).join()).toContain("is not the date in payments.csv row 3");
    expect(run(amb, { ...m, dateSample: { ...m.dateSample, confirmedBy: "" } }).mappingConfirmed).toBe(false);
  });
  it("warns (never silently) on a zero-total invoice, a payment before its invoice and a Windows-1252 file", () => {
    const r = run({ invoices: "Inv,Cust,Date,Net,VAT,Gross\nS1001,C1,01/03/2026,100.00,20.00,120.00\nS1002,C2,14/03/2026,0.00,0.00,0.00\n",
      payments: "Inv,Date,Amount\nS1001,28/02/2026,120.00\n", customers: new Uint8Array([...enc("Code,Name\nC1,Caf"), 0xe9, ...enc("\nC2,Beta\n")]) });
    expect(r.ok).toBe(true);
    const w = r.warnings.map((x) => x.reason).join("|");
    expect(w).toContain('invoice "S1002" has a zero total');
    expect(w).toContain('payment dated 2026-02-28, before its invoice "S1001" (2026-03-01)');
    expect(w).toContain("read as Windows-1252");
  });
});

describe("credit notes (IMPORT-CREDIT-NOTES.md option 1)", () => {
  const withCredits = (text: string) => {
    const m = structuredClone(MAPPING);
    m.entities.creditNotes = { file: "credits.csv", columns: { ref: "CN", invoiceRef: "Inv", date: "Date", gross: "Gross", reason: "Why" } };
    return validateSliqExport({ files: { ...files(), creditNotes: { name: "credits.csv", bytes: enc(text) } }, mapping: m });
  };
  it("accepts a credit applied to an invoice within what is unpaid, and totals it", () => {
    const r = withCredits("CN,Inv,Date,Gross,Why\nCRD-7,S1002,20/03/2026,50.00,Damaged\n");
    expect(r.errors).toEqual([]);
    expect(r.totals.entities.creditNotes?.moneyPence).toEqual({ gross: 5000 });
  });
  it("refuses: zero/negative, an unknown invoice, credits + payments over the total, a ref that is an invoice number, duplicate refs", () => {
    const why = (t: string) => reasons(withCredits(t)).join("|");
    expect(why("CN,Inv,Date,Gross,Why\nCRD-1,S1002,20/03/2026,0.00,x\n")).toContain("greater than zero");
    expect(why("CN,Inv,Date,Gross,Why\nCRD-1,S1002,20/03/2026,-5.00,x\n")).toContain("greater than zero");
    expect(why("CN,Inv,Date,Gross,Why\nCRD-1,S9999,20/03/2026,5.00,x\n")).toContain('invoice "S9999" which is not in the invoices file');
    expect(why("CN,Inv,Date,Gross,Why\nCRD-1,S1002,20/03/2026,500.01,x\n")).toContain("are more than its total");
    expect(why("CN,Inv,Date,Gross,Why\nS1001,S1002,20/03/2026,5.00,x\n")).toContain("is also an invoice number");
    expect(why("CN,Inv,Date,Gross,Why\nCRD-1,S1002,20/03/2026,5.00,x\ncrd-1,S1002,21/03/2026,5.00,y\n")).toContain("duplicate ref");
  });
  it("a credit not applied in full is a decision for a person", () => {
    const m = structuredClone(MAPPING);
    m.entities.creditNotes = { file: "credits.csv", columns: { ref: "CN", invoiceRef: "Inv", date: "Date", gross: "Gross", allocated: "Used" } };
    const r = validateSliqExport({ files: { ...files(), creditNotes: { name: "credits.csv", bytes: enc("CN,Inv,Date,Gross,Used\nCRD-1,S1002,20/03/2026,50.00,20.00\n") } }, mapping: m });
    expect(reasons(r).join()).toContain("not applied in full");
  });
  it("is optional: a mapping without creditNotes needs no file", () => {
    expect(run().ok).toBe(true);
  });
});

describe("scale and reporting", () => {
  it("handles a 20,000 invoice file and still hashes it", () => {
    const n = 20000;
    const inv = ["Inv,Cust,Date,Net,VAT,Gross"];
    const pay = ["Inv,Date,Amount"];
    for (let i = 0; i < n; i++) {
      inv.push(`S${100000 + i},C${(i % 2) + 1},01/03/2026,10.00,2.00,12.00`);
      pay.push(`S${100000 + i},20/03/2026,12.00`);
    }
    const invText = inv.join("\r\n") + "\r\n";
    const r = run({ invoices: invText, payments: pay.join("\r\n") + "\r\n" });
    expect(r.errors).toEqual([]);
    expect(r.totals.entities.invoices?.rows).toBe(n);
    expect(r.totals.entities.invoices?.moneyPence.gross).toBe(n * 1200);
    expect(r.totals.entities.payments?.moneyPence.amount).toBe(n * 1200);
    expect(r.totals.entities.invoices?.sha256).toBe(createHash("sha256").update(invText).digest("hex"));
  });
  it("caps the error list and refuses ok when truncated", () => {
    const rows = Array.from({ length: 50 }, (_, i) => `S${3000 + i},C1,99/99/2026,1.00,0.00,1.00`).join("\n");
    const r = validateSliqExport({ files: files({ invoices: `Inv,Cust,Date,Net,VAT,Gross\n${rows}\n`, payments: "Inv,Date,Amount\n" }), mapping: MAPPING, maxErrors: 10 });
    expect(r.errors).toHaveLength(10);
    expect(r.truncated).toBe(true);
    expect(r.ok).toBe(false);
  });
  it("does not mutate the input mapping", () => {
    const before = JSON.stringify(MAPPING);
    run();
    expect(JSON.stringify(MAPPING)).toBe(before);
  });
});
