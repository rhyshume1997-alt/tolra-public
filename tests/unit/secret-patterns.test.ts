import { describe, expect, it } from "vitest";

import { SECRET_IN_PAGE } from "../support/secret-patterns";

describe("SECRET_IN_PAGE", () => {
  it("lets the AI card's static placeholder through", () => {
    expect(SECRET_IN_PAGE.test('<input placeholder="sk-ant-…" type="password">')).toBe(false);
    expect(SECRET_IN_PAGE.test('placeholder="sk-ant-..."')).toBe(false);
    expect(SECRET_IN_PAGE.test("sk-ant-")).toBe(false);
  });

  it("still catches a realistically shaped complete Anthropic key", () => {
    const key = `sk-ant-api03-${"aB3_-".repeat(18)}AA`;
    expect(key.length).toBeGreaterThan(100);
    expect(SECRET_IN_PAGE.test(`<div>${key}</div>`)).toBe(true);
    expect(SECRET_IN_PAGE.test(`value="${key}"`)).toBe(true);
  });

  it("still catches the other credential words", () => {
    for (const word of ["client_secret", "refresh_token", "access_token"]) expect(SECRET_IN_PAGE.test(`{"${word}":"x"}`)).toBe(true);
  });
});
