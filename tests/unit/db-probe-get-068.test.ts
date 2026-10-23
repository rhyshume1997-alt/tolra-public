/**
 * The 068 probe (databaseHas068) asks for a column, quote_line_items.declined, that only 068 adds. With the real supabase-js client
 * against a PostgREST stand-in without that column: a GET carries PostgREST's error body (400, 42703 or PGRST204), so the probe reads
 * "not there yet"; a HEAD carries no body, so supabase-js gives an error with no code (or none at all) and a head-only probe could
 * never say "not yet". That is why the probe is a GET (tests/unit/db-probe-get.test.ts guards that no probe is head-only).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { featurePresent } from "@/lib/db-features";

const UNDEFINED_COLUMN = { code: "42703", details: null, hint: null, message: "column quote_line_items.declined does not exist" };
const SCHEMA_CACHE = { code: "PGRST204", details: null, hint: null, message: "Could not find the 'declined' column of 'quote_line_items' in the schema cache" };

/** A PostgREST stand-in whose quote_line_items has no declined column: 400 with the JSON error on GET, 400 with no body on HEAD. */
function clientWithoutColumn(methods: string[], body: object, headStatus = 400) {
  const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    methods.push(method);
    if (method === "HEAD") return new Response(null, { status: headStatus });
    return new Response(JSON.stringify(body), { status: 400, headers: { "content-type": "application/json" } });
  };
  return createClient("http://localhost:54321", "anon-key", { global: { fetch }, auth: { persistSession: false, autoRefreshToken: false } });
}

describe("the 068 probe against a database without quote_line_items.declined", () => {
  for (const [name, body] of [["42703 (undefined column)", UNDEFINED_COLUMN], ["PGRST204 (schema cache)", SCHEMA_CACHE]] as const) {
    it(`GET, as databaseHas068 asks: ${name} reads as not there yet`, async () => {
      const methods: string[] = [];
      const result = await clientWithoutColumn(methods, body).from("quote_line_items").select("declined").limit(1);
      expect(methods).toEqual(["GET"]);
      expect(result.error?.code).toBe(body.code);
      expect(featurePresent(result)).toBe(false);
    });
  }

  it("HEAD (head-only) can't say 'not yet': the 400 has no body, so there is no code to read", async () => {
    const methods: string[] = [];
    const result = await clientWithoutColumn(methods, UNDEFINED_COLUMN).from("quote_line_items").select("declined", { count: "exact", head: true }).limit(1);
    expect(methods).toEqual(["HEAD"]);
    expect(result.error?.code ?? "").toBe("");
    // No answer (null) or "present" (true): either way databaseHas068 would have shown 068's features before 068 is applied.
    expect(featurePresent(result)).not.toBe(false);
  });

  it("databaseHas068 asks with a GET of the declined column", () => {
    const source = readFileSync(path.join(process.cwd(), "lib/db-features.ts"), "utf8");
    expect(source).toMatch(/from\("quote_line_items"\)\.select\("declined"\)\.limit\(1\)/);
  });
});
