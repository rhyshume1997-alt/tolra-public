import type { Client } from "pg";
export type Snapshot = {
  readOnly: boolean;
  customers: Array<{ id: string; name: string; email: string | null }>;
  invoices: Array<{ id: string; invoice_ref: string; customer: string; subtotal: string; vat: string; total: string; amount_paid: string; payment_unverified: boolean; status: string }>;
  payments: Array<{ invoice_id: string; amount: string; paid_on: string; source: string; reference: string | null }>;
  quotes: Array<{ id: string; quote_ref: string; total_value: string }>;
  counters: Array<{ prefix: string; last: number }>;
};
export function sourceHashes(folder: string): Record<string, string>;
export function readOnlySnapshot(db: Pick<Client, "query">, org: string): Promise<Snapshot>;
export function writeScopedReport(args: { snapshot: Snapshot; plan: unknown; folder: string; out: string; organizationId: string; subjectSha: string }): {
  scopedFinancialResult: string; totals: Record<string, number>; customerReview: unknown[]; overallSignOff: string;
};
