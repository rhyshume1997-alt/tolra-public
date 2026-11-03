/** Connections and read-only invoice checks. Outbound accounting sends retain their separate mapping/approval gate. */
export const ACCOUNTING_IDS = ["xero", "sage", "quickbooks"] as const;
export type AccountingId = typeof ACCOUNTING_IDS[number];
export const accountingId = (value: string): AccountingId | null => ACCOUNTING_IDS.find((id) => id === value) ?? null;
export const ACCOUNTING_LABELS: Record<AccountingId, string> = { xero: "Xero", sage: "Sage Business Cloud Accounting", quickbooks: "QuickBooks Online" };
export type BalanceEvidence = { invoiceNumber: string; totalPence: number; outstandingPence: number; currency: "GBP"; reviewOnly: true };
export type ConnectionAdapter = {
  id: AccountingId;
  begin(): Promise<string>;
  finish(state: string, code: string, realm: string | null): Promise<boolean>;
  disconnect(): Promise<void>;
  checkInvoice(number: string): Promise<BalanceEvidence | null>;
};
