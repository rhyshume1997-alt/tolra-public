"use client";
import { useEffect, useState, type FormEvent } from 'react';
import { actualJobProfit, type ActualCostInputs } from '@/lib/job-profitability-actuals';
import { gbp, toPence } from '@/lib/money';
import { supabase } from '@/lib/supabase';
import { useUser } from '@/lib/use-user';
import { DEMO_MODE } from '@/lib/demo';

type Inputs = ActualCostInputs & { canConfigure: boolean; machineChoices: { id: string; name: string }[] };
const money = (n: number | null) => n === null ? 'Not available' : gbp(n / 100);
const pounds = (n: number | null | undefined) => n == null ? '' : (n / 100).toFixed(2);
function price(form: FormData, key: string, optional = false): number | null {
  const s = String(form.get(key) ?? '').trim();
  if (optional && !s) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) throw new Error('Enter pounds and pence, with no more than two decimal places.');
  const n = toPence(Number(s));
  if (n === null || n < 0 || n > 2147483647) throw new Error('Costing rate is outside the supported range.');
  return n;
}
function hours(form: FormData, key: string): string | null {
  const s = String(form.get(key) ?? '').trim();
  if (!s) return null;
  if (!/^\d+(?:\.\d{1,6})?$/.test(s) || Number(s) > 999999) throw new Error('Enter valid hours, with up to six decimal places.');
  return s;
}

/** New, optional view. The legacy BoughtInProfit display remains available above this panel. */
export function JobProfitabilityActuals({ jobId }: { jobId: string }) {
  const { activeRole, profile, hiddenSections } = useUser();
  const organizationId = profile?.organization_id;
  const allowed = !DEMO_MODE && !!organizationId && ['admin', 'office'].includes(activeRole)
    && !['jobs', 'invoices', 'quotes', 'purchase-orders'].some(section => hiddenSections.includes(section));
  const [input, setInput] = useState<Inputs | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    setInput(null); setMessage('');
    if (!allowed || !supabase || jobId.startsWith('demo')) return;
    let alive = true;
    void supabase.rpc('job_profitability_actual_inputs', { p_job: jobId }).then(({ data, error }) => {
      if (!alive) return;
      if (error) {
        // Before 148 is installed the unchanged legacy view remains usable.
        if (error.code !== 'PGRST202' && error.code !== '42883') setMessage('Actual costing unavailable. Check financial access and try again.');
      } else setInput(data as Inputs);
    }, () => { if (alive) setMessage('Actual costing unavailable. Try again.'); });
    return () => { alive = false; };
  }, [allowed, organizationId, jobId, version]);
  if (!allowed) return null;
  if (!input || input.organizationId !== organizationId) return message ? <p role="status">{message}</p> : null;
  if (!input.config.enabled && !input.canConfigure) return null;
  const figure = actualJobProfit(input);
  async function save(event: FormEvent<HTMLFormElement>, rates: boolean) {
    event.preventDefault();
    if (!input || !supabase || busy) return;
    const form = new FormData(event.currentTarget);
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    setBusy(true); setMessage('');
    try {
      const call = rates ? supabase.rpc('save_job_costing_rates', {
        p_organization: input.organizationId, p_revision: input.config.revision, p_enabled: submitter?.value === 'enable', p_labour: price(form, 'labour'),
        p_overhead_basis: form.get('basis'), p_overhead: price(form, 'overhead', true),
        p_machines: input.machineChoices.flatMap(machine => {
          if (!String(form.get(`rate-${machine.id}`) ?? '').trim()) return [];
          return [{ machine_id: machine.id, rate_pence: price(form, `rate-${machine.id}`), includes_labour: form.has(`labour-${machine.id}`), includes_overhead: form.has(`overhead-${machine.id}`) }];
        }),
      }) : supabase.rpc('save_job_cost_estimate', {
        p_job: jobId, p_supplier: price(form, 'supplier', true), p_labour: hours(form, 'hours'), p_overhead: hours(form, 'oh-hours'),
        p_no_labour: form.has('no-labour'), p_no_machines: form.has('no-machines'),
      });
      const { error } = await call;
      if (error) throw new Error('Save refused. Check your access, reload current rates and try again.');
      setVersion(v => v + 1);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Save failed.'); }
    finally { setBusy(false); }
  }
  const field = 'rounded border p-1 ml-2';
  return <section className="space-y-3 rounded-lg border p-4 text-sm" aria-label="Actual job costing" data-testid="actual-job-costing">
    <h3 className="font-semibold">Actual job costing {figure.state === 'off' ? '— disabled' : `— rates revision ${input.config.revision}`}</h3>
    <p>Net values, excluding VAT. This uses company costing rates, not employee pay. Rate changes recalculate this view for earlier jobs. The existing profit figure stays above.</p>
    {figure.state !== 'off' && <>
      {figure.state === 'incomplete' && <p className="font-semibold" role="status">Costing incomplete: {figure.reasons.join('; ')}.</p>}
      <dl className="grid grid-cols-2 gap-2">
        {Object.entries({ 'Quoted value': money(figure.quotedPence), 'Invoiced less credits': money(figure.invoicedPence), 'Supplier costs': money(figure.supplierPence),
          'Recorded labour hours': figure.labourMilliseconds === null ? 'Not available' : (figure.labourMilliseconds / 3600000).toFixed(2),
          'Labour cost (after machine inclusions)': money(figure.labourPence),
          'Recorded machine hours': figure.machineMilliseconds === null ? 'Not available' : (figure.machineMilliseconds / 3600000).toFixed(2),
          'Machine cost': money(figure.machinePence), 'Additional overheads': money(figure.overheadPence), 'Estimated profit': money(figure.estimatedProfitPence),
          'Actual profit': money(figure.actualProfitPence), 'Actual margin': figure.marginPct === null ? 'Not available' : `${figure.marginPct.toFixed(1)}%`,
          'Actual minus estimated profit': money(figure.differencePence) }).map(([name, value]) => <div key={name}><dt>{name}</dt><dd className="font-semibold">{value}</dd></div>)}
      </dl>
      {figure.warnings.map(w => <p className="text-amber-800" key={w}>{w}</p>)}
      <details><summary>Job estimate and required hours</summary>
        <p>Use the original estimate. Machine estimates come from the job’s planned machines. Additional hours exclude labour or overheads already included in machine rates. Blank estimates stay unknown.</p>
        <form key={`estimate-${version}`} onSubmit={e => void save(e, false)} className="grid gap-2 py-2">
          <label>Estimated supplier cost (£)<input className={field} name="supplier" inputMode="decimal" defaultValue={pounds(input.estimate?.supplier_pence)} /></label>
          <label>Estimated additional labour hours<input className={field} name="hours" inputMode="decimal" defaultValue={input.estimate?.labour_hours ?? ''} /></label>
          <label>Estimated additional overhead hours<input className={field} name="oh-hours" inputMode="decimal" defaultValue={input.estimate?.overhead_hours ?? ''} /></label>
          <label><input name="no-labour" type="checkbox" defaultChecked={input.estimate?.labour_not_required} /> This job needs no recorded labour hours</label>
          <label><input name="no-machines" type="checkbox" defaultChecked={input.estimate?.machines_not_required} /> This job needs no machine hours</label>
          <button disabled={busy} className="rounded border p-2">Save job estimate</button>
        </form>
      </details>
    </>}
    {input.canConfigure && <details><summary>Company costing rates (admin only)</summary>
      <p>Agree these rates before enabling. Approval applies to all company jobs. Saving disabled switches the new view off. Blank machine rates leave affected jobs incomplete. A zero rate must be an explicit agreed choice.</p>
      <form key={`rates-${version}`} onSubmit={e => void save(e, true)} className="grid gap-2 py-2">
        <label>Labour rate (£/hour)<input className={field} name="labour" required inputMode="decimal" defaultValue={pounds(input.config.labour_rate_pence)} /></label>
        <label>Additional overhead basis<select name="basis" className={field} defaultValue={input.config.overhead_basis}><option value="none">None</option><option value="labour">Recorded labour hours</option><option value="machine">Recorded machine hours</option></select></label>
        <label>Additional overhead rate (£/hour)<input className={field} name="overhead" inputMode="decimal" defaultValue={pounds(input.config.overhead_rate_pence)} /></label>
        {input.machineChoices.map(machine => {
          const rate = input.rates.find(r => r.machine_id === machine.id);
          return <fieldset key={machine.id} className="rounded border p-2"><legend>{machine.name}</legend>
            <label>Machine rate (£/hour)<input className={field} name={`rate-${machine.id}`} inputMode="decimal" defaultValue={pounds(rate?.rate_pence)} /></label>
            <label className="block"><input type="checkbox" name={`labour-${machine.id}`} defaultChecked={rate?.includes_labour} /> Rate includes operator labour</label>
            <label className="block"><input type="checkbox" name={`overhead-${machine.id}`} defaultChecked={rate?.includes_overhead} /> Rate includes overheads</label>
          </fieldset>;
        })}
        <button disabled={busy} value="disable" className="rounded border p-2">Save rates with costing disabled</button>
        <button disabled={busy} value="enable" className="rounded border p-2">Approve rates and enable company costing</button>
      </form>
    </details>}
    {message && <p role="status">{message}</p>}
  </section>;
}
