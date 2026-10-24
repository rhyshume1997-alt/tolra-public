import { cn } from "@/lib/utils";

/**
 * The Job Board's one heading style (app/globals.css, "Job Board headings"). Every heading on the board uses these: KPI tile
 * labels (StatTile labelClassName={BOARD_KPI_LABEL}), filter labels (BoardFilterRow), List / Table column headers
 * (TableHeader className={BOARD_TABLE_HEADINGS}) and the group-by headings (BoardHeading).
 */
export const BOARD_HEADING = "board-heading";
/** A KPI tile's label row: the shared caption, always two lines tall, so every tile's number sits on the same line. */
export const BOARD_KPI_LABEL = "board-heading board-kpi-label";
/** On a <TableHeader>: every column header in it takes the shared caption. */
export const BOARD_TABLE_HEADINGS = "board-headings";

export function BoardHeading({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-board-heading="" className={cn(BOARD_HEADING, className)} {...props} />;
}

/**
 * One filter row: a fixed-width label column, then the chips. Every row on the board uses it, so the labels start and end at the
 * same x whatever their length. A qualifier ("Not started and Running jobs") goes in `note`, after the chips, not in the label.
 */
export function BoardFilterRow({ label, groupLabel, note, title, children }: {
  label: string;
  /** The group's accessible name, when it says more than the label (e.g. "Job type"). */
  groupLabel?: string;
  note?: React.ReactNode;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="board-filter-row" role="group" aria-label={groupLabel ?? label} data-board-filter="">
      <span className="board-heading board-filter-label" data-board-heading="filter" title={title}>{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {children}
        {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
      </div>
    </div>
  );
}
