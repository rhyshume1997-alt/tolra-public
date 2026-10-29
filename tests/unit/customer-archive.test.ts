/** Archived customers (migration 100) leave the pickers for new documents: lib/customers withoutArchived / readArchivedCustomerIds. */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: null }));

import { CustomerSelectView, PICKER_LOAD_FAILED } from "@/components/customer-select";
import { loadPickerNames, pickerOptions, readArchivedCustomerIds, withoutArchived, type ArchivedCustomerReader } from "@/lib/customers";

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

  const answering = (answer: { data: unknown; error: unknown }) =>
    ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ range: async () => answer }) }) }) }) }) }) as unknown as ArchivedCustomerReader;

  it("a failed read throws (the picker then offers no customer), never an empty set", async () => {
    await expect(readArchivedCustomerIds(answering({ data: null, error: { message: "down" } }))).rejects.toBeTruthy();
  });

  it("no data and no error throws too: an unread archive list is never taken as 'nothing archived' (fail closed)", async () => {
    await expect(readArchivedCustomerIds(answering({ data: null, error: null }))).rejects.toThrow();
    await expect(readArchivedCustomerIds(answering({ data: undefined, error: null }))).rejects.toThrow();
  });

  it("an empty answer is a real 'nothing archived'", async () => {
    expect([...(await readArchivedCustomerIds(answering({ data: [], error: null })))]).toEqual([]);
  });

  it("end to end: when the archive list can't be read the picker gets no names, archived or not", async () => {
    const saved = [{ id: "a", name: "Acme Ltd", contactName: "", email: "", phone: "", address: "", notes: "" }, { id: "z", name: "Archived Co", contactName: "", email: "", phone: "", address: "", notes: "" }];
    const load = async () => withoutArchived(saved, await readArchivedCustomerIds(answering({ data: null, error: null })));
    expect(await loadPickerNames(load)).toEqual({ names: [], failed: true });
  });
});

describe("the picker fails closed (Q35)", () => {
  const view = (props: { failed: boolean; current?: string; names?: string[] }) => renderToStaticMarkup(createElement(CustomerSelectView, {
    name: "customer", current: props.current ?? "", names: props.names ?? ["Acme Ltd", "Beta Ltd"], failed: props.failed, onChoose: () => {}, onRetry: () => {},
  }));
  const options = (html: string) => [...html.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);

  it("a failed load gives no names, never the list it couldn't check", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadPickerNames(async () => { throw new Error("archive list down"); })).toEqual({ names: [], failed: true });
    quiet.mockRestore();
    expect(await loadPickerNames(async () => [{ name: "Acme Ltd", contactName: "", email: "", phone: "", address: "", notes: "" }])).toEqual({ names: ["Acme Ltd"], failed: false });
  });

  it("fetchPickerCustomers lets an archive read failure through (no fallback to every customer)", () => {
    // Line endings normalised, so the "\n}\n" slice also finds the function's end in a Windows (CRLF) checkout.
    const lib = readFileSync("lib/customers.ts", "utf8").replace(/\r\n/g, "\n");
    const start = lib.indexOf("export async function fetchPickerCustomers");
    const fn = lib.slice(start, lib.indexOf("\n}\n", start));
    expect(fn).toContain("await readArchivedCustomerIds(");
    expect(fn).not.toMatch(/\bcatch\b|return customers;/);
  });

  it("the failure state shows the error with Retry and offers no customer and no Add new", () => {
    const html = view({ failed: true });
    expect(options(html)).toEqual([""]);
    expect(html).toContain("Couldn&#x27;t load customers");
    expect(html).toContain('role="alert"');
    expect(html).toContain(PICKER_LOAD_FAILED.replace(/'/g, "&#x27;"));
    expect(html).toMatch(/<button type="button"[^>]*>Retry<\/button>/);
  });

  it("a document's own customer stays shown even when the load failed (existing documents stay readable)", () => {
    expect(options(view({ failed: true, current: "Old Archived Ltd" }))).toEqual(["", "Old Archived Ltd"]);
  });

  it("loaded: the names and Add new, no error", () => {
    const html = view({ failed: false });
    expect(options(html)).toEqual(["", "Acme Ltd", "Beta Ltd", "__add_new__"]);
    expect(html).not.toContain("Retry");
    expect(pickerOptions(["A"], "Z")).toEqual(["Z", "A"]);
    expect(pickerOptions(["A"], "A")).toEqual(["A"]);
  });
});
