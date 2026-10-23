/**
 * SliQ to Tolra reconciliation (offline, read only): the clean synthetic fixture reconciles with nothing unexplained, and each
 * corruption of it produces the expected rows with exact pence. Synthetic fixtures only (tests/fixtures/sliq-reconcile).
 */
import path from "node:path";

import { describe, expect, it } from "vitest";

import { legacyId } from "../../scripts/sliq-import/ids.mjs";
import { loadFolder } from "../../scripts/sliq-import/load.mjs";
import { getProfile } from "../../scripts/sliq-import/mapping.mjs";
import { analyse as importerAnalyse } from "../../scripts/sliq-import/reconcile.mjs";
import { loadSource } from "../../scripts/sliq-reconcile/source.mjs";

import { FIXTURE, ORG, analyse, dropCsv, dropTable, editCsv, editTable, first, idOf, pick, workspace, type Row } from "../support/sliq-reconcile";

const sev = (rows: Row[], s: string) => rows.filter((r) => r.severity === s);
// The ids in the generated snapshot are sequential uuids; find a row by a business key.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rowOf = (rows: any[], key: string, ref: string) => rows.find((r) => r[key] === ref);

describe("clean fixture", () => {
  it("has zero unexplained mismatches: only the one standing UNVERIFIED (WIP valuation)", async () => {
    const { rows, stats } = await analyse(workspace());
    expect(sev(rows, "BLOCKER")).toEqual([]);
    expect(sev(rows, "WARN")).toEqual([]);
    expect(sev(rows, "INFO")).toEqual([]);
    expect(rows.map((r) => [r.area, r.code, r.severity])).toEqual([["wip", "wip_valuation", "UNVERIFIED"]]);
    // ...which keeps the overall status at INCOMPLETE, never PASS, as long as any job is open
    const ws = workspace();
    editTable(ws, "jobs", (j) => j.forEach((r) => (r.finished_at = "2026-04-01")));
    editCsv(ws, "jobs.csv", (t) => t.replace("In Progress", "Finished"));
    expect((await analyse(ws)).rows).toEqual([]);
    expect(rows[0].reason).toContain("valuation: accountant to confirm");
    // the comparison really ran: every invoice matched through the importer's legacy id, and the totals are the hand-worked ones
    expect(stats.matching.invoices).toEqual({ byLegacyId: 10, byNumber: 0 });
    expect(stats.receivables.source).toBe(188600); // 960 + 340 + 300 + 96 + 40 owed on invoices, + 150 account-level opening
    expect(stats.receivables.target).toBe(188600);
    expect(stats.commitments.open_purchase_orders).toMatchObject({ sourceTotal: 25000, targetTotal: 25000 });
  });

  it("matches the exact arithmetic worked by hand: part payment, credit, reversal, refund", async () => {
    // S1002: 600.00 - 200.00 paid - 60.00 credit = 340.00; S1005: 96.00 paid then reversed = 96.00 owed; S1006: 120.00 - 150.00 + 30.00 refund = 0.00
    const ws = workspace();
    editTable(ws, "invoices", (rows) => {
      rowOf(rows, "invoice_ref", "S1002").credited_amount = "70.00"; // wrong on purpose, to read the numbers back
    });
    const { rows } = await analyse(ws);
    const out = first(rows, "invoice_outstanding", "S1002");
    expect(out).toMatchObject({ severity: "BLOCKER", source_value: "340.00", target_value: "330.00", difference: "-10.00" });
  });
});

describe("reuses the importer's identities, not a copy that could drift", () => {
  it("customers, suppliers and payments get exactly the legacy ids the importer would give them", async () => {
    const sliq = path.join(FIXTURE, "sliq");
    const plan = importerAnalyse(loadFolder(sliq, getProfile("synthetic")), { organizationId: ORG }).plan;
    const src = await loadSource(sliq, { mapping: "synthetic" });
    expect(src.customers.list.map((c: { identity: string }) => legacyId(ORG, "customers", c.identity))).toEqual(plan.customers.map((c: { oldId: number }) => c.oldId));
    expect(src.suppliers.list.map((c: { identity: string }) => legacyId(ORG, "suppliers", c.identity))).toEqual(plan.suppliers.map((c: { oldId: number }) => c.oldId));
    // the snapshot's legacy_import_map carries those same ids, so the recon follows the import's own route
    const { stats } = await analyse(workspace());
    expect(stats.matching.legacyIdsUsed).toBe(true);
  });

  it("the importer's provisional default mapping is flagged, and every file that mapping cannot supply is UNVERIFIED", async () => {
    const ws = workspace();
    const { loadSnapshot } = await import("../../scripts/sliq-reconcile/snapshot.mjs");
    const { reconcile } = await import("../../scripts/sliq-reconcile/engine.mjs");
    const src = await loadSource(path.resolve(__dirname, "../fixtures/sliq/provisional"), { mapping: "sliq" });
    const { snapshot } = await loadSnapshot(ws.tolra);
    const { rows } = reconcile(src, snapshot);
    expect(first(rows, "mapping_provisional")).toMatchObject({ area: "inputs", severity: "INFO" });
    for (const kind of ["refunds", "openingBalances", "jobs", "deliveries", "salesOrders", "supplierBills"]) expect(first(rows, "source_file_not_supplied", kind).severity).toBe("UNVERIFIED");
  });
});

describe("exact partial-payment arithmetic", () => {
  it("catches a 1p difference in a part payment (matched through the legacy id of the receipt)", async () => {
    const ws = workspace();
    editTable(ws, "invoice_payments", (rows) => {
      const p = rows.find((r) => r.amount === "100.00" && r.paid_on === "2026-03-10");
      p.amount = "99.99";
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "payment_amount", "S1002")).toMatchObject({ area: "payments", severity: "BLOCKER", source_value: "100.00", target_value: "99.99", difference: "-0.01" });
    // and Tolra's own books no longer agree with themselves: amount_paid 200.00 against rows adding to 199.99
    expect(first(rows, "tolra_paid_vs_rows", "S1002")).toMatchObject({ area: "target-integrity", severity: "BLOCKER", difference: "-0.01" });
  });

  it("flags amount paid and the outstanding balance when Tolra's part payment is short", async () => {
    const ws = workspace();
    editTable(ws, "invoices", (rows) => {
      rowOf(rows, "invoice_ref", "S1002").amount_paid = "150.00";
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "invoice_paid", "S1002")).toMatchObject({ severity: "BLOCKER", source_value: "200.00", target_value: "150.00", difference: "-50.00" });
    expect(first(rows, "invoice_outstanding", "S1002")).toMatchObject({ severity: "BLOCKER", source_value: "340.00", target_value: "390.00", difference: "50.00" });
    expect(first(rows, "total_outstanding")).toMatchObject({ source_value: "1886.00", target_value: "1936.00", difference: "50.00" });
    expect(first(rows, "customer_outstanding_total", "C002")).toMatchObject({ difference: "50.00" });
  });

  it("a payment missing in Tolra and a payment only in Tolra are both blockers", async () => {
    const ws = workspace();
    const s1002 = idOf(ws, "invoices", "invoice_ref", "S1002");
    editTable(ws, "invoice_payments", (rows) => rows.filter((r) => !(r.amount === "100.00" && r.paid_on === "2026-03-20")).concat([{ id: "extra-1", organization_id: ORG, invoice_id: s1002, amount: "5.00", paid_on: "2026-03-30", source: "recorded" }]));
    const { rows } = await analyse(ws);
    expect(first(rows, "payment_missing_in_tolra", "S1002")).toMatchObject({ severity: "BLOCKER", target_value: "(none)", difference: "-100.00" });
    expect(first(rows, "payment_only_in_tolra", "S1002")).toMatchObject({ severity: "BLOCKER", difference: "5.00" });
  });

  it("a reversal is compared as a negative receipt", async () => {
    const ws = workspace();
    editTable(ws, "invoice_payments", (rows) => rows.filter((r) => r.amount !== "-96.00"));
    editTable(ws, "invoices", (rows) => {
      rowOf(rows, "invoice_ref", "S1005").amount_paid = "96.00";
      rowOf(rows, "invoice_ref", "S1005").status = "paid";
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "reversal_missing_in_tolra", "S1005")).toMatchObject({ severity: "BLOCKER", source_value: "-96.00 on 2026-03-08", difference: "96.00" });
    expect(first(rows, "invoice_paid", "S1005")).toMatchObject({ source_value: "0.00", target_value: "96.00" });
    expect(first(rows, "status_settled_but_owed", "S1005")).toMatchObject({ severity: "BLOCKER", source_value: "owed 96.00", target_value: "paid" });
  });

  it("an invoice SliQ calls paid but whose payments leave a balance is UNVERIFIED, never assumed", async () => {
    const ws = workspace();
    editCsv(ws, "payments.csv", (t) => t.replace("S1001,05/03/2026,120.00,BACS,REF1", "S1001,05/03/2026,100.00,BACS,REF1"));
    const { rows } = await analyse(ws);
    expect(first(rows, "source_payment_state_unverified", "S1001")).toMatchObject({ area: "historical", severity: "UNVERIFIED" });
    expect(pick(rows, "invoice_paid", "S1001")).toEqual([]);
    expect(pick(rows, "invoice_outstanding", "S1001")).toEqual([]);
  });

  it("the same receipt listed twice is never summed: UNVERIFIED", async () => {
    const ws = workspace();
    editCsv(ws, "payments.csv", (t) => t.replace("S1004,12/03/2026,112.50,Card,", "S1004,12/03/2026,112.50,Card,\nS1004,12/03/2026,112.50,Card,"));
    const { rows } = await analyse(ws);
    expect(first(rows, "source_payment_state_unverified", "S1004").source_value).toContain("listed more than once");
    expect(sev(rows, "BLOCKER")).toEqual([]);
  });
});

describe("credit allocation, refunds", () => {
  it("a credit allocated for less in Tolra moves the allocation, the credited amount and the balance", async () => {
    const ws = workspace();
    editTable(ws, "invoice_credit_allocations", (rows) => {
      rows[0].amount = "50.00";
    });
    editTable(ws, "invoices", (rows) => {
      rowOf(rows, "invoice_ref", "S1002").credited_amount = "50.00";
    });
    editTable(ws, "credit_notes", (rows) => {
      rowOf(rows, "credit_ref", "CN-001").allocated_amount = "50.00";
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "allocation_amount", "CN-001>S1002")).toMatchObject({ area: "credits", severity: "BLOCKER", source_value: "60.00", target_value: "50.00", difference: "-10.00" });
    expect(first(rows, "invoice_credited", "S1002")).toMatchObject({ source_value: "60.00", target_value: "50.00", difference: "-10.00" });
    expect(first(rows, "invoice_outstanding", "S1002")).toMatchObject({ source_value: "340.00", target_value: "350.00", difference: "10.00" });
  });

  it("an allocation that is not in Tolra at all, and a credit note unallocated in SliQ but missing in Tolra", async () => {
    const ws = workspace();
    editTable(ws, "invoice_credit_allocations", () => []);
    editTable(ws, "invoices", (rows) => {
      rowOf(rows, "invoice_ref", "S1002").credited_amount = "0.00";
    });
    editTable(ws, "credit_notes", (rows) => rows.filter((r) => r.credit_ref !== "CN-002").map((r) => ({ ...r, allocated_amount: "0.00" })));
    const { rows } = await analyse(ws);
    expect(first(rows, "allocation_missing_in_tolra", "CN-001>S1002")).toMatchObject({ severity: "BLOCKER", source_value: "60.00", target_value: "(none)" });
    // CN-002 (24.00) is not applied to anything in SliQ, so losing it loses the customer's credit
    expect(first(rows, "credit_note_missing_in_tolra", "CN-002")).toMatchObject({ severity: "BLOCKER", difference: "-24.00" });
  });

  it("a credit note linked to the wrong invoice in Tolra", async () => {
    const ws = workspace();
    const s1002 = idOf(ws, "invoices", "invoice_ref", "S1002");
    editTable(ws, "credit_notes", (rows) => {
      const c = rowOf(rows, "credit_ref", "CN-002");
      c.invoice_id = s1002;
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "credit_invoice_link", "CN-002")).toMatchObject({ severity: "BLOCKER", source_value: "S1003", target_value: "S1002" });
  });

  it("an over-allocated credit note in SliQ is a blocker", async () => {
    const ws = workspace();
    editCsv(ws, "allocations.csv", (t) => `${t}CN-002,S1003,30.00,13/03/2026\n`);
    const { rows } = await analyse(ws);
    expect(first(rows, "source_credit_over_allocated", "CN-002")).toMatchObject({ severity: "BLOCKER", source_value: "30.00 of 24.00", difference: "6.00" });
  });

  it("a refund recorded differently in Tolra", async () => {
    const ws = workspace();
    editTable(ws, "customer_credit_ledger", (rows) => {
      rows[0].amount = "25.00";
    });
    editTable(ws, "invoices", (rows) => {
      rowOf(rows, "invoice_ref", "S1006").refunded_amount = "25.00";
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "invoice_refunded", "S1006")).toMatchObject({ area: "refunds", severity: "BLOCKER", source_value: "30.00", target_value: "25.00", difference: "-5.00" });
    expect(first(rows, "refund_missing_in_tolra", "S1006").severity).toBe("BLOCKER");
    expect(first(rows, "refund_only_in_tolra", "S1006").severity).toBe("BLOCKER");
    expect(first(rows, "invoice_outstanding", "S1006")).toMatchObject({ source_value: "0.00", target_value: "-5.00" });
  });

  it("no refunds file: a refund Tolra shows is UNVERIFIED, not assumed zero", async () => {
    const ws = workspace();
    dropCsv(ws, "refunds.csv");
    const { rows } = await analyse(ws);
    expect(first(rows, "source_file_not_supplied", "refunds").severity).toBe("UNVERIFIED");
    expect(first(rows, "refunded_unverified", "S1006")).toMatchObject({ severity: "UNVERIFIED", source_value: "(not supplied)", target_value: "30.00" });
    expect(pick(rows, "invoice_outstanding", "S1006")).toEqual([]);
    expect(sev(rows, "BLOCKER")).toEqual([]);
  });
});

describe("VAT", () => {
  it("a VAT difference of 50p on one invoice is a blocker on vat and gross", async () => {
    const ws = workspace();
    editTable(ws, "invoices", (rows) => {
      const i = rowOf(rows, "invoice_ref", "S1004");
      i.vat = "12.00";
      i.total = "112.00";
      i.amount_paid = "112.00";
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "invoice_vat", "S1004")).toMatchObject({ severity: "BLOCKER", source_value: "12.50", target_value: "12.00", difference: "-0.50" });
    expect(first(rows, "invoice_gross", "S1004")).toMatchObject({ source_value: "112.50", target_value: "112.00", difference: "-0.50" });
    expect(first(rows, "invoice_paid", "S1004")).toMatchObject({ source_value: "112.50", target_value: "112.00" });
  });

  it("VAT switched off in Tolra, and a different line rate", async () => {
    const ws = workspace();
    editTable(ws, "invoices", (rows) => {
      rowOf(rows, "invoice_ref", "S1003").vat_enabled = false;
    });
    editTable(ws, "invoice_line_items", (rows) => {
      rows.find((r) => r.description === "Item B").vat_pct = 20;
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "vat_switched_off", "S1003")).toMatchObject({ area: "receivables", severity: "BLOCKER", source_value: "VAT 50.00", target_value: "VAT off" });
    expect(first(rows, "line_vat_rate", "S1004")).toMatchObject({ severity: "BLOCKER", source_value: "5", target_value: "20" });
  });

  it("a zero-rated line that Tolra marks exempt is the same treatment; reverse charge is UNVERIFIED", async () => {
    const ws = workspace();
    editCsv(ws, "invoices.csv", (t) => t.replace("S1003,Invoice,03/03/2026,02/04/2026,C001,250.00,50.00,300.00,Issued,,,,,", "S1003,Invoice,03/03/2026,02/04/2026,C001,250.00,50.00,300.00,Issued,,,,RC,"));
    const { rows } = await analyse(ws);
    expect(pick(rows, "line_vat_rate", "S1007")).toEqual([]);
    expect(first(rows, "reverse_charge", "S1003")).toMatchObject({ severity: "UNVERIFIED" });
    expect(first(rows, "reverse_charge", "S1003").reason).toContain("accountant");
  });
});

describe("missing links and relationships", () => {
  it("an invoice missing in Tolra, an unknown customer, a payment and a credit allocation with no document", async () => {
    const ws = workspace();
    editTable(ws, "invoices", (rows) => rows.filter((r) => r.invoice_ref !== "S1003"));
    editCsv(ws, "payments.csv", (t) => `${t}S9999,01/03/2026,10.00,BACS,\n`);
    editCsv(ws, "allocations.csv", (t) => `${t}CN-099,S1001,5.00,13/03/2026\n`);
    editCsv(ws, "invoices.csv", (t) => t.replace("S1007,Invoice,07/03/2026,06/04/2026,C003", "S1007,Invoice,07/03/2026,06/04/2026,C777"));
    const { rows } = await analyse(ws);
    expect(first(rows, "invoice_missing_in_tolra", "S1003")).toMatchObject({ severity: "BLOCKER", target_value: "(none)", difference: "-300.00" });
    expect(first(rows, "payment_without_invoice", "S9999")).toMatchObject({ area: "relationships", severity: "BLOCKER" });
    expect(first(rows, "allocation_missing_link", "CN-099>S1001")).toMatchObject({ area: "relationships", severity: "BLOCKER" });
    expect(first(rows, "invoice_customer_not_found", "S1007")).toMatchObject({ area: "relationships", severity: "BLOCKER" });
  });

  it("a delivery with no job, order or invoice is UNVERIFIED, never attributed", async () => {
    const ws = workspace();
    editCsv(ws, "deliveries.csv", (t) => `${t}DN-0009,01/04/2026,,,,5\n`);
    const { rows } = await analyse(ws);
    expect(first(rows, "delivery_unlinked", "DN-0009")).toMatchObject({ area: "deliveries", severity: "UNVERIFIED" });
  });

  it("a credit note with no invoice link, and a sales order naming an unknown quote", async () => {
    const ws = workspace();
    editCsv(ws, "credit-notes.csv", (t) => t.replace("CN-002,11/03/2026,C001,20.00,4.00,24.00,S1003,Price adjustment,", "CN-002,11/03/2026,C001,20.00,4.00,24.00,,Price adjustment,"));
    editCsv(ws, "sales-orders.csv", (t) => t.replace("Q2002", "Q9999"));
    const { rows } = await analyse(ws);
    expect(first(rows, "credit_note_unlinked", "CN-002")).toMatchObject({ severity: "WARN" });
    expect(first(rows, "credit_link_not_in_source", "CN-002")).toMatchObject({ severity: "WARN", source_value: "(none)", target_value: "S1003" });
    expect(first(rows, "order_quote_not_found", "SO-0001")).toMatchObject({ severity: "WARN" });
  });
});

describe("duplicates and numbering collisions", () => {
  it("duplicate customers: the same name is a warning, or a blocker when one has open items; the same account code is a blocker", async () => {
    const ws = workspace();
    editCsv(ws, "customers.csv", (t) => `${t}C004,Delta Parts Ltd,,1 Road,,Hull,HU1 1AA,,,\nC005,"Delta Parts, Limited",,2 Road,,Hull,HU1 1AB,,,\nC006,"Alpha Fabrications, Ltd.",,9 Other Road,,Leeds,LS2 2BB,,,\nC001,Another Co,,1 Road,,Hull,HU1 1AA,,,\n`);
    const { rows } = await analyse(ws);
    const dup = pick(rows, "duplicate_customer_name");
    const delta = dup.find((r) => r.identifier.includes("C004"))!;
    expect(delta).toMatchObject({ area: "identity", severity: "WARN" });
    expect(delta.identifier).toContain("C005");
    const alpha = dup.find((r) => r.identifier.includes("C006"))!;
    expect(alpha.severity).toBe("BLOCKER"); // C001 has an open invoice
    expect(first(rows, "duplicate_customer_account", "C001")).toMatchObject({ severity: "BLOCKER" });
  });

  it("a document number used twice in SliQ, and twice in Tolra, is a blocker and is not compared", async () => {
    const ws = workspace();
    editCsv(ws, "invoices.csv", (t) => `${t}S1003,Invoice,10/03/2026,09/04/2026,C001,1.00,0.20,1.20,Issued,,,,,\n`);
    editTable(ws, "invoices", (rows) => {
      rows.push({ ...rowOf(rows, "invoice_ref", "S1001"), id: "dup-1" });
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "source_duplicate_number", "S1003")).toMatchObject({ area: "numbering", severity: "BLOCKER" });
    expect(first(rows, "tolra_duplicate_number", "S1001")).toMatchObject({ area: "numbering", severity: "BLOCKER" });
    expect(pick(rows, "invoice_gross", "S1003")).toEqual([]);
  });

  it("a number that already belongs to a record the import made from a different SliQ record", async () => {
    const ws = workspace();
    editTable(ws, "invoices", (rows) => {
      rowOf(rows, "invoice_ref", "S1003").invoice_ref = "S1003-OLD"; // the record the legacy id of S1003 points at has moved on...
      rowOf(rows, "invoice_ref", "S1005").invoice_ref = "S1003"; // ...and S1005's record now holds the number S1003
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "identity_conflict", "S1003")).toMatchObject({ area: "numbering", severity: "BLOCKER" });
  });

  it("a legacy id that leads to a record with a different number", async () => {
    const ws = workspace();
    editTable(ws, "invoices", (rows) => {
      rowOf(rows, "invoice_ref", "S1003").invoice_ref = "S1003A";
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "number_changed", "S1003")).toMatchObject({ severity: "BLOCKER", source_value: "S1003", target_value: "S1003A" });
  });

  it("a number used by a quote and an invoice is a warning (the lines file cannot tell them apart)", async () => {
    const ws = workspace();
    editCsv(ws, "quotes.csv", (t) => t.replace("Q2003", "S1003"));
    const { rows } = await analyse(ws);
    expect(first(rows, "cross_type_number", "S1003")).toMatchObject({ area: "numbering", severity: "WARN" });
  });

  it("matched by number only (no legacy map) is an INFO, and the importer's legacy ids are not needed", async () => {
    const ws = workspace();
    dropTable(ws, "legacy_import_map");
    const { rows, stats } = await analyse(ws);
    expect(stats.matching.invoices).toEqual({ byLegacyId: 0, byNumber: 10 });
    expect(first(rows, "matching_by_number")).toMatchObject({ area: "inputs", severity: "INFO" });
    expect(sev(rows, "BLOCKER")).toEqual([]);
    expect(sev(rows, "WARN")).toEqual([]);
  });
});

describe("open jobs, WIP and part deliveries", () => {
  it("stage and every quantity are compared, exact", async () => {
    const ws = workspace();
    editTable(ws, "jobs", (rows) => {
      const j = rowOf(rows, "job_no", "J-0001");
      j.stage = "inspection";
      j.quantity_required = 90;
    });
    editTable(ws, "job_quantities", (rows) => {
      const q = rows[0];
      q.quantity_made = 61;
      q.quantity_accepted = 45;
      q.quantity_rejected = 7;
      q.quantity_reworked = 3;
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "job_stage", "J-0001")).toMatchObject({ area: "wip", severity: "BLOCKER", source_value: "machining", target_value: "inspection" });
    expect(first(rows, "qty_ordered", "J-0001")).toMatchObject({ source_value: "100", target_value: "90", difference: "-10" });
    expect(first(rows, "qty_made", "J-0001")).toMatchObject({ source_value: "60", target_value: "61", difference: "1" });
    expect(first(rows, "qty_accepted", "J-0001")).toMatchObject({ source_value: "50", target_value: "45", difference: "-5" });
    expect(first(rows, "qty_rejected", "J-0001")).toMatchObject({ source_value: "6", target_value: "7", difference: "1" });
    expect(first(rows, "qty_reworked", "J-0001")).toMatchObject({ source_value: "4", target_value: "3", difference: "-1" });
    expect(first(rows, "qty_remaining", "J-0001")).toMatchObject({ source_value: "60", target_value: "50", difference: "-10" });
  });

  it("a missing part delivery changes quantity despatched and remaining", async () => {
    const ws = workspace();
    editTable(ws, "delivery_notes", (rows) => rows.filter((r) => r.dn_number !== "DN-0002"));
    const { rows } = await analyse(ws);
    expect(first(rows, "delivery_missing_in_tolra", "DN-0002")).toMatchObject({ area: "deliveries", severity: "BLOCKER", source_value: "quantity 15", difference: "-15" });
    expect(first(rows, "qty_despatched", "J-0001")).toMatchObject({ source_value: "40", target_value: "25", difference: "-15" });
    expect(first(rows, "qty_remaining", "J-0001")).toMatchObject({ source_value: "60", target_value: "75", difference: "15" });
  });

  it("a part delivery with a different quantity or attached to a different job", async () => {
    const ws = workspace();
    const j1 = idOf(ws, "jobs", "job_no", "J-0001");
    editTable(ws, "delivery_note_items", (rows) => {
      rows[0].quantity = "20";
    });
    editTable(ws, "delivery_notes", (rows) => {
      rowOf(rows, "dn_number", "DN-0003").job_id = j1;
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "delivery_quantity", "DN-0001")).toMatchObject({ source_value: "25", target_value: "20", difference: "-5" });
    expect(first(rows, "delivery_job", "DN-0003")).toMatchObject({ severity: "BLOCKER", source_value: "J-0002", target_value: "J-0001" });
  });

  it("Tolra cannot say how many were made: UNVERIFIED, not zero", async () => {
    const ws = workspace();
    editTable(ws, "job_quantities", (rows) => {
      rows[0].quantity_made = null;
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "qty_made_unverified", "J-0001")).toMatchObject({ severity: "UNVERIFIED", source_value: "60", target_value: "(unknown)" });
    expect(pick(rows, "qty_accepted", "J-0001")).toEqual([]);
  });

  it("no job_quantities table: every quantity Tolra cannot give is UNVERIFIED", async () => {
    const ws = workspace();
    dropTable(ws, "job_quantities");
    const { rows } = await analyse(ws);
    for (const c of ["qty_made", "qty_accepted", "qty_rejected", "qty_reworked"]) expect(first(rows, `${c}_unverified`, "J-0001")).toMatchObject({ severity: "UNVERIFIED", target_value: "(not supplied)" });
    expect(first(rows, "snapshot_table_not_supplied", "job_quantities").severity).toBe("UNVERIFIED");
  });

  it("a job finished on one side only, and an open job missing in Tolra", async () => {
    const ws = workspace();
    editTable(ws, "jobs", (rows) => {
      rowOf(rows, "job_no", "J-0001").finished_at = "2026-04-01";
    });
    const a = await analyse(ws);
    expect(first(a.rows, "job_finished", "J-0001")).toMatchObject({ severity: "BLOCKER", source_value: "open", target_value: "finished" });
    const ws2 = workspace();
    editTable(ws2, "jobs", (rows) => rows.filter((r) => r.job_no !== "J-0001"));
    const b = await analyse(ws2);
    expect(first(b.rows, "job_missing_in_tolra", "J-0001").severity).toBe("BLOCKER");
  });

  it("the WIP valuation is never derived: one standing UNVERIFIED row", async () => {
    const { rows } = await analyse(workspace());
    const v = first(rows, "wip_valuation");
    expect(v).toMatchObject({ severity: "UNVERIFIED", source_value: "(not derivable)", target_value: "(not derivable)" });
    expect(v.reason).toContain("valuation: accountant to confirm");
  });
});

describe("open quotes, orders, purchase orders and commitments", () => {
  it("a quote value, a sales order that is closed in Tolra, a missing open PO and the control totals", async () => {
    const ws = workspace();
    editTable(ws, "quotes", (rows) => {
      rowOf(rows, "quote_ref", "Q2001").total_value = "250.00";
    });
    editTable(ws, "sales_orders", (rows) => {
      rowOf(rows, "so_number", "SO-0001").status = "closed";
    });
    editTable(ws, "purchase_orders", (rows) => rows.filter((r) => r.po_ref !== "PO-0001"));
    const { rows } = await analyse(ws);
    expect(first(rows, "quote_amount", "Q2001")).toMatchObject({ area: "quotes", severity: "BLOCKER", source_value: "240.00", target_value: "250.00", difference: "10.00" });
    expect(first(rows, "open_quotes_total")).toMatchObject({ area: "commitments", severity: "BLOCKER", source_value: "240.00", target_value: "250.00" });
    expect(first(rows, "sales_order_openness", "SO-0001")).toMatchObject({ area: "sales-orders", severity: "BLOCKER" });
    expect(first(rows, "purchase_order_missing_in_tolra", "PO-0001")).toMatchObject({ area: "purchase-orders", severity: "BLOCKER", difference: "-250.00" });
    expect(first(rows, "open_purchase_orders_total")).toMatchObject({ source_value: "250.00", target_value: "0.00" });
  });

  it("a closed quote missing in Tolra is only a warning", async () => {
    const ws = workspace();
    editTable(ws, "quotes", (rows) => rows.filter((r) => r.quote_ref !== "Q2004"));
    const { rows } = await analyse(ws);
    expect(first(rows, "quote_missing_in_tolra", "Q2004").severity).toBe("WARN");
  });
});

describe("opening balances and supplier payables", () => {
  it("document-level and account-level opening balances are compared to the pence", async () => {
    const ws = workspace();
    editTable(ws, "invoices", (rows) => {
      rowOf(rows, "invoice_ref", "S0999").amount_paid = "100.00";
    });
    editTable(ws, "opening_balances", (rows) => {
      rows.find((r) => r.party_ref === "C003").amount = "140.00";
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "opening_receivable_document", "S0999")).toMatchObject({ area: "opening", severity: "BLOCKER", source_value: "960.00", target_value: "860.00", difference: "-100.00" });
    expect(first(rows, "opening_account", "C003")).toMatchObject({ area: "opening", severity: "BLOCKER", source_value: "150.00", target_value: "140.00", difference: "-10.00" });
  });

  it("Tolra has no payables ledger: supplier opening balances and bills are UNVERIFIED", async () => {
    const ws = workspace();
    dropTable(ws, "supplier_bills");
    dropTable(ws, "opening_balances");
    const { rows } = await analyse(ws);
    expect(first(rows, "supplier_bills_not_supplied", "SUP2")).toMatchObject({ area: "payables", severity: "UNVERIFIED", source_value: "1 bill(s), outstanding 240.00" });
    expect(first(rows, "opening_supplier_document_unverified", "SB-100").severity).toBe("UNVERIFIED");
    expect(first(rows, "opening_account_unverified", "SUP1")).toMatchObject({ area: "opening", severity: "UNVERIFIED", source_value: "500.00", target_value: "(not supplied)" });
    expect(first(rows, "opening_account_unverified", "C003").severity).toBe("UNVERIFIED");
    expect(sev(rows, "BLOCKER")).toEqual([]);
  });

  it("a supplier bill with a different balance", async () => {
    const ws = workspace();
    editTable(ws, "supplier_bills", (rows) => {
      rows[0].outstanding = "200.00";
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "supplier_bill_outstanding", "SB-100")).toMatchObject({ area: "payables", severity: "BLOCKER", source_value: "240.00", target_value: "200.00", difference: "-40.00" });
    expect(first(rows, "opening_supplier_document", "SB-100")).toMatchObject({ severity: "BLOCKER" });
  });
});

describe("missing fields and files are UNVERIFIED, never zero", () => {
  it("no payments file in SliQ: no invoice is called paid or unpaid", async () => {
    const ws = workspace();
    dropCsv(ws, "payments.csv");
    const { rows } = await analyse(ws);
    expect(first(rows, "source_file_not_supplied", "payments").severity).toBe("UNVERIFIED");
    expect(pick(rows, "source_payment_state_unverified").length).toBe(8); // every issued invoice
    expect(pick(rows, "invoice_paid")).toEqual([]);
    expect(pick(rows, "invoice_outstanding")).toEqual([]);
    expect(sev(rows, "BLOCKER")).toEqual([]);
  });

  it("no invoice_payments table in Tolra: the receipts cannot be compared and nothing is concluded", async () => {
    const ws = workspace();
    dropTable(ws, "invoice_payments");
    const { rows } = await analyse(ws);
    expect(first(rows, "snapshot_table_not_supplied", "invoice_payments").severity).toBe("UNVERIFIED");
    expect(pick(rows, "payment_missing_in_tolra")).toEqual([]);
    expect(sev(rows, "BLOCKER")).toEqual([]);
  });

  it("a column the snapshot did not carry is (not supplied), and a blank is (unknown)", async () => {
    const ws = workspace();
    editTable(ws, "invoices", (rows) => rows.map(({ amount_paid, ...r }) => (void amount_paid, r)));
    editTable(ws, "invoice_line_items", (rows) => {
      rows[0].description = null;
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "invoice_paid_unverified", "S1001")).toMatchObject({ severity: "UNVERIFIED", source_value: "120.00", target_value: "(not supplied)" });
    expect(first(rows, "line_description_unverified", "S0999")).toMatchObject({ severity: "UNVERIFIED", target_value: "(unknown)" });
  });

  it("a payment with no date: the amount agrees, the date is UNVERIFIED and not guessed", async () => {
    const ws = workspace();
    editCsv(ws, "payments.csv", (t) => t.replace("S1004,12/03/2026,112.50", "S1004,,112.50"));
    const { rows } = await analyse(ws);
    expect(first(rows, "payment_date_unknown", "S1004")).toMatchObject({ area: "historical", severity: "UNVERIFIED", source_value: "(no date in SliQ)" });
    expect(sev(rows, "BLOCKER")).toEqual([]);
  });

  it("Tolra's own 'payment to confirm' flag makes the invoice UNVERIFIED, not owed and not paid", async () => {
    const ws = workspace();
    editTable(ws, "invoices", (rows) => {
      rowOf(rows, "invoice_ref", "S1003").payment_unverified = true;
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "tolra_payment_unverified", "S1003")).toMatchObject({ area: "historical", severity: "UNVERIFIED" });
    expect(pick(rows, "invoice_outstanding", "S1003")).toEqual([]);
  });

  it("a SliQ quantity left blank is UNVERIFIED", async () => {
    const ws = workspace();
    editCsv(ws, "jobs.csv", (t) => t.replace("J-0001,C002,SO-0001,Machining,In Progress,100,60,50,6,4,40,60", "J-0001,C002,SO-0001,Machining,In Progress,100,,50,6,4,40,60"));
    const { rows } = await analyse(ws);
    expect(first(rows, "qty_made_unverified", "J-0001")).toMatchObject({ severity: "UNVERIFIED", source_value: "(unknown)", target_value: "60" });
  });

  it("an unreadable SliQ row is reported, left out, and never rounded", async () => {
    const ws = workspace();
    editCsv(ws, "invoices.csv", (t) => t.replace("S1007,Invoice,07/03/2026,06/04/2026,C003,40.00", "S1007,Invoice,07/03/2026,06/04/2026,C003,40.005"));
    const { rows } = await analyse(ws);
    expect(first(rows, "source_row_unreadable")).toMatchObject({ area: "inputs", severity: "UNVERIFIED" });
    expect(first(rows, "source_row_unreadable").source_value).toContain("more than two decimal places");
  });

  it("an identifier is a person's decision: names never appear in any row", async () => {
    const ws = workspace();
    editTable(ws, "customers", (rows) => {
      rows[0].name = "Alpha Fabs Limited";
    });
    editTable(ws, "invoices", (rows) => {
      rowOf(rows, "invoice_ref", "S1001").customer = "Gamma Supplies";
      rowOf(rows, "invoice_ref", "S1004").customer = "Somebody Else Ltd";
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "invoice_customer", "S1001")).toMatchObject({ severity: "WARN", source_value: "C001", target_value: "C003" });
    expect(first(rows, "invoice_customer", "S1004").target_value).toMatch(/^name-[0-9a-f]{8}$/);
    expect(first(rows, "customer_name_differs", "C001").source_value).toMatch(/^name-[0-9a-f]{8}$/);
    const text = JSON.stringify(rows);
    for (const secret of ["Alpha", "Beta", "Gamma", "Steel", "Tooling", "Somebody", "example.test", "Mill Lane", "Ann ", "Gus "]) expect(text).not.toContain(secret);
  });
});

describe("a missing customer with open items blocks", () => {
  it("customer deleted in Tolra", async () => {
    const ws = workspace();
    editTable(ws, "customers", (rows) => rows.filter((r) => !r.name.startsWith("Beta")));
    const { rows } = await analyse(ws);
    expect(first(rows, "customer_missing", "C002")).toMatchObject({ area: "identity", severity: "BLOCKER" });
  });
});
