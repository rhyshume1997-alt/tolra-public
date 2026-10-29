import type { SupabaseClient } from "@supabase/supabase-js";

/** True when the name exactly (ignoring case) matches one of this company's customers (the caller's session and RLS). */
export async function knownCustomer(db: SupabaseClient, org: string, name: string | null): Promise<boolean> {
  if (!name) return false;
  const pattern = name.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data, error } = await db.from("customers").select("name").eq("organization_id", org).ilike("name", pattern).limit(1);
  return !error && (data?.length ?? 0) > 0;
}
