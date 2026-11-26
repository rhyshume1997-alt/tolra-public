/**
 * BOUNDARY (module 9, ISO templates; owner-approved exception to "no saved documents / no SQL", 26 Nov). Reads and writes the append-only ISO
 * document versions through the database proposal p171 (table iso_document_versions, functions save_iso_document and approve_iso_document).
 * Inputs: a document id, text, a change note, an approver name. Outputs: typed results; nothing here throws.
 * Must not change: it never updates or deletes a row (a save is the function's new version; approval is the function's single transition);
 * company, person and the person's display name are decided by the database from the session, never sent from here; reads are SELECTs under
 * the signed-in admin's own session (row-level security: that company only) and are also filtered to the session company; ANY read that fails
 * (table or function not applied yet, no access, timeout) is "unavailable", so the page falls back to the read-only generated drafts and
 * never loops on an error. Nothing is audited here: the database functions write the audit rows (no document text in them).
 */
import { ISO_DOCUMENTS } from "@/lib/iso/document-list";
import { isoErrorText, parseBody, whichVersionPrints, type IsoBody, type IsoVersion, type IsoVersionMeta } from "@/lib/iso/editable-document";
import { ISO_LOAD_LIMIT_MS, settleWithin } from "@/lib/iso/load-iso-evidence-safe";
import { supabase } from "@/lib/supabase";
import { getCurrentOrganizationId } from "@/lib/supabase-business";

export const ISO_VERSION_META_COLUMNS = "id, doc_id, version, status, change_note, restored_from, created_by, created_by_name, created_at, approved_by_name, approved_at";
/** More than nine documents times any realistic number of saves; reached means the list is cut short and is reported as unavailable rather than guessed. */
export const ISO_VERSION_READ_CAP = 2000;

export type VersionsResult = { ok: true; versions: IsoVersionMeta[] } | { ok: false };
export type VersionResult = { ok: true; version: IsoVersion } | { ok: false };
export type WriteResult = { ok: true; version: number } | { ok: false; message: string };

const NINE = new Set(ISO_DOCUMENTS.map((d) => d.id));

function asMeta(row: Record<string, unknown>): IsoVersionMeta | null {
  if (typeof row.id !== "string" || typeof row.doc_id !== "string" || !NINE.has(row.doc_id) || typeof row.version !== "number") return null;
  if (row.status !== "draft" && row.status !== "approved") return null;
  return {
    id: row.id, doc_id: row.doc_id, version: row.version, status: row.status,
    change_note: typeof row.change_note === "string" ? row.change_note : null,
    restored_from: typeof row.restored_from === "number" ? row.restored_from : null,
    created_by: String(row.created_by ?? ""), created_by_name: String(row.created_by_name ?? ""), created_at: String(row.created_at ?? ""),
    approved_by_name: typeof row.approved_by_name === "string" ? row.approved_by_name : null,
    approved_at: typeof row.approved_at === "string" ? row.approved_at : null,
  };
}

/** Every saved version of the nine documents for this company, without the text. Any failure is { ok: false }. */
export async function loadIsoVersionMetas(): Promise<VersionsResult> {
  const db = supabase;
  if (!db) return { ok: false };
  return settleWithin<VersionsResult>((async () => {
    try {
      const org = await getCurrentOrganizationId();
      if (!org) return { ok: false } as const;
      const { data, error } = await db.from("iso_document_versions").select(ISO_VERSION_META_COLUMNS).eq("organization_id", org).order("doc_id").order("version", { ascending: false }).limit(ISO_VERSION_READ_CAP);
      if (error || !Array.isArray(data) || data.length >= ISO_VERSION_READ_CAP) return { ok: false } as const;
      const versions: IsoVersionMeta[] = [];
      for (const row of data as Record<string, unknown>[]) {
        const m = asMeta(row);
        if (!m) return { ok: false } as const;
        versions.push(m);
      }
      return { ok: true, versions } as const;
    } catch { return { ok: false } as const; }
  })(), ISO_LOAD_LIMIT_MS, { ok: false });
}

/** One version with its text. */
export async function loadIsoVersion(docId: string, version: number): Promise<VersionResult> {
  const db = supabase;
  if (!db || !NINE.has(docId)) return { ok: false };
  return settleWithin<VersionResult>((async () => {
    try {
      const org = await getCurrentOrganizationId();
      if (!org) return { ok: false } as const;
      const { data, error } = await db.from("iso_document_versions").select(`${ISO_VERSION_META_COLUMNS}, body`).eq("organization_id", org).eq("doc_id", docId).eq("version", version).maybeSingle();
      const meta = !error && data ? asMeta(data as Record<string, unknown>) : null;
      const body = meta ? parseBody((data as { body?: unknown }).body) : null;
      return meta && body ? ({ ok: true, version: { ...meta, body } } as const) : ({ ok: false } as const);
    } catch { return { ok: false } as const; }
  })(), ISO_LOAD_LIMIT_MS, { ok: false });
}

/** The text of the versions that print (latest approved, else latest saved draft, per document), keyed by document id. A document with none saved is absent. Failure: { ok: false }. */
export async function loadPrintVersions(metas: readonly IsoVersionMeta[]): Promise<{ ok: true; byDoc: Map<string, { kind: "approved" | "draft"; version: IsoVersion }> } | { ok: false }> {
  const db = supabase;
  if (!db) return { ok: false };
  const chosen = ISO_DOCUMENTS.map((d) => ({ id: d.id, choice: whichVersionPrints(metas.filter((m) => m.doc_id === d.id)) })).filter((c) => c.choice.kind !== "generated");
  if (!chosen.length) return { ok: true, byDoc: new Map() };
  return settleWithin<{ ok: true; byDoc: Map<string, { kind: "approved" | "draft"; version: IsoVersion }> } | { ok: false }>((async () => {
    try {
      const org = await getCurrentOrganizationId();
      if (!org) return { ok: false } as const;
      const ids = chosen.map((c) => c.choice.version!.id);
      const { data, error } = await db.from("iso_document_versions").select(`${ISO_VERSION_META_COLUMNS}, body`).eq("organization_id", org).in("id", ids);
      if (error || !Array.isArray(data)) return { ok: false } as const;
      const byDoc = new Map<string, { kind: "approved" | "draft"; version: IsoVersion }>();
      for (const c of chosen) {
        const row = (data as Record<string, unknown>[]).find((r) => r.id === c.choice.version!.id);
        const meta = row ? asMeta(row) : null;
        const body = row ? parseBody(row.body) : null;
        if (!meta || !body) return { ok: false } as const;
        byDoc.set(c.id, { kind: c.choice.kind as "approved" | "draft", version: { ...meta, body } });
      }
      return { ok: true, byDoc } as const;
    } catch { return { ok: false } as const; }
  })(), ISO_LOAD_LIMIT_MS, { ok: false });
}

type RpcRow = { version?: unknown } | null;

/** Saves `body` as a NEW draft version. baseVersion is the latest version the editor saw (0 when none): a newer one is refused. */
export async function saveIsoVersion(args: { docId: string; body: IsoBody; note: string; baseVersion: number; restoredFrom?: number | null }): Promise<WriteResult> {
  const db = supabase;
  if (!db) return { ok: false, message: "Editing is not available in this mode." };
  try {
    const { data, error } = await db.rpc("save_iso_document", { p_doc_id: args.docId, p_body: args.body, p_change_note: args.note.trim() || null, p_base_version: args.baseVersion, p_restored_from: args.restoredFrom ?? null });
    const version = (data as RpcRow)?.version;
    if (error || typeof version !== "number") return { ok: false, message: isoErrorText(error, "save") };
    return { ok: true, version };
  } catch { return { ok: false, message: isoErrorText(null, "save") }; }
}

/** Marks one draft version Approved with the typed approver name (the database stamps the time and the signed-in person). */
export async function approveIsoVersion(args: { docId: string; version: number; approverName: string }): Promise<WriteResult> {
  const db = supabase;
  if (!db) return { ok: false, message: "Editing is not available in this mode." };
  try {
    const { data, error } = await db.rpc("approve_iso_document", { p_doc_id: args.docId, p_version: args.version, p_approver_name: args.approverName.trim() });
    const version = (data as RpcRow)?.version;
    if (error || typeof version !== "number") return { ok: false, message: isoErrorText(error, "approve") };
    return { ok: true, version };
  } catch { return { ok: false, message: isoErrorText(null, "approve") }; }
}
