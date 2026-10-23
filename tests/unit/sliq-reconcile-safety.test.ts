/**
 * Output safety and personal data. The report folder can never be, sit inside or contain an input (symlinks resolved), never
 * overwrites a file the tool did not write, and is written atomically. No name, e-mail address, phone number, address or
 * password from the inputs or the arguments reaches any output file, standard output or standard error, however it got in.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { EXIT } from "../../scripts/sliq-reconcile/cli.mjs";
import { safeFile, safeRef, safeText, safeWord, scrub, stripQuoted } from "../../scripts/sliq-reconcile/safe.mjs";
import { CSV_COLUMNS, ids, makeCollector } from "../../scripts/sliq-reconcile/rows.mjs";
import { ORG, editCsv, editTable, runCli, workspace, type Ws } from "../support/sliq-reconcile";

const args = (ws: Ws, over: Record<string, string> = {}) => {
  const a = { "--sliq": ws.sliq, "--tolra": ws.tolra, "--out": ws.out, "--mapping": "synthetic", ...over };
  return Object.entries(a).flat();
};

describe("--out can never be, sit inside, or contain an input", () => {
  it("refuses the same folder, a folder inside it, and a parent of it", async () => {
    const ws = workspace();
    for (const out of [ws.sliq, path.join(ws.sliq, "report"), ws.tolra, path.join(ws.tolra, "report"), ws.root, path.dirname(ws.root)]) {
      const r = await runCli(ws, [], args(ws, { "--out": out }));
      expect({ out: out.replace(ws.root, "<root>"), code: r.code }).toEqual({ out: out.replace(ws.root, "<root>"), code: EXIT.INPUT });
      expect(r.stderr).toContain("--out must not be");
    }
    expect(readdirSync(ws.sliq).some((f) => f.startsWith("summary") || f.startsWith("mismatches"))).toBe(false);
    expect(readdirSync(ws.tolra).some((f) => f.startsWith("summary") || f.startsWith("mismatches"))).toBe(false);
  });

  it("sees through symlinks: a link to an input, a link inside an input, and a link to a parent", async () => {
    const ws = workspace();
    const links = mkdtempSync(path.join(tmpdir(), "sliq-reconcile-links-"));
    symlinkSync(ws.sliq, path.join(links, "to-sliq"));
    symlinkSync(ws.tolra, path.join(links, "to-tolra"));
    symlinkSync(ws.root, path.join(links, "to-root"));
    for (const out of [path.join(links, "to-sliq"), path.join(links, "to-sliq", "new"), path.join(links, "to-tolra"), path.join(links, "to-root"), path.join(links, "to-root", "sliq", "x")]) {
      const r = await runCli(ws, [], args(ws, { "--out": out }));
      expect({ code: r.code, out: path.relative(links, out) }).toEqual({ code: EXIT.INPUT, out: path.relative(links, out) });
    }
    // and the inputs may be the links while --out is the real folder inside
    const r = await runCli(ws, [], args(ws, { "--sliq": path.join(links, "to-sliq"), "--out": path.join(ws.sliq, "out") }));
    expect(r.code).toBe(EXIT.INPUT);
    expect(existsSync(path.join(ws.sliq, "out"))).toBe(false);
  });

  it("a plain sibling folder is fine", async () => {
    const ws = workspace();
    expect((await runCli(ws)).code).toBe(EXIT.OK);
  });
});

describe("a report folder is never used to overwrite someone else's files", () => {
  it("refuses a folder holding a file or folder this tool did not write, and touches nothing", async () => {
    const ws = workspace();
    mkdirSync(ws.out, { recursive: true });
    writeFileSync(path.join(ws.out, "budget.xlsx"), "precious");
    writeFileSync(path.join(ws.out, "summary.json"), "{}"); // its own name, from "an earlier run"
    const r = await runCli(ws);
    expect(r.code).toBe(EXIT.INPUT);
    expect(r.stderr).toContain("--allow-other-files");
    expect(readFileSync(path.join(ws.out, "budget.xlsx"), "utf8")).toBe("precious");
    expect(readFileSync(path.join(ws.out, "summary.json"), "utf8")).toBe("{}");
    mkdirSync(path.join(ws.out, "sub"));
    rmSync(path.join(ws.out, "budget.xlsx"));
    expect((await runCli(ws)).code).toBe(EXIT.INPUT); // a folder counts too
  });

  it("with --allow-other-files it writes beside them and still leaves them alone", async () => {
    const ws = workspace();
    mkdirSync(path.join(ws.out, "sub"), { recursive: true });
    writeFileSync(path.join(ws.out, "budget.xlsx"), "precious");
    writeFileSync(path.join(ws.out, "mismatches-old-area.csv"), "stale"); // not a name this tool generates: someone else's, left alone
    const r = await runCli(ws, ["--allow-other-files"]);
    expect(r.code).toBe(EXIT.OK);
    expect(readFileSync(path.join(ws.out, "budget.xlsx"), "utf8")).toBe("precious");
    expect(readFileSync(path.join(ws.out, "mismatches-old-area.csv"), "utf8")).toBe("stale");
    expect(existsSync(path.join(ws.out, "summary.json"))).toBe(true);
    expect(existsSync(path.join(ws.out, "sub"))).toBe(true);
  });

  it("an --out that is a file is refused", async () => {
    const ws = workspace();
    writeFileSync(ws.out, "x");
    expect((await runCli(ws)).code).toBe(EXIT.INPUT);
    expect(readFileSync(ws.out, "utf8")).toBe("x");
  });

  it("never writes through a link: a link where summary.json should be is refused (with or without --allow-other-files) and left as it is", async () => {
    const ws = workspace();
    const elsewhere = path.join(ws.root, "elsewhere.txt");
    writeFileSync(elsewhere, "not a report");
    mkdirSync(ws.out);
    symlinkSync(elsewhere, path.join(ws.out, "summary.json"));
    for (const extra of [[], ["--allow-other-files"]]) {
      expect((await runCli(ws, extra)).code).toBe(EXIT.INPUT);
      expect(readFileSync(elsewhere, "utf8")).toBe("not a report");
      expect(lstatSync(path.join(ws.out, "summary.json")).isSymbolicLink()).toBe(true);
      expect(readdirSync(ws.out)).toEqual(["summary.json"]);
    }
  });

  it("is atomic: no temporary files are left, and a failure part-way leaves the earlier report whole", async () => {
    const ws = workspace();
    expect((await runCli(ws)).code).toBe(EXIT.OK);
    expect(readdirSync(ws.out).filter((f) => f.includes("tmp"))).toEqual([]);
    const before = readFileSync(path.join(ws.out, "summary.json"), "utf8");
    // make the next run fail while writing: a folder where mismatches.csv must go
    rmSync(path.join(ws.out, "mismatches.csv"));
    mkdirSync(path.join(ws.out, "mismatches.csv"));
    const r = await runCli(ws);
    expect(r.code).toBe(EXIT.INPUT);
    expect(readFileSync(path.join(ws.out, "summary.json"), "utf8")).toBe(before);
    expect(readdirSync(ws.out).filter((f) => f.startsWith(".sliq-reconcile-tmp"))).toEqual([]);
  });
});

const SECRETS = ["Zed", "Zulu", "zed@", "zulu.example", "07700", "900123", "01110", "Hidden Lane", "HU9 9ZZ", "Mr Smith", "Smith", "SECRETPW", "hunter2"];

function everything(ws: Ws, r: { stdout: string; stderr: string }) {
  const files = existsSync(ws.out) ? readdirSync(ws.out).map((f) => readFileSync(path.join(ws.out, f), "utf8")) : [];
  return [...files, r.stdout, r.stderr].join("\n");
}
const expectNoSecrets = (text: string) => {
  for (const secret of SECRETS) expect({ secret, found: text.includes(secret) }).toEqual({ secret, found: false });
};

describe("no personal data in any output, whatever route it came in by", () => {
  it("names, e-mails, phones and addresses in references, free text, statuses, ids and error messages", async () => {
    const ws = workspace();
    // SliQ: in a reference (an invoice number of a payment that has no invoice), an account code, a description, a note, a status
    // word, a numeric column, a credit-note reference, a job stage word's neighbour, an opening-balance account
    editCsv(ws, "payments.csv", (t) => `${t}Zed.Zulu@zulu.example.test,01/03/2026,10.00,BACS,\nMr Smith 07700 900123,01/03/2026,11.00,BACS,\n`);
    editCsv(ws, "customers.csv", (t) => `${t}Mr Smith 07700 900123,Zed Zulu,Zed Zulu,12 Hidden Lane,,Hull,HU9 9ZZ,zed@zulu.example.test,01110 999999,\n`);
    editCsv(ws, "invoice-lines.csv", (t) => t.replace("S1001,Bracket", 'S1001,"Bracket for Zed Zulu, 12 Hidden Lane, HU9 9ZZ 07700900123"'));
    editCsv(ws, "invoices.csv", (t) => t.replace("S1009,Invoice,09/03/2026,08/04/2026,C002,10.00", "S1009,Invoice,09/03/2026,08/04/2026,C002,Zed Zulu 07700900123").replace("S1008,Invoice,08/03/2026,07/04/2026,C001,50.00,10.00,60.00,Cancelled", "S1008,Invoice,08/03/2026,07/04/2026,C001,50.00,10.00,60.00,Mr Smith"));
    editCsv(ws, "credit-notes.csv", (t) => t.replace("CN-002,11/03/2026,C001,20.00,4.00,24.00,S1003", "CN-002,11/03/2026,C001,20.00,4.00,24.00,Zed Zulu <zed@zulu.example.test>"));
    editCsv(ws, "opening-balances.csv", (t) => `${t}Mr Smith 07700 900123,Customer,,01/03/2026,5.00\n`);
    editCsv(ws, "deliveries.csv", (t) => `${t}DN-0009,01/04/2026,Zed Zulu job,zed@zulu.example.test,Hidden Lane 12,5\n`);
    // Tolra: a status, a stage, a customer, an id, a company-less row with an e-mail id, a free-text description, a table file name
    editTable(ws, "invoices", (rows) => {
      rows.find((r) => r.invoice_ref === "S1004").status = "zed@zulu.example.test";
      rows.find((r) => r.invoice_ref === "S1001").customer = "Zed Zulu Ltd, 12 Hidden Lane";
    });
    editTable(ws, "jobs", (rows) => {
      rows[0].stage = "Zed Zulu";
    });
    editTable(ws, "invoice_line_items", (rows) => {
      rows[1].description = "Mr Smith, 12 Hidden Lane";
    });
    editTable(ws, "quotes", (rows) => {
      rows.push({ organization_id: "cccccccc-2222-4333-8444-555555555555", id: "zed@zulu.example.test", quote_ref: "Q-ZED 07700900123", customer: "Zed Zulu", total_value: "1.00", status: "sent", valid_until: null });
    });
    writeFileSync(path.join(ws.tolra, "zed.zulu@example.test.json"), JSON.stringify([{ id: "1" }]));
    const r = await runCli(ws);
    expect([EXIT.OK, EXIT.BLOCKERS]).toContain(r.code);
    const all = everything(ws, r);
    expect(all.length).toBeGreaterThan(2000);
    expectNoSecrets(all);
    // something was really reported about these inputs (the test would pass vacuously if the rows had been dropped)
    expect(all).toContain("payment_without_invoice");
    expect(all).toContain("foreign_company_row");
    expect(all).toContain("source_row_unreadable");
    expect(all).toMatch(/ref-[0-9a-f]{8}/);
    expect(all).toMatch(/word-[0-9a-f]{8}/);
    expect(all).toMatch(/text-[0-9a-f]{8}/);
  });

  it("values that end up in error messages: bad money, bad dates, bad JSON, a bad percentage, a bad format, a bad company id", async () => {
    const cases: [string, (ws: Ws) => void][] = [
      ["bad snapshot money", (ws) => editTable(ws, "invoices", (rows) => { rows[0].total = "Zed Zulu 07700900123"; })],
      ["bad snapshot date", (ws) => editTable(ws, "invoices", (rows) => { rows[0].due_date = "Mr Smith"; })],
      ["bad snapshot percentage", (ws) => editTable(ws, "invoice_line_items", (rows) => { rows[0].vat_pct = "Zed Zulu"; })],
      ["bad snapshot type", (ws) => editTable(ws, "invoices", (rows) => { rows[0].payment_unverified = "zed@zulu.example.test"; })],
      ["bad company id", (ws) => writeFileSync(path.join(ws.tolra, "meta.json"), JSON.stringify({ format: "tolra-snapshot/1", organization_id: "Zed Zulu" }))],
      ["bad meta format", (ws) => writeFileSync(path.join(ws.tolra, "meta.json"), JSON.stringify({ format: "Zed Zulu", organization_id: ORG }))],
      ["invalid JSON", (ws) => writeFileSync(path.join(ws.tolra, "customers.json"), '[{"name": "Zed Zulu", "id": ')],
      ["bad SliQ money", (ws) => editCsv(ws, "payments.csv", (t) => t.replace("S1001,05/03/2026,120.00", "S1001,05/03/2026,Zed Zulu 07700900123"))],
      ["bad SliQ date", (ws) => editCsv(ws, "payments.csv", (t) => t.replace("05/03/2026", "Zed Zulu"))],
      ["bad SliQ status word", (ws) => editCsv(ws, "quotes.csv", (t) => t.replace("Sent", "Mr Smith"))],
      ["bad SliQ quantity", (ws) => editCsv(ws, "jobs.csv", (t) => t.replace("J-0001,C002,SO-0001,Machining,In Progress,100", "J-0001,C002,SO-0001,Machining,In Progress,Zed Zulu"))],
      ["bad SliQ job word", (ws) => editCsv(ws, "jobs.csv", (t) => t.replace("Machining", "Zed Zulu"))],
      ["bad SliQ csv", (ws) => writeFileSync(path.join(ws.sliq, "customers.csv"), 'Account,Name\n"Zed Zulu,unclosed\n')],
      ["missing header", (ws) => editCsv(ws, "customers.csv", (t) => t.replace("Name,", "Zed Zulu,"))],
    ];
    for (const [label, corrupt] of cases) {
      const ws = workspace();
      corrupt(ws);
      const r = await runCli(ws);
      expect({ label, code: r.code === EXIT.UNEXPECTED }).toEqual({ label, code: false });
      expect({ label, text: everything(ws, r).match(new RegExp(SECRETS.join("|"), "g")) }).toEqual({ label, text: null });
    }
  });

  it("arguments: a rejected URL or connection string is never echoed, password and all", async () => {
    const ws = workspace();
    for (const bad of ["postgres://admin:SECRETPW@db.internal:5432/app", "https://user:hunter2@qtgqliczvyyrkibvxfqv.supabase.co", "host=db user=admin password=hunter2"]) {
      const r = await runCli(ws, [], ["--sliq", ws.sliq, "--tolra", ws.tolra, "--out", ws.out, "--mapping", bad]);
      expect(r.code).toBe(EXIT.REFUSED);
      expect(r.stderr).toContain("the value of --mapping looks like");
      expectNoSecrets(r.stderr + r.stdout);
      expect(r.stderr).not.toContain("postgres");
      expect(r.stderr).not.toContain("supabase");
    }
    const r2 = await runCli(ws, [], ["--sliq", ws.sliq, "--tolra", ws.tolra, "--out", ws.out, "--Zed-Zulu-07700900123", "x"]);
    expect(r2.code).toBe(EXIT.INPUT);
    expectNoSecrets(r2.stderr);
  });

  it("an unexpected error cannot carry an e-mail address or a phone number to the terminal", async () => {
    expect(scrub("failed for zed@zulu.example.test, call 07700 900123 or +44 7700 900 123 (row 4, 120.50, 2026-03-05)")).toBe("failed for [e-mail withheld], call [number withheld] or [number withheld] (row 4, 120.50, 2026-03-05)");
    expect(scrub("id 11111111-2222-4333-8444-555555555555")).toBe("id 11111111-2222-4333-8444-555555555555");
  });
});

describe("the output allowlist", () => {
  it("references, files, words and text are shown only in a safe form", () => {
    expect(safeRef("S1003")).toBe("S1003");
    expect(safeRef("INV-000123")).toBe("INV-000123");
    for (const bad of ["Zed Zulu", "zed@zulu.example.test", "07700900123", "01110 000001", "=HYPERLINK(1)", "-5", "@x", "x".repeat(41), "a\tb", ""]) {
      const shown = safeRef(bad);
      expect(shown === "" || /^ref-[0-9a-f]{8}$/.test(shown), bad).toBe(true);
    }
    expect(safeRef("same")).toBe(safeRef("same"));
    expect(safeRef("Zed Zulu")).not.toBe(safeRef("Zed Zula"));
    expect(safeFile("customers.csv")).toBe("customers.csv");
    expect(safeFile("ledger.xlsx [Sales Invoices]")).toBe("ledger.xlsx [Sales Invoices]");
    expect(safeFile("zed.zulu@example.test.json")).toMatch(/^file-[0-9a-f]{8}$/);
    expect(safeWord("Paid")).toBe("paid");
    expect(safeWord("Zed Zulu")).toMatch(/^word-[0-9a-f]{8}$/);
    expect(safeText("Bracket for Zed Zulu")).toMatch(/^text-[0-9a-f]{8}$/);
    expect(stripQuoted('Money "Zed 0770" is not a plain amount')).toBe('Money "<value withheld>" is not a plain amount');
  });

  it("an identifier key outside the allowlist cannot be written (it throws), and unsafe values become fingerprints", () => {
    expect(() => ids({ "customer name": "x" })).toThrow(/allowlist/);
    expect(() => makeCollector().add({ area: "inputs", code: "x", ids: { email: "a@b" }, field: "f", severity: "INFO", reason: "r" })).toThrow(/allowlist/);
    expect(ids({ invoice: "Zed Zulu", customer: "C001", row: "4", "row id": "11111111-2222-4333-8444-555555555555" })).toMatch(/^invoice=ref-[0-9a-f]{8};customer=C001;row=4;row id=11111111-/);
    expect(ids({ payment: "zed@zulu.example.test#1" })).toMatch(/^payment=ref-[0-9a-f]{8}$/);
    const c = makeCollector();
    c.add({ area: "inputs", code: "x", ids: { file: "a.csv" }, field: "f", source: "mail zed@zulu.example.test", target: "call 07700 900123", severity: "INFO", reason: "see zed@zulu.example.test" });
    expect(JSON.stringify(c.rows)).not.toMatch(/zed|07700/);
    expect(CSV_COLUMNS).toHaveLength(8);
  });
});
