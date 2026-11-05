// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ role: 'admin', org: 'org', hidden: [] as string[], rpc: vi.fn(), payload: {} as Record<string, unknown> }));
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: mock.rpc } }));
vi.mock('@/lib/use-user', () => ({ useUser: () => ({ activeRole: mock.role, profile: { organization_id: mock.org }, hiddenSections: mock.hidden }) }));
vi.mock('@/lib/demo', () => ({ DEMO_MODE: false }));
import { JobProfitabilityActuals } from '@/components/job-profitability-actuals';
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  mock.role = 'admin'; mock.org = 'org'; mock.hidden = []; mock.rpc.mockReset();
  mock.payload = { organizationId: 'org', jobId: 'job', canConfigure: true,
    config: { enabled: false, revision: 0, approved_at: null, labour_rate_pence: 2000, overhead_basis: 'none', overhead_rate_pence: null },
    machineChoices: [{ id: 'mill', name: 'Mill' }], rates: [], estimate: null };
  mock.rpc.mockImplementation(async (name: string) => ({ data: name === 'job_profitability_actual_inputs' ? mock.payload : null, error: null }));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const mount = async () => { await act(async () => root.render(createElement(JobProfitabilityActuals, { jobId: 'job' }))); };
it.each(['workshop','viewer'])('never reads financial inputs for %s', async role => { mock.role = role; await mount(); expect(mock.rpc).not.toHaveBeenCalled(); expect(host.textContent).toBe(''); });
it('keeps the panel hidden for office when the feature is off', async () => { mock.role = 'office'; mock.payload.canConfigure = false; await mount(); expect(host.textContent).toBe(''); });
it('shows only admin configuration when disabled and explicitly approves enablement', async () => {
  await mount(); expect(host.textContent).toContain('disabled'); expect(host.textContent).not.toContain('Actual margin');
  expect((host.querySelector('[name="labour"]') as HTMLInputElement).value).toBe('20.00');
  const enable = [...host.querySelectorAll('button')].find(b => b.value === 'enable')!;
  await act(async () => enable.click());
  expect(mock.rpc).toHaveBeenCalledWith('save_job_costing_rates', expect.objectContaining({ p_revision: 0, p_enabled: true, p_labour: 2000, p_machines: [] }));
});
it('does not round away a badly entered rate or write it', async () => {
  await mount(); (host.querySelector('[name="labour"]') as HTMLInputElement).value = '20.005';
  await act(async () => host.querySelector('form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })));
  expect(mock.rpc.mock.calls.filter(([name]) => name === 'save_job_costing_rates')).toHaveLength(0);
  expect(host.textContent).toContain('no more than two decimal places');
});
it('shows pounds, full costs, and a job estimate form without exposing admin controls to office', async () => {
  mock.role = 'office'; mock.payload.canConfigure = false;
  Object.assign(mock.payload, { config: { enabled: true, revision: 1, approved_at: '2026-11-04', labour_rate_pence: 2000, overhead_basis: 'none', overhead_rate_pence: null },
    estimate: { labour_not_required: true, machines_not_required: true, labour_hours: 0, supplier_pence: 1000, overhead_hours: 0 },
    labour: [], machines: [], plans: [], pos: [{ id: 'po', status: 'sent', total_value: '10.00' }],
    invoices: [{ id: 'i', status: 'sent', subtotal: '200.00' }], credits: [], quoteLines: [{ quantity: 1, unit_price: 200 }] });
  await mount(); expect(host.textContent).toContain('£190.00'); expect(host.textContent).toContain('95.0%');
  expect(host.textContent).toContain('Save job estimate'); expect(host.textContent).not.toContain('Approve rates');
});
it('shows incomplete without guessed cost zeroes when recorded hours are missing', async () => {
  mock.payload.config = { enabled: true, revision: 1, approved_at: '2026-11-04', labour_rate_pence: 2000, overhead_basis: 'none', overhead_rate_pence: null };
  Object.assign(mock.payload, { labour: [], machines: [], plans: [], pos: [], invoices: [], credits: [], quoteLines: [] });
  await mount(); expect(host.textContent).toContain('Costing incomplete'); for (const label of ['Labour cost (after machine inclusions)', 'Machine cost', 'Additional overheads', 'Actual profit']) {
    const dt = [...host.querySelectorAll('dt')].find(n => n.textContent === label)!;
    expect(dt.nextElementSibling!.textContent).toBe('Not available');
  }
});
it('leaves legacy UI usable when migration 148 is absent', async () => { mock.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } }); await mount(); expect(host.textContent).toBe(''); });

it('clears the financial display when access or company changes', async () => {
  await mount(); expect(host.textContent).toContain('Company costing rates');
  mock.hidden = ['invoices']; await mount(); expect(host.textContent).toBe('');
  mock.hidden = []; mock.org = 'other'; await mount(); expect(host.textContent).toBe('');
});
it('labels the progress view as an unsaved projection, separate from actual profit',async()=>{
 mock.payload.config={enabled:true,revision:1,approved_at:'2026-11-05',labour_rate_pence:2000,overhead_basis:'none',overhead_rate_pence:null};
 Object.assign(mock.payload,{labour:[],machines:[],plans:[],pos:[],invoices:[],credits:[],quoteLines:[]});
 await mount();const section=host.querySelector('[aria-label="Job progress projection"]');
 expect(section?.textContent).toContain('It is not actual profit');expect(section?.textContent).toContain('not saved');expect(section?.textContent).toContain('Not available');
});
