'use client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NOT_SET_UP_MESSAGE, ratesGaps } from '@/lib/costing/app-rates';
import type { CostingRates, CostingMaterial, CostingMachine } from './types';
export type EditorNotice = { tone: 'ok' | 'error'; text: string } | null;
export type CostingRatesProps = {
  value: CostingRates; onChange: (value: CostingRates) => void; onSave?: () => void; saving?: boolean;
  notice?: EditorNotice; /** shown beside a stale-save notice: loads the company's current rates again */ onReload?: () => void;
};
/** A blank box is null: nothing is filled in for the company. */
const selectClass = 'h-10 w-full rounded-lg border border-input bg-surface px-3 text-sm text-ink';
const entered = (v: string): number | null => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Math.max(0, Number(v)));
export function CostingRatesEditor({ value, onChange, onSave, saving, notice, onReload }: CostingRatesProps) {
  const change = (patch: Partial<CostingRates>) => onChange({ ...value, ...patch });
  // `name` is what the person reads; `label` (with the row's id) is the box's accessible name, unique per row.
  const input = (name: string, number: number | null, update: (n: number | null) => void, label = name, step = '0.01') =>
    <label className="grid gap-1 text-sm text-slate-600">{name}<Input aria-label={label} type="number" min="0" step={step} value={number ?? ''} onChange={e => update(entered(e.target.value))} /></label>;
  const small = (label: string, onClick: () => void) => <Button type="button" variant="outline" size="sm" onClick={onClick}>{label}</Button>;
  const modifyMaterial = (id: string, patch: Partial<CostingMaterial>) => change({ materials: value.materials.map(m => m.id === id ? { ...m, ...patch } : m) });
  const modifyMachine = (id: string, patch: Partial<CostingMachine>) => change({ machines: value.machines.map(m => m.id === id ? { ...m, ...patch } : m) });
  const modifyDefaults = (patch: Partial<CostingRates['defaults']>) => change({ defaults: { ...value.defaults, ...patch } });
  const gaps = ratesGaps(value);
  return <section aria-label="Costing rates" className="space-y-4">
    <h2 className="text-lg font-semibold">Costing rates</h2>
    <p className="text-sm">All prices are in pounds. Enter your own materials, machines and rates: nothing is filled in for you, and quotes can only be priced from what you enter here.</p>
    {gaps.blank
      ? <p role="status" className="rounded border border-amber-200 bg-amber-50 p-2 text-sm">{NOT_SET_UP_MESSAGE}</p>
      : gaps.missing.length > 0 ? <p role="status" className="rounded border border-amber-200 bg-amber-50 p-2 text-sm">Still to enter: {gaps.missing.join(', ')}.</p> : null}
    <h3 className="font-medium">Materials</h3>
    {value.materials.map(m => <div key={m.id} className="grid items-end gap-2 rounded border p-3 sm:grid-cols-5">
      <label className="grid gap-1 text-sm text-slate-600">Material<Input aria-label={'Material name ' + m.id} placeholder="Material name" maxLength={80} value={m.name} onChange={e => modifyMaterial(m.id, { name: e.target.value })} /></label>
      <label className="grid gap-1 text-sm text-slate-600">Priced<select className={selectClass} aria-label={'Material unit ' + m.id} value={m.unit} onChange={e => modifyMaterial(m.id, { unit: e.target.value as 'kg' | 'each' })}><option value="kg">Per kg</option><option value="each">Each</option></select></label>
      {input('Price £', m.price, price => modifyMaterial(m.id, { price }), 'Price £ ' + m.id)}
      {input('Scrap %', m.scrapPct, scrapPct => modifyMaterial(m.id, { scrapPct }), 'Scrap % ' + m.id)}
      {small('Remove material', () => change({ materials: value.materials.filter(x => x.id !== m.id) }))}
    </div>)}
    <div>{small('Add material', () => change({ materials: [...value.materials, { id: crypto.randomUUID(), name: '', unit: 'kg', price: null, scrapPct: null }] }))}</div>
    <h3 className="font-medium">Machines</h3>
    {value.machines.map(m => <div key={m.id} className="grid items-end gap-2 rounded border p-3 sm:grid-cols-4">
      <label className="grid gap-1 text-sm text-slate-600">Machine<Input aria-label={'Machine name ' + m.id} placeholder="Machine name" maxLength={80} value={m.name} onChange={e => modifyMachine(m.id, { name: e.target.value })} /></label>
      {input('Machine £ per hour', m.hourlyRate, hourlyRate => modifyMachine(m.id, { hourlyRate }), 'Machine £ per hour ' + m.id)}
      {input('Labour £ per hour (optional)', m.labourPerHour, labourPerHour => modifyMachine(m.id, { labourPerHour }), 'Machine labour £ per hour (optional) ' + m.id)}
      {small('Remove machine', () => change({ machines: value.machines.filter(x => x.id !== m.id) }))}
    </div>)}
    <div>{small('Add machine', () => change({ machines: [...value.machines, { id: crypto.randomUUID(), name: '', hourlyRate: null, labourPerHour: null }] }))}</div>
    <h3 className="font-medium">Company rates</h3>
    <div className="grid gap-3 sm:grid-cols-2">
      {input('Labour £ per hour', value.defaults.labourPerHour, labourPerHour => modifyDefaults({ labourPerHour }))}
      {input('Programming £ per hour', value.defaults.programmingPerHour, programmingPerHour => modifyDefaults({ programmingPerHour }))}
      {input('Overhead %', value.defaults.overheadPct, overheadPct => modifyDefaults({ overheadPct }))}
      {input('Margin %', value.defaults.marginPct, marginPct => modifyDefaults({ marginPct }))}
    </div>
    <p className="text-xs text-slate-500">Overhead % is charged on machine and labour time: 100 means none, 150 means half as much again. Margin % is added on top of cost. A machine&apos;s own labour rate, if you give one, replaces the company labour rate for that machine.</p>
    {notice ? <p role={notice.tone === 'error' ? 'alert' : 'status'} className={notice.tone === 'error' ? 'text-sm text-red-700' : 'text-sm text-green-700'}>{notice.text}{onReload && notice.tone === 'error' ? <> <Button type="button" variant="outline" size="xs" onClick={onReload}>Reload costing rates</Button></> : null}</p> : null}
    {onSave && <Button type="button" disabled={saving} onClick={onSave} className="bg-brand text-brand-ink hover:bg-brand-hover">{saving ? 'Saving…' : 'Save costing rates'}</Button>}
  </section>;
}
