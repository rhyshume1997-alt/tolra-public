/**
 * The dialog's sticky-close header (react-dom/server): opted in, the X lives inside a sticky header so it stays visible while a long
 * dialog scrolls (the Job Board worksheet on a phone); not opted in, a header is unchanged and carries no X of its own.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Dialog, DialogHeader } from "@/components/ui/dialog";

const render = (stickyClose: boolean) =>
  renderToStaticMarkup(createElement(Dialog, null, createElement(DialogHeader, { stickyClose }, createElement("span", null, "Worksheet - J-1"))));

describe("DialogHeader stickyClose", () => {
  it("sticks to the top of the scrolling dialog and holds the Close button, 44px on a touch screen", () => {
    const html = render(true);
    expect(html).toContain('data-sticky-close=""');
    const headerClass = html.match(/^<div[^>]* class="([^"]*)"/)![1].split(" ");
    for (const cls of ["sticky", "bg-surface", "z-10"]) expect(headerClass).toContain(cls);
    expect(html).toMatch(/<button[^>]*class="[^"]*pointer-coarse:size-11[^"]*"[^>]*>.*<span class="sr-only">Close<\/span><\/button>/);
    expect(html.match(/>Close</g)).toHaveLength(1);
  });
  it("without stickyClose it is the plain header: not sticky, no X", () => {
    const html = render(false);
    expect(html).not.toContain("data-sticky-close");
    expect(html).not.toContain("sticky");
    expect(html).not.toContain("Close");
  });
});
