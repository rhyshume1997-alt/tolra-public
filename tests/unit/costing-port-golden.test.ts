import { describe, expect, it } from 'vitest';
import golden from '../fixtures/costing-golden.json';
import { calcDetailedQuote, type DetailedInputs } from '../../lib/costing/engine';

describe('Python costing golden parity', () => {
  it('ships all 60 frozen Python examples', () => expect(golden.cases).toHaveLength(60));
  it.each(golden.cases)('$name', (example) => {
    expect(calcDetailedQuote(example.input as DetailedInputs)).toEqual(example.dict);
  });
  it('rounds 21.125 down to 21.12 at an exact pence tie', () => {
    const result = calcDetailedQuote({
      quantity: 10, stock_weight_lb: 0, cost_per_lb: 0, scrap_factor: 0,
      ops: [{ name: 'Mill', sequence: 1, setup_time_hr: 0, cycle_time_hr: 0.325, allowance_pct: 0,
        machine_rate_per_hr: 65, labor_rate_per_hr: 0 }],
      overhead_rate_pct: 1, margin_pct: 0,
    });
    expect(result.cost_breakdown.machine_cost).toBe(21.12);
  });
});
