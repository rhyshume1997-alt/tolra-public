/**
 * The one line a brand-new company sees on an empty list, telling them what to do next. Worded for the view in use: only
 * point at a button the person actually has. Pure, so the words are tested once.
 */
type Role = "admin" | "office" | "workshop" | "viewer" | string | null | undefined;

const manages = (role: Role) => role === "admin" || role === "office";

/** Job Board with no jobs at all. Everyone but a viewer has New job. */
export function jobsEmptyHint(role: Role): string {
  if (role === "viewer") return "No jobs yet. Jobs show here once the office adds them.";
  if (role === "workshop") return "No jobs yet. Press New job to add one, or ask the office to send jobs through from sales orders.";
  return "No jobs yet. Convert a confirmed sales order to a job, or press New job to add one.";
}

/** Machine Schedule bookings list, empty. */
export function scheduleEmptyHint(role: Role, machineCount: number): string {
  if (!machineCount) {
    return manages(role) ? "Nothing booked yet. Add your machines below first, then press New booking to plan work onto them." : "Nothing booked yet. An admin or the office adds the machines first.";
  }
  if (role === "viewer") return "Nothing booked yet. Bookings show here once jobs are planned onto machines.";
  return "Nothing booked yet. Press New booking to plan a job onto a machine.";
}

/** Purchase orders, none at all. */
export function purchaseOrdersEmptyHint(): string {
  return "Add your suppliers first (Suppliers), then press New purchase order to order material.";
}

/**
 * The line under the New PO supplier dropdown when it has nothing to pick: a failed load says so (and offers Retry), an
 * empty list says where suppliers are added. null when there are suppliers to choose from.
 */
export function supplierPickerHint(count: number, loadError: string | null): string | null {
  if (count > 0) return null;
  return loadError ?? "No suppliers yet. Add one on the Suppliers page.";
}

/** Invoices, none at all. */
export function invoicesEmptyHint(): string {
  return "Press Invoice from Delivery Notes to bill delivered work, or New invoice to start one.";
}

// One sentence on each empty list: what to press next. The shared look is components/empty-list.tsx.

/** Quotes, none at all. */
export function quotesEmptyHint(): string {
  return "Press New quote to make your first one.";
}

/** Sales orders, none at all. */
export function salesOrdersEmptyHint(): string {
  return "Press New sales order when a customer sends you an order.";
}

/** Delivery notes, none at all. */
export function deliveryNotesEmptyHint(): string {
  return "Press New delivery note when an order is ready to go out.";
}

/** RFQs (requests for quote), none at all. */
export function rfqEmptyHint(): string {
  return "Press New RFQ when a customer asks us for a price.";
}

/** Customers, none at all. */
export function customersEmptyHint(): string {
  return "Press New customer to add your first one.";
}

/** Suppliers, none at all. */
export function suppliersEmptyHint(): string {
  return "Press New supplier to add your first one.";
}

/** Users, none at all. */
export function usersEmptyHint(): string {
  return "Press New user to add the first one.";
}
