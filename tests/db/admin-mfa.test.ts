/**
 * Admin two-step sign-in against the real Auth service of the local stack (TOTP): an admin signs in with the password alone
 * (aal1) or after the code (aal2); the database rule (organizations.require_admin_mfa) refuses aal1 on settings changes and
 * allows aal2; and another admin can reset a person's two-step sign-in (audited), but not their own and not another company's.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resetMfa } from "@/lib/server/admin-users";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { enrolTotp, passSecondStep } from "../support/totp";

let world: SyntheticWorld;
let adminFactor: { factorId: string; secret: string };
const aalOf = async (client: SupabaseClient) => {
  const session = (await client.auth.getSession()).data.session!;
  return JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url").toString()).aal as string;
};

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
});

afterAll(async () => {
  if (world) {
    await withDb((db) => db.query("update public.organizations set require_admin_mfa = false where id = any($1)", [[world.tenants.alpha.id, world.tenants.beta.id]]));
    await destroySyntheticWorld(world.runId);
  }
});

describe("enrolment and the assurance level", () => {
  it("password alone is aal1; enrolling and entering the code makes the session aal2; a new password sign-in is aal1 again, until the code", async () => {
    const admin = world.tenants.alpha.users.admin;
    const first = await signedInClient(admin);
    expect(await aalOf(first)).toBe("aal1");
    const factor = await enrolTotp(first);
    adminFactor = factor;
    // The same client now holds an aal2 session after verifying.
    await first.auth.refreshSession();
    expect(await aalOf(first)).toBe("aal2");

    const second = await signedInClient(admin);
    expect(await aalOf(second)).toBe("aal1");
    expect((await second.auth.mfa.getAuthenticatorAssuranceLevel()).data).toMatchObject({ currentLevel: "aal1", nextLevel: "aal2" });
    // A wrong code does not pass.
    expect((await second.auth.mfa.challengeAndVerify({ factorId: factor.factorId, code: "000000" })).error).not.toBeNull();
    await passSecondStep(second, factor.factorId, factor.secret);
    await second.auth.refreshSession();
    expect(await aalOf(second)).toBe("aal2");
  });
});

describe("the database rule with real tokens", () => {
  it("when the company requires it, an admin at aal1 can't change settings; at aal2 they can (payments and e-mails: prelaunch.test.ts)", async () => {
    const admin = world.tenants.alpha.users.admin;
    const aal2 = await signedInClient(admin);
    await passSecondStep(aal2, adminFactor.factorId, adminFactor.secret);
    await aal2.auth.refreshSession();
    expect(await aalOf(aal2)).toBe("aal2");
    // A password-only sign-in made afterwards (the auth service ends older password-only sessions when a second step passes).
    const aal1 = await signedInClient(admin);
    expect(await aalOf(aal1)).toBe("aal1");

    const change = (client: SupabaseClient) => client.from("organization_settings").update({ hidden_nav: [] }).eq("organization_id", world.tenants.alpha.id).select("organization_id");
    // Off (the default): both work.
    expect((await change(aal1)).error).toBeNull();

    // Migration 065 allows this with no skip: alpha's only admin enrolled a real authenticator factor above.
    await withDb((db) => db.query("update public.organizations set require_admin_mfa = true where id = $1", [world.tenants.alpha.id]));
    const refused = await change(aal1);
    expect(refused.error).toMatchObject({ code: "42501" });
    expect(refused.error?.hint).toBe("mfa_required");
    const allowed = await change(aal2);
    expect(allowed.error).toBeNull();
    expect(allowed.data).toHaveLength(1);

    // Everything else an admin does is untouched (only the privileged actions are held to it).
    expect((await aal1.from("customers").insert({ organization_id: world.tenants.alpha.id, name: `Mfa Customer ${world.runId}` })).error).toBeNull();
    // The other company is not affected.
    const betaAdmin = await signedInClient(world.tenants.beta.users.admin);
    expect((await betaAdmin.from("organization_settings").update({ hidden_nav: [] }).eq("organization_id", world.tenants.beta.id)).error).toBeNull();
    await withDb((db) => db.query("update public.organizations set require_admin_mfa = false where id = $1", [world.tenants.alpha.id]));
  });
});

describe("migration 065 reads real factors from the Auth service (auth.mfa_factors)", () => {
  it("the SECURITY DEFINER owner can read auth.mfa_factors: TRUE for an admin with a real verified factor, FALSE without", async () => {
    const owner = await withDb(async (db) => (await db.query<{ owner: string; can: boolean }>(
      "select pg_get_userbyid(p.proowner) as owner, has_table_privilege(p.proowner, 'auth.mfa_factors', 'SELECT') as can from pg_proc p where p.oid = 'public.member_has_verified_totp(uuid)'::regprocedure")).rows[0]);
    expect(owner.can).toBe(true);
    const verified = (userId: string) => withDb(async (db) => (await db.query<{ v: boolean }>("select public.member_has_verified_totp($1) as v", [userId])).rows[0].v);
    // alpha's admin enrolled a real factor through the Auth API above (enrolTotp: enroll + challenge + verify).
    expect(await verified(world.tenants.alpha.users.admin.id)).toBe(true);
    expect(await verified(world.tenants.beta.users.admin.id)).toBe(false);
    expect(await verified(world.tenants.alpha.users.viewer.id)).toBe(false);

    // The same through the signed-in readers (PostgREST, role authenticated): the definer function reads the factor table.
    const alphaClient = await signedInClient(world.tenants.alpha.users.admin);
    const alpha = await alphaClient.rpc("admin_mfa_overview");
    expect(alpha.error).toBeNull();
    expect(alpha.data).toMatchObject({ can_require: true, admins: [{ user_id: world.tenants.alpha.users.admin.id, enrolled: true }] });
    const betaClient = await signedInClient(world.tenants.beta.users.admin);
    const beta = await betaClient.rpc("admin_mfa_overview");
    expect(beta.data).toMatchObject({ can_require: false, admins: [{ user_id: world.tenants.beta.users.admin.id, enrolled: false }] });
    expect((await alphaClient.rpc("my_mfa_enrolment_required")).data).toBe(false);
  });

  it("the rule can't be turned on for a company whose admin has no real factor (owner SQL, no fixture); refused to an admin's own session too", async () => {
    let error: { code?: string; hint?: string; message: string } | null = null;
    try {
      await withDb((db) => db.query("update public.organizations set require_admin_mfa = true where id = $1", [world.tenants.beta.id]));
    } catch (err) {
      error = err as typeof error;
    }
    expect(error).toMatchObject({ code: "23514", hint: "admins_not_enrolled" });
    expect(error!.message).toBe(`Two-step sign-in can't be required yet: 1 admin(s) have not set up an authenticator app (${world.tenants.beta.users.admin.email}).`);
    const betaClient = await signedInClient(world.tenants.beta.users.admin);
    const own = await betaClient.from("organizations").update({ require_admin_mfa: true }).eq("id", world.tenants.beta.id).select("id");
    expect(own.error).toMatchObject({ code: "42501" });
    expect((await withDb((db) => db.query("select require_admin_mfa as r from public.organizations where id = $1", [world.tenants.beta.id]))).rows[0].r).toBe(false);
  });
});

describe("another admin resets someone's two-step sign-in", () => {
  const alphaAdmin = () => world.tenants.alpha.users.admin;

  async function enrolled(userKey: "office" | "viewer") {
    const client = await signedInClient(world.tenants.alpha.users[userKey]);
    await enrolTotp(client);
    return world.tenants.alpha.users[userKey].id;
  }
  const factorCount = async (userId: string) => ((await adminClient().auth.admin.mfa.listFactors({ userId })).data?.factors ?? []).length;

  it("removes every factor, so the person can set up a new one; the reset is the caller's to make and is audited by the route", async () => {
    const targetId = await enrolled("office");
    expect(await factorCount(targetId)).toBe(1);
    const result = await resetMfa(adminClient() as never, world.tenants.alpha.id, alphaAdmin().id, targetId);
    expect(result).toEqual({ ok: true, removed: 1 });
    expect(await factorCount(targetId)).toBe(0);
    // They can sign in with the password and enrol again.
    const again = await signedInClient(world.tenants.alpha.users.office);
    expect(await aalOf(again)).toBe("aal1");
    await enrolTotp(again);
    expect(await factorCount(targetId)).toBe(1);
    // Resetting someone with no factors is fine and removes nothing.
    await resetMfa(adminClient() as never, world.tenants.alpha.id, alphaAdmin().id, targetId);
    expect(await resetMfa(adminClient() as never, world.tenants.alpha.id, alphaAdmin().id, targetId)).toEqual({ ok: true, removed: 0 });
  });

  it("not your own, not another company's person, not a login shared with another company", async () => {
    const self = await resetMfa(adminClient() as never, world.tenants.alpha.id, alphaAdmin().id, alphaAdmin().id);
    expect(self).toMatchObject({ ok: false, status: 400 });
    const foreign = await resetMfa(adminClient() as never, world.tenants.alpha.id, alphaAdmin().id, world.tenants.beta.users.admin.id);
    expect(foreign).toMatchObject({ ok: false, status: 404 });

    const sharedId = await enrolled("viewer");
    const added = await adminClient().rpc("add_member", { p_org: world.tenants.beta.id, p_email: world.tenants.alpha.users.viewer.email, p_role: "viewer" });
    expect(added.error).toBeNull();
    const shared = await resetMfa(adminClient() as never, world.tenants.alpha.id, alphaAdmin().id, sharedId);
    expect(shared).toMatchObject({ ok: false, status: 403 });
    expect(await factorCount(sharedId)).toBe(1);
  });
});
