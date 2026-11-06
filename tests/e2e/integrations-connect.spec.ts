/**
 * Real-browser integration setup and emailed Xero invite flow, synthetic backend only.
 * Microsoft/platform cases remain; invite links carry22-character opaque references, never bearer tokens.
 * Codes and links come only from the local mock mailbox. Provider navigation is intercepted; no valid OAuth callback is invoked.
 * Proposal151 is prepared only after backend identity verification, never registered in the production release plan.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";

import { generatePassword } from "@/lib/password";

import { adminClient, signedInClient, withDb, verifyBackendIdentity } from "../support/fixtures";
import { enrolTotp, totpCode } from "../support/totp";
import { preparePost144Backend } from "../support/post-144-release-fixture";
import { E2E_MOCK_PORT } from "./paths";
import { asSeparateDevice, signIn, world } from "./helpers";

test.describe.configure({ mode: "serial" });

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const originOf = (baseURL: string | undefined) => new URL(baseURL ?? "http://localhost:3001").origin;
const MS_AUTHORIZE_PATH = /^\/[^/]+\/oauth2\/v2\.0\/authorize$/;
const INVITE_URL = /^(.+)\/api\/integrations\/invite\/([A-Za-z0-9_-]{22})$/;

/** Placeholder app details: never real, never sent anywhere. The secret's last 4 differ from every other 4 characters on the page. */
const microsoftApp = () => ({ clientId: `e2e-ms-client-${world().runId}`, secret: `ms~${world().runId}~secret~Z9xK`, last4: "Z9xK" });
const xeroApp = () => ({ clientId: `e2e-xero-client-${world().runId}`, secret: `xero~${world().runId}~secret~2vQp`, last4: "2vQp" });

type Person = { id: string; email: string; password: string };
let owner: Person;
let ownerSecret: string;
let lastCode = "";
let ownerContext: BrowserContext;
let ownerPage: Page;

/** A code that was not used a moment ago (a code is single-use inside its 30-second window). */
async function freshCode() {
  let code = totpCode(ownerSecret);
  while (code === lastCode) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    code = totpCode(ownerSecret);
  }
  lastCode = code;
  return code;
}

async function signInPlatformOwner(page: Page) {
  await asSeparateDevice(page);
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(owner.email);
  await page.getByLabel("Password", { exact: true }).fill(owner.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/mfa/, { timeout: 45_000 });
  await page.getByLabel("6-digit code").fill(await freshCode());
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(/\/platform/, { timeout: 30_000 });
}

const rows = <T extends Record<string, unknown>>(sql: string, args: unknown[] = []) => withDb((db) => db.query<T>(sql, args)).then((r) => r.rows);

/**
 * Removes what this spec writes: the platform's stored app details, and company beta's open Connect states and connect links. Replica
 * mode on the disposable database (as destroySyntheticWorld does), so the tables' statement guards and FK order do not matter.
 */
async function resetIntegrationState() {
  await withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local session_replication_role = replica");
      await db.query("delete from public.integration_app_credentials");
      await db.query("delete from public.integration_oauth_states where organization_id = $1", [world().tenants.beta.id]);
      await db.query("delete from public.integration_connect_invites where organization_id = $1", [world().tenants.beta.id]);
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

const betaCount = async (table: "integration_connect_invites" | "integration_oauth_states" | "integration_connections" | "integration_secrets") =>
  Number((await rows<{ n: string }>(`select count(*)::text as n from public.${table} where organization_id = $1`, [world().tenants.beta.id]))[0].n);

/** A redirect answer, not followed. */
async function noFollow(request: APIRequestContext, path: string) {
  const res = await request.get(path, { maxRedirects: 0 });
  return { res, location: res.headers()["location"] };
}

test.beforeAll(async ({ browser }) => {
  // Review-only151 is installed solely on the already identity-verified disposable backend, never registered as a release.
  await verifyBackendIdentity();
  await preparePost144Backend();
  await withDb(async db=>{
    const installed=(await db.query("select to_regprocedure('public.integration_invite_code_verify(text,text,text,text)') as fn")).rows[0].fn;
    if(!installed)await db.query(readFileSync('supabase/release/151_xero_invite_hardening.release.sql','utf8'));
    const checks=(await db.query(readFileSync('supabase/verify/xero_invite_hardening_151.sql','utf8'))).rows;
    expect(checks.length).toBeGreaterThan(0);expect(checks.every(row=>row.ok===true)).toBe(true);
    await db.query("NOTIFY pgrst, 'reload schema'");
  });
  await expect.poll(async()=>{const r=await adminClient().rpc('integration_invite_peek',{p_ref:'Z'.repeat(22)});return r.error?.code??null;}).toBeNull();
  const w = world();
  const email = `integrations-owner.${w.runId}@example.test`;
  const password = generatePassword(14);
  const { data, error } = await adminClient().auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "Integrations Owner" } });
  if (error || !data.user) throw new Error(error?.message);
  owner = { id: data.user.id, email, password };
  // A platform owner is a signed-in person with a profile; here it comes from a viewer membership of one test company, as in platform-new-company.spec.ts.
  expect((await adminClient().rpc("add_member", { p_org: w.tenants.alpha.id, p_email: owner.email, p_role: "viewer" })).data).toBe("member");
  ownerSecret = (await enrolTotp(await signedInClient(owner))).secret;
  lastCode = totpCode(ownerSecret);
  await withDb((db) => db.query("insert into security_audit.platform_admins (user_id, note) values ($1, 'synthetic platform owner (integrations connect)')", [owner.id]));
  await resetIntegrationState();
  ownerContext = await browser.newContext();
  ownerPage = await ownerContext.newPage();
  await signInPlatformOwner(ownerPage);
});

test.afterAll(async () => {
  await ownerContext?.close();
  await resetIntegrationState();
});

test("1. no app details anywhere: Xero and Microsoft 365 say 'Not set up yet' and Connect is disabled", async ({ page }) => {
  const beta = world().tenants.beta;
  await signIn(page, beta.users.admin);
  const status = await (await page.request.get("/api/integrations/status")).json();
  expect(status.db107).toBe(true);
  expect(status.microsoft).toEqual({ configured: false });

  await page.goto("/admin/integrations");
  // Guided page: the Microsoft 365 card is the setup card; its connection line carries "no mailbox" and "not set up" (it no longer has the long sentence).
  const card = page.getByTestId("setup-card-microsoft");
  await expect(card.getByTestId("connection-microsoft")).toHaveText("Connection: Not set up on this server");
  await expect(card.getByRole("button", { name: "Connect Microsoft 365" })).toBeDisabled();

  await expect(page.getByTestId("xero-status")).toBeVisible();
  if (!status.xero.configured) {
    await expect(page.getByTestId("xero-not-set-up")).toContainText("Not set up yet: Tolra's Xero connection is switched on at go-live. Nothing to do here.");
    await expect(page.getByRole("button", { name: "Connect to Xero" })).toBeDisabled();
    // With no app details the accountant's link is not offered either.
    await expect(page.getByTestId("xero-invite")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send the accountant a connect link" })).toHaveCount(0);
  } else {
    // XERO_CLIENT_ID / XERO_CLIENT_SECRET in the server's environment (the wt/e3-e2e placeholders) count as set up: the Xero half cannot be shown.
    test.info().annotations.push({ type: "note", description: "Xero is set up from the server environment: only the Microsoft half of 'Not set up yet' is checked." });
    await expect(page.getByTestId("xero-not-set-up")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Connect to Xero" })).toBeEnabled();
  }
  // On the guided page the Xero tools card under More (testid xero-status) carries the "Not connected" line; integrations-send-log.spec.ts reads it by that testid.
  await expect(page.getByText("Not connected")).toHaveCount(1);
  expect(await betaCount("integration_oauth_states")).toBe(0);
});

test("2. the platform owner saves the Microsoft client id and secret: the card shows the client id and the secret's last 4 only", async ({ baseURL }) => {
  const origin = originOf(baseURL);
  const app = microsoftApp();
  const page = ownerPage;
  await page.goto("/platform");
  const section = page.getByTestId("app-credentials");
  await expect(section.getByRole("heading", { name: "App connections" })).toBeVisible();
  const ms = section.locator('[data-provider="microsoft"]');
  await expect(page.getByTestId("app-credentials-microsoft-state")).toHaveText("Not set up yet.");
  // The exact redirect URI to register at Microsoft.
  await expect(ms.locator("code")).toHaveText(`${origin}/api/integrations/microsoft/callback`);
  await expect(ms.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

  await ms.getByLabel("Microsoft 365 client id", { exact: true }).fill(app.clientId);
  await ms.getByLabel("Microsoft 365 client secret", { exact: true }).fill(app.secret);
  await ms.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Microsoft 365 app details saved. Each company can now click Connect.")).toBeVisible();

  const state = page.getByTestId("app-credentials-microsoft-state");
  await expect(state).toContainText(app.clientId);
  await expect(state).toContainText(`secret ending ${app.last4}`);
  await expect(state).not.toContainText(app.secret.slice(0, -4));
  await expect(ms.getByLabel("Microsoft 365 client secret", { exact: true })).toHaveValue("");
  expect(await page.content()).not.toContain(app.secret);

  // A reload shows the same, and still not the secret.
  await page.reload();
  const again = page.getByTestId("app-credentials-microsoft-state");
  await expect(again).toContainText(app.clientId);
  await expect(again).toContainText(`secret ending ${app.last4}`);
  expect(await page.content()).not.toContain(app.secret);
  await expect(page.locator('[data-provider="microsoft"]').getByLabel("Microsoft 365 client secret", { exact: true })).toHaveValue("");

  // In the database: the client id, the last 4 and the ciphertext; never the secret.
  const [row] = await rows<{ client_id: string; client_secret_enc: string; client_secret_last4: string; redirect_uri: string; updated_by: string }>(
    "select client_id, client_secret_enc, client_secret_last4, redirect_uri, updated_by from public.integration_app_credentials where provider = 'microsoft'");
  expect(row).toMatchObject({ client_id: app.clientId, client_secret_last4: app.last4, redirect_uri: `${origin}/api/integrations/microsoft/callback`, updated_by: owner.id });
  expect(row.client_secret_enc).toMatch(/^v\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  expect(JSON.stringify(row)).not.toContain(app.secret);
  expect(row.client_secret_enc).not.toContain(app.secret);
});

test("3. the app-credentials API never returns the secret; a company admin, office and nobody signed in are refused", async ({ page, playwright, baseURL }) => {
  const origin = originOf(baseURL);
  const app = microsoftApp();
  const beta = world().tenants.beta;

  const res = await ownerPage.request.get("/api/integrations/app-credentials");
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toContain("no-store");
  const text = await res.text();
  expect(text).not.toContain(app.secret);
  expect(text).not.toContain(app.secret.slice(0, -4));
  expect(text).not.toMatch(/secret_enc|v1\./);
  const body = JSON.parse(text) as { db107: boolean; siteUrlSet: boolean; providers: Array<{ provider: string; stored: Record<string, string> | null; redirectUris: string[] }> };
  expect(body).toMatchObject({ db107: true, siteUrlSet: true });
  const microsoft = body.providers.find((p) => p.provider === "microsoft")!;
  expect(microsoft.stored).toEqual({ clientId: app.clientId, secretLast4: app.last4, updatedAt: expect.any(String) });
  expect(microsoft.redirectUris).toEqual([`${origin}/api/integrations/microsoft/callback`]);
  // The only key anywhere in the answer that mentions a secret is the last 4.
  const secretKeys: string[] = [];
  (function walk(value: unknown) {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { if (/secret/i.test(k)) secretKeys.push(k); walk(v); }
  })(body);
  expect(new Set(secretKeys)).toEqual(new Set(["secretLast4"]));

  // The company admin: 403 on read, save and remove, and nothing changed.
  await signIn(page, beta.users.admin);
  expect((await page.request.get("/api/integrations/app-credentials")).status()).toBe(403);
  const save = await page.request.post("/api/integrations/app-credentials", { data: { provider: "microsoft", clientId: "attacker-client", clientSecret: "attacker-secret" } });
  expect(save.status()).toBe(403);
  expect((await page.request.delete("/api/integrations/app-credentials?provider=microsoft")).status()).toBe(403);
  const [row] = await rows<{ client_id: string; client_secret_last4: string }>("select client_id, client_secret_last4 from public.integration_app_credentials where provider = 'microsoft'");
  expect(row).toEqual({ client_id: app.clientId, client_secret_last4: app.last4 });
  // The page for it is not theirs: no App connections on the admin's own Integrations page.
  await page.goto("/admin/integrations");
  await expect(page.getByTestId("app-credentials")).toHaveCount(0);

  // Office is refused too, and nobody signed in gets 401.
  const officePage = await page.context().browser()!.newPage();
  try {
    await signIn(officePage, beta.users.office);
    expect((await officePage.request.get("/api/integrations/app-credentials")).status()).toBe(403);
  } finally {
    await officePage.close();
  }
  const anonymous = await playwright.request.newContext({ baseURL });
  try {
    expect((await anonymous.get("/api/integrations/app-credentials")).status()).toBe(401);
    expect((await anonymous.post("/api/integrations/app-credentials", { data: { provider: "microsoft", clientId: "x", clientSecret: "y" } })).status()).toBe(401);
  } finally {
    await anonymous.dispose();
  }
});

test("4. the platform owner also saves placeholder Xero details (the accountant's link needs them): both redirect URIs are shown", async ({ baseURL }) => {
  const origin = originOf(baseURL);
  const app = xeroApp();
  const page = ownerPage;
  await page.goto("/platform");
  const xero = page.getByTestId("app-credentials").locator('[data-provider="xero"]');
  await expect(xero.locator("code")).toHaveText([`${origin}/api/integrations/xero/callback`, `${origin}/api/integrations/invite/callback`]);
  await xero.getByLabel("Xero client id", { exact: true }).fill(app.clientId);
  await xero.getByLabel("Xero client secret", { exact: true }).fill(app.secret);
  await xero.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Xero app details saved. Each company can now click Connect.")).toBeVisible();
  const state = page.getByTestId("app-credentials-xero-state");
  await expect(state).toContainText(app.clientId);
  await expect(state).toContainText(`secret ending ${app.last4}`);
  expect(await page.content()).not.toContain(app.secret);
  const [row] = await rows<{ client_secret_enc: string; client_secret_last4: string; redirect_uri: string }>(
    "select client_secret_enc, client_secret_last4, redirect_uri from public.integration_app_credentials where provider = 'xero'");
  expect(row).toMatchObject({ client_secret_last4: app.last4, redirect_uri: `${origin}/api/integrations/xero/callback` });
  expect(row.client_secret_enc).not.toContain(app.secret);
  // Microsoft's saved details are untouched.
  await expect(page.getByTestId("app-credentials-microsoft-state")).toContainText(microsoftApp().clientId);
});

test("5. the company admin's Microsoft Connect is enabled and goes to Microsoft's sign-in with the fixed redirect URI, a state and a code challenge", async ({ page, baseURL }) => {
  const origin = originOf(baseURL);
  const app = microsoftApp();
  const beta = world().tenants.beta;
  await signIn(page, beta.users.admin);

  // Anything bound for Microsoft or Xero is answered here, in the browser: nothing leaves the machine.
  const offBox: string[] = [];
  page.on("request", (request) => {
    if (/(^|\.)(microsoftonline|microsoft|live|xero)\.com$/.test(new URL(request.url()).hostname)) offBox.push(request.url());
  });
  await page.route(/^https:\/\/(login\.microsoftonline\.com|login\.xero\.com)\//, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>intercepted</title><p>intercepted</p>" }));

  expect((await (await page.request.get("/api/integrations/status")).json()).microsoft).toEqual({ configured: true });
  await page.goto("/admin/integrations");
  const card = page.getByTestId("setup-card-microsoft");
  await expect(card.getByTestId("connection-microsoft")).toHaveText("Connection: Not connected");
  const connect = card.getByRole("button", { name: "Connect Microsoft 365" });
  await expect(connect).toBeEnabled();

  const [request] = await Promise.all([page.waitForRequest((r) => r.url().startsWith("https://login.microsoftonline.com/")), connect.click()]);
  const url = new URL(request.url());
  expect(url.origin).toBe("https://login.microsoftonline.com");
  expect(url.pathname).toMatch(MS_AUTHORIZE_PATH);
  expect(url.searchParams.get("client_id")).toBe(app.clientId);
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("redirect_uri")).toBe(`${origin}/api/integrations/microsoft/callback`);
  expect(url.searchParams.get("scope")).toBe("offline_access User.Read Mail.Send Mail.Read"); // C1 (127): read-only inbox access too
  const state = url.searchParams.get("state") ?? "";
  expect(state.length).toBeGreaterThanOrEqual(20);
  expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(request.url()).not.toContain(app.secret); // the client secret never goes through the browser
  expect(url.searchParams.has("client_secret")).toBe(false);
  await expect(page.getByText("intercepted", { exact: true })).toBeVisible();
  expect(offBox).toEqual([request.url()]);

  // The server kept the state's hash and the encrypted verifier for ten minutes, as this admin, for this company.
  const states = await rows<{ state_hash: string; user_id: string; verifier_enc: string; consumed_at: string | null; ttl_s: number }>(
    "select state_hash, user_id, verifier_enc, consumed_at, extract(epoch from (expires_at - created_at))::int as ttl_s from public.integration_oauth_states where organization_id = $1 and provider = 'microsoft'",
    [beta.id]);
  expect(states).toHaveLength(1);
  expect(states[0]).toMatchObject({ state_hash: sha256(state), user_id: beta.users.admin.id, consumed_at: null });
  expect(states[0].ttl_s).toBeGreaterThanOrEqual(590);
  expect(states[0].ttl_s).toBeLessThanOrEqual(610);
  expect(states[0].verifier_enc).toMatch(/^v\d+\./);
  expect(JSON.stringify(states[0])).not.toContain(state);

  // The route itself (nothing followed): the same sign-in URL with a fresh state each time.
  const api = await page.request.post("/api/integrations/microsoft/connect");
  expect(api.status()).toBe(200);
  const second = new URL(((await api.json()) as { url: string }).url);
  expect(second.origin + second.pathname).toBe(url.origin + url.pathname);
  expect(second.searchParams.get("redirect_uri")).toBe(`${origin}/api/integrations/microsoft/callback`);
  expect(second.searchParams.get("state")).not.toBe(state);
  expect(second.searchParams.get("code_challenge")).not.toBe(url.searchParams.get("code_challenge"));
  expect(await betaCount("integration_oauth_states")).toBe(2);
  expect(await betaCount("integration_connections")).toBe(0);
});

test("6. the Microsoft callback with a bogus state sends the admin back with the error and stores no connection", async ({ page, playwright, baseURL }) => {
  const beta = world().tenants.beta;
  await signIn(page, beta.users.admin);
  const before = { states: await betaCount("integration_oauth_states"), connections: await betaCount("integration_connections"), secrets: await betaCount("integration_secrets") };
  expect(before.connections).toBe(0);

  const back = async (query: string) => {
    const { res, location } = await noFollow(page.request, `/api/integrations/microsoft/callback${query}`);
    expect(res.status(), query).toBe(303);
    const to = new URL(location, baseURL);
    expect(to.pathname, query).toBe("/admin/integrations");
    return to.searchParams.get("microsoft");
  };
  expect(await back("?code=not-a-real-code&state=not-a-real-state")).toBe("expired");
  expect(await back("?code=not-a-real-code")).toBe("invalid");
  expect(await back("?state=not-a-real-state")).toBe("invalid");
  expect(await back(`?code=x&state=${"s".repeat(201)}`)).toBe("invalid");
  expect(await back("?error=access_denied&state=not-a-real-state")).toBe("cancelled");
  expect(await back("?error=server_error&state=not-a-real-state")).toBe("refused");

  // Signed out: told to sign in, and the same bogus state is not even looked at.
  const anonymous = await playwright.request.newContext({ baseURL });
  try {
    const res = await anonymous.get("/api/integrations/microsoft/callback?code=not-a-real-code&state=not-a-real-state", { maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(new URL(res.headers()["location"], baseURL).searchParams.get("microsoft")).toBe("signed_out");
  } finally {
    await anonymous.dispose();
  }

  // Nothing stored; the real states from test 5 are neither used up nor removed.
  expect({ states: await betaCount("integration_oauth_states"), connections: await betaCount("integration_connections"), secrets: await betaCount("integration_secrets") })
    .toEqual({ states: before.states, connections: 0, secrets: 0 });
  expect(Number((await rows<{ n: string }>("select count(*)::text as n from public.integration_oauth_states where organization_id = $1 and consumed_at is not null", [beta.id]))[0].n)).toBe(0);

  // In the browser: back on the page, a plain-words message, the card unchanged and Connect still there.
  await page.goto("/api/integrations/microsoft/callback?code=not-a-real-code&state=not-a-real-state");
  await expect(page).toHaveURL(/\/admin\/integrations\?microsoft=expired/);
  await expect(page.getByText("That Connect took too long or was started elsewhere. Click Connect Microsoft 365 again.")).toBeVisible();
  const card = page.getByTestId("setup-card-microsoft");
  await expect(card.getByTestId("connection-microsoft")).toHaveText("Connection: Not connected");
  await expect(card.getByRole("button", { name: "Connect Microsoft 365" })).toBeEnabled();
});

test("7. emailed opaque reference, bound one-time code, scanner safety, replay, expiry and cancellation", async ({page,browser,playwright,baseURL})=>{
 const origin=originOf(baseURL),beta=world().tenants.beta;
 const redirect='https://tolra.example.test/api/integrations/invite/callback';
 // The browser app uses loopback HTTP, while the provider redirect remains exactly HTTPS-allowlisted. It is inspected, never followed.
 await withDb(db=>db.query("update integration_app_credentials set redirect_uri=$1 where provider='xero'",[redirect.replace('/invite/','/xero/')]));
 await signIn(page,beta.users.admin);await page.goto('/admin/integrations');
 const panel=page.getByTestId('xero-invite');let serial=0;
 type Mail={to:string[]|string;subject:string;text:string};
 const mail=async():Promise<Mail[]>=>{
  const response=await fetch(`http://127.0.0.1:${E2E_MOCK_PORT}/__emails`);expect(response.ok).toBe(true);
  return (await response.json() as Array<{body:Mail}>).map(m=>m.body);
 };
 const addressed=(m:Mail,to:string)=>[m.to].flat().includes(to);
 const makeLink=async()=>{
  const to=`accountant-${++serial}.${world().runId}@example.test`;
  await panel.getByLabel("Accountant's e-mail address").fill(to);
  const response=page.waitForResponse(r=>r.url().endsWith('/api/integrations/invite')&&r.request().method()==='POST');
  await panel.getByRole('button',{name:'E-mail the accountant a connect link'}).click();
  const answer=await response;expect(answer.status()).toBe(200);const body=await answer.json();
  await expect(panel.getByTestId('xero-invite-sent')).toContainText(to);
  await expect(panel.getByTestId('xero-invite-url')).toHaveCount(0);
  await expect.poll(async()=>(await mail()).filter(m=>addressed(m,to)&&m.text.includes('/api/integrations/invite/')).length).toBe(1);
  const message=(await mail()).find(m=>addressed(m,to)&&m.text.includes('/api/integrations/invite/'))!;
  const link=message.text.split(/\s+/).find(word=>INVITE_URL.test(word))!;expect(link).toBeTruthy();
  const parsed=INVITE_URL.exec(link)!;expect(parsed[1]).toBe(origin);const ref=parsed[2];
  expect(new URL(link).search).toBe('');expect(JSON.stringify(body)).not.toContain(ref);
  const [row]=await rows<{id:string;ref:string;recipient_email:string;token_hash:string|null;code_hash:string|null;used_at:string|null}>(
   'select id,ref,recipient_email,token_hash,code_hash,used_at from integration_connect_invites where ref=$1',[ref]);
  expect(row).toMatchObject({ref,recipient_email:to,token_hash:null,code_hash:null,used_at:null});
  return {to,ref,path:new URL(link).pathname,id:row.id};
 };
 const statesVia=(id:string)=>rows<{state_hash:string;user_id:string}>('select state_hash,user_id from integration_oauth_states where via_invite=$1',[id]);
 const address=()=>({'x-real-ip':`10.244.${serial}.${20+serial}`});
 const anon=await playwright.request.newContext({baseURL,extraHTTPHeaders:address()});
 try{
  const a=await makeLink();const count=(await mail()).length;
  for(let n=0;n<3;n++){
   const response=await anon.get(a.path,{maxRedirects:0});expect(response.status()).toBe(200);
   const html=await response.text();expect(html).toContain('E-mail me a code');expect(html).toContain('Code from the e-mail');expect(html).not.toContain(a.to);
  }
  expect((await mail()).length).toBe(count);expect(await statesVia(a.id)).toEqual([]);
  const cross=await anon.post(a.path,{form:{action:'send'},headers:{Origin:'https://attacker.example.test'},maxRedirects:0});expect(cross.status()).toBe(403);expect(await statesVia(a.id)).toEqual([]);
  expect((await anon.post(a.path,{form:{action:'unexpected'},headers:{Origin:origin},maxRedirects:0})).status()).toBe(400);
  expect((await anon.post(a.path,{form:{action:'verify',code:'not-a-code'},headers:{Origin:origin},maxRedirects:0})).status()).toBe(400);
  // A forwarded link cannot choose another recipient or start OAuth without the code delivered to its bound mailbox.
  const sent=await anon.post(a.path,{form:{action:'send',email:'attacker@example.test'},headers:{Origin:origin},maxRedirects:0});expect(sent.status()).toBe(200);
  const delivered=(await mail()).filter(m=>addressed(m,a.to)&&m.subject==='Your Tolra connect code');expect(delivered).toHaveLength(1);
  const digits=/\n\s*(\d{4}) (\d{4})\s*\n/.exec(delivered[0].text)!;expect(digits).not.toBeNull();const code=digits[1]+digits[2];
  expect(await sent.text()).not.toContain(code);expect(await statesVia(a.id)).toEqual([]);
  const stored=(await rows<{code_hash:string}>('select code_hash from integration_connect_invites where id=$1',[a.id]))[0];expect(stored.code_hash).toMatch(/^[0-9a-f]{64}$/);expect(stored.code_hash).not.toContain(code);
  const wrong=(code[0]==='0'?'1':'0')+code.slice(1);
  const refused=await anon.post(a.path,{form:{action:'verify',code:wrong},headers:{Origin:origin},maxRedirects:0});expect(refused.status()).toBe(400);expect(refused.headers().location).toBeUndefined();expect(await statesVia(a.id)).toEqual([]);
  const verified=await anon.post(a.path,{form:{action:'verify',code},headers:{Origin:origin},maxRedirects:0});expect(verified.status()).toBe(303);
  const url=new URL(verified.headers().location);expect(url.origin).toBe('https://login.xero.com');expect(url.searchParams.get('redirect_uri')).toBe(redirect);expect(url.searchParams.get('code_challenge_method')).toBe('S256');expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  for(const secret of [code,a.ref,xeroApp().secret])expect(url.href).not.toContain(secret);
  expect(await statesVia(a.id)).toEqual([{state_hash:sha256(url.searchParams.get('state')!),user_id:beta.users.admin.id}]);
  const replay=await anon.post(a.path,{form:{action:'verify',code},headers:{Origin:origin},maxRedirects:0});expect(replay.status()).toBe(404);expect(await statesVia(a.id)).toHaveLength(1);
  for(const ref of ['bad','A'.repeat(43),'Z'.repeat(22)])expect((await anon.get('/api/integrations/invite/'+ref,{maxRedirects:0})).status()).toBe(404);
  // Only an invalid callback is invoked: no valid state/code is ever sent to the provider.
  expect((await anon.get('/api/integrations/invite/callback',{maxRedirects:0})).status()).toBe(400);
  expect((await anon.get('/api/integrations/invite/callback?code=not-real&state=not-real',{maxRedirects:0})).status()).toBe(400);
 }finally{await anon.dispose();}
 // Actual browser forms: code is obtained from the local mock mailbox; Xero navigation is fulfilled before any HTTP leaves the machine.
 const b=await makeLink(),visitor=await browser.newContext({baseURL,extraHTTPHeaders:address()});
 try{
  const accountant=await visitor.newPage();await accountant.goto(b.path);
  await accountant.getByRole('button',{name:'E-mail me a code'}).click();
  await expect(accountant.getByRole('status')).toContainText("We've e-mailed a code");
  const message=(await mail()).find(m=>addressed(m,b.to)&&m.subject==='Your Tolra connect code')!;const code=/\n\s*(\d{4}) (\d{4})\s*\n/.exec(message.text)!;
  await accountant.getByLabel('Code from the e-mail').fill(code[1]+code[2]);
  let outbound='';await accountant.route('https://login.xero.com/**',async route=>{outbound=route.request().url();await route.fulfill({status:200,contentType:'text/plain',body:'intercepted'});});
  await accountant.getByRole('button',{name:'Continue to Xero'}).click();await expect(accountant.getByText('intercepted',{exact:true})).toBeVisible();
  expect(new URL(outbound).searchParams.get('redirect_uri')).toBe(redirect);expect(await statesVia(b.id)).toHaveLength(1);
 }finally{await visitor.close();}
 const c=await makeLink();await page.reload();const item=page.getByTestId('xero-open-invites').getByRole('listitem').filter({hasText:c.to});
 await item.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('dialog',{name:'Cancel this connect link?'}).getByRole('button',{name:'Cancel link'}).click();await expect(item).toHaveCount(0);
 const cancelled=(await rows<{revoked_at:string|null;revoked_by:string}>('select revoked_at,revoked_by from integration_connect_invites where id=$1',[c.id]))[0];expect(cancelled.revoked_at).not.toBeNull();expect(cancelled.revoked_by).toBe(beta.users.admin.id);
 expect((await page.request.delete('/api/integrations/invite?id='+c.id)).status()).toBe(404);expect((await page.request.delete('/api/integrations/invite?id=not-a-uuid')).status()).toBe(400);
 const expired=await makeLink();await withDb(db=>db.query("update integration_connect_invites set created_at=now()-interval '24 hours',expires_at=now()-interval '1 second' where id=$1",[expired.id]));
 const check=await playwright.request.newContext({baseURL,extraHTTPHeaders:address()});try{for(const i of [c,expired]){
  expect((await check.get(i.path,{maxRedirects:0})).status()).toBe(404);expect((await check.post(i.path,{form:{action:'send'},headers:{Origin:origin},maxRedirects:0})).status()).toBe(404);expect(await statesVia(i.id)).toEqual([]);
 }}finally{await check.dispose();}
 expect(await betaCount('integration_connections')).toBe(0);expect(await betaCount('integration_secrets')).toBe(0);
});

test("8. office cannot make a link or connect (403); workshop is sent away from the page; nobody signed in gets 401", async ({ page, browser, playwright, baseURL }) => {
  const beta = world().tenants.beta;
  const before = { invites: await betaCount("integration_connect_invites"), states: await betaCount("integration_oauth_states") };

  await signIn(page, beta.users.office);
  for (const path of ["/api/integrations/invite", "/api/integrations/microsoft/connect", "/api/integrations/xero/connect", "/api/integrations/microsoft/disconnect", "/api/integrations/xero/test"]) {
    expect((await page.request.post(path)).status(), `office ${path}`).toBe(403);
  }
  expect((await page.request.get("/api/integrations/status")).status()).toBe(403);
  expect((await page.request.delete("/api/integrations/invite?id=00000000-0000-4000-8000-000000000000")).status()).toBe(403);
  await page.goto("/admin/integrations");
  await expect(page).toHaveURL(/\/dashboard/);

  const workshop = await browser.newPage();
  try {
    await signIn(workshop, beta.users.workshop);
    for (const path of ["/api/integrations/invite", "/api/integrations/microsoft/connect"]) {
      expect((await workshop.request.post(path)).status(), `workshop ${path}`).toBe(403);
    }
    await workshop.goto("/admin/integrations");
    await expect(workshop).toHaveURL(/\/dashboard/);
    await expect(workshop.getByTestId("setup-card-microsoft")).toHaveCount(0);
  } finally {
    await workshop.close();
  }

  const anonymous = await playwright.request.newContext({ baseURL });
  try {
    for (const path of ["/api/integrations/invite", "/api/integrations/microsoft/connect"]) {
      expect((await anonymous.post(path)).status(), `signed out ${path}`).toBe(401);
    }
  } finally {
    await anonymous.dispose();
  }

  // Refused means nothing was written.
  expect({ invites: await betaCount("integration_connect_invites"), states: await betaCount("integration_oauth_states") }).toEqual(before);
});
