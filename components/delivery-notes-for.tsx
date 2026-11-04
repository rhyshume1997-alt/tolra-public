"use client";

import Link from "next/link";
import { useState } from "react";

import { StatusBadge } from "@/components/status-badge";
import { fmtDate } from "@/lib/dates";
import { DELIVERY_NOTE_LIST_LIMIT, canListDeliveryNotes, deliveryNoteHref, fetchDeliveryNotesFor, type NoteList, type NoteListQuery, type NoteListRow } from "@/lib/delivery-notes-for";
import { friendlyError } from "@/lib/friendly-error";
import { supabase } from "@/lib/supabase";
import { deliveryNoteStatusKey } from "@/lib/status-colours";
import { useUser } from "@/lib/use-user";

/**
 * A read-only list of a job's or a customer's delivery notes, each linking to the note's print page. Read when it is opened (so a board of jobs
 * makes no extra requests). Row security keeps it to the signed-in person's company. It gates itself by role: only the roles that can read
 * delivery notes (admin, office, workshop) see it, wherever it is placed; a viewer gets nothing.
 */
export function DeliveryNotesFor({ query, label = "Delivery notes" }: { query: NoteListQuery; label?: string }) {
  const { activeRole } = useUser();
  const [list, setList] = useState<NoteList | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (list || !supabase) return;
    try {
      setError(null);
      setList(await fetchDeliveryNotesFor(supabase, query));
    } catch (err) {
      setError(friendlyError(err, "Couldn't load delivery notes."));
    }
  }

  if (!canListDeliveryNotes(activeRole)) return null;
  return (
    <details data-testid="delivery-notes-for" className="text-xs" onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open) void load(); }}>
      <summary className="min-h-8 cursor-pointer font-semibold text-brand underline underline-offset-2">{label}</summary>
      {error ? <p className="mt-1 text-red-700" role="alert">{error}</p> : null}
      {!error && list === null ? <p className="mt-1 text-slate-500">Loading...</p> : null}
      {list ? <DeliveryNotesForList rows={list.rows} more={list.more} /> : null}
    </details>
  );
}

/** The loaded list: the notes, or "none yet", and a line saying the list was cut when there are more than the limit. */
export function DeliveryNotesForList({ rows, more }: { rows: NoteListRow[]; more: boolean }) {
  if (!rows.length) return <p className="mt-1 text-slate-500" data-testid="delivery-notes-none">No delivery notes yet.</p>;
  return (
    <>
      <ul className="mt-1 space-y-1" data-testid="delivery-notes-list">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center gap-2">
            <Link href={deliveryNoteHref(row.id)} className="font-mono font-semibold text-brand underline underline-offset-2">{row.ref}</Link>
            <StatusBadge status={deliveryNoteStatusKey(row.status)} label={row.status} className="capitalize" />
            {row.date ? <span className="text-slate-600">{fmtDate(row.date)}</span> : null}
          </li>
        ))}
      </ul>
      {more ? <p className="mt-1 text-slate-600" data-testid="delivery-notes-more">More than {DELIVERY_NOTE_LIST_LIMIT} delivery notes: showing the latest {DELIVERY_NOTE_LIST_LIMIT}.</p> : null}
    </>
  );
}
