import { writeFileSync } from "node:fs";

import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { documentTotals, linePence, toPence } from "@/lib/money";
import { verifyBackendIdentity } from "../support/fixtures";
import { isolatedBackend } from "../support/isolation";

// One-off money parity proof (workflow money-parity.yml): the 38 tie cases of the JNR reconciliation tie table, each
// computed by the real lib/money.ts and by real PostgreSQL numeric on the verified disposable backend, both compared
// with the fixed expected pence. Read-only SELECTs; no rows, no SQL installed. Decimal inputs travel as strings.
// Rule: half away from zero to the penny (0.135 -> 0.14); VAT per line, as 016_document_economics.sql and
// 030_vat_registration_totals.sql: round(round(quantity * unit_price, 2) * vat_pct / 100, 2).
type Tie = { kind: "to_pence" | "line_pence" | "vat_pence"; a: string; b: string; expected: number };
const T = (kind: Tie["kind"], a: string, b: string, expected: number): Tie => ({ kind, a, b, expected });

const TIES: Tie[] = [
  T("to_pence", "0.125", "0", 13), T("to_pence", "0.135", "0", 14), T("to_pence", "0.145", "0", 15),
  T("to_pence", "0.155", "0", 16), T("to_pence", "0.165", "0", 17), T("to_pence", "1.005", "0", 101),
  T("to_pence", "2.675", "0", 268), T("to_pence", "0.005", "0", 1), T("to_pence", "0.015", "0", 2),
  T("to_pence", "0.025", "0", 3), T("to_pence", "0.035", "0", 4), T("to_pence", "0.045", "0", 5),
  T("to_pence", "-0.125", "0", -13), T("to_pence", "-0.135", "0", -14), T("to_pence", "-0.005", "0", -1),
  T("to_pence", "-0.025", "0", -3), T("to_pence", "0.0049", "0", 0), T("to_pence", "0.0051", "0", 1),
  T("to_pence", "2.5", "0", 250), T("to_pence", "0.5", "0", 50), T("to_pence", "1.5", "0", 150),
  // quantity, unit price (pounds)
  T("line_pence", "0.5", "0.05", 3), T("line_pence", "1.5", "0.01", 2), T("line_pence", "3", "0.835", 251),
  T("line_pence", "0.125", "1", 13), T("line_pence", "0.02", "7.25", 15), T("line_pence", "2.5", "0.01", 3),
  T("line_pence", "0.5", "0.03", 2),
  // one line of quantity 1 at net pence a, VAT rate b percent: the VAT in pence
  T("vat_pence", "50", "5", 3), T("vat_pence", "250", "5", 13), T("vat_pence", "150", "5", 8),
  T("vat_pence", "10", "25", 3), T("vat_pence", "30", "5", 2), T("vat_pence", "130", "5", 7),
  T("vat_pence", "90", "5", 5), T("vat_pence", "70", "5", 4), T("vat_pence", "3", "50", 2),
  T("vat_pence", "1", "50", 1),
];

const SQL: Record<Tie["kind"], string> = {
  to_pence: "SELECT (round($1::numeric, 2) * 100)::bigint::text AS pence",
  line_pence: "SELECT (round($1::numeric * $2::numeric, 2) * 100)::bigint::text AS pence",
  vat_pence: "SELECT (round(round(1::numeric * ($1::numeric / 100), 2) * $2::numeric / 100, 2) * 100)::bigint::text AS pence",
};

function app(tie: Tie): number {
  const a = Number(tie.a);
  const b = Number(tie.b);
  if (tie.kind === "to_pence") return toPence(a);
  if (tie.kind === "line_pence") return linePence(a, b);
  return toPence(documentTotals([{ quantity: 1, unitPrice: a / 100, vatPct: b }], 0, {}).vat);
}

let db: Client;
const rows: Array<Tie & { ts: number; sql: string }> = [];

beforeAll(async () => {
  await verifyBackendIdentity(); // Missing or non-disposable backend fails here; no optional skip.
  db = new Client({ connectionString: isolatedBackend().databaseUrl });
  await db.connect();
});

afterAll(async () => {
  await db?.end();
  const out = process.env.MONEY_PARITY_TIES_OUT;
  if (out) writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`);
});

it.each(TIES)("tie $kind($a, $b) = $expected pence in lib/money.ts and PostgreSQL numeric", async (tie) => {
  const sql = (await db.query<{ pence: string }>(SQL[tie.kind], tie.kind === "to_pence" ? [tie.a] : [tie.a, tie.b])).rows[0].pence;
  const ts = app(tie);
  rows.push({ ...tie, ts, sql });
  expect(sql, `PostgreSQL ${tie.kind}(${tie.a}, ${tie.b})`).toBe(String(tie.expected));
  expect(ts, `lib/money.ts ${tie.kind}(${tie.a}, ${tie.b})`).toBe(tie.expected);
});
