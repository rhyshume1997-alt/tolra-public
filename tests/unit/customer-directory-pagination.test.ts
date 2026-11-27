// Exercises both customer directory reads against a response-capped API fixture.
import { createClient } from "@supabase/supabase-js";
import { expect, it } from "vitest";

import { readCustomers, withTraceableDefaults } from "@/lib/customers";

it("includes customer 1,001 and their traceability default", async () => {
  const rows = Array.from({ length: 1_001 }, (_, index) => ({
    id: String(index).padStart(4, "0"), name: `Customer ${index}`, mobile: "", traceable_default: index === 1_000,
  }));
  const client = createClient("http://127.0.0.1:54321", "test-key", {
    global: { fetch: async (input) => {
      const query = new URL(String(input)).searchParams;
      const offset = Number(query.get("offset") ?? 0);
      return Response.json(rows.slice(offset, offset + 1_000));
    } },
  });
  const customers = await readCustomers(client);
  expect(customers).toHaveLength(1_001);
  expect((await withTraceableDefaults(client, customers)).at(-1))
    .toMatchObject({ id: "1000", traceableDefault: true });
});
