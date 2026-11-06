/**
 * sm-e (1): characterises the DLN numbering hold (release 147) and the cutover scripts. Nothing is changed; each case asserts what the
 * SQL does TODAY, so a later change to it shows up here. Every case runs in one transaction that is always rolled back.
 * Findings (see each case): the hold is enforced by the delivery_notes trigger and the two note functions, NOT by next_doc_number('DLN');
 * keep_dln_numbering.sql has no undo; a company created after 147 is never held.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, attempt, inTransaction, newActor, newOrg, prepareFixture, psqlScript } from "../support/sm-e-db";

const SET = "supabase/cutover/set_dln_next_number.sql";
const UNDO = "supabase/cutover/undo_dln_next_number.sql";
const KEEP = "supabase/cutover/keep_dln_numbering.sql";
const keepVars = (slug: string) => ({ company_slug: slug, confirm_keep: "KEEP CURRENT DLN NUMBERING" });
const counterOf = async (db: import("pg").Client, org: string) => (await db.query("SELECT last FROM public.doc_counters WHERE organization_id=$1 AND prefix='DLN'", [org])).rows[0]?.last ?? null;
const heldRows = async (db: import("pg").Client, org: string) => (await db.query("SELECT 1 FROM public.dln_numbering_pending WHERE organization_id=$1", [org])).rowCount;
const actions = async (db: import("pg").Client, org: string) => (await db.query("SELECT action FROM security_audit.audit_log WHERE organization_id=$1 AND entity_table='doc_counters' ORDER BY created_at, id", [org])).rows.map(r => r.action);

beforeAll(prepareFixture);

describe("sm-e DLN hold and counter (release 147 + cutover scripts)", () => {
  it("REAL (SQL, not app): next_doc_number('DLN') ignores the hold, so a held company burns numbers while no note can be made", async () => {
    await inTransaction(async db => {
      const o = await newOrg(db, "held");
      const office = await newActor(db, o.id, "office");
      await db.query("INSERT INTO public.dln_numbering_pending(organization_id) VALUES($1)", [o.id]);
      // The hold works where it is checked: a note insert by a browser role is refused.
      const insert = await asUser(db, office, "INSERT INTO public.delivery_notes(organization_id, customer, status) VALUES($1,'Held Ltd','awaiting')", [o.id]);
      expect(insert.error).toMatchObject({ code: "55000", hint: "dln_numbering_not_set" });
      // But the number allocator is not checked (migrations/078 next_doc_number has no look at dln_numbering_pending).
      expect((await asUser<{ n: string }>(db, office, "SELECT public.next_doc_number('DLN') AS n")).rows![0].n).toBe("DLN-0001");
      expect((await asUser<{ n: string }>(db, office, "SELECT public.next_doc_number('DLN') AS n")).rows![0].n).toBe("DLN-0002");
      expect(await counterOf(db, o.id)).toBe(2);
      expect(await heldRows(db, o.id)).toBe(1);
      // Consequence on cutover day: the "start at DLN-0001" choice is now refused, because the counter has moved; a real pad number still works.
      const zero = await attempt(db, psqlScript(SET, { company_slug: o.slug, last_pad_number: "0", confirm_start_at_dln_0001: "START AT DLN-0001" }));
      expect(zero).toMatch(/already at 2, so it can't start at DLN-0001/);
      expect(await attempt(db, psqlScript(SET, { company_slug: o.slug, last_pad_number: "4521", confirm_start_at_dln_0001: "" }))).toBeNull();
      expect(await counterOf(db, o.id)).toBe(4521);
      expect(await heldRows(db, o.id)).toBe(0);
    });
  });

  it("REAL (ops script): keep_dln_numbering cannot be undone by undo_dln_next_number, and it also blocks the pad step", async () => {
    await inTransaction(async db => {
      const o = await newOrg(db, "keep");
      const office = await newActor(db, o.id, "office");
      for (let i = 0; i < 3; i++) expect((await asUser(db, office, "SELECT public.next_doc_number('DLN')")).error).toBeUndefined();
      await db.query("INSERT INTO public.dln_numbering_pending(organization_id) VALUES($1)", [o.id]);
      expect(await attempt(db, psqlScript(KEEP, keepVars(o.slug)))).toBeNull();
      expect(await heldRows(db, o.id)).toBe(0);
      expect(await counterOf(db, o.id)).toBe(3);
      expect(await actions(db, o.id)).toEqual(["DLN_HOLD_RELEASED"]);
      // undo only recognises DLN_COUNTER_SET, so it refuses: the hold stays lifted, the counter and the audit trail are unchanged.
      expect(await attempt(db, psqlScript(UNDO, { company_slug: o.slug }))).toMatch(/the step has not been run \(or is already undone\)/);
      expect(await heldRows(db, o.id)).toBe(0);
      expect(await counterOf(db, o.id)).toBe(3);
      expect(await actions(db, o.id)).toEqual(["DLN_HOLD_RELEASED"]);
      // Nor can the pad step correct it: DLN_HOLD_RELEASED counts as "already run". Keep is a one-way door.
      expect(await attempt(db, psqlScript(SET, { company_slug: o.slug, last_pad_number: "4521", confirm_start_at_dln_0001: "" }))).toMatch(/already been run/);
      expect(await counterOf(db, o.id)).toBe(3);
    });
  });

  it("REAL (as designed, worth knowing): a company created after 147 has no hold and numbers from DLN-0001 at once", async () => {
    await inTransaction(async db => {
      const o = await newOrg(db, "after147");
      const office = await newActor(db, o.id, "office");
      expect(await heldRows(db, o.id)).toBe(0);
      const made = await asUser<{ id: string }>(db, office, "SELECT public.create_with_lines('delivery_notes',$1::jsonb,'delivery_note_items','delivery_note_id','[]'::jsonb) AS id", [JSON.stringify({ customer: "New Ltd", status: "awaiting" })]);
      expect(made.error).toBeUndefined();
      expect((await db.query("SELECT dn_number FROM public.delivery_notes WHERE organization_id=$1", [o.id])).rows.map(r => r.dn_number)).toEqual(["DLN-0001"]);
      // The pad step and keep both refuse for it (nothing to lift), so such a company cannot be set to a pad number by the scripts' hold route.
      expect(await attempt(db, psqlScript(KEEP, keepVars(o.slug)))).toMatch(/is not held/);
      // The pad step is still allowed while no DLN is at or above the target and the counter is lower.
      expect(await attempt(db, psqlScript(SET, { company_slug: o.slug, last_pad_number: "4521", confirm_start_at_dln_0001: "" }))).toBeNull();
      expect(await counterOf(db, o.id)).toBe(4521);
    });
  });
});
