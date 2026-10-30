/**
 * S5b: company switch mid-form. Two tabs share one Supabase session and switch_organization (036) moves THAT session's company. A
 * form opened in company A (JNR) and submitted after another tab switched to company B (Marpet) was saved into B: the inserts read the
 * company fresh at submit (getCurrentUserAndOrganization), and create_with_lines / create_job / next_doc_number take it from the
 * session; RLS passes, the person is a member of both. Now the page remembers the company it was opened for (lib/page-company.ts, set
 * by lib/use-user.ts) and every one of those paths refuses, with a clear message, when the session is in another company: nothing is
 * written, into either company.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const db = { session: "jnr" as string | null, calls: [] as string[], inserts: [] as Array<Record<string, unknown>> };
  const client = {
    rpc: vi.fn(async (fn: string) => {
      db.calls.push(fn);
      if (fn === "current_user_organization_id") return { data: db.session, error: null };
      if (fn === "next_doc_number") return { data: "QUO-0042", error: null };
      return { data: null, error: null };
    }),
    from: vi.fn(() => ({
      insert: (payload: Record<string, unknown>) => {
        db.calls.push("insert");
        db.inserts.push(payload);
        return { select: () => ({ single: async () => ({ data: { name: payload.name, email: payload.email }, error: null }) }) };
      },
    })),
  };
  return { db, client };
});
vi.mock("@/lib/supabase", () => ({ supabase: h.client, isSupabaseConfigured: true }));
vi.mock("@/lib/confirmed-user", () => ({
  CONFIRMED_USER_REUSE_MS: 10_000,
  confirmedUser: async () => ({ data: { user: { id: "user-1" } }, error: null }),
}));

import { friendlyError } from "@/lib/friendly-error";
import { allocateNumber } from "@/lib/numbering";
import { COMPANY_CHANGED_MESSAGE, CompanyChangedError, assertPageCompany, confirmPageCompany, setPageCompany } from "@/lib/page-company";
import { getCurrentOrganizationId, getCurrentUserAndOrganization, saveSupplierToSupabase } from "@/lib/supabase-business";

const root = path.resolve(__dirname, "../..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");

beforeEach(() => {
  h.db.session = "jnr";
  h.db.calls = [];
  h.db.inserts = [];
  setPageCompany(null);
});
afterEach(() => setPageCompany(null));

describe("the page's company against the session's", () => {
  it("passes when no company is recorded (not loaded yet, the chooser) and when the session is still in the page's company", () => {
    expect(() => assertPageCompany("marpet")).not.toThrow();
    setPageCompany("jnr");
    expect(() => assertPageCompany("jnr")).not.toThrow();
  });

  it("refuses, with the clear message and its hint, when the session is now in another company or in none", () => {
    setPageCompany("jnr");
    expect(() => assertPageCompany("marpet")).toThrow(CompanyChangedError);
    expect(() => assertPageCompany(null)).toThrow(COMPANY_CHANGED_MESSAGE);
    const err = (() => { try { assertPageCompany("marpet"); } catch (e) { return e; } })();
    expect(err).toMatchObject({ name: "CompanyChangedError", code: "company_changed", hint: "company_changed" });
    // The screens show it through friendlyError (e.g. "Couldn't create the job."): the person sees why, not a generic failure.
    expect(friendlyError(err, "Couldn't create the job.")).toBe(COMPANY_CHANGED_MESSAGE);
  });
});

describe("a form opened in JNR, submitted after another tab switched the session to Marpet", () => {
  it("getCurrentUserAndOrganization (every direct insert: customers, suppliers, POs, quotes, settings) refuses instead of answering Marpet", async () => {
    setPageCompany("jnr");
    h.db.session = "marpet";
    await expect(getCurrentUserAndOrganization()).rejects.toThrow(COMPANY_CHANGED_MESSAGE);
    await expect(getCurrentOrganizationId()).rejects.toBeInstanceOf(CompanyChangedError);
  });

  it("a supplier save writes nothing into either company", async () => {
    setPageCompany("jnr");
    h.db.session = "marpet";
    await expect(saveSupplierToSupabase({ name: "Steel Co", email: "steel@example.test" })).rejects.toBeInstanceOf(CompanyChangedError);
    expect(h.db.inserts).toEqual([]);
  });

  it("the same save, in the company the page was opened for, still goes through with that company", async () => {
    setPageCompany("jnr");
    await saveSupplierToSupabase({ name: "Steel Co", email: "steel@example.test" });
    expect(h.db.inserts).toHaveLength(1);
    expect(h.db.inserts[0].organization_id).toBe("jnr");
  });

  it("a document number (quote, PO, sales order, job) is not taken from Marpet's series", async () => {
    setPageCompany("jnr");
    h.db.session = "marpet";
    await expect(allocateNumber("QUO")).rejects.toBeInstanceOf(CompanyChangedError);
    expect(h.db.calls).toEqual(["current_user_organization_id"]);
    h.db.session = "jnr";
    await expect(allocateNumber("QUO")).resolves.toBe("QUO-0042");
  });

  it("confirmPageCompany (before create_with_lines / create_job) refuses on a different company, passes on the same, and asks nothing with no page company", async () => {
    setPageCompany("jnr");
    h.db.session = "marpet";
    await expect(confirmPageCompany(h.client)).rejects.toBeInstanceOf(CompanyChangedError);
    h.db.session = "jnr";
    await expect(confirmPageCompany(h.client)).resolves.toBeUndefined();
    setPageCompany(null);
    h.db.calls = [];
    await expect(confirmPageCompany(h.client)).resolves.toBeUndefined();
    expect(h.db.calls).toEqual([]);
  });
});

describe("wiring", () => {
  it("the user provider records the company the page loaded under, online and offline", () => {
    const userSource = source("lib/use-user.ts");
    expect(userSource).toContain("setPageCompany(nextProfile.organization_id);");
    expect(userSource).toContain("setPageCompany(cachedProfile.organization_id);");
  });

  // The writes the database files in the session's company by itself: each asks first, before its RPC.
  for (const [file, rpc] of [
    ["app/(dashboard)/invoices/page.tsx", 'supabase.rpc("create_with_lines", {\n          p_parent: "invoices"'],
    ["app/(dashboard)/delivery-notes/page.tsx", 'supabase.rpc("next_doc_number", { p_prefix: "DLN" })'],
    ["components/new-job-dialog.tsx", 'supabase.rpc("create_job"'],
  ] as const) {
    it(`${file} confirms the page's company before ${rpc.split("(")[0]}`, () => {
      const text = source(file);
      const call = text.indexOf(rpc);
      expect(call).toBeGreaterThan(0);
      const check = text.lastIndexOf("await confirmPageCompany(supabase);", call);
      expect(check).toBeGreaterThan(0);
      // The check is in the same submit, a few lines above the call (not some other function's).
      expect(text.slice(check, call).split("\n").length).toBeLessThan(15);
    });
  }
});
