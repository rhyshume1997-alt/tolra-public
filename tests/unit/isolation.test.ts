import { describe, expect, it } from "vitest";

import { assertLocalKey, assertLoopbackUrl, IsolationError } from "../support/isolation";

const jwt = (claims: Record<string, unknown>) =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

describe("test isolation guard", () => {
  it("accepts only loopback backends", () => {
    expect(assertLoopbackUrl("X", "http://127.0.0.1:54321")).toBe("http://127.0.0.1:54321");
    expect(assertLoopbackUrl("X", "http://localhost:3001")).toBe("http://localhost:3001");
    expect(assertLoopbackUrl("X", "postgresql://postgres:postgres@127.0.0.1:54322/postgres")).toContain("127.0.0.1");
    expect(() => assertLoopbackUrl("X", "https://tolra.example.com")).toThrow(IsolationError);
    expect(() => assertLoopbackUrl("X", "postgresql://postgres:pw@db.example.com:5432/postgres")).toThrow(IsolationError);
    expect(() => assertLoopbackUrl("X", undefined)).toThrow(/not set/);
    expect(() => assertLoopbackUrl("X", "not a url")).toThrow(IsolationError);
  });

  it("refuses production project refs even when tunnelled through a loopback address", () => {
    expect(() => assertLoopbackUrl("X", "https://qngvemzbdsvtydkbplpo.supabase.co")).toThrow(/production project/);
    expect(() => assertLoopbackUrl("X", "http://127.0.0.1:8080/qtgqliczvyyrkibvxfqv")).toThrow(/production project/);
  });

  it("refuses hosted project keys and accepts local stack keys", () => {
    expect(() => assertLocalKey("K", jwt({ iss: "supabase", ref: "abcdefghijklmnopqrst", role: "service_role" }))).toThrow(/hosted project/);
    expect(assertLocalKey("K", jwt({ iss: "supabase-demo", role: "anon" }))).toContain(".");
    expect(() => assertLocalKey("K", "sb_secret_abc")).toThrow(IsolationError);
    expect(() => assertLocalKey("K", "")).toThrow(/not set/);
  });
});
