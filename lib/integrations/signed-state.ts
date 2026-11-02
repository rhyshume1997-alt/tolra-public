import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { LimiterUnavailableError, withinLimit } from "@/lib/server/login";

// Signed, expiring, one-use state for the two OAuth round trips that are NOT a company's own Connect (so they keep nothing in the
// database's oauth_states): the Microsoft admin-consent link ("admin_consent": made by a company admin, opened by that company's
// Microsoft administrator, who has no Tolra session) and the platform owner's "Test connection" for an app ("app_test").
// The state is `<base64url JSON>.<base64url HMAC-SHA256>`, signed with a key derived from INTEGRATIONS_ENCRYPTION_KEY. It carries its
// kind, provider, the company it is bound to (admin_consent) and the person who made it, an expiry and a random nonce. One use is
// enforced by the existing rate limiter: the first hit on the nonce is allowed, any later hit is refused (no new table).
// A normal Connect state is 43 plain base64url characters with no ".", which is how the callbacks tell them apart.

export type SignedStateKind = "admin_consent" | "app_test";
export type SignedStatePayload = {
  /** kind */ k: SignedStateKind;
  /** provider */ p: "xero" | "microsoft";
  /** company the state is bound to (null for app_test: it belongs to no company) */ o: string | null;
  /** the person who made it */ u: string;
  /** expires at, epoch seconds */ e: number;
  /** random nonce (the one-use key) */ n: string;
  /** app_test only: the PKCE verifier, encrypted (lib/integrations/crypto.ts) */ v?: string;
};

/** The longest an admin-consent link lives: the one-use record is kept 24 hours (auth_rate_hit's maximum window), so it never lives longer. */
export const ADMIN_CONSENT_TTL_SECONDS = 24 * 60 * 60;
/** A platform owner's test is a sign-in round trip: 10 minutes, like a company's Connect. */
export const APP_TEST_TTL_SECONDS = 10 * 60;
export const MAX_SIGNED_STATE_LENGTH = 800;
const USE_BUCKET = "signed_state_use";
const USE_WINDOW_SECONDS = 24 * 60 * 60;

const SHAPE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{43}$/;

/** True for a state this module made (a normal Connect state has no "."). Says nothing about whether it is valid. */
export function isSignedState(state: string): boolean {
  return state.length <= MAX_SIGNED_STATE_LENGTH && SHAPE.test(state);
}

const signingKey = (key: Buffer) => createHmac("sha256", key).update("tolra:signed-state:v1").digest();
const sign = (body: string, key: Buffer) => createHmac("sha256", signingKey(key)).update(body).digest("base64url");

/** `v` may be a function of the new nonce (a value that must be bound to it, such as an encrypted PKCE verifier). */
export function signState(input: Omit<SignedStatePayload, "e" | "n" | "v"> & { ttlSeconds: number; v?: string | ((nonce: string) => string) }, key: Buffer, now: number = Date.now()): { state: string; payload: SignedStatePayload } {
  const { ttlSeconds, v, ...rest } = input;
  const n = randomBytes(16).toString("base64url");
  const payload: SignedStatePayload = { ...rest, ...(v === undefined ? {} : { v: typeof v === "function" ? v(n) : v }), e: Math.floor(now / 1000) + ttlSeconds, n };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return { state: `${body}.${sign(body, key)}`, payload };
}

export type VerifyResult = { ok: true; payload: SignedStatePayload } | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "wrong_kind" | "wrong_company" };

/** Signature, kind, expiry and (when `org` is given) the company it is bound to. Does NOT use it up: see consumeStateOnce. */
export function verifyState(state: string, key: Buffer, expect: { kind: SignedStateKind; org?: string }, now: number = Date.now()): VerifyResult {
  if (!isSignedState(state)) return { ok: false, reason: "malformed" };
  const [body, mac] = state.split(".");
  const want = Buffer.from(sign(body, key));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: "bad_signature" };
  let payload: SignedStatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SignedStatePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!payload || typeof payload.n !== "string" || typeof payload.e !== "number" || typeof payload.u !== "string"
    || (payload.p !== "xero" && payload.p !== "microsoft")) return { ok: false, reason: "malformed" };
  if (payload.k !== expect.kind) return { ok: false, reason: "wrong_kind" };
  if (Math.floor(now / 1000) >= payload.e) return { ok: false, reason: "expired" };
  if (expect.org !== undefined && payload.o !== expect.org) return { ok: false, reason: "wrong_company" };
  return { ok: true, payload };
}

/** Uses the state up: true the first time, false for every later try, and false when the limiter can't be used (fails closed). */
export async function consumeStateOnce(service: SupabaseClient, payload: SignedStatePayload): Promise<boolean> {
  try {
    return await withinLimit(service, USE_BUCKET, payload.n, USE_WINDOW_SECONDS, 1);
  } catch (err) {
    if (err instanceof LimiterUnavailableError) return false;
    throw err;
  }
}
