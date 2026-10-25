import { expect, test, type BrowserContext } from "@playwright/test";

import { shellColours } from "@/lib/brand-pending";
import { PRODUCT } from "@/lib/product";

import { signIn, world } from "./helpers";

/**
 * Brand flash (sign-in page and app shell). The sign-in page is rendered on the server in the company's branding, chosen by ?org,
 * the company subdomain or this device's tolra_brand cookie, so the product page ("Welcome back", the Tolra wordmark) never shows
 * first. After sign-in the shell's first paint already has the company's colours and never shows the company placeholder.
 */

const BRAND_COOKIE = "tolra_brand";

async function rememberBrand(context: BrowserContext, slug: string) {
  const url = test.info().project.use.baseURL ?? "http://localhost:3001";
  await context.addCookies([{ name: BRAND_COOKIE, value: slug, url, httpOnly: true, sameSite: "Lax" }]);
}

test.describe("sign-in page without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the server HTML is already the remembered company's page", async ({ page, context }) => {
    const alpha = world().tenants.alpha;
    await rememberBrand(context, alpha.slug);
    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Sign in to ${alpha.name}`);
    const html = await page.content();
    expect(html).toContain(`Sign in to ${alpha.name}`);
    expect(html).not.toContain("Welcome back");
  });

  test("a cookie naming an unknown company gets the neutral page", async ({ page, context }) => {
    await rememberBrand(context, `no-such-company-${world().runId}`);
    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome back");
    expect(await page.content()).not.toContain(world().tenants.alpha.name);
  });
});

test.describe("sign-in page with JavaScript", () => {
  test("never shows the product page before the company's", async ({ page, context }) => {
    const alpha = world().tenants.alpha;
    await rememberBrand(context, alpha.slug);
    // Records, from the very first parsed node, every time the product heading or wordmark is on the page before the company heading.
    await page.addInitScript(([product]) => {
      const seen: string[] = [];
      (window as unknown as { __brandSeen: string[] }).__brandSeen = seen;
      const check = () => {
        const headings = Array.from(document.querySelectorAll("h1")).map((node) => node.textContent?.trim() ?? "");
        const tenant = headings.some((text) => text.startsWith("Sign in to "));
        if (tenant && !seen.includes("tenant")) seen.push("tenant");
        if (seen.includes("tenant")) return;
        if (headings.includes("Welcome back")) seen.push("welcome-back");
        if (Array.from(document.querySelectorAll("p")).some((node) => node.textContent?.trim() === product)) seen.push("wordmark");
      };
      new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
      document.addEventListener("DOMContentLoaded", check);
    }, [PRODUCT.name]);
    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Sign in to ${alpha.name}`);
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => (window as unknown as { __brandSeen: string[] }).__brandSeen)).toEqual(["tenant"]);
  });

  test("signing in remembers the company on this device (slug only, httpOnly)", async ({ page, context }) => {
    const alpha = world().tenants.alpha;
    const remembered = page.waitForResponse((response) => response.url().endsWith("/api/branding/remember") && response.request().method() === "POST");
    await signIn(page, alpha.users.office);
    expect((await remembered).status()).toBe(200);
    const cookie = (await context.cookies()).find((entry) => entry.name === BRAND_COOKIE);
    expect(cookie?.value).toBe(alpha.slug);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
  });
});

test.describe("app shell after sign-in", () => {
  test("the server HTML already has the company's colours and the placeholder is never shown", async ({ page }) => {
    const alpha = world().tenants.alpha;
    await signIn(page, alpha.users.office);

    // The synthetic tenant sets no colours of its own: the shell wears the product's, never the neutral placeholder slate.
    const expected = shellColours({ brandPrimary: null, brandAccent: null }, false);
    const html = await (await page.request.get("/dashboard")).text();
    expect(html).toContain(`--brand:${expected.primary};--brand-accent:${expected.accent};--brand-ink:${expected.ink}`);

    await page.addInitScript(() => {
      (window as unknown as { __pendingSeen: boolean }).__pendingSeen = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="company-pending"]')) (window as unknown as { __pendingSeen: boolean }).__pendingSeen = true;
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto("/dashboard");
    await expect(page.getByText(alpha.name).first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => (window as unknown as { __pendingSeen: boolean }).__pendingSeen)).toBe(false);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--brand").trim().toLowerCase())).toBe(expected.primary.toLowerCase());
  });
});
