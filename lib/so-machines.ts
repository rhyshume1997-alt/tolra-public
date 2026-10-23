/**
 * Machines on sales-order lines and on the job (migration 043): the pure parts of the plan the dialogs and the boards show.
 * The order keeps one row per line and machine; the job keeps one row per machine (042's rule), so carrying sums the lines.
 */

/** One row of an order's plan, as sales_order_line_machines holds it. */
export type OrderPlanRow = { machine_id: string; estimated_hours: number; line_key: number; sales_order_line_id: string | null; position: number };
/** One machine with its hours, as the job holds it and as the chips show it. */
export type MachineHours = { machine_id: string; hours: number };

/** The most hours one machine may carry (the tables' CHECK; across an order's lines the function refuses more). */
export const MAX_MACHINE_HOURS = 1000;
/** Machines per line or per job (the functions' limit). */
export const MAX_MACHINES = 10;

/**
 * The plan as the job will hold it after conversion (carry_so_machines): one row per machine, hours summed across the lines, in order
 * of first appearance (line, then position). More than 1000 on one machine is refused when the plan is set (not capped), so the sum
 * here is the plain sum and the dialog warns above 1000.
 */
export function sumMachineHours(rows: OrderPlanRow[]): MachineHours[] {
  const ordered = [...rows].sort((a, b) => a.line_key - b.line_key || a.position - b.position);
  const totals = new Map<string, number>();
  for (const row of ordered) totals.set(row.machine_id, (totals.get(row.machine_id) ?? 0) + Number(row.estimated_hours || 0));
  return [...totals].map(([machine_id, hours]) => ({ machine_id, hours: round(hours) }));
}

/**
 * The order's plan by line, for the editor: a row attaches to the line it names, or (after the lines were rebuilt) to the line at its
 * position; rows left over (their line gone in a rebuild) are "detached": still carried to the job, shown but not edited per line.
 */
export function groupPlanByLine<L extends { id: string; position: number }>(lines: L[], rows: OrderPlanRow[]): { byLine: Map<string, OrderPlanRow[]>; detached: OrderPlanRow[] } {
  const byId = new Map(lines.map((line) => [line.id, line]));
  const byPosition = new Map(lines.map((line) => [line.position, line]));
  const byLine = new Map<string, OrderPlanRow[]>(lines.map((line) => [line.id, []]));
  const detached: OrderPlanRow[] = [];
  for (const row of [...rows].sort((a, b) => a.line_key - b.line_key || a.position - b.position)) {
    const line = (row.sales_order_line_id && byId.get(row.sales_order_line_id)) || byPosition.get(row.line_key);
    if (line) byLine.get(line.id)!.push(row);
    else detached.push(row);
  }
  return { byLine, detached };
}

/** "2.5 h", "6 h": hours as the boards and chips print them. */
export function formatHours(hours: number): string {
  const value = round(Number(hours) || 0);
  return `${Number.isInteger(value) ? value : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")} h`;
}

/** "Mill 6 h, Lathe 2.5 h": the plan in one line, in the order given. */
export function describeMachines(rows: { name: string; hours: number }[]): string {
  return rows.map((row) => `${row.name} ${formatHours(row.hours)}`).join(", ");
}

/** The hours total across machines (the convert toast: "Carried 2 machines (7.5 h)"). */
export function totalHours(rows: { hours: number }[]): number {
  return round(rows.reduce((sum, row) => sum + (Number(row.hours) || 0), 0));
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
