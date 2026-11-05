/** Additional cost accounting only. Never payroll. All costs are integer pence; internal time is integer microseconds (display fields remain milliseconds). */
import { boughtIn, invoicedSellPence, invoiceCounts, quoteSellPence, type LinkedPo, type SellInvoice, type SellCredit, type SellLine } from "@/lib/purchase-order-link";

export type CostConfig = { enabled: boolean; revision: number; approved_at: string | null; labour_rate_pence: number | null;
  overhead_basis: "none" | "labour" | "machine"; overhead_rate_pence: number | null };
export type MachineCostRate = { machine_id: string; rate_pence: number | null; includes_labour: boolean; includes_overhead: boolean };
export type CostTimer = { id: string; organization_id: string; job_id: string; started_at: string; ended_at: string | null;
  user_id?: string; machine_id?: string; operator_id?: string | null; voided_at?: string | null };
export type JobCostEstimate = { labour_hours: string | number | null; supplier_pence: number | null; overhead_hours: string | number | null;
  labour_not_required: boolean; machines_not_required: boolean };
export type ActualCostInputs = { organizationId: string; jobId: string; config: CostConfig; rates: MachineCostRate[];
  labour: CostTimer[] | null; machines: CostTimer[] | null; plans: { machine_id: string; estimated_hours: string | number | null }[] | null;
  estimate: JobCostEstimate | null; pos: LinkedPo[] | null; invoices: SellInvoice[] | null; credits: SellCredit[] | null;
  quoteLines: SellLine[] | null; ambiguousQuoteCosts?: boolean };
type Span = [number, number];
const HOUR = 3_600_000;
const validRate = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
function roundedRatio(n: bigint, d: bigint): number {
  const magnitude = n < BigInt(0) ? -n : n;
  const v = Number((magnitude * BigInt(2) + d) / (d * BigInt(2))) * (n < BigInt(0) ? -1 : 1);
  if (!Number.isSafeInteger(v)) throw new Error("Cost exceeds supported pence range");
  return v;
}
export const costForMilliseconds = (ms: number, pencePerHour: number) => {
  if (!Number.isSafeInteger(ms) || ms < 0 || !validRate(pencePerHour)) throw new Error("Invalid hours or costing rate");
  return roundedRatio(BigInt(ms) * BigInt(pencePerHour), BigInt(HOUR));
};
export function plannedCostPence(hours: string | number | null, rate: number): number | null {
  if (hours === null || !/^\d+(?:\.\d{1,6})?$/.test(String(hours))) return null;
  const [whole, fraction = ""] = String(hours).split(".");
  const scale = BigInt(10) ** BigInt(fraction.length);
  return roundedRatio((BigInt(whole) * scale + BigInt(fraction || "0")) * BigInt(rate), scale);
}
export function unionTime(spans: Span[]): Span[] {
  const sorted = spans.map(s => [...s] as Span).sort((a, b) => a[0] - b[0]); const out: Span[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]); else out.push(span);
  }
  return out;
}
const duration = (spans: Span[]) => unionTime(spans).reduce((n, [a, b]) => n + b - a, 0);
function minusTime(spans: Span[], covered: Span[]): number {
  const cover = unionTime(covered);
  return unionTime(spans).reduce((total, [a, b]) => total + b - a - cover.reduce((n, [x, y]) => n + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0), 0);
}
/** PostgreSQL timestamps carry up to six fractional digits; Date.parse alone drops the last three. */
function timestampMicroseconds(value: string): number | null {
  const match = value.match(/(?:\.(\d+))?(?:Z|[+-]\d{2}:?\d{2})$/i);
  if (!match || (match[1]?.length ?? 0) > 6) return null;
  const ms = Date.parse(value);
  const remainder = Number((match[1] ?? "").padEnd(6, "0").slice(3));
  const us = ms * 1000 + remainder;
  return Number.isSafeInteger(us) ? us : null;
}
function spanOf(t: CostTimer): Span | null {
  if (!t.ended_at) return null;
  const a = timestampMicroseconds(t.started_at), b = timestampMicroseconds(t.ended_at);
  return a !== null && b !== null && b > a ? [a, b] : null;
}
function costForMicroseconds(us: number, rate: number): number {
  if (!Number.isSafeInteger(us) || us < 0 || !validRate(rate)) throw new Error("Invalid recorded time or rate");
  return roundedRatio(BigInt(us) * BigInt(rate), BigInt(HOUR) * BigInt(1000));
}
/** Keep the legacy calculator untouched; refuse unsafe intermediate sums in this optional view. */
function safeRevenue(invoices: SellInvoice[], credits: SellCredit[]): boolean {
  const issued = invoices.filter(inv => invoiceCounts(inv.status));
  const ids = new Set(issued.map(inv => inv.id));
  const parts = issued.map(inv => invoicedSellPence([inv], []));
  for (const credit of credits) {
    if (credit.invoice_id && ids.has(credit.invoice_id) && String(credit.status ?? "").trim().toLowerCase() === "issued") {
      parts.push(invoicedSellPence([{ id: credit.invoice_id, status: "issued", subtotal: 0 }], [credit]));
    }
  }
  let exposure = BigInt(0);
  for (const part of parts) {
    if (!part.issued || part.pence === null || !Number.isSafeInteger(part.pence)) return false;
    exposure += BigInt(Math.abs(part.pence));
    if (exposure > BigInt(Number.MAX_SAFE_INTEGER)) return false;
  }
  return true;
}
const overlap = (a: Span, b: Span) => a[0] < b[1] && b[0] < a[1];
export type ActualCostFigure = { state: "off" | "incomplete" | "complete"; reasons: string[]; warnings: string[];
  quotedPence: number | null; invoicedPence: number | null; supplierPence: number | null; labourMilliseconds: number | null;
  chargedLabourMilliseconds: number | null; labourPence: number | null; machineMilliseconds: number | null; machinePence: number | null;
  overheadPence: number | null; estimatedProfitPence: number | null; actualProfitPence: number | null; marginPct: number | null; differencePence: number | null };

export function actualJobProfit(input: ActualCostInputs, options: { allowUninvoicedCosts?: boolean } = {}): ActualCostFigure {
  const out: ActualCostFigure = { state: "incomplete", reasons: [], warnings: [], quotedPence: null, invoicedPence: null, supplierPence: null,
    labourMilliseconds: null, chargedLabourMilliseconds: null, labourPence: null, machineMilliseconds: null, machinePence: null,
    overheadPence: null, estimatedProfitPence: null, actualProfitPence: null, marginPct: null, differencePence: null };
  if (!input.config.enabled) return { ...out, state: "off" };
  const fail = (s: string) => { if (!out.reasons.includes(s)) out.reasons.push(s); };
  if (!input.config.approved_at) fail("Company costing rates are not approved");
  if (!validRate(input.config.labour_rate_pence)) fail("Company labour costing rate is missing");
  if (input.config.overhead_basis !== "none" && !validRate(input.config.overhead_rate_pence)) fail("Company overhead rate is missing");
  if (!input.estimate) fail("Confirm whether labour and machines are required for this job");
  out.quotedPence = input.quoteLines ? quoteSellPence(input.quoteLines) : null;
  if (!input.invoices || !input.credits) fail("Invoice or credit note records could not be read");
  else if (!safeRevenue(input.invoices, input.credits)) fail("Revenue exceeds supported pence range");
  else { const sell = invoicedSellPence(input.invoices, input.credits); if (sell.issued && sell.pence !== null) out.invoicedPence = sell.pence; else if (sell.issued || !options.allowUninvoicedCosts) fail("No complete issued net revenue yet"); }
  const purchases = input.pos ? boughtIn(input.pos) : null;
  if (!purchases) fail("Supplier allocations are missing or unreadable"); else out.supplierPence = purchases.pence;
  if (input.ambiguousQuoteCosts) fail("A quote-only supplier allocation is shared by multiple jobs; allocate it to a job");
  const labour = new Map<string, Span[]>(), machines = new Map<string, Span[]>();
  const runs: { timer: CostTimer; span: Span; rate: MachineCostRate }[] = [];
  const allLabour = (input.labour ?? []).filter(t => !t.voided_at), allMachines = input.machines ?? [];
  if (input.labour === null || input.machines === null) fail("Recorded hours could not be read");
  for (const [timers, key, map] of [[allLabour, "user_id", labour], [allMachines, "machine_id", machines]] as const) {
    const seen = new Map<string, string>();
    for (const timer of timers.filter(t => t.job_id === input.jobId)) {
      const fingerprint = JSON.stringify(timer);
      if (seen.has(timer.id)) { if (seen.get(timer.id) !== fingerprint) fail("Conflicting copies of a timer need correction"); continue; }
      seen.set(timer.id, fingerprint);
      const span = spanOf(timer), resource = timer[key];
      if (timer.organization_id !== input.organizationId || !span || !resource) { fail("A timer is open, invalid or has no resource"); continue; }
      const conflicts = timers.some(other => other.job_id !== input.jobId && other[key] === resource &&
        (other.organization_id !== input.organizationId || !spanOf(other) || overlap(span, spanOf(other)!)));
      if (conflicts) fail("Overlapping time on another job needs correction before costing");
      map.set(resource, [...(map.get(resource) ?? []), span]);
      if (key === "machine_id") {
        const rate = input.rates.find(r => r.machine_id === resource);
        if (!rate || !validRate(rate.rate_pence) || typeof rate.includes_labour !== "boolean" || typeof rate.includes_overhead !== "boolean") fail("A machine costing rate or inclusion flag is missing");
        else runs.push({ timer, span, rate });
      }
    }
  }
  if (!labour.size && !input.estimate?.labour_not_required) fail("No completed labour hours recorded");
  if (!machines.size && !input.estimate?.machines_not_required) fail("No completed machine hours recorded");
  if (labour.size && input.estimate?.labour_not_required) fail("Recorded labour conflicts with the no-labour declaration");
  if (machines.size && input.estimate?.machines_not_required) fail("Recorded machines conflict with the no-machine declaration");
  out.labourMilliseconds = [...labour.values()].reduce((n, spans) => n + duration(spans) / 1000, 0);
  out.machineMilliseconds = [...machines.values()].reduce((n, spans) => n + duration(spans) / 1000, 0);
  let chargedLabour = 0, overheadTime = 0;
  for (const [user, spans] of labour) {
    chargedLabour += minusTime(spans, runs.filter(r => r.rate.includes_labour && r.timer.operator_id === user).map(r => r.span));
    if (input.config.overhead_basis === "labour") overheadTime += minusTime(spans, runs.filter(r => r.rate.includes_overhead && r.timer.operator_id === user).map(r => r.span));
  }
  for (const r of runs) if (!r.timer.operator_id && labour.size && (r.rate.includes_labour || (r.rate.includes_overhead && input.config.overhead_basis === "labour"))) fail("Machine-inclusive time has no recorded operator; double counting cannot be ruled out");
  for (const run of runs) {
    if ((run.rate.includes_labour || (run.rate.includes_overhead && input.config.overhead_basis === "labour")) &&
      runs.some(other => other.timer.machine_id === run.timer.machine_id && other.timer.operator_id !== run.timer.operator_id && overlap(run.span, other.span))) {
      fail("Overlapping machine records disagree about the operator");
    }
  }
  out.chargedLabourMilliseconds = chargedLabour / 1000;
  try {
    out.labourPence = validRate(input.config.labour_rate_pence) ? costForMicroseconds(chargedLabour, input.config.labour_rate_pence) : null;
    let machineCost = 0;
    for (const [machine, spans] of machines) {
      const rate = input.rates.find(r => r.machine_id === machine);
      if (rate && validRate(rate.rate_pence)) machineCost += costForMicroseconds(duration(spans), rate.rate_pence);
      if (input.config.overhead_basis === "machine" && rate && !rate.includes_overhead) overheadTime += duration(spans);
    }
    out.machinePence = machineCost;
    out.overheadPence = input.config.overhead_basis === "none" ? 0 : validRate(input.config.overhead_rate_pence) ? costForMicroseconds(overheadTime, input.config.overhead_rate_pence) : null;
    if (!out.reasons.length && out.supplierPence !== null && out.labourPence !== null && out.overheadPence !== null) {
      const costs = out.supplierPence + out.labourPence + machineCost + out.overheadPence;
      out.actualProfitPence = out.invoicedPence === null ? null : out.invoicedPence - costs;
      if (!Number.isSafeInteger(costs) || (out.actualProfitPence !== null && !Number.isSafeInteger(out.actualProfitPence))) throw new Error("Cost exceeds supported pence range");
      out.marginPct = out.invoicedPence !== null && out.invoicedPence > 0 && out.actualProfitPence !== null ? roundedRatio(BigInt(out.actualProfitPence) * BigInt(1000), BigInt(out.invoicedPence)) / 10 : null;
      out.state = "complete";
    }
    const estimate = input.estimate;
    if (input.config.approved_at && estimate && out.quotedPence !== null && validRate(estimate.supplier_pence) && validRate(input.config.labour_rate_pence) && input.plans) {
      const lab = plannedCostPence(estimate.labour_hours, input.config.labour_rate_pence);
      const oh = input.config.overhead_basis === "none" ? 0 : validRate(input.config.overhead_rate_pence) ? plannedCostPence(estimate.overhead_hours, input.config.overhead_rate_pence) : null;
      let machineEstimate = 0, estimatedMs = 0, complete = lab !== null && oh !== null;
      if (!input.plans.length && !estimate.machines_not_required) complete = false;
      for (const plan of input.plans) {
        const rate = input.rates.find(r => r.machine_id === plan.machine_id);
        const cost = rate && validRate(rate.rate_pence) ? plannedCostPence(plan.estimated_hours, rate.rate_pence) : null;
        const ms = plannedCostPence(plan.estimated_hours, HOUR);
        if (cost === null || ms === null) complete = false; else { machineEstimate += cost; estimatedMs += ms; }
      }
      if (complete) {
        out.estimatedProfitPence = out.quotedPence - estimate.supplier_pence - lab! - machineEstimate - oh!;
        if (!Number.isSafeInteger(out.estimatedProfitPence)) throw new Error("Estimate exceeds supported range");
        out.differencePence = out.actualProfitPence === null ? null : out.actualProfitPence - out.estimatedProfitPence;
        const estimatedLabourMs = plannedCostPence(estimate.labour_hours, HOUR)!;
        if (chargedLabour > estimatedLabourMs * 1000) out.warnings.push("Additional labour hours exceed the estimate");
        if (out.machineMilliseconds! > estimatedMs) out.warnings.push("Machine hours exceed the estimate");
        if (out.supplierPence !== null && out.supplierPence > estimate.supplier_pence) out.warnings.push("Supplier costs exceed the estimate");
        if (out.actualProfitPence !== null && out.invoicedPence! - out.actualProfitPence > estimate.supplier_pence + lab! + machineEstimate + oh!) out.warnings.push("Actual costs exceed estimated costs");
      }
    }
  } catch { fail("Cost exceeds supported pence range"); out.state = "incomplete"; out.estimatedProfitPence = null; out.actualProfitPence = null; out.marginPct = null; out.differencePence = null; }
  if (out.reasons.length) {
    out.state = "incomplete"; out.actualProfitPence = null; out.marginPct = null; out.differencePence = null;
    // Never present a guessed zero for missing/invalid recorded costs.
    out.labourPence = null; out.machinePence = null; out.overheadPence = null;
    out.labourMilliseconds = null; out.machineMilliseconds = null; out.chargedLabourMilliseconds = null;
  }
  return out;
}
