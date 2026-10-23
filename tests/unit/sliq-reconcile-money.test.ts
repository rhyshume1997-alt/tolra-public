/**
 * Money arithmetic, in integer pence, with both sides built to agree and then broken one penny-exact way at a time:
 * reversals, refunds, credit allocations, no double counting, credit-note signs (never hidden by abs()), and the purchase-order
 * net/gross question (unknown stays UNVERIFIED, never "equal"). Synthetic only.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ORG, analyse, editCsv, editTable, first, idOf, pick, workspace, type Row, type Ws } from "../support/sliq-reconcile";

const sev = (rows: Row[], s: string) => rows.filter((r) => r.severity === s);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inv = (rows: any[], ref: string) => rows.find((r) => r.invoice_ref === ref);
const noProblems = (rows: Row[]) => expect(rows.filter((r) => r.severity !== "UNVERIFIED" && r.severity !== "INFO").map((r) => `${r.code} ${r.identifier}`)).toEqual([]);

/**
 * S1003 (300.00 owed in the clean fixture) is paid 300.00, that receipt is reversed in full (Tolra reverses a whole payment) and
 * 200.00 is received instead: 200.00 paid, 100.00 owed, on both sides.
 */
function receiptReversedThenReceived(ws: Ws, { tolraReversal = true, reversalAmount = "-300.00" } = {}) {
  editCsv(ws, "payments.csv", (t) => `${t}S1003,20/03/2026,300.00,BACS,R1\nS1003,25/03/2026,-300.00,BACS,R2\nS1003,26/03/2026,200.00,BACS,R3\n`);
  const s1003 = idOf(ws, "invoices", "invoice_ref", "S1003");
  editTable(ws, "invoice_payments", (rows) => {
    rows.push({ organization_id: ORG, id: "p-300", invoice_id: s1003, amount: "300.00", paid_on: "2026-03-20", source: "recorded", reverses_payment_id: null });
    if (tolraReversal) rows.push({ organization_id: ORG, id: "p-rev", invoice_id: s1003, amount: reversalAmount, paid_on: "2026-03-25", source: "recorded", reverses_payment_id: "p-300" });
    rows.push({ organization_id: ORG, id: "p-200", invoice_id: s1003, amount: "200.00", paid_on: "2026-03-26", source: "recorded", reverses_payment_id: null });
  });
  editTable(ws, "invoices", (rows) => {
    const i = inv(rows, "S1003");
    i.amount_paid = tolraReversal ? "200.00" : "500.00";
    i.status = tolraReversal ? "partial" : "paid";
  });
}

describe("payment reversals", () => {
  it("a receipt of 300.00 reversed in full and 200.00 received instead leave 200.00 paid and 100.00 owed, and agree", async () => {
    const ws = workspace();
    receiptReversedThenReceived(ws);
    const { rows, stats } = await analyse(ws);
    noProblems(rows);
    // 960 + 340 + 100 + 96 + 40 owed on invoices + 150 opening = 1686.00 (S1003 now owes 100.00, not 300.00)
    expect(stats.receivables).toMatchObject({ source: 168600, target: 168600 });
  });

  it("a reversal Tolra does not hold is a BLOCKER on the reversal, the amount paid and the balance", async () => {
    const ws = workspace();
    receiptReversedThenReceived(ws, { tolraReversal: false });
    const { rows } = await analyse(ws);
    expect(first(rows, "reversal_missing_in_tolra", "S1003")).toMatchObject({ severity: "BLOCKER", source_value: "-300.00 on 2026-03-25", target_value: "(none)", difference: "300.00" });
    expect(first(rows, "invoice_paid", "S1003")).toMatchObject({ source_value: "200.00", target_value: "500.00", difference: "300.00" });
    expect(first(rows, "invoice_outstanding", "S1003")).toMatchObject({ source_value: "100.00", target_value: "-200.00", difference: "-300.00" });
    expect(first(rows, "status_settled_but_owed", "S1003")).toMatchObject({ severity: "BLOCKER", source_value: "owed 100.00", target_value: "paid" });
  });

  it("a Tolra reversal that is not the exact negative of its payment is a BLOCKER in Tolra's own books", async () => {
    const ws = workspace();
    receiptReversedThenReceived(ws);
    editTable(ws, "invoice_payments", (rows) => {
      rows.find((r) => r.id === "p-rev").amount = "-299.99";
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "tolra_reversal_mismatch")).toMatchObject({ area: "target-integrity", severity: "BLOCKER" });
    // -299.99 is not -300.00: the reversal is missing from Tolra and an odd one is there instead
    expect(first(rows, "reversal_missing_in_tolra", "S1003").difference).toBe("300.00");
    expect(first(rows, "reversal_only_in_tolra", "S1003")).toMatchObject({ severity: "BLOCKER", target_value: "-299.99 on 2026-03-25" });
  });

  it("reversing more than was received is a warning, not a negative payment taken as fact", async () => {
    const ws = workspace();
    editCsv(ws, "payments.csv", (t) => `${t}S1003,20/03/2026,50.00,BACS,R1\nS1003,25/03/2026,-80.00,BACS,R2\n`);
    const { rows } = await analyse(ws);
    expect(first(rows, "reversals_exceed_receipts", "S1003")).toMatchObject({ area: "payments", severity: "WARN", source_value: "-30.00" });
  });

  it("a reversal listed before its payment counts the same (order does not matter)", async () => {
    const ws = workspace();
    editCsv(ws, "payments.csv", (t) => `${t}S1003,25/03/2026,-100.00,BACS,R2\nS1003,20/03/2026,300.00,BACS,R1\n`);
    const { rows } = await analyse(ws);
    expect(first(rows, "invoice_paid", "S1003")).toMatchObject({ source_value: "200.00", target_value: "0.00" });
  });
});

describe("refunds and credit allocations: each pound counted once", () => {
  /** S1001: 120.00 invoice, 120.00 paid. Credit note CN-003 of 60.00 allocated to it, and `refund` paid back, on both sides. */
  function creditAndRefund(ws: Ws, refund: string) {
    editCsv(ws, "credit-notes.csv", (t) => `${t}CN-003,12/03/2026,C001,50.00,10.00,60.00,S1001,Goods returned,\n`);
    editCsv(ws, "allocations.csv", (t) => `${t}CN-003,S1001,60.00,13/03/2026\n`);
    editCsv(ws, "refunds.csv", (t) => `${t}S1001,21/03/2026,${refund},BACS,RF9\n`);
    // SliQ's own word "Paid" would contradict a refund-driven balance (that case is UNVERIFIED, tested elsewhere): say "Issued"
    editCsv(ws, "invoices.csv", (t) => t.replace("Paid,120.00,,,,\nS1002", "Issued,120.00,,,,\nS1002"));
    const s1001 = idOf(ws, "invoices", "invoice_ref", "S1001");
    editTable(ws, "credit_notes", (rows) => {
      rows.push({ organization_id: ORG, id: "cn-3", invoice_id: s1001, credit_ref: "CN-003", status: "issued", customer: "Alpha Fabrications Ltd", subtotal: "50.00", vat: "10.00", total: "60.00", allocated_amount: "60.00" });
    });
    editTable(ws, "invoice_credit_allocations", (rows) => {
      rows.push({ organization_id: ORG, id: "al-3", invoice_id: s1001, credit_note_id: "cn-3", amount: "60.00", allocated_on: "2026-03-13" });
    });
    editTable(ws, "customer_credit_ledger", (rows) => {
      rows.push({ organization_id: ORG, id: "led-9", kind: "refund", invoice_id: s1001, to_invoice_id: null, amount: refund, paid_on: "2026-03-21" });
    });
    editTable(ws, "invoices", (rows) => {
      const i = inv(rows, "S1001");
      i.credited_amount = "60.00";
      i.refunded_amount = refund;
      i.status = refund === "60.00" ? "paid" : "sent"; // 60.00 is left owing when the whole 120.00 is refunded
    });
  }

  it("paid 120.00 + credit 60.00 allocated + refund 60.00 = nothing owed, nothing double counted", async () => {
    const ws = workspace();
    creditAndRefund(ws, "60.00");
    const { rows, stats } = await analyse(ws);
    noProblems(rows);
    expect(stats.receivables.source).toBe(188600); // unchanged: S1001 owes 120 - 120 - 60 + 60 = 0
    expect(pick(rows, "refund_exceeds_credit")).toEqual([]);
  });

  it("refunding the whole 120.00 is more than the 60.00 credit above the invoice: the balance counts it once and SliQ is warned", async () => {
    const ws = workspace();
    creditAndRefund(ws, "120.00");
    const { rows, stats } = await analyse(ws);
    expect(first(rows, "refund_exceeds_credit", "S1001")).toMatchObject({ severity: "WARN", source_value: "refunded 120.00, credit available 60.00", difference: "60.00" });
    // 120 - 120 - 60 + 120 = 60.00 owed, the same on both sides, so no balance mismatch and the total moves by exactly 60.00
    expect(pick(rows, "invoice_outstanding")).toEqual([]);
    expect(stats.receivables).toMatchObject({ source: 194600, target: 194600 });
  });

  it("the credit counted in Tolra's credited_amount AND again as a transfer is caught in Tolra's books", async () => {
    const ws = workspace();
    creditAndRefund(ws, "60.00");
    editTable(ws, "customer_credit_ledger", (rows) => {
      rows.push({ organization_id: ORG, id: "led-t", kind: "transfer", invoice_id: idOf(ws, "invoices", "invoice_ref", "S1002"), to_invoice_id: idOf(ws, "invoices", "invoice_ref", "S1001"), amount: "10.00", paid_on: null });
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "tolra_credited_vs_rows", "S1001")).toMatchObject({ area: "target-integrity", severity: "BLOCKER", difference: "10.00" });
    expect(first(rows, "transfer_only_in_tolra", "S1002")).toMatchObject({ severity: "WARN" });
  });

  it("one credit note applied to two invoices for more than it is worth is a BLOCKER in SliQ", async () => {
    const ws = workspace();
    editCsv(ws, "allocations.csv", (t) => `${t}CN-002,S1003,20.00,13/03/2026\nCN-002,S1001,10.00,13/03/2026\n`);
    const { rows } = await analyse(ws);
    expect(first(rows, "source_credit_over_allocated", "CN-002")).toMatchObject({ severity: "BLOCKER", source_value: "30.00 of 24.00", difference: "6.00" });
  });

  it("a zero or negative allocation or refund is a sign error, not arithmetic", async () => {
    const ws = workspace();
    editCsv(ws, "allocations.csv", (t) => `${t}CN-002,S1003,-5.00,13/03/2026\n`);
    editCsv(ws, "refunds.csv", (t) => `${t}S1001,22/03/2026,-5.00,BACS,\n`);
    const { rows } = await analyse(ws);
    expect(first(rows, "source_allocation_not_positive", "CN-002>S1003")).toMatchObject({ severity: "BLOCKER", source_value: "-5.00" });
    expect(first(rows, "source_refund_not_positive", "S1001")).toMatchObject({ severity: "BLOCKER", source_value: "-5.00" });
  });
});

describe("credit-note signs are compared, not erased with abs()", () => {
  it("a SliQ credit with mixed signs is a BLOCKER and is not compared", async () => {
    const ws = workspace();
    editCsv(ws, "credit-notes.csv", (t) => t.replace("CN-001,10/03/2026,C002,50.00,10.00,60.00", "CN-001,10/03/2026,C002,50.00,-10.00,60.00"));
    const { rows } = await analyse(ws);
    expect(first(rows, "credit_sign_inconsistent", "CN-001")).toMatchObject({ area: "credits", severity: "BLOCKER", source_value: "net 50.00, VAT -10.00, gross 60.00" });
    expect(pick(rows, "credit_gross", "CN-001")).toEqual([]);
  });

  it("a credit-notes file that holds negatives is a warning, and the magnitudes are still compared", async () => {
    const ws = workspace();
    editCsv(ws, "credit-notes.csv", (t) => t.replace("CN-001,10/03/2026,C002,50.00,10.00,60.00", "CN-001,10/03/2026,C002,-50.00,-10.00,-60.00"));
    const { rows } = await analyse(ws);
    expect(first(rows, "credit_sign_unexpected", "CN-001")).toMatchObject({ severity: "WARN", source_value: "net -50.00, VAT -10.00, gross -60.00" });
    expect(pick(rows, "credit_gross", "CN-001")).toEqual([]);
  });

  it("a credit stored as a negative invoice is an INFO that says so, and a wrong magnitude is still a BLOCKER", async () => {
    const ws = workspace();
    editCsv(ws, "invoices.csv", (t) => `${t}S2001,Credit Note,12/03/2026,,C001,-40.00,-8.00,-48.00,Issued,,S1001,,,\n`);
    editTable(ws, "credit_notes", (rows) => {
      rows.push({ organization_id: ORG, id: "cn-s2001", invoice_id: idOf(ws, "invoices", "invoice_ref", "S1001"), credit_ref: "S2001", status: "issued", customer: "Alpha Fabrications Ltd", subtotal: "40.00", vat: "8.00", total: "47.00", allocated_amount: "0.00" });
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "credit_sign_convention", "S2001")).toMatchObject({ severity: "INFO", source_value: "net -40.00, VAT -8.00, gross -48.00" });
    expect(first(rows, "credit_gross", "S2001")).toMatchObject({ severity: "BLOCKER", source_value: "48.00", target_value: "47.00", difference: "-1.00" });
  });

  it("a positive SliQ credit against a NEGATIVE Tolra credit is a sign flip: a BLOCKER, with both signed values shown", async () => {
    const ws = workspace();
    editTable(ws, "credit_notes", (rows) => {
      const c = rows.find((r) => r.credit_ref === "CN-001");
      c.subtotal = "-50.00";
      c.vat = "-10.00";
      c.total = "-60.00";
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "tolra_credit_negative", "CN-001")).toMatchObject({ severity: "BLOCKER", target_value: "-50.00" });
    expect(first(rows, "credit_gross", "CN-001")).toMatchObject({ severity: "BLOCKER", source_value: "60.00", target_value: "-60.00", difference: "-120.00" });
    expect(first(rows, "credit_net", "CN-001")).toMatchObject({ source_value: "50.00", target_value: "-50.00", difference: "-100.00" });
  });
});

describe("purchase-order totals: net or gross unknown stays UNVERIFIED", () => {
  const metaBasis = (ws: Ws, basis: string | null) => {
    const p = path.join(ws.tolra, "meta.json");
    const meta = JSON.parse(readFileSync(p, "utf8"));
    if (basis === null) delete meta.purchase_order_total_basis;
    else meta.purchase_order_total_basis = basis;
    writeFileSync(p, JSON.stringify(meta));
  };

  it("known on both sides and the same: compared to the penny", async () => {
    const ws = workspace();
    editTable(ws, "purchase_orders", (rows) => {
      rows.find((r) => r.po_ref === "PO-0001").total_value = "249.99";
    });
    const { rows } = await analyse(ws);
    expect(first(rows, "purchase_order_amount", "PO-0001")).toMatchObject({ severity: "BLOCKER", source_value: "250.00", target_value: "249.99", difference: "-0.01" });
    expect(first(rows, "open_purchase_orders_total")).toMatchObject({ severity: "BLOCKER" });
  });

  it("the snapshot does not say: equal figures are NOT reported as equal, different ones NOT as different", async () => {
    const ws = workspace();
    metaBasis(ws, null);
    editTable(ws, "purchase_orders", (rows) => {
      rows.find((r) => r.po_ref === "PO-0001").total_value = "999.00"; // different
    });
    const { rows } = await analyse(ws);
    const unknown = pick(rows, "purchase_order_basis_unknown");
    expect(unknown.map((r) => r.identifier).sort()).toEqual(["purchase order=PO-0001", "purchase order=PO-0002", "purchase order=PO-0003"]);
    expect(unknown.every((r) => r.severity === "UNVERIFIED")).toBe(true);
    expect(unknown.find((r) => r.identifier.endsWith("PO-0001"))).toMatchObject({ source_value: "250.00", target_value: "999.00" });
    expect(unknown.find((r) => r.identifier.endsWith("PO-0002"))).toMatchObject({ source_value: "80.00", target_value: "80.00" }); // equal, still not "equal"
    expect(pick(rows, "purchase_order_amount")).toEqual([]);
    expect(first(rows, "open_purchase_orders_basis_unknown").severity).toBe("UNVERIFIED");
    expect(pick(rows, "open_purchase_orders_total")).toEqual([]);
    expect(sev(rows, "BLOCKER")).toEqual([]);
  });

  it("net on one side and gross on the other cannot be compared either", async () => {
    const ws = workspace();
    metaBasis(ws, "gross");
    const { rows } = await analyse(ws);
    expect(pick(rows, "purchase_order_basis_unknown")).toHaveLength(3);
    expect(sev(rows, "BLOCKER")).toEqual([]);
  });
});
