/** Archived customers (migration 097) leave the pickers for new documents: lib/customers withoutArchived / readArchivedCustomerIds. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: null }));

import { readArchivedCustomerIds, withoutArchived, type ArchivedCustomerReader } from "@/lib/customers";

describe("withoutArchived", () => {
  it("drops archived saved customers and keeps the rest in order (and any without an id)", () => {
    const list = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { name: "C" }, { id: "d", name: "D" }];
    expect(withoutArchived(list, new Set(["b", "d"])).map((c) => c.name)).toEqual(["A", "C"]);
    expect(withoutArchived(list, new Set())).toEqual(list);
  });
});

describe("readArchivedCustomerIds", () => {
  it("reads only customers' archived choices, page by page", async () => {
    const calls: string[] = [];
    const client: ArchivedCustomerReader = {
      from: (table) => ({
        select: (columns) => ({
          eq: (c1, v1) => ({
            eq: (c2, v2) => ({
              order: () => ({
                range: async (from: number) => {
                  calls.push(`${table} ${columns} ${c1}=${v1} ${c2}=${v2} ${from}`);
                  return { data: from === 0 ? [{ record_id: "x" }, { record_id: "y" }] : [], error: null };
                },
              }),
            }),
          }),
        }),
      }),
    };
    expect([...(await readArchivedCustomerIds(client))]).toEqual(["x", "y"]);
    expect(calls[0]).toBe("record_archive_state record_id record_table=customers state=archived 0");
  });

  it("a failed read throws (the picker then offers every saved customer)", async () => {
    const client = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ range: async () => ({ data: null, error: { message: "down" } }) }) }) }) }) }) } as unknown as ArchivedCustomerReader;
    await expect(readArchivedCustomerIds(client)).rejects.toBeTruthy();
  });
});
