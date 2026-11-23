// @vitest-environment jsdom
/**
 * BOUNDARY (Users, Module 1, PREVIEW ONLY). Inputs: the exports of components/admin/users/preview/UsersPreview.tsx, the REAL pure lib functions it uses (password,
 * username, display-name, mfa-policy, sign-in-access, sections, company-access, empty-hints) and the SOURCE of app/(dashboard)/admin/users/page.tsx and
 * components/authorised-inspectors.tsx / lib/inspectors.ts for rules that live inline there. Output: pass/fail. Pins the preview's validation, row-control rules, role gate and
 * wording to the real page, and checks by rendering that nothing reports success, no sample address is real, and the preview imports no auth, session or network code.
 * Must not change: never loosen these to make a change pass; if a real rule changes, this test is the alarm. No network, no Supabase. Written with createElement (no JSX).
 */
import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import UsersPreview, {
  ADD_NEEDS_PERSON, COMPANY_NAME, ME, OFF_SITE_LABEL, OFF_SITE_RULE, ON_SITE_LABEL, ON_SITE_RULE, USERS_INTRO_GENERIC, USERS_INTRO_RULE, clockSwitchesFor, REASON_MAX, REASON_MIN, ROLE_HELP, ROLES, SCOPE_MAX, SEED_USERS, SELF_ADMIN_NOTE, canUseUsers, editChanges, eligibleForList, isLastAdminOf,
  nameOf, overviewOf, pagesOf, passwordForm, planRowActions, statusOf, validateAdd, validateEdit, validateInspector,
} from "@/components/admin/users/preview/UsersPreview";
import { usersEmptyHint } from "@/lib/empty-hints";
import { displayNameProblem } from "@/lib/display-name";
import { adminMfaRuleMessage } from "@/lib/mfa-policy";
import { passwordProblem } from "@/lib/password";
import { parseProtectedList, parseSignInList, SIGN_IN_CHECKING_LABEL } from "@/lib/sign-in-access";
import { USERNAME_RULES } from "@/lib/username";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const PAGE = read("app/(dashboard)/admin/users/page.tsx");
const ON_SITE_SRC = read("components/time/on-site-only.tsx");
const OFF_SITE_SRC = read("components/time/clock-in-off-site.tsx");
const INSPECT_UI = read("components/authorised-inspectors.tsx");
const INSPECT_LIB = read("lib/inspectors.ts");
const SRC = read("components/admin/users/preview/UsersPreview.tsx");
const ROUTE = read("app/(dashboard)/admin/users/preview/page.tsx");

const ctx = (o: Partial<Parameters<typeof planRowActions>[1]> = {}) => ({
  signInChecking: false, protectedUnavailable: false,
  signIn: parseSignInList({ users: SEED_USERS.filter((u) => u.signIn).map((u) => ({ user_id: u.id, sign_in: u.signIn })) }),
  shielded: parseProtectedList({ protected: [{ user_id: "u14", state: "protected" }] }),
  lastAdmin: (u: (typeof SEED_USERS)[number]) => isLastAdminOf(SEED_USERS, u), ...o,
});
const user = (id: string) => SEED_USERS.find((u) => u.id === id)!;
const ids = (id: string, c = ctx()) => planRowActions(user(id), c).actions.map((a) => a.id);

describe("users preview: the real source still says what the preview mirrors", () => {
  it("page: Admin only gate, the empty hint, roles and role help", () => {
    expect(PAGE).toContain('<RoleGate allowed={["admin"]}>');
    expect(["admin", "office", "workshop", "viewer"].map((r) => canUseUsers(r as never))).toEqual([true, false, false, false]);
    expect(usersEmptyHint()).toBe("Press New user to add the first one.");
    expect(PAGE).toContain('const ROLES: UserRole[] = ["admin", "office", "workshop", "viewer"];');
    expect(ROLES).toEqual(["admin", "office", "workshop", "viewer"]);
    for (const [k, v] of Object.entries(ROLE_HELP)) expect(PAGE).toContain(`${k}: "${v}"`);
  });
  it("page: inline add / edit rules and wording", () => {
    expect(PAGE).toContain(`toast.error("${ADD_NEEDS_PERSON}")`);
    expect(PAGE).toContain("required={!add.username.trim()}");
    expect(PAGE).toContain('type="email"');
    expect(PAGE).toContain("const problem = add.email.trim() ? passwordProblem(add.password) : null;");
    expect(PAGE).toContain("toast.error(`Username: ${USERNAME_RULES}`)");
    expect(PAGE).toContain("toast.error(`Display name: ${problem}`)");
    expect(PAGE).toContain(SELF_ADMIN_NOTE.replace("'", "&apos;"));
    expect(PAGE).toContain("Couldn't load their access to your other companies.");
    expect(PAGE).toContain("Couldn't load who can record inspections.");
    expect(PAGE).toContain("Add people to {company?.name");
    expect(PAGE).toContain("Nothing is e-mailed unless you press Send password reset e-mail.");
  });
  it("page: the four confirmation sentences", () => {
    expect(PAGE).toContain("Switch off Tolra support access to ${company?.name ?? \"this company\"}? It ends straight away.");
    expect(PAGE).toContain("E-mail ${user.name} a link to choose a new password? Their current password keeps working until they use it.");
    expect(PAGE).toContain("Reset two-step sign-in for ${user.name}? They will set up their authenticator app again at their next sign-in. Only do this once you are sure it is really them asking.");
    expect(PAGE).toContain("Deactivate ${user.name}? They lose access to ${company?.name ?? \"this company\"} straight away.");
  });
  it("page: row control rules (Reset two-step on the primary role only; Set password and reset e-mail never on oneself)", () => {
    expect(PAGE).toContain('isSelf || user.role !== "admin" ? null');
    expect(PAGE).toContain("{isSelf ? null : (");
    expect(PAGE).toContain("No e-mail address on file: use Set password.");
    expect(PAGE).toContain("Only available for a login that belongs to this company alone and can sign in: they can use Forgot password on the sign-in page.");
    expect(PAGE).toContain("E-mail them a link to choose a new password");
    expect(PAGE).toContain("Checking whether this person's sign-in can be disabled here");
  });
  it("inspectors: limits and messages mirror lib/inspectors.ts and the component", () => {
    expect(INSPECT_LIB).toContain(`REASON_MIN = ${REASON_MIN}`); expect(INSPECT_LIB).toContain(`REASON_MAX = ${REASON_MAX}`); expect(INSPECT_LIB).toContain(`SCOPE_MAX = ${SCOPE_MAX}`);
    expect(INSPECT_LIB).toContain("Give the reason (at least ${REASON_MIN} characters), for example the training or experience it rests on.");
    expect(INSPECT_LIB).toContain("The reason is up to ${REASON_MAX} characters.");
    expect(INSPECT_LIB).toContain("The scope is up to ${SCOPE_MAX} characters.");
    expect(INSPECT_UI).toContain('"Choose who to add."');
  });
});

describe("users preview: validators", () => {
  it("add: real checks in the real order, each beside its field", () => {
    const ok = { fullName: "Sample Person", email: "sample@fernhill.example", username: "", role: "workshop" as const, secondary: "" as const, hidden: [], password: "abcdefghij12", mustChange: true };
    expect(validateAdd(ok)).toEqual({});
    expect(validateAdd({ ...ok, fullName: "", email: "" }).form).toBe(ADD_NEEDS_PERSON);
    expect(validateAdd({ ...ok, fullName: "", email: "", username: "existing.login", password: "" })).toEqual({});
    expect(validateAdd({ ...ok, username: "a" }).username).toBe(`Username: ${USERNAME_RULES}`);
    expect(validateAdd({ ...ok, password: "short1" }).password).toBe(passwordProblem("short1"));
    expect(validateAdd({ ...ok, email: "nope" }).email).toBeTruthy();
  });
  it("edit: username rule, and the display-name rule only when the name changed", () => {
    const base = { fullName: "Priya Raman", role: "admin" as const, secondary: "" as const, username: "priyar", hidden: [], inspector: false };
    expect(validateEdit(base, { fullName: "Priya Raman" })).toEqual({});
    expect(validateEdit({ ...base, fullName: "a@b.example" }, { fullName: "Priya Raman" }).fullName).toBe(`Display name: ${displayNameProblem("a@b.example")}`);
    expect(validateEdit({ ...base, fullName: "" }, { fullName: "" })).toEqual({});
    expect(validateEdit({ ...base, username: "!!" }, { fullName: "Priya Raman" }).username).toBe(`Username: ${USERNAME_RULES}`);
    expect(editChanges({ ...base, role: "office", hidden: ["jobs"] }, user("u01"), { flagsError: false })).toEqual(["role", "page access"]);
  });
  it("password and inspector forms", () => {
    expect(passwordForm("x").password).toBe(passwordProblem("x")); expect(passwordForm("abcdefghij12")).toEqual({});
    expect(validateInspector({ mode: "add", personId: "", scope: "", reason: "" }).person).toBe("Choose who to add.");
    expect(validateInspector({ mode: "remove", personId: "u1", scope: "x".repeat(300), reason: "long enough reason" })).toEqual({});
    expect(validateInspector({ mode: "add", personId: "u1", scope: "x".repeat(201), reason: "long enough reason" }).scope).toContain("200");
    expect(validateInspector({ mode: "add", personId: "u1", scope: "", reason: "x".repeat(501) }).reason).toContain("500");
  });
});

describe("users preview: row controls follow the real rules", () => {
  it("oneself: Edit only; a support row: Switch off only", () => {
    expect(ids(ME)).toEqual(["edit"]);
    expect(ids("u15")).toEqual(["support-off"]);
  });
  it("an ordinary admin on a company-alone login: Disable sign-in, no Deactivate; shared login: Deactivate", () => {
    expect(ids("u03")).toEqual(["edit", "password", "reset-email", "reset-mfa", "sign-in"]);
    expect(ids("u02")).toEqual(["edit", "password", "reset-email", "reset-mfa", "deactivate"]);
  });
  it("secondary admin does not get Reset two-step; a deactivated person gets Reactivate and nothing else enabled", () => {
    expect(user("u02").secondary).toBe("office");
    const p = planRowActions(user("u10"), ctx());
    expect(p.actions.find((a) => a.id === "deactivate")!.label).toBe("Reactivate");
    expect(p.actions.find((a) => a.id === "password")!.disabled).toBe(true);
    expect(p.actions.find((a) => a.id === "deactivate")!.confirm).toBeUndefined();
  });
  it("protected login: identity actions off with the reason; no sign-in or Deactivate", () => {
    const p = planRowActions(user("u14"), ctx());
    expect(p.note).toContain("Platform owner"); expect(p.actions.find((a) => a.id === "edit")!.disabled).toBe(true);
    expect(p.actions.some((a) => a.id === "deactivate" || a.id === "sign-in")).toBe(false);
  });
  it("while checking nothing is offered on a guess; unreadable answers fail closed", () => {
    const c = planRowActions(user("u06"), ctx({ signInChecking: true }));
    expect(c.actions.find((a) => a.id === "edit")!.disabled).toBe(true);
    expect(c.actions.find((a) => a.id === "sign-in")!.label).toBe(SIGN_IN_CHECKING_LABEL);
    expect(c.actions.some((a) => a.id === "deactivate")).toBe(false);
    const f = planRowActions(user("u06"), ctx({ protectedUnavailable: true, shielded: new Map() }));
    expect(f.actions.find((a) => a.id === "edit")!.disabled).toBe(true);
  });
  it("the last admin gets neither Disable sign-in nor Deactivate", () => {
    const only = SEED_USERS.filter((u) => u.id === "u02" || u.role !== "admin");
    expect(planRowActions(user("u02"), ctx({ lastAdmin: (u) => isLastAdminOf(only, u) })).actions.some((a) => a.id === "deactivate")).toBe(false);
  });
  it("status precedence, pages, two-step labels and the rule line", () => {
    const s = (id: string, o = { checking: false, state: user(id).signIn }) => statusOf(user(id), o).text;
    expect(s("u11")).toBe("Sign-in disabled"); expect(s("u12")).toBe("Sign-in disabled by Tolra"); expect(s("u03")).toBe("Must change password");
    expect(s("u07")).toBe("Not signed in yet"); expect(s("u10")).toBe("Deactivated"); expect(s("u06")).toBe("Active"); expect(s("u15")).toContain("Tolra support, until");
    expect(pagesOf(user("u04"))).toBe("10 of 12"); expect(pagesOf(user("u01"))).toBe("All");
    expect(adminMfaRuleMessage(overviewOf(SEED_USERS)!, (id) => nameOf(user(id))).text).toContain("Elena Voss, Tomas Whitcombe have not set up");
    expect(eligibleForList(user("u08"))).toBe(false); expect(eligibleForList(user("u10"))).toBe(false); expect(COMPANY_NAME).toContain("Fernhill");
  });
});

describe("users preview v2: the structural changes keep every rule", () => {
  it("clock-in switches: same labels and rules as the real components, same row rule, now in the Edit sheet", () => {
    expect(ON_SITE_SRC).toContain(`title="${ON_SITE_RULE}"`); expect(ON_SITE_SRC).toContain(ON_SITE_LABEL);
    expect(OFF_SITE_SRC).toContain(`title="${OFF_SITE_RULE}"`); expect(OFF_SITE_SRC).toContain(OFF_SITE_LABEL);
    expect(OFF_SITE_LABEL).toBe("Can clock in off site (while the network lock is on)");
    const both = { has075: true, has114: true };
    expect(clockSwitchesFor(user("u04"), both)).toEqual({ onSite: true, offSite: true });
    expect(clockSwitchesFor(user("u04"), { has075: false, has114: true })).toEqual({ onSite: false, offSite: true });
    expect(clockSwitchesFor(user("u04"), { has075: true, has114: false })).toEqual({ onSite: true, offSite: false });
    expect(clockSwitchesFor(user("u10"), both)).toEqual({ onSite: false, offSite: false });
    expect(clockSwitchesFor(user("u15"), both)).toEqual({ onSite: false, offSite: false });
    expect(editChanges({ fullName: "Callum Reeve", role: "office", secondary: "", username: "creeve", hidden: ["invoices", "approval"], inspector: true, onSite: false, offSite: true }, user("u04"), { flagsError: false })).toEqual(["on site only", "off-site clock-in"]);
  });
  it("the page sentence is split, not lost: the generic part is a tooltip, the rule stays visible, together they are the real wording", () => {
    expect(`${USERS_INTRO_GENERIC} ${USERS_INTRO_RULE}`).toBe("Add people to Fernhill Engineering Ltd, choose what they can open, and manage their passwords. Nothing is e-mailed unless you press Send password reset e-mail.");
    expect(PAGE).toContain("Add people to {company?.name"); expect(PAGE).toContain(USERS_INTRO_RULE);
  });
  it("the source holds no per-row clock-in switch any more", () => {
    expect(SRC).not.toContain("function ClockIn"); expect(SRC).not.toContain("toggleFlag");
  });
});

describe("users preview: sample data and boundary", () => {
  it("every address is on a reserved .example domain and the file imports no auth, session or network code", () => {
    for (const u of SEED_USERS) expect(u.email).toMatch(/\.example$/);
    for (const text of [SRC, ROUTE]) {
      expect(text).not.toMatch(/from "@\/lib\/(supabase|use-user|company|auth|mfa-step-up|admin-user-save|inspectors|friendly-error)"|@\/lib\/auth\//);
      expect(text).not.toMatch(/from "next\/(navigation|headers)"|fetch\(|navigator\.clipboard|window\.confirm|supabase|localStorage|sessionStorage/);
    }
    expect(SRC).not.toContain("Authenticator"); expect(ROUTE).not.toMatch(/useUser|getUser|cookies\(/);
  });
});

describe("users preview: rendering", () => {
  let host: HTMLDivElement;
  beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; const D = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void; open: boolean }; D.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); }; D.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); }; window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as never; });
  afterEach(() => { host?.remove(); });
  const mount = async () => { host = document.createElement("div"); document.body.append(host); const root = createRoot(host); await act(async () => { root.render(createElement(UsersPreview)); }); return host; };
  it("shows every person, the real wording, and a toast that never claims success", async () => {
    const h = await mount();
    expect(h.querySelectorAll('[data-testid="user-row"]').length).toBe(SEED_USERS.length);
    expect(h.textContent).toContain("User Management"); expect(h.textContent).toContain("Preview, sample data, nothing is saved");
    expect(h.querySelector('[data-testid="no-display-name"]')).not.toBeNull();
    expect(h.querySelectorAll('[data-testid="admin-mfa-status"]').length).toBe(4);
    await act(async () => { (h.querySelector('[data-testid="new-user"]') as HTMLButtonElement).click(); });
    const dlg = document.querySelector('[data-testid="dlg-add-user"]')!;
    await act(async () => { (dlg.querySelector('[data-testid="save-user"]') as HTMLButtonElement).click(); });
    expect(dlg.querySelector('[data-testid="form-summary"]')?.textContent).toContain(ADD_NEEDS_PERSON);
    expect(document.body.textContent).not.toMatch(/saved successfully|User updated|deactivated\b(?! would)/);
  });
  it("rows no longer carry the clock-in switches; the Edit user sheet does, with the real labels, for an active person only", async () => {
    const h = await mount();
    expect(h.querySelector('[data-testid="user-row"] [data-testid="on-site-only"]')).toBeNull();
    expect(h.querySelector('[data-testid="user-row"] [data-testid="clock-in-off-site"]')).toBeNull();
    expect(h.querySelector('[data-testid="clock-in-off-site-note"]')).not.toBeNull();
    const edit = (name: string) => h.querySelector(`[data-testid="user-row"][data-user="${name}"] button[data-action="Edit"]`) as HTMLButtonElement;
    await act(async () => { edit("Callum Reeve").click(); });
    const dlg = document.querySelector('[data-testid="dlg-edit-user"]')!;
    expect(dlg.querySelector('[data-testid="on-site-only"]')?.textContent).toContain(ON_SITE_LABEL);
    expect(dlg.querySelector('[data-testid="clock-in-off-site"]')?.textContent).toContain(OFF_SITE_LABEL);
    expect((dlg.querySelector('[data-testid="on-site-only"] input') as HTMLInputElement).checked).toBe(true);
    await act(async () => { (dlg.querySelector('[data-testid="on-site-only"] input') as HTMLInputElement).click(); });
    await act(async () => { (dlg.querySelector('[data-testid="save-user"]') as HTMLButtonElement).click(); });
    expect(document.body.textContent).toContain("Changes to Callum Reeve would be saved: on site only.");
    expect(document.body.textContent).toContain("Nothing was saved.");
  });
  it("one 'N things need attention' disclosure holds the two original messages verbatim", async () => {
    const h = await mount();
    expect(h.querySelectorAll('[data-testid="attention"]').length).toBe(1);
    expect(h.querySelector('[data-testid="attention-summary"]')?.textContent).toBe("2 things need attention");
    expect(h.querySelector('[data-testid="attention"]')?.tagName).toBe("DETAILS");
    expect(h.querySelector('[data-testid="missing-names"]')?.textContent).toBe("1 person has no display name, so the Job Board can't say who a job is assigned to. Use Edit to add one, or ask them to add it in Account Settings.");
    expect(h.querySelector('[data-testid="admin-mfa-rule"]')?.textContent).toBe(adminMfaRuleMessage(overviewOf(SEED_USERS)!, (id) => nameOf(user(id))).text);
    expect(SRC).toContain("so the Job Board can&apos;t say who a job is assigned to. Use Edit to add one, or ask them to add it in Account Settings.");
    expect(PAGE).toContain("so the Job Board can&apos;t say who a job is assigned to. Use Edit to add one, or ask them to add it in Account Settings.");
  });
  it("one role pill style, and one primary action (Edit) per row with the rest under More", async () => {
    const h = await mount();
    const pills = Array.from(h.querySelectorAll('[data-testid="role-pill"]'));
    expect(pills.length).toBeGreaterThan(SEED_USERS.length - 3);
    expect(new Set(pills.map((p) => p.className)).size).toBe(1);
    for (const row of Array.from(h.querySelectorAll('[data-testid="user-row"]'))) {
      expect(row.querySelectorAll("button[data-action]").length).toBeLessThanOrEqual(1);
    }
    expect(h.querySelectorAll('button[aria-label^="More actions for"]').length).toBeGreaterThanOrEqual(SEED_USERS.length - 3);
  });
});
