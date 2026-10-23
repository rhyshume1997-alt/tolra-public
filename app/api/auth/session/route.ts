import { NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/server/auth";

export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ user: null }, { headers });

  const { data } = await supabase.auth.getUser();
  const user = data?.user ? { id: data.user.id, email: data.user.email ?? null } : null;
  return NextResponse.json({ user }, { headers });
}
