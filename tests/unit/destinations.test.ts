import { describe, expect, it } from "vitest";

import { canOpenDestination } from "@/lib/destinations";

const none: string[] = [];

describe("canOpenDestination: a visible link must open", () => {
  it("the approval queue (bell, dashboard link) is for admin and office views only", () => {
    expect(canOpenDestination("/approval", { activeRole: "admin", hiddenSections: none })).toBe(true);
    expect(canOpenDestination("/approval", { activeRole: "office", hiddenSections: none })).toBe(true);
    expect(canOpenDestination("/approval", { activeRole: "workshop", hiddenSections: none })).toBe(false);
    expect(canOpenDestination("/approval", { activeRole: "viewer", hiddenSections: none })).toBe(false);
  });

  it("follows the active view, not the person's highest role", () => {
    // An admin working in the workshop view gets the workshop's links.
    expect(canOpenDestination("/invoices", { activeRole: "workshop", hiddenSections: none })).toBe(false);
    expect(canOpenDestination("/jobs", { activeRole: "workshop", hiddenSections: none })).toBe(true);
    expect(canOpenDestination("/settings", { activeRole: "office", hiddenSections: none })).toBe(false);
    expect(canOpenDestination("/settings", { activeRole: "admin", hiddenSections: none })).toBe(true);
  });

  it("an individually hidden section is not offered, nor are its sub-pages", () => {
    expect(canOpenDestination("/approval", { activeRole: "admin", hiddenSections: ["approval"] })).toBe(false);
    expect(canOpenDestination("/quotes/new", { activeRole: "office", hiddenSections: ["quotes"] })).toBe(false);
    expect(canOpenDestination("/jobs", { activeRole: "workshop", hiddenSections: ["quotes"] })).toBe(true);
  });

  it("a menu item the company hid is not offered; the dashboard and settings can't be hidden that way", () => {
    expect(canOpenDestination("/customers", { activeRole: "office", hiddenSections: none, hiddenNav: ["customers"] })).toBe(false);
    expect(canOpenDestination("/dashboard", { activeRole: "viewer", hiddenSections: none, hiddenNav: ["dashboard"] })).toBe(true);
    expect(canOpenDestination("/settings", { activeRole: "admin", hiddenSections: none, hiddenNav: ["settings"] })).toBe(true);
  });

  it("unknown destinations are never offered", () => {
    expect(canOpenDestination("/nowhere", { activeRole: "admin", hiddenSections: none })).toBe(false);
  });
});
