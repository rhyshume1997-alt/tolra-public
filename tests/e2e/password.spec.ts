/**
 * Temporary passwords (audit B0a: SEC3, A9). An admin-set password with "must change password" lets the person
 * sign in, but nothing else works until they choose their own; and no step reports success unless the requirement
 * was really stored or cleared.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";

import { generatePassword } from "@/lib/password";

import { adminClient, signedInClient, withDb } from "../support/fixtures";
import { aal2Admin, choosePassword, failFlagWrites, signIn, signInToSetup, world } from "./helpers";

test.describe.configure({ mode: "serial" });

const w = world();
const alpha = { get users() { return w.tenants.alpha.users; } };
let counter = 0;

async function asAdmin(page: import("@playwright/test").Page) {
  await signIn(page, alpha.users.admin);
  return page.request;
}

async function createTemporaryUser(request: APIRequestContext, baseURL: string) {
  counter += 1;
  // The worker index keeps e-mails unique when a test runs again in a new worker (--repeat-each, a retry), where counter restarts at 0.
  const email = `temp${counter}-${test.info().workerIndex}.${w.runId}@example.test`;
  const password = generatePassword(14);
  const response = await request.post("/api/admin/users", {
    headers: { origin: baseURL },
    data: { email, full_name: `Temp ${counter}`, role: "office", password, must_change_password: true },
  });
  // Fail here, not 45 s later at sign-in, if the user wasn't created (e.g. the e-mail was already used).
  expect(response.status(), `creating ${email}`).toBe(201);
  return { response, email, password };
}

async function profileOf(email: string) {
  const { data } = await adminClient().from("user_profiles").select("id, must_change_password").eq("email", email).single();
  return data!;
}

async function appMetadata(id: string) {
  const { data } = await adminClient().auth.admin.getUserById(id);
  return (data.user?.app_metadata ?? {}) as Record<string, unknown>;
}

test("temporary password: only set-up works until the person chooses their own", async ({ browser, page, baseURL }) => {
  const created = await createTemporaryUser(await aal2Admin(page), baseURL!);
  expect(created.response.status()).toBe(201);
  const profile = await profileOf(created.email);
  expect(profile.must_change_password).toBe(true);
  expect(typeof (await appMetadata(profile.id)).temp_password_set_at).toBe("string");

  const context = await browser.newContext();
  const staff = await context.newPage();
  await signInToSetup(staff, created.email, created.password);

  const refused = await staff.request.post("/api/send-job", { headers: { origin: baseURL! }, data: {} });
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toMatchObject({ code: "password_change_required" });
  await staff.goto("/jobs");
  await expect(staff).toHaveURL(/\/auth\/set-password/);

  await choosePassword(staff, created.password);
  await expect(staff.getByText("different from the one you were given")).toBeVisible();

  const chosen = generatePassword(14);
  await choosePassword(staff, chosen);
  await staff.waitForURL(/\/dashboard/);
  expect((await profileOf(created.email)).must_change_password).toBe(false);
  expect(typeof (await appMetadata(profile.id)).password_changed_at).toBe("string");
  const allowed = await staff.request.post("/api/send-job", { headers: { origin: baseURL! }, data: {} });
  expect(allowed.status()).toBe(400); // past the gate: now it's just an invalid request
  await context.close();
});

test("\"finish set-up\" is refused until the temporary password has really been replaced", async ({ browser, page, baseURL }) => {
  const created = await createTemporaryUser(await aal2Admin(page), baseURL!);
  const context = await browser.newContext();
  const staff = await context.newPage();
  await signInToSetup(staff, created.email, created.password);
  const finish = await staff.request.post("/api/auth/change-password", { headers: { origin: baseURL! }, data: { finish: true } });
  expect(finish.status()).toBe(409);
  expect((await profileOf(created.email)).must_change_password).toBe(true);
  await context.close();
});

test("flag can't be cleared: partial result, then Finish set-up completes without a second change", async ({ browser, page, baseURL }) => {
  const created = await createTemporaryUser(await aal2Admin(page), baseURL!);
  const profile = await profileOf(created.email);
  const context = await browser.newContext();
  const staff = await context.newPage();
  await signInToSetup(staff, created.email, created.password);

  const undo = await failFlagWrites({ id: profile.id }, false);
  try {
    await choosePassword(staff, generatePassword(14));
    await expect(staff.getByText("Your new password is saved, but setting up your account didn't finish")).toBeVisible();
    await expect(staff).toHaveURL(/\/auth\/set-password/);
    expect((await profileOf(created.email)).must_change_password).toBe(true);
  } finally {
    await undo();
  }
  await staff.getByRole("button", { name: "Finish set-up" }).click();
  await staff.waitForURL(/\/dashboard/);
  expect((await profileOf(created.email)).must_change_password).toBe(false);
  await context.close();
});

test("re-submitting the already saved password after a partial result also completes set-up", async ({ browser, page, baseURL }) => {
  const created = await createTemporaryUser(await aal2Admin(page), baseURL!);
  const profile = await profileOf(created.email);
  const context = await browser.newContext();
  const staff = await context.newPage();
  await signInToSetup(staff, created.email, created.password);
  const chosen = generatePassword(14);

  const undo = await failFlagWrites({ id: profile.id }, false);
  try {
    await choosePassword(staff, chosen);
    await expect(staff.getByText("Your new password is saved")).toBeVisible();
  } finally {
    await undo();
  }
  await staff.reload();
  await choosePassword(staff, chosen);
  await staff.waitForURL(/\/dashboard/);
  expect((await profileOf(created.email)).must_change_password).toBe(false);
  await context.close();
});

test("admin set password: if the requirement can't be saved, the password is not changed and nothing reports success (R1)", async ({ page, baseURL }) => {
  const target = alpha.users.workshop;
  // An admin session that hasn't passed the second step is refused first (093, audit item 4), whatever REQUIRE_ADMIN_MFA says.
  const aal1 = await (await asAdmin(page)).post("/api/admin/users/password", {
    headers: { origin: baseURL! },
    data: { user_id: target.id, password: generatePassword(14), must_change_password: true },
  });
  expect(aal1.status()).toBe(403);
  expect((await aal1.json()).code).toBe("mfa_required");
  const request = await aal2Admin(page);
  const before = await profileOf(target.email);
  const attempted = generatePassword(14);
  const undo = await failFlagWrites({ id: target.id }, true);
  try {
    const response = await request.post("/api/admin/users/password", {
      headers: { origin: baseURL! },
      data: { user_id: target.id, password: attempted, must_change_password: true },
    });
    expect(response.status()).toBe(500);
    const body = await response.json();
    expect(body.error).toContain("the password was not changed");
    expect(body).not.toHaveProperty("partial");
  } finally {
    await undo();
  }
  // Fail closed: the old password still works, the new one doesn't, and the flag is as it was.
  await expect(signedInClient(target)).resolves.toBeTruthy();
  await expect(signedInClient({ email: target.email, password: attempted })).rejects.toBeTruthy();
  expect((await profileOf(target.email)).must_change_password).toBe(before.must_change_password);

  const ok = await request.post("/api/admin/users/password", {
    headers: { origin: baseURL! },
    data: { user_id: target.id, password: target.password, must_change_password: false },
  });
  expect(ok.status()).toBe(200);
});

test("admin create user: if the requirement can't be stored, the login is not created", async ({ page, baseURL }) => {
  const request = await aal2Admin(page);
  const email = `rollback.${w.runId}@example.test`;
  const undo = await failFlagWrites({ email }, true);
  try {
    const response = await request.post("/api/admin/users", {
      headers: { origin: baseURL! },
      data: { email, full_name: "Rollback", role: "office", password: generatePassword(14), must_change_password: true },
    });
    expect(response.status()).toBe(500);
  } finally {
    await undo();
  }
  const left = await withDb((db) => db.query("select count(*)::int as n from auth.users where email = $1", [email]));
  expect(left.rows[0].n).toBe(0);
});
