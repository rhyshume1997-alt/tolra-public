// Inputs: Supabase client, purchase-order rows/IDs, update columns, and optional excluded statuses.
// Outputs: acknowledged updated purchase-order IDs and status eligibility helpers for Module 4.
// Boundary: Module 4 only; does not alter database permissions, triggers, or migrations.
import type { SupabaseClient } from "@supabase/supabase-js";
import { ValidationError } from "@/lib/validation/schemas";

export const NON_RECEIVABLE_PO_STATUSES = ["draft", "received", "cancelled"] as const;

export type UpdatePurchaseOrderOptions = {
  excludeStatuses?: readonly string[];
};

function normalisePoStatus(status: string | null | undefined): string {
  return String(status ?? "").trim().toLowerCase();
}

export function isCancelledPurchaseOrder(status: string | null | undefined): boolean {
  return normalisePoStatus(status) === "cancelled";
}

export function isOpenPurchaseOrder(status: string | null | undefined): boolean {
  const s = normalisePoStatus(status);
  return s !== "received" && s !== "cancelled";
}

export function canReceivePurchaseOrder(status: string | null | undefined): boolean {
  const s = normalisePoStatus(status);
  return s !== "draft" && s !== "received" && s !== "cancelled";
}

export function canRecordPurchaseOrderSent(status: string | null | undefined): boolean {
  return canReceivePurchaseOrder(status);
}

export function canEmailPurchaseOrder(status: string | null | undefined): boolean {
  const s = normalisePoStatus(status);
  return s !== "draft" && s !== "cancelled";
}

export function filterReceivablePurchaseOrders<T extends { id: string; status: string }>(
  orders: readonly T[],
  ids: readonly string[],
): T[] {
  const wanted = new Set(ids);
  return orders.filter((po) => wanted.has(po.id) && canReceivePurchaseOrder(po.status));
}

export async function updatePurchaseOrders(
  client: Pick<SupabaseClient, "from">,
  ids: readonly string[],
  columns: Record<string, unknown>,
  options?: UpdatePurchaseOrderOptions,
): Promise<string[]> {
  let query = client.from("purchase_orders").update(columns).in("id", ids);
  if (options?.excludeStatuses?.length) {
    query = query.not("status", "in", `(${options.excludeStatuses.join(",")})`);
  }
  const { data, error } = await query.select("id");
  if (error) throw error;

  const acknowledged = new Set(data?.map((row) => row.id));
  const updatedIds = ids.filter((id) => acknowledged.has(id));
  if (!updatedIds.length) {
    throw new ValidationError("No purchase orders were updated. Refresh the list and try again.");
  }
  return updatedIds;
}
