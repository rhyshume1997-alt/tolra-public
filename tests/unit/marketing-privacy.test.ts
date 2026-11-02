/**
 * The public privacy page ("/privacy"): indexable with a canonical, in the sitemap, linked from "/", first person only, no backups or
 * GitHub, and clean whether or not the contact email and founder name are set.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const BOOKING = "https://calendar.google.com/calendar/appointments/AcZssZ35nSQ_2lobUifPsul__TiweHpPV1aRWuWbssQ=";

async function render(env: { email?: string; name?: string }) {
  vi.resetModules();
  vi.unstubAllEnvs();
  if (env.email !== undefined) vi.stubEnv("NEXT_PUBLIC_CONTACT_EMAIL", env.email);
  if (env.name !== undefined) vi.stubEnv("NEXT_PUBLIC_FOUNDER_NAME", env.name);
  const page = await import("@/app/privacy/page");
  const home = await import("@/app/page");
  return {
    html: renderToStaticMarkup(createElement(page.default)),
    homeHtml: renderToStaticMarkup(createElement(home.default)),
    metadata: page.metadata,
  };
}

const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

afterEach(() => vi.unstubAllEnvs());

describe("/privacy metadata, sitemap and robots", () => {
  it("is indexable with a canonical, a title and a description", async () => {
    const { metadata } = await render({});
    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.alternates?.canonical).toBe("https://tolra.co.uk/privacy");
    expect(JSON.stringify(metadata.title)).toContain("Privacy");
    expect(String(metadata.description).length).toBeGreaterThan(20);
  });

  it("is in the sitemap and not disallowed by robots", async () => {
    const sitemap = (await import("@/app/sitemap")).default();
    expect(sitemap.map((entry) => entry.url)).toContain("https://tolra.co.uk/privacy");
    const robots = (await import("@/app/robots")).default();
    const rule = Array.isArray(robots.rules) ? robots.rules[0] : robots.rules;
    const disallow = ([] as string[]).concat(rule.disallow ?? []);
    expect(disallow.some((path) => "/privacy".startsWith(path))).toBe(false);
  });

  it("is linked from the footer of the home page and of /privacy itself", async () => {
    const { html, homeHtml } = await render({});
    for (const page of [html, homeHtml]) expect(page).toMatch(/<a\b[^>]*href="\/privacy"[^>]*>Privacy<\/a>/);
    expect(text(homeHtml)).toContain("Privacy: I only use the details you send me to reply to your enquiry");
  });
});

describe("/privacy content", () => {
  it("has one h1, plain h2 headings, the updated date and every required statement", async () => {
    const { html } = await render({});
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    const headings = (html.match(/<h2\b[^>]*>[\s\S]*?<\/h2>/g) ?? []).map((h) => text(h).trim());
    expect(headings).toEqual(["Who I am", "What this site collects", "Using Tolra (the app)", "Where it's stored", "Services I use", "How long I keep it", "Your rights and contact"]);
    const visible = text(html);
    expect(visible).toContain("Last updated: 2 November 2026.");
    expect(visible).toContain("This site sets no tracking cookies and runs no analytics.");
    expect(visible).toContain("is the controller of those records. I process them only to run Tolra for that company.");
    expect(visible).toContain("In the UK. The database, sign-ins and stored files are with Supabase in London, and the app runs on Vercel's servers in London.");
    for (const service of ["Supabase", "Vercel", "Resend", "Google Calendar"]) expect(visible).toContain(service);
    expect(visible).toContain("It is a US company");
    expect(visible).toContain("only as long as I need them to reply to you and to keep reasonable business records. Ask me and I'll delete them.");
    expect(visible).toContain("can ask me for an export of its data and for its data to be deleted, and I'll do both promptly.");
    expect(visible).toContain("Financial records a company must keep by law are its own to export and keep.");
    expect(visible).not.toMatch(/\b(?:12 months|30 days|90 days)\b/);
    expect(visible).toContain("You can ask to see, correct or delete your details.");
    expect(visible).toContain("ask that company first, and I'll help them");
  });

  it("is first person only, has no backups or GitHub, no prices or numeric claims", async () => {
    for (const env of [{}, { email: "owner@example.test", name: "Alex Example" }]) {
      const { html } = await render(env);
      const visible = text(html);
      // "us" is checked in lower case only: the copy says "a US company" (Resend), which is the country, not the pronoun.
      expect(visible).not.toMatch(/\b(?:we|we'll|we're|we've|our|ours)\b/i);
      expect(visible).not.toMatch(/\bus\b/);
      expect(visible).not.toMatch(/\b(?:backups?|GitHub)\b/i);
      expect(visible).not.toMatch(/£|\$|€/);
      expect(visible).not.toMatch(/\d\s*%/);
    }
  });
});

describe("/privacy with and without the founder name and contact email", () => {
  it("both unset: 'run by Tolra, which is', the booking link instead of an email, no gaps", async () => {
    const { html } = await render({});
    const visible = text(html);
    expect(visible).toContain("This site and Tolra are run by Tolra, which is the controller for the details you send through this site.");
    expect(html).not.toContain("mailto:");
    expect(visible).not.toMatch(/Email\s*:/i);
    expect(html).toMatch(new RegExp(`<a\\b[^>]*href="${BOOKING}"[^>]*>the booking link</a>`));
    expect(html).toMatch(/To ask, use <a [^>]*>the booking link<\/a> and tell me what you need\./);
    expect(visible).not.toMatch(/undefined|null|\{|\}/);
    expect(visible).not.toMatch(/ ,|, ,|\(\s*\)|\bby\s*,|\bat\s*\./);
    expect(html).not.toMatch(/<a\b[^>]*>\s*<\/a>/);
    expect(html).not.toMatch(/<p[^>]*>\s*<\/p>/);
    expect(html).not.toMatch(/<li[^>]*>\s*<\/li>/);
  });

  it("both set: the name sits in the sentence and the email is a mailto link in the contact line", async () => {
    const { html } = await render({ email: "owner@example.test", name: "Alex Example" });
    const visible = text(html);
    expect(visible).toContain("This site and Tolra are run by Alex Example, trading as Tolra, who is the controller for the details you send through this site.");
    expect(html).toContain('<a href="mailto:owner@example.test"');
    expect(html).toMatch(/To ask, email me at <a [^>]*href="mailto:owner@example\.test"[^>]*>owner@example\.test<\/a>\./);
    expect(html).not.toContain(BOOKING);
  });

  it("whitespace-only values count as unset", async () => {
    const { html } = await render({ email: "  ", name: " " });
    const visible = text(html);
    expect(visible).toContain("run by Tolra, which is the controller");
    expect(html).not.toContain("mailto:");
    expect(visible).toContain("the booking link");
  });
});
