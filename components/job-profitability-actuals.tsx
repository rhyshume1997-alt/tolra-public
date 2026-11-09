"use client";
import { useEffect, useState, type FormEvent } from "react";

import { DEMO_MODE } from "@/lib/demo";
import { actualJobProfit, type ActualCostInputs } from "@/lib/job-profitability-actuals";
import { gbp } from "@/lib/money";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";

const money = (n: number | null) => (n === null ? "Not available" : gbp(n / 100));

/**
 * Optional actual job costing (release 148), below the legacy bought-in profit line. Rates are NOT edited here: they come from
 * Settings > Costing rates (release 143). An admin can switch the view on (only once those rates are set up) and say which costing machine
 * prices each shop-floor machine; admin and office confirm whether a job needs labour or machine hours.
 */
export function JobProfitabilityActuals({ jobId }: { jobId: string }) {
  const { activeRole, profile, hiddenSections } = useUser();
  const organizationId = profile?.organization_id;
  const allowed = !DEMO_MODE && !!organizationId && ["admin", "office"].includes(activeRole)
    && !["jobs", "invoices", "quotes", "purchase-orders"].some(section => hiddenSections.includes(section));
  const [input, setInput] = useState<ActualCostInputs | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    setInput(null); setMessage("");
    if (!allowed || !supabase || jobId.startsWith("demo")) return;
    let alive = true;
    void supabase.rpc("job_profitability_actual_inputs", { p_job: jobId }).then(({ data, error }) => {
      if (!alive) return;
      // Before 148 is installed the legacy view above stays as it is and this panel shows nothing.
      if (error) { if (error.code !== "PGRST202" && error.code !== "42883") setMessage("Actual costing unavailable. Check financial access and try again."); }
      else setInput(data as ActualCostInputs);
    }, () => { if (alive) setMessage("Actual costing unavailable. Try again."); });
    return () => { alive = false; };
  }, [allowed, organizationId, jobId, version]);
  if (!allowed) return null;
  if (!input || input.organizationId !== organizationId) return message ? <p role="status">{message}</p> : null;
  if (!input.config.enabled && !input.canConfigure) return null;
  const figure = actualJobProfit(input);

  async function call(name: string, args: Record<string, unknown>) {
    if (!supabase || busy) return;
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc(name, args);
    setBusy(false);
    if (error) setMessage(error.code === "40001" ? "Someone else changed this. Reload and try again." : error.message || "Save refused. Check your access and try again.");
    else setVersion(v => v + 1);
  }
  function saveLinks(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!input) return;
    const form = new FormData(event.currentTarget);
    void call("save_job_costing_machine_links", { p_organization: input.organizationId,
      p_links: input.machineChoices.flatMap(m => { const c = String(form.get(`link-${m.id}`) ?? ""); return c ? [{ machine_id: m.id, costing_machine_id: c }] : []; }) });
  }
  function saveDeclarations(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void call("save_job_cost_declarations", { p_job: jobId, p_no_labour: form.has("no-labour"), p_no_machines: form.has("no-machines") });
  }
  const linked = new Map(input.links.map(l => [l.machine_id, l.costing_machine_id]));
  const field = "rounded border p-1 ml-2";
  return <section className="space-y-3 rounded-lg border p-4 text-sm" aria-label="Actual job costing" data-testid="actual-job-costing" data-state={figure.state}>
    <h3 className="font-semibold">Actual job costing{figure.state === "off" ? " (off)" : ""}</h3>
    <p>Net values, excluding VAT. Company costing rates from Settings &gt; Costing rates, not employee pay. The existing profit figure stays above.</p>
    {(figure.state === "off" || figure.state === "not_configured") && <p role="status" data-testid="actual-costing-off">{figure.reasons[0]}</p>}
    {(figure.state === "incomplete" || figure.state === "complete") && <>
      {figure.basisLabel && <p data-testid="actual-costing-basis" data-basis={figure.basis} className="font-medium">{figure.basisLabel}</p>}
      {figure.state === "incomplete" && <p className="font-semibold" role="status" data-testid="actual-costing-incomplete">Incomplete: {figure.reasons.join("; ")}.</p>}
      <dl className="grid grid-cols-2 gap-2">
        {Object.entries({ "Quoted value": money(figure.quotedPence), "Invoiced less credits": money(figure.invoicedPence),
          "Supplier costs": money(figure.supplierPence), "Recorded labour hours": figure.labourHours ?? "Not available", "Labour cost": money(figure.labourPence),
          "Recorded machine hours": figure.machineHours ?? "Not available", "Machine cost": money(figure.machinePence), "Overhead": money(figure.overheadPence),
          "Total cost": money(figure.costPence), "Actual profit": money(figure.actualProfitPence),
          "Actual margin": figure.marginPct === null ? "Not available" : `${figure.marginPct.toFixed(1)}%` })
          .map(([name, value]) => <div key={name}><dt>{name}</dt><dd className="font-semibold">{value}</dd></div>)}
      </dl>
      <form key={`declare-${version}`} onSubmit={saveDeclarations} className="grid gap-2 py-2">
        <label><input name="no-labour" type="checkbox" defaultChecked={input.declarations?.labour_not_required} /> This job needs no recorded labour hours</label>
        <label><input name="no-machines" type="checkbox" defaultChecked={input.declarations?.machines_not_required} /> This job needs no machine hours</label>
        <button disabled={busy} className="rounded border p-2">{input.declarations ? "Save" : "Confirm"} what this job needs</button>
      </form>
      {input.snapshot && <button disabled={busy} className="rounded border p-2" onClick={() => void call("refresh_job_cost_snapshot", { p_job: jobId })}>
        Re-work the record from corrected times (at its own rates)</button>}
    </>}
    {input.canConfigure && <details><summary>Company job costing (admin only)</summary>
      <p>Rates are entered once, in Settings &gt; Costing rates. Here you only switch this view on or off and say which costing machine prices each machine.</p>
      <button disabled={busy || (!input.config.enabled && !input.configured)} className="rounded border p-2"
        onClick={() => void call("set_job_costing_enabled", { p_organization: input.organizationId, p_revision: input.config.revision, p_enabled: !input.config.enabled })}>
        {input.config.enabled ? "Switch job costing off" : "Approve and switch job costing on"}</button>
      <form key={`links-${version}`} onSubmit={saveLinks} className="grid gap-2 py-2">
        {input.machineChoices.map(m => <label key={m.id}>{m.name}
          <select name={`link-${m.id}`} className={field} defaultValue={linked.get(m.id) ?? ""}>
            <option value="">Not linked (its jobs stay incomplete)</option>
            {input.costingMachines.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>)}
        <button disabled={busy} className="rounded border p-2">Save machine links</button>
      </form>
    </details>}
    {message && <p role="status">{message}</p>}
  </section>;
}
