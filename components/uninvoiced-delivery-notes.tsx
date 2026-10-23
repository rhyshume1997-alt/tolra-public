"use client";

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fmtDate } from "@/lib/dates";
import { supabase } from "@/lib/supabase";
import { REASON_LABEL, isMissingFunction, toUninvoiced, type UninvoicedNote } from "@/lib/uninvoiced";

const SHOWN = 50;

/**
 * "Sent but not invoiced" (migration 059): every delivery note that has gone out and is on no live invoice, with why. A note sent out
 * by a person gets a draft invoice by itself, so this lists what didn't: a failed draft, a hand-made note, a customer that differs from
 * the order, an internal job (never invoiced, listed so nothing is missed), and notes sent out before automatic drafts. Hidden when
 * there are none, or when the database is older than 059.
 */
export function UninvoicedDeliveryNotes({ refreshKey, onInvoiceFromNotes }: { refreshKey: number; onInvoiceFromNotes: () => void }) {
  const [rows, setRows] = useState<UninvoicedNote[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    void supabase.rpc("uninvoiced_delivery_notes").then(({ data, error }) => {
      if (!active) return;
      if (error) {
        if (!isMissingFunction(error)) { console.error(error); setFailed(true); }
        setRows([]);
        return;
      }
      setFailed(false);
      setRows(((data ?? []) as Record<string, unknown>[]).map(toUninvoiced));
    });
    return () => { active = false; };
  }, [refreshKey]);

  if (failed) return <p role="alert" className="text-sm text-red-700" data-testid="uninvoiced-error">Couldn&apos;t load the delivery notes sent but not invoiced. Reload the page to try again.</p>;
  if (!rows || !rows.length) return null;
  const toInvoice = rows.filter((row) => row.reason !== "internal-job").length;
  const shown = expanded ? rows : rows.slice(0, SHOWN);

  return (
    <Card data-testid="uninvoiced-delivery-notes">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-ink">Despatched but not invoiced</h2>
            <p className="text-sm text-slate-500" data-testid="uninvoiced-count">
              {toInvoice} delivery note{toInvoice === 1 ? "" : "s"} despatched with no invoice{rows.length > toInvoice ? `, and ${rows.length - toInvoice} for internal jobs (never invoiced)` : ""}.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onInvoiceFromNotes}>Invoice from Delivery Notes</Button>
        </div>
        <ul className="divide-y rounded-lg border text-sm" aria-label="Despatched but not invoiced">
          {shown.map((row) => (
            <li key={row.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 p-3" data-reason={row.reason}>
              <span className="font-mono font-semibold">{row.ref}</span>
              <span className="truncate">{row.customer || "No customer"}</span>
              <Badge variant="outline" className={row.reason === "internal-job" ? "" : "border-amber-400 bg-amber-50 text-amber-800"}>{REASON_LABEL[row.reason]}</Badge>
              <span className="ml-auto text-xs text-slate-500">{row.sentAt ? `Despatched ${fmtDate(row.sentAt)}` : "Despatched"}</span>
              <span className="basis-full text-xs text-slate-600">{row.detail}</span>
            </li>
          ))}
        </ul>
        {rows.length > SHOWN ? <Button variant="ghost" size="sm" onClick={() => setExpanded((value) => !value)}>{expanded ? "Show fewer" : `Show all ${rows.length}`}</Button> : null}
      </CardContent>
    </Card>
  );
}
