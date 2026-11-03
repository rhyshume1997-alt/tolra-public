/* Pure TypeScript port of services/costing-engine/app/services/quoting*.py.
   Preserve Python's intermediate float arithmetic and round only serialized values. */
export type Operation = {
  name: string; sequence: number; operation_type?: string;
  setup_time_hr: number; cycle_time_hr: number; allowance_pct: number;
  machine_rate_per_hr: number; labor_rate_per_hr: number;
  tool_change_time_min?: number; inspection_time_min?: number;
  tool_cost_per_part?: number; consumables_cost_per_part?: number;
};
export type QuoteInputs = {
  quantity: number; stock_weight_lb: number; cost_per_lb: number;
  scrap_factor: number; ops: Operation[]; margin_pct?: number;
};
export type DetailedInputs = QuoteInputs & {
  programming_time_hr?: number; programming_rate_per_hr?: number;
  first_article_inspection_hr?: number; overhead_rate_pct?: number;
};
function round(n: number, places: number): number {
  if (!Number.isFinite(n)) throw new RangeError('Invalid rounding input');
  if (!Number.isInteger(places) || places < 0 || places > 10) throw new RangeError('Invalid decimal precision');
  // Match Python round(binary64, digits): inspect the original IEEE 754 fraction,
  // not a floating point value first multiplied by 10 ** digits.
  if (n === 0) return 0;
  const negative = n < 0;
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setFloat64(0, Math.abs(n), false);
  const bits = view.getBigUint64(0, false);
  const exponent = Number((bits >> BigInt(52)) & BigInt(2047));
  const fraction = bits & ((BigInt(1) << BigInt(52)) - BigInt(1));
  const mantissa = exponent === 0 ? fraction : fraction + (BigInt(1) << BigInt(52));
  const power = (exponent === 0 ? 1 : exponent) - 1023 - 52;
  let numerator = mantissa * (BigInt(10) ** BigInt(places));
  let denominator = BigInt(1);
  if (power < 0) denominator <<= BigInt(-power);
  else numerator <<= BigInt(power);
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const doubled = remainder * BigInt(2);
  if (doubled > denominator || (doubled === denominator && quotient % BigInt(2) !== BigInt(0))) {
    quotient += BigInt(1);
  }
  const result = Number(quotient) / 10 ** places;
  return negative ? -result : result;
}
function validate(p: QuoteInputs) {
  if (!Number.isSafeInteger(p.quantity) || p.quantity < 1 || p.quantity > 1_000_000) throw new RangeError('Invalid quantity');
  const nums = [p.stock_weight_lb, p.cost_per_lb, p.scrap_factor, p.margin_pct ?? 0.15,
    ...p.ops.flatMap(x => [x.setup_time_hr, x.cycle_time_hr, x.allowance_pct, x.machine_rate_per_hr, x.labor_rate_per_hr,
      x.tool_change_time_min ?? 0, x.inspection_time_min ?? 0, x.tool_cost_per_part ?? 0, x.consumables_cost_per_part ?? 0])];
  if (nums.some(x => !Number.isFinite(x) || x < 0)) throw new RangeError('Costs and times must be finite and nonnegative');
}
export function calcUnitCost(p: QuoteInputs) {
  validate(p);
  const material_unit = (p.stock_weight_lb * p.cost_per_lb) * (1 + p.scrap_factor);
  let machine_unit = 0, labor_unit = 0, total_time_hr = 0;
  for (const op of p.ops) {
    const setup = op.setup_time_hr / Math.max(p.quantity, 1);
    const allowance = op.cycle_time_hr * op.allowance_pct;
    const time = setup + op.cycle_time_hr + allowance;
    machine_unit += time * op.machine_rate_per_hr;
    labor_unit += time * op.labor_rate_per_hr;
    total_time_hr += time;
  }
  const unit_cost = material_unit + machine_unit + labor_unit;
  const unit_price = unit_cost * (1 + (p.margin_pct ?? 0.15));
  return { material_unit: round(material_unit, 2), machine_unit: round(machine_unit, 2),
    labor_unit: round(labor_unit, 2), unit_cost: round(unit_cost, 2),
    unit_price: round(unit_price, 2), total_time_hr: round(total_time_hr, 4) };
}
export function calcDetailedQuote(p: DetailedInputs) {
  validate(p);
  const programmingTime = p.programming_time_hr ?? 0;
  const programmingRate = p.programming_rate_per_hr ?? 75;
  const firstArticle = p.first_article_inspection_hr ?? 0;
  const overheadRate = p.overhead_rate_pct ?? 1.5;
  if ([programmingTime, programmingRate, firstArticle, overheadRate].some(x => !Number.isFinite(x) || x < 0)) throw new RangeError('Invalid detailed costing parameters');
  const materialBase = p.stock_weight_lb * p.cost_per_lb;
  const materialScrap = materialBase * p.scrap_factor;
  const materialTotal = materialBase + materialScrap;
  let machine = 0, labour = 0, tooling = 0, consumables = 0;
  let setup = 0, cycle = 0, allowance = 0, toolChange = 0, inspection = 0, totalTime = 0;
  const operations = p.ops.map(op => {
    const s = op.setup_time_hr / Math.max(p.quantity, 1);
    const c = op.cycle_time_hr;
    const a = c * op.allowance_pct;
    const t = (op.tool_change_time_min ?? 0) / 60;
    const i = (op.inspection_time_min ?? 0) / 60;
    const duration = s + c + a + t + i;
    const m = duration * op.machine_rate_per_hr, l = duration * op.labor_rate_per_hr;
    const tool = op.tool_cost_per_part ?? 0, consumable = op.consumables_cost_per_part ?? 0;
    machine += m; labour += l; tooling += tool; consumables += consumable;
    setup += s; cycle += c; allowance += a; toolChange += t; inspection += i; totalTime += duration;
    return { operation_name: op.name, operation_type: op.operation_type ?? 'machining', sequence: op.sequence,
      time: { setup_per_part: round(s, 4), cycle: round(c, 4), allowance: round(a, 4),
        tool_change: round(t, 4), inspection: round(i, 4), total: round(duration, 4) },
      cost: { machine: round(m, 2), labor: round(l, 2), tooling: round(tool, 2),
        consumables: round(consumable, 2), total: round(m + l + tool + consumable, 2) } };
  });
  const programming = programmingTime > 0 ? programmingTime * programmingRate / Math.max(p.quantity, 1) : 0;
  const inspectionCost = firstArticle > 0 ? firstArticle * programmingRate / Math.max(p.quantity, 1) : 0;
  const overhead = (machine + labour) * (overheadRate - 1);
  const subtotal = materialTotal + machine + labour + tooling + programming + inspectionCost + consumables;
  const unitCost = subtotal + overhead;
  const marginPct = p.margin_pct ?? 0.15;
  const margin = unitCost * marginPct;
  const unitPrice = unitCost + margin;
  const extendedCost = unitCost * p.quantity, extendedPrice = unitPrice * p.quantity;
  return {
    time_breakdown: { setup_time_per_part: round(setup, 4), cycle_time: round(cycle, 4), allowance_time: round(allowance, 4),
      tool_change_time: round(toolChange, 4), inspection_time: round(inspection, 4), total_time_per_part: round(totalTime, 4) },
    cost_breakdown: { material: { base: round(materialBase, 2), scrap: round(materialScrap, 2), total: round(materialTotal, 2) },
      machine_cost: round(machine, 2), labor_cost: round(labour, 2), tooling_cost: round(tooling, 2),
      programming_cost: round(programming, 2), inspection_cost: round(inspectionCost, 2), consumables_cost: round(consumables, 2),
      overhead_cost: round(overhead, 2), subtotal_cost: round(subtotal, 2), unit_cost: round(unitCost, 2),
      margin_amount: round(margin, 2), unit_price: round(unitPrice, 2) },
    operations,
    summary: { quantity: p.quantity, unit_cost: round(unitCost, 2), unit_price: round(unitPrice, 2),
      margin_pct: round(marginPct * 100, 1), extended_cost: round(extendedCost, 2),
      extended_price: round(extendedPrice, 2), profit_amount: round(extendedPrice - extendedCost, 2) },
  };
}
