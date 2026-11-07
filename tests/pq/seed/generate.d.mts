export const GENERATOR_VERSION: string;
export const EMAIL_DOMAIN: string;
export const VAT_RATE: number;
export const MAX_SCALE: number;
export const pctOf: (pence: number, pct: number) => number;
export type PqLine = { description: string; partNumber: string | null; quantity: number; unitPence: number; vatPct: number; vatExempt: boolean };
export type PqInvoice = {
  key: string; source: "delivery_note" | "standalone"; deliveryNoteKey: string | null; customerKey: string; customerPo: string | null; vatEnabled: boolean; carriageVat: boolean;
  lines: PqLine[]; netPence: number; carriagePence: number; vatPence: number; totalPence: number; shape: string; invoiceDate: string; dueDate: string; terms: string;
  payments: { paidOn: string; amountPence: number; method: string; reference: string }[];
  credit: null | { lineIndex: number; quantity: number; reason: string; creditDate: string; netPence: number; vatPence: number; totalPence: number };
  issue: boolean; paidPence: number; creditedPence: number; outstandingPence: number; overdue: boolean;
};
export type PqQuote = { key: string; customerKey: string; status: string; shape: string; createdOn: string; validUntil: string; customerPo: string | null; vatEnabled: boolean; description: string; lines: PqLine[]; netPence: number; vatPence: number; totalPence: number; acceptedOn?: string; deliveryOn?: string };
export type PqCompany = {
  name: string; slug: string; kind: "primary" | "practice"; profile: Record<string, unknown>;
  users: { key: string; role: string; email: string; fullName: string }[];
  customers: { key: string; name: string; contactName: string; email: string | null; phone: string | null; mobile: string | null; address: string; notes: string; archived: boolean; duplicateOf?: string }[];
  parts: { sku: string; material: string; currentStock: number; minLevel: number; reorderQuantity: number; preferredSupplier: string; unitPricePence: number; leadTimeDays: string }[];
  machines: { key: string; name: string; type: string; hoursPerDay: number; workingDays: number[]; active: boolean }[];
  quotes: PqQuote[];
  jobs: { key: string; kind: string; quoteKey: string | null; customerKey: string | null; description: string; requiredOn: string; progress: string; quantityRequired: number }[];
  bookings: { key: string; jobKey: string; machineKey: string; startAt: string; hours: number; hoursDone: number; status: string; notes: string }[];
  deliveryNotes: { key: string; jobKey: string; quoteKey: string; shipDate: string; shipVia: string; signed: boolean; notes: string; finishedOn: string }[];
  invoices: PqInvoice[];
  attendance: { userKey: string; day: string; events: { action: string; at: string; opId: string }[]; worked: null | { minutes: number } }[];
  labour: { userKey: string; jobKey: string; startedAt: string; endedAt: string }[];
};
export type PqDataset = {
  meta: { generator: string; seed: string; scale: number; baseDate: string; runId: string; marker: { slugPrefix: string; emailSuffix: string } };
  companies: PqCompany[];
  expected: Record<string, Record<string, unknown>>;
};
export function documentTotals(lines: PqLine[], options?: { vatEnabled?: boolean; carriagePence?: number; carriageVat?: boolean }): { netPence: number; carriagePence: number; vatPence: number; totalPence: number };
export function lineNet(line: Pick<PqLine, "quantity" | "unitPence">): number;
export function lineVat(line: PqLine): number;
export function generatePqDataset(options: { seed?: string; baseDate: string; scale?: number }): PqDataset;
export function summarise(dataset: PqDataset): Record<string, Record<string, unknown>>;
