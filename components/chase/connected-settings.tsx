"use client";
import { useEffect, useRef, useState } from "react";
import { ChaseSettingsCard, type ChaseStep } from "@/components/chase/settings-card";
import { DEFAULT_CHASE_STEPS } from "@/lib/email/chase/steps";
import { saveChaseSteps, type SavedStep } from "@/lib/chase/ui-store";
import { supabase } from "@/lib/supabase";

export function ConnectedChaseSettings({ organizationId, canEdit }: { organizationId: string; canEdit: boolean }) {
  const saving = useRef(false);
  const generation = useRef(0);
  const [state, setState] = useState<{ rows: SavedStep[]; version: number } | null>(null);
  const [suggested, setSuggested] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    generation.current += 1;
    setState(null); setError("");
    void supabase?.from("chase_steps").select("id, offset_days, tone").eq("organization_id", organizationId).order("offset_days").then(({ data, error }) => {
      if (!live) return;
      if (error) { setError("Could not load payment chasing. Ask the person who looks after Tolra to check the setup."); return; }
      setSuggested(!data?.length);
      setState({ rows: (data ?? []).map((r) => ({ id: r.id, days: r.offset_days, tone: r.tone })), version: 0 });
    });
    return () => { live = false; };
  }, [organizationId]);
  async function save(steps: ChaseStep[]) {
    if (!supabase || !state || !canEdit || saving.current) throw new Error("Changes are not available.");
    saving.current = true;
    const version = generation.current;
    try {
      const rows = await saveChaseSteps(supabase, organizationId, state.rows, steps);
      if (version !== generation.current) return;
      setState((s) => s ? ({ rows, version: s.version }) : null);
      setSuggested(false);
      setError("");
    } catch (failure) {
      if (version === generation.current) setError("Could not save chase steps. Reload this page before trying again; if it still fails, ask the person who looks after Tolra.");
      throw failure;
    } finally { saving.current = false; }
  }
  if (!state) return <p role="status">{error || "Loading payment chasing…"}</p>;
  return <div className="space-y-3">
    {suggested && <p className="text-sm">The steps below are suggestions. Save them to start using them.</p>}
    {error && <p role="alert">{error}</p>}
    <ChaseSettingsCard key={`${organizationId}-${state.version}`} initialSteps={state.rows.length ? state.rows : DEFAULT_CHASE_STEPS.map((s) => ({ days: s.offset_days, tone: s.tone }))} onSave={save} disabled={!canEdit || !!error} />
  </div>;
}
