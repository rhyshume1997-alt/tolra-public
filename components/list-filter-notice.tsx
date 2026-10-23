"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { type ListFilterPage, parseListFilter } from "@/lib/list-filter";

/**
 * The page's ?filter= value (lib/list-filter), read once after the page mounts so server and browser render the same first
 * paint. `clear` drops the filter and the parameter. The address keeps the parameter while the filter is on, so the link can be shared.
 */
export function useListFilter(page: ListFilterPage): [string | null, () => void] {
  const [filter, setFilter] = useState<string | null>(null);
  useEffect(() => { setFilter(parseListFilter(page, window.location.search)); }, [page]);
  const clear = useCallback(() => {
    setFilter(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("filter");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);
  return [filter, clear];
}

/** "Showing: Expired quotes" with a way back to the full list. */
export function ListFilterNotice({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <div data-testid="list-filter-notice" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
      <p>Showing only: <strong>{label}</strong></p>
      <Button variant="outline" size="sm" onClick={onClear}>Show everything</Button>
    </div>
  );
}
