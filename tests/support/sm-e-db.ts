/** Test-only helpers for the sm-e state-machine characterisation tests. Every case runs in ONE transaction that is always rolled back. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Client } from "pg";

import { preparePost144Fixture } from "./post-144-release-fixture";
import { verifyBackendIdentity, withDb } from "./fixtures";

export const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
export const unwrapped = (sql: string) => sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;\s*$/m, "");

/** psql's :'name' as a quoted literal, its backslash meta-commands dropped, and the script's own BEGIN/COMMIT removed (the case's transaction owns them). */
export function psqlScript(file: string, vars: Record<string, string>): string {
  return unwrapped(read(file).split("\n").filter(l => !l.startsWith("\\")).join("\n"))
    .replace(/:'([a-z0-9_]+)'/g, (_, name: string) => {
      if (!(name in vars)) throw new Error(`psql variable ${name} not given`);
      return `'${vars[name].replaceAll("'", "''")}'`;
    });
}

export async function prepareFixture() {
  await verifyBackendIdentity();
  await withDb(db => preparePost144Fixture({ verify: verifyBackendIdentity, query: sql => db.query(sql) }));
}

export async function inTransaction<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async db => {
    await db.query("BEGIN");
    try { return await fn(db); } finally { await db.query("ROLLBACK"); }
  });
}

export type Actor = { id: string; session: string; email: string; org: string; role: string };
export async function newOrg(db: Client, label: string) {
  const id = randomUUID(), slug = `t-sme-${label}-${id.slice(0, 8)}`;
  await db.query("INSERT INTO public.organizations(id,name,slug,status) VALUES($1,$2,$3,'active')", [id, `Synthetic ${label}`, slug]);
  return { id, slug };
}
export async function newActor(db: Client, org: string, role: string): Promise<Actor> {
  const id = randomUUID(), session = randomUUID(), email = `${id}@example.test`;
  await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [id, email]);
  await db.query("INSERT INTO public.user_profiles(id,email,full_name,role,organization_id,active,must_change_password) VALUES($1,$2,'Synthetic',$3,$4,true,false)", [id, email, role, org]);
  await db.query("INSERT INTO public.organization_members(user_id,organization_id,role,active) VALUES($1,$2,$3,true)", [id, org, role]);
  await db.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)", [session, id]);
  await db.query("INSERT INTO security_audit.session_company(session_id,user_id,organization_id) VALUES($1,$2,$3)", [session, id, org]);
  return { id, session, email, org, role };
}
/** Runs one statement as an authenticated browser user (aal2). Returns rows, or { error } with the SQLSTATE and hint, leaving the transaction usable. */
export async function asUser<T = Record<string, any>>(db: Client, who: Actor, sql: string, params: unknown[] = []): Promise<{ rows?: T[]; error?: { code?: string; hint?: string; message: string } }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  await db.query("SAVEPOINT as_user");
  try {
    await db.query("SET LOCAL ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)", [JSON.stringify({ sub: who.id, session_id: who.session, role: "authenticated", aal: "aal2", email: who.email }), who.id]);
    const rows = (await db.query(sql, params)).rows as T[];
    await db.query("RESET ROLE");
    await db.query("RELEASE SAVEPOINT as_user");
    return { rows };
  } catch (e) {
    await db.query("ROLLBACK TO SAVEPOINT as_user");
    await db.query("RESET ROLE");
    const err = e as { code?: string; hint?: string; message: string };
    return { error: { code: err.code, hint: err.hint, message: err.message } };
  }
}
/** Runs an owner-level script/statement; returns the error message (state rolled back to before it) or null. */
export async function attempt(db: Client, sql: string, params: unknown[] = []): Promise<string | null> {
  await db.query("SAVEPOINT attempt");
  try { await db.query(sql, params); await db.query("RELEASE SAVEPOINT attempt"); return null; } catch (e) { await db.query("ROLLBACK TO SAVEPOINT attempt"); return (e as Error).message; }
}
