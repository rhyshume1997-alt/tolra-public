/**
 * Admin > Integrations connect (migration 107, E2/E7): the Microsoft 365 card, Platform > App connections, and the accountant's Xero link.
 *
 * Nothing here reaches Xero or Microsoft. No spec step follows an off-box redirect: the sign-in URLs are read from the browser's own
 * navigation (page.route fulfils it before it leaves the machine) or from a redirect answer fetched with maxRedirects 0; the Microsoft
 * and Xero callbacks are only called with states and codes that cannot match anything, so no token exchange is ever attempted (a valid
 * state with a made-up code would make the server call the provider). The server's no-network guard blocks anything else.
 *
 * One flow, in order (serial): (1) a company admin with no app details anywhere sees "Not set up yet" and Connect disabled; (2)(3) the
 * platform owner enters the Microsoft client id and secret (placeholders): the card shows the client id and the secret's last 4 only, the
 * API never returns the secret, a company admin is refused; (4) the owner enters placeholder Xero details (for the accountant link);
 * (5) back as the admin, Microsoft Connect is enabled and goes to login.microsoftonline.com with the fixed redirect_uri, a state and a
 * code_challenge; (6) the callback with a bogus state sends the admin back with the error and stores no connection; (7) the accountant's
 * link: made by the admin (only its hash is stored), opened signed out (sent to Xero's authorize URL, not followed), single use, a bogus
 * token refused; (8) office cannot make a link or connect, workshop is sent away from the page.
 *
 * Stored app details are platform wide and only this spec writes them: they are removed again (with this spec's invites and states in
 * company beta) before and after the run. The world is read inside tests and hooks, never at import.
 */
import { createHash } from "node:crypto";

import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";

import { generatePassword } from "@/lib/password";

import { adminClient, signedInClient, withDb } from "../support/fixtures";
import { enrolTotp, totpCode } from "../support/totp";
import { asSeparateDevice, signIn, world } from "./helpers";

test.describe.configure({ mode: "serial" });

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const originOf = (baseURL: string | undefined) => new URL(baseURL ?? "http://localhost:3001").origin;
const MS_AUTHORIZE_PATH = /^\/[^/]+\/oauth2\/v2\.0\/authorize$/;
const INVITE_URL = /^(.+)\/api\/integrations\/invite\/([A-Za-z0-9_-]{43})$/;

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
  const card = page.getByTestId("microsoft-card");
  await expect(card.getByTestId("microsoft-status")).toContainText("No mailbox connected");
  await expect(card.getByTestId("microsoft-not-set-up")).toHaveText("Not set up yet: the owner must enter the Microsoft 365 app details.");
  await expect(card.getByRole("button", { name: "Connect Microsoft 365" })).toBeDisabled();

  await expect(page.getByTestId("xero-status")).toBeVisible();
  if (!status.xero.configured) {
    await expect(page.getByTestId("xero-not-set-up")).toHaveText("Not set up yet: the owner must enter the Xero app details.");
    await expect(page.getByRole("button", { name: "Connect to Xero" })).toBeDisabled();
    // With no app details the accountant's link is not offered either.
    await expect(page.getByTestId("xero-invite")).toContainText("Not set up yet");
    await expect(page.getByRole("button", { name: "Send the accountant a connect link" })).toHaveCount(0);
  } else {
    // XERO_CLIENT_ID / XERO_CLIENT_SECRET in the server's environment (the wt/e3-e2e placeholders) count as set up: the Xero half cannot be shown.
    test.info().annotations.push({ type: "note", description: "Xero is set up from the server environment: only the Microsoft half of 'Not set up yet' is checked." });
    await expect(page.getByTestId("xero-not-set-up")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Connect to Xero" })).toBeEnabled();
  }
  // The Xero card's own line is still the only "Not connected" on the page (integrations-send-log.spec.ts relies on that).
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
  const card = page.getByTestId("microsoft-card");
  await expect(card.getByTestId("microsoft-status")).toContainText("No mailbox connected");
  await expect(card.getByTestId("microsoft-not-set-up")).toHaveCount(0);
  const connect = card.getByRole("button", { name: "Connect Microsoft 365" });
  await expect(connect).toBeEnabled();

  const [request] = await Promise.all([page.waitForRequest((r) => r.url().startsWith("https://login.microsoftonline.com/")), connect.click()]);
  const url = new URL(request.url());
  expect(url.origin).toBe("https://login.microsoftonline.com");
  expect(url.pathname).toMatch(MS_AUTHORIZE_PATH);
  expect(url.searchParams.get("client_id")).toBe(app.clientId);
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("redirect_uri")).toBe(`${origin}/api/integrations/microsoft/callback`);
  expect(url.searchParams.get("scope")).toContain("Mail.Send");
  const state = url.searchParams.get("state") ?? "";
  expect(state.length).toBeGreaterThanOrEqual(20);
  expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
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
  const card = page.getByTestId("microsoft-card");
  await expect(card.getByTestId("microsoft-status")).toContainText("No mailbox connected");
  await expect(card.getByRole("button", { name: "Connect Microsoft 365" })).toBeEnabled();
});

test("7. the accountant's link: made by the admin, hashed in the database, opens signed out onto Xero's sign-in once only; a bogus token is refused", async ({ page, playwright, baseURL }) => {
  const origin = originOf(baseURL);
  const app = xeroApp();
  const beta = world().tenants.beta;
  await signIn(page, beta.users.admin);
  await page.goto("/admin/integrations");
  const panel = page.getByTestId("xero-invite");
  await panel.getByRole("button", { name: "Send the accountant a connect link" }).click();
  const url = await panel.getByTestId("xero-invite-url").inputValue();
  const parsed = INVITE_URL.exec(url);
  expect(parsed, url).not.toBeNull();
  expect(parsed![1]).toBe(origin); // built on the site address, not on a request header
  const token = parsed![2];
  await expect(panel).toContainText("Works once");

  // The token is in the link only: the database keeps its SHA-256, for 24 hours, unused.
  const invites = await rows<Record<string, unknown> & { id: string; token_hash: string; created_by: string; used_at: string | null; hours: number }>(
    "select i.*, extract(epoch from (expires_at - created_at))::numeric / 3600 as hours from public.integration_connect_invites i where organization_id = $1", [beta.id]);
  expect(invites).toHaveLength(1);
  const invite = invites[0];
  expect(invite).toMatchObject({ token_hash: sha256(token), created_by: beta.users.admin.id, used_at: null, provider: "xero" });
  expect(Number(invite.hours)).toBeGreaterThan(23.9);
  expect(Number(invite.hours)).toBeLessThanOrEqual(24);
  expect(JSON.stringify(invite)).not.toContain(token);
  expect(invite.token_hash).not.toBe(token);

  const anonymous = await playwright.request.newContext({ baseURL });
  try {
    // Signed out, first open: straight to Xero's authorize URL (read, not followed).
    const first = await noFollow(anonymous, `/api/integrations/invite/${token}`);
    expect(first.res.status()).toBe(303);
    const xero = new URL(first.location);
    expect(xero.origin + xero.pathname).toBe("https://login.xero.com/identity/connect/authorize");
    expect(xero.searchParams.get("client_id")).toBe(app.clientId);
    expect(xero.searchParams.get("response_type")).toBe("code");
    expect(xero.searchParams.get("redirect_uri")).toBe(`${origin}/api/integrations/invite/callback`); // the accountant's own callback
    const state = xero.searchParams.get("state") ?? "";
    expect(state.length).toBeGreaterThanOrEqual(20);
    expect(xero.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(xero.searchParams.get("code_challenge_method")).toBe("S256");
    expect(first.location).not.toContain(app.secret);
    expect(first.location).not.toContain(token);

    // Used up, with one state kept for it (bound to the company and the admin who made the link).
    const [used] = await rows<{ used_at: string | null }>("select used_at from public.integration_connect_invites where id = $1", [invite.id]);
    expect(used.used_at).not.toBeNull();
    const states = await rows<{ state_hash: string; user_id: string; provider: string }>(
      "select state_hash, user_id, provider from public.integration_oauth_states where via_invite = $1", [invite.id]);
    expect(states).toEqual([{ state_hash: sha256(state), user_id: beta.users.admin.id, provider: "xero" }]);

    // The same link again: refused with a fixed page, nothing redirected, no second state.
    const second = await anonymous.get(`/api/integrations/invite/${token}`, { maxRedirects: 0 });
    expect(second.status()).toBe(404);
    expect(second.headers()["location"]).toBeUndefined();
    expect(await second.text()).toContain("This link can't be used");
    expect(second.headers()["content-type"]).toContain("text/html");

    // Bogus tokens: the wrong shape, and the right shape that no one made. Both 404, and neither starts anything.
    for (const bogus of ["not-a-token", "A".repeat(43), "A".repeat(44), `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`]) {
      const res = await anonymous.get(`/api/integrations/invite/${bogus}`, { maxRedirects: 0 });
      expect(res.status(), bogus).toBe(404);
      expect(res.headers()["location"], bogus).toBeUndefined();
    }
    expect(Number((await rows<{ n: string }>("select count(*)::text as n from public.integration_oauth_states where via_invite is not null and organization_id = $1", [beta.id]))[0].n)).toBe(1);

    // The accountant's callback with nothing it can match: a fixed page, nothing connected (no code exchange is attempted).
    expect((await anonymous.get("/api/integrations/invite/callback", { maxRedirects: 0 })).status()).toBe(400);
    const stale = await anonymous.get("/api/integrations/invite/callback?code=not-a-real-code&state=not-a-real-state", { maxRedirects: 0 });
    expect(stale.status()).toBe(409);
    expect(await stale.text()).toContain("That took too long");
    expect(await betaCount("integration_connections")).toBe(0);
    expect(await betaCount("integration_secrets")).toBe(0);
  } finally {
    await anonymous.dispose();
  }
});

test("8. office cannot make a link or connect (403); workshop is sent away from the page; nobody signed in gets 401", async ({ page, browser, playwright, baseURL }) => {
  const beta = world().tenants.beta;
  const before = { invites: await betaCount("integration_connect_invites"), states: await betaCount("integration_oauth_states") };

  await signIn(page, beta.users.office);
  for (const path of ["/api/integrations/invite", "/api/integrations/microsoft/connect", "/api/integrations/xero/connect", "/api/integrations/microsoft/disconnect", "/api/integrations/xero/test"]) {
    expect((await page.request.post(path)).status(), `office ${path}`).toBe(403);
  }
  expect((await page.request.get("/api/integrations/status")).status()).toBe(403);
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
    await expect(workshop.getByTestId("microsoft-card")).toHaveCount(0);
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
