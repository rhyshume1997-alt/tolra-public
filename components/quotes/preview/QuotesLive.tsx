"use client";

/**
 * BOUNDARY (Quotes module 3, READ-ONLY LIVE PREVIEW, scratch environment only). Inputs: the signed-in session (useUser) and the browser Supabase client under that person's own
 * row-level-security session, exactly as the real Quote Generator uses it. Outputs: the redesigned Quotes screen (QuotesPreview) fed with the person's real quotes, read with SELECT only
 * through lib/quote-list-load.ts. Wrapped in RoleGate (admin, office) as well as the middleware prefix gate and the production gate in the route's page.
 * A failed load shows the failed state with Retry: it NEVER falls back to the sample quotes. Nothing here writes, sends, e-mails, uploads, exports or opens a window.
 * Must not change: no .insert/.update/.upsert/.delete/.rpc/.storage, no fetch to /api, no e-mail, send, mailto or window.open, no import of a write helper
 * (tests/unit/quotesLiveGuard.test.ts scans this file and fails if any appear).
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { RoleGate } from "@/components/role-gate";
import QuotesPreview, { type QuoteRow, type SeedLine } from "@/components/quotes/preview/QuotesPreview";
import { toDateInput } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { loadArchiveState, loadQuoteLines, loadQuoteList, type ManualArchive, type QuoteListRow } from "@/lib/quote-list-load";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";
import { truncationNotice } from "@/lib/fetch-all";

export const LIVE_BANNER = "Read-only preview of real data: nothing is saved or sent";

/** The loaded list row as the preview's row: lines stay empty (they load when a quote is opened), the manual archive choice is attached. Pure. */
export function toPreviewRow(row: QuoteListRow, manual: Map<string, ManualArchive>): QuoteRow {
  const id = row.id ?? row.ref;
  return {
    id, ref: row.ref, customer: row.customer, description: row.description, rawStatus: row.rawStatus, status: row.status, date: row.date ?? "", validUntil: row.validUntil, sentAt: row.sentAt,
    vatEnabled: row.vatEnabled, version: row.version, previousVersionId: row.previousVersionId, customerPo: row.customerPo, internalNotes: row.internalNotes, customerNotes: row.customerNotes,
    manual: row.id ? manual.get(row.id) : undefined, lines: [], value: row.value, declinedValue: row.declinedValue ?? 0,
  };
}

type Loaded = { rows: QuoteRow[]; months: number; notice: string; today: string };

function LiveInner() {
  const { profile } = useUser();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setState("loading");
    void (async () => {
      try {
        if (!supabase) throw new Error("Supabase is not configured yet.");
        const today = toDateInput(new Date());
        const [list, archive] = await Promise.all([
          loadQuoteList(supabase, today),
          // A failed archive read must not hide the quotes: it is said in the notice, as the real page says it in a toast.
          loadArchiveState(supabase).catch(() => null),
        ]);
        if (!active) return;
        const notes: string[] = [];
        if (list.truncated) notes.push(truncationNotice(list.rows.length));
        if (list.declinedTruncated) notes.push("Some declined lines were not counted: the list of them was cut short.");
        if (!archive) notes.push("Couldn't load which quotes were archived by hand, so some may show under Open or Done instead of Archived.");
        const manual = archive?.manual ?? new Map<string, ManualArchive>();
        setLoaded({ rows: list.rows.map((row) => toPreviewRow(row, manual)), months: archive?.months ?? 12, notice: notes.join(" "), today });
        setError("");
        setState("ready");
      } catch (err) {
        if (!active) return;
        // Never the sample rows: an error state with Retry, nothing else.
        setLoaded(null);
        setError(friendlyError(err, "The list could not be loaded. Nothing was changed. Check your connection and try again."));
        setState("error");
      }
    })();
    return () => { active = false; };
  }, [attempt]);

  const loadLines = useCallback(async (quoteId: string): Promise<SeedLine[]> => {
    if (!supabase) throw new Error("Supabase is not configured yet.");
    const lines = await loadQuoteLines(supabase, quoteId);
    return lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, partNumber: l.partNumber ?? undefined, drawingNumber: l.drawingNumber ?? undefined, drawingRevision: l.drawingRevision ?? undefined, declined: l.declined }));
  }, []);
  const onRetry = useCallback(() => setAttempt((n) => n + 1), []);
  const rows = useMemo(() => loaded?.rows ?? [], [loaded]);

  return (
    <QuotesPreview readOnlyReason={LIVE_BANNER} rows={rows} today={loaded?.today ?? toDateInput(new Date())} archiveMonths={loaded?.months} loadState={state}
      errorDetail={error} onRetry={onRetry} companyName={profile?.organization ?? undefined} notice={loaded?.notice || undefined} loadLines={loadLines} />
  );
}

export default function QuotesLive() {
  return <RoleGate allowed={["admin", "office"]}><LiveInner /></RoleGate>;
}
