import { NextResponse } from "next/server";

import { createSupabaseServerClient, jsonError } from "@/lib/server/auth";
import { loadLogo, logoDataUrl } from "@/lib/server/branding";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

// Used by the company picker (/choose-company). Storage RLS lets a member read only the CURRENT session company's logo folder,
// so the picker can't download the others client-side. The company list comes from my_organizations() run AS THE CALLER (their own
// session, never the service role): only their own active companies. Only those ids are looked up, with the service role, by the
// same rules as the sign-in logo (lib/server/branding.ts loadLogo). The sign-in "branded login" opt-in does not apply: a member
// may see their own company's logo. Answers { [organization_id]: dataUrl | null } and nothing else from the company profile.

const HEADERS = { "Cache-Control": "private, no-store" };

export async function GET() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return jsonError("Service unavailable", 503, { headers: HEADERS });

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) return jsonError("Unauthorized", 401, { headers: HEADERS });

  const { data: companies, error: listError } = await supabase.rpc("my_organizations");
  if (listError) return jsonError("Couldn't load your companies.", 500, { headers: HEADERS });
  const ids = ((companies ?? []) as { organization_id: string }[]).map((company) => company.organization_id);

  const logos: Record<string, string | null> = Object.fromEntries(ids.map((id) => [id, null]));
  const admin = ids.length ? createSupabaseAdminClient() : null;
  if (admin) {
    try {
      const { data: rows } = await admin.from("organization_settings").select("organization_id, company_profile").in("organization_id", ids);
      const paths = new Map<string, unknown>();
      for (const row of (rows ?? []) as { organization_id: string; company_profile: Record<string, unknown> | null }[]) {
        if (ids.includes(row.organization_id)) paths.set(row.organization_id, row.company_profile?.logoPath);
      }
      await Promise.all([...paths].map(async ([id, logoPath]) => {
        try {
          logos[id] = logoDataUrl(await loadLogo(admin, id, logoPath));
        } catch {
          logos[id] = null;
        }
      }));
    } catch {
      // Logos are decoration: any failure leaves the icon tiles.
    }
  }
  return NextResponse.json(logos, { headers: HEADERS });
}
