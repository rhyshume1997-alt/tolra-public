/**
 * E6 (ISO 9001 item): two people saving the same customer. Both open it, the first saves, the second saves the copy they opened:
 * before E6 the second save silently wrote over the first (and a rename raced the customer being put on a document). Now a customer
 * read with its version (customers.updated_at, moved by the database on every change) is saved only if the row still has that
 * version; otherwise nothing is written and the person is told someone else changed it. A rename of a customer that is in use is
 * still refused by the database (082's guard) with its own message.
 *
 * The fake database below keeps one customers row, moves updated_at on every change (037's touch_updated_at) and applies the
 * update's filters as PostgREST does: a filter that matches no row changes nothing and returns no row.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: null }));
vi.mock("@/lib/supabase-business", () => ({ getCurrentOrganizationId: async () => "org-1" }));

import { CUSTOMER_CHANGED, type CustomerReader, type CustomerRecord, type CustomerWriter, readCustomers, saveCustomer } from "@/lib/customers";
import { friendlyError } from "@/lib/friendly-error";

type Row = Record<string, unknown> & { id: string; name: string; updated_at: string };

function fakeDatabase(start: Row, opts: { inUse?: boolean } = {}) {
  let row: Row = { ...start };
  let tick = 0;
  const writes: Array<Record<string, unknown>> = [];
  const result = (data: unknown, error: unknown = null) => Promise.resolve({ data, error } as { data: unknown; error: { code?: string; message?: string; hint?: string } | null });
  const reader: CustomerReader = { from: () => ({ select: () => ({ order: () => Promise.resolve({ data: [{ ...row }], error: null }) }) }) };
  const writer: CustomerWriter = {
    from: () => ({
      insert: (values) => ({ select: () => ({ single: () => result({ ...values, id: "new-1", updated_at: "2026-10-30T09:00:00+00:00" }), maybeSingle: () => result(null) }) }),
      update: (values) => {
        const filters: Array<[string, string]> = [];
        const run = (one: boolean) => {
          const matches = filters.every(([column, value]) => String(row[column]) === value);
          if (!matches) return result(null, one ? { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } : null);
          if (opts.inUse && String(values.name).trim().toLowerCase() !== row.name.trim().toLowerCase()) {
            return result(null, { code: "22023", hint: "customer_in_use", message: `${row.name} is on 2 documents (quotes, RFQs, orders, jobs, delivery notes, invoices or credit notes) and can't be renamed: those records keep its name.` });
          }
          writes.push(values);
          tick += 1;
          row = { ...row, ...values, updated_at: `2026-10-30T10:00:0${tick}.123456+00:00` };
          return result({ ...row });
        };
        const selected = { select: () => ({ single: () => run(true), maybeSingle: () => run(false) }) };
        const second = { ...selected, eq: (column: string, value: string) => { filters.push([column, value]); return selected; } };
        return { eq: (column: string, value: string) => { filters.push([column, value]); return second; } };
      },
    }),
  };
  return { reader, writer, writes, row: () => row };
}

const START: Row = { id: "c1", name: "Acme Ltd", contact_name: "Ann", email: "ann@acme.example", phone: null, address: null, notes: null, updated_at: "2026-10-30T08:00:00.654321+00:00" };

describe("saving a customer two people have open (E6)", () => {
  it("reads each customer with its version", async () => {
    const db = fakeDatabase(START);
    const [customer] = await readCustomers(db.reader, false);
    expect(customer.updatedAt).toBe(START.updated_at);
  });

  it("refuses the second of two saves made from the same read, and keeps the first person's change", async () => {
    const db = fakeDatabase(START);
    const [opened] = await readCustomers(db.reader, false);
    const mine: CustomerRecord = { ...opened, contactName: "Bob" };
    const theirs: CustomerRecord = { ...opened, email: "orders@acme.example" };

    const first = await saveCustomer(mine, db.writer);
    expect(first.contactName).toBe("Bob");
    expect(first.updatedAt).not.toBe(START.updated_at);

    await expect(saveCustomer(theirs, db.writer)).rejects.toThrow(CUSTOMER_CHANGED);
    expect(db.writes).toHaveLength(1);
    expect(db.row()).toMatchObject({ contact_name: "Bob", email: "ann@acme.example" });
  });

  it("refuses a rename from a stale read, so it never lands on top of a change made in between", async () => {
    const db = fakeDatabase(START);
    const [opened] = await readCustomers(db.reader, false);
    await saveCustomer({ ...opened, notes: "Pays by BACS" }, db.writer);
    await expect(saveCustomer({ ...opened, name: "Acme Group Ltd" }, db.writer)).rejects.toThrow(CUSTOMER_CHANGED);
    expect(db.row().name).toBe("Acme Ltd");
  });

  it("saves again once the customer is read afresh", async () => {
    const db = fakeDatabase(START);
    const [opened] = await readCustomers(db.reader, false);
    await saveCustomer({ ...opened, contactName: "Bob" }, db.writer);
    const [fresh] = await readCustomers(db.reader, false);
    const saved = await saveCustomer({ ...fresh, email: "orders@acme.example" }, db.writer);
    expect(saved).toMatchObject({ contactName: "Bob", email: "orders@acme.example" });
  });

  it("a rename of a customer in use is refused by the database, with its own message (not the conflict one)", async () => {
    const db = fakeDatabase(START, { inUse: true });
    const [opened] = await readCustomers(db.reader, false);
    const err = await saveCustomer({ ...opened, name: "Acme Group Ltd" }, db.writer).catch((e: unknown) => e);
    expect(err).toMatchObject({ hint: "customer_in_use" });
    expect(friendlyError(err, "Could not save customer")).toMatch(/can't be renamed/);
    expect(friendlyError(err, "Could not save customer")).not.toBe(CUSTOMER_CHANGED);
    expect(db.writes).toHaveLength(0);
    // Other details of a customer in use still save.
    expect((await saveCustomer({ ...opened, phone: "01482 000000" }, db.writer)).phone).toBe("01482 000000");
  });

  it("a record read without a version (and a new customer) saves as before, without the check", async () => {
    const db = fakeDatabase(START);
    const { updatedAt: _ignored, ...unversioned } = (await readCustomers(db.reader, false))[0];
    void _ignored;
    await saveCustomer({ ...unversioned, contactName: "Bob" }, db.writer);
    expect((await saveCustomer({ ...unversioned, contactName: "Cat" }, db.writer)).contactName).toBe("Cat");
    expect((await saveCustomer({ name: "New Co", contactName: "", email: "", phone: "", address: "", notes: "" }, db.writer)).id).toBe("new-1");
  });
});
