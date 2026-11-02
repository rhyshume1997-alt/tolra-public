/**
 * The AI section: the master on/off switch's mapping (on = every feature on, off = every feature off, in between = "Some features on"),
 * the finance check's missing-column fallback, the sidebar rule for the AI item, and the two cards rendered for admin and office.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AiCustomisedCard } from "@/components/ai-helper/customised-card";
import { AiMasterCard } from "@/components/ai-helper/master-card";
import { type AiHelperStatus, featureStates } from "@/components/ai-helper/use-ai-helper-status";
import { companyFinanceCheckEnabled, financeCheckAllowed, readCompanyFinanceCheck } from "@/lib/ai/finance-check/flag";
import { aiNavAvailable, canOpenDestination } from "@/lib/destinations";
import { type AiFeatureStates, applyMaster, availableFeatures, masterLabel, masterState, settingsBody } from "@/lib/ai-helper/master-switch";

const states = (roundup: boolean, rfq: boolean, financeCheck: boolean | null, assistant: boolean | null = null): AiFeatureStates => ({ roundup, rfq, financeCheck, assistant });

describe("master switch mapping", () => {
  it("all three on -> on; none on -> off; anything between -> partial, labelled \"Some features on\"", () => {
    expect(masterState(states(true, true, true))).toBe("on");
    expect(masterState(states(false, false, false))).toBe("off");
    for (const partial of [states(true, false, false), states(false, true, false), states(false, false, true), states(true, true, false), states(true, false, true), states(false, true, true)]) {
      expect(masterState(partial)).toBe("partial");
    }
    expect(masterLabel("on")).toBe("AI is on");
    expect(masterLabel("off")).toBe("AI is off");
    expect(masterLabel("partial")).toBe("Some features on");
  });

  it("turning the master on writes every feature on; off writes every feature off", () => {
    expect(applyMaster(states(false, true, false), true)).toEqual(states(true, true, true));
    expect(applyMaster(states(true, true, true), false)).toEqual(states(false, false, false));
    expect(applyMaster(states(true, false, true), true)).toEqual(states(true, true, true));
  });

  it("a finance check the database can't hold yet (null) is left out of the sum and never written", () => {
    expect(availableFeatures(states(true, true, null))).toEqual(["roundup", "rfq"]);
    expect(masterState(states(true, true, null))).toBe("on");
    expect(masterState(states(false, false, null))).toBe("off");
    expect(masterState(states(true, false, null))).toBe("partial");
    expect(applyMaster(states(false, false, null), true)).toEqual(states(true, true, null));
    expect(settingsBody(states(true, true, null), 500)).toEqual({ roundupEnabled: true, rfqEnabled: true, monthlyCapPence: 500 });
    expect(settingsBody(states(true, false, true), 500)).toEqual({ roundupEnabled: true, rfqEnabled: false, financeCheckEnabled: true, monthlyCapPence: 500 });
  });

  it("the status becomes the three states; a missing finance column reads as not available", () => {
    const base: AiHelperStatus = { roundup_enabled: true, rfq_enabled: false, monthly_cap_pence: 500, key_set: true, key_last4: "WXYZ", month_spent_pence: 0, month_reserved_pence: 0, can_manage: true };
    expect(featureStates(base)).toEqual(states(true, false, null));
    expect(featureStates({ ...base, finance_check_available: true, finance_check_enabled: true })).toEqual(states(true, false, true));
    expect(featureStates({ ...base, finance_check_available: true })).toEqual(states(true, false, false));
  });
});

type Reply = { data: Record<string, unknown> | null; error: { code?: string } | null };
const dbReturning = (reply: Reply, seen: { table?: string; cols?: string; org?: string } = {}) => ({
  from: (table: string) => ({ select: (cols: string) => ({ eq: (_c: string, org: string) => ({ maybeSingle: async () => { Object.assign(seen, { table, cols, org }); return reply; } }) }) }),
}) as unknown as Parameters<typeof readCompanyFinanceCheck>[0];

describe("the finance check's per-company switch (column-missing fallback)", () => {
  it("reads finance_check_enabled from this company's ai_helper_settings row", async () => {
    const seen: { table?: string; cols?: string; org?: string } = {};
    expect(await readCompanyFinanceCheck(dbReturning({ data: { finance_check_enabled: true }, error: null }, seen), "o-1")).toEqual({ available: true, enabled: true });
    expect(seen).toEqual({ table: "ai_helper_settings", cols: "finance_check_enabled", org: "o-1" });
    expect(await readCompanyFinanceCheck(dbReturning({ data: { finance_check_enabled: false }, error: null }), "o-1")).toEqual({ available: true, enabled: false });
  });

  it("no settings row, a null or odd value: off", async () => {
    expect(await readCompanyFinanceCheck(dbReturning({ data: null, error: null }), "o-1")).toEqual({ available: true, enabled: false });
    expect(await readCompanyFinanceCheck(dbReturning({ data: { finance_check_enabled: null }, error: null }), "o-1")).toEqual({ available: true, enabled: false });
    expect(await readCompanyFinanceCheck(dbReturning({ data: { finance_check_enabled: "true" }, error: null }), "o-1")).toEqual({ available: true, enabled: false });
  });

  it("a database without the column (42703, or any error): not available and off", async () => {
    for (const code of ["42703", "PGRST204", "42501", undefined]) {
      expect(await readCompanyFinanceCheck(dbReturning({ data: null, error: { code } }), "o-1")).toEqual({ available: false, enabled: false });
      expect(await companyFinanceCheckEnabled(dbReturning({ data: null, error: { code } }), "o-1")).toBe(false);
    }
  });

  it("needs both switches: the server's env var AND the company's", async () => {
    const on = dbReturning({ data: { finance_check_enabled: true }, error: null });
    expect(await financeCheckAllowed(on, "o-1", { AI_FINANCE_CHECK_ENABLED: "true" })).toBe(true);
    expect(await financeCheckAllowed(on, "o-1", { AI_FINANCE_CHECK_ENABLED: "TRUE" })).toBe(false);
    expect(await financeCheckAllowed(on, "o-1", {})).toBe(false);
    expect(await financeCheckAllowed(dbReturning({ data: { finance_check_enabled: false }, error: null }), "o-1", { AI_FINANCE_CHECK_ENABLED: "true" })).toBe(false);
    expect(await financeCheckAllowed(dbReturning({ data: null, error: { code: "42703" } }), "o-1", { AI_FINANCE_CHECK_ENABLED: "true" })).toBe(false);
  });
});

describe("the AI item in the menu", () => {
  it("is for office and admin views only, and only while the server has AI_HELPER_ENABLED on", () => {
    const access = (activeRole: "admin" | "office" | "workshop" | "viewer") => ({ activeRole, hiddenSections: [] as string[] });
    expect(canOpenDestination("/ai-helper", access("admin"))).toBe(true);
    expect(canOpenDestination("/ai-helper", access("office"))).toBe(true);
    expect(canOpenDestination("/ai-helper", access("workshop"))).toBe(false);
    expect(canOpenDestination("/ai-helper", access("viewer"))).toBe(false);
    expect(aiNavAvailable("/ai-helper", true)).toBe(true);
    expect(aiNavAvailable("/ai-helper", false)).toBe(false);
    expect(aiNavAvailable("/quotes", false)).toBe(true);
  });
});

const status = (over: Partial<AiHelperStatus> = {}): AiHelperStatus => ({
  roundup_enabled: true, rfq_enabled: true, monthly_cap_pence: 500, key_set: true, key_last4: "WXYZ", month_spent_pence: 120, month_reserved_pence: 0, can_manage: true,
  finance_check_available: true, finance_check_enabled: true, ...over,
});
const master = (s: AiHelperStatus) => renderToStaticMarkup(createElement(AiMasterCard, { status: s, onStatus: () => {} }));
const customised = (s: AiHelperStatus) => renderToStaticMarkup(createElement(AiCustomisedCard, { status: s, onStatus: () => {} }));

describe("the master card", () => {
  it("shows the state in words and ticks the master only when every feature is on", () => {
    const on = master(status());
    expect(on).toContain("AI is on");
    expect(on).toMatch(/aria-label="AI on for this company"[^>]*checked/);
    const off = master(status({ roundup_enabled: false, rfq_enabled: false, finance_check_enabled: false }));
    expect(off).toContain("AI is off");
    expect(off).not.toMatch(/aria-label="AI on for this company"[^>]*checked/);
    const partial = master(status({ rfq_enabled: false }));
    expect(partial).toContain("Some features on");
    expect(partial).not.toMatch(/aria-label="AI on for this company"[^>]*checked/);
  });

  it("an admin can change the switches; office sees the same state read-only", () => {
    expect(master(status())).not.toContain("disabled");
    const office = master(status({ can_manage: false }));
    expect(office).toContain("AI is on");
    expect(office).toContain("Only an admin can change these switches.");
    expect(office.match(/disabled/g)?.length).toBe(4);
  });

  it("without the finance column that feature is disabled and says so; the master counts the other two", () => {
    const html = master(status({ finance_check_available: false, finance_check_enabled: false }));
    expect(html).toContain("Not available yet");
    expect(html).toContain("AI is on");
  });

  it("warns that nothing runs until a cap and a key are set", () => {
    expect(master(status({ key_set: false }))).toContain("Nothing runs until");
    expect(master(status({ monthly_cap_pence: 0 }))).toContain("Nothing runs until");
    expect(master(status())).not.toContain("Nothing runs until");
    expect(master(status({ key_set: false, roundup_enabled: false, rfq_enabled: false, finance_check_enabled: false }))).not.toContain("Nothing runs until");
  });
});

describe("how it is customised", () => {
  it("everyone sees the summary; only an admin sees the limit and key controls, and the key's last four", () => {
    const admin = customised(status());
    expect(admin).toContain("API key set (ending WXYZ)");
    expect(admin).toContain("£5.00 (used this month: £1.20)");
    expect(admin).toContain("Office and admin");
    expect(admin).toContain("Save monthly limit");
    expect(admin).toContain("Anthropic API key");
    const office = customised(status({ can_manage: false, key_last4: null }));
    expect(office).toContain("API key set");
    expect(office).not.toContain("ending");
    expect(office).not.toContain("Save monthly limit");
    expect(office).not.toContain("Save key");
    expect(customised(status({ key_set: false }))).toContain("No API key set");
  });
});
