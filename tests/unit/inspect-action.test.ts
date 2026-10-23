/**
 * G20: the two avoidable taps. The Job Board offers "Inspected" only to someone who may record an inspection (083's authorised inspectors
 * list, the rule the inspection dialog applies), and the phone machine sheet starts the job itself once a machine or the bench is ticked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  has083: true, member: null as { can_inspect: boolean } | null, user: "u1" as string | null, memberReads: 0,
  userError: null as Error | null, memberError: null as Error | null,
}));

vi.mock("@/lib/inspectors", () => ({ databaseHas083: async () => state.has083 }));
vi.mock("@/lib/supabase-business", () => ({ getCurrentOrganizationId: async () => "org1" }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    // Like supabase-js: a failed getUser (offline, network) resolves with no user and an error; a failed read resolves with data null and an error.
    auth: { getUser: async () => (state.userError ? { data: { user: null }, error: state.userError } : { data: { user: state.user ? { id: state.user } : null }, error: null }) },
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => { state.memberReads += 1; return state.memberError ? { data: null, error: state.memberError } : { data: state.member, error: null }; } }) }) }) }),
  },
}));

import { inspectedActionOffered, loadCanInspect, mayRecordInspection } from "@/lib/inspection";
import { pickIsChosen } from "@/lib/job-actions";

beforeEach(() => { state.has083 = true; state.member = null; state.user = "u1"; state.memberReads = 0; state.userError = null; state.memberError = null; });

/** What the Job Board does with loadCanInspect: a throw leaves the status unknown (null), never false. */
const boardStatus = (isAdmin: boolean) => loadCanInspect(isAdmin).then((may): boolean | null => may, () => null);

describe("who may record an inspection (the dialog's rule)", () => {
  it("from 083 only people on the list, admins included", () => {
    expect(mayRecordInspection(false, true, false)).toBe(false);
    expect(mayRecordInspection(true, true, false)).toBe(false);
    expect(mayRecordInspection(true, true, true)).toBe(true);
    expect(mayRecordInspection(false, true, true)).toBe(true);
  });
  it("before 083 an admin always may; others still need the flag", () => {
    expect(mayRecordInspection(true, false, false)).toBe(true);
    expect(mayRecordInspection(false, false, false)).toBe(false);
  });
});

describe("loadCanInspect", () => {
  it("a workshop person not on the list may not (one member read)", async () => {
    state.member = { can_inspect: false };
    expect(await loadCanInspect(false)).toBe(false);
    expect(state.memberReads).toBe(1);
  });
  it("a person on the list may", async () => {
    state.member = { can_inspect: true };
    expect(await loadCanInspect(false)).toBe(true);
  });
  it("an admin not on the list may not from 083, and may before it (no read)", async () => {
    state.member = { can_inspect: false };
    expect(await loadCanInspect(true)).toBe(false);
    state.has083 = false;
    state.memberReads = 0;
    expect(await loadCanInspect(true)).toBe(true);
    expect(state.memberReads).toBe(0);
  });
  it("a listed admin may from 083", async () => {
    state.member = { can_inspect: true };
    expect(await loadCanInspect(true)).toBe(true);
  });
  it("no signed-in person, or no member row: may not", async () => {
    state.user = null;
    expect(await loadCanInspect(false)).toBe(false);
    state.user = "u1";
    state.member = null;
    expect(await loadCanInspect(false)).toBe(false);
  });
  it("a failed getUser (offline or network) is not known, never false: the board keeps Inspected offered", async () => {
    state.member = { can_inspect: false };
    state.userError = new Error("Failed to fetch");
    await expect(loadCanInspect(false)).rejects.toThrow("Failed to fetch");
    expect(state.memberReads).toBe(0);
    expect(await boardStatus(false)).toBeNull();
    expect(inspectedActionOffered(await boardStatus(false))).toBe(true);
  });
  it("a failed member read is not known, never false (workshop and admin from 083)", async () => {
    state.memberError = new Error("Failed to fetch");
    await expect(loadCanInspect(false)).rejects.toThrow("Failed to fetch");
    await expect(loadCanInspect(true)).rejects.toThrow("Failed to fetch");
    expect(await boardStatus(false)).toBeNull();
    expect(inspectedActionOffered(await boardStatus(false))).toBe(true);
  });
  it("known answers stay known: no row (data null) or can_inspect off is false, on is true", async () => {
    state.member = null;
    expect(await boardStatus(false)).toBe(false);
    state.member = { can_inspect: false };
    expect(await boardStatus(false)).toBe(false);
    expect(inspectedActionOffered(await boardStatus(false))).toBe(false);
    state.member = { can_inspect: true };
    expect(await boardStatus(false)).toBe(true);
  });
  it("an admin before 083 may without any read, even while offline", async () => {
    state.has083 = false;
    state.userError = new Error("Failed to fetch");
    state.memberError = new Error("Failed to fetch");
    expect(await loadCanInspect(true)).toBe(true);
    expect(state.memberReads).toBe(0);
  });
  it("uses the person it is given without asking again", async () => {
    state.user = null;
    state.member = { can_inspect: true };
    expect(await loadCanInspect(false, "u2")).toBe(true);
  });
});

describe("the Inspected action on the board", () => {
  it("is hidden only when the person is known not to be an inspector", () => {
    expect(inspectedActionOffered(false)).toBe(false);
    expect(inspectedActionOffered(true)).toBe(true);
    expect(inspectedActionOffered(null)).toBe(true); // not known yet or offline: offered; the dialog and the database still decide
  });
});

describe("the phone sheet's Start", () => {
  it("needs a machine or the bench ticked, never a guessed default", () => {
    expect(pickIsChosen({ machines: [], bench: false })).toBe(false);
    expect(pickIsChosen({ machines: ["m1"], bench: false })).toBe(true);
    expect(pickIsChosen({ machines: ["m1", "m2"], bench: false })).toBe(true);
    expect(pickIsChosen({ machines: [], bench: true })).toBe(true);
  });
});
