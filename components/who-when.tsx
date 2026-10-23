"use client";

import { useEffect, useState } from "react";

import { type JobExtras, type PaymentRow, type PeopleMap, lineText, whoWhenLines } from "@/lib/people";
import { canReadUsernames } from "@/lib/company-people";
import { loadWhoWhen, withRetries } from "@/lib/who-when-load";
import { useMaybeUser } from "@/lib/use-user";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

export type WhoTable = "jobs" | "quotes" | "sales_orders" | "invoices" | "purchase_orders" | "delivery_notes" | "credit_notes";

/**
 * Small "who / when" lines for a record: created, started, finished, inspected ... with display names only (company_people,
 * migration 035) and "—" for anyone not recorded. Reads the record's own actor columns (the record is read as the signed-in
 * person, so it shows only what their role can already open). Pass `row` when the screen already has the record.
 */
export function WhoWhen({ table, recordId, row, className }: { table: WhoTable; recordId?: string | null; row?: Record<string, unknown> | null; className?: string }) {
  const [record, setRecord] = useState<Record<string, unknown> | null>(row ?? null);
  const [people, setPeople] = useState<PeopleMap | null>(null);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [extras, setExtras] = useState<JobExtras>({});
  const id = recordId ?? (typeof row?.id === "string" ? row.id : null);
  const usernames = canReadUsernames(useMaybeUser()?.profile);

  useEffect(() => {
    if (!supabase || !id || !/^[0-9a-f-]{36}$/i.test(id)) return;
    let live = true;
    void (async () => {
      // One lost or failed read used to leave the lines out for good; ask again a few times (lib/who-when-load.ts).
      const data = await withRetries(() => loadWhoWhen(supabase!, table, id, row, usernames), () => live);
      if (!data || !live) return;
      setRecord(data.record);
      setPeople(data.people);
      setPayments(data.payments);
      setExtras(data.extras);
    })();
    return () => { live = false; };
  }, [table, id, row, usernames]);

  if (!record || !people) return null;
  const lines = whoWhenLines(table, record, people, payments, extras);
  return (
    <section aria-label="Who and when" data-testid="who-when" className={cn("space-y-0.5 text-xs text-slate-600", className)}>
      <ul>
        {lines.map((line) => <li key={line.key} data-testid="who-when-line">{lineText(line)}</li>)}
      </ul>
    </section>
  );
}
