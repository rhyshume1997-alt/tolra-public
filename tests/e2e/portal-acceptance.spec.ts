/**
 * BOUNDARY (module 10): isolated synthetic contacts, real route handlers and Release 154 -> browser acceptance.
 * Runs its own disposable Portal-ON server with a fresh test-only HMAC key; shared browser infrastructure stays unchanged.
 * No mocked database behaviour, skipped cases, production records or staff-authentication bypasses.
 * Requires refreshed core #498, routes #499, pages #505 and Auth #520 together; this draft is stacked on #520.
 * Native execution remains blocked until the real route/core/release dependency chain is available.
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { expect, test as base, type Page } from "@playwright/test";
import { createSoloTenant, verifyBackendIdentity, withDb, type SyntheticUser } from "../support/fixtures";
import { asSeparateDevice, world } from "./helpers";
import { E2E_MOCK_PORT, E2E_BLOCKED_LOG } from "./paths";
import type { RecordedEmail } from "../support/mock-providers";

// Portal-owned worker fixture: same isolated backend/build and local provider recorder, explicit server mode.
// The shared Playwright config/global setup is unchanged. No hosted backend or existing app server is reused.
import { isolatedBackend } from "../support/isolation";
type PortalRuntime = { url: string; key: string; enabled: boolean };
const test = base.extend<object, { portalRuntime: PortalRuntime }>({
  portalRuntime: [async ({}, provide) => {
    const backend = isolatedBackend();
    await verifyBackendIdentity(backend);
    const root = path.resolve(__dirname, "../..");
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("Portal test port could not be allocated");
    const port = address.port;
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    const url = `http://localhost:${port}`;
    const key = randomBytes(32).toString("base64");
    const child = spawn(process.execPath, [path.join(root,"node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
      cwd: root, stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, NODE_ENV: "production", NODE_OPTIONS: `--require ${path.join(root,"tests/support/no-network.cjs")}`,
        NEXT_PUBLIC_SUPABASE_URL: backend.apiUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: backend.anonKey,
        SUPABASE_SERVICE_ROLE_KEY: backend.serviceRoleKey, NEXT_PUBLIC_SITE_URL: url,
        CUSTOMER_PORTAL_ENABLED: "true", PORTAL_SIGNIN_HMAC_KEY: key, REQUIRE_ADMIN_MFA: "false",
        RESEND_API_KEY: "re_test_mock", RESEND_BASE_URL: `http://127.0.0.1:${E2E_MOCK_PORT}`,
        EMAIL_FROM: "Tolra Test <noreply@example.test>", E2E_BLOCKED_LOG },
    });
    let launchError: Error | null = null;
    child.once("error", error => { launchError = error; });
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    try {
      // Startup polling only; this does not retry a failed Portal assertion or provider operation.
      await expect.poll(async () => {
        if (launchError || child.exitCode !== null) throw new Error("Dedicated Portal test server did not start");
        const tenant = world().tenants.alpha;
        const response = await fetch(`${url}/api/branding?org=${encodeURIComponent(tenant.slug)}`).catch(() => null);
        const body = await response?.json().catch(() => null) as { name?: string } | null;
        return body?.name === tenant.name;
      }, { timeout: 30_000 }).toBe(true);
      await provide({ url, key, enabled: true });
    } finally {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await closed;
      clearTimeout(force);
    }
  }, { scope: "worker" }],
  baseURL: async ({ portalRuntime }, provide) => { await provide(portalRuntime.url); },
});

let runnerKey = "";

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
  const key = Buffer.from(runnerKey, "base64");
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

test.beforeEach(async ({ portalRuntime }) => {
  runnerKey = portalRuntime.key;
  await verifyBackendIdentity();
  expect(portalRuntime.enabled).toBe(true);
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


test("the request route sends a platform email whose real link and code sign in", async ({ page, portalRuntime }) => {
  await asSeparateDevice(page);
  await page.goto("/portal/signin");
  await page.getByLabel("E-mail address").fill(buyer.email);
  await page.getByRole("button", { name: "Send me a link and code", exact: true }).click();
  await expect(page).toHaveURL(/\/portal\/signin\/sent$/);
  // Provider transport is the existing local recorder. The request handler, code generation and database remain real.
  const received = async () => {
    const response = await fetch(`http://127.0.0.1:${E2E_MOCK_PORT}/__emails`);
    expect(response.ok).toBe(true);
    const records = await response.json() as RecordedEmail[];
    return records.filter(record => JSON.stringify(record.body).includes(buyer.email));
  };
  await expect.poll(async () => (await received()).length).toBe(1);
  const body = (await received())[0].body as { to?: unknown; text?: unknown; subject?: unknown; from?: unknown };
  expect(body.to).toEqual([buyer.email]);
  expect(body.from).toBe("Tolra Test <noreply@example.test>");
  expect(body.subject).toBe("Your sign-in link and code");
  if (typeof body.text!=="string") throw new Error("Portal platform email is missing its text body");
  const ref = body.text.match(/\/portal\/code\/([A-Za-z0-9_-]{22})/);
  const link = body.text.match(/https?:\/\/\S+\/portal\/code\/([A-Za-z0-9_-]{22})/);
  const code = body.text.match(/Your code: (\d{4}) (\d{4})/);
  if (!ref || !link || !code) throw new Error("Portal platform email is missing its sign-in link or code");
  expect(new URL(link[0]).origin).toBe(portalRuntime.url);
  expect(link[1]).toBe(ref[1]);
  await page.goto(link[0]);
  await page.getByLabel("8-digit code from the e-mail").fill(code[1]+code[2]);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading",{name:`Welcome, ${buyer.name}`,exact:true})).toBeVisible();
  const history = await withDb(db=>db.query("select id from public.email_history where to_email=$1",[buyer.email]));
  expect(history.rows).toEqual([]);
});


test("request IP limit keeps the generic response and blocks a fresh eligible contact", async ({ playwright, portalRuntime }) => {
  const network = randomBytes(6).toString("hex").match(/.{4}/g)!.join(":");
  const client = (suffix: string) => playwright.request.newContext({ baseURL: portalRuntime.url,
    extraHTTPHeaders: { Origin: portalRuntime.url, "x-real-ip": `2001:db8:${network}::${suffix}` } });
  const limited = await client("1");
  const fresh = await client("2");
  const codeCount = async (contact: Contact) => Number((await withDb(db => db.query("select count(*) as n from public.customer_portal_signin_codes where contact_id=$1", [contact.id]))).rows[0].n);
  try {
    const first = await limited.post("/api/portal/signin/request", { form: { email: buyer.email }, maxRedirects: 0 });
    expect(first.status()).toBe(303); expect(first.headers()["location"]).toBe("/portal/signin/sent");
    expect(await codeCount(buyer)).toBe(1);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await limited.post("/api/portal/signin/request", { form: { email: `unknown-${randomUUID()}@example.test` }, maxRedirects: 0 });
      expect(response.status()).toBe(303); expect(response.headers()["location"]).toBe(first.headers()["location"]);
    }
    const boundary = await limited.post("/api/portal/signin/request", { form: { email: jobsOnly.email }, maxRedirects: 0 });
    expect(boundary.status()).toBe(303); expect(boundary.headers()["location"]).toBe(first.headers()["location"]);
    expect(await codeCount(jobsOnly)).toBe(1); // attempt10 must still be allowed
    const refused = await limited.post("/api/portal/signin/request", { form: { email: foreign.email }, maxRedirects: 0 });
    expect(refused.status()).toBe(303); expect(refused.headers()["location"]).toBe(first.headers()["location"]);
    expect(refused.headers()["cache-control"]).toBe("no-store"); expect(refused.headers()["set-cookie"]).toBeUndefined();
    expect(await codeCount(foreign)).toBe(0); // attempt11 must refuse
    // Independent positive control: the same fresh contact is eligible on a fresh IP; no email cooldown explains the refusal.
    const control = await fresh.post("/api/portal/signin/request", { form: { email: foreign.email }, maxRedirects: 0 });
    expect(control.status()).toBe(303); expect(control.headers()["location"]).toBe(first.headers()["location"]);
    expect(await codeCount(foreign)).toBe(1);
  } finally { await limited.dispose(); await fresh.dispose(); }
});

test("verify IP limit cannot consume a valid code or issue a customer cookie", async ({ playwright, portalRuntime }) => {
  const network = randomBytes(6).toString("hex").match(/.{4}/g)!.join(":");
  const client = (suffix: string) => playwright.request.newContext({ baseURL: portalRuntime.url,
    extraHTTPHeaders: { Origin: portalRuntime.url, "x-real-ip": `2001:db8:${network}::${suffix}` } });
  const limited = await client("1");
  const blocked = await client("1"); // same IP budget, separate cookie-free context
  const fresh = await client("2");
  try {
    for (let attempt = 0; attempt < 19; attempt += 1) {
      const response = await limited.post("/api/portal/signin/verify", { form: { ref: randomBytes(16).toString("base64url"), code: "87654321" }, maxRedirects: 0 });
      expect(response.status()).toBe(303); expect(response.headers()["set-cookie"]).toBeUndefined();
    }
    const boundary = await issue(buyer);
    const allowed = await limited.post("/api/portal/signin/verify", { form: boundary, maxRedirects: 0 });
    expect(allowed.status()).toBe(303); expect(allowed.headers()["location"]).toBe("/portal");
    expect(allowed.headers()["set-cookie"]).toContain("__Host-tolra_portal="); // attempt20 must be allowed
    const boundaryState = await withDb(db => db.query("select used_at is not null as used from public.customer_portal_signin_codes where ref_hash=$1", [sha(boundary.ref)]));
    expect(boundaryState.rows).toEqual([{ used: true }]);
    const pair = await issue(jobsOnly);
    const refused = await blocked.post("/api/portal/signin/verify", { form: pair, maxRedirects: 0 });
    expect(refused.status()).toBe(303); expect(refused.headers()["location"]).toContain(`/portal/code/${pair.ref}?c=`);
    expect(refused.headers()["cache-control"]).toBe("no-store"); expect(refused.headers()["set-cookie"]).toBeUndefined();
    const state = await withDb(db => db.query("select used_at from public.customer_portal_signin_codes where ref_hash=$1", [sha(pair.ref)]));
    expect(state.rows).toEqual([{ used_at: null }]);
    // Same exact code succeeds on a fresh IP, proving the limit did not consume it and the code was otherwise valid.
    const control = await fresh.post("/api/portal/signin/verify", { form: pair, maxRedirects: 0 });
    expect(control.status()).toBe(303); expect(control.headers()["location"]).toBe("/portal");
    expect(control.headers()["set-cookie"]).toContain("__Host-tolra_portal=");
    const used = await withDb(db => db.query("select used_at is not null as used from public.customer_portal_signin_codes where ref_hash=$1", [sha(pair.ref)]));
    expect(used.rows).toEqual([{ used: true }]);
  } finally { await limited.dispose(); await blocked.dispose(); await fresh.dispose(); }
});
