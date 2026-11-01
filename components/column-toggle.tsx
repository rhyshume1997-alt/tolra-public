"use client";

import { useEffect } from "react";
import { Columns3 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { COLUMN_TABLES, clearDeviceColumns, useColumnVisibility } from "@/lib/org-settings";
import { useUser } from "@/lib/use-user";

/** Roles whose Columns button changes the company setting. Everyone else's changes only their own view on this device. */
export const COMPANY_DISPLAY_ROLES = ["admin", "office"] as const;

/** Who a change reaches: the company's shared setting, (offline) this browser only, or (own view) this person on this device only. */
export function columnScopeText(localOnly: boolean, own = false) {
  if (own) return "Your own view on this device only. Everyone else, and the company setting, are not changed.";
  return localOnly ? "Supabase unavailable: changes are saved in this browser only." : "Changes apply to everyone in this company.";
}

/** The reset item's words: back to everything shown (company), or back to what the company shows (own view). */
export function resetLabel(own: boolean) {
  return own ? "Reset to the company view" : "Reset to default (show all columns)";
}

/**
 * `keys` limits the menu to those columns (the Dashboard shows each role only its own tiles). Admin and office change the company
 * setting (as before); workshop and viewer change only their own view on this device (G5 option A, never written to the server).
 */
export function ColumnToggle({ tableKey, keys }: { tableKey: string; keys?: string[] }) {
  const { hasAnyRole, loading } = useUser();
  const { isVisible, isLocked, setColumnVisible, resetColumns, setOwnColumnVisible, resetOwnColumns, hidden, ownView, hasOwnViews, loaded, localOnly } = useColumnVisibility(tableKey);
  const table = COLUMN_TABLES.find((entry) => entry.key === tableKey);
  const company = hasAnyRole([...COMPANY_DISPLAY_ROLES]);
  // Admin and office always see the company setting: an own view left from an earlier role in this company is dropped.
  useEffect(() => { if (!loading && company && hasOwnViews) clearDeviceColumns(); }, [company, hasOwnViews, loading]);
  if (!table || loading) return null;
  const own = !company;
  const setVisible = own ? setOwnColumnVisible : setColumnVisible;
  const reset = own ? resetOwnColumns : resetColumns;

  return (
    <DropdownMenu>
      {/* Disabled until the saved columns have loaded, so a tick made first is never overwritten by the load landing after it. */}
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="min-h-9" disabled={!loaded}><Columns3 className="size-4" /> {table.kind === "elements" ? "Show / hide" : "Columns"}</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>{table.kind === "elements" ? `${table.label}: show / hide` : `${table.label} columns`}</DropdownMenuLabel>
        <p className="px-2 pb-1.5 text-xs text-slate-500" data-testid="column-scope">{columnScopeText(localOnly, own)}</p>
        <DropdownMenuSeparator />
        {table.columns.filter((column) => !keys || keys.includes(column.key)).map((column) => (
          <DropdownMenuCheckboxItem
            key={column.key}
            checked={isLocked(column.key) || isVisible(column.key)}
            disabled={isLocked(column.key)}
            title={isLocked(column.key) ? "Always shown" : undefined}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={async (checked) => {
              if (isLocked(column.key)) return;
              const result = await setVisible(column.key, Boolean(checked));
              if (result.denied) toast.error(result.message ?? "You can't change this setting.");
              else if (result.localOnly && !own) toast.message("Saved in this browser only (Supabase unavailable).");
            }}
          >
            {column.label}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={own ? !ownView : !hidden.length}
          onSelect={async (event) => {
            event.preventDefault();
            const result = await reset();
            if (result.denied) toast.error(result.message ?? "You can't change this setting.");
            else if (result.localOnly && !own) toast.message("Saved in this browser only (Supabase unavailable).");
          }}
        >
          {resetLabel(own)}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
