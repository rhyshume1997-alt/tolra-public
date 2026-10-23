/**
 * Admin > Users loads fast: the table shows as soon as the members and flags are in; the two-step overview, the companies and the sign-in
 * answers arrive beside it, and until the sign-in answer is known nothing is offered on a guess.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SIGN_IN_CHECKING_LABEL, signInControls } from "@/lib/sign-in-access";

const base = { isSelf: false, isLastAdmin: false, active: true, checking: false } as const;

describe("signInControls", () => {
  it("while the answer is unknown, an active person gets one disabled 'checking' control and no Deactivate", () => {
    for (const state of [undefined, "on", "off", "off_platform", "unknown"] as const) {
      expect(signInControls({ ...base, checking: true, state })).toEqual({ signIn: "checking", deactivate: false });
    }
    expect(SIGN_IN_CHECKING_LABEL).toBe("Checking sign-in…");
  });

  it("once known: Disable for a login this company owns, Enable when disabled here, nothing when Tolra support disabled it", () => {
    expect(signInControls({ ...base, state: "on" })).toEqual({ signIn: "disable", deactivate: false });
    expect(signInControls({ ...base, state: "unknown" })).toEqual({ signIn: "disable", deactivate: false });
    expect(signInControls({ ...base, state: "off" })).toEqual({ signIn: "enable", deactivate: false });
    expect(signInControls({ ...base, state: "off_platform" })).toEqual({ signIn: "none", deactivate: false });
  });

  it("a login that isn't this company's alone (not in the list) keeps the normal Deactivate", () => {
    expect(signInControls({ ...base, state: undefined })).toEqual({ signIn: "none", deactivate: true });
  });

  it("Reactivate is never held back; oneself and the last admin get neither", () => {
    expect(signInControls({ ...base, active: false, checking: true, state: undefined })).toEqual({ signIn: "none", deactivate: true });
    expect(signInControls({ ...base, active: false, state: "on" })).toEqual({ signIn: "none", deactivate: true });
    expect(signInControls({ ...base, isSelf: true, checking: true, state: undefined })).toEqual({ signIn: "none", deactivate: false });
    expect(signInControls({ ...base, isLastAdmin: true, state: "on" })).toEqual({ signIn: "none", deactivate: false });
  });
});

describe("the page's load", () => {
  const page = readFileSync("app/(dashboard)/admin/users/page.tsx", "utf8");
  const load = page.slice(page.indexOf("const load = useCallback"), page.indexOf("useEffect(() => { void load(); }, [load]);"));

  it("reads the members and the flags together, and shows the table before anything slower", () => {
    expect(load).toContain('Promise.all([\n        supabase.rpc("org_members"),\n        supabase.from("organization_members").select("user_id, can_inspect"),');
    const table = load.indexOf("setLoading(false);\n      // Side by side");
    expect(table).toBeGreaterThan(0);
    expect(table).toBeLessThan(load.indexOf('"admin_mfa_overview"'));
    expect(table).toBeLessThan(load.indexOf('"my_admin_companies"'));
    expect(table).toBeLessThan(load.indexOf('fetch("/api/admin/users/sign-in")'));
  });

  it("does not wait for the slower reads one after another", () => {
    expect(load).not.toMatch(/await[^\n]*admin_mfa_overview/);
    expect(load).not.toMatch(/await[^\n]*my_admin_companies/);
    expect(load).not.toMatch(/await fetch\(/);
  });

  it("an older load's late answers are dropped, and a failed sign-in read leaves nobody offered Disable", () => {
    expect(load).toContain("if (seq !== loadSeq.current) return;");
    // A failed read is a null body: parseSignInList(null) is empty (nobody offered Disable), and the protected list is unavailable
    // (093: every other row's identity actions off).
    expect(load).toContain("(response.ok ? await response.json().catch(() => null) : null), () => null)");
    expect(load).toContain("setSignIn(parseSignInList(body));");
    expect(load).toContain("setProtectedUnavailable(!body || typeof body !== \"object\" || !Array.isArray((body as { protected?: unknown }).protected));");
  });

  it("093: Edit, Set password, Reset two-step, sign-in and Deactivate follow identityActions for each row", () => {
    expect(page).toContain("identityActions({ isSelf, checking: signInChecking, unavailable: protectedUnavailable, state: shielded.get(user.id) })");
    expect(page).toContain("disabled={saving || !identity.allowed} title={identity.reason ?? undefined} onClick={() => openEdit(user)}");
    expect(page.split("!identity.allowed} title={identity.reason ?? undefined}")).toHaveLength(4);
    expect(page).toContain("{!identity.allowed && !signInChecking ? null : controls.signIn === \"checking\" ? (");
    expect(page).toContain("{controls.deactivate && identity.allowed ? (");
  });

  it("the buttons come from signInControls, and the Status cell says 'checking' rather than guess", () => {
    expect(page).toContain("signInControls({ isSelf, isLastAdmin, active: user.active, checking: signInChecking, state: signIn.get(user.id) })");
    expect(page).toContain('data-testid="sign-in-checking"');
  });
});
