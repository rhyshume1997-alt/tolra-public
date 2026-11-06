import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createXeroClient } from '@/lib/integrations/xero/client';
const row = (kind: 'invoice' | 'credit_note', id = 'synthetic-xero-1') => kind === 'invoice'
  ? { InvoiceID: id, InvoiceNumber: 'SYN-001', Type: 'ACCREC', Status: 'AUTHORISED', SubTotal: 100, TotalTax: 20, Total: 120 }
  : { CreditNoteID: id, CreditNoteNumber: 'SYN-001', Type: 'ACCRECCREDIT', Status: 'AUTHORISED', SubTotal: 100, TotalTax: 20, Total: 120 };
const client = (kind: 'invoice' | 'credit_note', rows: unknown) => createXeroClient({
  accessToken: 'synthetic-token', tenantId: 'synthetic-tenant',
  fetchImpl: vi.fn(async () => new Response(JSON.stringify({ [kind === 'invoice' ? 'Invoices' : 'CreditNotes']: rows }), { status: 200 })) as typeof fetch,
});
describe.each(['invoice', 'credit_note'] as const)('%s read-back safety', kind => {
  it('refuses ambiguous numbers instead of choosing the first match', async () => {
    await expect(client(kind, [row(kind), row(kind, 'synthetic-xero-2')]).readBack(kind, 'SYN-001')).rejects.toMatchObject({ outcome: 'unknown' });
  });
  it.each(['SubTotal','TotalTax','Total'] as const)('refuses a missing %s instead of inventing zero', async field => {
    const incomplete: Record<string, unknown> = row(kind); delete incomplete[field];
    await expect(client(kind, [incomplete]).readBack(kind, 'SYN-001')).rejects.toMatchObject({ outcome: 'unknown' });
  });
  it('refuses non-finite/invalid totals', async () => {
    await expect(client(kind, [{...row(kind), Total: 'not-money'}]).readBack(kind, 'SYN-001')).rejects.toMatchObject({ outcome: 'unknown' });
  });
  it('still accepts a single full exact match', async () => {
    expect(await client(kind, [row(kind)]).readBack(kind, 'SYN-001')).toMatchObject({ externalId: 'synthetic-xero-1', totals: {subTotal:100,totalTax:20,total:120} });
  });
});
it('never treats a purchase credit as a matching sales credit', async () => {
  expect(await client('credit_note', [{...row('credit_note'), Type:'ACCPAYCREDIT'}]).readBack('credit_note','SYN-001')).toBeNull();
});
it('holds an incomplete document list instead of treating it as empty', async () => {
  await expect(client('invoice', undefined).readBack('invoice','SYN-001')).rejects.toMatchObject({outcome:'unknown'});
});
it('holds a matching record without an identity', async () => {
  await expect(client('invoice',[{...row('invoice'),InvoiceID:undefined}]).readBack('invoice','SYN-001')).rejects.toMatchObject({outcome:'unknown'});
});
it('holds a matching record without a type', async () => {
  await expect(client('invoice',[{...row('invoice'),Type:undefined}]).readBack('invoice','SYN-001')).rejects.toMatchObject({outcome:'unknown'});
});
