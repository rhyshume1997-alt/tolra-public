/** A job's and a customer's delivery notes (read-only list on the job and customer pages): which rows, in what order, who sees it. */
import { describe, expect, it } from "vitest";

import { canListDeliveryNotes, deliveryNoteHref, fetchDeliveryNotesFor, type NoteListRow } from "@/lib/delivery-notes-for";

type Row = Record<string, unknown>;
const J = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";

/** A stand-in for the signed-in client: the rows filtered by eq(), as row security would leave them (the other company's row is never returned). */
function fakeDb(rows: Row[], failWith?: string) {
  const calls: Array<Array<[string, unknown]>> = [];
  return {
    calls,
    from: (table: string) => {
      expect(table).toBe("delivery_notes");
      const filters: Array<[string, unknown]> = [];
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => { filters.push([column, value]); return builder; },
        order: () => builder,
        limit: () => builder,
        then: (resolve: (value: { data: unknown; error: unknown }) => unknown) => {
          calls.push(filters);
          if (failWith) return Promise.resolve({ data: null, error: { message: failWith } }).then(resolve);
          return Promise.resolve({ data: rows.filter((r) => filters.every(([c, v]) => r[c] === v)), error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

const note = (id: string, extra: Row): Row => ({ id, dn_number: `DLN-000${id}`, status: "despatched", delivery_date: "2026-10-20", customer: "Acme Ltd", job_ref: null, job_id: null, customer_id: null, ...extra });

describe("fetchDeliveryNotesFor a job", () => {
  it("lists notes linked by job id and hand-made notes that name the job, each once, newest first", async () => {
    const db = fakeDb([
      note("1", { job_id: J, job_ref: "J-0042", delivery_date: "2026-10-01" }),
      note("2", { job_ref: "J-0042", delivery_date: "2026-10-09" }),
      note("3", { job_id: J, delivery_date: "2026-10-05" }),
      note("4", { job_ref: "J-0099" }),
    ]);
    const rows = await fetchDeliveryNotesFor(db, { jobId: J, jobNo: "J-0042" });
    expect(rows.map((r) => r.ref)).toEqual(["DLN-0002", "DLN-0003", "DLN-0001"]);
  });
  it("returns nothing for a job with no notes, and a failed read is an error, not an empty list", async () => {
    expect(await fetchDeliveryNotesFor(fakeDb([]), { jobId: J, jobNo: "J-0042" })).toEqual([]);
    await expect(fetchDeliveryNotesFor(fakeDb([], "permission denied"), { jobId: J, jobNo: "J-0042" })).rejects.toThrow("permission denied");
  });
});

describe("fetchDeliveryNotesFor a customer", () => {
  it("lists notes linked by customer id and hand-made notes that name the customer", async () => {
    const rows = await fetchDeliveryNotesFor(fakeDb([
      note("1", { customer_id: C, customer: "Acme Ltd" }),
      note("2", { customer: "Acme Ltd" }),
      note("3", { customer: "Other Ltd" }),
    ]), { customerId: C, customerName: "Acme Ltd" });
    expect(rows.map((r) => r.id).sort()).toEqual(["1", "2"]);
  });
  it("asks for no notes at all when it has nothing to match on", async () => {
    const db = fakeDb([note("1", {})]);
    expect(await fetchDeliveryNotesFor(db, {})).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });
});

describe("the list's links and roles", () => {
  it("links to the note's print page", () => {
    expect(deliveryNoteHref("abc")).toBe("/delivery-notes/abc/print");
  });
  it("shows a note without a number by a short label", async () => {
    const [row]: NoteListRow[] = await fetchDeliveryNotesFor(fakeDb([note("5", { id: "abcdef12-0000", dn_number: null, job_id: J })]), { jobId: J });
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
