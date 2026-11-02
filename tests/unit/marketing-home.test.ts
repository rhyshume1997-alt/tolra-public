/**
 * The public home page ("/"): its content rules (one proof line, no prices or numeric claims, structured data without offers or
 * ratings), the booking link, and that it renders cleanly whether or not the contact email and founder name are set.
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
  const page = await import("@/app/page");
  const marketing = await import("@/lib/marketing");
  return { html: renderToStaticMarkup(createElement(page.default)), marketing, metadata: page.metadata };
}

const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

afterEach(() => vi.unstubAllEnvs());

describe("home page content", () => {
  it("has exactly one h1, the proof line, and no prices or numeric claims", async () => {
    const { html, marketing } = await render({});
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain("Quotes, jobs and invoices for small CNC and fabrication shops");
    const visible = text(html);
    expect(visible).toContain("In pilot in two working shops, JNR Engineering and Marpet Fabrications.");
    expect(marketing.PROOF_LINE).toBe("In pilot in two working shops, JNR Engineering and Marpet Fabrications.");
    expect(visible).not.toMatch(/£|\$|€/);
    expect(visible).not.toMatch(/\d[\d.,]*\s*(?:hours?|hrs?|h)\b/i);
    expect(visible).not.toMatch(/\d\s*%/);
    expect(visible).not.toMatch(/\b(?:price|pricing|per month|testimonial)\b/i);
  });

  it("labels every mock as Demo data and gives every image alt text", async () => {
    const { html } = await render({});
    expect(text(html).match(/Demo data/g)!.length).toBeGreaterThanOrEqual(4);
    const images = html.match(/<img\b[^>]*>/g) ?? [];
    expect(images.length).toBeGreaterThanOrEqual(4);
    for (const image of images) expect(image).toMatch(/\balt="[^"]+"/);
  });

  it("the JSON-LD is SoftwareApplication and Organization, with no offers, price or ratings", async () => {
    const { html, marketing } = await render({});
    const scripts = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) ?? [];
    expect(scripts).toHaveLength(1);
    const data = JSON.parse(scripts[0]!.replace(/<\/?script[^>]*>/g, ""));
    expect(data.map((d: { "@type": string }) => d["@type"])).toEqual(["SoftwareApplication", "Organization"]);
    expect(data[0]).toMatchObject({ name: "Tolra", applicationCategory: "BusinessApplication" });
    const keys: string[] = [];
    const walk = (value: unknown) => { if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) { keys.push(key); walk(inner); } };
    walk(marketing.jsonLd());
    expect(keys.filter((key) => /^(?:offers?|price\w*|aggregateRating|rating\w*|review\w*)$/i.test(key))).toEqual([]);
  });

  it("metadata: index,follow, canonical and the static 1200x630 share image", async () => {
    const { metadata } = await render({});
    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.alternates?.canonical).toBe("https://tolra.co.uk/");
    expect(JSON.stringify(metadata.openGraph)).toContain("/marketing/tolra-og.png");
    expect(JSON.stringify(metadata.openGraph)).toContain('"width":1200');
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image" });
  });
});

describe("the booking link", () => {
  it("every call to action is the Google Calendar link, in a new tab, and there is no mailto or placeholder", async () => {
    const { html, marketing } = await render({ email: "owner@example.test" });
    expect(marketing.BOOKING_URL).toBe(BOOKING);
    const ctas = html.match(/<a\b[^>]*>Book a free 20-minute chat<\/a>/g) ?? [];
    expect(ctas.length).toBeGreaterThanOrEqual(2);
    for (const cta of ctas) {
      expect(cta).toContain(`href="${BOOKING}"`);
      expect(cta).toContain('target="_blank"');
      expect(cta).toContain('rel="noopener noreferrer"');
    }
    expect(html).not.toContain("subject=Tolra");
  });
});

describe("optional contact email and founder name", () => {
  it("both unset: no email line, no name, no empty links or dangling labels", async () => {
    const { html, marketing } = await render({});
    expect(marketing.CONTACT_EMAIL).toBe("");
    expect(marketing.FOUNDER_NAME).toBe("");
    const visible = text(html);
    expect(visible).not.toMatch(/Email\s*:/i);
    expect(html).not.toContain("mailto:");
    expect(visible).not.toMatch(/undefined|null/);
    expect(html).not.toMatch(/<a\b[^>]*>\s*<\/a>/);
    expect(html).not.toMatch(/<p[^>]*>\s*<\/p>/);
    expect(html).toContain("Built by an engineer in Glasgow");
    expect(html).toContain("Sign in");
    expect(html).toContain("&copy; Tolra".replace("&copy;", "©"));
  });

  it("both set: the email is a mailto link in the footer and the name is shown", async () => {
    const { html } = await render({ email: "owner@example.test", name: "Alex Example" });
    expect(html).toContain('<a href="mailto:owner@example.test"');
    expect(text(html)).toContain("Email: owner@example.test");
    expect(text(html)).toContain("Alex Example");
  });

  it("whitespace-only values count as unset", async () => {
    const { html } = await render({ email: "  ", name: " " });
    expect(html).not.toContain("mailto:");
    expect(text(html)).not.toMatch(/Email\s*:/i);
  });
});

describe("robots.txt and sitemap.xml sources", () => {
  it("robots allows the home page, disallows the app and /api, and names the sitemap", async () => {
    const robots = (await import("@/app/robots")).default();
    const rule = Array.isArray(robots.rules) ? robots.rules[0] : robots.rules;
    expect(rule.allow).toBe("/");
    for (const path of ["/dashboard", "/api/", "/jobs", "/quotes", "/admin"]) expect(rule.disallow).toContain(path);
    expect(rule.disallow).not.toContain("/");
    expect(robots.sitemap).toBe("https://tolra.co.uk/sitemap.xml");
  });

  it("the sitemap lists the home page only", async () => {
    const sitemap = (await import("@/app/sitemap")).default();
    expect(sitemap.map((entry) => entry.url)).toEqual(["https://tolra.co.uk/"]);
  });
});
