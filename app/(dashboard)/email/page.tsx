"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Brain, Info, Mail } from "lucide-react";

import { FilterBar } from "@/components/filter-bar";
import { RoleGate } from "@/components/role-gate";
import { StatusBadge } from "@/components/status-badge";
import { emailStatusKey } from "@/lib/status-colours";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDateTime } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { supabase } from "@/lib/supabase";
import { PRODUCT } from "@/lib/product";
import { useUser } from "@/lib/use-user";
import { toast } from "sonner";

type EmailRow = {
  id: string;
  to: string;
  subject: string;
  body: string;
  status: string;
  related: string;
  when: string;
};

const STATUS_LABEL: Record<string, string> = {
  drafted: "Drafted", copied: "Copied", sent_manually: "Sent manually", sent_via_system: "Sent", failed: "Failed", sending: "Sending", unknown: "Needs checking",
};

export default function EmailPage() {
  const [filters, setFilters] = useState(new Set(["all"]));
  const [rows, setRows] = useState<EmailRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { activeRole } = useUser();
  const [settling, setSettling] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!supabase) throw new Error("Supabase is not configured.");
      const { data, error: queryError } = await supabase
        .from("email_history")
        .select("id, to_email, subject, body, status, related_to_type, drafted_at, sent_at")
        .order("drafted_at", { ascending: false })
        .limit(100);
      if (queryError) throw queryError;
      setRows((data ?? []).map((row) => ({
        id: String(row.id),
        to: row.to_email || "",
        subject: row.subject || "",
        body: row.body || "",
        status: row.status || "drafted",
        related: String(row.related_to_type || "general").replace(/_/g, " "),
        when: fmtDateTime(row.sent_at || row.drafted_at),
      })));
    } catch (err) {
      setError(friendlyError(err, "Couldn't load email history."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** An admin who checked settles a job e-mail whose outcome was unknown (it went, or it didn't and may be sent again). */
  async function settle(item: EmailRow, as: "sent" | "failed") {
    setSettling(item.id);
    try {
      const response = await fetch("/api/send-job/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ historyId: item.id, as }) });
      if (!response.ok) throw new Error("settle failed");
      toast.success(as === "sent" ? "Marked as sent" : "Marked as not sent. It can be sent again.");
      await load();
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't update that email. Try again."));
    } finally {
      setSettling(null);
    }
  }

  const visible = useMemo(() => filters.has("all") ? rows : rows.filter((row) => filters.has(row.status)), [filters, rows]);
  const count = (status: string) => (loading || error ? "—" : String(rows.filter((row) => row.status === status).length));

  return (
    <RoleGate allowed={["admin", "office"]}>
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div><h1 className="page-title">Email & Payment Automation</h1><p className="mt-2 text-sm text-slate-500">Emails sent from Tolra, with a record of each. Automatic follow-ups are not available yet.</p></div>
      </div>

      <Card className="border-amber-200 bg-amber-50">
        <CardContent className="flex gap-3 p-5">
          <Info className="mt-0.5 size-5 shrink-0 text-amber-700" />
          <p className="text-sm font-medium text-amber-950">Coming soon: automatic email reading, quote follow-ups and payment reminders. Nothing on this page sends email yet. Drafts are reviewed in the Approval Queue.</p>
        </CardContent>
      </Card>

      <Card className="border-blue-200 bg-gradient-to-r from-brand to-brand-accent text-white">
        <CardContent className="grid gap-5 p-6 lg:grid-cols-[1.3fr_2fr]">
          <div><div className="flex items-center gap-2 font-semibold"><Brain className="size-5" /> Email history</div><p className="mt-3 text-sm text-white/80">Counts of the most recent 100 emails recorded by {PRODUCT.name}.</p></div>
          <div className="grid gap-3 sm:grid-cols-5">{[["Drafted", count("drafted"), "drafted"], ["Sent manually", count("sent_manually"), "sent_manually"], [`Sent by ${PRODUCT.name}`, count("sent_via_system"), "sent_via_system"], ["Failed", count("failed"), "failed"], ["Needs checking", count("unknown"), "unknown"]].map(([a, b, filter]) => <button key={a} onClick={() => setFilters(new Set([filter]))} className="rounded-lg bg-white/10 p-3 text-left transition hover:bg-white/20"><p className="text-xs text-white/70">{a}</p><p className="text-2xl font-bold">{b}</p></button>)}</div>
        </CardContent>
      </Card>

      <FilterBar options={[{ label: "All", value: "all" }, { label: "Drafted", value: "drafted" }, { label: "Sent manually", value: "sent_manually" }, { label: "Sent", value: "sent_via_system" }, { label: "Failed", value: "failed" }, { label: "Needs checking", value: "unknown" }]} onChange={setFilters} />

      {error ? <Card><CardContent className="flex flex-wrap items-center justify-between gap-3 p-5"><p className="text-sm text-red-700">{error}</p><Button variant="outline" onClick={() => void load()}>Retry</Button></CardContent></Card> : null}

      {loading ? <Skeleton className="h-60" /> : (
      <Card><CardContent className="p-0">
        <Table data-tablet-cards>
          <TableHeader className="hidden md:table-header-group"><TableRow><TableHead>To</TableHead><TableHead>Subject</TableHead><TableHead>Related to</TableHead><TableHead>Date</TableHead><TableHead>Status</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader>
          <TableBody>
            {visible.map((item) => (
              <TableRow key={item.id} className="block md:table-row">
                <TableCell data-label="To" className="block font-semibold md:table-cell">{item.to}</TableCell>
                <TableCell data-label="Subject" className="block md:table-cell">{item.subject}</TableCell>
                <TableCell data-label="Related to" className="block capitalize md:table-cell">{item.related}</TableCell>
                <TableCell data-label="Date" className="block md:table-cell">{item.when}</TableCell>
                <TableCell data-label="Status" className="block space-y-2 md:table-cell">
                  <StatusBadge status={emailStatusKey(item.status)} label={STATUS_LABEL[item.status] ?? item.status} />
                  {item.status === "unknown" && item.related === "job" ? (
                    <div className="max-w-xs space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
                      <p>We couldn&apos;t confirm whether this was sent. Check with the customer or the provider&apos;s log before sending it again.</p>
                      {activeRole === "admin" ? (
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="outline" disabled={settling === item.id} onClick={() => void settle(item, "sent")}>It was sent</Button>
                          <Button size="sm" variant="outline" disabled={settling === item.id} onClick={() => void settle(item, "failed")}>It was not sent</Button>
                        </div>
                      ) : <p className="font-medium">An administrator can settle this.</p>}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell data-actions className="block md:table-cell">
                  <Dialog>
                    <DialogTrigger asChild><Button variant="outline" size="sm"><Mail className="size-4" /> View</Button></DialogTrigger>
                    <DialogContent className="max-w-2xl">
                      <DialogHeader>
                        <DialogTitle>{item.subject}</DialogTitle>
                        <DialogDescription>To {item.to} · {item.when}</DialogDescription>
                      </DialogHeader>
                      <div className="whitespace-pre-wrap rounded-lg border p-4 text-sm text-slate-700">{item.body}</div>
                    </DialogContent>
                  </Dialog>
                </TableCell>
              </TableRow>
            ))}
            {!visible.length && !error ? <TableRow><TableCell colSpan={6} className="py-8 text-center text-slate-500">No emails recorded yet.</TableCell></TableRow> : null}
          </TableBody>
        </Table>
      </CardContent></Card>
      )}
    </div>
    </RoleGate>
  );
}
