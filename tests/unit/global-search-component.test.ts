/** The search box's results panel rendered (react-dom/server) and its keyboard shortcut rule. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SearchResults, isSearchShortcut } from "@/components/global-search";
import type { SearchAnswer } from "@/lib/global-search";

const answer: SearchAnswer = {
  query: "acme",
  unavailable: [],
  groups: [
    { key: "quotes", label: "Quotes", results: [{ id: "q1", title: "QUO-1001", subtitle: "Acme Ltd", href: "/quotes?quote=q1" }] },
    { key: "jobs", label: "Jobs", results: [{ id: "j1", title: "J-3001", subtitle: "", href: "/jobs?job=j1" }] },
  ],
};
const render = (state: Parameters<typeof SearchResults>[0]["state"]) => renderToStaticMarkup(createElement(SearchResults, { state, query: "acme" }));
const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);

describe("SearchResults", () => {
  it("each group has its heading and every result is a link to the existing page", () => {
    const html = render({ kind: "done", answer });
    expect(html).toContain(">Quotes<");
    expect(html).toContain(">Jobs<");
    expect(hrefs(html)).toEqual(["/quotes?quote=q1", "/jobs?job=j1"]);
    expect(html).toContain("min-h-11"); // 44px targets
  });
  it("no matches, still searching, failed and idle each say so", () => {
    expect(render({ kind: "done", answer: { query: "zz", groups: [], unavailable: [] } })).toContain("No matches for");
    expect(render({ kind: "loading" })).toContain("Searching");
    expect(render({ kind: "error", message: "Search failed. Try again." })).toContain("Search failed");
    expect(render({ kind: "idle" })).toContain("at least 2 characters");
  });
  it("says when part of the answer is missing", () => {
    expect(render({ kind: "done", answer: { ...answer, unavailable: ["jobs"] } })).toContain("Some results could not be loaded");
  });
});

describe("isSearchShortcut", () => {
  const key = (init: Partial<KeyboardEvent> & { tag?: string }) => ({ key: "", ctrlKey: false, metaKey: false, altKey: false, target: { tagName: init.tag ?? "BODY", isContentEditable: false } as unknown as EventTarget, ...init });
  it("/ opens it, except while typing in a field", () => {
    expect(isSearchShortcut(key({ key: "/" }))).toBe(true);
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) expect(isSearchShortcut(key({ key: "/", tag }))).toBe(false);
    expect(isSearchShortcut({ ...key({ key: "/" }), target: { tagName: "DIV", isContentEditable: true } as unknown as EventTarget })).toBe(false);
  });
  it("Ctrl+K and Cmd+K open it from anywhere, even in a field", () => {
    expect(isSearchShortcut(key({ key: "k", ctrlKey: true, tag: "INPUT" }))).toBe(true);
    expect(isSearchShortcut(key({ key: "K", metaKey: true }))).toBe(true);
    expect(isSearchShortcut(key({ key: "k" }))).toBe(false);
  });
});
