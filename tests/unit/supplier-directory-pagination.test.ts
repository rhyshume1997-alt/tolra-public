// Exercises the supplier directory and the legacy schema fallback with capped API fixtures.
import { expect, it, vi } from "vitest";

import { fetchSuppliersFromSupabase } from "@/lib/supabase-business";

const supplierFetch = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock("@/lib/supabase", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  return { supabase: createClient("http://127.0.0.1:54321", "test-key", { global: { fetch: supplierFetch } }) };
});

it.each([true, false])("includes supplier 1,001 when status column is present: %s", async (hasStatus) => {
  supplierFetch.mockImplementation(async (input) => {
    const query = new URL(String(input)).searchParams;
    const withStatus = query.get("select")?.includes("supplier_status");
    if (!hasStatus && withStatus) {
      return Response.json({ code: "42703", message: "column suppliers.supplier_status does not exist" }, { status: 400 });
    }
    const offset = Number(query.get("offset") ?? 0);
    return Response.json(Array.from({ length: Math.min(1_000, 1_001 - offset) }, (_, index) => ({
      id: String(offset + index), name: `Supplier ${offset + index}`, email: null,
      ...(withStatus ? { supplier_status: "blocked" } : {}),
    })));
  });

  const suppliers = await fetchSuppliersFromSupabase();
  expect(suppliers).toHaveLength(1_001);
  expect(suppliers.at(-1)?.supplierStatus).toBe(hasStatus ? "blocked" : undefined);
});
