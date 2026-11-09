"use client";

import { useCallback, useEffect, useState } from "react";
import { PauseCircle, PlayCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmtDate } from "@/lib/dates";
import { pauseActive } from "@/lib/email/chase/steps";
import { supabase } from "@/lib/supabase";
import { getCurrentOrganizationId } from "@/lib/supabase-business";

/**
 * Chasing paused (migration 138's chase_pauses): for one invoice or one customer, with a reason and an optional last day. While a pause is
 * in force the chase steps draft nothing for that invoice (or any invoice made out to that customer), and Approve and send refuses.
 * Resume removes the pause. Admin and office only (the database's rule); before 138 is applied nothing shows.
 */
export type PauseTarget = { kind: "invoice" | "customer"; id: string; name: string };
type PauseRow = { id: string; reason: string; paused_until: string | null; paused_at: string };

const todayUk = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const missing = (error: { code?: string } | null) => !!error && ["PGRST205", "42P01", "PGRST200"].includes(String(error.code ?? ""));

/** The pauses in force for the caller's company: invoice ids and customer names (trimmed, lower case). Empty before 138. */
export function useChasePauses() {
  const [state, setState] = useState<{ invoices: Set<string>; customers: Set<string> }>({ invoices: new Set(), customers: new Set() });
  const reload = useCallback(async () => {
    if (!supabase) return;
    try {
      const [{ data, error }, { data: customers }] = await Promise.all([
        supabase.from("chase_pauses").select("invoice_id, customer_id, paused_until"),
        supabase.from("customers").select("id, name"),
      ]);
      if (error) return;
      const names = new Map(((customers ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name.trim().toLowerCase()]));
      const today = todayUk();
      const live = ((data ?? []) as Array<{ invoice_id: string | null; customer_id: string | null; paused_until: string | null }>).filter((p) => pauseActive(p.paused_until, today));
      setState({
        invoices: new Set(live.map((p) => p.invoice_id).filter((v): v is string => !!v)),
        customers: new Set(live.map((p) => (p.customer_id ? names.get(p.customer_id) : undefined)).filter((v): v is string => !!v)),
      });
    } catch {
      // nothing shown
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { ...state, reload, pausedFor: (invoiceId: string | null | undefined, customer: string) => (!!invoiceId && state.invoices.has(invoiceId)) || state.customers.has(customer.trim().toLowerCase()) };
}

/** The small "Chasing paused" mark on a list row. */
export function ChasePausedBadge({ customer }: { customer?: boolean }) {
  return (
    <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-amber-700" data-testid="chase-paused-badge">
      <PauseCircle className="size-3.5" /> Chasing paused{customer ? " (customer)" : ""}
    </span>
  );
}

export function ChasePauseControl({ target, onChange }: { target: PauseTarget; onChange?: () => void }) {
  const [phase, setPhase] = useState<"loading" | "hidden" | "ready">("loading");
  const [pause, setPause] = useState<PauseRow | null>(null);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [saving, setSaving] = useState(false);
  const column = target.kind === "invoice" ? "invoice_id" : "customer_id";
  const label = target.kind === "invoice" ? "this invoice" : "this customer";

  const load = useCallback(async () => {
    if (!supabase) return void setPhase("hidden");
    const { data, error } = await supabase.from("chase_pauses").select("id, reason, paused_until, paused_at").eq(column, target.id).maybeSingle();
    if (error) return void setPhase(missing(error) ? "hidden" : "ready");
    setPause((data as PauseRow | null) ?? null);
    setPhase("ready");
  }, [column, target.id]);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!supabase || saving) return;
    const text = reason.trim();
    if (!text) return void toast.error("Enter a reason for pausing.");
    if (text.length > 300) return void toast.error("The reason can be up to 300 characters.");
    if (until && until < todayUk()) return void toast.error("The last day can't be in the past.");
    setSaving(true);
    try {
      const organizationId = await getCurrentOrganizationId();
      const { error } = await supabase.from("chase_pauses").insert({ organization_id: organizationId, [column]: target.id, reason: text, paused_until: until || null });
      if (error) throw error;
      toast.success(`Chasing paused for ${target.name}`);
      setEditing(false);
      setReason("");
      setUntil("");
      await load();
      onChange?.();
    } catch {
      toast.error("Couldn't pause chasing. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function resume() {
    if (!supabase || !pause || saving) return;
    setSaving(true);
    try {
      const { error } = await supabase.from("chase_pauses").delete().eq("id", pause.id);
      if (error) throw error;
      toast.success(`Chasing resumed for ${target.name}`);
      await load();
      onChange?.();
    } catch {
      toast.error("Couldn't resume chasing. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (phase !== "ready") return null;
  const active = pause && pauseActive(pause.paused_until, todayUk());
  return (
    <div className="rounded-lg border p-3 text-sm" data-testid={`chase-pause-${target.kind}`}>
      {pause ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-semibold text-amber-800" data-testid="chase-pause-status">{active ? "Chasing paused" : "Chasing pause ended"}{pause.paused_until ? ` until ${fmtDate(pause.paused_until)}` : ""}</p>
            <p className="text-slate-600">Reason: {pause.reason}</p>
            <p className="text-xs text-slate-500">No chase e-mails are drafted for {label} while it is paused.</p>
          </div>
          <Button variant="outline" size="sm" disabled={saving} onClick={() => void resume()}><PlayCircle className="size-4" /> Resume chasing</Button>
        </div>
      ) : editing ? (
        <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <label className="text-sm font-medium text-slate-700">Reason
            <Input className="mt-1" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Query on the delivery" aria-label="Reason for pausing chasing" />
          </label>
          <label className="text-sm font-medium text-slate-700">Until (optional)
            <Input className="mt-1" type="date" value={until} onChange={(e) => setUntil(e.target.value)} aria-label="Pause chasing until" />
          </label>
          <div className="flex gap-2">
            <Button size="sm" className="bg-brand text-brand-ink" disabled={saving} onClick={() => void save()}>Pause</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-slate-600">Chase steps run for {label}.</p>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}><PauseCircle className="size-4" /> Pause chasing</Button>
        </div>
      )}
    </div>
  );
}
