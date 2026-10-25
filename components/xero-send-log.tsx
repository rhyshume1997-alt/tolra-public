"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { loadCompanyPeople } from "@/lib/company-people";
import { fmtDateTime } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import {
  SEND_LOG_COLUMNS, type SendLogFilter, type SendLogRow, filterSendLog, issuedByMap, retryErrorMessage, sendLogView,
} from "@/lib/integrations/send-log";
import { type PeopleMap, personName } from "@/lib/people";
import { supabase } from "@/lib/supabase";

const LIMIT = 200;

const FILTERS: Array<{ value: SendLogFilter; label: string }> = [
  { value: "all", label: "Everything" },
  { value: "problems", label: "Failed or to check" },
  { value: "sent", label: "Sent" },
  { value: "pending", label: "Waiting to send" },
  { value: "skipped", label: "Not sent" },
];

/**
 * The send log as a table (pure: rendered in tests). One row per document: what it is (Tolra's number), sent / failed with the reason /
 * waiting / not sent, when, and who issued it (the issue is what queued it). Retry only where 084 allows it (failed, or to check in Xero).
 */
export function SendLogTable({ rows, people, issuedBy, busyId, onRetry }: {
  rows: SendLogRow[];
  people: PeopleMap;
  issuedBy: Record<string, string | null>;
  busyId?: string | null;
  onRetry?: (row: SendLogRow) => void;
}) {
  if (!rows.length) return <p className="text-sm text-slate-500" data-testid="send-log-empty">Nothing in the send log yet.</p>;
  return (
    <Table data-testid="send-log">
      <TableHeader>
        <TableRow>
          <TableHead>Document</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>When</TableHead>
          <TableHead>Issued by</TableHead>
          <TableHead><span className="sr-only">Action</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const view = sendLogView(row);
          return (
            <TableRow key={row.id} data-testid="send-log-row" data-status={row.status}>
              <TableCell className="font-medium">{view.document}</TableCell>
              <TableCell className="whitespace-normal">
                <StatusBadge status={view.badge} label={view.label} />
                {view.detail ? <p className="mt-1 max-w-md text-xs text-slate-600">{view.detail}</p> : null}
              </TableCell>
              <TableCell>{fmtDateTime(view.when)}</TableCell>
              <TableCell>{personName(people, issuedBy[row.doc_id])}</TableCell>
              <TableCell className="text-right">
                {view.retry && onRetry ? (
                  <Button size="sm" variant="outline" disabled={busyId === row.id} onClick={() => onRetry(row)}>Retry</Button>
                ) : null}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * Admin > Integrations > Send log. integration_sends is readable by the company's admins only (084), so this is admin only; office,
 * workshop and viewers see no log at all. Retry is 084's integration_retry_send (admin, two-step), then Send now (admin only), so the
 * document goes straight away; the server reads Xero back first, so one that did arrive is never sent twice.
 */
export function XeroSendLog({ reloadKey, onChanged }: { reloadKey: number; onChanged: () => void }) {
  const [rows, setRows] = useState<SendLogRow[] | null>(null);
  const [issuedBy, setIssuedBy] = useState<Record<string, string | null>>({});
  const [people, setPeople] = useState<PeopleMap>({});
  const [filter, setFilter] = useState<SendLogFilter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase.from("integration_sends").select(SEND_LOG_COLUMNS).eq("provider", "xero")
      .order("created_at", { ascending: false }).limit(LIMIT);
    if (error) {
      toast.error(friendlyError(error, "Couldn't load the send log."));
      return;
    }
    const list = (data ?? []) as unknown as SendLogRow[];
    setRows(list);
    const ids = (type: SendLogRow["doc_type"]) => [...new Set(list.filter((r) => r.doc_type === type).map((r) => r.doc_id))];
    const [inv, cn, who] = await Promise.all([
      ids("invoice").length ? supabase.from("invoices").select("id, issued_by").in("id", ids("invoice")) : Promise.resolve({ data: [] }),
      ids("credit_note").length ? supabase.from("credit_notes").select("id, issued_by").in("id", ids("credit_note")) : Promise.resolve({ data: [] }),
      loadCompanyPeople(supabase, { usernames: true }),
    ]);
    setIssuedBy(issuedByMap(inv.data, cn.data));
    if (who) setPeople(who);
  }, []);

  useEffect(() => { void load(); }, [load, reloadKey]);

  async function retry(row: SendLogRow) {
    if (!supabase) return;
    setBusyId(row.id);
    try {
      const { error } = await supabase.rpc("integration_retry_send", { p_send: row.id });
      if (error) {
        toast.error(retryErrorMessage(error as { code?: string; hint?: string; message?: string }));
        return;
      }
      const res = await fetch("/api/integrations/xero/send", { method: "POST", credentials: "same-origin" });
      const body = (await res.json().catch(() => ({}))) as { sent?: number; failed?: number; skipped?: string; error?: string };
      if (!res.ok) toast.error(body.error ?? "Queued again; it is sent on the next run.");
      else if (body.skipped === "not_configured") toast.message("Queued again. Xero is not set up on this server yet.");
      else toast.success(`Queued again. Sent ${Number(body.sent ?? 0)}; failed ${Number(body.failed ?? 0)}.`);
    } finally {
      setBusyId(null);
      await load();
      onChanged();
    }
  }

  const shown = rows ? filterSendLog(rows, filter) : [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Send log</CardTitle>
        <CardDescription>Every invoice, credit note and void sent to Xero, newest first. Each document is sent once.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          Show
          <select aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value as SendLogFilter)} className="h-9 rounded-lg border px-2 text-sm">
            {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </label>
        {!rows ? <p className="text-sm text-slate-500">Loading…</p> : <SendLogTable rows={shown} people={people} issuedBy={issuedBy} busyId={busyId} onRetry={retry} />}
        {rows && rows.length >= LIMIT ? <p className="text-xs text-slate-500">Showing the latest {LIMIT}.</p> : null}
      </CardContent>
    </Card>
  );
}
