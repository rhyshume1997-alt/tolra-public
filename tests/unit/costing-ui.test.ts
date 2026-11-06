import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CostingRatesEditor } from '../../components/costing/costing-rates-editor';
import { PriceThisPart } from '../../components/costing/price-this-part';
import { blankCostingRates, type CostingRates } from '../../components/costing/types';

vi.mock('@/lib/use-user', () => ({ useUser: () => ({ activeRole: 'admin' }) }));
vi.mock('@/lib/supabase', () => ({ supabase: null }));

const ready: CostingRates = { materials: [{ id: 'steel', name: 'Steel', unit: 'kg', price: 4, scrapPct: 5 }],
  machines: [{ id: 'mill', name: 'Mill', hourlyRate: 65, labourPerHour: null }], defaults: { labourPerHour: 25, programmingPerHour: 40, overheadPct: 150, marginPct: 20 } };
const html = (rates: CostingRates) => renderToStaticMarkup(React.createElement(PriceThisPart, { rates, onAdd: vi.fn() }));
describe('costing controls', () => {
  it('renders editable rate fields', () => {
    const out = renderToStaticMarkup(React.createElement(CostingRatesEditor, { value: ready, onChange: vi.fn() }));
    for (const label of ['Costing rates', 'Per kg', 'Scrap %', 'Labour £ per hour', 'Programming £ per hour', 'Overhead %', 'Margin %', 'Add material', 'Add machine']) expect(out).toContain(label);
  });
  it('blank rates: the editor says nothing is entered, and shows no value', () => {
    const out = renderToStaticMarkup(React.createElement(CostingRatesEditor, { value: blankCostingRates, onChange: vi.fn() }));
    expect(out).toContain('No costing rates entered yet');
    expect(out).not.toMatch(/value="[^"]+"/);
  });
  it('the pricing panel shows no figure until the company has rates (blank, and each part missing)', () => {
    for (const rates of [blankCostingRates, { ...ready, machines: [] }, { ...ready, materials: [] }, { ...ready, defaults: blankCostingRates.defaults }]) {
      const out = html(rates);
      expect(out).toContain('Costing is not set up: enter your rates in Settings &gt; Costing rates');
      expect(out).not.toMatch(/£\d|Cost per part|Total quote|Add as quote line/);
    }
  });
  it('shows the fields and quote line action when configured (figures wait for the part to be described)', () => {
    const out = html(ready);
    for (const label of ['Price this part', 'Material weight kg', 'Machine', 'Add as quote line']) expect(out).toContain(label);
    expect(out).not.toMatch(/£\d|Cost per part|Total quote/);
  });
});

describe('page wiring', () => {
  const read = (file: string) => readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
  it('Settings shows the Costing rates card', () => {
    const page = read('app/(dashboard)/settings/page.tsx');
    expect(page).toContain('import { CostingRatesCard } from "@/components/costing/costing-rates-card";');
    expect(page).toContain('<CostingRatesCard />');
  });
  it('the quote builder shows Price this part beside the existing (Python) line picker, which is still there and untouched', () => {
    const page = read('app/(dashboard)/quotes/page.tsx');
    expect(page).toContain('<QuotePricePanel');
    expect(page).toContain('<CostingLinePicker onAdd=');
    expect(page.indexOf('<CostingLinePicker')).toBeLessThan(page.indexOf('<QuotePricePanel'));
    expect(page).not.toMatch(/rates-store|app-rates/); // the page never reads or writes rates itself
  });
  it('the new panel and card make no call to the Python proxy', () => {
    for (const file of ['components/costing/price-this-part.tsx', 'components/costing/costing-rates-card.tsx', 'components/costing/costing-rates-editor.tsx', 'lib/costing/app-rates.ts', 'lib/costing/price-part.ts']) {
      expect(read(file)).not.toMatch(/api\/costing|costing-line-picker|fetchCostingParts|calculatePartCost/);
    }
  });
});
