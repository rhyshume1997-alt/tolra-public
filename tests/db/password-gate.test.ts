/**
 * Temporary-password sessions and session revocation (audit B0a: SEC3, SEC7), against the real Auth + REST.
 */
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedBackend } from "../support/isolation";
import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity } from "../support/fixtures";

const BUSINESS = ["customers", "quotes", "jobs", "invoices", "machines", "suppliers"];
let world: SyntheticWorld;

const fresh = () => {
  const { apiUrl, anonKey } = isolatedBackend();
  return createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
};

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("temporary password: no business access until the person chooses their own", () => {
  beforeAll(async () => {
    const admin = adminClient();
    for (const table of ["customers", "suppliers", "machines"]) {
      const { error } = await admin.from(table).insert({ organization_id: world.tenants.alpha.id, name: `${table} probe` });
      if (error) throw new Error(error.message);
    }
    await admin.from("jobs").insert({ organization_id: world.tenants.alpha.id, job_no: "J-GATE", customer: "Probe" });
  });

  it("refuses REST reads, writes and RPCs for a flagged session and restores them once cleared", async () => {
    const admin = adminClient();
    const user = world.tenants.alpha.users.admin;
    const orgId = world.tenants.alpha.id;
    expect((await admin.from("user_profiles").update({ must_change_password: true }).eq("id", user.id)).error).toBeNull();

    const flagged = await signedInClient(user);
    const own = await flagged.from("user_profiles").select("id, must_change_password").eq("id", user.id).single();
    expect(own.data).toEqual({ id: user.id, must_change_password: true }); // set-up can still read its own state
    expect((await flagged.rpc("current_user_organization_id")).data).toBeNull();
    expect((await flagged.rpc("has_org_role", { allowed_roles: ["admin"] })).data).toBe(false);
    for (const table of BUSINESS) {
      const { data } = await flagged.from(table).select("id");
      expect({ table, rows: data?.length ?? 0 }).toEqual({ table, rows: 0 });
    }
    expect((await flagged.from("customers").insert({ organization_id: orgId, name: "Flagged write" })).error).not.toBeNull();
    expect((await flagged.from("organization_settings").select("organization_id")).data ?? []).toEqual([]);
    const members = await flagged.rpc("org_members");
    expect(members.error ? [] : members.data ?? []).toEqual([]);
    // The flag itself can't be cleared from the browser.
    await flagged.from("user_profiles").update({ must_change_password: false }).eq("id", user.id);
    expect((await admin.from("user_profiles").select("must_change_password").eq("id", user.id).single()).data?.must_change_password).toBe(true);

    expect((await admin.from("user_profiles").update({ must_change_password: false }).eq("id", user.id)).error).toBeNull();
    const cleared = await signedInClient(user);
    expect((await cleared.rpc("current_user_organization_id")).data).toBe(orgId);
    expect(((await cleared.from("customers").select("id")).data ?? []).length).toBeGreaterThan(0);
  });
});

describe("password changes and existing sessions (provider behaviour, verified)", () => {
  it("own change keeps the current session and revokes the others; admin set revokes all", async () => {
    const user = world.tenants.beta.users.office;
    const sessionA = (await fresh().auth.signInWithPassword(user)).data.session!;
    const sessionB = (await fresh().auth.signInWithPassword(user)).data.session!;

    const clientA = fresh();
    await clientA.auth.setSession(sessionA);
    expect((await clientA.auth.updateUser({ password: `${user.password}x9` })).error).toBeNull();

    expect((await fresh().auth.refreshSession({ refresh_token: sessionB.refresh_token })).error).not.toBeNull();
    expect((await fresh().auth.getUser(sessionB.access_token)).error).not.toBeNull();

    const sessionC = (await fresh().auth.signInWithPassword({ email: user.email, password: `${user.password}x9` })).data.session!;
    expect((await adminClient().auth.admin.updateUserById(user.id, { password: `${user.password}y8` })).error).toBeNull();
    expect((await fresh().auth.refreshSession({ refresh_token: sessionC.refresh_token })).error).not.toBeNull();
    // The app's server checks (middleware, requireProfile) ask Auth, which refuses the revoked session at once.
    expect((await fresh().auth.getUser(sessionC.access_token)).error).not.toBeNull();
  });

  it("a revoked access token can no longer read or write through REST; a live session still can", async () => {
    const user = world.tenants.beta.users.admin;
    const live = (await fresh().auth.signInWithPassword(user)).data.session!;
    const revoked = (await fresh().auth.signInWithPassword(user)).data.session!;
    // Signing out one session (scope local) deletes it, exactly like a password change does for the others.
    const revoker = fresh();
    await revoker.auth.setSession(revoked);
    expect((await revoker.auth.signOut({ scope: "local" })).error).toBeNull();

    const { apiUrl, anonKey } = isolatedBackend();
    const as = (token: string) => createClient(apiUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const orgId = world.tenants.beta.id;
    const write = await as(revoked.access_token).from("customers").insert({ organization_id: orgId, name: "Stale token write" }).select("id");
    expect(write.error ?? (write.data ?? []).length === 0 ? "refused" : "allowed").toBe("refused");
    const read = await as(revoked.access_token).from("customers").select("id");
    expect((read.data ?? []).length).toBe(0);
    const { count } = await adminClient().from("customers").select("id", { count: "exact", head: true }).eq("name", "Stale token write");
    expect(count).toBe(0);

    const ok = await as(live.access_token).from("customers").insert({ organization_id: orgId, name: "Live session write" }).select("id");
    expect(ok.error).toBeNull();
  });
});

describe("pending invites can't be claimed by self sign-up (audit SEC5, configuration gate)", () => {
  it("refuses public sign-up, so an invited address gains nothing without an admin-created login", async () => {
    const email = `invitee.${world.runId}@example.test`;
    const { data: status, error: inviteError } = await adminClient().rpc("add_member", { p_org: world.tenants.alpha.id, p_email: email, p_role: "office" });
    expect(inviteError).toBeNull();
    expect(status).toBe("invited");
    const { data, error } = await fresh().auth.signUp({ email, password: "Invitee12345" });
    expect(error).not.toBeNull();
    expect(data.user).toBeNull();
    const { data: members } = await adminClient().from("organization_members").select("user_id").eq("organization_id", world.tenants.alpha.id);
    const { data: users } = await adminClient().auth.admin.listUsers({ perPage: 1000 });
    expect(users.users.some((u) => u.email === email)).toBe(false);
    expect(members?.length).toBe(4);
    await adminClient().from("organization_invites").delete().eq("email", email);
  });
});
