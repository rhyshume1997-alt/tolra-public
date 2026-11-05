/* Pure TypeScript port of services/costing-engine/app/services/quoting*.py.
   Preserve Python's intermediate float arithmetic and round only serialized values.
   NO BUILT-IN RATES: the Python engine's fallbacks (margin 15%, programming 75/hr, overhead x1.5) are NOT ported. Every rate (margin, programming
   rate, overhead, material price, machine and labour rates) must be passed in, from the company's own costing settings; a missing one throws. */
export type Operation = {
  name: string; sequence: number; operation_type?: string;
  setup_time_hr: number; cycle_time_hr: number; allowance_pct: number;
  machine_rate_per_hr: number; labor_rate_per_hr: number;
  tool_change_time_min?: number; inspection_time_min?: number;
  tool_cost_per_part?: number; consumables_cost_per_part?: number;
};
export type QuoteInputs = {
  quantity: number; stock_weight_lb: number; cost_per_lb: number;
  scrap_factor: number; ops: Operation[]; margin_pct: number;
};
export type DetailedInputs = QuoteInputs & {
  programming_time_hr?: number; programming_rate_per_hr: number;
  first_article_inspection_hr?: number; overhead_rate_pct: number;
};
export function pyRound(n: number, places: number): number {
  if (!Number.isFinite(n)) throw new RangeError('Invalid rounding input');
  if (!Number.isInteger(places) || places < 0 || places > 10) throw new RangeError('Invalid decimal precision');
  // Match Python pyRound(binary64, digits): inspect the original IEEE 754 fraction,
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
  // Correctly rounded decimal -> float, as CPython does (string to double); dividing Number(quotient) would lose digits above 2**53.
  const result = Number(quotient.toString() + 'e-' + places);
  return negative ? -result : result;
}
/** A rate must be given (a number): the engine has no fallback for it. Non-finite or negative values are refused by the checks that follow. */
function requireRate(name: string, value: unknown): number {
  if (typeof value !== 'number') throw new RangeError('Missing rate: ' + name + ' must come from the costing settings');
  return value;
}
function validate(p: QuoteInputs) {
  requireRate('margin', p.margin_pct);
  if (!Number.isSafeInteger(p.quantity) || p.quantity < 1 || p.quantity > 1_000_000) throw new RangeError('Invalid quantity');
  const nums = [p.stock_weight_lb, p.cost_per_lb, p.scrap_factor, p.margin_pct,
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
  const unit_price = unit_cost * (1 + p.margin_pct);
  return { material_unit: pyRound(material_unit, 2), machine_unit: pyRound(machine_unit, 2),
    labor_unit: pyRound(labor_unit, 2), unit_cost: pyRound(unit_cost, 2),
    unit_price: pyRound(unit_price, 2), total_time_hr: pyRound(total_time_hr, 4) };
}
export function calcDetailedQuote(p: DetailedInputs) {
  validate(p);
  const programmingTime = p.programming_time_hr ?? 0;
  const programmingRate = requireRate('programming rate', p.programming_rate_per_hr);
  const firstArticle = p.first_article_inspection_hr ?? 0;
  const overheadRate = requireRate('overhead', p.overhead_rate_pct);
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
      time: { setup_per_part: pyRound(s, 4), cycle: pyRound(c, 4), allowance: pyRound(a, 4),
        tool_change: pyRound(t, 4), inspection: pyRound(i, 4), total: pyRound(duration, 4) },
      cost: { machine: pyRound(m, 2), labor: pyRound(l, 2), tooling: pyRound(tool, 2),
        consumables: pyRound(consumable, 2), total: pyRound(m + l + tool + consumable, 2) } };
  });
  const programming = programmingTime > 0 ? programmingTime * programmingRate / Math.max(p.quantity, 1) : 0;
  const inspectionCost = firstArticle > 0 ? firstArticle * programmingRate / Math.max(p.quantity, 1) : 0;
  const overhead = (machine + labour) * (overheadRate - 1);
  const subtotal = materialTotal + machine + labour + tooling + programming + inspectionCost + consumables;
  const unitCost = subtotal + overhead;
  const marginPct = p.margin_pct;
  const margin = unitCost * marginPct;
  const unitPrice = unitCost + margin;
  const extendedCost = unitCost * p.quantity, extendedPrice = unitPrice * p.quantity;
  return {
    time_breakdown: { setup_time_per_part: pyRound(setup, 4), cycle_time: pyRound(cycle, 4), allowance_time: pyRound(allowance, 4),
      tool_change_time: pyRound(toolChange, 4), inspection_time: pyRound(inspection, 4), total_time_per_part: pyRound(totalTime, 4) },
    cost_breakdown: { material: { base: pyRound(materialBase, 2), scrap: pyRound(materialScrap, 2), total: pyRound(materialTotal, 2) },
      machine_cost: pyRound(machine, 2), labor_cost: pyRound(labour, 2), tooling_cost: pyRound(tooling, 2),
      programming_cost: pyRound(programming, 2), inspection_cost: pyRound(inspectionCost, 2), consumables_cost: pyRound(consumables, 2),
      overhead_cost: pyRound(overhead, 2), subtotal_cost: pyRound(subtotal, 2), unit_cost: pyRound(unitCost, 2),
      margin_amount: pyRound(margin, 2), unit_price: pyRound(unitPrice, 2) },
    operations,
    summary: { quantity: p.quantity, unit_cost: pyRound(unitCost, 2), unit_price: pyRound(unitPrice, 2),
      margin_pct: pyRound(marginPct * 100, 1), extended_cost: pyRound(extendedCost, 2),
      extended_price: pyRound(extendedPrice, 2), profit_amount: pyRound(extendedPrice - extendedCost, 2) },
  };
}
