import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

import { forbiddenOrigin, sameOrigin } from "@/lib/server/auth";
import { withGatewayRetry } from "@/lib/server/resilient-fetch";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) return NextResponse.json({ ok: true });

  const cookieStore = await cookies();
  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    global: { fetch: withGatewayRetry() },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) =>
        cookiesToSet.forEach(({ name, value, options }) =>
          cookieStore.set(name, value, { ...options, secure: process.env.NODE_ENV === "production" }),
        ),
    },
  });

  await supabase.auth.signOut();
  return NextResponse.json({ ok: true });
}
