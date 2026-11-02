import { describe, it, expect } from 'vitest';
import { calcUnitCost, calcDetailedQuote } from '../../lib/costing/engine';
const base = { quantity: 10, stock_weight_lb: 2, cost_per_lb: 3, scrap_factor: 0.05,
  ops: [{ name: 'Mill', sequence: 1, setup_time_hr: 1, cycle_time_hr: 0.2, allowance_pct: 0.1,
    machine_rate_per_hr: 60, labor_rate_per_hr: 30, tool_change_time_min: 6, inspection_time_min: 3,
    tool_cost_per_part: 1.5, consumables_cost_per_part: 0.5 }] };
describe('Python engine parity', () => {
  it('calculates basic formula exactly', () => expect(calcUnitCost(base)).toEqual({
    material_unit: 6.3, machine_unit: 19.2, labor_unit: 9.6,
    unit_cost: 35.1, unit_price: 40.37, total_time_hr: 0.32,
  }));
  it('includes full operation time in detailed quote', () => {
    const d = calcDetailedQuote(base);
    expect(d.operations[0].time.total).toBe(0.47);
    expect(d.summary.quantity).toBe(10);
    expect(d.time_breakdown.total_time_per_part).toBe(0.47);
  });
  it('applies programming and first article across quantity', () => {
    const d = calcDetailedQuote({ ...base, programming_time_hr: 2, first_article_inspection_hr: 1 });
    expect(d.cost_breakdown.programming_cost).toBe(15);
    expect(d.cost_breakdown.inspection_cost).toBe(7.5);
  });
  it('uses overhead only on machine and labour', () => {
    const d = calcDetailedQuote(base);
    expect(d.cost_breakdown.overhead_cost).toBe(21.15);
  });
  it('uses Python default overhead factor 1.5 and margin 15 percent', () => {
    expect(calcDetailedQuote(base).summary.margin_pct).toBe(15);
  });
  it('rejects invalid quantity', () => expect(() => calcUnitCost({ ...base, quantity: 0 })).toThrow());
  it('rejects non finite input', () => expect(() => calcDetailedQuote({ ...base, cost_per_lb: Infinity })).toThrow());
  it('returns no time cost with zero operations', () => expect(calcUnitCost({ ...base, ops: [] }).machine_unit).toBe(0));
});
