"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { History } from "lucide-react";

import { RoleGate } from "@/components/role-gate";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { actorLabel, describeEntry, RECORD_TYPES, recordLabel, recordTypeLabel, type ActivityEntry } from "@/lib/activity";
import { fmtDateTime } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { memberLabel, type PeopleMap, peopleMap, withUsernames } from "@/lib/people";
import { supabase } from "@/lib/supabase";

const PAGE = 100;
const selectClass = "h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm";
type Member = { user_id: string; full_name: string | null; username: string | null };

/** Start of a local day, as an ISO timestamp (the database compares in UTC). */
const dayStart = (date: string, plusDays = 0) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d + plusDays).toISOString();
};

export default function ActivityPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [companyPeople, setPeople] = useState<PeopleMap>({});
  // Same name rule as everywhere: display name (company_people), then the member's username (org_members, admin only), then "—"; never an e-mail address.
  const people = useMemo(() => withUsernames(companyPeople, members), [companyPeople, members]);
  const [actor, setActor] = useState("");
  const [table, setTable] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void supabase?.rpc("org_members").then(({ data }) => setMembers((data ?? []) as Member[]));
    // Names only (migration 035): the people of this company and the name to show for each; no name is "—", never an e-mail.
    void supabase?.rpc("company_people").then(({ data, error: peopleError }) => { if (!peopleError) setPeople(peopleMap(data)); });
  }, []);

  const load = useCallback(async (before?: ActivityEntry) => {
    if (!supabase) return;
    setLoading(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc("org_activity", {
      p_from: from ? dayStart(from) : null,
      p_to: to ? dayStart(to, 1) : null,
      p_actor: actor || null,
      p_table: table || null,
      p_before: before?.created_at ?? null,
      p_before_id: before?.id ?? null,
      p_limit: PAGE,
    });
    setLoading(false);
    if (rpcError) {
      setError(rpcError.code === "PGRST202" || rpcError.code === "42883" ? "The activity log isn't switched on yet (database update 013)." : friendlyError(rpcError, "Couldn't load the activity."));
      return;
    }
    const page = (data ?? []) as ActivityEntry[];
    setRows((current) => (before ? [...current, ...page] : page));
    setMore(page.length === PAGE);
  }, [actor, from, table, to]);

  useEffect(() => { void load(); }, [load]);

  const typeLabel = (entry: ActivityEntry) => recordTypeLabel(entry.record_table ?? entry.entity_table);

  return (
    <RoleGate allowed={["admin"]}>
      <div className="space-y-6">
        <div>
          <h1 className="page-title">Activity</h1>
          <p className="mt-2 text-sm text-slate-500">Everything created, changed or deleted, by whom and when. Entries are permanent: nobody can edit or delete them.</p>
        </div>

        <Card><CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="grid gap-1.5 text-sm font-medium text-slate-700">Person
            <select aria-label="Person" className={selectClass} value={actor} onChange={(e) => setActor(e.target.value)}>
              <option value="">Everyone</option>
              {members.map((m) => <option key={m.user_id} value={m.user_id}>{memberLabel(m)}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm font-medium text-slate-700">Record type
            <select aria-label="Record type" className={selectClass} value={table} onChange={(e) => setTable(e.target.value)}>
              <option value="">All</option>
              {RECORD_TYPES.map((type) => <option key={type.table} value={type.table}>{type.label}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm font-medium text-slate-700">From
            <Input aria-label="From" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="h-11" />
          </label>
          <label className="grid gap-1.5 text-sm font-medium text-slate-700">To
            <Input aria-label="To" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="h-11" />
          </label>
        </CardContent></Card>

        {error ? <Card><CardContent className="flex flex-wrap items-center justify-between gap-3 p-5"><p className="text-sm text-red-700">{error}</p><Button variant="outline" onClick={() => void load()}>Retry</Button></CardContent></Card> : null}

        {loading && !rows.length ? <Skeleton className="h-60" /> : (
          <Card><CardContent className="p-0">
            {!rows.length && !error ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center text-slate-500"><History className="size-6" /><p className="text-sm">No activity for these filters.</p></div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {rows.map((entry) => {
                  const { title, details } = describeEntry(entry, people);
                  // The title already starts with the record type ("Clock action created"), so only add the type when it does not.
                  const type = typeLabel(entry);
                  const badge = [title.startsWith(type) ? null : type, recordLabel(entry)].filter(Boolean).join(" ");
                  return (
                    <li key={entry.id} className="grid gap-1 px-4 py-3 sm:grid-cols-[170px_180px_1fr] sm:gap-4">
                      <p className="text-xs text-slate-500 sm:text-sm">{fmtDateTime(entry.created_at)}</p>
                      <p className="truncate text-sm font-medium text-slate-800" data-testid="activity-actor">{actorLabel(entry, people)}</p>
                      <div className="min-w-0">
                        <p className="text-sm text-slate-900">
                          {badge ? <span className="mr-2 rounded-none bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">{badge}</span> : null}
                          {title}
                        </p>
                        {details.length ? <ul className="mt-1 space-y-0.5 text-xs text-slate-600">{details.slice(0, 10).map((line, index) => <li key={index} className="break-words">{line}</li>)}</ul> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent></Card>
        )}
        {more ? <div className="flex justify-center"><Button variant="outline" disabled={loading} onClick={() => void load(rows[rows.length - 1])}>{loading ? "Loading…" : "Load more"}</Button></div> : null}
      </div>
    </RoleGate>
  );
}
