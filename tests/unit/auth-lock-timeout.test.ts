import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { AUTH_OPTIONS } from "@/lib/supabase";

/**
 * supabase-js 2.105 passes `lockAcquireTimeout: undefined` to auth-js unless the app sets it, and that overwrites
 * auth-js's default of 5000 ms. With no timeout, a waiter for the shared auth Web Lock never gives up and never takes
 * the orphaned lock, so one stuck tab silences every query in the others (the invoice "Loading payments…" hang).
 * The behaviour itself needs a real browser (tests/e2e/invoice-payments-lock.spec.ts); this pins the setting.
 */
describe("auth lock acquire timeout", () => {
  it("the app's client options give auth-js a real timeout", () => {
    expect(AUTH_OPTIONS.lockAcquireTimeout).toBeGreaterThan(0);
    const client = createClient("http://127.0.0.1:1", "anon-key", { auth: { ...AUTH_OPTIONS, persistSession: false, autoRefreshToken: false } });
    expect((client.auth as unknown as { lockAcquireTimeout: unknown }).lockAcquireTimeout).toBe(AUTH_OPTIONS.lockAcquireTimeout);
  });
});
