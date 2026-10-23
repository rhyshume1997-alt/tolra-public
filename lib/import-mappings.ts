/**
 * Admin > Data: a company's saved column mappings (migration 076, table import_mappings: one per company, kind and header layout; admins
 * of the company read and write it through its row rules). A mapping is saved when an import is confirmed, so the next file with the
 * same headers needs no choosing.
 */
import { type SavedMapping, type SheetPlan, mappingToSave } from "@/lib/import-detect";
import { IMPORT_KINDS, type ImportKind } from "@/lib/import-targets";

/** The part of the Supabase client used here (so a test can stand in for it). */
export type MappingClient = {
  from(table: "import_mappings"): {
    select(columns: string): PromiseLike<{ data: unknown; error: { message: string } | null }>;
    upsert(rows: Record<string, unknown>[], options: { onConflict: string }): PromiseLike<{ error: { message: string } | null }>;
  };
};

const isKind = (value: unknown): value is ImportKind => typeof value === "string" && (IMPORT_KINDS as readonly string[]).includes(value);

/** The company's saved mappings (RLS: this company's, admin only). Empty when they can't be read: detection then uses the export columns and synonyms. */
export async function loadMappings(client: MappingClient): Promise<SavedMapping[]> {
  const { data, error } = await client.from("import_mappings").select("kind, header_signature, mapping");
  if (error || !Array.isArray(data)) return [];
  return data.flatMap((row: Record<string, unknown>) => {
    const mapping = row.mapping;
    if (!isKind(row.kind) || typeof row.header_signature !== "string" || !mapping || typeof mapping !== "object" || Array.isArray(mapping)) return [];
    const clean: Record<string, string> = {};
    for (const [header, target] of Object.entries(mapping as Record<string, unknown>)) clean[header] = typeof target === "string" ? target : "";
    return [{ kind: row.kind, header_signature: row.header_signature, mapping: clean }];
  });
}

/** The rows to save for the plans of a confirmed import: only layouts where the admin chose something, one per kind and layout. */
export function mappingRows(plans: SheetPlan[], organizationId: string): Record<string, unknown>[] {
  const rows = new Map<string, Record<string, unknown>>();
  for (const plan of plans) {
    const mapping = mappingToSave(plan);
    if (!mapping || !plan.kind) continue;
    rows.set(`${plan.kind}|${plan.signature}`, { organization_id: organizationId, kind: plan.kind, header_signature: plan.signature, mapping });
  }
  return [...rows.values()];
}

/** Saves them (insert, or update the layout's earlier mapping). Returns how many were saved; a failure is reported, never thrown: the import is already done. */
export async function saveMappings(client: MappingClient, plans: SheetPlan[], organizationId: string): Promise<{ saved: number; error: string | null }> {
  const rows = mappingRows(plans, organizationId);
  if (!rows.length) return { saved: 0, error: null };
  const { error } = await client.from("import_mappings").upsert(rows, { onConflict: "organization_id,kind,header_signature" });
  return error ? { saved: 0, error: error.message } : { saved: rows.length, error: null };
}

/**
 * The company's saved mappings, loaded once and awaited before a file is planned. A page that loads them in the background and plans the
 * first file at once (a quick upload straight after opening) would plan it with none; `ready()` hands out the load in progress, so planning
 * waits for it. `refresh()` loads again (after a save).
 */
export function mappingsStore(client: MappingClient | null) {
  let pending: Promise<SavedMapping[]> | null = null;
  const refresh = (): Promise<SavedMapping[]> => (pending = client ? loadMappings(client) : Promise.resolve([]));
  return { refresh, ready: (): Promise<SavedMapping[]> => pending ?? refresh() };
}
