import { expect, it } from 'vitest';
import { actualJobProfit, type ActualCostInputs, type CostTimer } from '@/lib/job-profitability-actuals';
const timer = (id: string, start = '08:00', end: string | null = '09:00'): CostTimer => ({ id, organization_id: 'org', job_id: 'job', user_id: 'worker', machine_id: 'mill', operator_id: 'worker', started_at: `2026-11-04T${start}:00Z`, ended_at: end ? `2026-11-04T${end}:00Z` : null });
const fixture = (): ActualCostInputs => ({ organizationId: 'org', jobId: 'job', config: { enabled: true, revision: 1, approved_at: '2026-11-04', labour_rate_pence: 2000, overhead_basis: 'labour', overhead_rate_pence: 500 }, rates: [{ machine_id: 'mill', rate_pence: 3000, includes_labour: false, includes_overhead: false }], labour: [timer('l')], machines: [timer('m')], plans: [{ machine_id: 'mill', estimated_hours: 1 }], estimate: { supplier_pence: 1000, labour_hours: 1, overhead_hours: 1, labour_not_required: false, machines_not_required: false }, pos: [{ id: 'po', total_value: '100.00', linked_net: '10.00', status: 'sent' }], invoices: [{ id: 'invoice', status: 'sent', subtotal: '200.00' }], credits: [{ invoice_id: 'invoice', status: 'issued', subtotal: '10.00' }], quoteLines: [{ quantity: 1, unit_price: 200 }] });

it('keeps penny precision or refuses an unsafe revenue aggregate', () => {
  const x = fixture();
  x.invoices = Array.from({length:91}, (_,i) => ({id:`invoice-${i}`, status:'sent', subtotal:'999999999999.99'}));
  x.credits = []; x.pos = [{id:'po', status:'sent', total_value:'999999999999.99', linked_net:'999999999999.99'}];
  const exact = Number(BigInt(90) * BigInt("99999999999999") - BigInt(5500));
  const out = actualJobProfit(x);
  console.log('aggregate revenue', JSON.stringify({exact, actual:out.actualProfitPence, state:out.state}));
  if (out.state === 'complete') expect(out.actualProfitPence).toBe(exact);
  else expect(out.actualProfitPence).toBeNull();
});
it('retains recorded microseconds when they add up to half a penny', () => {
  const x = fixture(); x.config.labour_rate_pence = 10000; x.config.overhead_basis = 'none';
  x.machines = []; x.estimate!.machines_not_required = true; x.pos = [];
  x.labour = Array.from({length:360}, (_,i) => {
    const day = new Date(Date.UTC(2025,0,1+i)).toISOString().slice(0,10);
    return {...timer(`l-${i}`), started_at:`${day}T00:00:00.000000Z`, ended_at:`${day}T01:00:00.000500Z`};
  });
  // 360 * (3,600,000,500 microseconds) * 10,000p / 3,600,000,000 => 3,600,000.5p.
  expect(actualJobProfit(x).labourPence).toBe(3600001);
});
it('keeps fractional machine/overhead time and inclusive labour coverage exact', () => {
  const x = fixture(); x.config.labour_rate_pence = 10000; x.config.overhead_rate_pence = 10000;
  x.config.overhead_basis = 'machine'; x.rates[0].rate_pence = 10000;
  x.rates[0].includes_labour = true;
  const sessions = Array.from({length:360}, (_,i) => {
    const day = new Date(Date.UTC(2025,0,1+i)).toISOString().slice(0,10);
    return {...timer(`m-${i}`), started_at:`${day}T00:00:00.000000Z`, ended_at:`${day}T01:00:00.000500Z`};
  });
  x.machines = sessions; x.labour = sessions.map(t => ({...t,id:`lab-${t.id}`}));
  expect(actualJobProfit(x)).toMatchObject({state:'complete',labourPence:0,machinePence:3600001,overheadPence:3600001});
});
it('refuses unsupported timestamp precision instead of truncating it', () => {
  const x=fixture(); x.labour![0].ended_at='2026-11-04T09:00:00.0000001Z';
  expect(actualJobProfit(x)).toMatchObject({state:'incomplete',actualProfitPence:null});
});
