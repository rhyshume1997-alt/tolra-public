/**
 * The reconciliation tool is offline and read only by construction. These tests prove it: forbidden endpoints are refused before
 * anything is read, there is no write option, nothing touches the network while it runs (fetch, net, http, https, tls, dns,
 * dgram and child_process are stubbed to throw and are never called), and no source file imports a network, database or
 * process module.
 */
import { spawnSync } from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import childProcess from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EXIT, main } from "../../scripts/sliq-reconcile/cli.mjs";
import { OfflineGuardError, PROJECT_REFS, assertOfflineArgs, describeForbidden } from "../../scripts/sliq-reconcile/screen.mjs";
import { parseCsv } from "../../scripts/sliq-import/parse.mjs";
import { buildXlsx } from "../support/make-xlsx.mjs";
import { GENERATED_AT, runCli, workspace } from "../support/sliq-reconcile";

const TOOL = path.resolve(__dirname, "../../scripts/sliq-reconcile");
const PRELOAD = path.resolve(__dirname, "../support/no-network.cjs");

afterEach(() => vi.restoreAllMocks());

const BAD = [
  "https://qtgqliczvyyrkibvxfqv.supabase.co",
  "http://localhost:54321",
  "postgres://postgres:postgres@127.0.0.1:54322/postgres",
  "postgresql://u:p@db.example.com:5432/app",
  "db.qngvemzbdsvtydkbplpo.supabase.co",
  "qtgqliczvyyrkibvxfqv",
  "qngvemzbdsvtydkbplpo",
  "QNGVEMZBDSVTYDKBPLPO",
  "supabase.co",
  "host=db.internal dbname=app user=x",
  "user:secret@db.internal:5432",
  "localhost:5432",
  "localhost",
  "127.0.0.1",
  "10.0.0.5:5432",
  "example.com",
  "www.example.org",
  "api.example.io/v1",
  "file:///etc/passwd",
  "ftp://files.example.net/x",
  "jdbc:postgresql://db/app",
  "mongodb+srv://cluster0.example.net",
  "ws://example.test",
];

describe("forbidden endpoints are refused before anything is read", () => {
  it("names the kind of thing it saw", () => {
    expect(describeForbidden("https://x.test")).toMatch(/URL/);
    expect(describeForbidden("postgresql://u:p@h/db")).toMatch(/URL|database/);
    expect(describeForbidden("qngvemzbdsvtydkbplpo")).toMatch(/project reference/);
    expect(PROJECT_REFS).toEqual(["qtgqliczvyyrkibvxfqv", "qngvemzbdsvtydkbplpo"]);
  });

  for (const bad of BAD) {
    it(`refuses ${bad} as any value (exit 3, nothing created)`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), "sliq-reconcile-refuse-"));
      const out = path.join(root, "out");
      for (const option of ["--sliq", "--tolra", "--out", "--mapping", "--encoding", "--date-format", "--sheet", "--generated-at"]) {
        const argv = ["--sliq", path.join(root, "no-such-sliq"), "--tolra", path.join(root, "no-such-tolra"), "--out", out, option, bad];
        const stderr: string[] = [];
        const code = await main(argv, { stdout: () => {}, stderr: (t: string) => stderr.push(t) });
        expect({ option, code }).toEqual({ option, code: EXIT.REFUSED });
        expect(stderr.join("\n")).toContain("Refusing");
        expect(existsSync(out)).toBe(false);
      }
    });
  }

  it("also refuses the --option=value form and a bare positional", async () => {
    const stderr: string[] = [];
    const code = await main(["--sliq=https://x.test/a", "--tolra", "t", "--out", "o"], { stdout: () => {}, stderr: (t: string) => stderr.push(t) });
    expect(code).toBe(EXIT.REFUSED);
    expect(await main(["postgres://u:p@h/db"], { stdout: () => {}, stderr: () => {} })).toBe(EXIT.REFUSED);
    expect(() => assertOfflineArgs(["--sliq", "ok", "--out", "https://x"])).toThrow(OfflineGuardError);
  });

  it("has no write or connect option: each is refused, and unknown options are too (fail closed)", async () => {
    for (const option of ["--write", "--apply", "--commit", "--push", "--database-url", "--db", "--url", "--host", "--organization-id", "--org", "--supabase-url", "--install-importer", "--token"]) {
      const stderr: string[] = [];
      const code = await main(["--sliq", "a", "--tolra", "b", "--out", "c", option, "x"], { stdout: () => {}, stderr: (t: string) => stderr.push(t) });
      expect({ option, code }).toEqual({ option, code: EXIT.REFUSED });
      expect(stderr.join("\n")).toMatch(/no write path|not available/);
    }
    const stderr: string[] = [];
    expect(await main(["--sliq", "a", "--tolra", "b", "--out", "c", "--frobnicate", "x"], { stdout: () => {}, stderr: (t: string) => stderr.push(t) })).toBe(EXIT.INPUT);
    expect(stderr.join("\n")).toContain("Unknown option --frobnicate");
  });

  it("accepts ordinary local paths", () => {
    for (const ok of ["/tmp/sliq-export", "./out", "reports/2026-10-13", "C:\\Users\\office\\sliq", "snapshot.json", "tolra-snapshot", "dir/customers.csv", "DD/MM/YYYY", "customers=Sheet 1", "2026-10-13T09:00:00Z", "synthetic"]) {
      expect(describeForbidden(ok), ok).toBeNull();
    }
    expect(() => assertOfflineArgs(["--sliq", "/tmp/sliq-export", "--tolra", "snapshot.json", "--out", "./out"])).not.toThrow();
  });

  it("the report folder may not be inside, or around, an input folder", async () => {
    const ws = workspace();
    const stderr: string[] = [];
    const code = await main(["--sliq", ws.sliq, "--tolra", ws.tolra, "--out", path.join(ws.sliq, "report"), "--mapping", "synthetic"], { stdout: () => {}, stderr: (t: string) => stderr.push(t) });
    expect(code).toBe(EXIT.INPUT);
    expect(stderr.join("\n")).toContain("--out must not be");
    expect(existsSync(path.join(ws.sliq, "report"))).toBe(false);
  });
});

describe("zero outbound network while the tool runs", () => {
  function stubNetwork() {
    const calls: string[] = [];
    const trap = (name: string) => () => {
      calls.push(name);
      throw new Error(`network or process call attempted: ${name}`);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = (obj: any, key: string, label: string) => {
      if (typeof obj[key] === "function") vi.spyOn(obj, key).mockImplementation(trap(label));
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(trap("fetch") as never);
    for (const k of ["connect", "createConnection"]) spy(net, k, `net.${k}`);
    spy(net.Socket.prototype, "connect", "net.Socket#connect");
    for (const k of ["request", "get"]) {
      spy(http, k, `http.${k}`);
      spy(https, k, `https.${k}`);
    }
    spy(tls, "connect", "tls.connect");
    for (const k of ["lookup", "resolve", "resolve4", "resolve6"]) spy(dns, k, `dns.${k}`);
    spy(dgram, "createSocket", "dgram.createSocket");
    for (const k of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) spy(childProcess, k, `child_process.${k}`);
    return calls;
  }

  it("a full run on the clean fixture makes no network, DNS or process call", async () => {
    const calls = stubNetwork();
    const ws = workspace();
    const r = await runCli(ws);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(EXIT.OK);
    expect(calls).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(net.connect).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
    expect(https.request).not.toHaveBeenCalled();
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("a run that finds blockers, and a run that is refused, make none either", async () => {
    const calls = stubNetwork();
    const ws = workspace();
    const bad = JSON.parse(readFileSync(path.join(ws.tolra, "invoices.json"), "utf8"));
    bad[1].total = "1.00";
    writeFileSync(path.join(ws.tolra, "invoices.json"), JSON.stringify(bad));
    expect((await runCli(ws)).code).toBe(EXIT.BLOCKERS);
    expect((await main(["--sliq", "https://x.test"], { stdout: () => {}, stderr: () => {} })).valueOf()).toBe(EXIT.REFUSED);
    expect(calls).toEqual([]);
  });

  it("the Excel route (read-excel-file) is local too", async () => {
    const calls = stubNetwork();
    const ws = workspace();
    const sheet = (file: string) => {
      const { headers, rows } = parseCsv(readFileSync(path.join(ws.sliq, file), "utf8"));
      return [headers, ...rows];
    };
    writeFileSync(path.join(ws.sliq, "ledger.xlsx"), buildXlsx([{ name: "Customers", rows: sheet("customers.csv") }, { name: "Sales Invoices", rows: sheet("invoices.csv") }, { name: "Jobs", rows: sheet("jobs.csv") }]));
    for (const f of ["customers.csv", "invoices.csv", "jobs.csv"]) rmSync(path.join(ws.sliq, f));
    const mapping = JSON.parse(readFileSync(path.join(TOOL, "mappings/synthetic.json"), "utf8"));
    mapping.reconcile.files.jobs = { ...mapping.reconcile.files.jobs, file: "jobs-not-a-csv.csv", sheet: "Jobs" };
    const mappingFile = path.join(ws.root, "xlsx-mapping.json");
    writeFileSync(mappingFile, JSON.stringify(mapping));
    const r = await runCli(ws, [], ["--sliq", ws.sliq, "--tolra", ws.tolra, "--out", ws.out, "--mapping", mappingFile]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(EXIT.OK);
    const summary = JSON.parse(readFileSync(path.join(ws.out, "summary.json"), "utf8"));
    expect(summary.inputs.sliq.files.filter((f: { file: string }) => f.file === "ledger.xlsx").map((f: { kind: string; sheet: string }) => `${f.kind}:${f.sheet}`).sort()).toEqual(["customers:Customers", "invoices:Sales Invoices", "jobs:Jobs"]);
    expect(summary.counts.bySeverity).toMatchObject({ BLOCKER: 0, WARN: 0, INFO: 0, UNVERIFIED: 1 });
    expect(calls).toEqual([]);
  });

  it("as a real process under the repo's outbound-network guard, nothing is blocked (and nothing is attempted)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sliq-reconcile-proc-"));
    const log = path.join(root, "blocked.log");
    const ws = workspace();
    const env = { ...process.env, E2E_BLOCKED_LOG: log, HTTPS_PROXY: "", HTTP_PROXY: "", https_proxy: "", http_proxy: "", NODE_OPTIONS: "" };
    const result = spawnSync(process.execPath, ["--require", PRELOAD, path.join(TOOL, "cli.mjs"), "--sliq", ws.sliq, "--tolra", ws.tolra, "--out", ws.out, "--mapping", "synthetic", "--generated-at", GENERATED_AT], { env, encoding: "utf8", timeout: 60_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Dry run only: read only and offline");
    expect(existsSync(log)).toBe(false);
    expect(existsSync(path.join(ws.out, "summary.json"))).toBe(true);
    const refused = spawnSync(process.execPath, [path.join(TOOL, "cli.mjs"), "--sliq", ws.sliq, "--tolra", "postgres://u:p@h/db", "--out", ws.out], { env, encoding: "utf8" });
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain("Refusing");
  });
});

describe("static: the tool cannot reach out", () => {
  const files = readdirSync(TOOL).filter((f) => f.endsWith(".mjs"));
  const source = (f: string) => readFileSync(path.join(TOOL, f), "utf8");

  it("imports no network, database or process module, and not the importer's write module", () => {
    expect(files.length).toBeGreaterThan(8);
    const forbidden = /(?:from|import\(|require\()\s*["'](?:node:)?(?:http|https|http2|net|tls|dgram|dns|dns\/promises|child_process|cluster|worker_threads|inspector|repl|vm)["']|["'](?:pg|@supabase\/[\w-]+|undici|node-fetch|axios|ws)["']|sliq-import\/(?:write|guard)\.mjs/;
    for (const f of files) expect({ f, hit: forbidden.exec(source(f))?.[0] ?? null }).toEqual({ f, hit: null });
  });

  it("uses no fetch, XMLHttpRequest, WebSocket, environment variable or .env file", () => {
    const forbidden = /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|process\.env|\.env\b|dotenv|navigator\.sendBeacon/;
    for (const f of files) expect({ f, hit: forbidden.exec(source(f))?.[0] ?? null }).toEqual({ f, hit: null });
  });

  it("writes files only in output.mjs, and only into the report folder", () => {
    for (const f of files) {
      const writes = /writeFileSync|appendFileSync|createWriteStream|mkdirSync|rmSync|unlinkSync|renameSync|copyFileSync|rmdirSync|truncateSync|symlinkSync/.test(source(f));
      expect({ f, writes }).toEqual({ f, writes: f === "output.mjs" });
    }
    const out = source("output.mjs");
    // one writer, to a temporary name in the report folder (exclusive create), then a rename into place
    expect(out.match(/writeFileSync\(/g)).toHaveLength(1);
    expect(out).toContain('writeFileSync(tmp, text, { flag: "wx" })');
    expect(out.match(/renameSync\(tmp, target\)/g)).toHaveLength(1);
    expect(out).toContain("path.join(outDir, `.sliq-reconcile-tmp-");
    // the only deletion is of a file the marker lists and whose SHA-256 still matches (see inspectOutDir)
    expect(out.match(/unlinkSync\(/g)).toHaveLength(1);
    expect(out).toContain("for (const f of removable) if (!(f in files)) unlinkSync(path.join(outDir, f));");
  });
});
