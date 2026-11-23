"use client";

// Platform owner screen: the issues inbox. Inputs: GET /api/platform/issues (every company's issues, filtered by company, status and urgent).
// Outputs: PATCH /api/platform/issues { id, status, notes, prUrl } (Save, or Close which sets the status to closed). Must not change: the
// private notes and PR link exist only here (the route returns them to a platform owner only); it sends no e-mail, calls no AI and never
// deletes an issue; every check is the route's and the database's, not this file's.

import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ISSUE_STATUS_LABELS, ISSUE_STATUSES, OWNER_NOTES_MAX, PR_URL_MAX, type IssueStatus, type OwnerIssue } from "@/lib/issues/issues";

type Company = { organizationId: string; name: string };
type Draft = { status: IssueStatus; notes: string; prUrl: string };
type ListBody = { issues?: OwnerIssue[]; companies?: Company[]; error?: string; code?: string };
type UpdateBody = { ok?: boolean; status?: IssueStatus; closedAt?: string | null; updatedAt?: string | null; error?: string; code?: string };

const SELECT = "h-11 rounded-lg border border-slate-200 bg-white px-3 text-sm";

export function IssuesInbox() {
  const [issues, setIssues] = useState<OwnerIssue[] | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [org, setOrg] = useState("");
  const [status, setStatus] = useState("");
  const [urgent, setUrgent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams();
    if (org) params.set("org", org);
    if (status) params.set("status", status);
    if (urgent) params.set("urgent", urgent);
    try {
      const response = await fetch(`/api/platform/issues?${params.toString()}`, { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as ListBody;
      if (response.status === 403 && body.code === "mfa_required") return window.location.assign("/mfa");
      if (!response.ok || !body.issues) return setError(body.error || "Couldn't load the issues. Try again.");
      setIssues(body.issues);
      setCompanies(body.companies ?? []);
      setDrafts(Object.fromEntries(body.issues.map((issue) => [issue.id, { status: issue.status, notes: issue.ownerNotes, prUrl: issue.prUrl ?? "" }])));
    } catch {
      setError("Can't reach the server. Check your connection and try again.");
    }
  }, [org, status, urgent]);

  useEffect(() => {
    void load();
  }, [load]);

  function patch(id: string, change: Partial<Draft>) {
    setDrafts((current) => ({ ...current, [id]: { ...current[id], ...change } }));
  }

  async function save(issue: OwnerIssue, next: Draft) {
    setBusyId(issue.id);
    setRowError(null);
    try {
      const response = await fetch("/api/platform/issues", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: issue.id, status: next.status, notes: next.notes, prUrl: next.prUrl }) });
      const body = (await response.json().catch(() => ({}))) as UpdateBody;
      if (response.status === 403 && body.code === "mfa_required") return window.location.assign("/mfa");
      if (!response.ok || !body.ok) return setRowError({ id: issue.id, message: body.error || "Couldn't save. Try again." });
      await load();
    } catch {
      setRowError({ id: issue.id, message: "Can't reach the server. Check your connection and try again." });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="grid gap-4" data-testid="issues-inbox">
      <h1 className="text-2xl font-bold tracking-tight text-slate-950">Issues</h1>
      <div className="flex flex-wrap gap-3">
        <select aria-label="Company" className={SELECT} value={org} onChange={(event) => setOrg(event.target.value)}>
          <option value="">All companies</option>
          {companies.map((company) => <option key={company.organizationId} value={company.organizationId}>{company.name}</option>)}
        </select>
        <select aria-label="Status" className={SELECT} value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">Any status</option>
          {ISSUE_STATUSES.map((value) => <option key={value} value={value}>{ISSUE_STATUS_LABELS[value]}</option>)}
        </select>
        <select aria-label="Urgent" className={SELECT} value={urgent} onChange={(event) => setUrgent(event.target.value)}>
          <option value="">Urgent or not</option>
          <option value="true">Urgent only</option>
          <option value="false">Not urgent</option>
        </select>
      </div>
      {error ? <p role="alert" className="rounded-lg border border-red-200 bg-white px-4 py-3 text-sm text-red-700">{error} <Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button></p> : null}
      {issues === null && !error ? <><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></> : null}
      {issues?.length === 0 ? <p className="text-sm text-slate-500" data-testid="issues-empty">No issues match.</p> : null}
      <div className="grid gap-4" data-testid="issues-list">
        {(issues ?? []).map((issue) => {
          const draft = drafts[issue.id] ?? { status: issue.status, notes: issue.ownerNotes, prUrl: issue.prUrl ?? "" };
          const busy = busyId === issue.id;
          return (
            <Card key={issue.id} className="border-slate-200" data-issue={issue.id}>
              <CardContent className="grid gap-3 p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-slate-950">{issue.organizationName}</p>
                  {issue.urgent ? <Badge className="bg-red-600 text-white">Urgent</Badge> : null}
                  <Badge variant="outline">{ISSUE_STATUS_LABELS[issue.status]}</Badge>
                  <span className="text-xs text-slate-500">{new Date(issue.createdAt).toLocaleString("en-GB")}</span>
                </div>
                <p className="text-xs text-slate-500">Page {issue.page}{issue.raisedByName || issue.raisedByEmail ? `, raised by ${issue.raisedByName ?? issue.raisedByEmail}` : ""}</p>
                <p className="whitespace-pre-wrap text-sm text-slate-800">{issue.body}</p>
                <div className="grid gap-3 border-t border-slate-100 pt-3">
                  <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                    Status
                    <select aria-label={`Status of the issue from ${issue.organizationName}`} className={SELECT} value={draft.status} onChange={(event) => patch(issue.id, { status: event.target.value as IssueStatus })}>
                      {ISSUE_STATUSES.map((value) => <option key={value} value={value}>{ISSUE_STATUS_LABELS[value]}</option>)}
                    </select>
                  </label>
                  <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                    Private notes (only you see these)
                    <Textarea aria-label="Private notes" value={draft.notes} maxLength={OWNER_NOTES_MAX} rows={3} onChange={(event) => patch(issue.id, { notes: event.target.value })} />
                  </label>
                  <label className="grid gap-1.5 text-sm font-medium text-slate-700">
                    Link to the PR
                    <Input aria-label="Link to the PR" value={draft.prUrl} maxLength={PR_URL_MAX} placeholder="https://github.com/..." onChange={(event) => patch(issue.id, { prUrl: event.target.value })} className="h-11" autoComplete="off" />
                  </label>
                  {rowError?.id === issue.id ? <p role="alert" className="text-sm text-red-700">{rowError.message}</p> : null}
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={busy} onClick={() => void save(issue, draft)} className="min-h-11 bg-brand text-brand-ink hover:bg-brand-hover">{busy ? "Saving..." : "Save"}</Button>
                    {issue.status !== "closed" ? <Button variant="outline" disabled={busy} onClick={() => void save(issue, { ...draft, status: "closed" })} className="min-h-11">Close issue</Button> : null}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
