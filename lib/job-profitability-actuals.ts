/**
 * Optional actual job costing (release 148). Additional cost accounting only, never payroll. Every rate comes from release 143
 * (Settings > Costing rates); the database works out the costs (in whole pence, one rounding rule: half to even, as lib/costing's
 * pyRound) and this file only combines them with the job's issued net revenue and says which basis a figure is on:
 *   - "recorded": the job's cost record, taken when it finished or was first invoiced, at the rates of that moment (later rate edits never
 *     change it);
 *   - "todays_rates": an OPEN job only, costs so far at today's rates (labelled; it is recorded when the job finishes or is invoiced).
 * Anything missing is "incomplete" with reasons and no figure; nothing is shown as zero unless it is a real, declared zero.
 */
import { PANEL_NOT_SET_UP_MESSAGE } from "@/lib/costing/app-rates";
import { invoicedSellPence, quoteSellPence, type SellCredit, type SellInvoice, type SellLine } from "@/lib/purchase-order-link";

export type CostFigures = {
  state: "complete" | "incomplete"; reasons: string[];
  labour_us: number | null; machine_us: number | null;
  labour_pence: number | null; machine_pence: number | null; overhead_pence: number | null; supplier_pence: number | null;
};
export type CostRecord = CostFigures & { taken_on: "finished" | "invoiced"; taken_at: string; refreshed_at: string | null; rates_read_at: string | null };
export type ActualCostInputs = {
  organizationId: string; jobId: string; configured: boolean; open: boolean; canConfigure: boolean;
  config: { enabled: boolean; revision: number; approved_at: string | null };
  machineChoices: { id: string; name: string }[]; costingMachines: { id: string; name: string }[];
  links: { machine_id: string; costing_machine_id: string }[];
  declarations: { labour_not_required: boolean; machines_not_required: boolean } | null;
  snapshot?: CostRecord | null; live?: CostFigures | null;
  invoices?: SellInvoice[] | null; credits?: SellCredit[] | null; quoteLines?: SellLine[] | null;
};
export type ActualCostFigure = {
  state: "off" | "not_configured" | "incomplete" | "complete";
  basis: "recorded" | "todays_rates" | null; basisLabel: string | null; reasons: string[];
  quotedPence: number | null; invoicedPence: number | null; supplierPence: number | null;
  labourPence: number | null; machinePence: number | null; overheadPence: number | null; costPence: number | null;
  labourHours: string | null; machineHours: string | null; actualProfitPence: number | null; marginPct: number | null;
};

export const COSTING_OFF_MESSAGE = "Actual job costing is off for this company.";
export const NOT_CONFIGURED_MESSAGE = PANEL_NOT_SET_UP_MESSAGE;
export const NO_RECORD_REASON = "No cost record was taken when this job closed, so it is not costed (a closed job is never costed at today's rates)";
export const NOT_INVOICED_REASON = "No issued invoice yet, so there is no actual profit";
const isPence = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** The one rounding rule (lib/costing pyRound's): half to even on the exact ratio n / d (d > 0). */
export function roundHalfEven(n: bigint, d: bigint): bigint {
  if (d <= BigInt(0)) throw new RangeError("Invalid ratio");
  const neg = n < BigInt(0), m = neg ? -n : n;
  let q = m / d;
  const twice = (m - q * d) * BigInt(2);
  if (twice > d || (twice === d && q % BigInt(2) === BigInt(1))) q += BigInt(1);
  return neg ? -q : q;
}
const hours = (us: number | null) => (isPence(us) ? (Number(roundHalfEven(BigInt(us), BigInt(36_000_000))) / 100).toFixed(2) : null);
const day = (iso: string) => iso.slice(0, 10);

export function actualJobProfit(input: ActualCostInputs): ActualCostFigure {
  const out: ActualCostFigure = { state: "incomplete", basis: null, basisLabel: null, reasons: [], quotedPence: null, invoicedPence: null,
    supplierPence: null, labourPence: null, machinePence: null, overheadPence: null, costPence: null, labourHours: null, machineHours: null,
    actualProfitPence: null, marginPct: null };
  if (!input.configured) return { ...out, state: "not_configured", reasons: [NOT_CONFIGURED_MESSAGE] };
  if (!input.config.enabled) return { ...out, state: "off", reasons: [COSTING_OFF_MESSAGE] };
  out.quotedPence = input.quoteLines ? quoteSellPence(input.quoteLines) : null;
  let costs: CostFigures | null = null;
  if (input.snapshot) {
    costs = input.snapshot; out.basis = "recorded";
    out.basisLabel = `Recorded when this job ${input.snapshot.taken_on === "finished" ? "finished" : "was first invoiced"} (${day(input.snapshot.taken_at)}), at the costing rates of that day`;
  } else if (input.open && input.live) {
    costs = input.live; out.basis = "todays_rates";
    out.basisLabel = "Open job: costs so far at today's rates. They are recorded when the job finishes or is invoiced.";
  } else out.reasons.push(NO_RECORD_REASON);
  if (costs) {
    if (costs.state !== "complete") out.reasons.push(...(costs.reasons.length ? costs.reasons : ["Costs are incomplete"]));
    else if ([costs.labour_pence, costs.machine_pence, costs.overhead_pence, costs.supplier_pence].every(isPence)) {
      out.labourPence = costs.labour_pence; out.machinePence = costs.machine_pence; out.overheadPence = costs.overhead_pence; out.supplierPence = costs.supplier_pence;
      out.labourHours = hours(costs.labour_us); out.machineHours = hours(costs.machine_us);
      const total = out.labourPence! + out.machinePence! + out.overheadPence! + out.supplierPence!;
      if (Number.isSafeInteger(total)) out.costPence = total; else out.reasons.push("Cost exceeds supported pence range");
    } else out.reasons.push("Costs are incomplete");
  }
  if (!input.invoices || !input.credits) out.reasons.push("Invoice or credit note records could not be read");
  else {
    const sell = invoicedSellPence(input.invoices, input.credits);
    if (!sell.issued) out.reasons.push(NOT_INVOICED_REASON);
    else if (sell.pence === null) out.reasons.push("Revenue exceeds supported pence range");
    else out.invoicedPence = sell.pence;
  }
  if (out.costPence !== null && out.invoicedPence !== null) {
    const profit = out.invoicedPence - out.costPence;
    if (Number.isSafeInteger(profit)) {
      out.actualProfitPence = profit;
      out.marginPct = out.invoicedPence > 0 ? Number(roundHalfEven(BigInt(profit) * BigInt(1000), BigInt(out.invoicedPence))) / 10 : null;
    } else out.reasons.push("Profit exceeds supported pence range");
  }
  // Costs that are themselves incomplete are never shown, even partly.
  if (out.costPence === null) { out.labourPence = null; out.machinePence = null; out.overheadPence = null; out.supplierPence = null; out.labourHours = null; out.machineHours = null; }
  out.state = out.reasons.length ? "incomplete" : "complete";
  return out;
}
