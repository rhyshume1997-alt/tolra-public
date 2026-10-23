/**
 * Who can change a person's display name (user_profiles.full_name), against the real database and its row-level security:
 *   * a member cannot edit another member's profile,
 *   * an admin of company A cannot rename someone who is only in company B,
 *   * a login shared by two companies is refused by the admin rename route (only the person may rename it).
 * The route is called with its real code; only the session lookup is replaced by clients signed in through Supabase Auth.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity } from "../support/fixtures";

vi.mock("server-only", () => ({}));

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/server/admin-users", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/admin-users")>()),
  guard: async () => session.ctx,
  audit: async () => undefined,
}));

const { PATCH } = await import("@/app/api/admin/users/route");

let world: SyntheticWorld;
const service = () => adminClient();
const clients: Record<string, SupabaseClient> = {};

const nameOf = async (id: string) => (await service().from("user_profiles").select("full_name").eq("id", id).single()).data!.full_name as string;

/** Update as the signed-in client: RLS decides. Returns how many rows changed. */
async function rename(client: SupabaseClient, id: string, name: string) {
  const { data, error } = await client.from("user_profiles").update({ full_name: name }).eq("id", id).select("id");
  return { rows: data?.length ?? 0, error };
}

/** The admin rename route, as `who` (an admin of `orgId`). */
async function routeRename(who: "alpha" | "beta", targetId: string, name: string) {
  const tenant = world.tenants[who];
  session.ctx = {
    auth: { user: { id: tenant.users.admin.id }, profile: { organization_id: tenant.id }, supabase: clients[`${who}.admin`] },
    admin: service(),
  };
  const response = await PATCH(new Request("http://localhost/api/admin/users", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ user_id: targetId, full_name: name }),
  }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const key of ["alpha", "beta"] as const) {
    for (const role of ["admin", "workshop"] as const) clients[`${key}.${role}`] = await signedInClient(world.tenants[key].users[role]);
  }
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("profile names", () => {
  it("a member cannot edit another member's profile name", async () => {
    const target = world.tenants.alpha.users.office;
    const before = await nameOf(target.id);
    const result = await rename(clients["alpha.workshop"], target.id, "Hijacked");
    expect(result.rows).toBe(0);
    expect(await nameOf(target.id)).toBe(before);
  });

  it("a member can still rename themselves", async () => {
    const me = world.tenants.alpha.users.workshop;
    expect((await rename(clients["alpha.workshop"], me.id, "Nia Own")).rows).toBe(1);
    expect(await nameOf(me.id)).toBe("Nia Own");
  });

  it("an admin of company A cannot rename a member who is only in company B", async () => {
    const target = world.tenants.beta.users.office;
    const before = await nameOf(target.id);
    expect((await rename(clients["alpha.admin"], target.id, "Hijacked")).rows).toBe(0);
    const viaRoute = await routeRename("alpha", target.id, "Hijacked");
    expect(viaRoute.status).toBe(404);
    expect(await nameOf(target.id)).toBe(before);
  });

  it("an admin renames a member of their own company through the route (control)", async () => {
    const target = world.tenants.alpha.users.office;
    const result = await routeRename("alpha", target.id, "Olive Office");
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, applied: ["name"] });
    expect(await nameOf(target.id)).toBe("Olive Office");
  });

  it("a login shared between two companies is refused by the admin rename route", async () => {
    const shared = world.tenants.alpha.users.viewer;
    const added = await service().rpc("add_member", { p_org: world.tenants.beta.id, p_email: shared.email, p_role: "viewer" });
    expect(added.error).toBeNull();
    const before = await nameOf(shared.id);
    for (const company of ["alpha", "beta"] as const) {
      const result = await routeRename(company, shared.id, "Renamed By Admin");
      expect(result.status).toBe(409);
      expect(String(result.body.error)).toContain("only they can change their name");
    }
    expect(await nameOf(shared.id)).toBe(before);
  });
});
