"use client";

import { LayoutGrid, List, Table2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ViewMode } from "@/lib/view-mode";

const OPTIONS: Array<{ mode: ViewMode; label: string; Icon: typeof List }> = [
  { mode: "cards", label: "Cards", Icon: LayoutGrid },
  { mode: "list", label: "List", Icon: List },
  { mode: "table", label: "Table", Icon: Table2 },
];

/** Cards / List / Table switcher for list pages (hidden on phones, which always show cards; no Table up to 1024px, where dense tables don't fit). */
export function ViewSwitcher({ value, onChange, className = "", buttonClassName = "" }: { value: ViewMode; onChange: (mode: ViewMode) => void; className?: string; buttonClassName?: string }) {
  return (
    <div role="group" aria-label="View" className={`hidden items-center rounded-lg border border-slate-300 bg-white p-0.5 md:inline-flex dark:bg-transparent ${className}`}>
      {OPTIONS.map(({ mode, label, Icon }) => (
        <button
          key={mode}
          type="button"
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
          className={cn(`${mode === "table" ? "max-desk:hidden " : ""}inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:px-3.5 ${value === mode ? "bg-brand text-brand-ink" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/10"}`, buttonClassName)}
        >
          <Icon className="size-4" aria-hidden /> {label}
        </button>
      ))}
    </div>
  );
}
