"use client";

import { useEffect, useMemo, useState } from "react";
import { BellRing, Database, FileSearch, LockKeyhole, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";

import { RoleGate } from "@/components/role-gate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ALERT_TEST_NETWORK_ERROR, type AlertTestOutcome, describeAlertTest } from "@/lib/alert-test-message";
import { auditActionLabel, recordTypeLabel } from "@/lib/activity";
import { fmtDateTime } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { supabase } from "@/lib/supabase";
import { PRODUCT } from "@/lib/product";

type AuditEntry = {
  id: string;
  actor_email: string | null;
  action: string;
  entity_table: string;
  entity_id: string | null;
  metadata: Record<string, unknown> | null;
  hash: string | null;
  created_at: string;
};

const controls = [
  {
    title: "Access by role",
    description: "Each person signs in with their own account. Their role decides which pages they can open and what they can change. Administrator accounts can also be protected with a code from an authenticator app.",
    icon: LockKeyhole,
  },
  {
    title: "Company separation",
    description: "Every record belongs to one company, and the database only shows people the records of their own company.",
    icon: Database,
  },
  {
    title: "Audit log",
    description: "Changes to records are logged automatically. Entries are added to the end of the log, linked to the one before, and cannot be edited or deleted. Only administrators can read it.",
    icon: FileSearch,
  },
  {
    title: "Exports and downloads",
    description: "Exports, PDF downloads and print packs are recorded in the audit log, with who did it and when.",
    icon: ShieldCheck,
  },
];

export default function CompliancePage() {
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [alertBusy, setAlertBusy] = useState(false);
  const [alertOutcome, setAlertOutcome] = useState<AlertTestOutcome | null>(null);

  async function sendTestAlert() {
    setAlertBusy(true);
    setAlertOutcome(null);
    try {
      const response = await fetch("/api/admin/alert-test", { method: "POST" });
      const body: unknown = await response.json().catch(() => null);
      setAlertOutcome(describeAlertTest(response.status, body));
    } catch {
      setAlertOutcome(ALERT_TEST_NETWORK_ERROR);
    } finally {
      setAlertBusy(false);
    }
  }

  async function loadAuditEntries() {
    if (!supabase) {
      setError("Couldn't load the audit log.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: auditError } = await supabase
      .from("audit_log_view")
      .select("id,actor_email,action,entity_table,entity_id,metadata,hash,created_at")
      .order("created_at", { ascending: false })
      .limit(25);

    if (auditError) {
      setAuditEntries([]);
      setError(friendlyError(auditError, "Couldn't load the audit log."));
    } else {
      setAuditEntries((data ?? []) as AuditEntry[]);
    }
    setLoading(false);
  }

  useEffect(() => {
    void loadAuditEntries();
  }, []);

  const filteredEntries = useMemo(() => {
    const search = query.toLowerCase().trim();
    if (!search) return auditEntries;
    return auditEntries.filter((entry) =>
      [entry.actor_email, entry.action, entry.entity_table, entry.entity_id, entry.hash]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(search)),
    );
  }, [auditEntries, query]);

  return (
    <RoleGate allowed={["admin"]}>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="page-title">Security</h1>
            <p className="mt-1 text-sm text-slate-500">How {PRODUCT.name} protects your company&apos;s records.</p>
          </div>
          <Button className="min-h-11 bg-brand hover:bg-brand-hover" onClick={() => void loadAuditEntries()} disabled={loading}>
            <RefreshCw className="size-4" />
            Refresh Audit Log
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {controls.map((control) => {
            const Icon = control.icon;
            return (
              <Card key={control.title}>
                <CardHeader>
                  <Icon className="size-6 text-brand" />
                  <CardTitle className="text-base">{control.title}</CardTitle>
                  <CardDescription>{control.description}</CardDescription>
                </CardHeader>
              </Card>
            );
          })}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BellRing className="size-5 text-brand" />
              Alerts
            </CardTitle>
            <CardDescription>When the live app hits a server error it e-mails the owner. Send a made-up test error to check that e-mail arrives. Only one test is allowed per hour.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button className="min-h-11 bg-brand hover:bg-brand-hover" onClick={() => void sendTestAlert()} disabled={alertBusy}>
              <BellRing className="size-4" />
              {alertBusy ? "Sending..." : "Send test alert"}
            </Button>
            <p
              role="status"
              aria-live="polite"
              className={alertOutcome ? `rounded-lg border p-3 text-sm ${alertOutcome.tone === "success" ? "border-green-200 bg-green-50 text-green-900" : alertOutcome.tone === "warning" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-red-200 bg-red-50 text-red-900"}` : "sr-only"}
            >
              {alertOutcome?.text}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileSearch className="size-5 text-brand" />
              Audit Log
            </CardTitle>
            <CardDescription>The 25 most recent recorded actions: exports, changes to records and administrative actions.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {error ? (
              <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </div>
            ) : null}
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search audit entries..." className="h-11" />
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Record</TableHead>
                    <TableHead>Integrity code</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredEntries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="whitespace-nowrap text-xs">{fmtDateTime(entry.created_at)}</TableCell>
                      <TableCell className="text-xs">{entry.actor_email || "System"}</TableCell>
                      <TableCell><Badge variant="outline">{auditActionLabel(entry.action)}</Badge></TableCell>
                      <TableCell className="text-xs">{recordTypeLabel(entry.entity_table)}</TableCell>
                      <TableCell className="whitespace-normal break-all font-mono text-xs">{entry.hash || "Pending"}</TableCell>
                    </TableRow>
                  ))}
                  {!filteredEntries.length && !error && !loading ? (
                    <TableRow><TableCell colSpan={5} className="py-8 text-center text-sm text-slate-500">{auditEntries.length ? "No entries match your search." : "No audit entries yet."}</TableCell></TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </RoleGate>
  );
}
