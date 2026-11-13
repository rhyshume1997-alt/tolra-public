// Portal mail: platform Resend only, no Microsoft 365, no history, nothing logged.
import { readFileSync } from "fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { sendPortalSigninEmail } from "@/lib/portal/mail";

const input = { to: "Pat@Customer.example", companyName: "Acme Ltd", customerName: "Pat Co", link: "https://app.test/portal/code/REF", code: "12345678" };
const env = { RESEND_API_KEY: "test-key-not-real", EMAIL_FROM: "Tolra <noreply@tolra.test>" };
const provider = (outcome: string) => { const send = vi.fn<(m: unknown) => Promise<{ outcome: string }>>(async () => ({ outcome })); return { send, factory: { resend: () => ({ name: "resend", send }) as never } }; };

describe("portal mail", () => {
  it("sends one platform Resend e-mail with the link and the code", async () => {
    const p = provider("accepted");
    expect(await sendPortalSigninEmail(input, { env, providers: p.factory })).toBe(true);
    const sent = p.send.mock.calls[0][0] as { to: string[]; text: string; subject: string };
    expect(sent.to).toEqual(["pat@customer.example"]);
    expect(sent.text).toContain("https://app.test/portal/code/REF");
    expect(sent.text).toContain("1234 5678");
  });
  it("is false (and sends nothing) when Resend is not configured", async () => {
    const p = provider("accepted");
    expect(await sendPortalSigninEmail(input, { env: {}, providers: p.factory })).toBe(false);
    expect(await sendPortalSigninEmail(input, { env: { RESEND_API_KEY: "k" }, providers: p.factory })).toBe(false);
    expect(p.send).not.toHaveBeenCalled();
  });
  it("keeps the preview recipient allowlist", async () => {
    const p = provider("accepted");
    expect(await sendPortalSigninEmail(input, { env: { ...env, VERCEL_ENV: "preview", EMAIL_RECIPIENT_DOMAINS: "other.example" }, providers: p.factory })).toBe(false);
    expect(await sendPortalSigninEmail(input, { env: { ...env, VERCEL_ENV: "preview", EMAIL_RECIPIENT_DOMAINS: "customer.example" }, providers: p.factory })).toBe(true);
  });
  it("is false for a bad address, a failed or unknown send, or a throw, and never logs", async () => {
    const spies = [vi.spyOn(console, "error"), vi.spyOn(console, "log"), vi.spyOn(console, "warn")];
    expect(await sendPortalSigninEmail({ ...input, to: "not an address" }, { env, providers: provider("accepted").factory })).toBe(false);
    expect(await sendPortalSigninEmail(input, { env, providers: provider("failed").factory })).toBe(false);
    expect(await sendPortalSigninEmail(input, { env, providers: provider("unknown").factory })).toBe(false);
    expect(await sendPortalSigninEmail(input, { env, providers: { resend: () => ({ name: "resend", send: async () => { throw new Error("boom pat@customer.example 12345678"); } }) as never } })).toBe(false);
    for (const s of spies) { expect(s).not.toHaveBeenCalled(); s.mockRestore(); }
  });
  it("source never uses the company mailer, Microsoft 365 or e-mail history", () => {
    const src = readFileSync("lib/portal/mail.ts", "utf8").replace(/\/\*\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/sendCompanyEmail|selectProvider|email_history|m365|microsoft|getDelegatedAccessToken|console\./i);
  });
});
