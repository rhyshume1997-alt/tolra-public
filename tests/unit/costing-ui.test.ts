import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CostingRatesEditor } from '../../components/costing/costing-rates-editor';
import { PriceThisPart } from '../../components/costing/price-this-part';
import type { CostingRates } from '../../components/costing/types';
const empty: CostingRates = { materials: [], machines: [], labourPerHour: 25, programmingPerHour: 40, overheadPct: 15, marginPct: 20 };
const ready: CostingRates = { ...empty, materials: [{ id: 'steel', name: 'Steel', unit: 'kg', price: 4, scrapPct: 5 }],
  machines: [{ id: 'mill', name: 'Mill', hourlyRate: 65 }] };
describe('costing controls', () => {
  it('renders editable rate fields', () => {
    const html = renderToStaticMarkup(React.createElement(CostingRatesEditor, { value: ready, onChange: vi.fn() }));
    for (const label of ['Costing rates', 'Per kg', 'Scrap %', 'Labour £ per hour', 'Programming £ per hour', 'Overhead %', 'Margin %', 'Add material', 'Add machine']) expect(html).toContain(label);
  });
  it('hides pricing until a material and machine exist', () => {
    expect(renderToStaticMarkup(React.createElement(PriceThisPart, { rates: empty, onAdd: vi.fn() }))).toBe('');
    expect(renderToStaticMarkup(React.createElement(PriceThisPart, { rates: { ...ready, machines: [] }, onAdd: vi.fn() }))).toBe('');
  });
  it('shows a full cost breakdown and quote line action when configured', () => {
    const html = renderToStaticMarkup(React.createElement(PriceThisPart, { rates: ready, onAdd: vi.fn() }));
    for (const label of ['Price this part', 'Material weight kg', 'Machine', 'Cost per part', 'Total quote', 'Add as quote line']) expect(html).toContain(label);
  });
});
