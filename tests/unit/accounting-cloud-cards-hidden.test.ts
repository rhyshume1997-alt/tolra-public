// Boundary: Sage and QuickBooks cards are unmounted. Asserts no card, no status fetch, and that file-export rows remain. Adapter/card source stays (hidden, not deleted).
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@/lib/use-user", () => ({ useUser: () => ({ profile: { id: "u", organization_id: "o" } }) }));
vi.mock("@/lib/supabase", () => ({ supabase: null }));
import { AccountingCloudCards } from "@/components/integrations/accounting-cloud-cards";
import { accountingStatuses } from "@/lib/integrations/accounting-status";

it("renders no Sage or QuickBooks card and makes no /api/accounting status fetch", () => {
  const f = vi.fn(async () => Response.json({}));
  vi.stubGlobal("fetch", f);
  const html = renderToStaticMarkup(createElement(AccountingCloudCards));
  expect(html).not.toMatch(/sage|quickbooks/i);
  expect(html).not.toMatch(/Connect to|Not connected|Loading connection/);
  expect(f).not.toHaveBeenCalled();
  const src = readFileSync("components/integrations/accounting-cloud-cards.tsx", "utf8");
  expect(src).not.toMatch(/<AccountingCloudCard\s+provider=/);
  vi.unstubAllGlobals();
});
it("file-export row remains in the accounting status table; adapter code is kept, not deleted", () => {
  const rows = accountingStatuses({ configured: true, overview: null, enabled: null, last: null, lastReadOk: true });
  expect(rows.find((r) => r.id === "file-export")).toMatchObject({ readiness: "File export only, no live link" });
  expect(readFileSync("lib/accounting/cloud-adapters.ts", "utf8")).toMatch(/sage/i);
  expect(readFileSync("components/integrations/accounting-cloud-cards.tsx", "utf8")).toContain("function AccountingCloudCard(");
});
