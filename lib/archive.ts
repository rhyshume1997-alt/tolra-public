"use client";

/**
 * Open / Done / Archived for list pages (migration 028). Nothing is ever deleted:
 *   Open      - still being worked on (draft, sent, in production, unpaid ...).
 *   Done      - finished (accepted/rejected/expired quote, paid invoice, received PO, converted SO, delivered note,
 *               inspected job).
 *   Archived  - done and older than the company's "archive after" months (default 12), or archived by hand.
 *               Still searchable, viewable and printable under the Archived filter.
 * A manual choice (admin/office) overrides the age rule: Archive now, or keep Active (never auto-archived).
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { auditEvent } from "@/lib/audit";
import { fetchAll } from "@/lib/fetch-all";
import { friendlyError } from "@/lib/friendly-error";
import type { AuditTable } from "@/lib/audit-contract";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";

export type ArchiveTable = "jobs" | "quotes" | "invoices" | "purchase_orders" | "sales_orders" | "delivery_notes";
export type Phase = "open" | "done" | "archived";
export type PhaseFilterValue = Phase | "all";
export type ManualState = "archived" | "active";

/** The phase of one record. `finalDate` is when it became done (or its document date when that isn't stored). */
export function phaseOf(record: { final: boolean; finalDate?: string | null }, manual: ManualState | undefined, months: number, now = new Date()): Phase {
  if (manual === "archived") return "archived";
  if (!record.final) return "open";
  if (manual === "active" || !record.finalDate) return "done";
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - months);
  const at = new Date(record.finalDate);
  return !Number.isNaN(at.getTime()) && at < cutoff ? "archived" : "done";
}

/** The company's archive setting and manual choices for one kind of record, plus the admin/office action. */
export function useArchive(table: ArchiveTable) {
  const { activeRole } = useUser();
  const [months, setMonths] = useState(12);
  const [manual, setManual] = useState<Map<string, ManualState>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const canManage = activeRole === "admin" || activeRole === "office";

  // Every override, page by page (audit L6: a single request stops at 1,000 rows). A failure is said, with Retry,
  // rather than quietly treating every record as following the age rule.
  useEffect(() => {
    if (!supabase) return;
    let active = true;
    void (async () => {
      try {
        const [{ data: settings, error: settingsError }, { rows: states }] = await Promise.all([
          supabase!.from("organization_settings").select("archive_after_months").maybeSingle(),
          fetchAll((from, to) => supabase!.from("record_archive_state").select("record_id, state").eq("record_table", table).order("record_id").range(from, to), { maxRows: Number.MAX_SAFE_INTEGER }),
        ]);
        if (settingsError) throw settingsError;
        if (!active) return;
        const value = Number((settings as { archive_after_months?: unknown } | null)?.archive_after_months);
        if (Number.isFinite(value) && value >= 1) setMonths(value);
        setManual(new Map(states.map((row) => [String(row.record_id), row.state as ManualState])));
        setLoadError(null);
        toast.dismiss(`archive-${table}`);
      } catch (err) {
        if (!active) return;
        const message = friendlyError(err, "Couldn't load which records were archived by hand, so some may show under Open or Done instead of Archived.");
        setLoadError(message);
        toast.error(message, { id: `archive-${table}`, duration: Infinity, action: { label: "Retry", onClick: () => setAttempt((n) => n + 1) } });
      }
    })();
    return () => { active = false; };
  }, [table, attempt]);

  /** Archive now ('archived'), keep out of the archive ('active'), or back to the age rule ('auto'). */
  const setState = useCallback(async (id: string, state: ManualState | "auto") => {
    if (!supabase) throw new Error("Supabase is not configured.");
    const { error } = await supabase.rpc("set_archive_state", { p_table: table, p_id: id, p_state: state });
    if (error) throw error;
    setManual((current) => {
      const next = new Map(current);
      if (state === "auto") next.delete(id);
      else next.set(id, state);
      return next;
    });
    void auditEvent({ action: "UPDATE", entityTable: table as AuditTable, entityId: id, metadata: { archive: state } });
  }, [table]);

  return { months, manual, canManage, setState, loadError, retry: () => setAttempt((n) => n + 1) };
}
