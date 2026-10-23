/**
 * A supplier's status (ISO 9001 8.4, migration 082): a simple flag that only an admin changes. Approved (every existing supplier),
 * Conditional (a warning when a purchase order to it is issued, nothing refused) or Blocked (the database refuses to issue a purchase
 * order to it; a draft can still be made). Colours from the one status map (lib/status-colours.ts): approved green, conditional
 * yellow, blocked red.
 */
import type { StatusKey } from "@/lib/status-colours";

export const SUPPLIER_STATUSES = ["approved", "conditional", "blocked"] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];

export const SUPPLIER_STATUS_LABELS: Record<SupplierStatus, string> = { approved: "Approved", conditional: "Conditional", blocked: "Blocked" };

/** The badge key for a status: blocked red, conditional yellow, approved green ("accepted" in the map, shown as "Approved"). */
export const SUPPLIER_STATUS_BADGE: Record<SupplierStatus, StatusKey> = { approved: "accepted", conditional: "conditional_supplier", blocked: "blocked_supplier" };

export function isSupplierStatus(value: unknown): value is SupplierStatus {
  return typeof value === "string" && (SUPPLIER_STATUSES as readonly string[]).includes(value);
}

/** How an order's supplier text matches a listed supplier (as the database matches it: case and surrounding spaces ignored). */
export const supplierKey = (name: string | null | undefined) => (name ?? "").trim().toLowerCase();

/** Only an admin changes a supplier's status (decided Tue 20 Oct; the database refuses anyone else). */
export const canChangeSupplierStatus = (role: string | null | undefined) => role === "admin";

/**
 * What the Issue dialog says about the order's supplier (a purchase order is raised when its draft is issued): nothing for an
 * approved one (or one not on the list).
 */
export function supplierOrderNotice(status: SupplierStatus | undefined): { tone: "warning" | "blocked"; text: string } | null {
  if (status === "conditional") return { tone: "warning", text: "Conditional supplier: check this order before you issue it." };
  if (status === "blocked") return { tone: "blocked", text: "Blocked supplier: this order can't be issued until an admin changes its status on the Suppliers page." };
  return null;
}
