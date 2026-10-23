/**
 * Admin > Data: a column mapping is saved per company on confirm (lib/import-mappings.ts; table import_mappings, migration 076) and read
 * back for the next file with the same headers.
 */
import { describe, expect, it } from "vitest";

import { type ParsedSheet, planSheet } from "@/lib/import-detect";
import { type MappingClient, loadMappings, mappingRows, mappingsStore, saveMappings } from "@/lib/import-mappings";
import { chooseTarget, headerSignature } from "@/lib/import-detect";

const sheet: ParsedSheet = { name: "Invoices", headers: ["Invoice No", "Customer", "Total", "Odd One"], rows: [["INV-1", "A", 1, "x"]], rowNumbers: [2] };

function fakeClient(rows: unknown, fail = false) {
  const calls: { rows: Record<string, unknown>[]; onConflict: string }[] = [];
  const client: MappingClient = {
    from: () => ({
      select: async () => (fail ? { data: null, error: { message: "boom" } } : { data: rows, error: null }),
      upsert: async (list, options) => { calls.push({ rows: list, onConflict: options.onConflict }); return { error: fail ? { message: "refused" } : null }; },
    }),
  };
  return { client, calls };
}

describe("mappings are saved on confirm", () => {
  it("saves a layout where the admin chose a field, once per company, kind and layout (an upsert on that key)", async () => {
    const [plan] = await planSheet(sheet, []);
    const chosen = chooseTarget(plan, 3, "description");
    const { client, calls } = fakeClient([]);
    const out = await saveMappings(client, [chosen, chosen], "org-1");
    expect(out).toEqual({ saved: 1, error: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].onConflict).toBe("organization_id,kind,header_signature");
    expect(calls[0].rows[0]).toMatchObject({
      organization_id: "org-1", kind: "invoices", header_signature: chosen.signature,
      mapping: { "invoice no": "invoice_ref", customer: "customer", total: "total", "odd one": "description" },
    });
    expect(String(calls[0].rows[0].header_signature)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("saves nothing when everything was recognised (nothing was chosen)", async () => {
    const [plan] = await planSheet(sheet, []);
    expect(mappingRows([plan], "org-1")).toEqual([]);
    const { client, calls } = fakeClient([]);
    expect(await saveMappings(client, [plan], "org-1")).toEqual({ saved: 0, error: null });
    expect(calls).toHaveLength(0);
  });

  it("a refused save is reported, not thrown (the import is already done)", async () => {
    const [plan] = await planSheet(sheet, []);
    const { client } = fakeClient([], true);
    expect(await saveMappings(client, [chooseTarget(plan, 3, "description")], "org-1")).toEqual({ saved: 0, error: "refused" });
  });

  it("the saved mapping is used for the next file with the same headers", async () => {
    const [first] = await planSheet(sheet, []);
    const chosen = chooseTarget(first, 3, "description");
    const [row] = mappingRows([chosen], "org-1");
    const saved = await loadMappings(fakeClient([{ kind: row.kind, header_signature: row.header_signature, mapping: row.mapping }]).client);
    const [again] = await planSheet({ ...sheet, headers: ["ODD ONE", "total", "customer", "Invoice no"], rows: [["x", 1, "A", "INV-1"]] }, saved);
    expect(again.kindSource).toBe("saved");
    expect(again.columns.map((c) => [c.header, c.target])).toEqual([["ODD ONE", "description"], ["total", "total"], ["customer", "customer"], ["Invoice no", "invoice_ref"]]);
  });
});

describe("loading", () => {
  it("keeps well-formed rows only, and is empty when the table can't be read", async () => {
    const good = { kind: "customers", header_signature: "s", mapping: { name: "name", junk: 5 } };
    const loaded = await loadMappings(fakeClient([good, { kind: "bogus", header_signature: "s", mapping: {} }, { kind: "jobs", header_signature: 3, mapping: {} }, { kind: "jobs", header_signature: "t", mapping: [] }]).client);
    expect(loaded).toEqual([{ kind: "customers", header_signature: "s", mapping: { name: "name", junk: "" } }]);
    expect(await loadMappings(fakeClient(null, true).client)).toEqual([]);
  });
});

describe("a file planned straight after the page opens still gets the saved mappings", () => {
  const headers = ["Ref", "Who", "Gross"];
  const upload: ParsedSheet = { name: "Sheet1", headers, rows: [["INV-1", "A", 5]], rowNumbers: [2] };

  function slowClient(rows: unknown[], delayMs: number): { client: MappingClient; selects: () => number } {
    let n = 0;
    return {
      selects: () => n,
      client: {
        from: () => ({
          select: () => { n += 1; return new Promise((resolve) => setTimeout(() => resolve({ data: rows, error: null }), delayMs)); },
          upsert: async () => ({ error: null }),
        }),
      },
    };
  }

  it("planning waits for the load in progress: the saved mapping decides the sheet", async () => {
    const signature = await headerSignature(headers);
    const { client, selects } = slowClient([{ kind: "invoices", header_signature: signature, mapping: { ref: "invoice_ref", who: "customer", gross: "total" } }], 80);
    const store = mappingsStore(client);
    void store.refresh(); // the page's effect: the load has started and not finished
    // The upload comes at once, before the answer: planning is given the answer, not an empty list.
    const [plan] = await planSheet(upload, await store.ready());
    expect(plan.kindSource).toBe("saved");
    expect(plan.kind).toBe("invoices");
    expect(selects()).toBe(1); // the one load, not another
  });

  it("planned without waiting (what the page used to do), the same sheet has no saved mapping", async () => {
    const [plan] = await planSheet(upload, []);
    expect(plan.kindSource).not.toBe("saved");
  });

  it("ready() starts the load if nothing has; refresh() loads again after a save; no client is no mappings", async () => {
    const { client, selects } = slowClient([], 1);
    const store = mappingsStore(client);
    await store.ready();
    await store.ready();
    expect(selects()).toBe(1);
    await store.refresh();
    expect(selects()).toBe(2);
    expect(await mappingsStore(null).ready()).toEqual([]);
  });
});
