/**
 * BOUNDARY (module 10): isolated synthetic contacts, real route handlers and Release 154 -> browser acceptance.
 * Run with a disposable Portal-ON server and a fresh 32-byte base64 PORTAL_SIGNIN_HMAC_KEY shared with this runner.
 * No mocked database behaviour, skipped cases, production records or staff-authentication bypasses.
 * Requires core #498, routes #499, pages #505 and Auth #520 together; this branch has only #505 today.
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createSoloTenant, verifyBackendIdentity, withDb, type SyntheticUser } from "../support/fixtures";
import { asSeparateDevice, world } from "./helpers";

const w = world();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
type Contact = { id: string; email: string; name: string; org: string; customer: string };
let buyer: Contact;
let jobsOnly: Contact;
let foreign: Contact;
let ownJob = "";
let otherJob = "";
let foreignJob = "";
let ownQuote = "";
let otherQuote = "";
let foreignQuote = "";
let secret = "";
let owner: SyntheticUser;

async function staffSql(user: SyntheticUser, expression: string, args: unknown[]) {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      const claims = { sub: user.id, role: "authenticated", aal: "aal2", amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }] };
      await db.query("select set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)", [JSON.stringify(claims), user.id]);
      const result = await db.query(`select ${expression} as result`, args);
      await db.query("commit");
      return result.rows[0].result;
    } catch (error) { await db.query("rollback"); throw error; }
  });
}

async function issue(contact: Contact) {
  const ref = randomBytes(16).toString("base64url");
  const code = "12345678";
  const key = Buffer.from(process.env.PORTAL_SIGNIN_HMAC_KEY ?? "", "base64");
  expect(key.length, "runner and disposable app need the same test-only HMAC key").toBe(32);
  const subkey = createHmac("sha256", key).update("tolra:portal-signin-code:v1").digest();
  const codeHash = createHmac("sha256", subkey).update(`${ref}:${code}`).digest("hex");
  const result = await withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role service_role");
      const r = await db.query("select public.portal_signin_request($1,$2::text[],$3::text[]) as result", [contact.email, [sha(ref)], [codeHash]]);
      await db.query("commit");
      return r.rows[0].result;
    } catch (error) { await db.query("rollback"); throw error; }
  });
  expect(result).toMatchObject({ ok: true });
  expect(result.sends).toHaveLength(1);
  return { ref, code };
}

// Age only isolated fixture records: their immutable timestamps cannot be changed by normal API callers.
async function ageFixture(sql: string, args: unknown[]) {
  await withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local session_replication_role = replica");
      await db.query(sql,args);
      await db.query("commit");
    } catch (error) { await db.query("rollback"); throw error; }
  });
}

async function enter(page: Page, pair: { ref: string; code: string }) {
  await page.goto(`/portal/code/${pair.ref}`);
  await page.getByLabel("8-digit code from the e-mail").fill(pair.code);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
async function login(page: Page, contact = buyer) {
  await asSeparateDevice(page);
  await enter(page, await issue(contact));
  await expect(page.getByRole("heading", { name: `Welcome, ${contact.name}`, exact: true })).toBeVisible();
  await expect(page.getByTestId("portal-home")).toBeVisible();
}

async function seedContact(org: string, customer: string, admin: SyntheticUser, permissions: string[]): Promise<Contact> {
  const email = `portal-${randomUUID()}@example.test`;
  const name = `Synthetic buyer ${randomUUID().slice(0, 8)}`;
  const result = await staffSql(admin, "public.portal_contact_invite($1,$2,$3,$4::text[],'synthetic browser acceptance')", [customer, email, name, permissions]);
  return { id: result.contact_id, email, name, org, customer };
}

test.beforeEach(async () => {
  await verifyBackendIdentity();
  expect(process.env.CUSTOMER_PORTAL_ENABLED, "requires a dedicated disposable Portal-ON server").toBe("true");
  const tag = randomUUID().slice(0, 8);
  const a = await createSoloTenant(w.runId, `portal-a-${tag}`);
  const b = await createSoloTenant(w.runId, `portal-b-${tag}`);
  owner = a.admin;
  secret = `INTERNAL-COST-${tag}`;
  await staffSql(a.admin, "public.customer_portal_set_enabled(true,'synthetic acceptance only')", []);
  await staffSql(b.admin, "public.customer_portal_set_enabled(true,'synthetic acceptance only')", []);
  await withDb(async (db) => {
    const customer = async (org: string) => (await db.query("insert into public.customers(organization_id,name) values($1,'Same synthetic customer') returning id", [org])).rows[0].id as string;
    const ca = await customer(a.id);
    const other = await customer(a.id);
    const cb = await customer(b.id);
    buyer = { id: "", email: "", name: "", org: a.id, customer: ca };
    foreign = { id: "", email: "", name: "", org: b.id, customer: cb };
    ownJob = `J-PORTAL-A-${tag}`;
    otherJob = `J-PORTAL-OTHER-${tag}`;
    foreignJob = `J-PORTAL-B-${tag}`;
    ownQuote = `Q-PORTAL-A-${tag}`;
    otherQuote = `Q-PORTAL-OTHER-${tag}`;
    foreignQuote = `Q-PORTAL-B-${tag}`;
    // Existing fixture pattern: create sent documents with frozen audit/lifecycle triggers suspended only during seeding.
    // All authorisation and reads below run with normal triggers and real Release 153/154 functions.
    await db.query("begin");
    try {
      await db.query("set local session_replication_role = replica");
      for (const [org, ref] of [[a.id, ownQuote], [a.id, otherQuote], [b.id, foreignQuote]]) {
        await db.query("insert into public.quotes(id,organization_id,quote_ref,customer,status,sent_at,total_value,valid_until,internal_notes,version) values($1,$2,$3,'Same synthetic customer','sent',now(),1234.50,'2026-12-31',$4,1)", [randomUUID(), org, ref, secret]);
      }
      for (const [org,no] of [[a.id,ownJob],[a.id,otherJob],[b.id,foreignJob]]) {
        await db.query("insert into public.jobs(organization_id,job_no,customer,is_internal,description,overrun_reasons) values($1,$2,'Same synthetic customer',false,$3,$3)",[org,no,secret]);
      }
      await db.query("commit");
    } catch (error) { await db.query("rollback"); throw error; }
    const rows = await db.query("select id,quote_ref from public.quotes where organization_id=any($1::uuid[]) and quote_ref=any($2::text[])", [[a.id,b.id],[ownQuote,otherQuote,foreignQuote]]);
    for (const row of rows.rows) {
      const admin = row.quote_ref === foreignQuote ? b.admin : a.admin;
      const cust = row.quote_ref === foreignQuote ? cb : row.quote_ref === ownQuote ? ca : other;
      await staffSql(admin, "public.link_document_customer('quote',$1,$2,'synthetic verified link')", [row.id,cust]);
    }
    const jobRows = await db.query("select id,job_no from public.jobs where organization_id=any($1::uuid[]) and job_no=any($2::text[])",[[a.id,b.id],[ownJob,otherJob,foreignJob]]);
    for (const row of jobRows.rows) {
      const admin = row.job_no===foreignJob ? b.admin : a.admin;
      const cust = row.job_no===foreignJob ? cb : row.job_no===ownJob ? ca : other;
      await staffSql(admin,"public.link_document_customer('job',$1,$2,'synthetic verified job link')",[row.id,cust]);
    }
  });
  buyer = await seedContact(a.id,buyer.customer,a.admin,["quotes","jobs"]);
  jobsOnly = await seedContact(a.id,buyer.customer,a.admin,["jobs"]);
  foreign = await seedContact(b.id,foreign.customer,b.admin,["quotes"]);
});

test("real code sign-in sets a secure customer cookie; logout ends it", async ({ page }) => {
  await login(page);
  const cookie = (await page.context().cookies()).find(c => c.name === "__Host-tolra_portal");
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/" });
  expect((await page.context().cookies()).filter(c => /^sb-.*-auth-token/.test(c.name))).toEqual([]);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.goto("/portal/quotes");
  await expect(page.getByTestId("portal-refusal")).toBeVisible();
  const state = await withDb(db => db.query("select end_reason from public.customer_portal_sessions where contact_id=$1", [buyer.id]));
  expect(state.rows).toEqual([{ end_reason: "signed_out" }]);
});

test("invalid, expired and used codes have identical customer-facing errors", async ({ page }) => {
  await asSeparateDevice(page);
  const invalid = await issue(buyer);
  await enter(page, { ...invalid, code: "87654321" });
  const message = await page.getByTestId("portal-code-refused").innerText();
  const expired = await issue(jobsOnly);
  await ageFixture("update public.customer_portal_signin_codes set created_at=now()-interval '11 minutes',expires_at=now()-interval '1 minute' where ref_hash=$1", [sha(expired.ref)]);
  await enter(page, expired);
  await expect(page.getByTestId("portal-code-refused")).toHaveText(message);
  const used = await issue(foreign);
  await enter(page, used);
  await expect(page.getByTestId("portal-home")).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await enter(page, used);
  await expect(page.getByTestId("portal-code-refused")).toHaveText(message);
  await expect(page.locator("body")).not.toContainText(buyer.email);
  await expect(page.locator("body")).not.toContainText("correlation_id");
});

test("idle session expiry refuses protected data", async ({ page }) => {
  await login(page);
  await ageFixture("update public.customer_portal_sessions set created_at=now()-interval '1 hour',last_seen_at=now()-interval '31 minutes',absolute_expires_at=now()+interval '7 hours' where contact_id=$1", [buyer.id]);
  await page.goto("/portal/quotes");
  await expect(page.getByTestId("portal-refusal")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(ownQuote);
});

test("verified documents stay isolated by customer and company; internal notes never render", async ({ page }) => {
  await login(page);
  await page.goto("/portal/quotes");
  await expect(page.getByTestId("portal-quotes")).toContainText(ownQuote);
  await expect(page.locator("body")).not.toContainText(otherQuote);
  await expect(page.locator("body")).not.toContainText(foreignQuote);
  expect(await page.content()).not.toContain(secret);
  expect(await page.content()).not.toMatch(/cost_price|hourly_rate|gross_margin|internal_cost/);
  await page.context().clearCookies();
  await login(page,foreign);
  await page.goto("/portal/quotes");
  await expect(page.getByTestId("portal-quotes")).toContainText(foreignQuote);
  await expect(page.locator("body")).not.toContainText(ownQuote);
});

test("named contacts keep separate identities and document permissions", async ({ page }) => {
  await login(page,jobsOnly);
  await expect(page.getByRole("heading", { name: `Welcome, ${buyer.name}`, exact: true })).toHaveCount(0);
  await expect(page.getByTestId("portal-tab-quotes")).toHaveCount(0);
  expect((await page.goto("/portal/quotes"))!.status()).toBe(404);
  await expect(page.locator("body")).not.toContainText(ownQuote);
  await page.goto("/portal/jobs");
  await expect(page.getByTestId("portal-jobs")).toContainText(ownJob);
  await expect(page.locator("body")).not.toContainText(otherJob);
  await expect(page.locator("body")).not.toContainText(foreignJob);
  expect(await page.content()).not.toContain(secret);
});

test("customer cookie gives no staff or invoice access", async ({ page }) => {
  await login(page);
  for (const route of ["/dashboard","/customers","/settings","/invoices","/admin/users"]) {
    await page.goto(route);
    await expect(page).toHaveURL(/\/login(?:\?|$)/);
  }
  expect((await page.goto("/portal/invoices"))!.status()).toBe(404);
});

test("company OFF ends a valid customer session and hides its documents", async ({ page }) => {
  await login(page);
  await staffSql(owner,"public.customer_portal_set_enabled(false,'synthetic acceptance switch off')",[]);
  await page.goto("/portal/quotes");
  await expect(page.getByTestId("portal-refusal")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(ownQuote);
});


test("known and unknown sign-in requests show the same public response", async ({ page }) => {
  await asSeparateDevice(page);
  const bodies: string[] = [];
  for (const email of [buyer.email,`unknown-${randomUUID()}@example.test`]) {
    await page.goto("/portal/signin");
    await page.getByLabel("E-mail address").fill(email);
    await page.getByRole("button", { name: "Send me a link and code", exact: true }).click();
    await expect(page).toHaveURL(/\/portal\/signin\/sent$/);
    bodies.push(await page.locator("body").innerText());
  }
  expect(bodies[0]).toBe(bodies[1]);
  expect(bodies[0]).not.toContain(buyer.email);
});

test("five wrong codes lock the code; the correct code still refuses", async ({ page }) => {
  await asSeparateDevice(page);
  const pair = await issue(buyer);
  for (let attempt=0; attempt<5; attempt+=1) {
    await enter(page,{...pair,code:"87654321"});
    await expect(page.getByTestId("portal-code-refused")).toBeVisible();
  }
  await enter(page,pair);
  await expect(page.getByTestId("portal-code-refused")).toBeVisible();
  const result = await withDb(db=>db.query("select attempts,burn_reason from public.customer_portal_signin_codes where ref_hash=$1",[sha(pair.ref)]));
  expect(result.rows).toEqual([{attempts:5,burn_reason:"locked"}]);
});


test("absolute session expiry refuses even a recently active customer", async ({ page }) => {
  await login(page);
  await ageFixture("update public.customer_portal_sessions set created_at=now()-interval '9 hours',last_seen_at=now()-interval '1 minute',absolute_expires_at=now()-interval '1 hour' where contact_id=$1",[buyer.id]);
  await page.goto("/portal/quotes");
  await expect(page.getByTestId("portal-refusal")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(ownQuote);
  const state = await withDb(db=>db.query("select end_reason from public.customer_portal_sessions where contact_id=$1",[buyer.id]));
  expect(state.rows).toEqual([{end_reason:"absolute"}]);
});
