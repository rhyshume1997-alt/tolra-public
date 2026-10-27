"use client";

import { Columns3 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { COLUMN_TABLES, useColumnVisibility } from "@/lib/org-settings";
import { useUser } from "@/lib/use-user";

/** Who a change reaches: the company's shared setting, or (offline) this browser only, keyed by user and company. */
export function columnScopeText(localOnly: boolean) {
  return localOnly ? "Supabase unavailable: changes are saved in this browser only." : "Changes apply to everyone in this company.";
}

export function ColumnToggle({ tableKey }: { tableKey: string }) {
  const { hasAnyRole } = useUser();
  const { isVisible, isLocked, setColumnVisible, resetColumns, hidden, loaded, localOnly } = useColumnVisibility(tableKey);
  const table = COLUMN_TABLES.find((entry) => entry.key === tableKey);
  if (!table || !hasAnyRole(["admin", "office"])) return null;

  return (
    <DropdownMenu>
      {/* Disabled until the saved columns have loaded, so a tick made first is never overwritten by the load landing after it. */}
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="min-h-9" disabled={!loaded}><Columns3 className="size-4" /> {table.kind === "elements" ? "Show / hide" : "Columns"}</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>{table.kind === "elements" ? `${table.label}: show / hide` : `${table.label} columns`}</DropdownMenuLabel>
        <p className="px-2 pb-1.5 text-xs text-slate-500" data-testid="column-scope">{columnScopeText(localOnly)}</p>
        <DropdownMenuSeparator />
        {table.columns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.key}
            checked={isLocked(column.key) || isVisible(column.key)}
            disabled={isLocked(column.key)}
            title={isLocked(column.key) ? "Always shown" : undefined}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={async (checked) => {
              if (isLocked(column.key)) return;
              const result = await setColumnVisible(column.key, Boolean(checked));
              if (result.denied) toast.error(result.message ?? "You can't change this setting.");
              else if (result.localOnly) toast.message("Saved in this browser only (Supabase unavailable).");
            }}
          >
            {column.label}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!hidden.length}
          onSelect={async (event) => {
            event.preventDefault();
            const result = await resetColumns();
            if (result.denied) toast.error(result.message ?? "You can't change this setting.");
            else if (result.localOnly) toast.message("Saved in this browser only (Supabase unavailable).");
          }}
        >
          Reset to default (show all columns)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
