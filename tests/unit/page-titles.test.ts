import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { MEMBER_SECTIONS } from "@/lib/sections";

/** Rhys: each page's H1 is exactly its menu label. These read the source so a renamed menu item cannot drift from its page. */
const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

const sidebar = read("components/sidebar.tsx");
const topbar = read("components/topbar.tsx");
const menu = [...sidebar.matchAll(/href: "(\/[^"]*)", label: "([^"]+)"/g)].map((m) => ({ href: m[1], label: m[2] }));
const topbarTitles = Object.fromEntries([...topbar.matchAll(/^\s+"(\/[^"]*)": "([^"]+)",$/gm)].map((m) => [m[1], m[2]]));

/** The file whose H1 is the page's title. Weekly hours has its H1 in the component both tabs share. */
const pageFile: Record<string, string[]> = {
  "/dashboard": ["app/(dashboard)/dashboard/page.tsx"],
  "/time": ["components/time/day-sheet.tsx", "components/time/week-review.tsx"],
};
const fileFor = (href: string) => pageFile[href] ?? [`app/(dashboard)${href}/page.tsx`];

describe("menu labels and page titles agree", () => {
  it("reads every menu item", () => {
    expect(menu.length).toBeGreaterThanOrEqual(18);
  });


  it.each(menu.map((item) => [item.label, item.href]))("%s: the H1 on %s is the menu label", (label, href) => {
    for (const file of fileFor(href)) {
      const source = read(file);
      const h1 = /<h1 className="page-title">([^<{]+)</.exec(source);
      expect(h1?.[1]?.trim().replace("&amp;", "&"), file).toBe(label);
    }
  });

  it.each(menu.map((item) => [item.label, item.href]))("%s: a short plain sentence sits under the H1", (_label, href) => {
    for (const file of fileFor(href)) {
      const after = /<h1 className="page-title">[^]*?<\/h1>\s*(<p[^>]*>[^]{0,200})/.exec(read(file));
      expect(after?.[1], file).toBeTruthy();
    }
  });

  it("the topbar shows the same label for every menu page", () => {
    for (const { href, label } of menu) expect(topbarTitles[href], href).toBe(label);
  });

  it("the page-access list (Admin > Users) uses the same names", () => {
    for (const section of MEMBER_SECTIONS) {
      if (section.href === "/email") continue; // hidden from the menu until built (Rhys, Tue 20 Oct)
      expect(menu.find((item) => item.href === section.href)?.label).toBe(section.label);
    }
  });

  it("the full names are used, not the short ones", () => {
    expect(menu.map((item) => item.label)).toEqual(expect.arrayContaining(["RFQ Control Centre", "Weekly hours"]));
  });

  it("Email & Payment Automation is not in the menu until it is built (Rhys, Tue 20 Oct)", () => {
    expect(menu.find((item) => item.href === "/email")).toBeUndefined();
  });
});

describe("RFQ stage tabs carry the same SHOW label as the other list pages", () => {
  const phase = read("components/phase-filter.tsx");
  const rfq = read("app/(dashboard)/rfq/page.tsx");
  const label = /<span className="([^"]+)">Show<\/span>/;

  it("uses the Show group name and the same label style as the Open / Done tabs", () => {
    expect(rfq).toContain('role="group" aria-label="Show"');
    expect(label.exec(rfq)?.[1]).toBe(label.exec(phase)?.[1]);
  });
});
