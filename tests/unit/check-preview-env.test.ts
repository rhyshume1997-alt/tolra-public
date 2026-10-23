/** Preview isolation check (release validation): the preview may only reach the test project and send no e-mail. */
import { describe, expect, it } from "vitest";

import { parseEnv, previewChecks } from "../../scripts/check-preview-env.mjs";

const jwt = (ref: string) => `x.${Buffer.from(JSON.stringify({ ref, role: "anon" })).toString("base64url")}.y`;
const good = {
  NEXT_PUBLIC_SUPABASE_URL: "https://testrefaaaa.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt("testrefaaaa"),
  SUPABASE_SERVICE_ROLE_KEY: jwt("testrefaaaa"),
  EMAIL_RECIPIENT_DOMAINS: "example.test",
};
const failing = (env: Record<string, string>) => previewChecks(env, "testrefaaaa", ["prodrefbbbb", "legacyrefcc"]).filter((r: { ok: boolean }) => !r.ok).map((r: { check: string }) => r.check);

describe("check-preview-env", () => {
  it("a correctly isolated preview passes", () => {
    expect(failing(good)).toEqual([]);
  });

  it("refuses the production URL, a production key, a real mail key, a costing engine or demo mode", () => {
    expect(failing({ ...good, NEXT_PUBLIC_SUPABASE_URL: "https://prodrefbbbb.supabase.co" })).toHaveLength(2);
    expect(failing({ ...good, SUPABASE_SERVICE_ROLE_KEY: jwt("prodrefbbbb") })).toEqual(["SUPABASE_SERVICE_ROLE_KEY belongs to the test project"]);
    expect(failing({ ...good, RESEND_API_KEY: "re_live" })).toEqual(["RESEND_API_KEY is not set (job e-mails are saved as drafts, nothing is sent)"]);
    expect(failing({ ...good, EMAIL_RECIPIENT_DOMAINS: "realcustomer.co.uk" })).toHaveLength(1);
    expect(failing({ ...good, COSTING_ENGINE_URL: "https://engine.internal" })).toHaveLength(1);
    expect(failing({ ...good, NEXT_PUBLIC_DEMO_MODE: "true" })).toHaveLength(1);
    expect(failing({ ...good, NEXT_PUBLIC_SITE_URL: "https://app.realcompany.co.uk" })).toHaveLength(1);
    expect(failing({ ...good, NEXT_PUBLIC_SITE_URL: "https://tolra-git-claude-x.vercel.app" })).toEqual([]);
  });

  it("refuses when no protected refs or no test ref are given", () => {
    expect(previewChecks(good, "testrefaaaa", []).some((r: { ok: boolean }) => !r.ok)).toBe(true);
    expect(previewChecks(good, undefined, ["prodrefbbbb"]).some((r: { ok: boolean }) => !r.ok)).toBe(true);
  });

  it("an opaque key is MANUAL, never PASS: its ownership isn't proven by the file", () => {
    const results = previewChecks({ ...good, SUPABASE_SERVICE_ROLE_KEY: "sb_secret_opaque" }, "testrefaaaa", ["prodrefbbbb"]);
    const key = results.find((r: { check: string }) => r.check === "SUPABASE_SERVICE_ROLE_KEY belongs to the test project");
    expect(key).toMatchObject({ status: "manual", ok: false });
    expect(results.filter((r: { status: string }) => r.status === "fail")).toEqual([]);
  });

  it("084: a Preview integrations key is checked against Production's (MANUAL without the production file); no key, no line", () => {
    const check = "INTEGRATIONS_ENCRYPTION_KEY is not Production's";
    expect(previewChecks(good, "testrefaaaa", ["prodrefbbbb"]).some((r: { check: string }) => r.check === check)).toBe(false);
    const withKey = { ...good, INTEGRATIONS_ENCRYPTION_KEY: "cHJldmlldy1rZXk=" };
    expect(previewChecks(withKey, "testrefaaaa", ["prodrefbbbb"]).find((r: { check: string }) => r.check === check)).toMatchObject({ status: "manual" });
    expect(previewChecks(withKey, "testrefaaaa", ["prodrefbbbb"], { INTEGRATIONS_ENCRYPTION_KEY: "cHJvZC1rZXk=" }).find((r: { check: string }) => r.check === check)).toMatchObject({ status: "pass" });
    expect(previewChecks(withKey, "testrefaaaa", ["prodrefbbbb"], { INTEGRATIONS_ENCRYPTION_KEY: "cHJldmlldy1rZXk=" }).find((r: { check: string }) => r.check === check)).toMatchObject({ status: "fail" });
  });

  it("reads the format vercel env pull writes", () => {
    expect(parseEnv('# Created by Vercel CLI\nNEXT_PUBLIC_SUPABASE_URL="https://testrefaaaa.supabase.co"\nRESEND_API_KEY=""\n')).toEqual({ NEXT_PUBLIC_SUPABASE_URL: "https://testrefaaaa.supabase.co", RESEND_API_KEY: "" });
  });
});
