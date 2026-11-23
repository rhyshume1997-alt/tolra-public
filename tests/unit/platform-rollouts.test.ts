/**
 * Rollout catalogue, input checks, parsing and refusal wording (lib/platform/rollouts.ts). Proves: only the six existing "<name>:on" markers are
 * listed, each equal to the marker exported by the module that owns that switch; the list equals the list hard-coded in release 167's functions
 * (so the app and the database cannot drift); switches that are not plain markers (Sales Orders, Xero, portal, sign-off) are absent; a request needs
 * a listed switch, an on/off boolean and 1 to 200 distinct company ids; unknown keys are refused; parsing keeps only well-formed rows and only listed
 * markers; refusals get fixed wording with no database message.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { TOOLY_TOUR_ON_MARKER } from "@/components/tooly/tour/tour-switch";
import { ISO_TEMPLATES_ON_MARKER } from "@/lib/iso/iso-switch";
import { NCR_REGISTER_ON_MARKER } from "@/lib/jobs/ncr-register-switch";
import { JOB_TIME_VARIANCE_ON_MARKER } from "@/lib/jobs/planned-vs-actual-switch";
import { checkRolloutInput, parseRolloutOverview, parseRolloutResult, ROLLOUT_MARKERS, ROLLOUT_SWITCHES, rolloutRefusal, switchLabel } from "@/lib/platform/rollouts";
import { REPORTS_ON_MARKER } from "@/lib/reports/reports-switch";
import { REVENUE_ON_MARKER } from "@/lib/reports/revenue/revenue-switch";

const root = path.resolve(__dirname, "../..");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ok = { switchMarker: "reports:on", organizationIds: [A], on: true, phase: "Phase 1" };

describe("the switches that can be rolled out", () => {
  it("are exactly the six existing markers, each the same text as the module that owns it", () => {
    expect([...ROLLOUT_MARKERS].sort()).toEqual([REPORTS_ON_MARKER, REVENUE_ON_MARKER, ISO_TEMPLATES_ON_MARKER, JOB_TIME_VARIANCE_ON_MARKER, NCR_REGISTER_ON_MARKER, TOOLY_TOUR_ON_MARKER].sort());
    expect(ROLLOUT_MARKERS).toHaveLength(6);
    for (const s of ROLLOUT_SWITCHES) { expect(s.marker).toMatch(/^[a-z-]+:on$/); expect(s.label.length).toBeGreaterThan(0); }
  });
  it("match the six markers hard-coded in release 167's functions (apply and overview)", () => {
    const sql = readFileSync(path.join(root, "supabase/proposals/p167_roadmap_rollouts.sql"), "utf8");
    const lists = [...sql.matchAll(/ARRAY\[((?:'[a-z:-]+:on',? ?)+)\]/g)].map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
    expect(lists).toHaveLength(2);
    for (const list of lists) expect([...list].sort()).toEqual([...ROLLOUT_MARKERS].sort());
  });
  it("leave out switches that are not plain markers", () => {
    for (const m of ["sales-orders:on", "xero_transfer_hold", "customer_signoff_enabled", "portal", "hidden:reports"]) expect(ROLLOUT_MARKERS).not.toContain(m);
  });
  it("label a marker, and fall back to the marker itself", () => {
    expect(switchLabel("reports:on")).toBe("Reports");
    expect(switchLabel("other:on")).toBe("other:on");
  });
});

describe("checkRolloutInput", () => {
  it("accepts a listed switch for 1 to 200 distinct companies, on or off, and trims the phase", () => {
    expect(checkRolloutInput({ ...ok, phase: "  Phase 1 " })).toEqual({ ok: true, value: { switchMarker: "reports:on", organizationIds: [A], on: true, phase: "Phase 1" } });
    expect(checkRolloutInput({ switchMarker: "job-ncr-register:on", organizationIds: [A, B.toUpperCase()], on: false })).toEqual({ ok: true, value: { switchMarker: "job-ncr-register:on", organizationIds: [A, B], on: false, phase: "" } });
    const many = Array.from({ length: 200 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(checkRolloutInput({ ...ok, organizationIds: many }).ok).toBe(true);
  });
  it("refuses an unlisted switch, a missing or non-boolean on, no companies, too many, duplicates, bad ids, a long phase and unknown keys", () => {
    expect(checkRolloutInput({ ...ok, switchMarker: "sales-orders:on" }).ok).toBe(false);
    expect(checkRolloutInput({ ...ok, switchMarker: 5 }).ok).toBe(false);
    expect(checkRolloutInput({ ...ok, on: "true" }).ok).toBe(false);
    expect(checkRolloutInput({ switchMarker: "reports:on", organizationIds: [A] }).ok).toBe(false);
    expect(checkRolloutInput({ ...ok, organizationIds: [] }).ok).toBe(false);
    expect(checkRolloutInput({ ...ok, organizationIds: "all" }).ok).toBe(false);
    expect(checkRolloutInput({ ...ok, organizationIds: Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`) }).ok).toBe(false);
    expect(checkRolloutInput({ ...ok, organizationIds: [A, A] }).ok).toBe(false);
    expect(checkRolloutInput({ ...ok, organizationIds: ["nope"] }).ok).toBe(false);
    expect(checkRolloutInput({ ...ok, phase: "x".repeat(61) }).ok).toBe(false);
    expect(checkRolloutInput({ ...ok, phase: 4 }).ok).toBe(false);
    expect(checkRolloutInput({ ...ok, actor: "someone" }).ok).toBe(false);
    for (const v of [null, undefined, "x", 3, [], {}]) expect(checkRolloutInput(v).ok, String(v)).toBe(false);
  });
});

describe("parsing and refusal wording", () => {
  it("keeps well-formed companies and log rows, and only listed markers in a company's on list", () => {
    const parsed = parseRolloutOverview({
      companies: [{ organization_id: A, name: "JNR", slug: "jnr", status: "active", on: ["reports:on", "sales-orders:on", "x"] }, { organization_id: 1 }, null],
      log: [{ id: B, created_at: "2026-11-22T10:00:00Z", actor_email: "o@example.test", switch: "reports:on", turned_on: true, phase: "Phase 1", org_names: ["JNR"], changed: 1 }, { id: "bad" }],
    });
    expect(parsed?.companies).toEqual([{ organizationId: A, name: "JNR", slug: "jnr", status: "active", on: ["reports:on"] }]);
    expect(parsed?.log).toEqual([{ id: B, createdAt: "2026-11-22T10:00:00Z", actorEmail: "o@example.test", switchMarker: "reports:on", turnedOn: true, phase: "Phase 1", orgNames: ["JNR"], changed: 1 }]);
    expect(parseRolloutOverview(null)).toBeNull();
    expect(parseRolloutOverview({ companies: [] })).toBeNull();
  });
  it("parses the apply answer or returns null", () => {
    expect(parseRolloutResult({ log_id: A, switch: "reports:on", turned_on: false, requested: 2, changed: 1, changed_org_ids: [] })).toEqual({ logId: A, switchMarker: "reports:on", turnedOn: false, requested: 2, changed: 1 });
    expect(parseRolloutResult({ log_id: A })).toBeNull();
    expect(parseRolloutResult("x")).toBeNull();
  });
  it("gives fixed wording and never a database message", () => {
    expect(rolloutRefusal({ code: "22023", hint: "unknown_switch" }).status).toBe(400);
    expect(rolloutRefusal({ code: "22023", hint: "company_not_active" }).status).toBe(409);
    expect(rolloutRefusal({ code: "22023" }).status).toBe(400);
    expect(rolloutRefusal({ code: "P0002" }).status).toBe(404);
    expect(rolloutRefusal({ code: "42501" })).toEqual({ status: 403, error: "Forbidden" });
    expect(rolloutRefusal({ code: "XX000" }).status).toBe(500);
    expect(rolloutRefusal(undefined).error).toContain("Nothing was changed");
    expect(JSON.stringify(rolloutRefusal({ code: "XX000", hint: "secret detail" }))).not.toContain("secret");
  });
});
