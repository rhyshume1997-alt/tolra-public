import { expect, it } from "vitest";

import { documentTotals, linePence, toPence } from "@/lib/money";
import { documentCases, lineCases, pennyCases } from "../fixtures/money-rounding-cases";
import { verifyBackendIdentity, withDb } from "../support/fixtures";

// Read-only SELECTs on the verified disposable backend. No schema install or business rows.
// Exercises PostgreSQL numeric itself, never a JS imitation of database rounding.
it("CL: app and real PostgreSQL agree on penny ties, fractional lines and per-line VAT", async () => {
  await verifyBackendIdentity(); // Missing/hosted backend fails this test; no optional skip.
  await withDb(async (db) => {
    for (const { pounds, pence } of pennyCases) {
      const result = await db.query<{ pence: string }>(
        "SELECT (round($1::numeric, 2) * 100)::bigint::text AS pence", [String(pounds)],
      );
      expect(result.rows[0].pence, `PostgreSQL scalar ${pounds}`).toBe(String(pence));
      expect(toPence(pounds), `app scalar ${pounds}`).toBe(Number(result.rows[0].pence));
    }
    for (const { quantity, unitPrice, pence } of lineCases) {
      const result = await db.query<{ pence: string }>(
        "SELECT (round($1::numeric * $2::numeric, 2) * 100)::bigint::text AS pence",
        [String(quantity), String(unitPrice)],
      );
      expect(result.rows[0].pence, `PostgreSQL line ${quantity} x ${unitPrice}`).toBe(String(pence));
      expect(linePence(quantity, unitPrice)).toBe(Number(result.rows[0].pence));
    }
    for (const example of documentCases) {
      // Same numeric line/VAT expression used in 016_document_economics.sql and
      // 030_vat_registration_totals.sql. This proves arithmetic, not document-write permissions.
      const result = await db.query<{ subtotal: string; vat: string; total: string }>(`
        WITH lines AS (
          SELECT round(quantity * unit_price, 2) AS net, vat_pct
          FROM jsonb_to_recordset($1::jsonb) AS x(quantity numeric, unit_price numeric, vat_pct numeric)
        ), totals AS (
          SELECT sum(net) AS net, sum(round(net * vat_pct / 100, 2)) AS vat FROM lines
        )
        SELECT (net * 100)::bigint::text AS subtotal, (vat * 100)::bigint::text AS vat,
          ((net + vat) * 100)::bigint::text AS total FROM totals
      `, [JSON.stringify(example.lines.map(line => ({ quantity: String(line.quantity), unit_price: String(line.unitPrice), vat_pct: String(line.vatPct) })))]);
      const sql = result.rows[0];
      const app = documentTotals([...example.lines]);
      for (const field of ["subtotal", "vat", "total"] as const) {
        expect(sql[field], `${example.name}: SQL ${field}`).toBe(String(example[field]));
        expect(toPence(app[field]), `${example.name}: app ${field}`).toBe(Number(sql[field]));
      }
    }
  });
});
