import { describe, expect, it } from 'vitest';
import { actualJobProfit, costForMilliseconds, type ActualCostInputs, type CostTimer } from '@/lib/job-profitability-actuals';
const timer = (id: string, start = '08:00', end: string | null = '09:00'): CostTimer => ({ id, organization_id: 'org', job_id: 'job', user_id: 'worker', machine_id: 'mill', operator_id: 'worker', started_at: `2026-11-04T${start}:00Z`, ended_at: end ? `2026-11-04T${end}:00Z` : null });
const fixture = (): ActualCostInputs => ({ organizationId: 'org', jobId: 'job', config: { enabled: true, revision: 1, approved_at: '2026-11-04', labour_rate_pence: 2000, overhead_basis: 'labour', overhead_rate_pence: 500 }, rates: [{ machine_id: 'mill', rate_pence: 3000, includes_labour: false, includes_overhead: false }], labour: [timer('l')], machines: [timer('m')], plans: [{ machine_id: 'mill', estimated_hours: 1 }], estimate: { supplier_pence: 1000, labour_hours: 1, overhead_hours: 1, labour_not_required: false, machines_not_required: false }, pos: [{ id: 'po', total_value: '100.00', linked_net: '10.00', status: 'sent' }], invoices: [{ id: 'invoice', status: 'sent', subtotal: '200.00' }], credits: [{ invoice_id: 'invoice', status: 'issued', subtotal: '10.00' }], quoteLines: [{ quantity: 1, unit_price: 200 }] });
describe('optional actual job costing', () => {
  it('keeps the replacement off by default', () => { const x = fixture(); x.config.enabled = false; expect(actualJobProfit(x).state).toBe('off'); });
  it('uses net issued revenue less issued credits, allocated suppliers and recorded costs', () => {
    expect(actualJobProfit(fixture())).toMatchObject({ state: 'complete', invoicedPence: 19000, supplierPence: 1000, labourPence: 2000, machinePence: 3000, overheadPence: 500, actualProfitPence: 12500, estimatedProfitPence: 13500, differencePence: -1000, marginPct: 65.8 });
  });
  it('rounds exact half pennies up and smaller fractions down', () => { expect(costForMilliseconds(1800000, 1)).toBe(1); expect(costForMilliseconds(1799999, 1)).toBe(0); });
  it('unions overlapping labour and machine timers, including replayed IDs', () => { const x = fixture(); x.labour!.push(timer('l2','08:30','09:30'), timer('l')); x.machines!.push(timer('m2','08:30','09:30')); expect(actualJobProfit(x)).toMatchObject({ state: 'complete', labourMilliseconds: 5400000, machineMilliseconds: 5400000, labourPence: 3000, machinePence: 4500 }); });
  it('subtracts machine-inclusive labour and overhead once, including overlapping coverage', () => { const x = fixture(); x.rates[0].includes_labour = true; x.rates[0].includes_overhead = true; x.machines!.push(timer('m2','08:30','09:00')); expect(actualJobProfit(x)).toMatchObject({ state: 'complete', labourPence: 0, machinePence: 3000, overheadPence: 0 }); });
  it('only subtracts coverage for the recorded machine operator', () => { const x = fixture(); x.rates[0].includes_labour = true; x.machines![0].operator_id = 'other'; expect(actualJobProfit(x).labourPence).toBe(2000); });
  it('handles partial coverage and optional machine-hour overheads', () => { const x = fixture(); x.config.overhead_basis = 'machine'; x.rates[0].includes_labour = true; x.machines = [timer('m','08:30','09:00')]; expect(actualJobProfit(x)).toMatchObject({ labourPence: 1000, machinePence: 1500, overheadPence: 250 }); x.rates[0].includes_overhead = true; expect(actualJobProfit(x).overheadPence).toBe(0); });
  it.each(['labour rate','machine rate','labour hours','machine hours','open timer','approval','operator','foreign company','cross job','read failure','supplier allocation','shared quote'])('refuses to report actual profit with missing/ambiguous %s', kind => {
    const x = fixture();
    switch (kind) {
      case 'labour rate': x.config.labour_rate_pence = null; break;
      case 'machine rate': x.rates = []; break;
      case 'labour hours': x.labour = []; break;
      case 'machine hours': x.machines = []; break;
      case 'open timer': x.labour![0].ended_at = null; break;
      case 'approval': x.config.approved_at = null; break;
      case 'operator': x.rates[0].includes_labour = true; x.machines![0].operator_id = null; break;
      case 'foreign company': x.labour![0].organization_id = 'other'; break;
      case 'cross job': x.labour!.push({ ...timer('other'), job_id: 'other' }); break;
      case 'read failure': x.labour = null; break;
      case 'supplier allocation': x.pos![0].linked_net = 'invalid'; break;
      case 'shared quote': x.ambiguousQuoteCosts = true; break;
    }
    expect(actualJobProfit(x)).toMatchObject({ state: 'incomplete', actualProfitPence: null, labourPence: null, machinePence: null });
  });
  it('ignores voided sessions and disjoint other-job time', () => { const x = fixture(); x.labour!.push({ ...timer('void', '08:00', null), voided_at: '2026-11-04' }, { ...timer('other','10:00','11:00'), job_id: 'other' }); expect(actualJobProfit(x).state).toBe('complete'); });
  it('allows explicit no-labour/no-machine jobs without silently assuming missing hours are zero', () => { const x = fixture(); x.labour = []; x.machines = []; x.estimate!.labour_not_required = true; x.estimate!.machines_not_required = true; expect(actualJobProfit(x)).toMatchObject({ state: 'complete', labourPence: 0, machinePence: 0 }); });
  it('deduplicates supplier allocations and excludes cancelled purchases and draft credits', () => { const x = fixture(); x.pos!.push(x.pos![0], { id: 'cancel', status: 'cancelled', total_value: 999, linked_net: 999 }); x.credits!.push({ invoice_id: 'invoice', status: 'draft', subtotal: 999 }); expect(actualJobProfit(x).supplierPence).toBe(1000); expect(actualJobProfit(x).invoicedPence).toBe(19000); });
  it('shows negative margins and overruns', () => { const x = fixture(); x.invoices![0].subtotal = '20.00'; x.estimate!.labour_hours = 0.5; x.estimate!.supplier_pence = 0; const out = actualJobProfit(x); expect(out.actualProfitPence).toBe(-5500); expect(out.marginPct).toBe(-550); expect(out.warnings).toContain('Additional labour hours exceed the estimate'); expect(out.warnings).toContain('Actual costs exceed estimated costs'); });
  it('does not invent an estimate without planned costs', () => { const x = fixture(); x.estimate!.labour_hours = null; expect(actualJobProfit(x)).toMatchObject({ state: 'complete', estimatedProfitPence: null, differencePence: null }); });
});
it('refuses conflicting replays of a timer instead of choosing a copy', () => { const x = fixture(); x.labour!.push(timer('l','08:00','10:00')); expect(actualJobProfit(x).state).toBe('incomplete'); });
it('refuses cross-job machine overlap', () => { const x = fixture(); x.machines!.push({ ...timer('other'), job_id: 'another' }); expect(actualJobProfit(x).state).toBe('incomplete'); });
it('does not replace missing actual hours with planned hours', () => { const x = fixture(); x.machines = []; expect(actualJobProfit(x).actualProfitPence).toBeNull(); });
it('requires the selected overhead rate and allows explicitly no additional overhead', () => { const x = fixture(); x.config.overhead_rate_pence = null; expect(actualJobProfit(x).state).toBe('incomplete'); x.config.overhead_basis = 'none'; expect(actualJobProfit(x)).toMatchObject({ state: 'complete', overheadPence: 0 }); });
it('keeps zero revenue margin undefined and does not fall back to the quote', () => { const x = fixture(); x.invoices![0].subtotal = '10'; expect(actualJobProfit(x)).toMatchObject({ invoicedPence: 0, actualProfitPence: -6500, marginPct: null }); });
it('does not charge an explicit zero costing rate as if it were missing', () => { const x = fixture(); x.config.labour_rate_pence = 0; expect(actualJobProfit(x)).toMatchObject({ state: 'complete', labourPence: 0 }); });
it('fails closed for cost overflow', () => { const x = fixture(); x.config.labour_rate_pence = Number.MAX_SAFE_INTEGER; x.labour = [timer('l','08:00','10:00')]; expect(actualJobProfit(x)).toMatchObject({ state: 'incomplete', actualProfitPence: null }); });
it('refuses overlapping machine records with different operators when the rate includes labour', () => {
  const x = fixture(); x.rates[0].includes_labour = true;
  x.machines!.push({ ...timer('other-operator'), operator_id: 'second-worker' });
  x.labour!.push({ ...timer('second-worker-session'), user_id: 'second-worker' });
  expect(actualJobProfit(x)).toMatchObject({ state: 'incomplete', actualProfitPence: null });
});
