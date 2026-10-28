/**
 * The Dashboard's display definition (Rhys, Fri 23 Oct: people can select or deselect what they see). One list of tiles and
 * sections in rendered order, shared by the page (what it renders and in what order), the Columns picker on the Dashboard and
 * Settings > Table Columns (via COLUMN_TABLES, key "dashboard"). Nothing is locked except the page heading, which is not listed.
 * Everything is on by default; a hidden tile is only left out of the page, no figure's calculation changes.
 * Pure data, no imports, so a unit test can read it without a backend.
 */
export type DashboardRole = "admin" | "office" | "workshop";

export type DashboardTile = { key: string; label: string; roles: DashboardRole[] };

/** Rendered order within each role's view (the order here is the order on the page). */
export const DASHBOARD_TILES: DashboardTile[] = [
  { key: "money-owed", label: "Money Owed (admin)", roles: ["admin"] },
  { key: "rfqs-to-quote", label: "RFQs to Quote (office)", roles: ["office"] },
  { key: "open-jobs", label: "Open jobs", roles: ["admin", "office"] },
  { key: "open-quotes", label: "Open Quotes", roles: ["admin", "office"] },
  { key: "revenue-trend", label: "Revenue Trend", roles: ["admin"] },
  { key: "money-by-age", label: "Money Owed by Age (admin)", roles: ["admin"] },
  { key: "quote-outcomes", label: "Quotes, last 90 days", roles: ["admin", "office"] },
  { key: "this-month-revenue", label: "This Month Revenue", roles: ["admin"] },
  { key: "quotes-sent", label: "Quotes Sent", roles: ["admin"] },
  { key: "jobs-late-on-time", label: "Jobs Late / On Time", roles: ["admin"] },
  { key: "avg-days-to-pay", label: "Avg Days to Pay", roles: ["admin"] },
  { key: "jobs-by-status", label: "Open Jobs by Status", roles: ["admin", "office"] },
  { key: "on-time-delivery", label: "On-time Delivery", roles: ["admin", "office"] },
  { key: "right-first-time", label: "Right First Time", roles: ["admin", "office"] },
  { key: "machine-load", label: "Machine Load This Week", roles: ["admin", "office"] },
  { key: "work-due", label: "Work Coming Due", roles: ["admin", "office"] },
  { key: "top-customers", label: "Top Customers (admin)", roles: ["admin"] },
  { key: "jobs-running", label: "Jobs Running (workshop)", roles: ["workshop"] },
  { key: "due-this-week", label: "Due This Week (workshop)", roles: ["workshop"] },
  { key: "delivery-notes", label: "Delivery Notes (workshop)", roles: ["workshop"] },
  { key: "my-jobs", label: "My jobs (workshop)", roles: ["workshop"] },
  { key: "needs-attention", label: "Needs Your Attention", roles: ["admin", "office", "workshop"] },
  { key: "quote-pipeline", label: "Quote Pipeline", roles: ["admin", "office"] },
  { key: "priority-jobs", label: "Priority Jobs (workshop)", roles: ["workshop"] },
  { key: "workshop-schedule", label: "Workshop Schedule This Week (workshop)", roles: ["workshop"] },
];

export const dashboardTileKeysFor = (role: DashboardRole) => DASHBOARD_TILES.filter((tile) => tile.roles.includes(role)).map((tile) => tile.key);

/** Static class names per visible count, so a row of tiles fills its width whatever is hidden (no empty cell at the end). */
export const GRID_COLS: Record<number, string> = {
  1: "grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 xl:grid-cols-3",
};
export const kpiGridClass = (visible: number) => GRID_COLS[Math.min(Math.max(visible, 1), 3)];
export const statGridClass = (visible: number) => (["", "grid-cols-1", "md:grid-cols-2", "md:grid-cols-3", "md:grid-cols-4"][Math.min(Math.max(visible, 1), 4)]);
