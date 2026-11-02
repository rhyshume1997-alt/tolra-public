// TODO-CHATGPT-PORT: interface stub only. ChatGPT is porting the costing maths to this exact path and API:
// services/costing-engine/app/services/quoting_enhanced.py (claude/a8-costing-activation, 9b98c3f) calc_detailed_quote ->
// calcDetailedQuote, calc_operation_breakdown -> calcOperationBreakdown, each dataclass's to_dict -> detailedQuoteToDict, and
// pyRound reproducing CPython's round(x, n) on floats (exact binary value, ties to even). Field names are the Python names, so the
// golden fixtures (tests/fixtures/costing-golden.json, from the real engine) compare one to one in tests/unit/costing-golden.test.ts.
// The port deletes QUOTE_MATH_STUB and the throws below; the golden test then runs instead of being skipped.
// Pure module: no I/O, no environment, no Supabase. Money in and out is pounds as floats, exactly as the Python engine works.

/** One operation, as the Python engine's ops list item. Omitted optional values are 0 (operation_type "machining"), as Python's .get. */
export type QuoteOperationInput = {
  name: string;
  sequence: number;
  operation_type?: string;
  setup_time_hr: number;
  cycle_time_hr: number;
  allowance_pct: number;
  tool_change_time_min?: number;
  inspection_time_min?: number;
  tool_cost_per_part?: number;
  consumables_cost_per_part?: number;
  machine_rate_per_hr: number;
  labor_rate_per_hr: number;
};

/** calc_detailed_quote's keyword arguments. Omitted optional ones take Python's defaults (75.0, 0.0, 0.0, 1.5, 0.15). */
export type DetailedQuoteInput = {
  quantity: number;
  stock_weight_lb: number;
  cost_per_lb: number;
  scrap_factor: number;
  ops: QuoteOperationInput[];
  programming_time_hr?: number;
  programming_rate_per_hr?: number;
  first_article_inspection_hr?: number;
  overhead_rate_pct?: number;
  margin_pct?: number;
};

/** TimeBreakdown, unrounded. */
export type TimeBreakdown = {
  setup_time_per_part: number;
  cycle_time: number;
  allowance_time: number;
  tool_change_time: number;
  inspection_time: number;
  total_time_per_part: number;
};

/** CostBreakdown, unrounded. */
export type CostBreakdown = {
  material_base: number;
  material_scrap: number;
  material_total: number;
  machine_cost: number;
  labor_cost: number;
  tooling_cost: number;
  programming_cost: number;
  inspection_cost: number;
  consumables_cost: number;
  overhead_cost: number;
  subtotal_cost: number;
  unit_cost: number;
  margin_amount: number;
  unit_price: number;
};

/** OperationBreakdown, unrounded. */
export type OperationBreakdown = {
  operation_name: string;
  operation_type: string;
  sequence: number;
  setup_time_per_part: number;
  cycle_time: number;
  allowance_time: number;
  tool_change_time: number;
  inspection_time: number;
  total_time: number;
  machine_cost: number;
  labor_cost: number;
  tooling_cost: number;
  consumables_cost: number;
  total_cost: number;
};

/** DetailedQuoteBreakdown, unrounded (what dataclasses.asdict gives in Python). */
export type DetailedQuoteBreakdown = {
  time_breakdown: TimeBreakdown;
  cost_breakdown: CostBreakdown;
  operations_breakdown: OperationBreakdown[];
  quantity: number;
  unit_cost: number;
  unit_price: number;
  margin_pct: number;
  extended_cost: number;
  extended_price: number;
  profit_amount: number;
};

/** DetailedQuoteBreakdown.to_dict(): money to 2 places, times to 4, margin_pct as a percentage to 1. */
export type DetailedQuoteDict = {
  time_breakdown: TimeBreakdown;
  cost_breakdown: {
    material: { base: number; scrap: number; total: number };
    machine_cost: number;
    labor_cost: number;
    tooling_cost: number;
    programming_cost: number;
    inspection_cost: number;
    consumables_cost: number;
    overhead_cost: number;
    subtotal_cost: number;
    unit_cost: number;
    margin_amount: number;
    unit_price: number;
  };
  operations: {
    operation_name: string;
    operation_type: string;
    sequence: number;
    time: { setup_per_part: number; cycle: number; allowance: number; tool_change: number; inspection: number; total: number };
    cost: { machine: number; labor: number; tooling: number; consumables: number; total: number };
  }[];
  summary: {
    quantity: number;
    unit_cost: number;
    unit_price: number;
    margin_pct: number;
    extended_cost: number;
    extended_price: number;
    profit_amount: number;
  };
};

/** Present only while this file is the stub. The port removes it. */
export const QUOTE_MATH_STUB = true as const;

function notPorted(): never {
  throw new Error("lib/costing/quote-math.ts is a stub (TODO-CHATGPT-PORT): the costing maths has not been ported yet");
}

/** CPython round(x, ndigits) for a float. */
export function pyRound(x: number, ndigits = 0): number {
  void x;
  void ndigits;
  return notPorted();
}

/** calc_operation_breakdown(operation, quantity, machine_rate, labor_rate). */
export function calcOperationBreakdown(operation: QuoteOperationInput, quantity: number, machineRate: number, laborRate: number): OperationBreakdown {
  void operation;
  void quantity;
  void machineRate;
  void laborRate;
  return notPorted();
}

/** calc_detailed_quote(**input). */
export function calcDetailedQuote(input: DetailedQuoteInput): DetailedQuoteBreakdown {
  void input;
  return notPorted();
}

/** DetailedQuoteBreakdown.to_dict(). */
export function detailedQuoteToDict(breakdown: DetailedQuoteBreakdown): DetailedQuoteDict {
  void breakdown;
  return notPorted();
}
