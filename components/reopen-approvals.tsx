"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadCompanyPeople } from "@/lib/company-people";
import { fmtDateTime } from "@/lib/dates";
import { missingDbObject } from "@/lib/db-features";
import { friendlyError } from "@/lib/friendly-error";
import { type PeopleMap, personName } from "@/lib/people";
import { REOPEN_COUNT_EVENT, type ReopenRequestRow, approvalLine, decideReopen } from "@/lib/reopen-sign-off";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";

export const REOPEN_PENDING_COLUMNS = "id, record_ref, reason, requested_by, requested_at, approval_mode, reopened_at";

export type ReopenApprovalsListProps = {
  rows: ReopenRequestRow[];
  people: PeopleMap;
  canDecide: boolean;
  busyId: string | null;
  onDecide: (row: ReopenRequestRow, decision: "approve" | "reject") => void;
};

/** The pending reopens, as the Approval Queue shows them (no state of its own, so tests render it on the server). */
export function ReopenApprovalsList({ rows, people, canDecide, busyId, onDecide }: ReopenApprovalsListProps) {
  if (!rows.length) return null;
  return (
    <section className="space-y-4" data-testid="reopen-approvals">
      <div>
        <h2 className="text-xl font-semibold text-slate-950">Reopened jobs to sign off</h2>
        <p className="mt-1 text-sm text-slate-500">
          {canDecide ? "Approve or reject each reopen. A rejection is recorded against the reopen; it does not undo it or the work done since."
            : "An admin approves or rejects these with their own login."}
        </p>
      </div>
      {rows.map((row) => {
        const line = approvalLine(row);
        return (
          <Card key={row.id} data-reopen-request={row.id}>
            <CardHeader className="gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-2">
                <Badge className={row.reopened_at ? "bg-amber-500 text-white" : "bg-blue-600 text-white"}>{line.badge}</Badge>
                <CardTitle className="text-xl">{row.record_ref ?? "Job"}</CardTitle>
                <p className="text-sm text-slate-500">{line.detail}</p>
              </div>
              <div className="text-sm text-slate-500">{personName(people, row.requested_by)}, {fmtDateTime(row.requested_at)}</div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm text-slate-800"><span className="field-label">Reason: </span>{row.reason}</p>
              {canDecide ? (
                <div className="flex flex-col gap-2 md:flex-row">
                  <Button className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={busyId !== null} onClick={() => onDecide(row, "approve")}>{line.approveLabel}</Button>
                  <Button variant="outline" disabled={busyId !== null} onClick={() => onDecide(row, "reject")}>Reject</Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </section>
  );
}

/** The pending reopens' count for the sidebar badge (admin and office); 0 before 113 or on any error. */
export async function loadPendingReopenCount(): Promise<number> {
  if (!supabase) return 0;
  const { count, error } = await supabase.from("reopen_requests").select("id", { count: "exact", head: true }).eq("status", "pending");
  return error ? 0 : count ?? 0;
}

/** The sidebar's share of the Approval Queue badge: pending reopens, reloaded whenever a reopen is asked for or decided. */
export function usePendingReopenCount(enabled: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) { setCount(0); return; }
    let active = true;
    const load = () => { void loadPendingReopenCount().then((n) => { if (active) setCount(n); }); };
    load();
    window.addEventListener(REOPEN_COUNT_EVENT, load);
    return () => { active = false; window.removeEventListener(REOPEN_COUNT_EVENT, load); };
  }, [enabled]);
  return count;
}

/**
 * Approval Queue > reopened jobs (migration 113): every pending reopen of the company. An admin approves (a waiting request is
 * reopened then, under the admin's own session) or rejects (recorded; a tick-box reopen stays done). Shows nothing before 113.
 */
export function ReopenApprovals() {
  const { activeRole } = useUser();
  const canDecide = activeRole === "admin";
  const [rows, setRows] = useState<ReopenRequestRow[]>([]);
  const [people, setPeople] = useState<PeopleMap>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase.from("reopen_requests").select(REOPEN_PENDING_COLUMNS).eq("status", "pending").order("requested_at", { ascending: true });
    if (error) {
      if (!missingDbObject(error)) toast.error(friendlyError(error, "Couldn't load the reopens waiting for sign-off."));
      setRows([]);
      return;
    }
    setRows((data ?? []) as ReopenRequestRow[]);
    const loaded = await loadCompanyPeople(supabase);
    if (loaded) setPeople(loaded);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function decide(row: ReopenRequestRow, decision: "approve" | "reject") {
    if (!supabase || busyId) return;
    if (decision === "reject" && !window.confirm(row.reopened_at
      ? `Reject the reopen of ${row.record_ref ?? "this job"}? Your decision is recorded; the job stays reopened and the work is not undone.`
      : `Reject the reopen of ${row.record_ref ?? "this job"}? It is not reopened.`)) return;
    setBusyId(row.id);
    try {
      const done = await decideReopen(supabase, row.id, decision, null);
      if (!done.ok) throw done.error;
      toast.success(decision === "approve" ? (done.reopenedNow ? `${row.record_ref ?? "Job"} reopened and signed off.` : `${row.record_ref ?? "Job"} reopen signed off.`)
        : done.reopenKept ? `Rejection recorded. ${row.record_ref ?? "The job"} stays reopened.` : `Rejected. ${row.record_ref ?? "The job"} was not reopened.`);
      setRows((current) => current.filter((item) => item.id !== row.id));
      window.dispatchEvent(new CustomEvent(REOPEN_COUNT_EVENT));
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't record the decision. Nothing was changed."));
    } finally {
      setBusyId(null);
    }
  }

  return <ReopenApprovalsList rows={rows} people={people} canDecide={canDecide} busyId={busyId} onDecide={(row, decision) => void decide(row, decision)} />;
}
