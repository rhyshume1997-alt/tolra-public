// @vitest-environment jsdom
/**
 * Module J: Company details still load and save exactly as before, and a save never drops or rolls back the document template choices stored in the
 * same company_profile (the choices are kept from the stored row). The other open tab is told through localStorage (lib/company-sync) and refreshes
 * its copy, which still carries the new details and the choices.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ row: null as null | { organization_id: string; company_profile: Record<string, unknown> }, upserts: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => {
        const q = { eq: () => q, maybeSingle: async () => ({ data: table === "organization_settings" ? db.row : null, error: null }) };
        return q;
      },
      upsert: async (value: Record<string, unknown>) => { db.upserts.push(value); db.row = { organization_id: String(value.organization_id), company_profile: value.company_profile as Record<string, unknown> }; return { error: null }; },
    }),
    storage: { from: () => ({ download: async () => ({ data: null, error: { message: "no logo" } }) }) },
  },
}));

import { COMPANY_CHANGED_KEY, listenForTabSignals } from "@/lib/company-sync";
import { loadCompanyProfile, parseCompanyProfile, saveCompanyProfile, storedProfile } from "@/lib/company";

const BASE = { name: "Acme Ltd", documentName: "Acme Ltd", addressLines: ["1 Road", "Town"], vatRegistered: false };
const CHOICES = { enabled: true, colour: true, quote: [{ design: "modern", from: "2026-12-01T09:00:00.000Z" }] };

beforeEach(() => { db.row = null; db.upserts = []; window.localStorage.clear(); });

describe("Company details load", () => {
  it("loads with or without stored document templates, and a company that never chose has none", async () => {
    db.row = { organization_id: "org-1", company_profile: { ...BASE } };
    const plain = await loadCompanyProfile(true);
    expect(plain?.name).toBe("Acme Ltd");
    expect(plain?.documentTemplates).toBeUndefined();
    db.row = { organization_id: "org-1", company_profile: { ...BASE, documentTemplates: CHOICES } };
    const chosen = await loadCompanyProfile(true);
    expect(chosen?.documentTemplates).toEqual(CHOICES);
  });
  it("an incomplete profile still reads as not set up (unchanged)", () => {
    expect(parseCompanyProfile({ documentTemplates: CHOICES })).toBeNull();
  });
});

describe("Company details save", () => {
  it("saves the new details, keeps the stored template choices (even if this form's copy is stale), and reloads", async () => {
    db.row = { organization_id: "org-1", company_profile: { ...BASE, documentTemplates: CHOICES, printLayout: "basic" } };
    const loaded = (await loadCompanyProfile(true))!;
    // The form was opened before another admin changed the choices: its copy is stale.
    const stale = { ...storedProfile(loaded), documentTemplates: { enabled: false } };
    await saveCompanyProfile("org-1", { ...stale, name: "Renamed Ltd", documentName: "Renamed Ltd" });
    const written = db.upserts.at(-1)!.company_profile as Record<string, unknown>;
    expect(written.name).toBe("Renamed Ltd");
    expect(written.documentTemplates).toEqual(CHOICES);
    expect(written.printLayout).toBe("basic");
    expect((await loadCompanyProfile())?.name).toBe("Renamed Ltd");
  });
  it("a company with no choices stored gets none written", async () => {
    db.row = { organization_id: "org-1", company_profile: { ...BASE } };
    const loaded = (await loadCompanyProfile(true))!;
    await saveCompanyProfile("org-1", { ...storedProfile(loaded), name: "Renamed Ltd", documentName: "Renamed Ltd" });
    expect(Object.keys(db.upserts.at(-1)!.company_profile as object)).not.toContain("documentTemplates");
  });
});

describe("the other tab", () => {
  it("is told through localStorage when details are saved, asks to refresh its company copy, and the refreshed copy has the new details and the choices", async () => {
    db.row = { organization_id: "org-1", company_profile: { ...BASE, documentTemplates: CHOICES } };
    const loaded = (await loadCompanyProfile(true))!;
    const signals: string[] = [];
    // The storage event fires in the OTHER tab only; deliver it to a listener the way the browser would.
    const stop = listenForTabSignals(window, { userId: () => "user-1", skip: () => false, onSignal: (s) => signals.push(s) });
    const before = window.localStorage.getItem(COMPANY_CHANGED_KEY);
    await saveCompanyProfile("org-1", { ...storedProfile(loaded), name: "Renamed Ltd", documentName: "Renamed Ltd" });
    const after = window.localStorage.getItem(COMPANY_CHANGED_KEY);
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    window.dispatchEvent(new StorageEvent("storage", { key: COMPANY_CHANGED_KEY, newValue: after }));
    expect(signals).toEqual(["refresh-company"]);
    const refreshed = await loadCompanyProfile(true);
    expect(refreshed?.name).toBe("Renamed Ltd");
    expect(refreshed?.documentTemplates).toEqual(CHOICES);
    stop();
  });
});
