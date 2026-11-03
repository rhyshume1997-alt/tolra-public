'use client';
import type { CostingRates, CostingMaterial, CostingMachine } from './types';
export type CostingRatesProps = { value: CostingRates; onChange: (value: CostingRates) => void; onSave?: () => void; saving?: boolean };
const numeric = (v: string) => Math.max(0, Number(v) || 0);
export function CostingRatesEditor({ value, onChange, onSave, saving }: CostingRatesProps) {
  const change = (patch: Partial<CostingRates>) => { if (!saving) onChange({ ...value, ...patch }); };
  const input = (name: string, number: number, update: (n: number) => void) =>
    <label className="block text-sm">{name}<input aria-label={name} className="block w-full rounded border p-2" type="number" min="0" step="0.01" value={number} onChange={e => update(numeric(e.target.value))} /></label>;
  const modifyMaterial = (id: string, patch: Partial<CostingMaterial>) => change({ materials: value.materials.map(m => m.id === id ? { ...m, ...patch } : m) });
  const modifyMachine = (id: string, patch: Partial<CostingMachine>) => change({ machines: value.machines.map(m => m.id === id ? { ...m, ...patch } : m) });
  return <section aria-label="Costing rates" className="space-y-4">
    <fieldset disabled={saving} className="space-y-4">
    <h2 className="text-lg font-semibold">Costing rates</h2>
    <p className="text-sm">All prices are in pounds. Set your materials and machines before pricing a quote. Profit added is a percentage of the cost: £100 cost plus 20% gives a £120 price before VAT.</p>
    <h3 className="font-medium">Materials</h3>
    {value.materials.map((m, index) => <div key={m.id} className="grid gap-2 rounded border p-3 sm:grid-cols-4">
      <input aria-label={'Material name ' + (index + 1)} className="border p-2" value={m.name} onChange={e => modifyMaterial(m.id, { name: e.target.value })} />
      <select aria-label={'Material unit ' + (index + 1)} value={m.unit} onChange={e => modifyMaterial(m.id, { unit: e.target.value as 'kg' | 'each' })}><option value="kg">Per kg</option><option value="each">Each</option></select>
      {input('Price £ ' + (index + 1), m.price, price => modifyMaterial(m.id, { price }))}
      {input('Extra material for waste % ' + (index + 1), m.scrapPct, scrapPct => modifyMaterial(m.id, { scrapPct }))}
      <button type="button" onClick={() => change({ materials: value.materials.filter(x => x.id !== m.id) })}>Remove material</button>
    </div>)}
    <button type="button" onClick={() => change({ materials: [...value.materials, { id: crypto.randomUUID(), name: '', unit: 'kg', price: 0, scrapPct: 5 }] })}>Add material</button>
    <h3 className="font-medium">Machines</h3>
    {value.machines.map((m, index) => <div key={m.id} className="flex gap-3 rounded border p-3">
      <input aria-label={'Machine name ' + (index + 1)} className="border p-2" value={m.name} onChange={e => modifyMachine(m.id, { name: e.target.value })} />
      {input('Machine £ per hour ' + (index + 1), m.hourlyRate, hourlyRate => modifyMachine(m.id, { hourlyRate }))}
      <button type="button" onClick={() => change({ machines: value.machines.filter(x => x.id !== m.id) })}>Remove machine</button>
    </div>)}
    <button type="button" onClick={() => change({ machines: [...value.machines, { id: crypto.randomUUID(), name: '', hourlyRate: 0 }] })}>Add machine</button>
    <div className="grid gap-3 sm:grid-cols-2">
      {input('Labour £ per hour', value.labourPerHour, labourPerHour => change({ labourPerHour }))}
      {input('Programming £ per hour', value.programmingPerHour, programmingPerHour => change({ programmingPerHour }))}
      {input('Other running costs %', value.overheadPct, overheadPct => change({ overheadPct }))}
      {input('Profit added %', value.marginPct, marginPct => change({ marginPct }))}
    </div>
    {onSave && <button type="button" disabled={saving} onClick={onSave}>Save costing rates</button>}
    </fieldset>
  </section>;
}
