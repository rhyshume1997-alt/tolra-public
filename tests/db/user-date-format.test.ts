/**
 * Migration 109: each person's date format (public.user_preferences.date_format). Row-level security gives every signed-in person
 * their own row and nothing else: nobody, a company admin included, reads or changes someone else's setting, in their company or
 * another; anon has no access; no one deletes. The column takes only the nine formats the app knows.
 * SQL only (as PostgREST runs it: role authenticated with the JWT claims), so it also runs against plain PostgreSQL with stand-ins.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DATE_FORMATS } from "@/lib/dates";
import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { type Who, q, refusal } from "./time-support";

let world: SyntheticWorld;
const user = (role: "admin" | "office" | "workshop" | "viewer", tenant: "alpha" | "beta" = "alpha"): Who => ({ id: world.tenants[tenant].users[role].id });
const everyone = () => (["alpha", "beta"] as const).flatMap((t) => (["admin", "office", "workshop", "viewer"] as const).map((r) => user(r, t).id));

/** What the database holds, read as the owner (no row-level security). */
const stored = async (who: Who) =>
  (await withDb((db) => db.query<{ date_format: string }>("select date_format from public.user_preferences where user_id = $1", [who.id]))).rows[0]?.date_format ?? null;
/** The app's save (lib/date-format-preference saveDateFormat: PostgREST upsert on user_id). */
const SAVE = `insert into public.user_preferences (user_id, date_format) values ($1, $2)
  on conflict (user_id) do update set user_id = excluded.user_id, date_format = excluded.date_format`;
const save = (as: Who, owner: Who, format: string) => q(as, SAVE, [owner.id, format]);
/** The app's read (loadDateFormat). */
const read = async (as: Who, owner: Who) => (await q<{ date_format: string }>(as, "select date_format from public.user_preferences where user_id = $1", [owner.id])).map((r) => r.date_format);

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
});

afterAll(async () => {
  if (!world) return;
  await withDb((db) => db.query("delete from public.user_preferences where user_id = any($1::uuid[])", [everyone()]));
  await destroySyntheticWorld(world.runId);
});

describe("109: a person's date format", () => {
  it("has no row until the person chooses (the app shows the default, DD/MM/YYYY); the column default is dmy-number", async () => {
    expect(await read(user("office"), user("office"))).toEqual([]);
    const column = await withDb((db) => db.query("select column_default from information_schema.columns where table_schema = 'public' and table_name = 'user_preferences' and column_name = 'date_format'"));
    expect(column.rows[0].column_default).toBe("'dmy-number'::text");
  });

  it("each person saves and reads their own, any of the nine formats, and changes it again (the app's upsert)", async () => {
    for (const format of DATE_FORMATS) {
      await save(user("workshop"), user("workshop"), format);
      expect(await read(user("workshop"), user("workshop"))).toEqual([format]);
    }
    await save(user("viewer"), user("viewer"), "ymd-number");
    expect(await stored(user("viewer"))).toBe("ymd-number");
    // Plain INSERT and UPDATE on the own row work too.
    await q(user("office"), "insert into public.user_preferences (user_id, date_format) values ($1, 'mdy-short')", [user("office").id]);
    await q(user("office"), "update public.user_preferences set date_format = 'dmy-full' where user_id = $1", [user("office").id]);
    expect(await stored(user("office"))).toBe("dmy-full");
  });

  it("refuses any value the app doesn't know (the CHECK), and nothing changes", async () => {
    await save(user("admin"), user("admin"), "dmy-short");
    for (const bad of ["DD/MM/YYYY", "dmy", "dmy-long", "", "ymd-number "]) {
      expect(await refusal(user("admin"), SAVE, [user("admin").id, bad])).toMatchObject({ code: "23514" });
    }
    expect(await refusal(user("admin"), SAVE, [user("admin").id, null])).toMatchObject({ code: "23502" });
    expect(await stored(user("admin"))).toBe("dmy-short");
  });

  it("nobody reads someone else's setting: not a colleague, not their company admin, not another company", async () => {
    await save(user("office"), user("office"), "mdy-full");
    for (const other of [user("admin"), user("workshop"), user("viewer"), user("admin", "beta"), user("office", "beta")]) {
      expect(await read(other, user("office"))).toEqual([]);
    }
    // Reading the whole table shows only one's own row.
    await save(user("admin", "beta"), user("admin", "beta"), "ymd-full");
    const all = await q<{ user_id: string }>(user("admin"), "select user_id from public.user_preferences");
    expect(all.map((r) => r.user_id)).toEqual([user("admin").id]);
    const beta = await q<{ user_id: string }>(user("admin", "beta"), "select user_id from public.user_preferences");
    expect(beta.map((r) => r.user_id)).toEqual([user("admin", "beta").id]);
  });

  it("nobody changes someone else's setting: an update touches no row, an insert or upsert for them is refused, a row can't be moved to them", async () => {
    await save(user("office"), user("office"), "mdy-full");
    for (const other of [user("admin"), user("workshop"), user("admin", "beta")]) {
      const updated = await q(other, "update public.user_preferences set date_format = 'ymd-number' where user_id = $1 returning user_id", [user("office").id]);
      expect(updated).toEqual([]);
      // The upsert for someone else: their row exists, so it is an UPDATE row-level security hides (42501 on the conflict row).
      expect(await refusal(other, SAVE, [user("office").id, "ymd-number"])).toMatchObject({ code: "42501" });
    }
    expect(await stored(user("office"))).toBe("mdy-full");
    // Someone with no row yet: an insert on their behalf is refused by the INSERT policy.
    expect(await stored(user("viewer", "beta"))).toBeNull();
    expect(await refusal(user("admin", "beta"), "insert into public.user_preferences (user_id, date_format) values ($1, 'mdy-number')", [user("viewer", "beta").id]))
      .toMatchObject({ code: "42501" });
    expect(await refusal(user("admin"), "insert into public.user_preferences (user_id, date_format) values ($1, 'mdy-number')", [user("viewer", "beta").id]))
      .toMatchObject({ code: "42501" });
    expect(await stored(user("viewer", "beta"))).toBeNull();
    // Moving one's own row onto someone else is refused by the UPDATE policy's check.
    await save(user("workshop"), user("workshop"), "dmy-number");
    expect(await refusal(user("workshop"), "update public.user_preferences set user_id = $2 where user_id = $1", [user("workshop").id, user("viewer", "beta").id]))
      .toMatchObject({ code: "42501" });
    expect(await stored(user("workshop"))).toBe("dmy-number");
    expect(await stored(user("viewer", "beta"))).toBeNull();
  });

  it("no one deletes a row, not even their own (the app saves the default instead)", async () => {
    await save(user("viewer"), user("viewer"), "dmy-full");
    expect(await refusal(user("viewer"), "delete from public.user_preferences where user_id = $1", [user("viewer").id])).toMatchObject({ code: "42501" });
    expect(await refusal(user("admin"), "delete from public.user_preferences where user_id = $1", [user("viewer").id])).toMatchObject({ code: "42501" });
    expect(await stored(user("viewer"))).toBe("dmy-full");
  });

  it("anon is refused everything", async () => {
    const asAnon = async (text: string, params: unknown[] = []) =>
      withDb(async (db) => {
        await db.query("begin");
        try {
          await db.query("set local role anon");
          await db.query(text, params);
          return null;
        } catch (err) {
          return (err as { code?: string }).code ?? "error";
        } finally {
          await db.query("rollback");
        }
      });
    expect(await asAnon("select * from public.user_preferences")).toBe("42501");
    expect(await asAnon("insert into public.user_preferences (user_id, date_format) values ($1, 'dmy-full')", [user("admin").id])).toBe("42501");
    expect(await asAnon("update public.user_preferences set date_format = 'dmy-full'")).toBe("42501");
    expect(await asAnon("delete from public.user_preferences")).toBe("42501");
  });

  it("the grants and policies are own-row only (one policy per command, no DELETE, nothing for anon)", async () => {
    const policies = await withDb((db) => db.query<{ cmd: string; roles: string[]; qual: string | null; with_check: string | null }>(
      "select cmd, roles::text[] as roles, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'user_preferences' order by cmd"));
    const own = "(user_id = ( SELECT auth.uid() AS uid))";
    expect(policies.rows).toEqual([
      { cmd: "INSERT", roles: ["authenticated"], qual: null, with_check: own },
      { cmd: "SELECT", roles: ["authenticated"], qual: own, with_check: null },
      { cmd: "UPDATE", roles: ["authenticated"], qual: own, with_check: own },
    ]);
    const grants = await withDb((db) => db.query<{ who: string; can: boolean }>(`select r as who, has_table_privilege(r, 'public.user_preferences', p) as can
      from unnest(array['anon', 'authenticated']) r, unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p order by 1, p`));
    expect(grants.rows.filter((g) => g.can).length).toBe(3);
    expect(grants.rows.filter((g) => g.who === "anon" && g.can)).toEqual([]);
  });
});
