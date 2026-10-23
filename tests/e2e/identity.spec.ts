/**
 * Global login identity across companies (audit B0b: SEC2). A company admin manages memberships in their own
 * company; a login shared with another company keeps its username, password and sign-in ban out of their reach.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { generatePassword } from "@/lib/password";

import { adminClient, signedInClient } from "../support/fixtures";
import { enrolTotp, totpCode } from "../support/totp";
import { asSeparateDevice, signIn, world } from "./helpers";

test.describe.configure({ mode: "serial" });

const w = world();
let n = 0;

/** A login (service role, like the platform owner) with memberships in the given tenants. */
async function login(memberOf: ("alpha" | "beta")[], role = "office") {
  n += 1;
  const email = `ident${n}.${w.runId}@example.test`;
  const password = generatePassword(14);
  const admin = adminClient();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(error?.message);
  for (const tenant of memberOf) {
    const { error: addError } = await admin.rpc("add_member", { p_org: w.tenants[tenant].id, p_email: email, p_role: role });
    if (addError) throw new Error(addError.message);
  }
  return { id: data.user.id, email, password };
}

async function adminOf(page: Page, tenant: "alpha" | "beta") {
  await signIn(page, w.tenants[tenant].users.admin);
  return page.request;
}

const patch = (request: APIRequestContext, baseURL: string, data: Record<string, unknown>) =>
  request.patch("/api/admin/users", { headers: { origin: baseURL }, data });

const signInAccess = (request: APIRequestContext, baseURL: string, data: { user_id: string; enabled: boolean }) =>
  request.post("/api/admin/users/sign-in", { headers: { origin: baseURL }, data });

/**
 * A new admin of alpha who has passed the second step in the browser (aal2): Disable sign-in always needs it, even on this server
 * (REQUIRE_ADMIN_MFA off). Their authenticator is enrolled through the Auth API; the code is entered on /mfa.
 */
async function aal2AdminOfAlpha(page: Page) {
  const person = await login(["alpha"], "admin");
  const { secret } = await enrolTotp(await signedInClient(person));
  // A fresh 30-second window, so the code entered below is not the one used to enrol.
  const used = totpCode(secret);
  while (totpCode(secret) === used) await page.waitForTimeout(1000);
  await asSeparateDevice(page);
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(person.email);
  await page.getByLabel("Password", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/(select-role|dashboard|mfa)/, { timeout: 45_000 });
  await page.goto("/mfa");
  await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
  await page.getByLabel("6-digit code").fill(totpCode(secret));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(/\/(dashboard|select-role)/, { timeout: 30_000 });
  return page.request;
}

async function banState(id: string) {
  const { data } = await adminClient().auth.admin.getUserById(id);
  const user = data.user as { banned_until?: string | null; app_metadata?: Record<string, unknown> };
  return { banned: Boolean(user.banned_until && new Date(user.banned_until).getTime() > Date.now()), marker: user.app_metadata?.deactivation_ban ?? null };
}

test("a shared login's username can't be changed by one company; a company-only login's can", async ({ page, baseURL }) => {
  const shared = await login(["alpha", "beta"]);
  const own = await login(["alpha"]);
  const request = await adminOf(page, "alpha");

  const refused = await patch(request, baseURL!, { user_id: shared.id, username: `shared${w.runId}` });
  expect(refused.status()).toBe(409);
  const { data: profile } = await adminClient().from("user_profiles").select("username").eq("id", shared.id).single();
  expect(profile?.username ?? null).toBeNull();

  const allowed = await patch(request, baseURL!, { user_id: own.id, username: `own${w.runId}` });
  expect(allowed.status()).toBe(200);

  // Local, per-company changes to the shared login still work.
  const role = await patch(request, baseURL!, { user_id: shared.id, role: "viewer" });
  expect(role.status()).toBe(200);
  const { data: beta } = await adminClient().from("organization_members").select("role").eq("user_id", shared.id).eq("organization_id", w.tenants.beta.id).single();
  expect(beta?.role).toBe("office");
});

test("an alpha-only admin can't attach a beta-only login (by e-mail, with or without a username): 403, no membership", async ({ page, baseURL }) => {
  const other = await login(["beta"]);
  const request = await adminOf(page, "alpha");
  const withName = await request.post("/api/admin/users", { headers: { origin: baseURL! }, data: { email: other.email, full_name: "Other", role: "office", username: `taken${w.runId}` } });
  expect(withName.status()).toBe(403);
  const plain = await request.post("/api/admin/users", { headers: { origin: baseURL! }, data: { email: other.email, full_name: "Other", role: "office" } });
  expect(plain.status()).toBe(403);
  expect((await plain.json()).error).toBe("This login belongs to another company. An admin of that company must add it.");
  const { data: added } = await adminClient().from("organization_members").select("user_id").eq("user_id", other.id).eq("organization_id", w.tenants.alpha.id);
  expect(added ?? []).toEqual([]);
});

test("a company admin can't set a shared login's password (unchanged behaviour; at aal2, which Set password always needs from 093)", async ({ page, baseURL }) => {
  const shared = await login(["alpha", "beta"]);
  const request = await aal2AdminOfAlpha(page);
  const response = await request.post("/api/admin/users/password", { headers: { origin: baseURL! }, data: { user_id: shared.id, password: generatePassword(14), must_change_password: false } });
  expect(response.status()).toBe(409);
});

test("Deactivate never removes a login's only company (066): refused with the friendly message, no ban", async ({ page, baseURL }) => {
  const person = await login(["alpha"]);
  const request = await adminOf(page, "alpha");
  const refused = await patch(request, baseURL!, { user_id: person.id, active: false });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error).toBe("They must keep access to at least one company, so this company can't be removed. If they're leaving, use Disable sign-in instead: it stops them signing in to Tolra.");
  const { data: still } = await adminClient().from("organization_members").select("active").eq("user_id", person.id).eq("organization_id", w.tenants.alpha.id).single();
  expect(still?.active).toBe(true);
  expect(await banState(person.id)).toEqual({ banned: false, marker: null });
});

test("the app's own deactivation ban (marked) is lifted when the company takes its former member back", async ({ page, baseURL }) => {
  const person = await login(["alpha"]);
  // Switched off with no company left and banned by the app (as before 066): membership and marker set directly.
  expect((await adminClient().from("organization_members").update({ active: false }).eq("user_id", person.id)).error).toBeNull();
  expect((await adminClient().auth.admin.updateUserById(person.id, { ban_duration: "876000h", app_metadata: { deactivation_ban: true } })).error).toBeNull();
  const request = await adminOf(page, "alpha");
  const back = await patch(request, baseURL!, { user_id: person.id, active: true });
  expect(await back.json()).toMatchObject({ ok: true, login_disabled: false });
  expect(await banState(person.id)).toEqual({ banned: false, marker: null });
});

test("a ban the app didn't set (platform owner) survives a company reactivating the person", async ({ page, baseURL }) => {
  const person = await login(["alpha", "beta"]);
  const request = await adminOf(page, "alpha");
  expect((await patch(request, baseURL!, { user_id: person.id, active: false })).status()).toBe(200);
  expect((await adminClient().auth.admin.updateUserById(person.id, { ban_duration: "876000h" })).error).toBeNull();

  const back = await patch(request, baseURL!, { user_id: person.id, active: true });
  expect({ status: back.status(), body: await back.json() }).toMatchObject({ status: 200, body: { login_disabled: true } });
  expect((await banState(person.id)).banned).toBe(true);
  await adminClient().auth.admin.updateUserById(person.id, { ban_duration: "none" });
});

test("a platform ban on a company-only login survives reactivation (no app marker)", async ({ page, baseURL }) => {
  const person = await login(["alpha"]);
  // Deactivated in the company (membership only), then banned by the platform owner: no deactivation marker.
  expect((await adminClient().from("organization_members").update({ active: false }).eq("user_id", person.id)).error).toBeNull();
  expect((await adminClient().auth.admin.updateUserById(person.id, { ban_duration: "876000h" })).error).toBeNull();
  const request = await adminOf(page, "alpha");
  const back = await patch(request, baseURL!, { user_id: person.id, active: true });
  expect(back.status()).toBe(200);
  expect(await back.json()).toMatchObject({ login_disabled: true });
  expect(await banState(person.id)).toEqual({ banned: true, marker: null });
});

test("Disable sign-in needs the second step, and is refused for a login that also belongs to another company", async ({ page, baseURL }) => {
  const sole = await login(["alpha"]);
  const shared = await login(["alpha", "beta"]);
  const aal1 = await adminOf(page, "alpha");
  const refused = await signInAccess(aal1, baseURL!, { user_id: sole.id, enabled: false });
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toMatchObject({ code: "mfa_required" });
  expect(await banState(sole.id)).toEqual({ banned: false, marker: null });

  await page.context().clearCookies();
  const request = await aal2AdminOfAlpha(page);
  expect((await signInAccess(request, baseURL!, { user_id: shared.id, enabled: false })).status()).toBe(409);
  expect(await banState(shared.id)).toEqual({ banned: false, marker: null });
});

test("Disable sign-in (a leaver whose only company is alpha): the app's marked ban, membership kept; Enable lifts it", async ({ page, baseURL }) => {
  const leaver = await login(["alpha"]);
  const request = await aal2AdminOfAlpha(page);
  const off = await signInAccess(request, baseURL!, { user_id: leaver.id, enabled: false });
  expect(off.status()).toBe(200);
  expect(await banState(leaver.id)).toEqual({ banned: true, marker: true });
  const { data: member } = await adminClient().from("organization_members").select("active").eq("user_id", leaver.id).eq("organization_id", w.tenants.alpha.id).single();
  expect(member?.active).toBe(true);
  // They can't sign in any more.
  await expect(signedInClient(leaver)).rejects.toThrow();
  const on = await signInAccess(request, baseURL!, { user_id: leaver.id, enabled: true });
  expect(on.status()).toBe(200);
  expect(await banState(leaver.id)).toEqual({ banned: false, marker: null });
});

test("a platform ban is never turned into an app ban by Disable sign-in, and survives Enable sign-in and Reactivate", async ({ page, baseURL }) => {
  const person = await login(["alpha"]);
  expect((await adminClient().auth.admin.updateUserById(person.id, { ban_duration: "876000h" })).error).toBeNull();
  const request = await aal2AdminOfAlpha(page);
  expect((await signInAccess(request, baseURL!, { user_id: person.id, enabled: false })).status()).toBe(409);
  expect(await banState(person.id)).toEqual({ banned: true, marker: null });
  expect((await signInAccess(request, baseURL!, { user_id: person.id, enabled: true })).status()).toBe(409);
  expect(await banState(person.id)).toEqual({ banned: true, marker: null });
  // Switched off here (directly, as before 066) and taken back with Reactivate: the platform's ban still stands, unmarked.
  expect((await adminClient().from("organization_members").update({ active: false }).eq("user_id", person.id)).error).toBeNull();
  const back = await patch(request, baseURL!, { user_id: person.id, active: true });
  expect(await back.json()).toMatchObject({ ok: true, login_disabled: true });
  expect(await banState(person.id)).toEqual({ banned: true, marker: null });
});

test("a person in two companies can still switch between them", async () => {
  const person = await login(["alpha", "beta"]);
  const client = await signedInClient(person);
  const { data: before } = await client.rpc("current_user_organization_id");
  const target = before === w.tenants.alpha.id ? w.tenants.beta.id : w.tenants.alpha.id;
  expect((await client.rpc("switch_organization", { p_org: target })).error).toBeNull();
  expect((await client.rpc("current_user_organization_id")).data).toBe(target);
});
