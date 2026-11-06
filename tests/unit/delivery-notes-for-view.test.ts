/**
 * The delivery-notes list on the job card and the customer page gates itself by role (a viewer gets nothing, whoever renders it),
 * and says "more than 100" when the list was cut.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const role = vi.hoisted(() => ({ value: "office" as string | null }));
vi.mock("@/lib/use-user", () => ({ useUser: () => ({ activeRole: role.value }) }));
vi.mock("@/lib/supabase", () => ({ supabase: null }));

import { DeliveryNotesFor, DeliveryNotesForList } from "@/components/delivery-notes-for";

const query = { customerId: "22222222-2222-4222-8222-222222222222", customerName: "Acme Ltd" };

describe("DeliveryNotesFor is role-gated itself", () => {
  beforeEach(() => { role.value = "office"; });
  it.each(["admin", "office", "workshop"])("renders the fold-out for %s", (r) => {
    role.value = r;
    expect(renderToStaticMarkup(createElement(DeliveryNotesFor, { query }))).toContain('data-testid="delivery-notes-for"');
  });
  it.each(["viewer", null, "accountant"])("renders nothing for %s", (r) => {
    role.value = r;
    expect(renderToStaticMarkup(createElement(DeliveryNotesFor, { query }))).toBe("");
  });
});

describe("DeliveryNotesForList", () => {
  const rows = [{ id: "a", ref: "DLN-0001", status: "awaiting", date: "2026-10-20" }];
  it("says there are more than 100 when the list was cut", () => {
    const html = renderToStaticMarkup(createElement(DeliveryNotesForList, { rows, more: true }));
    expect(html).toContain('data-testid="delivery-notes-more"');
    expect(html).toContain("More than 100 delivery notes: showing the latest 100.");
  });
  it("says nothing extra when the list is whole", () => {
    expect(renderToStaticMarkup(createElement(DeliveryNotesForList, { rows, more: false }))).not.toContain("delivery-notes-more");
  });
});
