/**
 * The files a person reads: the mismatch CSVs (fixed columns, formula-injection safe), summary.json / summary.md, determinism
 * (two runs are byte-identical), and no personal data. Synthetic fixtures only.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { EXIT, main } from "../../scripts/sliq-reconcile/cli.mjs";
import { csvField, neutraliseCsvText, toCsv } from "../../scripts/sliq-reconcile/csv.mjs";
import { AREAS, CSV_COLUMNS, SEVERITIES, sortRows } from "../../scripts/sliq-reconcile/rows.mjs";
import { csvField as appCsvField, neutraliseCsvText as appNeutralise } from "../../lib/html";
import { FIXTURE, GENERATED_AT, analyse, editCsv, editTable, idOf, readCsvRows, runCli, workspace, type Row, type Ws } from "../support/sliq-reconcile";

const dirHash = (dir: string) => Object.fromEntries(readdirSync(dir).sort().map((f) => [f, createHash("sha256").update(readFileSync(path.join(dir, f))).digest("hex")]));

/** A small, fixed set of corruptions so every output file has something in it. */
function corrupt(ws: Ws) {
  editTable(ws, "invoices", (rows) => {
    rows.find((r) => r.invoice_ref === "S1002").amount_paid = "150.00";
    rows.find((r) => r.invoice_ref === "S1004").vat = "12.00";
  });
  editTable(ws, "jobs", (rows) => {
    rows.find((r) => r.job_no === "J-0001").stage = "inspection";
  });
  editTable(ws, "quotes", (rows) => rows.filter((r) => r.quote_ref !== "Q2004"));
}

describe("mismatch CSV format", () => {
  it("has exactly the agreed columns, valid severities and areas, in a stable order", async () => {
    const ws = workspace();
    corrupt(ws);
    const r = await runCli(ws);
    expect(r.code).toBe(EXIT.BLOCKERS);
    const text = readFileSync(path.join(ws.out, "mismatches.csv"), "utf8");
    expect(text.split("\n")[0]).toBe("area,identifier,field,source_value,target_value,difference,severity,reason");
    expect(CSV_COLUMNS).toEqual(["area", "identifier", "field", "source_value", "target_value", "difference", "severity", "reason"]);
    const rows = readCsvRows(path.join(ws.out, "mismatches.csv"));
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) {
      expect(SEVERITIES).toContain(row.severity);
      expect(AREAS).toContain(row.area);
      expect(row.reason.length).toBeGreaterThan(10);
      expect(row.identifier.length).toBeGreaterThan(0);
    }
    // sorted by area (in AREAS order), then identifier
    const rank = (a: string) => AREAS.indexOf(a);
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1];
      const b = rows[i];
      expect(rank(a.area) < rank(b.area) || (rank(a.area) === rank(b.area) && a.identifier <= b.identifier)).toBe(true);
    }
    // one CSV per area that has rows, holding exactly that area's rows; together they are the combined file
    const files = readdirSync(ws.out).filter((f) => /^mismatches-.*\.csv$/.test(f));
    expect(files.length).toBeGreaterThan(1);
    const perArea = files.flatMap((f) => readCsvRows(path.join(ws.out, f)));
    expect(perArea.length).toBe(rows.length);
    for (const f of files) {
      const area = f.replace(/^mismatches-|\.csv$/g, "");
      expect(readCsvRows(path.join(ws.out, f)).every((x) => x.area === area)).toBe(true);
    }
  });

  it("difference is target minus source in pounds, to the penny", async () => {
    const ws = workspace();
    corrupt(ws);
    await runCli(ws);
    const rows = readCsvRows(path.join(ws.out, "mismatches.csv"));
    const paid = rows.find((r) => r.identifier === "invoice=S1002" && r.field.startsWith("paid"))!;
    expect(paid).toMatchObject({ source_value: "200.00", target_value: "150.00", difference: "-50.00", severity: "BLOCKER" });
  });
});

describe("CSV formula injection", () => {
  const nasty = ["=1+1", "+1+1", "-2+3", "@SUM(A1)", "\t=1", "\r=1", '=HYPERLINK("x","y")', "-12.50", "12.50", "-5", "plain", "", " =x", "a=b", "=cmd|' /C calc'!A0"];

  it("gives a formula a leading apostrophe and leaves plain numbers and text alone, exactly as the app's own exports do", () => {
    for (const v of nasty) {
      expect({ v, mine: neutraliseCsvText(v) }).toEqual({ v, mine: appNeutralise(v) });
      expect({ v, mine: csvField(v) }).toEqual({ v, mine: appCsvField(v) });
    }
    expect(neutraliseCsvText("=1+1")).toBe("'=1+1");
    expect(neutraliseCsvText("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(neutraliseCsvText("\t=1")).toBe("'\t=1");
    expect(neutraliseCsvText("-12.50")).toBe("-12.50"); // a negative amount is a number, not a formula
    expect(toCsv(["a", "b"], [{ a: "=1", b: "x,y" }])).toBe('a,b\n\'=1,"x,y"\n');
  });

  it("a hostile value from either side never starts a cell as a formula, and is not printed at all", async () => {
    const ws = workspace();
    // SliQ line descriptions that are formulas: shown only as a fingerprint
    editCsv(ws, "invoice-lines.csv", (t) =>
      t
        .replace("S1001,Bracket", 'S1001,"=HYPERLINK(""http://example.test"",""click"")"')
        .replace("S1002,Frame", "S1002,+1+1")
        .replace("S1003,Plate", "S1003,-2+3")
        .replace("S1006,Thing", "S1006,@SUM(A1)")
        .replace("S1007,Export part", 'S1007,"\t=1"')
        .replace("S1005,Gasket", 'S1005,"\r=cmd|\' /C calc\'!A0"'),
    );
    // a Tolra-side status, a reference and a stage that start with a formula character
    editTable(ws, "invoices", (rows) => {
      rows.find((r) => r.invoice_ref === "S1004").status = "=SUM(1)";
    });
    editTable(ws, "jobs", (rows) => {
      rows[0].stage = "@cmd";
    });
    editTable(ws, "quotes", (rows) => {
      rows.find((r) => r.quote_ref === "Q2001").customer = "-1+1";
    });
    const r = await runCli(ws);
    expect([EXIT.OK, EXIT.BLOCKERS]).toContain(r.code);
    let cells = 0;
    for (const f of readdirSync(ws.out).filter((x) => x.endsWith(".csv"))) {
      const text = readFileSync(path.join(ws.out, f), "utf8");
      const { rows } = (await import("../../scripts/sliq-import/parse.mjs")).parseCsv(text) as { rows: string[][] };
      for (const row of rows) {
        for (const cell of row) {
          cells++;
          if (/^[=+\-@\t\r]/.test(cell) && !/^-?\d+(\.\d+)?$/.test(cell)) throw new Error(`${f}: a cell can start a formula: ${JSON.stringify(cell)}`);
        }
      }
    }
    expect(cells).toBeGreaterThan(20);
    const all = readdirSync(ws.out).map((f) => readFileSync(path.join(ws.out, f), "utf8")).join("\n");
    for (const hostile of ["HYPERLINK", "calc", "SUM(1)", "@cmd", "+1+1", "-2+3", "@SUM", "example.test"]) expect(all).not.toContain(hostile);
    expect(all).toMatch(/text-[0-9a-f]{8}/); // the descriptions are there, as fingerprints
    expect(all).toMatch(/word-[0-9a-f]{8}/); // and so are the unknown status and stage words
  });

  it("a document number that looks like a formula is safe in the identifier and the values", async () => {
    const ws = workspace();
    editCsv(ws, "invoices.csv", (t) => t.replace("S1009,Invoice", "=S1009,Invoice"));
    const { rows } = await analyse(ws);
    const hit = rows.find((x) => x.identifier.includes("=S1009"));
    expect(hit).toBeTruthy();
    const csv = toCsv(CSV_COLUMNS, rows);
    for (const line of csv.split("\n").slice(1)) expect(line.startsWith("=")).toBe(false);
  });
});

describe("deterministic output", () => {
  it("two runs are byte-identical, even from different folders", async () => {
    const a = workspace();
    const b = workspace();
    corrupt(a);
    corrupt(b);
    expect(a.root).not.toBe(b.root);
    await runCli(a);
    await runCli(b);
    expect(dirHash(a.out)).toEqual(dirHash(b.out));
    await runCli(a); // and again over the same folder
    expect(dirHash(a.out)).toEqual(dirHash(b.out));
  });

  it("the only moving part is generatedAt, and nothing else carries a path or a clock", async () => {
    const a = workspace();
    const b = workspace();
    corrupt(a);
    corrupt(b);
    await main(["--sliq", a.sliq, "--tolra", a.tolra, "--out", a.out, "--mapping", "synthetic", "--generated-at", "2026-01-01T00:00:00Z"], { stdout: () => {}, stderr: () => {} });
    await runCli(b);
    const ha = dirHash(a.out);
    const hb = dirHash(b.out);
    expect(Object.keys(ha)).toEqual(Object.keys(hb));
    const differing = Object.keys(ha).filter((f) => ha[f] !== hb[f]);
    // the marker records the SHA-256 of summary.json / summary.md, so it moves with them and with nothing else
    expect(differing).toEqual([".sliq-reconcile-output.json", "summary.json", "summary.md"]);
    for (const ws of [a, b]) expect(readFileSync(path.join(ws.out, ".sliq-reconcile-output.json"), "utf8")).not.toMatch(/\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}|\/tmp|\/home/);
    const markerOf = (ws: Ws) => JSON.parse(readFileSync(path.join(ws.out, ".sliq-reconcile-output.json"), "utf8")).files as Record<string, string>;
    for (const f of Object.keys(markerOf(a))) if (f !== "summary.json" && f !== "summary.md") expect(markerOf(a)[f]).toBe(markerOf(b)[f]);
    const swap = (f: string, ws: Ws, to: string) => readFileSync(path.join(ws.out, f), "utf8").replace(to, "STAMP");
    expect(swap("summary.json", a, "2026-01-01T00:00:00Z")).toBe(swap("summary.json", b, GENERATED_AT));
    expect(swap("summary.md", a, "2026-01-01T00:00:00Z")).toBe(swap("summary.md", b, GENERATED_AT));
    for (const f of Object.keys(ha)) {
      const text = readFileSync(path.join(a.out, f), "utf8");
      expect(text).not.toContain(a.root);
      expect(text).not.toContain(tmpdir());
    }
  });

  it("without --generated-at the clock is read once, for that one field only", async () => {
    const a = workspace();
    const b = workspace();
    await main(["--sliq", a.sliq, "--tolra", a.tolra, "--out", a.out, "--mapping", "synthetic"], { stdout: () => {}, stderr: () => {} });
    await main(["--sliq", b.sliq, "--tolra", b.tolra, "--out", b.out, "--mapping", "synthetic"], { stdout: () => {}, stderr: () => {} });
    const strip = (ws: Ws) => readFileSync(path.join(ws.out, "summary.json"), "utf8").replace(/"generatedAt": "[^"]+"/, '"generatedAt": "X"');
    expect(strip(a)).toBe(strip(b));
    expect(readFileSync(path.join(a.out, "mismatches.csv"), "utf8")).toBe(readFileSync(path.join(b.out, "mismatches.csv"), "utf8"));
    expect(JSON.parse(readFileSync(path.join(a.out, "summary.json"), "utf8")).generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it("sorting is a total order that ignores insertion order", () => {
    const row = (area: string, identifier: string, code: string) => ({ area, code, identifier, field: "f", source_value: "", target_value: "", difference: "", severity: "WARN", reason: "r" });
    const rows = [row("wip", "job=J-2", "b"), row("inputs", "x", "a"), row("wip", "job=J-1", "b"), row("wip", "job=J-1", "a"), row("wip", "job=J-1", "a")];
    const forward = sortRows(rows);
    const backward = sortRows([...rows].reverse());
    expect(backward).toEqual(forward);
    expect(forward.map((r: { area: string; identifier: string; code: string }) => `${r.area}/${r.identifier}/${r.code}`)).toEqual(["inputs/x/a", "wip/job=J-1/a", "wip/job=J-1/b", "wip/job=J-2/b"]);
  });
});

describe("the report folder holds one run", () => {
  it("removes this tool's own files from an earlier run (and only those), so nothing stale sits beside the new summary", async () => {
    const ws = workspace();
    corrupt(ws);
    await runCli(ws);
    expect(existsSync(path.join(ws.out, "mismatches-wip.csv"))).toBe(true);
    const fs = await import("node:fs");
    fs.writeFileSync(path.join(ws.out, "notes.txt"), "mine");
    expect((await runCli(ws)).code).toBe(EXIT.INPUT); // a folder with someone else's file in it is refused...
    // fix the one corruption that produced the wip rows, then run again into the same folder
    const tolra = path.join(ws.tolra, "jobs.json");
    fs.writeFileSync(tolra, fs.readFileSync(path.join(FIXTURE, "tolra", "jobs.json")));
    await runCli(ws, ["--allow-other-files"]); // ...unless the operator says it is fine
    expect(existsSync(path.join(ws.out, "mismatches-wip.csv"))).toBe(true); // the standing valuation row is still there...
    editTable(ws, "jobs", (rows) => rows.forEach((r) => (r.finished_at = "2026-04-01")));
    editCsv(ws, "jobs.csv", (t) => t.replace("In Progress", "Finished"));
    await runCli(ws, ["--allow-other-files"]);
    expect(existsSync(path.join(ws.out, "mismatches-wip.csv"))).toBe(false); // ...until no job is open
    expect(readFileSync(path.join(ws.out, "notes.txt"), "utf8")).toBe("mine");
    const s = JSON.parse(readFileSync(path.join(ws.out, "summary.json"), "utf8"));
    for (const f of s.outputs) expect(existsSync(path.join(ws.out, f))).toBe(true);
    expect(readdirSync(ws.out).filter((f) => f.endsWith(".csv") || f.startsWith("summary")).sort()).toEqual([...s.outputs].sort());
    expect(readdirSync(ws.out).filter((f) => f.startsWith(".sliq-reconcile-tmp"))).toEqual([]);
  });
});

describe("summary files", () => {
  it("summary.json states the verdict, counts by severity and area, inputs with checksums, and the limitations", async () => {
    const ws = workspace();
    corrupt(ws);
    await runCli(ws);
    const s = JSON.parse(readFileSync(path.join(ws.out, "summary.json"), "utf8"));
    expect(s.format).toBe("sliq-tolra-reconciliation/1");
    expect(s.generatedAt).toBe(GENERATED_AT);
    expect(s.verdict.status).toBe("FAIL");
    expect(s.signOff.allowed).toBe(false);
    expect(s.signOff.text).toMatch(/^cannot sign off/);
    expect(s.mode).toContain("read only");
    expect(s.counts.bySeverity.BLOCKER).toBeGreaterThan(0);
    expect(s.counts.bySeverity.UNVERIFIED).toBeGreaterThanOrEqual(1);
    expect(Object.keys(s.counts.byArea)).toEqual(AREAS);
    expect(s.counts.total).toBe(Object.values(s.counts.bySeverity as Record<string, number>).reduce((a, b) => a + b, 0));
    expect(s.inputs.sliq.mapping).toMatchObject({ id: "synthetic", status: "confirmed" });
    expect(s.inputs.sliq.files.length).toBeGreaterThan(10);
    for (const f of [...s.inputs.sliq.files, ...s.inputs.tolra.files]) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.inputs.tolra.tablesNotSupplied).toEqual([]);
    expect(s.limitations.join(" ")).toContain("valuation: accountant to confirm");
    expect(s.outputs).toEqual(expect.arrayContaining(["summary.json", "summary.md", "mismatches.csv"]));
    const md = readFileSync(path.join(ws.out, "summary.md"), "utf8");
    expect(md).toContain("# SliQ to Tolra reconciliation: FAIL");
    expect(md).toContain("Sign-off: cannot sign off");
    expect(md).toContain("What UNVERIFIED means");
    expect(md).toContain("valuation: accountant to confirm");
  });

  it("UNVERIFIED never looks like a pass: INCOMPLETE, 'cannot sign off', and exit 0 means only 'no BLOCKER'", async () => {
    const ws = workspace();
    const r = await runCli(ws);
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toContain("Dry run only: read only and offline");
    expect(r.stdout).toContain("STATUS: INCOMPLETE");
    expect(r.stdout).toContain("cannot sign off");
    expect(r.stdout).toContain("NOT a pass");
    const s = JSON.parse(readFileSync(path.join(ws.out, "summary.json"), "utf8"));
    expect(s.verdict.status).toBe("INCOMPLETE");
    expect(s.verdict.text).toContain("This is not a pass");
    expect(s.signOff).toMatchObject({ allowed: false });
    expect(s.signOff.text).toBe("cannot sign off: 0 BLOCKER, 0 WARN, 1 UNVERIFIED row(s) remain. Resolve or explain each, supply any missing file or table, and run again.");
    expect(s.exitCode).toContain("does NOT mean PASS");
    const md = readFileSync(path.join(ws.out, "summary.md"), "utf8");
    expect(md.split("\n")[0]).toBe("# SliQ to Tolra reconciliation: INCOMPLETE");
    expect(md).toContain("**Sign-off: cannot sign off");
    expect(md).toContain("it is not a pass");
    expect(md).not.toMatch(/evidence ready|PASS:/);
  });

  it("--require-pass turns INCOMPLETE into exit 5; a BLOCKER stays 4; only a run with nothing outstanding is PASS", async () => {
    const ws = workspace();
    expect((await runCli(ws, ["--require-pass"])).code).toBe(EXIT.NOT_PASS);
    corrupt(ws);
    expect((await runCli(ws, ["--require-pass"])).code).toBe(EXIT.BLOCKERS);
    const done = workspace();
    editTable(done, "jobs", (j) => j.forEach((r) => (r.finished_at = "2026-04-01")));
    editCsv(done, "jobs.csv", (t) => t.replace("In Progress", "Finished"));
    const r = await runCli(done, ["--require-pass"]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.stdout).toContain("STATUS: PASS");
    const s = JSON.parse(readFileSync(path.join(done.out, "summary.json"), "utf8"));
    expect(s.verdict.status).toBe("PASS");
    expect(s.signOff.allowed).toBe(true);
    expect(s.signOff.text).toContain("not the sign-off");
    expect(readFileSync(path.join(done.out, "summary.md"), "utf8")).toContain("# SliQ to Tolra reconciliation: PASS");
  });

  it("warnings alone are not a pass either", async () => {
    const ws = workspace();
    editTable(ws, "jobs", (j) => j.forEach((r) => (r.finished_at = "2026-04-01")));
    editCsv(ws, "jobs.csv", (t) => t.replace("In Progress", "Finished"));
    editTable(ws, "quotes", (rows) => rows.filter((r) => r.quote_ref !== "Q2004"));
    await runCli(ws);
    const s = JSON.parse(readFileSync(path.join(ws.out, "summary.json"), "utf8"));
    expect(s.counts.bySeverity).toMatchObject({ BLOCKER: 0, WARN: 1, UNVERIFIED: 0 });
    expect(s.verdict.status).toBe("INCOMPLETE");
    expect(s.signOff.allowed).toBe(false);
  });

  it("no names, e-mail addresses, phone numbers or street addresses appear in any output file, whatever is corrupted", async () => {
    const ws = workspace();
    corrupt(ws);
    editTable(ws, "customers", (rows) => {
      rows[0].name = "Alpha Fabs Limited";
    });
    editTable(ws, "invoices", (rows) => {
      rows.find((r) => r.invoice_ref === "S1001").customer = "Gamma Supplies";
    });
    editTable(ws, "credit_notes", (rows) => {
      rows[0].invoice_id = idOf(ws, "invoices", "invoice_ref", "S1001");
    });
    editCsv(ws, "customers.csv", (t) => `${t}C009,Alpha Fabs Limited,Zed Zulu,5 Hidden Lane,,Hull,HU9 9ZZ,zed@zulu.example.test,01110 999999,\n`);
    await runCli(ws);
    for (const f of readdirSync(ws.out)) {
      const text = readFileSync(path.join(ws.out, f), "utf8");
      for (const secret of ["Alpha", "Beta", "Gamma", "Steel", "Tooling", "Zed", "Zulu", "Hidden Lane", "example.test", "01110", "Mill Lane", "Foundry", "Sheffield", "LS1 1AA", "GB000000001"]) {
        expect({ f, secret, found: text.includes(secret) }).toEqual({ f, secret, found: false });
      }
    }
  });
});

describe("running it", () => {
  it("the default mapping is the importer's provisional one and stops with the list when its headers are not there", async () => {
    const ws = workspace();
    const stderr: string[] = [];
    const code = await main(["--sliq", ws.sliq, "--tolra", ws.tolra, "--out", ws.out], { stdout: () => {}, stderr: (t: string) => stderr.push(t) });
    expect(code).toBe(EXIT.INPUT);
    expect(stderr.join("\n")).toContain("Provisional mapping");
    expect(existsSync(ws.out)).toBe(false);
  });

  it("reads a single JSON snapshot file the same as a folder", async () => {
    const ws = workspace();
    const tables: Record<string, unknown> = {};
    let meta: unknown = {};
    for (const f of readdirSync(ws.tolra)) {
      const json = JSON.parse(readFileSync(path.join(ws.tolra, f), "utf8"));
      if (f === "meta.json") meta = json;
      else tables[f.replace(/\.json$/, "")] = json;
    }
    const single = path.join(ws.root, "snapshot.json");
    (await import("node:fs")).writeFileSync(single, JSON.stringify({ meta, tables }));
    const one = await runCli(ws, [], ["--sliq", ws.sliq, "--tolra", single, "--out", path.join(ws.root, "out-single"), "--mapping", "synthetic"]);
    expect(one.code).toBe(EXIT.OK);
    await runCli(ws);
    expect(readFileSync(path.join(ws.root, "out-single", "mismatches.csv"), "utf8")).toBe(readFileSync(path.join(ws.out, "mismatches.csv"), "utf8"));
  });

  it("refuses a snapshot whose money is not exact (nothing is rounded), and a malformed one", async () => {
    const ws = workspace();
    editTable(ws, "invoices", (rows) => {
      rows[1].total = "120.005";
      rows[2].due_date = "31/03/2026";
    });
    const r = await runCli(ws);
    expect(r.code).toBe(EXIT.INPUT);
    expect(r.stderr).toContain("more than two decimal places");
    expect(r.stderr).toContain("ISO date");
    expect(existsSync(ws.out)).toBe(false);
    const ws2 = workspace();
    cpSync(path.join(ws2.tolra, "invoices.json"), path.join(mkdtempSync(path.join(tmpdir(), "x-")), "invoices.json"));
    editTable(ws2, "customers", (rows) => rows.map(({ name, ...r }) => (void name, r)));
    expect((await runCli(ws2)).stderr).toContain("required column is not in the snapshot rows");
  });

  it("an unknown table in the snapshot is ignored and said so, never read", async () => {
    const ws = workspace();
    (await import("node:fs")).writeFileSync(path.join(ws.tolra, "user_profiles.json"), JSON.stringify([{ id: "1", email: "x@example.test" }]));
    const { rows } = await analyse(ws);
    expect(rows.find((r: Row) => r.code === "snapshot_table_ignored")).toMatchObject({ severity: "INFO", identifier: "table=user_profiles" });
    expect(JSON.stringify(rows)).not.toContain("example.test");
  });
});
