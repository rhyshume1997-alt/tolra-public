/**
 * Why the database-feature probes are GETs: with the real supabase-js client, a HEAD request for a missing table comes back as
 * "204, no error" (PostgREST sends no body on HEAD, and supabase-js reads a 404 with an empty body as an empty result), so a
 * head-only probe says "present" before the migration is applied. A GET carries PostgREST's error body (PGRST205), so it doesn't.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { featurePresent } from "@/lib/db-features";

const MISSING_TABLE = { code: "PGRST205", details: null, hint: null, message: "Could not find the table 'public.document_attachments' in the schema cache" };

/** A PostgREST stand-in that doesn't have the table: 404 with the JSON error on GET, 404 with no body on HEAD. */
function clientWithoutTable(methods: string[]) {
  const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    methods.push(method);
    if (method === "HEAD") return new Response(null, { status: 404 });
    return new Response(JSON.stringify(MISSING_TABLE), { status: 404, headers: { "content-type": "application/json" } });
  };
  return createClient("http://localhost:54321", "anon-key", { global: { fetch }, auth: { persistSession: false, autoRefreshToken: false } });
}

describe("feature probes against a database without the table", () => {
  it("a head-only probe would read a missing table as present (why it isn't used)", async () => {
    const methods: string[] = [];
    const result = await clientWithoutTable(methods).from("document_attachments").select("id", { count: "exact", head: true }).limit(1);
    expect(methods).toEqual(["HEAD"]);
    expect(result.error).toBeNull();
    expect(featurePresent(result)).toBe(true);
  });

  it("the GET probe reads it as not there yet", async () => {
    const methods: string[] = [];
    const result = await clientWithoutTable(methods).from("document_attachments").select("id").limit(1);
    expect(methods).toEqual(["GET"]);
    expect(result.error?.code).toBe("PGRST205");
    expect(featurePresent(result)).toBe(false);
  });

  it("no probe in lib/db-features.ts is head-only", () => {
    const source = readFileSync(path.join(process.cwd(), "lib/db-features.ts"), "utf8");
    expect(source).not.toMatch(/head:\s*true/);
  });
});

/** Migration 073's probe: a PostgREST stand-in whose invoices table has no invoice_note column (400 with the JSON error on GET). */
function clientWithoutColumn(methods: string[], error: { code: string; message: string }) {
  const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    methods.push(method);
    if (method === "HEAD") return new Response(null, { status: 400 });
    return new Response(JSON.stringify({ ...error, details: null, hint: null }), { status: 400, headers: { "content-type": "application/json" } });
  };
  return createClient("http://localhost:54321", "anon-key", { global: { fetch }, auth: { persistSession: false, autoRefreshToken: false } });
}

describe("the 073 probe against a database without invoices.invoice_note", () => {
  for (const error of [
    { code: "42703", message: "column invoices.invoice_note does not exist" },
    { code: "PGRST204", message: "Could not find the 'invoice_note' column of 'invoices' in the schema cache" },
  ]) {
    it(`a GET reads a missing column (${error.code}) as not there yet`, async () => {
      const methods: string[] = [];
      const result = await clientWithoutColumn(methods, error).from("invoices").select("invoice_note").limit(1);
      expect(methods).toEqual(["GET"]);
      expect(result.error?.code).toBe(error.code);
      expect(featurePresent(result)).toBe(false);
    });
  }

  it("the 073 probe in lib/db-features.ts asks for invoices.invoice_note with a GET", () => {
    const source = readFileSync(path.join(process.cwd(), "lib/db-features.ts"), "utf8");
    expect(source).toMatch(/from\("invoices"\)\.select\("invoice_note"\)\.limit\(1\)/);
  });
});
