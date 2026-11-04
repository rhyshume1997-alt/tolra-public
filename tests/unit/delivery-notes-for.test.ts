/**
 * A job's and a customer's delivery notes (read-only list on the job and customer pages): which rows, in what order, who sees it.
 * A note that carries the job / customer by foreign key is matched by that key only. A legacy hand-made note that names the job or
 * customer as text is still listed, but only while it has no key of its own (so a note linked to another job or customer never shows).
 */
import { describe, expect, it } from "vitest";

import { DELIVERY_NOTE_LIST_LIMIT, canListDeliveryNotes, deliveryNoteHref, fetchDeliveryNotesFor, type NoteListRow } from "@/lib/delivery-notes-for";

type Row = Record<string, unknown>;
const J = "11111111-1111-4111-8111-111111111111";
const J2 = "33333333-3333-4333-8333-333333333333";
const C = "22222222-2222-4222-8222-222222222222";
const C2 = "44444444-4444-4444-8444-444444444444";

/** A stand-in for the signed-in client: the rows filtered by eq() / is(), as row security would leave them, cut at limit(). */
function fakeDb(rows: Row[], failWith?: string) {
  const calls: Array<Array<[string, string, unknown]>> = [];
  return {
    calls,
    from: (table: string) => {
      expect(table).toBe("delivery_notes");
      const filters: Array<[string, string, unknown]> = [];
      let cap = Infinity;
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => { filters.push(["eq", column, value]); return builder; },
        is: (column: string, value: unknown) => { filters.push(["is", column, value]); return builder; },
        order: () => builder,
        limit: (n: number) => { cap = n; return builder; },
        then: (resolve: (value: { data: unknown; error: unknown }) => unknown) => {
          calls.push(filters);
          if (failWith) return Promise.resolve({ data: null, error: { message: failWith } }).then(resolve);
          const hit = rows.filter((r) => filters.every(([, c, v]) => (r[c] ?? null) === v)).slice(0, cap);
          return Promise.resolve({ data: hit, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

const note = (id: string, extra: Row): Row => ({ id, dn_number: `DLN-000${id}`, status: "despatched", delivery_date: "2026-10-20", customer: "Acme Ltd", job_ref: null, job_id: null, customer_id: null, ...extra });

describe("fetchDeliveryNotesFor a job", () => {
  it("lists notes linked by job id and legacy hand-made notes that name the job, each once, newest first", async () => {
    const db = fakeDb([
      note("1", { job_id: J, job_ref: "J-0042", delivery_date: "2026-10-01" }),
      note("2", { job_ref: "J-0042", delivery_date: "2026-10-09" }),
      note("3", { job_id: J, delivery_date: "2026-10-05" }),
      note("4", { job_ref: "J-0099" }),
    ]);
    const { rows, more } = await fetchDeliveryNotesFor(db, { jobId: J, jobNo: "J-0042" });
    expect(rows.map((r) => r.ref)).toEqual(["DLN-0002", "DLN-0003", "DLN-0001"]);
    expect(more).toBe(false);
  });
  it("matches by the job's key, not by its text: a note linked to ANOTHER job that repeats this job's number is not listed", async () => {
    const db = fakeDb([
      note("1", { job_id: J }),
      note("2", { job_id: J2, job_ref: "J-0042" }),
      note("3", { job_ref: "J-0042" }),
    ]);
    const { rows } = await fetchDeliveryNotesFor(db, { jobId: J, jobNo: "J-0042" });
    expect(rows.map((r) => r.id).sort()).toEqual(["1", "3"]);
    // The text match is for legacy notes only: it asks for notes with no job key.
    expect(db.calls).toContainEqual([["eq", "job_ref", "J-0042"], ["is", "job_id", null]]);
    expect(db.calls).toContainEqual([["eq", "job_id", J]]);
  });
  it("returns nothing for a job with no notes, and a failed read is an error, not an empty list", async () => {
    expect((await fetchDeliveryNotesFor(fakeDb([]), { jobId: J, jobNo: "J-0042" })).rows).toEqual([]);
    await expect(fetchDeliveryNotesFor(fakeDb([], "permission denied"), { jobId: J, jobNo: "J-0042" })).rejects.toThrow("permission denied");
  });
});

describe("fetchDeliveryNotesFor a customer", () => {
  it("lists notes linked by customer id and legacy hand-made notes that name the customer", async () => {
    const { rows } = await fetchDeliveryNotesFor(fakeDb([
      note("1", { customer_id: C, customer: "Acme Ltd" }),
      note("2", { customer: "Acme Ltd" }),
      note("3", { customer: "Other Ltd" }),
    ]), { customerId: C, customerName: "Acme Ltd" });
    expect(rows.map((r) => r.id).sort()).toEqual(["1", "2"]);
  });
  it("does not list a note linked to a different customer record that happens to share the name", async () => {
    const { rows } = await fetchDeliveryNotesFor(fakeDb([
      note("1", { customer_id: C }),
      note("2", { customer_id: C2, customer: "Acme Ltd" }),
    ]), { customerId: C, customerName: "Acme Ltd" });
    expect(rows.map((r) => r.id)).toEqual(["1"]);
  });
  it("asks for no notes at all when it has nothing to match on", async () => {
    const db = fakeDb([note("1", {})]);
    expect(await fetchDeliveryNotesFor(db, {})).toEqual({ rows: [], more: false });
    expect(db.calls).toHaveLength(0);
  });
});

describe("a long list says it was cut", () => {
  const many = (n: number, extra: Row) => Array.from({ length: n }, (_, i) => note(String(1000 + i), { delivery_date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, ...extra }));
  it(`shows at most ${DELIVERY_NOTE_LIST_LIMIT} and says there are more when there are`, async () => {
    expect(DELIVERY_NOTE_LIST_LIMIT).toBe(100);
    const { rows, more } = await fetchDeliveryNotesFor(fakeDb(many(101, { job_id: J })), { jobId: J });
    expect(rows).toHaveLength(100);
    expect(more).toBe(true);
  });
  it("exactly 100 is not 'more than 100'", async () => {
    const { rows, more } = await fetchDeliveryNotesFor(fakeDb(many(100, { job_id: J })), { jobId: J });
    expect(rows).toHaveLength(100);
    expect(more).toBe(false);
  });
  it("keyed and legacy notes together over 100 are cut to 100 and flagged", async () => {
    const { rows, more } = await fetchDeliveryNotesFor(fakeDb([...many(60, { customer_id: C }), ...many(60, { customer: "Acme Ltd" }).map((r, i) => ({ ...r, id: `L${i}` }))]), { customerId: C, customerName: "Acme Ltd" });
    expect(rows).toHaveLength(100);
    expect(more).toBe(true);
  });
});

describe("the list's links and roles", () => {
  it("links to the note's print page", () => {
    expect(deliveryNoteHref("abc")).toBe("/delivery-notes/abc/print");
  });
  it("shows a note without a number by a short label", async () => {
    const { rows: [row] }: { rows: NoteListRow[] } = await fetchDeliveryNotesFor(fakeDb([note("5", { id: "abcdef12-0000", dn_number: null, job_id: J })]), { jobId: J });
    expect(row.ref).toBe("DN-abcdef12");
  });
  it("is offered to admin, office and workshop, the roles that can read delivery notes, and not to a viewer", () => {
    expect(canListDeliveryNotes("admin")).toBe(true);
    expect(canListDeliveryNotes("office")).toBe(true);
    expect(canListDeliveryNotes("workshop")).toBe(true);
    expect(canListDeliveryNotes("viewer")).toBe(false);
    expect(canListDeliveryNotes(null)).toBe(false);
  });
});
