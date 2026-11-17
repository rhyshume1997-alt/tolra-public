import "server-only";
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ZodType } from "zod";

import { siteOrigin } from "@/lib/integrations/app-credentials";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { cleanPortalCode, cleanPortalRef, cleanPortalToken, codeHash, newPortalSessionToken, newSigninPairs, portalKey, refHash, tokenHash } from "./crypto";
import { portalEnabled } from "./flag";
import { sendPortalSigninEmail, type PortalMailDeps } from "./mail";
import { logPortalRefusal, portalRefusal } from "./refusal";
import {
  PORTAL_CODE_PATH, rpcEndSchema, rpcJobsSchema, rpcQuotesSchema, rpcRequestSchema, rpcSessionSchema, toPortalJob, toPortalQuote, toPortalSession,
  type PortalJob, type PortalQuote, type PortalResult, type PortalSession, type PortalSignin,
} from "./types";

/**
 * BOUNDARY: lib/portal/server.ts (module 10). Server-only; the ONLY place that calls the release 154 customer-side functions
 * (service role). Inputs: what a visitor typed, the cookie token, an optional deps override (tests). Outputs: PortalResult<T> (success, or
 * the one generic refusal) and void for request/end. Every RPC answer is parsed with strict zod; anything unexpected, an error, a missing
 * function (154 not applied) or a thrown exception is a refusal (fail closed). With the platform flag OFF, or the key missing, nothing
 * touches the database. `sends` and the e-mail address NEVER leave this module: requestPortalSignin returns void and mails inside after().
 * Must not return, log or throw anything that tells a visitor whether a contact, code, session or account exists. The per-IP limits and
 * the same-origin check belong to the routes (limits.ts), not here.
 */
export type PortalServerDeps = {
  admin?: SupabaseClient | null;
  env?: Record<string, string | undefined>;
  /** Runs after the response. Default: next/server after(). Tests pass their own. */
  schedule?: (task: () => Promise<void>) => void;
  mail?: PortalMailDeps;
};

type Rpc<T> = { ok: true; data: T } | { ok: false; refusal: ReturnType<typeof portalRefusal> };

/** One RPC, parsed. Any failure (client missing, error, throw, shape) is a refusal that carries a fresh id and logs only that id. */
async function callRpc<T>(deps: PortalServerDeps, fn: string, args: Record<string, unknown>, schema: ZodType<T>): Promise<Rpc<T>> {
  const fail = (correlationId?: string): Rpc<T> => {
    const refusal = portalRefusal(correlationId);
    logPortalRefusal(refusal.correlationId);
    return { ok: false, refusal };
  };
  const admin = deps.admin === undefined ? createSupabaseAdminClient() : deps.admin;
  if (!admin) return fail();
  try {
    const { data, error } = await admin.rpc(fn, args);
    if (error) return fail();
    const parsed = schema.safeParse(data);
    return parsed.success ? { ok: true, data: parsed.data } : fail();
  } catch {
    return fail();
  }
}

const off = (deps: PortalServerDeps) => !portalEnabled(deps.env ?? process.env);

/** Shared read: flag, token shape, RPC, then refusal or the mapped data. */
async function readWithToken<R extends { ok: boolean }, T>(
  deps: PortalServerDeps, token: unknown, fn: string, schema: ZodType<R>, map: (ok: Extract<R, { ok: true }>) => T,
): Promise<PortalResult<T>> {
  const clean = cleanPortalToken(token);
  if (off(deps) || !clean) return portalRefusal();
  const out = await callRpc(deps, fn, { p_token_hash: tokenHash(clean) }, schema);
  if (!out.ok) return out.refusal;
  const raw = out.data as { ok: boolean; correlation_id?: string };
  if (!raw.ok) return portalRefusal(raw.correlation_id);
  return { ok: true, data: map(out.data as Extract<R, { ok: true }>) };
}

/**
 * "E-mail me a sign-in link". ALWAYS makes 10 ref/code pairs and calls the database once (when on and keyed), whatever the e-mail is, then
 * mails in after() and returns void: neither the response nor its timing says whether the e-mail is a contact.
 */
export async function requestPortalSignin(email: unknown, deps: PortalServerDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  if (off(deps)) return;
  const key = portalKey(env);
  if (!key) return;
  const pairs = newSigninPairs(key);
  const typed = typeof email === "string" ? email.slice(0, 320) : "";
  const out = await callRpc(deps, "portal_signin_request", { p_email: typed, p_ref_hashes: pairs.map((p) => p.refHash), p_code_hashes: pairs.map((p) => p.codeHash) }, rpcRequestSchema);
  if (!out.ok || !out.data.ok) return;
  const origin = siteOrigin(env);
  if (!origin) return;
  const answer = out.data;
  const sends = answer.sends.flatMap((s) => {
    const pair = pairs[s.slot - 1];
    return pair ? [{ to: answer.email, companyName: s.company_name, customerName: s.customer_name, link: `${origin}${PORTAL_CODE_PATH}/${pair.ref}`, code: pair.code }] : [];
  });
  if (!sends.length) return;
  const task = async () => {
    for (const send of sends) await sendPortalSigninEmail(send, { env, ...deps.mail }).catch(() => false);
  };
  (deps.schedule ?? after)(task);
}

/** The code typed on the page the link opened. On success returns the session and the cookie token (hash only went to the database). */
export async function verifyPortalSignin(input: { ref: unknown; code: unknown }, deps: PortalServerDeps = {}): Promise<PortalResult<PortalSignin>> {
  const env = deps.env ?? process.env;
  const ref = cleanPortalRef(input.ref);
  const code = cleanPortalCode(input.code);
  const key = portalKey(env);
  if (off(deps) || !ref || !code || !key) return portalRefusal();
  const { token, tokenHash: tHash } = newPortalSessionToken();
  const out = await callRpc(deps, "portal_signin_verify", { p_ref_hash: refHash(ref), p_code_hash: codeHash(key, ref, code), p_token_hash: tHash }, rpcSessionSchema);
  if (!out.ok) return out.refusal;
  if (!out.data.ok) return portalRefusal(out.data.correlation_id);
  return { ok: true, data: { session: toPortalSession(out.data.session), token } };
}

/** Every portal page: who is signed in (the database also restarts the idle clock and enforces every switch). */
export function resolvePortalSession(token: unknown, deps: PortalServerDeps = {}): Promise<PortalResult<PortalSession>> {
  return readWithToken(deps, token, "portal_session_resolve", rpcSessionSchema, (r) => toPortalSession(r.session));
}

/** Sign out. Best effort and silent: the caller clears the cookie either way. */
export async function endPortalSession(token: unknown, deps: PortalServerDeps = {}): Promise<void> {
  const clean = cleanPortalToken(token);
  if (off(deps) || !clean) return;
  await callRpc(deps, "portal_session_end", { p_token_hash: tokenHash(clean) }, rpcEndSchema);
}

export function listPortalQuotes(token: unknown, deps: PortalServerDeps = {}): Promise<PortalResult<PortalQuote[]>> {
  return readWithToken(deps, token, "portal_quotes", rpcQuotesSchema, (r) => r.quotes.map(toPortalQuote));
}

export function listPortalJobs(token: unknown, deps: PortalServerDeps = {}): Promise<PortalResult<PortalJob[]>> {
  return readWithToken(deps, token, "portal_jobs", rpcJobsSchema, (r) => r.jobs.map(toPortalJob));
}
