'use client';
import { useMemo, useState } from 'react';
import { linePence, fromPence } from '@/lib/money';
import { calcDetailedQuote, type DetailedInputs } from '@/lib/costing/engine';
import type { CostingRates } from './types';
export type CostedQuoteLine = { description: string; quantity: number; unitPrice: number };
export type PricePartProps = { rates: CostingRates; onAdd: (line: CostedQuoteLine) => void };
export function safePartEstimate(input: DetailedInputs) {
  try { return calcDetailedQuote(input); } catch { return null; }
}
export const previewLineTotal = (quantity: number, unitPrice: number) => fromPence(linePence(quantity, unitPrice));
const positive = (value: string) => Math.max(0, Number(value) || 0);
export function PriceThisPart({ rates, onAdd }: PricePartProps) {
  const [materialId, setMaterialId] = useState('');
  const [machineId, setMachineId] = useState('');
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [weightKg, setWeightKg] = useState(1);
  const [setupHours, setSetupHours] = useState(0);
  const [cycleHours, setCycleHours] = useState(0);
  const [programmingHours, setProgrammingHours] = useState(0);
  const material = rates.materials.find(m => m.id === (materialId || rates.materials[0]?.id));
  const machine = rates.machines.find(m => m.id === (machineId || rates.machines[0]?.id));
  const estimate = useMemo(() => {
    if (!material || !machine || !Number.isInteger(quantity) || quantity < 1) return null;
    const perLb = material.unit === 'kg' ? material.price * 0.45359237 : material.price;
    const stockLb = material.unit === 'kg' ? weightKg / 0.45359237 : 1;
    return safePartEstimate({ quantity, stock_weight_lb: stockLb, cost_per_lb: perLb,
      scrap_factor: material.scrapPct / 100, margin_pct: rates.marginPct / 100,
      programming_time_hr: programmingHours, programming_rate_per_hr: rates.programmingPerHour,
      overhead_rate_pct: 1 + rates.overheadPct / 100,
      ops: [{ name: machine.name, sequence: 1, setup_time_hr: setupHours,
        cycle_time_hr: cycleHours, allowance_pct: 0, machine_rate_per_hr: machine.hourlyRate,
        labor_rate_per_hr: rates.labourPerHour }] });
  }, [material, machine, quantity, weightKg, setupHours, cycleHours, programmingHours, rates]);
  if (!rates.materials.length || !rates.machines.length) return null;
  const field = (name: string, value: number, update: (v: number) => void, step = '0.01') =>
    <label className="block text-sm">{name}<input aria-label={name} type="number" min="0" step={step} className="block w-full rounded border p-2" value={value} onChange={e => update(positive(e.target.value))} /></label>;
  return <section aria-label="Price this part" className="space-y-3 rounded border p-4">
    <h2 className="text-lg font-semibold">Price this part</h2>
    <label className="block text-sm">Description<input aria-label="Part description" className="block w-full rounded border p-2" value={description} onChange={e => setDescription(e.target.value)} /></label>
    <label className="block text-sm">Material<select aria-label="Material" className="block w-full rounded border p-2" value={material?.id} onChange={e => setMaterialId(e.target.value)}>{rates.materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
    <label className="block text-sm">Machine<select aria-label="Machine" className="block w-full rounded border p-2" value={machine?.id} onChange={e => setMachineId(e.target.value)}>{rates.machines.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
    <div className="grid gap-3 sm:grid-cols-2">
      {field('Quantity', quantity, v => setQuantity(Math.floor(v)), '1')}
      {material?.unit === 'kg' && field('Material weight kg per part', weightKg, setWeightKg)}
      {field('Setup hours for this batch', setupHours, setSetupHours)}
      {field('Making time per part (hours)', cycleHours, setCycleHours)}
      {field('Programming hours for this batch', programmingHours, setProgrammingHours)}
    </div>
    {!estimate && material && machine && <p role="alert">Check the quantity, costs and times. Quantity must be a whole number from 1 to 1,000,000.</p>}
    {estimate && <div aria-label="Cost breakdown" className="space-y-1 text-sm">
      <div>Material: £{estimate.cost_breakdown.material.total.toFixed(2)}</div>
      <div>Machine: £{estimate.cost_breakdown.machine_cost.toFixed(2)}</div>
      <div>Labour: £{estimate.cost_breakdown.labor_cost.toFixed(2)}</div>
      <div>Programming: £{estimate.cost_breakdown.programming_cost.toFixed(2)}</div>
      <div>Other running costs: £{estimate.cost_breakdown.overhead_cost.toFixed(2)}</div>
      <div>Cost per part: £{estimate.summary.unit_cost.toFixed(2)}</div>
      <div>Price per part: £{estimate.summary.unit_price.toFixed(2)}</div>
      <div>Quote line total before VAT: £{previewLineTotal(quantity, estimate.summary.unit_price).toFixed(2)}</div>
    </div>}
    <button type="button" disabled={!estimate || !description.trim()} onClick={() => {
      if (estimate && description.trim()) onAdd({ description: description.trim(), quantity, unitPrice: estimate.summary.unit_price });
    }}>Add as quote line</button>
  </section>;
}
