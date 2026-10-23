import "server-only";
import { createHash } from "crypto";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { clientIp as trustedClientIp } from "@/lib/server/auth";
import { isValidUsername, normaliseUsername } from "@/lib/username";

/** SHA-256 of the parts, so the rate-limit table never holds an e-mail, username or IP in clear. */
export function hashKey(...parts: string[]) {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

/**
 * Caller IP for rate limiting: the platform's x-real-ip, else the last x-forwarded-for hop (the one our proxy
 * added). The first hop is whatever the client sent, so trusting it would let anyone pick a fresh IP per request.
 */
export function clientIp(request: Request) {
  return trustedClientIp(request) ?? "unknown";
}

/** The limiter itself could not be used (no service role client, the database refused or was unreachable). */
export class LimiterUnavailableError extends Error {
  constructor(reason: string) {
    super(`rate limiter unavailable: ${reason}`);
    this.name = "LimiterUnavailableError";
  }
}

/** What sign-in and password reset say when the limiter is down: refused, never let through unchecked. */
export const TRY_AGAIN_SHORTLY = "Sign-in is temporarily unavailable. Try again shortly.";

/** The answer for a limiter failure: 503 with the message above and a Retry-After header. */
export function limiterUnavailableResponse(message = TRY_AGAIN_SHORTLY) {
  return NextResponse.json({ error: message }, { status: 503, headers: { "Retry-After": "30" } });
}

/**
 * Counts one attempt in `bucket` for `key` and says whether it is still allowed. FAILS SAFE: if the limiter itself is
 * unavailable (no service role client, an error, an unreachable database) it throws LimiterUnavailableError and the
 * caller refuses the request. It used to let the request through, which turned an outage into an unlimited guessing window.
 */
export async function withinLimit(admin: SupabaseClient | null, bucket: string, key: string, windowSeconds: number, max: number) {
  if (!admin) {
    console.error("[login] rate limiter unavailable: no service role client");
    throw new LimiterUnavailableError("no service role client");
  }
  let result: { data: unknown; error: { code?: string } | null };
  try {
    result = await admin.rpc("auth_rate_hit", { p_bucket: bucket, p_key_hash: hashKey(bucket, key), p_window_seconds: windowSeconds, p_max: max });
  } catch (err) {
    console.error("[login] rate limiter unavailable", err instanceof Error ? err.name : "threw");
    throw new LimiterUnavailableError("request failed");
  }
  if (result.error) {
    console.error("[login] rate limiter unavailable", result.error.code);
    throw new LimiterUnavailableError(result.error.code ?? "error");
  }
  return result.data === true;
}

/**
 * Attempts already recorded in `bucket` for `key` within the window, without recording one. Throws
 * LimiterUnavailableError when the limiter can't be read (callers refuse, as for withinLimit).
 */
export async function recentHits(admin: SupabaseClient | null, bucket: string, key: string, windowSeconds: number): Promise<number> {
  if (!admin) throw new LimiterUnavailableError("no service role client");
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  let result: { count: number | null; error: { code?: string } | null };
  try {
    result = await admin.from("auth_rate_limits").select("id", { count: "exact", head: true })
      .eq("bucket", bucket).eq("key_hash", hashKey(bucket, key)).gt("created_at", since);
  } catch (err) {
    console.error("[login] rate limiter unavailable", err instanceof Error ? err.name : "threw");
    throw new LimiterUnavailableError("request failed");
  }
  if (result.error) {
    console.error("[login] rate limiter unavailable", result.error.code);
    throw new LimiterUnavailableError(result.error.code ?? "error");
  }
  return result.count ?? 0;
}

/** The username lookup itself failed (database or network), as opposed to "no such username". Callers must not treat it as a wrong guess. */
export class LoginLookupError extends Error {
  constructor(reason: string) {
    super(`login lookup unavailable: ${reason}`);
    this.name = "LoginLookupError";
  }
}

/**
 * Username or e-mail -> the login's e-mail. Server-side only (service role): the e-mail is never sent back to the
 * browser. Returns null when there is no such username (callers then answer exactly as for a wrong password).
 * THROWS LoginLookupError when the lookup could not be made (no client, database error, unreachable): that says nothing
 * about the username, so callers answer "service unavailable" and do not count a failed guess.
 */
export async function resolveLoginEmail(admin: SupabaseClient | null, identifier: string): Promise<string | null> {
  const value = identifier.trim();
  if (value.includes("@")) return value.toLowerCase();
  const username = normaliseUsername(value);
  if (!isValidUsername(username)) return null;
  if (!admin) throw new LoginLookupError("no service role client");
  let result: { data: { email?: unknown } | null; error: { code?: string } | null };
  try {
    result = await admin.from("user_profiles").select("email").eq("username", username).maybeSingle();
  } catch (err) {
    console.error("[login] username lookup failed", err instanceof Error ? err.name : "threw");
    throw new LoginLookupError("request failed");
  }
  if (result.error) {
    console.error("[login] username lookup failed", result.error.code);
    throw new LoginLookupError(result.error.code ?? "error");
  }
  return result.data?.email ? String(result.data.email).toLowerCase() : null;
}
