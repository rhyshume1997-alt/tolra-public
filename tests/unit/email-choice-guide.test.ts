// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { EMAIL_CHOICE_APPROVAL, EMAIL_CHOICE_OTHER, EMAIL_CHOICE_OUTLOOK, EmailChoiceGuide } from "@/components/email-choice-guide";
import { readFileSync } from "node:fs";

describe("Integrations e-mail choice", () => {
  it("says plainly: Outlook/Microsoft 365 -> Connect Microsoft 365; any other e-mail -> Resend; approval first; no Gmail or SMTP option", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(EmailChoiceGuide)));
    const text = host.textContent ?? "";
    expect(text).toContain(EMAIL_CHOICE_OUTLOOK);
    expect(text).toContain(EMAIL_CHOICE_OTHER);
    expect(text).toContain(EMAIL_CHOICE_APPROVAL);
    expect(text).toMatch(/Outlook or Microsoft 365 email: use Connect Microsoft 365/);
    expect(text).toMatch(/Any other email: .* Resend/);
    expect(text).not.toMatch(/Gmail|SMTP/i);
    await act(async () => root.unmount());
    host.remove();
  });
  it("is placed above the Microsoft and Resend cards on the Integrations panel", () => {
    const src = readFileSync("components/integrations-panel.tsx", "utf8");
    const guide = src.indexOf("<EmailChoiceGuide />");
    expect(guide).toBeGreaterThan(0);
    expect(guide).toBeLessThan(src.indexOf("<MicrosoftConnectCard"));
    expect(guide).toBeLessThan(src.indexOf("<ResendStatusCard"));
  });
});
