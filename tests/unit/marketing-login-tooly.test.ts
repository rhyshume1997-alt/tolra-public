/**
 * The decorative Tooly on the sign-in page: the layout hands the page's children through untouched, decides "neutral" from the same
 * pure slug rule the page uses (no DB), and the component renders nothing on the server (so the first paint is unchanged).
 */
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
let host: string | null = "app.example.test";
let cookieValue: string | undefined;
vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => host }),
  cookies: async () => ({ get: () => (cookieValue === undefined ? undefined : { value: cookieValue }) }),
}));

import LoginLayout from "@/app/login/layout";
import { LoginTooly } from "@/components/marketing/login-tooly";
import { BRAND_COOKIE } from "@/lib/server/branding";

type LayoutOut = { props: { children: Array<{ props: Record<string, unknown> } | string> } };
beforeEach(() => { host = "app.example.test"; cookieValue = undefined; });

describe("sign-in layout", () => {
  it("passes the page through as the first child, unchanged", async () => {
    const page = createElement("main", { id: "page" });
    const out = (await LoginLayout({ children: page })) as unknown as LayoutOut;
    expect(isValidElement(out.props.children[0])).toBe(true);
    expect(out.props.children[0]).toBe(page);
  });

  it("is neutral with no brand hint, and not neutral when this device remembers a company", async () => {
    let out = (await LoginLayout({ children: null })) as unknown as LayoutOut;
    expect((out.props.children[1] as { props: { neutral: boolean } }).props.neutral).toBe(true);
    cookieValue = "alpha";
    out = (await LoginLayout({ children: null })) as unknown as LayoutOut;
    expect((out.props.children[1] as { props: { neutral: boolean } }).props.neutral).toBe(false);
    expect(BRAND_COOKIE).toBeTruthy();
  });
});

describe("LoginTooly", () => {
  it("renders nothing on the server, so nothing is added to the first paint", () => {
    expect(renderToStaticMarkup(createElement(LoginTooly, { neutral: true }))).toBe("");
    expect(renderToStaticMarkup(createElement(LoginTooly, { neutral: false }))).toBe("");
  });
});
