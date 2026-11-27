/**
 * Tooly on the public home page: the "Meet Tooly" copy keeps to what the app's AI pages say and its status (optional, off until an
 * admin switches it on, in pilot, suggestions only), the demo is real buttons with a live status, and the mascot is decorative
 * (hidden from assistive tech) unless it is given a label.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MeetTooly } from "@/components/marketing/meet-tooly";
import { ToolyMark } from "@/components/marketing/tooly-mark";
import { TOOLY_DEMO, TOOLY_FLOW_NOTES, TOOLY_INTRO, TOOLY_POINTS } from "@/lib/marketing";

const lines = [TOOLY_INTRO, TOOLY_DEMO.note, TOOLY_DEMO.enquiry, ...Object.values(TOOLY_DEMO.status), ...Object.values(TOOLY_FLOW_NOTES), ...TOOLY_POINTS.flatMap((p) => [p.title, p.detail])];

describe("Meet Tooly copy", () => {
  it("states the status plainly: optional, off until an admin switches it on, in pilot, suggestions only", () => {
    expect(TOOLY_INTRO).toMatch(/optional/);
    expect(TOOLY_INTRO).toMatch(/in pilot/);
    expect(TOOLY_INTRO).toMatch(/only suggests/);
    // The section shows the AI feature's own copy beside the intro: off until an admin switches it on, nothing saved until approved.
    const html = renderToStaticMarkup(createElement(MeetTooly));
    expect(html).toContain("It stays off until your admin switches it on");
    expect(html).toContain("nothing is saved until you approve it");
  });

  it("keeps the page's content rules: no prices or numbers, no we/our/us, no integrations or promises", () => {
    for (const line of lines) {
      expect(line).not.toMatch(/£|\$|€|\d\s*%/);
      expect(line).not.toMatch(/\b(?:we|we'll|we're|our|ours|us|price|pricing|testimonial|import|imports|backups?|GitHub|Xero|Sage|QuickBooks|automatic\w*|soon|coming)\b/i);
      expect(line).not.toContain("—");
    }
  });
});

describe("Tooly components", () => {
  it("the demo has one real button, a polite status and an Illustration label, and sends nothing", () => {
    const html = renderToStaticMarkup(createElement(MeetTooly));
    expect(html.match(/<button\b/g)).toHaveLength(1);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Illustration");
    expect(html).not.toMatch(/<form\b|<input\b|href="mailto:/);
  });

  it("is hidden from assistive tech by default and labelled when given a label", () => {
    const decorative = renderToStaticMarkup(createElement(ToolyMark, { size: 96 }));
    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).not.toContain('role="img"');
    const labelled = renderToStaticMarkup(createElement(ToolyMark, { size: 96, label: "Tooly waving" }));
    expect(labelled).toContain('role="img"');
    expect(labelled).toContain('aria-label="Tooly waving"');
    expect(labelled).not.toContain("aria-hidden");
  });

  it("renders every pose in place up front with width and height set, only one visible", () => {
    const html = renderToStaticMarkup(createElement(ToolyMark, { size: 120, pose: "point", poses: ["point", "think"] }));
    const images = html.match(/<img\b[^>]*>/g) ?? [];
    expect(images.length).toBeGreaterThanOrEqual(2);
    for (const image of images) expect(image).toMatch(/width="120"[^>]*height="120"|height="120"[^>]*width="120"/);
    expect(images.filter((i) => i.includes("opacity:1"))).toHaveLength(1);
  });
});
