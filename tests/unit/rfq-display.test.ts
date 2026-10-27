/** RFQ card display definition: the card's field order comes from the one list in lib/rfq-display.ts. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: null }));

import { COLUMN_TABLES } from "@/lib/org-settings";
import { RFQ_CARD_FIELDS, RFQ_DISPLAY_KEY, rfqCardFields, rfqPickerColumns } from "@/lib/rfq-display";

const keys = (fields: { key: string }[]) => fields.map((field) => field.key);
const page = readFileSync(path.resolve(__dirname, "../../app/(dashboard)/rfq/page.tsx"), "utf8");

describe("RFQ card display definition", () => {
  it("lists the fields in the order the card shows them, all on by default, customer and actions locked", () => {
    expect(keys(RFQ_CARD_FIELDS)).toEqual(["customer", "status", "stage", "description", "value", "received", "actions"]);
    expect(keys(rfqCardFields())).toEqual(keys(RFQ_CARD_FIELDS));
    expect(RFQ_CARD_FIELDS.filter((field) => field.locked).map((field) => field.key)).toEqual(["customer", "actions"]);
  });

  it("hiding a field removes only that field and keeps the defined order; locked fields cannot be hidden", () => {
    expect(keys(rfqCardFields(["description"]))).toEqual(["customer", "status", "stage", "value", "received", "actions"]);
    expect(keys(rfqCardFields(["customer", "actions", "value", "stage"]))).toEqual(["customer", "status", "description", "received", "actions"]);
  });

  it("the Columns picker and Settings list the whole definition under the rfq key, locked fields included (ticked, disabled)", () => {
    const entry = COLUMN_TABLES.find((def) => def.key === RFQ_DISPLAY_KEY)!;
    expect(RFQ_DISPLAY_KEY).toBe("rfq");
    expect(keys(entry.columns)).toEqual(keys(RFQ_CARD_FIELDS));
    expect(entry.columns.filter((column) => column.locked).map((column) => column.key)).toEqual(["customer", "actions"]);
    expect(rfqPickerColumns().map((column) => column.key)).toEqual(["status", "stage", "description", "value", "received"]);
  });

  it("groups never interleave, so rendering by group keeps the defined order", () => {
    const order = ["title", "body", "meta"];
    const idx = RFQ_CARD_FIELDS.map((field) => order.indexOf(field.group));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it("the RFQ page renders its card from rfqCardFields and has the Columns button", () => {
    expect(page).toContain("rfqCardFields(hiddenFields)");
    expect(page).toContain('<ColumnToggle tableKey={RFQ_DISPLAY_KEY} />');
  });
});
