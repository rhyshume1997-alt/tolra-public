"use client";

import { useCallback, useState } from "react";
import { ChevronDown, History } from "lucide-react";

import { WhoWhen } from "@/components/who-when";
import { actorLabel, describeGroup, groupEntries, type ActivityEntry } from "@/lib/activity";
import { fmtDateTime } from "@/lib/dates";
import { type PeopleMap } from "@/lib/people";
import { canReadUsernames, loadCompanyPeople } from "@/lib/company-people";
import { useMaybeUser } from "@/lib/use-user";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

type RecordTable = "quotes" | "jobs" | "sales_orders" | "invoices" | "purchase_orders" | "delivery_notes";

/**
 * Collapsed "Activity" section for a record: who created it, what changed and when (append-only audit trail,
 * migration 013). Loads only when opened.
 */
export function ActivityPanel({ table, recordId, className }: { table: RecordTable; recordId: string | null | undefined; className?: string }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [people, setPeople] = useState<PeopleMap>({});
  const usernames = canReadUsernames(useMaybeUser()?.profile);

  const load = useCallback(async () => {
    if (!supabase || !recordId) return;
    setLoading(true);
    setError(null);
    const [{ data, error: rpcError }, who] = await Promise.all([supabase.rpc("record_activity", { p_table: table, p_id: recordId }), loadCompanyPeople(supabase, { usernames })]);
    setLoading(false);
    if (who) setPeople(who);
    if (rpcError) {
      setError(rpcError.code === "PGRST202" || rpcError.code === "42883" ? "The activity trail isn't switched on yet (database update 013)." : "Couldn't load the activity.");
      return;
    }
    setEntries((data ?? []) as ActivityEntry[]);
  }, [recordId, table, usernames]);

  if (!recordId || !/^[0-9a-f-]{36}$/i.test(recordId)) return null;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && entries === null) void load();
  };

  const groups = entries ? groupEntries(entries) : [];

  return (
    <section className={cn("border-t border-slate-200 pt-3", className)}>
      <WhoWhen table={table} recordId={recordId} className="mb-2" />
      <button type="button" onClick={toggle} aria-expanded={open}
        className="flex min-h-10 w-full items-center gap-2 text-left text-sm font-medium text-slate-600 hover:text-slate-900">
        <History className="size-4" aria-hidden />
        Activity
        {entries ? <span className="text-xs font-normal text-slate-400">({groups.length})</span> : null}
        <ChevronDown className={cn("ml-auto size-4 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open ? (
        <div className="mt-2 max-h-80 overflow-y-auto pr-1">
          {loading ? <p className="py-2 text-sm text-slate-500">Loading…</p> : null}
          {error ? <p className="py-2 text-sm text-red-700">{error}</p> : null}
          {entries && !groups.length ? <p className="py-2 text-sm text-slate-500">No activity recorded yet.</p> : null}
          <ol className="relative ml-2 border-l border-slate-200">
            {groups.map((group) => {
              const head = group[0];
              const { title, details } = describeGroup(group, people);
              return (
                <li key={head.id} className="relative pb-3 pl-4">
                  <span className="absolute -left-[4.5px] top-1.5 size-2 rounded-none bg-slate-300" aria-hidden />
                  <p className="text-sm text-slate-900">{title}</p>
                  {details.length ? (
                    <ul className="mt-0.5 space-y-0.5 text-xs text-slate-600">{details.map((line, index) => <li key={index}>{line}</li>)}</ul>
                  ) : null}
                  <p className="mt-0.5 text-xs text-slate-400">{actorLabel(head, people)} · {fmtDateTime(head.created_at)}</p>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
