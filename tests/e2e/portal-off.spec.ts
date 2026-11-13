/**
 * BOUNDARY (module 10): real disposable Portal-OFF server -> refusal without customer records or activation.
 * Runs its own isolated Portal-OFF server, alongside the ON spec without a shared harness change.
 * Shared harness, staff authentication, database security and feature defaults must remain unchanged.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { expect, test as base } from "@playwright/test";
import { verifyBackendIdentity } from "../support/fixtures";
import { asSeparateDevice, world } from "./helpers";
import { E2E_MOCK_PORT, E2E_BLOCKED_LOG } from "./paths";

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
        CUSTOMER_PORTAL_ENABLED: "false", PORTAL_SIGNIN_HMAC_KEY: key, REQUIRE_ADMIN_MFA: "false",
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
      await provide({ url, key, enabled: false });
    } finally {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await closed;
      clearTimeout(force);
    }
  }, { scope: "worker" }],
  baseURL: async ({ portalRuntime }, provide) => { await provide(portalRuntime.url); },
});

test.beforeAll(async ({ portalRuntime }) => {
  await verifyBackendIdentity();
  expect(portalRuntime.enabled).toBe(false);
});

test("Portal OFF refuses every customer page even with a customer-shaped cookie", async ({ page, baseURL }) => {
  await asSeparateDevice(page);
  await page.context().addCookies([{ name: "__Host-tolra_portal", value: "A".repeat(43), url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
  for (const route of ["/portal","/portal/signin","/portal/quotes","/portal/jobs",`/portal/code/${"A".repeat(22)}`]) {
    const response = await page.goto(route);
    expect(response!.status(),route).toBe(404);
    await expect(page.getByTestId("portal-home")).toHaveCount(0);
    await expect(page.getByTestId("portal-quotes")).toHaveCount(0);
    await expect(page.getByTestId("portal-jobs")).toHaveCount(0);
    await expect(page).not.toHaveURL(/\/login/);
  }
});

test("Portal OFF code refusals expose no reason or authentication cookie", async ({ page, baseURL }) => {
  await asSeparateDevice(page);
  const refused = [];
  for (const code of ["12345678","87654321"]) {
    const response = await page.request.post("/api/portal/signin/verify", { form: { ref: "A".repeat(22), code }, headers: { origin: baseURL! }, maxRedirects: 0 });
    expect(response.status()).toBe(303);
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(response.headers()["set-cookie"]).toBeUndefined();
    expect(await response.text()).toBe("");
    const location = new URL(response.headers().location,baseURL);
    expect(location.searchParams.get("c")).toMatch(/^[0-9a-f-]{36}$/);
    location.searchParams.delete("c");
    refused.push(location.pathname+location.search);
  }
  expect(refused[0]).toBe(refused[1]);
});
