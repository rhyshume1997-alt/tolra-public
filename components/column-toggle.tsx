"use client";

import { Columns3 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { COLUMN_TABLES, useColumnVisibility } from "@/lib/org-settings";
import { useUser } from "@/lib/use-user";

export function ColumnToggle({ tableKey }: { tableKey: string }) {
  const { hasAnyRole } = useUser();
  const { isVisible, setColumnVisible } = useColumnVisibility(tableKey);
  const table = COLUMN_TABLES.find((entry) => entry.key === tableKey);
  if (!table || !hasAnyRole(["admin", "office"])) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="min-h-9"><Columns3 className="size-4" /> Columns</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>{table.label} columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {table.columns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.key}
            checked={isVisible(column.key)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={async (checked) => {
              const result = await setColumnVisible(column.key, Boolean(checked));
              if (result.localOnly) toast.message("Saved in this browser only (Supabase unavailable).");
            }}
          >
            {column.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
