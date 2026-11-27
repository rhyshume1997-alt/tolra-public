/**
 * Inputs: payment query reader and either null (all org payments) or the selected invoice IDs to export.
 * Outputs: scoped InvoicePayment rows and truncation flag without loading all org payments when invoices are selected.
 * Boundary: Module 4 (Invoices) only; does not modify shared lib/fetch-all.ts or payment calculation logic.
 */
import { fetchAll } from "@/lib/fetch-all";
import { type InvoicePayment, paymentFromRow } from "@/lib/payments";

const INVOICE_ID_CHUNK_SIZE = 200;

type PaymentPage = PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>;
type OrderedPaymentQuery = {
  order(column: "created_at"): {
    order(column: "id"): {
      range(from: number, to: number): PaymentPage;
    };
  };
};

export type PaymentExportReader = {
  from(table: "invoice_payments"): {
    select(columns: "*"): OrderedPaymentQuery & {
      in(column: "invoice_id", values: string[]): OrderedPaymentQuery;
    };
  };
};

/**
 * Loads invoice_payments for CSV/XLSX export.
 * When `selectedInvoiceIds` is provided, queries only those invoice IDs in bounded chunks so large organisations
 * can export selected invoices without fetching every payment in the database first.
 */
export async function fetchPaymentsForExport(
  client: PaymentExportReader,
  selectedInvoiceIds: string[] | null,
  chunkSize = INVOICE_ID_CHUNK_SIZE,
): Promise<{ payments: InvoicePayment[]; truncated: boolean }> {
  if (selectedInvoiceIds === null) {
    const { rows, truncated } = await fetchAll((from, to) =>
      client.from("invoice_payments").select("*").order("created_at").order("id").range(from, to),
    );
    if (truncated) return { payments: [], truncated: true };
    return { payments: rows.map(paymentFromRow), truncated: false };
  }

  const uniqueIds = [...new Set(selectedInvoiceIds.filter(Boolean))];
  if (!uniqueIds.length) return { payments: [], truncated: false };

  const allRows: Record<string, unknown>[] = [];
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    const { rows, truncated } = await fetchAll((from, to) =>
      client
        .from("invoice_payments")
        .select("*")
        .in("invoice_id", chunk)
        .order("created_at")
        .order("id")
        .range(from, to),
    );
    if (truncated) return { payments: [], truncated: true };
    allRows.push(...rows);
  }

  allRows.sort((a, b) => {
    const at = String(a.created_at ?? "");
    const bt = String(b.created_at ?? "");
    if (at !== bt) return at.localeCompare(bt);
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
  });

  return { payments: allRows.map(paymentFromRow), truncated: false };
}
