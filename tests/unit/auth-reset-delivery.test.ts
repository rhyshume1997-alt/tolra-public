import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let lookupMode: "ok" | "missing" | "db_error" = "ok";
let deliveryMode: "ok" | "error" | "throw" = "ok";

const adminStub = () => ({
  rpc: async () => ({ data: true, error: null }),
  from: () => {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "ilike", "limit"]) c[m] = () => c;
    c.maybeSingle = async () => {
      if (lookupMode === "db_error") return { data: null, error: { code: "08006", message: "db down" } };
      if (lookupMode === "missing") return { data: null, error: null };
      return { data: { email: "alex@example.test" }, error: null };
    };
    return c;
  },
});

vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => adminStub() }));
vi.mock("@supabase/supabase-js", async (original) => {
  const real = await original<typeof import("@supabase/supabase-js")>();
  return {
    ...real,
    createClient: () => ({
      auth: {
        resetPasswordForEmail: async () => {
          if (deliveryMode === "throw") throw new Error("SMTP socket hang up");
          if (deliveryMode === "error") return { error: { status: 502, message: "mail provider error" } };
          return { error: null };
        },
      },
    }),
  };
});

import { POST as reset } from "@/app/api/auth/reset/route";
import { RESET_UNAVAILABLE_MESSAGE } from "@/lib/server/password-reset";

const post = (identifier: string) =>
  new Request("https://app.test/api/auth/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-real-ip": "203.0.113.10" },
    body: JSON.stringify({ identifier }),
  });

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  lookupMode = "ok";
  deliveryMode = "ok";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("POST /api/auth/reset delivery failure handling (CR-028)", () => {
  it("returns 503 instead of 200 DONE when resetPasswordForEmail returns a delivery error", async () => {
    deliveryMode = "error";
    const res = await reset(post("alex@example.test"));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.json()).toEqual({ error: RESET_UNAVAILABLE_MESSAGE });
  });

  it("returns 503 instead of 200 DONE when resetPasswordForEmail throws", async () => {
    deliveryMode = "throw";
    const res = await reset(post("alex@example.test"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: RESET_UNAVAILABLE_MESSAGE });
  });

  it("returns 503 instead of 200 DONE when username lookup fails due to a DB outage", async () => {
    lookupMode = "db_error";
    const res = await reset(post("alex"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: RESET_UNAVAILABLE_MESSAGE });
  });

  it("still returns 200 DONE for an unknown username (preserving anti-enumeration)", async () => {
    lookupMode = "missing";
    const res = await reset(post("no_such_user"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("returns 200 DONE when delivery succeeds", async () => {
    const res = await reset(post("alex"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});
