import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { suggestPaidClaims, type InboundEmail } from "@/lib/chase/paid-claim-adapter";
import { matchStatementLines, parseStatementCsv } from "@/lib/bank/match-statement";

const fixture = (file: string) => readFileSync(path.resolve(__dirname, "../fixtures/chase-evidence", file), "utf8");
// Already scoped to the signed-in company's open invoices, as required by the adapter contract.
// Frozen rows make any attempt to mark paid during detection/matching fail immediately.
const invoice = Object.freeze({ id: "invoice-1061", number: "INV-1061", ref: "INV-1061", customer: "Fictional Test Shop",
  customerName: "Fictional Test Shop", customerEmail: "accounts@fictional.example.test", balancePence: 12050,
  dueDate: "2026-11-01", status: "sent", amountPaidPence: 0 });

it("fake incoming email reaches the reconciled detector and flags its invoice for review without recording payment", () => {
  const email = JSON.parse(fixture("paid-email.json")) as InboundEmail;
  const before = structuredClone(invoice);
  const flags = suggestPaidClaims([email], [invoice]);
  expect(flags).toEqual([{ invoiceId: invoice.id, emailId: email.id, confidence: "high", reason: "Payment claimed with invoice number INV-1061" }]);
  expect(invoice).toEqual(before);
  expect(invoice).toMatchObject({ status: "sent", amountPaidPence: 0, balancePence: 12050 });
  expect(suggestPaidClaims([{ ...email, from: '"accounts@fictional.example.test" <other@attacker.example.test>' }], [invoice])).toEqual([]);
});

it("fake bank file reaches the reconciled parser and flags a matching invoice without marking it paid", () => {
  const before = structuredClone(invoice);
  const parsed = parseStatementCsv(fixture("bank.csv"));
  expect(parsed.errors).toEqual([]);
  expect(parsed.lines).toHaveLength(1);
  expect(parsed.lines[0]).toMatchObject({ amountPence: 12050, date: "2026-11-03" });
  const flags = matchStatementLines(parsed.lines, [invoice]);
  expect(flags).toHaveLength(1);
  expect(flags[0]).toMatchObject({ invoice, confidence: "high" });
  expect(invoice).toEqual(before);
  expect(invoice).toMatchObject({ status: "sent", amountPaidPence: 0, balancePence: 12050 });
  // The result is evidence to review. Only the separate, explicit confirmation path may record a payment.
});
