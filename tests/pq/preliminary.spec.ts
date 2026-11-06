import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { SyntheticWorld } from "../support/fixtures";
import { verifyBackendIdentity, withDb } from "../support/fixtures";
import { assertLocalKey, assertLoopbackUrl, gitSha, type IsolatedBackend } from "../support/isolation";
import { totpCode } from "../support/totp";

const accounts = () => JSON.parse(readFileSync("tests/pq/.runtime/accounts.json", "utf8")) as { world: SyntheticWorld; totpSecret: string; records: Record<string, string> };
function backend(): IsolatedBackend {
  const s = JSON.parse(execFileSync(process.env.SUPABASE_BIN || "supabase", ["status", "--workdir", "tests/pq/.runtime", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  expect(s.API_URL).toBe("http://127.0.0.1:55321");
  const u = new URL(s.DB_URL); expect(u.hostname).toBe("127.0.0.1"); expect(u.port).toBe("55322");
  return { apiUrl: assertLoopbackUrl("PQ API", s.API_URL), databaseUrl: s.DB_URL, anonKey: assertLocalKey("PQ anon", s.ANON_KEY), serviceRoleKey: assertLocalKey("PQ service", s.SERVICE_ROLE_KEY) };
}
async function signIn(page: Page, role: "admin" | "workshop") {
  const a = accounts(); const user = a.world.tenants.alpha.users[role];
  if (role === "admin") {
    // A separate real MFA challenge gets a fresh code window, never a bypass or replay.
    const previous = totpCode(a.totpSecret);
    while (totpCode(a.totpSecret) === previous) await page.waitForTimeout(1000);
  }
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/(mfa|select-role|dashboard)/);
  if (page.url().includes("/mfa")) {
    await page.getByLabel("6-digit code").fill(totpCode(a.totpSecret));
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForURL(/\/(select-role|dashboard)/);
  }
  if (page.url().includes("/select-role")) await page.getByRole("button", { name: role === "admin" ? "Continue as Admin" : "Continue as Workshop" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}
async function financialSnapshot(b: IsolatedBackend) {
  return withDb(async db => {
    await db.query("BEGIN READ ONLY");
    try {
      const org = accounts().world.tenants.alpha.id;
      const invoices = (await db.query("SELECT invoice_ref,subtotal::text,vat::text,total::text,status,amount_paid::text FROM public.invoices WHERE organization_id=$1 ORDER BY invoice_ref", [org])).rows;
      const quotes = (await db.query("SELECT quote_ref,status,total_value::text FROM public.quotes WHERE organization_id=$1 ORDER BY quote_ref", [org])).rows;
      const delivery = (await db.query("SELECT dn_number,status,signed_at FROM public.delivery_notes WHERE organization_id=$1 ORDER BY dn_number", [org])).rows;
      return { invoices, quotes, delivery };
    } finally { await db.query("ROLLBACK"); }
  }, b);
}

test("PRELIMINARY: execute the twelve fake PQ run-sheet checks on the exact source SHA", async ({ page }) => {
  const b = backend(); const identity = await verifyBackendIdentity(b);
  const before = await financialSnapshot(b);
  const rows = Array.from({ length: 12 }, (_, i) => ({ step: i + 1, status: "NOT RUN", screenshot: "", failure: "" }));
  const receipt = { status: "PRELIMINARY", sourceSha: gitSha(), candidateSha: null, identity, syntheticOnly: true,
    startedAt: new Date().toISOString(), rows, financialRowsUnchanged: false,
    unchecked: ["Final candidate SHA", "John's physical devices", "Physical printer", "Human acceptance/signatures", "Live provider consent or delivery", "Full agreed validation pack beyond this twelve-step fixture"] };
  mkdirSync("tests/pq/results", { recursive: true }); mkdirSync("tests/pq/screenshots/preliminary", { recursive: true });
  const save = () => writeFileSync("tests/pq/results/preliminary.json", JSON.stringify(receipt, null, 2));
  await page.context().route("**/*", async route => {
    const host = new URL(route.request().url()).hostname;
    if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) await route.continue(); else await route.abort("blockedbyclient");
  });
  async function check(step: number, title: string, fn: () => Promise<void>) {
    try {
      await test.step(`${step}. ${title}`, fn);
      const screenshot = `tests/pq/screenshots/preliminary/${String(step).padStart(2,"0")}.png`;
      await page.screenshot({ path: screenshot, fullPage: true });
      rows[step - 1] = { step, status: "PASS", screenshot, failure: "" };
    } catch (e) {
      // Never photograph a failed sign-in/MFA screen. Later fixture pages contain synthetic business data only.
      const screenshot = step > 1 ? `tests/pq/screenshots/preliminary/${String(step).padStart(2,"0")}-failed.png` : "";
      if (screenshot) await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
      rows[step - 1] = { step, status: "FAIL", screenshot, failure: e instanceof Error ? e.name : "Error" };
      throw e;
    } finally { save(); }
  }
  const close = () => page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).first().click();
  try {
    await check(1, "admin sign-in and correct fake company", async () => { await signIn(page, "admin"); await expect(page.getByText("FAKE JNR Engineering PQ", { exact: true }).first()).toBeVisible(); });
    await check(2, "fake customers", async () => { await page.goto("/customers"); await expect(page.getByText("FAKE Pump Customer Ltd", { exact: true }).first()).toBeVisible(); await expect(page.getByText("FAKE Shaft Customer Ltd", { exact: true }).first()).toBeVisible(); });
    await check(3, "143 rate values", async () => {
      await page.goto("/settings"); const panel = page.getByRole("region", { name: "Costing rates", exact: true });
      await expect(panel.getByLabel("Labour £ per hour", { exact: true })).toHaveValue("20");
      await expect(panel.getByLabel(/^Price £ /)).toHaveValue("4.5");
      await expect(panel.getByLabel(/^Machine £ per hour /)).toHaveValue("45");
      await expect(panel.getByLabel("Overhead %", { exact: true })).toHaveValue("150");
    });
    await check(4, "quote line and totals", async () => {
      await page.goto("/quotes"); await page.getByRole("button", { name: /^View(?: QUO-PQ-0001)?$/ }).first().click();
      const dialog = page.getByRole("dialog"); await expect(dialog).toContainText("FAKE-PART-BRACKET"); await expect(dialog).toContainText("£150.00");
    }); await close();
    await check(5, "customer PO and linked job", async () => {
      await page.goto("/sales-orders"); await page.getByRole("row").filter({ hasText: "FAKE-CUSTOMER-PO-0001" }).getByRole("button", { name: "View", exact: true }).click();
      await expect(page.getByRole("dialog")).toContainText("FAKE-CUSTOMER-PO-0001"); await expect(page.getByRole("dialog")).toContainText("J-PQ-0001");
    }); await close();
    await check(6, "actual costs and no invented profit", async () => {
      await page.goto("/jobs"); await page.getByRole("row").filter({ hasText: "J-PQ-0001" }).getByRole("button", { name: "Worksheet", exact: true }).click();
      const costs = page.getByTestId("actual-job-costing"); await expect(costs).toContainText("£30.00"); await expect(costs).toContainText("£20.00"); await expect(costs).toContainText("£10.00"); await expect(costs).toContainText("No issued invoice");
    }); await close();
    await check(7, "missing costs are unavailable", async () => {
      await page.getByRole("row").filter({ hasText: "J-PQ-NO-COST" }).getByRole("button", { name: "Worksheet", exact: true }).click();
      await expect(page.getByTestId("actual-costing-incomplete")).toContainText("Incomplete"); await expect(page.getByTestId("actual-job-costing")).toContainText("Not available");
    }); await close();
    await check(8, "pending delivery print output", async () => {
      await page.goto(`/delivery-notes/${accounts().records.delivery}/print`);
      await expect(page.getByText("DLN-PQ-0001", { exact: false }).first()).toBeVisible();
      await expect(page.getByText("FAKE-PART-BRACKET", { exact: false }).first()).toBeVisible();
      await page.pdf({ path: "tests/pq/results/preliminary-delivery.pdf", format: "A4" });
    });
    await check(9, "draft invoice totals", async () => {
      await page.goto("/invoices"); await page.getByRole("button", { name: "View", exact: true }).first().click();
      const dialog = page.getByRole("dialog"); await expect(dialog).toContainText("INV-PQ-0001"); await expect(dialog).toContainText("£150.00"); await expect(dialog).toContainText("£25.00");
    }); await close();
    await check(10, "approval remains a draft", async () => { await page.goto("/approval"); await expect(page.getByText("SYNTHETIC PQ: invoice approval draft", { exact: true }).first()).toBeVisible(); });
    await check(11, "provider cards unconfigured and AI off", async () => {
      await page.goto("/admin/integrations"); await expect(page.getByText("Microsoft 365", { exact: true }).first()).toBeVisible(); await expect(page.getByText("Xero", { exact: true }).first()).toBeVisible();
      await expect(page.getByText(/Not set up/).first()).toBeVisible();
      await withDb(async db => {
        expect((await db.query("SELECT count(*)::int n FROM public.integration_connections")).rows[0].n).toBe(0);
        expect((await db.query("SELECT count(*)::int n FROM public.ai_helper_settings WHERE roundup_enabled OR rfq_enabled OR assistant_enabled")).rows[0].n).toBe(0);
      }, b);
    });
    await check(12, "workshop login, schedule and financial restrictions", async () => {
      await page.context().clearCookies(); await signIn(page, "workshop"); await page.setViewportSize({ width: 1024, height: 768 });
      await page.goto("/jobs"); await expect(page.getByText("J-PQ-0001", { exact: true }).first()).toBeVisible();
      await page.getByRole("row").filter({ hasText: "J-PQ-0001" }).getByRole("button", { name: "Worksheet", exact: true }).click();
      await expect(page.getByTestId("actual-job-costing")).toHaveCount(0); await close();
      expect((await page.request.get("/api/integrations/app-credentials")).status()).toBe(403);
      await page.goto("/schedule"); await expect(page.getByText("FAKE CNC Mill", { exact: false }).first()).toBeVisible();
    });
    expect(await financialSnapshot(b)).toEqual(before); receipt.financialRowsUnchanged = true;
  } finally { save(); }
});
