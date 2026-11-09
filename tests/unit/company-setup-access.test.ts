// @vitest-environment jsdom
import { URL as NodeURL } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ role: "admin", session: { organization_id: "company-a", support: false, read_only: false }, reads: vi.fn(), writes: vi.fn() }));
vi.mock("@/lib/use-user", () => ({ useUser: () => ({ profile: { organization_id: "company-a" }, activeRole: state.role, session: state.session }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/settings" }));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/lib/company-setup/progress", async (original) => ({ ...(await original<object>()), readSetupProgress: (...args: unknown[]) => state.reads(...args), writeSetupProgress: (...args: unknown[]) => state.writes(...args) }));
import { CompanySetupGuide } from "@/components/company-setup-guide";
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.role = "admin"; state.session = { organization_id: "company-a", support: false, read_only: false };
  state.reads.mockReset().mockResolvedValue({ company: true }); state.writes.mockReset().mockResolvedValue(undefined);
  host = document.createElement("div"); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(createElement(CompanySetupGuide)));
it.each(["office", "workshop", "viewer"])("%s never reads or changes saved setup progress", async (role) => {
  state.role = role;
  await render();
  expect(host.textContent).toBe(""); expect(state.reads).not.toHaveBeenCalled(); expect(state.writes).not.toHaveBeenCalled();
});
it.each([false, true])("support cannot read or write setup progress even with admin role, read-only=%s", async (readOnly) => {
  state.session.support = true; state.session.read_only = readOnly;
  await render();
  expect(host.textContent).toBe(""); expect(state.reads).not.toHaveBeenCalled(); expect(state.writes).not.toHaveBeenCalled();
});
it("a missing/mismatched company session does not read progress", async () => {
  state.session.organization_id = "company-b";
  await render();
  expect(state.reads).not.toHaveBeenCalled(); expect(host.textContent).toBe("");
});
it("the own-company admin reads and changes only its progress, and loses access immediately on entering support", async () => {
  await render();
  expect(state.reads).toHaveBeenCalledTimes(1); expect(state.reads.mock.calls[0][1]).toBe("company-a");
  const checkbox = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
  expect(checkbox.checked).toBe(true);
  await act(async () => checkbox.click());
  expect(state.writes).toHaveBeenCalledWith({}, "company-a", "company", false);
  state.session = { ...state.session, support: true, read_only: true };
  await render();
  expect(host.textContent).toBe(""); expect(state.reads).toHaveBeenCalledTimes(1);
});

it("the unapplied database policy requires own-company admin and non-support for every read and write clause", async () => {
  const { readFileSync } = await import("node:fs");
  const sql = readFileSync(new NodeURL("../../supabase/proposals/n5_company_setup.sql", import.meta.url), "utf8");
  expect(sql).toContain("ALTER TABLE public.company_setup_progress ENABLE ROW LEVEL SECURITY");
  const policies = [...sql.matchAll(/CREATE POLICY "[^"]+" ON public\.company_setup_progress FOR (SELECT|INSERT|UPDATE) TO authenticated\s+([\s\S]*?);/g)];
  expect(policies.map((p) => p[1]).sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
  for (const [, action, expression] of policies) {
    const compact = expression.replace(/\s+/g, " ");
    const clauses = action === "UPDATE" ? 2 : 1;
    expect(compact.match(/organization_id = \(SELECT public\.current_user_organization_id\(\)\)/g)).toHaveLength(clauses);
    expect(compact.match(/public\.has_org_role\(ARRAY\['admin'\]\)/g)).toHaveLength(clauses);
    expect(compact.match(/NOT coalesce\(\(\(SELECT public\.my_session\(\)\) ->> 'support'\)::boolean,true\)/g)).toHaveLength(clauses);
    expect(compact).not.toMatch(/\bOR\b/i);
    expect(compact).not.toContain("_session_membership");
    expect(compact).not.toContain("session_read_only");
  }
  expect(sql).toContain("REVOKE ALL ON public.company_setup_progress FROM PUBLIC, anon, authenticated");
  expect(sql).toContain("EXECUTE FUNCTION public.support_readonly_guard()");
});
