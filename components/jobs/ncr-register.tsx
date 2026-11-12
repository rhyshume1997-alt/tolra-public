"use client";

/**
 * The NCR register page body (read-only report, off by default). Inputs: the company's switch (organization_settings.hidden_nav marker),
 * the signed-in role, and the rows read by lib/jobs/load-ncr-register. Outputs: filters, summary tiles, a table and a CSV download.
 * Must not change: it never writes anything, reads nothing while the switch is off, and shows only to admin and office.
 */
import { useEffect, useMemo, useState } from "react";

import { RoleGate } from "@/components/role-gate";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DEMO_MODE } from "@/lib/demo";
import { fmtDate } from "@/lib/dates";
import { loadNcrRegister } from "@/lib/jobs/load-ncr-register";
import {
  buildNcrRows, countConcessions, defaultRange, filterNcrRows, ncrCsv, NCR_CONFIRMED_TYPES, splitByClass, summariseNcrRows,
  type NcrRow, type NcrSources, type NcrStatusFilter, type NcrType,
} from "@/lib/jobs/ncr-register";
import { NCR_REGISTER_OFF_NOTICE, ncrRegisterEnabled } from "@/lib/jobs/ncr-register-switch";
import { gbp } from "@/lib/money";
import { useOrgSettings } from "@/lib/org-settings";
import { CSV_TYPE, downloadFile } from "@/lib/spreadsheet";
import { supabase } from "@/lib/supabase";

const SELECT = "min-h-11 rounded-md border border-input bg-background px-3 text-sm";

export function NcrRegister() {
  return (
    <RoleGate allowed={["admin", "office"]}>
      <NcrRegisterBody />
    </RoleGate>
  );
}

function NcrRegisterBody() {
  const { hiddenNav, loaded } = useOrgSettings();
  const on = ncrRegisterEnabled(hiddenNav);
  const available = !DEMO_MODE && Boolean(supabase);
  const [range, setRange] = useState(() => defaultRange());
  const [type, setType] = useState<"all" | NcrType>("all");
  const [status, setStatus] = useState<NcrStatusFilter>("all");
  const [sources, setSources] = useState<NcrSources | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    if (!loaded || !on || !available) return;
    let cancelled = false;
    setState("loading");
    void loadNcrRegister(range).then((result) => {
      if (cancelled) return;
      if (!result.ok) { setState("error"); return; }
      setSources(result.sources);
      setTruncated(result.truncated);
      setState("ready");
    });
    return () => { cancelled = true; };
  }, [loaded, on, available, range]);

  // Confirmed NCRs follow every filter. Legacy failed inspections with no linked rework are listed apart (date range only), never in the totals.
  const { rows, legacy } = useMemo<{ rows: NcrRow[]; legacy: NcrRow[] }>(() => {
    if (!sources) return { rows: [], legacy: [] };
    const all = buildNcrRows(sources);
    return {
      rows: splitByClass(filterNcrRows(all, { from: range.from, to: range.to, type, status })).confirmed,
      legacy: splitByClass(filterNcrRows(all, { from: range.from, to: range.to, type: "all", status: "all" })).notLinked,
    };
  }, [sources, range, type, status]);
  const summary = useMemo(() => summariseNcrRows([...rows, ...legacy]), [rows, legacy]);

  if (!loaded) return <Skeleton className="h-80" />;
  if (!on) return <p className="text-sm text-slate-500">{NCR_REGISTER_OFF_NOTICE}</p>;
  if (!available) return <p className="text-sm text-slate-500">The NCR register is not available in this mode.</p>;

  const tiles: [string, string][] = [
    ["Total", String(summary.total)],
    ["Open", String(summary.open)],
    ["Closed", String(summary.closed)],
    ["Concession inspections (by inspection date)", String(sources ? countConcessions(sources, range) : 0)],
    ["Failed inspections, no linked rework (legacy)", String(summary.notLinked)],
    ...NCR_CONFIRMED_TYPES.map((t): [string, string] => [t, String(summary.byType[t])]),
    ["Quantity scrapped", String(summary.quantityScrapped)],
    ["Average days to close", summary.averageDaysToClose === null ? "None closed" : String(summary.averageDaysToClose)],
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">NCR register</h1>
        <p className="mt-2 text-sm text-slate-500">Read-only list of nonconformance records (rework, failed inspections, concessions and problems) for ISO 9001 clause 8.7.</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">From<Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
        <label className="text-sm">To<Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
        <label className="text-sm">Type<br /><select className={SELECT} value={type} onChange={(e) => setType(e.target.value as "all" | NcrType)}>
          <option value="all">All types</option>{NCR_CONFIRMED_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
        <label className="text-sm">Status<br /><select className={SELECT} value={status} onChange={(e) => setStatus(e.target.value as NcrStatusFilter)}>
          <option value="all">All</option><option value="open">Open</option><option value="closed">Closed</option></select></label>
        <Button variant="outline" className="min-h-11" disabled={!rows.length && !legacy.length} onClick={() => downloadFile(`ncr-register-${range.from}-to-${range.to}.csv`, ncrCsv([...rows, ...legacy]), CSV_TYPE)}>Download CSV</Button>
      </div>
      {state === "error" ? <p className="text-sm text-slate-500">The NCR register can&apos;t be read right now.</p> : state !== "ready" ? <Skeleton className="h-80" /> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {tiles.map(([label, value]) => <Card key={label}><CardContent className="p-4"><div className="text-xs text-slate-500">{label}</div><div className="text-xl font-semibold">{value}</div></CardContent></Card>)}
          </div>
          <p className="text-xs text-slate-500">Rework hours and material cost: {summary.hours} h, {gbp(summary.materialCost)} in total.</p>
          {truncated ? <p className="text-xs text-slate-500">Some records are not listed: narrow the date range.</p> : null}
          {!rows.length ? <p className="text-sm text-slate-500">No records match these filters.</p> : (
            <Table>
              <TableHeader><TableRow>
                {["Record", "Raised", "Type", "Reason / description", "Qty affected", "Scrapped", "Remade", "Status", "Closed", "Days open", "Replacements", "Rework hours", "Material cost"].map((h) => <TableHead key={h}>{h}</TableHead>)}
              </TableRow></TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell>{r.record}</TableCell>
                    <TableCell>{fmtDate(r.raisedAt)}</TableCell>
                    <TableCell>{r.type}</TableCell>
                    <TableCell>{r.reason}{r.action ? <div className="text-xs text-slate-500">{r.action}</div> : null}</TableCell>
                    <TableCell>{r.affectsAll ? "All" : r.quantityAffected ?? ""}</TableCell>
                    <TableCell>{r.scrapped ?? ""}</TableCell>
                    <TableCell>{r.remade ?? ""}</TableCell>
                    <TableCell>{r.statusText}</TableCell>
                    <TableCell>{r.closedAt ? `${fmtDate(r.closedAt)}${r.closedHow ? `, ${r.closedHow}` : ""}` : ""}</TableCell>
                    <TableCell>{r.daysOpen ?? ""}</TableCell>
                    <TableCell>{r.replacements || ""}</TableCell>
                    <TableCell>{r.hours ?? ""}</TableCell>
                    <TableCell>{r.materialCost === null ? "" : gbp(r.materialCost)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {legacy.length ? (
            <section className="space-y-2">
              <h2 className="text-base font-semibold">Failed inspections with no linked rework (legacy)</h2>
              <p className="text-xs text-slate-500">Not counted in the figures above. These are failed inspections older than the rework records, or whose rework link was lost.</p>
              <Table>
                <TableHeader><TableRow><TableHead>Record</TableHead><TableHead>Raised</TableHead><TableHead>Customer</TableHead><TableHead>Inspection notes</TableHead></TableRow></TableHeader>
                <TableBody>
                  {legacy.map((r) => (
                    <TableRow key={r.key}><TableCell>{r.record}</TableCell><TableCell>{fmtDate(r.raisedAt)}</TableCell><TableCell>{r.customer}</TableCell><TableCell>{r.reason}</TableCell></TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
