/**
 * The Sales Orders switch (Settings > Menu). Sales Orders is OFF by default: the menu item, the /sales-orders pages and the
 * buttons and links that lead to them stay hidden until an admin switches them on. No database change: the choice lives in the
 * company's existing organization_settings.hidden_nav list (admin-only to change, empty to start), as a positive marker.
 *
 * Off only hides the screens. Accepting a quote still makes its internal sales order (accept_quote, migration 068), and the job,
 * delivery notes and invoice lines are still built from it; nothing here touches that.
 *
 * Pure (no React, no browser) so the middle layers, the sidebar, the page guard and the tests share one rule.
 */

/** The menu key of the Sales Orders page (href without the leading slash). */
export const SALES_ORDERS_KEY = "sales-orders";
/** Stored in hidden_nav when an admin has switched Sales Orders on. Absent (the default) means off. */
export const SALES_ORDERS_ON_MARKER = "sales-orders:on";

export const SALES_ORDERS_OFF_NOTICE = "Sales Orders is switched off for your company. An admin can switch it on in Settings > Menu.";

/** On only when an admin switched it on (the marker) and has not also hidden the item the old way (the plain key). */
export function salesOrdersEnabled(hiddenNav?: readonly string[] | null): boolean {
  return Boolean(hiddenNav?.includes(SALES_ORDERS_ON_MARKER)) && !hiddenNav!.includes(SALES_ORDERS_KEY);
}

/** True for /sales-orders and everything under it (query and fragment ignored). */
export function isSalesOrdersPath(target: string): boolean {
  const href = target.split(/[?#]/)[0];
  return href === "/sales-orders" || href.startsWith("/sales-orders/");
}

/** The hidden_nav change that switches Sales Orders on or off: on adds the marker and clears any old plain hide. */
export function salesOrdersSwitchChange(on: boolean): { add: string[]; remove: string[] } {
  return on ? { add: [SALES_ORDERS_ON_MARKER], remove: [SALES_ORDERS_KEY] } : { add: [], remove: [SALES_ORDERS_ON_MARKER] };
}
