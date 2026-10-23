"use client";

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export type ListToolbarExport = {
  /** The menu text, e.g. "CSV", "Excel", "Word", "PDF". */
  label: string;
  onSelect: () => void;
  /** Hover text saying what will be exported (see exportScopeTitle in lib/spreadsheet). */
  title?: string;
};

export type ListToolbarProps = {
  /** How many rows the current filters show. */
  visibleCount: number;
  selectedCount: number;
  /** Pages without row selection (Customers, Suppliers) leave these out and get only the Export menu. */
  onSelectAll?: () => void;
  onClear?: () => void;
  /** Only pages that already have "Print Selected" pass this. */
  onPrint?: () => void;
  /** The Job Board calls its print "Print Workshop Pack". */
  printLabel?: string;
  printDisabled?: boolean;
  printTitle?: string;
  /** Only the formats the page passes are listed; none passed means no Export menu. */
  exports?: ListToolbarExport[];
  /** The page's own bulk actions (e.g. Pay Selected in Full), shown last. */
  actions?: ReactNode;
  /** Extra classes on the touch-size buttons (the Job Board's bigger tablet targets). */
  buttonClassName?: string;
  /** Replaces the default "N selected of M filtered records" text. */
  statusText?: ReactNode;
  /** Disables Select all / Clear when there is nothing to act on (Jobs). */
  disableEmptyButtons?: boolean;
};

/** The labels of the Export menu, in order. Kept separate so the order and content can be unit tested. */
export function exportMenuLabels(exports: ListToolbarExport[] | undefined): string[] {
  return (exports ?? []).map((entry) => entry.label);
}

/**
 * The one row above every list: Select all, Clear, "N selected", Print (if the page has it), one Export menu,
 * then the page's own bulk actions. Wraps on a phone.
 */
export function ListToolbar({ visibleCount, selectedCount, onSelectAll, onClear, onPrint, printLabel = "Print Selected", printDisabled, printTitle, exports, actions, buttonClassName = "", statusText, disableEmptyButtons = false }: ListToolbarProps) {
  const formats = exports ?? [];
  return (
    <div role="toolbar" aria-label="Selection and export" className="flex flex-wrap items-center gap-2">
      {onSelectAll && onClear ? (
        <>
          <Button variant="outline" className={buttonClassName} disabled={disableEmptyButtons && !visibleCount} onClick={onSelectAll}>{`Select all ${visibleCount} filtered`}</Button>
          <Button variant="outline" className={buttonClassName} disabled={disableEmptyButtons && !selectedCount} onClick={onClear}>Clear selection</Button>
          <span role="status" aria-live="polite" className="text-sm text-slate-600 dark:text-slate-300">
            {statusText ?? <><strong className="font-semibold text-ink">{selectedCount} selected</strong> of {visibleCount} filtered {visibleCount === 1 ? "record" : "records"}</>}
          </span>
        </>
      ) : null}
      {onPrint ? <Button variant="outline" className={buttonClassName} disabled={printDisabled} title={printTitle} onClick={onPrint}>{printLabel}</Button> : null}
      {formats.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className={buttonClassName}>Export <ChevronDown className="size-4" aria-hidden /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {formats.map((entry) => <DropdownMenuItem key={entry.label} title={entry.title} className="pointer-coarse:min-h-11" onSelect={entry.onSelect}>{entry.label}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {actions}
    </div>
  );
}
