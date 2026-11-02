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

const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

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

  it("the JSON-LD is SoftwareApplication, Organization and FAQPage, with no offers, price or ratings", async () => {
    const { html, marketing } = await render({});
    const scripts = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) ?? [];
    expect(scripts).toHaveLength(1);
    const data = JSON.parse(scripts[0]!.replace(/<\/?script[^>]*>/g, ""));
    expect(data.map((d: { "@type": string }) => d["@type"])).toEqual(["SoftwareApplication", "Organization", "FAQPage"]);
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

describe("round 2 sections", () => {
  it("hero: the exact subhead, the booking CTA and a See how it works link to #flow-title (which exists)", async () => {
    const { html } = await render({});
    expect(text(html)).toContain("Every enquiry, quote, job and invoice in one place, so nothing gets lost between the office and the shop floor.");
    expect(html).toMatch(/<a\b[^>]*href="#flow-title"[^>]*>See how it works<\/a>/);
    expect(html).toMatch(/<h2 id="flow-title"/);
  });

  it("Sound familiar? has four pain cards, then who it's for and the three getting-started steps", async () => {
    const { html, marketing } = await render({});
    expect(text(html)).toContain("Sound familiar?");
    expect(marketing.PAIN_CARDS).toHaveLength(4);
    for (const card of marketing.PAIN_CARDS) expect(text(html)).toContain(card.title);
    expect(text(html)).toContain("Small CNC, machining and fabrication shops that are owner-run, with the office and the shop floor in the same building.");
    expect(marketing.START_STEPS.map((step) => step.title)).toEqual(["A 20-minute chat", "Set up your templates, machines and customers", "Run live jobs alongside your current system"]);
    expect(html.match(/<ol\b[^>]*>[\s\S]*?<\/ol>/g)!.some((list) => (list.match(/<li\b/g) ?? []).length === 3 && list.includes("A 20-minute chat"))).toBe(true);
  });

  it("FAQ: only the four questions, native details/summary, and the FAQPage JSON-LD describes exactly those", async () => {
    const { html, marketing } = await render({});
    expect(marketing.FAQ.map((item) => item.question)).toEqual(["How is it secured?", "Is there a phone app?", "Can I export my data?", "What does it cost?"]);
    expect(html.match(/<details\b/g)).toHaveLength(4);
    expect(html.match(/<summary\b/g)).toHaveLength(4);
    const visible = text(html);
    expect(visible).toContain("I'll talk it through with you on the call.");
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!.replace(/\\u003c/g, "<"));
    const faq = ld.find((d: { "@type": string }) => d["@type"] === "FAQPage");
    expect(faq.mainEntity.map((q: { name: string }) => q.name)).toEqual(marketing.FAQ.map((item) => item.question));
    for (const item of marketing.FAQ) expect(visible).toContain(item.answer);
  });

  it("leaves out everything not yet supplied or proven: no hosting, import, Xero/Sage, Not-for or privacy page", async () => {
    const { html } = await render({});
    const visible = text(html);
    expect(visible).not.toMatch(/\b(?:Xero|Sage|hosted|hosting|region|Not for|retention|controller)\b/i);
    expect(html).not.toContain('href="/privacy"');
  });

  it("first person everywhere: no we / our / us in the page's own words", async () => {
    const { html } = await render({});
    expect(text(html)).not.toMatch(/\b(?:we|we'll|we're|our|ours|us)\b/i);
  });

  it("trust strip: only the three verified items", async () => {
    const { html, marketing } = await render({});
    expect(marketing.TRUST_ITEMS).toEqual(["Admin two-step sign-in", "No tracking cookies on this page", "Built in Glasgow"]);
    for (const item of marketing.TRUST_ITEMS) expect(text(html)).toContain(item);
  });

  it("closing: the new heading, the CTA, and one line on the call", async () => {
    const { html, marketing } = await render({});
    expect(text(html)).toContain("Tell me how your shop runs and I'll show you whether Tolra fits.");
    expect(text(html)).not.toMatch(/No sales pressure/i);
    expect(text(html)).toContain(marketing.CLOSE_CALL_LINE);
  });

  it("job flow keeps the ARIA tabs pattern: one tablist, seven tabs, one selected with tabindex 0, a controlled tabpanel", async () => {
    const { html } = await render({});
    expect(html.match(/role="tablist"/g)).toHaveLength(1);
    const tabs = html.match(/<button\b[^>]*role="tab"[^>]*>/g) ?? [];
    expect(tabs).toHaveLength(7);
    expect(tabs.filter((tab) => tab.includes('aria-selected="true"'))).toHaveLength(1);
    expect(tabs.filter((tab) => tab.includes('tabindex="0"'))).toHaveLength(1);
    for (const tab of tabs) expect(tab).toContain('aria-controls="flow-panel"');
    expect(html).toMatch(/role="tabpanel"[^>]*id="flow-panel"|id="flow-panel"[^>]*role="tabpanel"/);
  });
});
