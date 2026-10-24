/**
 * Render-level Columns check: the Customers page rendered (react-dom/server, the repo's unit render setup) with a hidden set
 * applied. Its header row and its first body row must have the same number of cells, the locked Name column and Actions must be
 * there, and a crafted hidden set naming the locked column must not hide it.
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  hidden: [] as string[],
  rows: [] as unknown[],
  seeded: { rows: false, loading: false },
}));

vi.mock("@/lib/supabase", () => ({ supabase: null }));
vi.mock("@/lib/use-user", () => ({ useUser: () => ({ hasAnyRole: () => true }) }));
vi.mock("@/components/role-gate", () => ({ RoleGate: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/lib/use-database-has-073", () => ({ useDatabaseHas073: () => true }));
// The page reads its hidden set through useColumnVisibility; the real pure columnVisibility (locked columns enforced) decides.
vi.mock("@/lib/org-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/org-settings")>();
  return {
    ...actual,
    useColumnVisibility: (tableKey: string) => ({
      isVisible: actual.columnVisibility(tableKey, h.hidden),
      isLocked: (key: string) => actual.isColumnLocked(tableKey, key),
      setColumnVisible: async () => ({ localOnly: false, denied: false }),
      hidden: h.hidden,
      localOnly: false,
    }),
  };
});
// Server rendering runs no effects, so the page's first list state ([] customers, loading true) is seeded with loaded rows.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useState = ((initial: unknown) => {
    if (!h.seeded.rows && Array.isArray(initial) && initial.length === 0) { h.seeded.rows = true; return actual.useState(h.rows); }
    if (!h.seeded.loading && initial === true) { h.seeded.loading = true; return actual.useState(false); }
    return actual.useState(initial);
  }) as typeof actual.useState;
  return { ...actual, default: { ...actual, useState }, useState };
});

import CustomersPage from "@/app/(dashboard)/customers/page";
import { columnScopeText } from "@/components/column-toggle";

const customer = { id: "c1", name: "Acme Ltd", contactName: "Jo", email: "jo@acme.test", phone: "0100", address: "1 High St", notes: "" };

function render(hidden: string[]) {
  h.hidden = hidden;
  h.rows = [customer];
  h.seeded = { rows: false, loading: false };
  const markup = renderToStaticMarkup(createElement(CustomersPage));
  const table = markup.slice(markup.indexOf("<table"), markup.indexOf("</table>"));
  const head = table.slice(table.indexOf("<thead"), table.indexOf("</thead>"));
  const body = table.slice(table.indexOf("<tbody"));
  const firstRow = body.slice(body.indexOf("<tr"), body.indexOf("</tr>"));
  const heads = [...head.matchAll(/<th[\s>][^]*?>([^<]*)<\/th>/g)].map((match) => match[1]);
  const cells = (firstRow.match(/<td[\s>]/g) ?? []).length;
  const cellLabels = [...firstRow.matchAll(/<td[^>]*?(?:data-label="([^"]*)"|data-actions)[^>]*>/g)].map((match) => match[1] ?? "Actions");
  return { heads, cells, firstRow, cellLabels };
}

describe("columns render: header and cells stay in step with a hidden set", () => {
  beforeEach(() => { h.hidden = []; });

  it("all columns shown: one header per cell, Name first, Actions last", () => {
    const { heads, cells, firstRow, cellLabels } = render([]);
    expect(heads).toEqual(["Name", "Contact", "Email", "Phone", "Address", "Actions"]);
    expect(cells).toBe(heads.length);
    expect(cellLabels).toEqual(heads);
    expect(firstRow).toContain("Acme Ltd");
  });

  it("Phone and Address hidden: both header and row drop them; counts match", () => {
    const { heads, cells, firstRow, cellLabels } = render(["phone", "address"]);
    expect(heads).toEqual(["Name", "Contact", "Email", "Actions"]);
    expect(cells).toBe(heads.length);
    expect(cellLabels).toEqual(heads);
    expect(firstRow).not.toContain("1 High St");
  });

  it("every optional column hidden: exactly the locked Name then Actions, in that order, in header and row", () => {
    const { heads, cellLabels, firstRow } = render(["contact", "email", "phone", "address"]);
    expect(heads).toEqual(["Name", "Actions"]);
    expect(cellLabels).toEqual(["Name", "Actions"]);
    expect(firstRow).not.toContain("jo@acme.test");
  });

  it("the picker says who a change reaches", () => {
    expect(columnScopeText(false)).toBe("Changes apply to everyone in this company.");
    expect(columnScopeText(true)).toContain("this browser only");
  });

  it("a crafted set hiding the locked Name column (and everything else) still shows Name and Actions", () => {
    const { heads, cells, firstRow, cellLabels } = render(["name", "contact", "email", "phone", "address"]);
    expect(heads).toEqual(["Name", "Actions"]);
    expect(cells).toBe(heads.length);
    expect(cellLabels).toEqual(["Name", "Actions"]);
    expect(firstRow).toContain("Acme Ltd");
  });
});
