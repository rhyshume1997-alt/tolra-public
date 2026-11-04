"use client";

import Link from "next/link";
import { useState } from "react";

import { StatusBadge } from "@/components/status-badge";
import { fmtDate } from "@/lib/dates";
import { deliveryNoteHref, fetchDeliveryNotesFor, type NoteListQuery, type NoteListRow } from "@/lib/delivery-notes-for";
import { friendlyError } from "@/lib/friendly-error";
import { supabase } from "@/lib/supabase";
import { deliveryNoteStatusKey } from "@/lib/status-colours";

/**
 * A read-only list of a job's or a customer's delivery notes, each linking to the note's print page. Read when it is opened (so a board of jobs
 * makes no extra requests). Row security keeps it to the signed-in person's company; the caller shows it only to roles that can read delivery notes.
 */
export function DeliveryNotesFor({ query, label = "Delivery notes" }: { query: NoteListQuery; label?: string }) {
  const [rows, setRows] = useState<NoteListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (rows || !supabase) return;
    try {
      setError(null);
      setRows(await fetchDeliveryNotesFor(supabase, query));
    } catch (err) {
      setError(friendlyError(err, "Couldn't load delivery notes."));
    }
  }

  return (
    <details data-testid="delivery-notes-for" className="text-xs" onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open) void load(); }}>
      <summary className="min-h-8 cursor-pointer font-semibold text-brand underline underline-offset-2">{label}</summary>
      {error ? <p className="mt-1 text-red-700" role="alert">{error}</p> : null}
      {!error && rows === null ? <p className="mt-1 text-slate-500">Loading...</p> : null}
      {rows && !rows.length ? <p className="mt-1 text-slate-500" data-testid="delivery-notes-none">No delivery notes yet.</p> : null}
      {rows?.length ? (
        <ul className="mt-1 space-y-1" data-testid="delivery-notes-list">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-2">
              <Link href={deliveryNoteHref(row.id)} className="font-mono font-semibold text-brand underline underline-offset-2">{row.ref}</Link>
              <StatusBadge status={deliveryNoteStatusKey(row.status)} label={row.status} className="capitalize" />
              {row.date ? <span className="text-slate-600">{fmtDate(row.date)}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
