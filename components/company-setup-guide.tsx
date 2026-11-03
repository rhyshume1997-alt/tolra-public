"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";
import { SETUP_STEPS, readSetupProgress, writeSetupProgress, type SetupProgress, type SetupStep } from "@/lib/company-setup/progress";

export function CompanySetupGuide() {
  const { profile, activeRole, session } = useUser();
  const pathname = usePathname();
  const org = profile?.organization_id;
  const canManage = Boolean(org && activeRole === "admin" && session?.organization_id === org && session.support === false && session.read_only === false);
  const [loaded, setLoaded] = useState<{ org: string; progress: SetupProgress } | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    let live = true;
    setLoaded(null); setMessage("");
    if (org && canManage && supabase) void readSetupProgress(supabase, org).then(progress => {
      if (live) setLoaded({ org, progress });
    }).catch(error => { if (live) setMessage(error.message); });
    return () => { live = false; };
  }, [org, canManage]);
  const visible = pathname === "/settings" || pathname === "/admin/users" || pathname === "/admin/integrations" || pathname === "/admin/data";
  if (!visible || !org || !canManage) return null;
  const progress = loaded?.org === org ? loaded.progress : {};
  const count = SETUP_STEPS.filter(step => progress[step.id]).length;
  async function mark(step: SetupStep, completed: boolean) {
    if (!supabase || !org || saving || loaded?.org !== org) return;
    const company = org;
    setSaving(true); setMessage("");
    try {
      await writeSetupProgress(supabase, company, step, completed);
      setLoaded(current => current?.org === company ? { org: company, progress: { ...current.progress, [step]: completed } } : current);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save setup progress."); }
    finally { setSaving(false); }
  }
  return <section aria-label="Company setup" className="mb-6 rounded-lg border border-blue-200 bg-white p-4 print:hidden">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Set up your company — {count} of {SETUP_STEPS.length} reviewed</h2><button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Show setup steps"}</button></div>
    {expanded && <><p className="mt-2 text-sm">Start with your own details. No sample customers, jobs or invoices are added. Follow these steps, then tick each one when you have checked it. Optional connections can stay off.</p>
      <ol className="mt-3 grid gap-3 md:grid-cols-3">{SETUP_STEPS.map((step, i) => <li key={step.id} className="rounded border p-3"><Link href={step.href} className="font-semibold underline">{i + 1}. {step.label}</Link><p className="mt-1 text-sm">{step.hint}</p><label className="mt-2 flex gap-2 text-sm"><input type="checkbox" checked={Boolean(progress[step.id])} disabled={saving || loaded?.org !== org} onChange={e => void mark(step.id, e.target.checked)} />I have checked this</label></li>)}</ol></>}
    {message && <p role="status" className="mt-2 text-sm text-amber-800">{message}</p>}
  </section>;
}
