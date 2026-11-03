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

  it("labels every made-up example as Illustration and every real screenshot as Example data, and gives every image alt text", async () => {
    const { html, marketing } = await render({});
    // One drawn figure per feature, plus the two real screenshots (the Job Board in "What it does", the Dashboard in the owner's section).
    const figures = html.match(/<figure\b[\s\S]*?<\/figure>/g) ?? [];
    expect(figures).toHaveLength(marketing.FEATURES.length + marketing.SCREENSHOTS.length);
    const screenshots = figures.filter((figure) => /<img\b/.test(figure));
    expect(screenshots).toHaveLength(marketing.SCREENSHOTS.length + marketing.FEATURES.filter((feature) => feature.shot).length);
    for (const figure of figures) expect(text(figure)).toMatch(screenshots.includes(figure) ? /Example data\s*$/ : /Illustration\s*$/);
    // + the traveller, its short copy for phones (hidden from assistive tech) and the "How Tolra handles it" drawings
    expect(text(html).match(/Illustration/g)!.length).toBe(marketing.FEATURES.length + 3);
    const shots = marketing.FEATURES.filter((feature) => feature.shot).length;
    expect(text(html).match(/Example data/g)?.length ?? 0).toBe(marketing.SCREENSHOTS.length + shots);
    expect(text(html)).not.toContain("Screenshot");
    expect(text(html)).not.toContain("Demo data");
    // Real screenshots live in /public/screens only.
    for (const shot of marketing.SCREENSHOTS) expect(shot.src).toMatch(/^\/screens\//);
    // The screenshots are redacted: no pilot company or person is named in their alt text.
    for (const shot of marketing.SCREENSHOTS) expect(shot.alt).not.toMatch(/JNR|Marpet|Rhys/i);
    const images = html.match(/<img\b[^>]*>/g) ?? [];
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

  it("the sitemap lists the home page and the privacy page", async () => {
    const sitemap = (await import("@/app/sitemap")).default();
    expect(sitemap.map((entry) => entry.url)).toEqual(["https://tolra.co.uk/", "https://tolra.co.uk/privacy"]);
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

  it("FAQ: only the six questions, native details/summary, and the FAQPage JSON-LD describes exactly those", async () => {
    const { html, marketing } = await render({});
    expect(marketing.FAQ.map((item) => item.question)).toEqual([
      "How is it secured?", "Where is my data hosted?", "Is there a phone app?", "Can I export my data?", "Does it work with my accounts package?", "What does it cost?",
    ]);
    expect(html.match(/<details\b/g)).toHaveLength(6);
    expect(html.match(/<summary\b/g)).toHaveLength(6);
    const visible = text(html);
    expect(visible).toContain("I'll talk it through with you on the call.");
    expect(visible).toContain("In the UK. The database, sign-ins and stored files are in London, and the app runs on servers in London.");
    // N7 review: the Xero connection is in the code (lib/integrations, migration 084) but not confirmed in production use, so the page
    // calls it in development and promises nothing it sends or syncs. Nothing about any other accounts package.
    const xero = marketing.FAQ.find((item) => item.question === "Does it work with my accounts package?")!.answer;
    expect(xero).toBe("A Xero connection is in development with the pilot shops. Until then you can send your accountant exports, or invite them to see your company in Tolra, read only.");
    expect(visible).not.toMatch(/\b(?:Sage|QuickBooks)\b/);
    expect(visible).not.toContain("not yet");
    // No sentence that names Xero promises sending, syncing or "today".
    for (const sentence of visible.split(/(?<=[.?!])\s+/).filter((s) => /Xero/.test(s))) expect(sentence).not.toMatch(/\b(?:sent|sends?|sync\w*|go(?:es)? across|automatic\w*|today)\b/i);
    expect(marketing.SITE_DESCRIPTION).not.toMatch(/Xero/);
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!.replace(/\\u003c/g, "<"));
    const faq = ld.find((d: { "@type": string }) => d["@type"] === "FAQPage");
    expect(faq.mainEntity.map((q: { name: string }) => q.name)).toEqual(marketing.FAQ.map((item) => item.question));
    for (const item of marketing.FAQ) expect(visible).toContain(item.answer);
  });

  it("leaves out what is not proven: no Not-for section, no import or setup claims, no backups or GitHub, and a Privacy link", async () => {
    const { html } = await render({});
    const visible = text(html);
    expect(visible).not.toMatch(/\b(?:Not for|import|imports|migrat\w*|we set up|set up for you|backups?|GitHub)\b/i);
    expect(html).toMatch(/<a\b[^>]*href="\/privacy"[^>]*>Privacy<\/a>/);
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

  it("owner's section: the heading, the Xero line, every listed item, the Dashboard screen, and no AI helper or other package in it", async () => {
    const { html, marketing } = await render({});
    const section = html.match(/<section aria-labelledby="owner-title"[\s\S]*?<\/section>/)![0];
    const visible = text(section);
    expect(visible).toContain("See the patterns and numbers you didn't know you needed");
    expect(visible).toContain("Then send everything straight to your accountant.");
    expect(visible).toContain("A Xero connection is being built with the pilot shops.");
    expect(visible).not.toContain("Xero today");
    for (const row of marketing.OWNER_ROWS) for (const [name, what] of row.items) { expect(visible).toContain(name); expect(visible).toContain(what); }
    expect(section).toContain('src="/_next/image?url=%2Fscreens%2Ftolra-dashboard.jpg');
    expect(visible).not.toMatch(/\b(?:AI|Sage|QuickBooks)\b/);
    expect(visible).not.toMatch(/\d/);
    // The owner's section sits between "What it does" and the founder's note, on the pale blue band.
    expect(html.indexOf('aria-labelledby="features-title"')).toBeLessThan(html.indexOf('aria-labelledby="owner-title"'));
    expect(html.indexOf('aria-labelledby="owner-title"')).toBeLessThan(html.indexOf('aria-labelledby="builder-title"'));
    expect(section).toMatch(/^<section aria-labelledby="owner-title" class="mk-band mk-band-alt"/);
  });

  it("bands alternate white and pale blue down the page", async () => {
    const { html } = await render({});
    const bands = (html.match(/<(?:section|div)\b[^>]*class="mk-band[^"]*"/g) ?? []).map((tag) => tag.includes("mk-band-alt"));
    expect(bands.length).toBe(8);
    bands.forEach((alt, index) => expect(alt).toBe(index % 2 === 1));
  });

  it("In development: only the features and owner's-sheet lines flagged in the copy carry the tag, and the pilot note follows the features", async () => {
    const { html, marketing } = await render({});
    const tagged = marketing.FEATURES.filter((feature) => feature.inDevelopment).map((feature) => feature.title);
    expect(tagged).toEqual(["Optional AI helper"]);
    const sheetTagged = marketing.OWNER_ROWS.flatMap((row) => row.items.filter((item) => item[2]).map((item) => item[0]));
    expect(sheetTagged).toEqual(["Xero connection"]);
    expect(html.match(/class="mk-tag[^"]*">In development</g)).toHaveLength(tagged.length + sheetTagged.length);
    // The tag sits on the Xero line of the sheet.
    expect(html).toMatch(/Xero connection<\/dt><dd[^>]*><span class="mk-tag[^"]*">In development<\/span>/);
    expect(text(html)).toContain("Tolra is in pilot and still being developed with the shops using it.");
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
