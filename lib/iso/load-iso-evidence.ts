/**
 * Reads what the ISO pack states and the self-check list uses. SELECTs only, under the signed-in user's own session (RLS applies),
 * each read bounded (fetchAll's row cap, reported when reached). Inputs: none. Output: GapEvidence, the facts the templates print, the
 * NCR register rows (for the internal reminder) and a list of reads that failed. Never throws and never writes.
 * Must not change: it must stay read-only, and a failed read must give null (never a guess), so the clause reads "Not evidenced by Tolra".
 */
import { fetchAll } from "@/lib/fetch-all";
import { currentAuthorisations, loadInspectorHistory } from "@/lib/inspectors";
import { loadNcrRegister } from "@/lib/jobs/load-ncr-register";
import { buildNcrRows, type NcrRow } from "@/lib/jobs/ncr-register";
import { openConfirmedCount } from "@/lib/iso/ncr-review-reminder";
import type { FlaggedJobs, GapEvidence } from "@/lib/iso/gap-checklist";
import type { IsoFacts } from "@/lib/iso/fill";
import { isSupplierStatus } from "@/lib/supplier-status";
import { supabase } from "@/lib/supabase";
import { getCurrentOrganizationId } from "@/lib/supabase-business";

export const ISO_MAX_ROWS = 5000;
const MEMBER_LIMIT = 1000;

export type IsoEvidence = {
  evidence: GapEvidence;
  facts: IsoFacts;
  ncrRows: NcrRow[] | null;
  /** Names of the reads that failed or were cut short, for one muted line. */
  unread: string[];
};

type JobRow = { id: string; inspected_at: string | null; drawing_revision: string | null; material_cert_no: string | null; heat_cast_no: string | null };
const blank = (v: string | null | undefined) => !v || !v.trim();

export function summariseJobs(rows: JobRow[], missing: (r: JobRow) => boolean, truncated: boolean): FlaggedJobs {
  const finished = rows.filter((r) => r.inspected_at);
  return { flagged: rows.length, finished: finished.length, finishedMissing: finished.filter(missing).length, truncated };
}

export async function loadIsoEvidence(): Promise<IsoEvidence> {
  const unread: string[] = [];
  const db = supabase;
  const out: IsoEvidence = {
    evidence: { inspectors: null, changeHistoryPresent: null, drawingRevision: null, suppliers: null, traceability: null },
    facts: { inspectors: null, suppliers: null, traceableJobs: null, openNcrs: null },
    ncrRows: null,
    unread,
  };
  if (!db) { unread.push("all records"); return out; }

  try {
    const orgId = await getCurrentOrganizationId();
    if (!orgId) throw new Error("no company");
    const { data, error } = await db.from("organization_members").select("user_id").eq("organization_id", orgId).eq("can_inspect", true).eq("active", true).eq("support", false).limit(MEMBER_LIMIT);
    if (error) throw error;
    const cut = (data ?? []).length >= MEMBER_LIMIT;
    if (cut) unread.push("some authorised inspectors");
    const onList = new Set(((data ?? []) as { user_id: string }[]).map((m) => m.user_id));
    const current = currentAuthorisations(await loadInspectorHistory(), onList);
    const withReason = [...onList].filter((id) => (current.get(id)?.reason ?? "").trim() !== "").length;
    out.evidence.inspectors = { current: onList.size, withReason, truncated: cut };
    out.facts.inspectors = onList.size;
  } catch { unread.push("authorised inspectors"); }

  try {
    const { data, error } = await db.from("audit_log_view").select("id").limit(1);
    if (error) throw error;
    out.evidence.changeHistoryPresent = (data ?? []).length > 0;
  } catch { unread.push("change history"); }

  try {
    const got = await fetchAll<JobRow>((from, to) => db.from("jobs").select("id, inspected_at, drawing_revision, material_cert_no, heat_cast_no").eq("drawing_revision_required", true).order("id").range(from, to) as never, { maxRows: ISO_MAX_ROWS });
    out.evidence.drawingRevision = summariseJobs(got.rows, (r) => blank(r.drawing_revision), got.truncated);
    if (got.truncated) unread.push("some jobs needing a drawing revision");
  } catch { unread.push("drawing revisions"); }

  try {
    const got = await fetchAll<JobRow>((from, to) => db.from("jobs").select("id, inspected_at, drawing_revision, material_cert_no, heat_cast_no").eq("traceable", true).order("id").range(from, to) as never, { maxRows: ISO_MAX_ROWS });
    out.evidence.traceability = summariseJobs(got.rows, (r) => blank(r.material_cert_no) || blank(r.heat_cast_no), got.truncated);
    out.facts.traceableJobs = got.rows.length;
    if (got.truncated) unread.push("some traceable jobs");
  } catch { unread.push("traceable jobs"); }

  try {
    const got = await fetchAll<{ id: string; supplier_status: string | null }>((from, to) => db.from("suppliers").select("id, supplier_status").order("id").range(from, to) as never, { maxRows: ISO_MAX_ROWS });
    const count = (s: string) => got.rows.filter((r) => isSupplierStatus(r.supplier_status) && r.supplier_status === s).length;
    const counts = { total: got.rows.length, approved: count("approved"), conditional: count("conditional"), blocked: count("blocked") };
    out.evidence.suppliers = { ...counts, truncated: got.truncated };
    out.facts.suppliers = counts;
    if (got.truncated) unread.push("some suppliers");
  } catch { unread.push("suppliers"); }

  // Open confirmed NCRs of any age: a blank range is open-ended in loadNcrRegister.
  const ncr = await loadNcrRegister({ from: "", to: "" });
  if (ncr.ok) {
    out.ncrRows = buildNcrRows(ncr.sources);
    out.facts.openNcrs = ncr.truncated ? null : openConfirmedCount(out.ncrRows);
    if (ncr.truncated) unread.push("some nonconformance records");
  } else unread.push("nonconformance records");

  return out;
}
