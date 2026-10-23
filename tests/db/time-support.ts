/**
 * Shared helpers for the time and pay DB tests (migrations 050 to 052): run SQL as a signed-in member of a synthetic company, the way
 * PostgREST does (role authenticated, the JWT claims in request.jwt.claims), inside one transaction per call.
 */
import { randomUUID } from "node:crypto";
import type { Client } from "pg";

import { withDb } from "../support/fixtures";

export type Who = { id: string };

/** Sets the session to `who` (authenticated, aal1) for the open transaction. */
export async function become(db: Client, who: Who) {
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: who.id, role: "authenticated", aud: "authenticated", session_id: randomUUID(), aal: "aal1" })]);
}

/** Runs `fn` as `who` in its own transaction, committed when it succeeds (rolled back on error, and the error rethrown). */
export async function as<T>(who: Who, fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await become(db, who);
      const out = await fn(db);
      await db.query("commit");
      return out;
    } catch (err) {
      await db.query("rollback");
      throw err;
    }
  });
}

/** One statement as `who`; resolves with the rows. */
export const q = <R extends Record<string, unknown> = Record<string, unknown>>(who: Who, text: string, params: unknown[] = []) =>
  as(who, async (db) => (await db.query<R>(text, params)).rows);

/** The error a statement as `who` raises (code, hint, message), or null when it succeeds. */
export async function refusal(who: Who, text: string, params: unknown[] = []): Promise<{ code?: string; hint?: string; message: string } | null> {
  try {
    await q(who, text, params);
    return null;
  } catch (err) {
    const e = err as { code?: string; hint?: string; message: string };
    return { code: e.code, hint: e.hint, message: e.message };
  }
}

export const clock = (who: Who, action: string, at: string | null, key = randomUUID(), device: string | null = null) =>
  q<{ r: Record<string, unknown> }>(who, "select public.record_attendance_event($1, $2, $3, $4) as r", [key, action, at, device]).then((rows) => rows[0].r);

export const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
