/**
 * Helpers for the SliQ reconciliation tests: a throw-away copy of the synthetic clean fixture (SliQ CSVs + a Tolra snapshot
 * folder) that a test then corrupts in one place, and wrappers that run the comparison with the clock fixed.
 * Synthetic data only: nothing here is, or may become, real JNR data.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { main } from "../../scripts/sliq-reconcile/cli.mjs";
import { reconcile } from "../../scripts/sliq-reconcile/engine.mjs";
import { loadSnapshot } from "../../scripts/sliq-reconcile/snapshot.mjs";
import { loadSource } from "../../scripts/sliq-reconcile/source.mjs";
import { parseCsv } from "../../scripts/sliq-import/parse.mjs";

export const FIXTURE = path.resolve(__dirname, "../fixtures/sliq-reconcile/clean");
export const GENERATED_AT = "2026-10-13T09:00:00Z";
export const ORG = "11111111-2222-4333-8444-555555555555";

export type Row = { area: string; code: string; identifier: string; field: string; source_value: string; target_value: string; difference: string; severity: string; reason: string };
export type Ws = { root: string; sliq: string; tolra: string; out: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export function workspace(): Ws {
  const root = mkdtempSync(path.join(tmpdir(), "sliq-reconcile-"));
  const ws = { root, sliq: path.join(root, "sliq"), tolra: path.join(root, "tolra"), out: path.join(root, "out") };
  cpSync(path.join(FIXTURE, "sliq"), ws.sliq, { recursive: true });
  cpSync(path.join(FIXTURE, "tolra"), ws.tolra, { recursive: true });
  return ws;
}

/** Edit a SliQ CSV as text. */
export function editCsv(ws: Ws, file: string, fn: (text: string) => string) {
  const p = path.join(ws.sliq, file);
  const before = readFileSync(p, "utf8");
  const after = fn(before);
  if (after === before) throw new Error(`editCsv(${file}): the edit changed nothing`);
  writeFileSync(p, after);
}

/** Edit a Tolra snapshot table (the rows array) in place. Returning a value replaces the rows. */
export function editTable(ws: Ws, name: string, fn: (rows: Any[]) => Any[] | void) {
  const p = path.join(ws.tolra, `${name}.json`);
  const rows = JSON.parse(readFileSync(p, "utf8"));
  const next = fn(rows) ?? rows;
  writeFileSync(p, `${JSON.stringify(next, null, 2)}\n`);
}

/** The id of the snapshot row whose `col` is `ref` (to point one row at another). */
export function idOf(ws: Ws, table: string, col: string, ref: string): string {
  const rows = JSON.parse(readFileSync(path.join(ws.tolra, `${table}.json`), "utf8"));
  const hit = rows.find((r: Any) => r[col] === ref);
  if (!hit) throw new Error(`${table} has no row with ${col} = ${ref}`);
  return hit.id;
}

export const dropTable = (ws: Ws, name: string) => rmSync(path.join(ws.tolra, `${name}.json`));
export const dropCsv = (ws: Ws, file: string) => rmSync(path.join(ws.sliq, file));
export const byRef = (rows: Any[], key: string, ref: string) => rows.find((r) => r[key] === ref);

export async function analyse(ws: Ws, mapping = "synthetic"): Promise<{ rows: Row[]; stats: Any }> {
  const src = await loadSource(ws.sliq, { mapping });
  const { snapshot } = await loadSnapshot(ws.tolra);
  return reconcile(src, snapshot);
}

/** The rows with a given code, optionally narrowed to an identifier that contains `id`. */
export const pick = (rows: Row[], code: string, id?: string) => rows.filter((r) => r.code === code && (id === undefined || r.identifier.includes(id)));
export const first = (rows: Row[], code: string, id?: string) => {
  const hit = pick(rows, code, id)[0];
  if (!hit) throw new Error(`no row with code ${code}${id ? ` for ${id}` : ""}. Codes seen: ${[...new Set(rows.map((r) => `${r.code}[${r.identifier}]`))].join("; ")}`);
  return hit;
};

export async function runCli(ws: Ws, extra: string[] = [], args?: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(args ?? ["--sliq", ws.sliq, "--tolra", ws.tolra, "--out", ws.out, "--mapping", "synthetic", ...extra], { stdout: (t: string) => stdout.push(t), stderr: (t: string) => stderr.push(t) }, { generatedAt: GENERATED_AT });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

export function readCsvRows(file: string): Row[] {
  const { headers, rows } = parseCsv(readFileSync(file, "utf8"));
  return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]]))) as Row[];
}
