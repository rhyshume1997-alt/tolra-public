"use client";

import { useEffect, useState } from "react";
import { Calculator, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { friendlyError } from "@/lib/friendly-error";
import { fromPence, toPence } from "@/lib/money";
import { calculatePartCost, fetchCostingParts, isCostingEngineConfigured, type CostingBreakdown, type CostingPart } from "@/lib/costing";

export type CostedLineItem = { description: string; qty: number; unit: number };

type CostingLinePickerProps = {
  onAdd: (line: CostedLineItem) => void;
};

function gbp(value: number) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2 }).format(value);
}

export function CostingLinePicker({ onAdd }: CostingLinePickerProps) {
  const [parts, setParts] = useState<CostingPart[]>([]);
  const [partsError, setPartsError] = useState<string | null>(null);
  const [partId, setPartId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [marginPct, setMarginPct] = useState(20);
  const [result, setResult] = useState<CostingBreakdown | null>(null);
  const [calcError, setCalcError] = useState<string | null>(null);
  const [calculating, setCalculating] = useState(false);

  // null while checking; the panel stays hidden unless the engine is configured.
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    isCostingEngineConfigured().then((configured) => {
      if (cancelled) return;
      setEnabled(configured);
      if (!configured) return;
      fetchCostingParts()
        .then((rows) => { if (!cancelled) setParts(rows); })
        .catch((err) => { if (!cancelled) setPartsError(friendlyError(err, "Could not load parts.")); });
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { setResult(null); }, [partId, quantity, marginPct]);

  async function calculate() {
    if (!partId || !Number.isInteger(quantity) || quantity < 1 || !Number.isFinite(marginPct) || marginPct < 0 || marginPct > 95) return;
    setCalculating(true);
    setCalcError(null);
    try {
      setResult(await calculatePartCost(Number(partId), quantity, marginPct / 100));
    } catch (err) {
      setCalcError(friendlyError(err, "Calculation failed. Check the quantity and margin and try again."));
    } finally {
      setCalculating(false);
    }
  }

  function addLine() {
    if (!result) return;
    const { part_info, summary } = result;
    const description = [part_info.part_number, part_info.description, part_info.material_name].filter(Boolean).join(" · ");
    // Prices are stored to the penny, so round here and the preview, saved value and PDF all agree.
    onAdd({ description, qty: summary.quantity, unit: fromPence(toPence(summary.unit_price)) });
    setResult(null);
  }

  if (!enabled) return null;

  if (partsError) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        Costing engine unavailable — enter prices manually. ({partsError})
      </div>
    );
  }

  const costs = result?.cost_breakdown;

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <p className="flex items-center gap-2 text-sm font-semibold text-slate-950"><Calculator className="size-4 text-brand-accent" /> Price from costing engine</p>
      <div className="grid gap-2 md:grid-cols-[1fr_100px_110px_auto]">
        <select value={partId} onChange={(e) => setPartId(e.target.value)} className="h-9 rounded-lg border px-3 text-sm" aria-label="Part">
          <option value="">{parts.length ? "Select a part" : "Loading parts…"}</option>
          {parts.map((part) => <option key={part.id} value={part.id}>{part.part_number}{part.description ? ` — ${part.description}` : ""}</option>)}
        </select>
        <Input type="number" inputMode="numeric" step={1} min={1} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} aria-label="Quantity" placeholder="Qty" />
        <Input type="number" inputMode="decimal" step="any" min={0} max={95} value={marginPct} onChange={(e) => setMarginPct(Number(e.target.value))} aria-label="Margin %" placeholder="Margin %" />
        <Button type="button" variant="outline" disabled={!partId || !Number.isInteger(quantity) || quantity < 1 || calculating} onClick={() => void calculate()}>{calculating ? "Calculating…" : "Calculate"}</Button>
      </div>
      {calcError ? <p className="text-sm text-red-600">{calcError}</p> : null}
      {result && costs ? (
        <div className="space-y-3">
          <div className="grid gap-x-6 gap-y-1 rounded-lg bg-slate-50 p-3 text-sm sm:grid-cols-2">
            {([
              ["Material", costs.material.total],
              ["Machine", costs.machine_cost],
              ["Labour", costs.labor_cost],
              ["Tooling", costs.tooling_cost],
              ["Programming", costs.programming_cost],
              ["Inspection", costs.inspection_cost],
              ["Consumables", costs.consumables_cost],
              ["Overhead", costs.overhead_cost],
            ] as const).map(([label, value]) => (
              <div key={label} className="flex justify-between"><span className="text-slate-500">{label}</span><span>{gbp(value)}</span></div>
            ))}
            <div className="flex justify-between border-t pt-1 font-medium sm:col-span-2"><span>Unit cost → unit price ({result.summary.margin_pct}% margin)</span><span>{gbp(costs.unit_cost)} → {gbp(costs.unit_price)}</span></div>
            <div className="flex justify-between font-bold sm:col-span-2"><span>Line total ({result.summary.quantity} pcs, ex VAT)</span><span>{gbp(result.summary.extended_price)}</span></div>
          </div>
          <Button type="button" className="bg-brand text-brand-ink hover:bg-brand-hover" onClick={addLine}><Plus className="size-4" /> Add to quote</Button>
        </div>
      ) : null}
    </div>
  );
}
