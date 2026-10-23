/**
 * The report folder never overwrites a file this tool did not write, even under --allow-other-files, and an identifier key that is
 * not on the output allowlist is never echoed by any error. Synthetic data only.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { EXIT } from "../../scripts/sliq-reconcile/cli.mjs";
import { GENERATED_NAMES, MARKER_FORMAT, MARKER_NAME, sha256 } from "../../scripts/sliq-reconcile/output.mjs";
import { ids, makeCollector } from "../../scripts/sliq-reconcile/rows.mjs";
import { SafeError } from "../../scripts/sliq-reconcile/safe.mjs";
import { editCsv, editTable, runCli, workspace, type Ws } from "../support/sliq-reconcile";

const all = (dir: string) => Object.fromEntries(readdirSync(dir).sort().map((f) => [f, lstatSync(path.join(dir, f)).isFile() ? readFileSync(path.join(dir, f), "utf8") : "<not a file>"]));
const marker = (ws: Ws) => JSON.parse(readFileSync(path.join(ws.out, MARKER_NAME), "utf8")) as { format: string; files: Record<string, string> };

describe("a file the tool did not write is protected, whatever its name, even with --allow-other-files", () => {
  it("a foreign summary.json / mismatches.csv is refused and left byte-identical (with and without the flag)", async () => {
    for (const extra of [["--allow-other-files"], []]) {
      const ws = workspace();
      mkdirSync(ws.out);
      writeFileSync(path.join(ws.out, "summary.json"), '{"mine":"precious"}');
      writeFileSync(path.join(ws.out, "mismatches.csv"), "a,b\n1,2\n");
      writeFileSync(path.join(ws.out, "notes.txt"), "notes");
      const before = all(ws.out);
      const r = await runCli(ws, extra);
      expect(r.code).toBe(EXIT.INPUT);
      expect(r.stderr).toMatch(/cannot prove it wrote|did not write/);
      expect(all(ws.out)).toEqual(before);
    }
  });

  it("every file name the tool writes is protected, one at a time", async () => {
    const ws0 = workspace();
    expect((await runCli(ws0)).code).toBe(EXIT.OK);
    const written = Object.keys(marker(ws0).files);
    expect(written).toContain("mismatches.csv");
    expect(written.every((n) => GENERATED_NAMES.has(n))).toBe(true);
    for (const name of GENERATED_NAMES) {
      const ws = workspace();
      mkdirSync(ws.out);
      writeFileSync(path.join(ws.out, name), `foreign ${name}`);
      const r = await runCli(ws, ["--allow-other-files"]);
      expect({ name, code: r.code }).toEqual({ name, code: EXIT.INPUT });
      expect(all(ws.out)).toEqual({ [name]: `foreign ${name}` });
    }
  });

  it("a file the marker does not list is refused even beside a valid marker, and nothing is removed", async () => {
    const ws = workspace();
    expect((await runCli(ws)).code).toBe(EXIT.OK);
    const m = marker(ws);
    delete m.files["summary.md"]; // as if summary.md had been put there by someone else
    writeFileSync(path.join(ws.out, MARKER_NAME), JSON.stringify(m));
    const before = all(ws.out);
    const r = await runCli(ws, ["--allow-other-files"]);
    expect(r.code).toBe(EXIT.INPUT);
    expect(r.stderr).toContain("summary.md");
    expect(all(ws.out)).toEqual(before);
  });

  it("a previous run's outputs are replaced on a re-run, with or without the flag, and the marker follows", async () => {
    const ws = workspace();
    expect((await runCli(ws)).code).toBe(EXIT.OK);
    const first = all(ws.out);
    expect(Object.keys(first)).toContain(MARKER_NAME);
    expect(marker(ws).format).toBe(MARKER_FORMAT);
    expect(Object.keys(marker(ws).files)).not.toContain(MARKER_NAME);
    for (const [name, sha] of Object.entries(marker(ws).files)) expect(sha256(first[name])).toBe(sha);
    // identical inputs: a byte-identical folder (the marker holds no clock when the clock is fixed)
    expect((await runCli(ws)).code).toBe(EXIT.OK);
    expect(all(ws.out)).toEqual(first);
    expect((await runCli(ws, ["--allow-other-files"])).code).toBe(EXIT.OK);
    expect(all(ws.out)).toEqual(first);
    // different inputs: the changed files are replaced and a file the new run no longer writes is removed
    editTable(ws, "invoices", (rows) => {
      rows.find((r) => r.invoice_ref === "S1002").amount_paid = "150.00";
    });
    expect((await runCli(ws, ["--allow-other-files"])).code).toBe(EXIT.BLOCKERS);
    const second = all(ws.out);
    expect(second["mismatches.csv"]).not.toBe(first["mismatches.csv"]);
    for (const [name, sha] of Object.entries(marker(ws).files)) expect(sha256(second[name])).toBe(sha);
    expect(Object.keys(second).sort()).toEqual([MARKER_NAME, ...Object.keys(marker(ws).files)].sort());
  });

  it("a previous output edited by hand (its SHA-256 changed) is refused and left as it is", async () => {
    for (const edited of ["summary.json", "mismatches.csv", "summary.md"]) {
      const ws = workspace();
      expect((await runCli(ws)).code).toBe(EXIT.OK);
      writeFileSync(path.join(ws.out, edited), `${readFileSync(path.join(ws.out, edited), "utf8")}\nmy note`);
      const before = all(ws.out);
      for (const extra of [["--allow-other-files"], []]) {
        const r = await runCli(ws, extra);
        expect({ edited, code: r.code }).toEqual({ edited, code: EXIT.INPUT });
        expect(r.stderr).toContain("SHA-256 differs");
        expect(all(ws.out)).toEqual(before);
      }
    }
  });

  it("a stale output the run no longer writes is removed only if it is unchanged since written", async () => {
    const ws = workspace();
    expect((await runCli(ws)).code).toBe(EXIT.OK);
    // pretend an earlier run also wrote a file this run does not
    const stale = [...GENERATED_NAMES].find((n) => !(n in marker(ws).files)) as string;
    expect(stale).toBeTruthy();
    writeFileSync(path.join(ws.out, stale), "old\n");
    const m = marker(ws);
    m.files[stale] = sha256("old\n");
    writeFileSync(path.join(ws.out, MARKER_NAME), JSON.stringify(m));
    expect((await runCli(ws)).code).toBe(EXIT.OK);
    expect(existsSync(path.join(ws.out, stale))).toBe(false);
    // the same, but edited by hand: refused, kept
    writeFileSync(path.join(ws.out, stale), "old\n");
    m.files[stale] = sha256("old\n");
    writeFileSync(path.join(ws.out, MARKER_NAME), JSON.stringify(m));
    writeFileSync(path.join(ws.out, stale), "edited\n");
    expect((await runCli(ws)).code).toBe(EXIT.INPUT);
    expect(readFileSync(path.join(ws.out, stale), "utf8")).toBe("edited\n");
  });

  it("a folder or a link with a generated name is refused (never replaced or written through)", async () => {
    const ws = workspace();
    expect((await runCli(ws)).code).toBe(EXIT.OK);
    const elsewhere = path.join(ws.root, "elsewhere.txt");
    writeFileSync(elsewhere, "mine");
    rmSyncSafe(path.join(ws.out, "summary.md"));
    symlinkSync(elsewhere, path.join(ws.out, "summary.md"));
    expect((await runCli(ws, ["--allow-other-files"])).code).toBe(EXIT.INPUT);
    expect(readFileSync(elsewhere, "utf8")).toBe("mine");
    expect(lstatSync(path.join(ws.out, "summary.md")).isSymbolicLink()).toBe(true);
  });

  it("the foreign-file refusal without the flag stays, and names no file", async () => {
    const ws = workspace();
    mkdirSync(ws.out);
    writeFileSync(path.join(ws.out, "Zed Zulu zed@zulu.example.test.xlsx"), "x");
    const r = await runCli(ws);
    expect(r.code).toBe(EXIT.INPUT);
    expect(r.stderr).toContain("--allow-other-files");
    expect(r.stderr).not.toMatch(/Zed|Zulu|zulu/);
    expect((await runCli(ws, ["--allow-other-files"])).code).toBe(EXIT.OK);
    expect(readFileSync(path.join(ws.out, "Zed Zulu zed@zulu.example.test.xlsx"), "utf8")).toBe("x");
  });
});

const rmSyncSafe = (p: string) => rmSync(p, { force: true, recursive: true });

describe("the marker cannot be used to escape the report folder", () => {
  const victim = (ws: Ws) => path.join(ws.root, "victim.txt");
  const bad = ["../victim.txt", "..", "../../victim.txt", "sub/summary.json", "sub\\summary.json", "/etc/passwd", path.join("..", "victim.txt"), "", ".", "summary.json/", "mismatches-nope.csv", MARKER_NAME, ".sliq-reconcile-tmp-1-a-0"];

  it("rejects separators, '..' and any name the tool does not generate, and touches nothing", async () => {
    for (const name of bad) {
      const ws = workspace();
      writeFileSync(victim(ws), "victim");
      expect((await runCli(ws)).code).toBe(EXIT.OK);
      const m = marker(ws);
      m.files[name] = sha256("victim");
      writeFileSync(path.join(ws.out, MARKER_NAME), JSON.stringify(m));
      const before = all(ws.out);
      for (const extra of [["--allow-other-files"], []]) {
        const r = await runCli(ws, extra);
        expect({ name, code: r.code }).toEqual({ name, code: EXIT.INPUT });
        expect(r.stderr).toContain("not a valid marker");
        expect(r.stderr).not.toContain("victim");
      }
      expect(all(ws.out)).toEqual(before);
      expect(readFileSync(victim(ws), "utf8")).toBe("victim");
    }
  });

  it("rejects a __proto__ entry (an own property once parsed)", async () => {
    const ws = workspace();
    expect((await runCli(ws)).code).toBe(EXIT.OK);
    writeFileSync(path.join(ws.out, MARKER_NAME), `{"format":"${MARKER_FORMAT}","files":{"__proto__":"${sha256("x")}"}}`);
    expect((await runCli(ws)).code).toBe(EXIT.INPUT);
  });

  it("rejects a marker that is not ours: bad JSON, wrong format, a list instead of an object, a bad checksum, a link, a folder", async () => {
    const make = async () => {
      const ws = workspace();
      expect((await runCli(ws)).code).toBe(EXIT.OK);
      return ws;
    };
    const cases: [string, (ws: Ws) => void][] = [
      ["bad json", (ws) => writeFileSync(path.join(ws.out, MARKER_NAME), "{not json Zed Zulu")],
      ["wrong format", (ws) => writeFileSync(path.join(ws.out, MARKER_NAME), JSON.stringify({ format: "other/1", files: {} }))],
      ["list", (ws) => writeFileSync(path.join(ws.out, MARKER_NAME), JSON.stringify({ format: MARKER_FORMAT, files: ["summary.json"] }))],
      ["bad sha", (ws) => writeFileSync(path.join(ws.out, MARKER_NAME), JSON.stringify({ format: MARKER_FORMAT, files: { "summary.json": "abc" } }))],
      ["link", (ws) => {
        const real = path.join(ws.root, "real-marker.json");
        writeFileSync(real, readFileSync(path.join(ws.out, MARKER_NAME)));
        rmSyncSafe(path.join(ws.out, MARKER_NAME));
        symlinkSync(real, path.join(ws.out, MARKER_NAME));
      }],
      ["folder", (ws) => {
        rmSyncSafe(path.join(ws.out, MARKER_NAME));
        mkdirSync(path.join(ws.out, MARKER_NAME));
      }],
    ];
    for (const [label, corrupt] of cases) {
      const ws = await make();
      corrupt(ws);
      const before = all(ws.out);
      const r = await runCli(ws, ["--allow-other-files"]);
      expect({ label, code: r.code }).toEqual({ label, code: EXIT.INPUT });
      expect(r.stderr).toContain("not a valid marker");
      expect(r.stderr).not.toContain("Zed");
      expect(all(ws.out)).toEqual(before);
    }
  });

  it("a marker listing a file that is gone is fine", async () => {
    const ws = workspace();
    expect((await runCli(ws)).code).toBe(EXIT.OK);
    const gone = [...GENERATED_NAMES].find((n) => !(n in marker(ws).files)) as string;
    const m = marker(ws);
    m.files[gone] = sha256("never written");
    writeFileSync(path.join(ws.out, MARKER_NAME), JSON.stringify(m));
    expect((await runCli(ws)).code).toBe(EXIT.OK);
    expect(Object.keys(marker(ws).files)).not.toContain(gone);
  });
});

describe("an identifier key outside the allowlist is never echoed", () => {
  const hostile = [
    "jane.doe@example.test",
    "+44 7700 900123",
    "12 Hidden Lane, Hull HU9 9ZZ",
    "Zed Zulu",
    "line one\nline two\r\n\u0000\u001b[31mred\u0007",
    "k".repeat(20000),
    '"quoted" `tick` ${x}',
  ];

  it("the thrown message is one constant, identical for every hostile key", () => {
    const messages = new Set<string>();
    for (const key of hostile) {
      for (const run of [() => ids({ [key]: "x" }), () => makeCollector().add({ area: "inputs", code: "c", ids: { [key]: "x" }, field: "f", severity: "INFO", reason: "r" })]) {
        let error: unknown;
        try {
          run();
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(SafeError);
        const message = (error as Error).message;
        expect(message).toBe("an identifier key is not on the output allowlist (scripts/sliq-reconcile/rows.mjs)");
        messages.add(message);
        expect(message.length).toBeLessThan(200);
        for (const part of [key, key.slice(0, 12), "Zed", "Hidden", "example", "7700"].filter((p) => p.trim().length > 3)) {
          if (key.includes(part)) expect({ key: key.slice(0, 20), leaked: message.includes(part) }).toEqual({ key: key.slice(0, 20), leaked: false });
        }
        expect(message).not.toMatch(/[\u0000-\u001f]/);
      }
    }
    expect([...messages]).toEqual(["an identifier key is not on the output allowlist (scripts/sliq-reconcile/rows.mjs)"]);
  });

  it("bad severity and area values give one constant message whatever the value", () => {
    for (const bad of hostile) {
      expect(() => makeCollector().add({ area: "inputs", code: "c", ids: {}, field: "f", severity: bad, reason: "r" })).toThrow(/^bad severity$/);
      expect(() => makeCollector().add({ area: bad, code: "c", ids: {}, field: "f", severity: "INFO", reason: "r" })).toThrow(/^bad area$/);
    }
  });
});

describe("input-derived text in the loaders' errors never reaches the terminal", () => {
  const SECRET = /Zed|Zulu|zulu|Smith|07700|900123|Hidden|HU9|example\.test/;

  it("a hostile file name, column header, mapping name and --sheet value", async () => {
    const cases: [string, (ws: Ws) => string[]][] = [
      ["unreadable workbook with a hostile name", (ws) => {
        writeFileSync(path.join(ws.sliq, "Mr Smith 07700 900123 zed@zulu.example.test.xlsx"), "not a workbook");
        return [];
      }],
      ["--sheet value", () => ["--sheet", "invoices=Zed Zulu 07700900123"]],
      ["--sheet value with a file", () => ["--sheet", "invoices=Mr Smith.xlsx:Zed Zulu"]],
      ["mapping file with invalid JSON and a hostile name", (ws) => {
        const f = path.join(ws.root, "Zed Zulu zed@zulu.example.test.json");
        writeFileSync(f, '{"Zed Zulu": ');
        return ["--mapping", f];
      }],
      ["mapping name that does not exist", () => ["--mapping", "Zed-Zulu-Smith"]],
      ["mapped columns that are hostile and absent from the files", (ws) => {
        const m = JSON.parse(readFileSync(path.join(__dirname, "../../scripts/sliq-reconcile/mappings/synthetic.json"), "utf8"));
        m.files.customers.columns.name = "Zed Zulu <zed@zulu.example.test> 07700 900123";
        m.files.customers.columns.bogusField = "Mr Smith";
        const f = path.join(ws.root, "hostile-mapping.json");
        writeFileSync(f, JSON.stringify(m));
        return ["--mapping", f];
      }],
      ["a duplicated hostile header", (ws) => {
        const m = JSON.parse(readFileSync(path.join(__dirname, "../../scripts/sliq-reconcile/mappings/synthetic.json"), "utf8"));
        m.files.customers.columns.name = "Zed Zulu 07700900123";
        const f = path.join(ws.root, "dup-mapping.json");
        writeFileSync(f, JSON.stringify(m));
        editCsv(ws, "customers.csv", (t) => t.replace("Name,", "Zed Zulu 07700900123,Zed Zulu 07700900123,"));
        return ["--mapping", f];
      }],
      ["a status word that is not in the mapping", (ws) => {
        editCsv(ws, "jobs.csv", (t) => t.replace("Machining", 'Zed "Zulu" Smith 07700900123'));
        return [];
      }],
      ["an unbalanced quote in a hostile file", (ws) => {
        writeFileSync(path.join(ws.sliq, "customers.csv"), 'Account,Name\n"Zed Zulu zed@zulu.example.test,unclosed\n');
        return [];
      }],
    ];
    for (const [label, setup] of cases) {
      const ws = workspace();
      const extra = setup(ws);
      const mapping = extra.includes("--mapping") ? [] : ["--mapping", "synthetic"];
      const r = await runCli(ws, [], ["--sliq", ws.sliq, "--tolra", ws.tolra, "--out", ws.out, ...mapping, ...extra]);
      expect({ label, code: r.code === EXIT.UNEXPECTED }).toEqual({ label, code: false });
      const text = [r.stdout, r.stderr, ...(existsSync(ws.out) ? Object.values(all(ws.out)) : [])].join("\n");
      expect({ label, leaked: text.match(SECRET)?.[0] ?? null }).toEqual({ label, leaked: null });
    }
  });

  it("an unexpected error is reported by name only: no message, no path", async () => {
    const ws = workspace();
    // meta.json as a folder makes the read fail with an operating-system error whose message holds a path
    cpSync(ws.tolra, path.join(ws.root, "tolra2"), { recursive: true });
    const t2 = path.join(ws.root, "tolra2");
    rmSyncSafe(path.join(t2, "meta.json"));
    mkdirSync(path.join(t2, "meta.json"));
    const r = await runCli(ws, [], ["--sliq", ws.sliq, "--tolra", t2, "--out", ws.out, "--mapping", "synthetic"]);
    expect(r.code).toBe(EXIT.UNEXPECTED);
    expect(r.stderr).toMatch(/unexpected error/);
    expect(r.stderr).not.toContain(ws.root);
    expect(r.stderr).not.toContain("meta.json");
    expect(existsSync(ws.out)).toBe(false);
  });
});

