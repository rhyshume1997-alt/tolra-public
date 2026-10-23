"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function DateRangeFields({ from = "2026-05-01", to = "2026-05-31", onApply }: { from?: string; to?: string; onApply?: (range: { from: string; to: string }) => void }) {
  const [fromValue, setFromValue] = useState(from);
  const [toValue, setToValue] = useState(to);
  const [applied, setApplied] = useState({ from, to });

  function applyRange() {
    const range = { from: fromValue, to: toValue };
    setApplied(range);
    onApply?.(range);
    toast.success(`Date range applied: ${new Date(fromValue).toLocaleDateString("en-GB")} to ${new Date(toValue).toLocaleDateString("en-GB")}`);
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="text-sm font-medium text-slate-700">
          From
          <Input type="date" value={fromValue} onChange={(event) => setFromValue(event.target.value)} className="mt-1 h-11" />
        </label>
        <label className="text-sm font-medium text-slate-700">
          To
          <Input type="date" value={toValue} onChange={(event) => setToValue(event.target.value)} className="mt-1 h-11" />
        </label>
        <Button type="button" className="min-h-11 bg-brand text-brand-ink hover:bg-brand-hover" onClick={applyRange}>
          Apply
        </Button>
      </div>
      <p className="text-xs text-slate-500">
        Showing: {new Date(applied.from).toLocaleDateString("en-GB")} to {new Date(applied.to).toLocaleDateString("en-GB")}
      </p>
    </div>
  );
}
