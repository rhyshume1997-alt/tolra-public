'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { loadCompanyRates, PANEL_NOT_SET_UP_MESSAGE, type LoadedRates } from '@/lib/costing/app-rates';
import { appliedLine, costNote, priceThisPart, type AppliedLine } from '@/lib/costing/price-part';
import { fromPence, gbp, linePence, toPence } from '@/lib/money';
import { supabase } from '@/lib/supabase';
import { useUser } from '@/lib/use-user';
import type { CostingRates } from './types';

export type PricePartProps = {
  rates: CostingRates;
  /** Copies the calculated price into a quote line, as plain values at this moment. Later rate changes never reach a line already added. */
  onAdd: (line: AppliedLine) => void;
  /** Optional: writes the cost breakdown, as text, into the quote's internal notes. */
  onCostNote?: (text: string) => void;
  /** Today's date as text for the cost note (a prop so tests are stable). */
  today?: string;
};
const entered = (value: string): number | null => (value.trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value));

/** The panel without its data hooks: rates in, a quote line out. With no rates (or some missing) it says so and shows no figure. */
export function PriceThisPart({ rates, onAdd, onCostNote, today }: PricePartProps) {
  const [materialId, setMaterialId] = useState('');
  const [machineId, setMachineId] = useState('');
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [amount, setAmount] = useState('');
  const [setupHours, setSetupHours] = useState('');
  const [cycleHours, setCycleHours] = useState('');
  const [programmingHours, setProgrammingHours] = useState('');
  const material = rates.materials.find(m => m.id === (materialId || rates.materials[0]?.id));
  const machine = rates.machines.find(m => m.id === (machineId || rates.machines[0]?.id));
  const pricing = useMemo(() => priceThisPart(rates, {
    materialId: materialId || rates.materials[0]?.id || '', machineId: machineId || rates.machines[0]?.id || '', quantity: Number(quantity), amountPerPart: entered(amount),
    setupHours: entered(setupHours), cycleHours: entered(cycleHours), programmingHours: entered(programmingHours),
  }), [rates, materialId, machineId, quantity, amount, setupHours, cycleHours, programmingHours]);

  if (pricing.status === 'not_set_up') {
    return <section aria-label="Price this part" className="space-y-2 rounded border p-4">
      <h2 className="text-lg font-semibold">Price this part</h2>
      <p role="status" className="text-sm">{PANEL_NOT_SET_UP_MESSAGE}</p>
      {pricing.blank ? null : <p className="text-sm">Still to enter: {pricing.missing.join(', ')}.</p>}
    </section>;
  }
  // aria-label of the Quantity box differs from the quote line's own "Quantity" so the two never share an accessible name.
  const field = (name: string, value: string, update: (v: string) => void, step = '0.01', label = name) =>
    <label className="grid gap-1 text-sm text-slate-600">{name}<Input aria-label={label} type="number" min="0" step={step} value={value} onChange={e => update(e.target.value)} /></label>;
  const figures = pricing.status === 'ok' ? pricing.figures : null;
  const ready = Boolean(figures && description.trim());
  // Inside the quote form: Enter in a box here must not save the quote.
  const noSubmit = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') e.preventDefault(); };
  return <section aria-label="Price this part" className="space-y-3 rounded border p-4" onKeyDown={noSubmit}>
    <h2 className="text-lg font-semibold">Price this part</h2>
    <label className="grid gap-1 text-sm text-slate-600">Description<Input aria-label="Part description" maxLength={500} value={description} onChange={e => setDescription(e.target.value)} /></label>
    <label className="grid gap-1 text-sm text-slate-600">Material<select aria-label="Part material" className="h-10 w-full rounded-lg border border-input bg-surface px-3 text-sm text-ink" value={material?.id ?? ''} onChange={e => setMaterialId(e.target.value)}>{!material ? <option value="">Choose a current material</option> : null}{rates.materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
    <label className="grid gap-1 text-sm text-slate-600">Machine<select aria-label="Part machine" className="h-10 w-full rounded-lg border border-input bg-surface px-3 text-sm text-ink" value={machine?.id ?? ''} onChange={e => setMachineId(e.target.value)}>{!machine ? <option value="">Choose a current machine</option> : null}{rates.machines.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
    <div className="grid gap-3 sm:grid-cols-2">
      {field('Quantity', quantity, setQuantity, '1', 'Part quantity')}
      {field(material?.unit === 'each' ? 'Pieces per part' : 'Material weight kg per part', amount, setAmount)}
      {field('Setup hours for batch', setupHours, setSetupHours)}
      {field('Cycle hours per part', cycleHours, setCycleHours)}
      {field('Programming hours for batch', programmingHours, setProgrammingHours)}
    </div>
    {pricing.status === 'need_input' ? <p role="status" className="text-sm text-slate-600">Enter {pricing.needs.join(', ')} to see the price.</p> : null}
    {figures ? <div aria-label="Cost breakdown" className="space-y-1 text-sm">
      <div>Material: {gbp(figures.materialCost)}</div>
      <div>Machine: {gbp(figures.machineCost)}</div>
      <div>Labour: {gbp(figures.labourCost)}</div>
      <div>Programming: {gbp(figures.programmingCost)}</div>
      <div>Overhead: {gbp(figures.overheadCost)}</div>
      <div>Cost per part: {gbp(figures.unitCost)}</div>
      <div>Price per part: {gbp(figures.unitPrice)}</div>
      <div>Total quote: {gbp(fromPence(linePence(figures.quantity, figures.unitPrice)))}</div>
      {linePence(figures.quantity, figures.unitPrice) !== toPence(figures.engineExtendedPrice ?? figures.extendedPrice) ? <p className="text-xs text-slate-500">The quote uses the rounded price per part. The costing batch estimate is {gbp(figures.engineExtendedPrice ?? figures.extendedPrice)} before each part is rounded.</p> : null}
    </div> : null}
    <div className="flex flex-wrap gap-2">
      <Button type="button" disabled={!ready} onClick={() => { if (figures && description.trim()) onAdd(appliedLine(description, figures)); }} className="bg-brand text-brand-ink hover:bg-brand-hover">Add as quote line</Button>
      {onCostNote ? <Button type="button" variant="outline" disabled={!ready} onClick={() => { if (figures && description.trim()) onCostNote(costNote(description, figures, today ?? new Date().toISOString().slice(0, 10))); }}>Add cost to internal notes</Button> : null}
    </div>
    <p className="text-xs text-slate-500">The price is copied into the quote line as plain numbers. Changing your costing rates later does not change a quote already saved.</p>
  </section>;
}

export type QuotePricePanelProps = {
  role: string;
  load: () => Promise<LoadedRates>;
  onAdd: (line: AppliedLine) => void;
  onCostNote?: (text: string) => void;
};

/** The quote builder's panel, without its data hooks: loads the company's rates once, admin and office only. */
export function QuotePricePanelView({ role, load, onAdd, onCostNote }: QuotePricePanelProps) {
  const allowed = role === 'admin' || role === 'office';
  const [result, setResult] = useState<LoadedRates | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!allowed) return;
    void load().then((r) => { if (alive.current) setResult(r); });
  }, [allowed, load]);
  if (!allowed || !result) return null;
  // 143 not applied: costing reads as off, like the rest of the app before an update.
  if (result.status === 'not_applied') return null;
  if (result.status === 'error') return <section aria-label="Price this part" className="rounded border p-4"><h2 className="text-lg font-semibold">Price this part</h2><p role="alert" className="text-sm text-red-700">Couldn&apos;t load your costing rates. Reload the page to try again.</p></section>;
  return <PriceThisPart rates={result.rates} onAdd={onAdd} onCostNote={onCostNote} />;
}

/** The quote builder's "Price this part", wired to the signed-in company's rates. */
export function QuotePricePanel(props: Omit<QuotePricePanelProps, 'role' | 'load'>) {
  const { activeRole } = useUser();
  const load = useCallback(() => loadCompanyRates(supabase), []);
  return <QuotePricePanelView role={activeRole} load={load} {...props} />;
}
