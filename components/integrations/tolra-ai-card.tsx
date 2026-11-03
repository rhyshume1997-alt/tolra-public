"use client";
import { useUser } from "@/lib/use-user";
import { useState } from "react";
import { useAiHelperStatus, type AiHelperStatus } from "@/components/ai-helper/use-ai-helper-status";
import { pounds } from "@/components/ai-helper/api";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export function TolraAiCard({ status, onChanged }: {status: AiHelperStatus; onChanged: () => void | Promise<void>}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Old databases and a global service switched off by Rhys expose no option.
  if (!status.tolra_available && !status.tolra_enabled) return null;
  async function toggle() {
    if (busy || !status.can_manage) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/ai-helper/tolra-mode", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled: !status.tolra_enabled})});
      if (!response.ok) throw new Error("Could not change Tolra AI. Try again.");
      await onChanged();
    } catch { setError("Could not change Tolra AI. Try again."); }
    finally { setBusy(false); }
  }
  return <Card data-testid="tolra-ai-card"><CardHeader><CardTitle>Tolra-provided AI</CardTitle></CardHeader><CardContent className="space-y-3">
    {!status.tolra_available && <p className="text-sm">Tolra has switched this service off. You can turn it off for your company below.</p>}
    <p className="text-sm">Use Tolra&apos;s AI account instead of your company&apos;s own key. People still check and approve every suggestion.</p>
    <p className="text-sm">{status.tolra_enabled ? "On for this company." : "Off for this company."} Monthly allowance: £{pounds(status.tolra_cap_pence ?? 1000)}. Used: £{pounds(status.month_spent_pence)}; waiting for answers: £{pounds(status.month_reserved_pence)}. The allowance resets each month.</p>
    <p className="text-xs text-slate-500">Use from either AI account counts towards this company&apos;s monthly allowance. Turning this off turns the AI features off; you can then choose your own key in the AI section.</p>
    {status.can_manage && <Button type="button" disabled={busy} aria-pressed={!!status.tolra_enabled} onClick={()=>void toggle()}>{busy ? "Saving..." : status.tolra_enabled ? "Turn Tolra AI off" : "Turn Tolra AI on"}</Button>}
    {error && <p role="alert">{error}</p>}
  </CardContent></Card>;
}
export function TolraAiConnectionCard({onChanged}:{onChanged?:()=>void | Promise<void>} = {}) {
  const {profile} = useUser();
  return <ScopedTolraAiCard key={profile?.organization_id ?? "none"} onChanged={onChanged} />;
}
function ScopedTolraAiCard({onChanged}:{onChanged?:()=>void | Promise<void>}) {
  const {status,allowed,reload} = useAiHelperStatus();
  if (!allowed || !status) return null;
  return <TolraAiCard status={status} onChanged={async()=>{await reload();await onChanged?.();}} />;
}
