/**
 * The Raise an issue form's one call (lib/issues/raise-issue.ts) and the button's wiring. Proves: it calls only raise_issue with the three
 * arguments (company and person are never sent: the database takes them from the session); an error or a thrown failure gives fixed wording and
 * never claims success; urgent is passed through (the call-Rhys message is the form's, and the issue is still saved); the button is mounted in
 * the shell for every role (no role check), hidden unless the company marker is on and in a support session, and sends no e-mail, AI or direct write.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { raiseIssue } from "@/lib/issues/raise-issue";

const root = path.resolve(__dirname, "../..");
const src = (file: string) => readFileSync(path.join(root, file), "utf8");
const input = { page: "/jobs", body: "It broke", urgent: false };

describe("raiseIssue", () => {
  it("calls raise_issue with the page, text and urgent only", async () => {
    const rpc = vi.fn(async () => ({ data: "id", error: null }));
    expect(await raiseIssue({ rpc } as never, { ...input, urgent: true })).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("raise_issue", { p_page: "/jobs", p_body: "It broke", p_urgent: true });
  });
  it("a refusal is fixed wording, never success and never the database message", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "42501", hint: "issues_off", message: "Raising an issue is switched off for this company" } }));
    const result = await raiseIssue({ rpc } as never, input);
    expect(result).toEqual({ ok: false, error: "Raising an issue isn't switched on for your company." });
  });
  it("a thrown failure or no client says nothing was saved", async () => {
    const thrown = await raiseIssue({ rpc: vi.fn(async () => { throw new Error("offline"); }) } as never, input);
    expect(thrown).toMatchObject({ ok: false });
    expect(thrown.ok ? "" : thrown.error).toMatch(/Nothing was saved/);
    const none = await raiseIssue(null, input);
    expect(none).toMatchObject({ ok: false });
    expect(none.ok ? "" : none.error).toMatch(/Nothing was saved/);
  });
});

describe("the button and its mount", () => {
  const button = src("components/issues/raise-issue-button.tsx");
  it("is mounted once in the dashboard shell, which every signed-in role sees", () => {
    const shell = src("components/dashboard-shell.tsx");
    expect(shell).toContain('import { RaiseIssueButton } from "@/components/issues/raise-issue-button";');
    expect(shell.match(/<RaiseIssueButton \/>/g)).toHaveLength(1);
  });
  it("has no role check, is off without the company marker, and is hidden in a support session", () => {
    expect(button).not.toMatch(/activeRole|hasRole|hasAnyRole|canSee/);
    expect(button).toContain("!issuesEnabled(hiddenNav) || session?.support");
  });
  it("shows Call Rhys on 07908041480 when urgent is ticked, and still sends the issue", () => {
    expect(button).toContain("{urgent ? <CallRhys /> : null}");
    expect(button).toContain("Call Rhys on");
    expect(button).toContain("OWNER_PHONE_DISPLAY");
    expect(button).toContain("{sent.urgent ? <CallRhys /> : null}");
    expect(button).toContain("raiseIssue(supabase, checked.value)");
  });
  it("fills the page from the current path and sends no e-mail, calls no AI and writes no table", () => {
    expect(button).toContain("issuePageFrom(pathname)");
    for (const file of ["components/issues/raise-issue-button.tsx", "lib/issues/raise-issue.ts", "lib/issues/issues.ts"]) {
      const text = src(file);
      expect(text, file).not.toMatch(/\.from\(|\.insert\(|\.update\(|\.delete\(|fetch\(|sendMail|resend|@\/lib\/ai|openai|anthropic/i);
    }
  });
});
