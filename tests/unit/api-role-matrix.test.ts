/**
 * S2 (Fri 30 Oct): WHO each API route lets in, pinned as a table, and proved by calling every handler as each kind of login.
 * tests/unit/api-route-guards.test.ts proves every handler runs a guard first; this file pins which roles that guard allows, whether
 * the route always needs the second step (aal2) and whether it refuses a support session itself. The middleware lets every /api/
 * path through, so these handlers are the whole gate for a workshop or office login calling the API directly.
 *
 * Source of truth: the code's own guards (lib/server/auth.ts requireProfile, lib/server/admin-users.ts guard, lib/m365/route.ts
 * mailGuard, lib/server/platform.ts requirePlatformOwner, lib/server/cron-auth.ts isCronRequest) and the role lists in lib/; there are
 * no role guides in this repository. Not pinned here (the Design session is changing them): admin/users POST, auth/reset,
 * auth/change-password, ai-helper/*.
 *
 * Adding a route: give it a row in EXPECTED.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FINANCE_CHECK_ROLES } from "@/lib/ai/finance-check/request";
import { EMAIL_SEND_ROLES } from "@/lib/email/send-company-email";
import { AUTOMATIC_SEND_ROLES, CONNECT_ROLES, MANUAL_SEND_ROLES, MAPPING_ROLES } from "@/lib/integrations/xero/policy";

// ---- Part 1: the table, read from the source ----------------------------------------------------------------------------------

/** Role lists routes spread into requireProfile, and the module each must come from. */
const ROLE_CONSTANTS: Record<string, { module: string; roles: readonly string[] }> = {
  FINANCE_CHECK_ROLES: { module: "@/lib/ai/finance-check/request", roles: FINANCE_CHECK_ROLES },
  CONNECT_ROLES: { module: "@/lib/integrations/xero/policy", roles: CONNECT_ROLES },
  MAPPING_ROLES: { module: "@/lib/integrations/xero/policy", roles: MAPPING_ROLES },
  MANUAL_SEND_ROLES: { module: "@/lib/integrations/xero/policy", roles: MANUAL_SEND_ROLES },
  AUTOMATIC_SEND_ROLES: { module: "@/lib/integrations/xero/policy", roles: AUTOMATIC_SEND_ROLES },
  EMAIL_SEND_ROLES: { module: "@/lib/email/send-company-email", roles: EMAIL_SEND_ROLES },
};
const GUARDS: Record<string, string> = {
  requireProfile: "@/lib/server/auth",
  guard: "@/lib/server/admin-users",
  mailGuard: "@/lib/m365/route",
  requirePlatformOwner: "@/lib/server/platform",
  isCronRequest: "@/lib/server/cron-auth",
};
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/**
 * who:     the roles let in ("admin", "admin,office", ...), "signed-in" (any active member, viewer included), "platform owner", "cron"
 *          (CRON_SECRET), "public" (no sign-in, see api-route-guards PUBLIC_ROUTES), "self" (authenticates inline, own data only).
 * aal2:    "always" (whatever REQUIRE_ADMIN_MFA says), "switch" (admins only while REQUIRE_ADMIN_MFA is on: requireProfile's rule), "-".
 * support: "refused" (the route itself answers 403 to a support session), "db" (the database's read-only support rule decides), "-".
 */
type Row = { who: string; aal2: "always" | "switch" | "-"; support: "refused" | "db" | "-" };
const r = (who: string, aal2: Row["aal2"], support: Row["support"]): Row => ({ who, aal2, support });
const EXPECTED: Record<string, Row> = {
  // The alert test also asks for aal2 when the company's own rule (organizations.require_admin_mfa) is on.
  "admin/alert-test:POST": r("admin", "switch", "refused"),
  "admin/users:PATCH": r("admin", "switch", "refused"),
  "admin/users/companies:POST": r("admin", "switch", "refused"),
  "admin/users/mfa-reset:POST": r("admin", "always", "refused"),
  "admin/users/password:POST": r("admin", "always", "refused"),
  "admin/users/reset-link:POST": r("admin", "always", "refused"),
  "admin/users/sign-in:GET": r("admin", "switch", "refused"),
  "admin/users/sign-in:POST": r("admin", "always", "refused"),
  "ai/finance-check:POST": r("admin,office", "switch", "refused"),
  "ai/finance-check/decision:POST": r("admin,office", "switch", "refused"),
  "audit:POST": r("signed-in", "switch", "db"),
  "auth/session:GET": r("self", "-", "-"),
  "auth/signin:POST": r("public", "-", "-"),
  "auth/signout:POST": r("public", "-", "-"),
  "branding:GET": r("public", "-", "-"),
  "branding/logo:GET": r("public", "-", "-"),
  "branding/remember:POST": r("signed-in", "switch", "db"),
  "company-logo:GET": r("signed-in", "switch", "db"),
  "costing/[...path]:GET": r("admin,office", "switch", "db"),
  "costing/[...path]:POST": r("admin,office", "switch", "db"),
  "costing/status:GET": r("admin,office", "switch", "db"),
  "cron/daily:GET": r("cron", "-", "-"),
  "cron/email-schedules:GET": r("cron", "-", "-"),
  "cron/ip-purge:GET": r("cron", "-", "-"),
  "cron/nightly:GET": r("cron", "-", "-"),
  "cron/overview-snapshot:GET": r("cron", "-", "-"),
  "cron/xero-sweep:GET": r("cron", "-", "-"),
  "email/send:POST": r("admin,office", "switch", "refused"),
  "favicon:GET": r("public", "-", "-"),
  "health:GET": r("public", "-", "-"),
  // Platform owner only (the app's own Xero/Microsoft keys): requirePlatformOwner, aal2 always.
  "integrations/app-credentials:DELETE": r("platform owner", "always", "-"),
  "integrations/app-credentials:GET": r("platform owner", "always", "-"),
  "integrations/app-credentials:POST": r("platform owner", "always", "-"),
  "integrations/invite:DELETE": r("admin", "switch", "refused"),
  "integrations/invite:POST": r("admin", "switch", "refused"),
  // The accountant's one-use connect link (no sign-in; see api-route-guards PUBLIC_ROUTES for why each is safe).
  "integrations/invite/[token]:GET": r("public", "-", "-"),
  "integrations/invite/[token]:POST": r("public", "-", "-"),
  "integrations/invite/callback:GET": r("public", "-", "-"),
  "integrations/microsoft/callback:GET": r("admin", "switch", "refused"),
  "integrations/microsoft/connect:POST": r("admin", "switch", "refused"),
  "integrations/microsoft/disconnect:POST": r("admin", "switch", "refused"),
  "integrations/microsoft/test:POST": r("admin", "switch", "refused"),
  // Only whether the company's connections are set up; no secret is returned.
  "integrations/status:GET": r("admin", "switch", "db"),
  "integrations/xero/after-issue:POST": r("admin,office", "switch", "refused"),
  "integrations/xero/batch:POST": r("admin", "switch", "refused"),
  "integrations/xero/callback:GET": r("admin", "switch", "refused"),
  "integrations/xero/connect:POST": r("admin", "switch", "refused"),
  "integrations/xero/disconnect:POST": r("admin", "switch", "refused"),
  "integrations/xero/mappings:GET": r("admin", "switch", "refused"),
  "integrations/xero/mappings:POST": r("admin", "switch", "refused"),
  "integrations/xero/send:POST": r("admin", "switch", "refused"),
  // The accountant's summary (a read of the documents' totals; no token or secret): office as well as admin, by design (#47 E3).
  "integrations/xero/summary:GET": r("admin,office", "switch", "refused"),
  "integrations/xero/test:POST": r("admin", "switch", "refused"),
  "job-photos/[id]:GET": r("admin,office,workshop", "switch", "db"),
  // Mail: a read-only support session is stopped by the database before Microsoft is called (reserve_mail_send / record_inbound_email
  // / save_mail_poll_state write tables with the support_read_only trigger); an elevated one has write access by design.
  "mail/forward:POST": r("admin", "switch", "db"),
  "mail/poll:POST": r("admin", "switch", "db"),
  "mail/reply:POST": r("admin", "switch", "db"),
  "mail/resolve:POST": r("admin", "switch", "db"),
  "mail/send:POST": r("admin", "switch", "db"),
  "mail/status:GET": r("admin", "switch", "db"),
  "my-company-logos:GET": r("self", "-", "-"),
  "platform/organizations:POST": r("platform owner", "always", "-"),
  // D30-5 (Rhys): staff, workshop included, may tick "notify the admin" on a reopen they asked for. This only e-mails the company's
  // admins about the caller's own pending request of their own company, made in the last 15 minutes; it reopens nothing.
  "reopen-requests/notify:POST": r("admin,office,workshop", "switch", "db"),
  "report-error:POST": r("signed-in", "switch", "db"),
  "send-job:POST": r("admin,office", "switch", "db"),
  "send-job/resolve:POST": r("admin", "switch", "db"),
};
/** Being changed by the Design session (security/auth-routes): present, but not pinned here. */
const NOT_PINNED = new Set([
  "admin/users:POST", "auth/reset:POST", "auth/change-password:POST",
  "ai-helper/key:POST", "ai-helper/key:DELETE", "ai-helper/rfq:POST", "ai-helper/rfq/decision:POST", "ai-helper/roundup:POST",
  "ai-helper/settings:POST", "ai-helper/status:GET",
]);
const PUBLIC_OR_SELF = new Set(Object.entries(EXPECTED).filter(([, row]) => row.who === "public" || row.who === "self").map(([key]) => key));

type Fn = ts.FunctionLikeDeclaration;

function readRoute(route: string, source: string): Record<string, Row | string> {
  const file = ts.createSourceFile(`${route}.ts`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imported = new Map<string, string>();
  const topLevel = new Map<string, Fn>();
  /** Same-file `const X = ["admin", ...]` role lists (xero/summary's SUMMARY_ROLES). */
  const localRoles = new Map<string, string[]>();
  const handlers = new Map<string, Fn>();
  for (const s of file.statements) {
    if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings)) {
      for (const spec of s.importClause.namedBindings.elements) imported.set(spec.name.text, `${s.moduleSpecifier.text}#${(spec.propertyName ?? spec.name).text}`);
    }
    const exported = ts.canHaveModifiers(s) && (ts.getModifiers(s) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(s) && s.name) {
      topLevel.set(s.name.text, s);
      if (exported && METHODS.has(s.name.text)) handlers.set(s.name.text, s);
    }
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        const init = d.initializer && ts.isAsExpression(d.initializer) ? d.initializer.expression : d.initializer;
        if ((s.declarationList.flags & ts.NodeFlags.Const) && ts.isIdentifier(d.name) && init && ts.isArrayLiteralExpression(init) && init.elements.every(ts.isStringLiteral)) {
          localRoles.set(d.name.text, init.elements.map((e) => (e as ts.StringLiteral).text));
        }
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          topLevel.set(d.name.text, d.initializer);
          if (exported && METHODS.has(d.name.text)) handlers.set(d.name.text, d.initializer);
        }
      }
    }
  }
  const isGuard = (name: string) => Boolean(GUARDS[name]) && imported.get(name) === `${GUARDS[name]}#${name}`;

  /** The first guard call in the handler, following calls into same-file helpers (costing's forward()); and all the code walked. */
  const walk = (fn: Fn, seen: Set<Fn>, texts: string[], bodies: ts.Node[] = []): ts.CallExpression | null => {
    if (seen.has(fn) || !fn.body) return null;
    seen.add(fn);
    texts.push(fn.body.getText());
    bodies.push(fn.body);
    let found: ts.CallExpression | null = null;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (isGuard(node.expression.text)) { found = node; return; }
        const local = topLevel.get(node.expression.text);
        if (local) { const inner = walk(local, seen, texts, bodies); if (inner) { found = inner; return; } }
      }
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
    return found;
  };

  /** A second-step check at the top level of the body (not only inside an if: the alert test asks only when the company's rule is on). */
  const unconditionalAal2 = (body: ts.Node) => ts.isBlock(body) && body.statements.some((st) => ts.isVariableStatement(st) && /\.mfa\.getAuthenticatorAssuranceLevel\(\)/.test(st.getText()));

  const out: Record<string, Row | string> = {};
  for (const [method, fn] of handlers) {
    const key = `${route}:${method}`;
    const texts: string[] = [];
    const bodies: ts.Node[] = [];
    const call = walk(fn, new Set(), texts, bodies);
    const body = texts.join("\n");
    const inlineAal2 = bodies.some((b) => unconditionalAal2(b));
    // A 403, or (the Xero callback, a browser redirect) the page's "forbidden" outcome.
    const supportRefused = /if \(\w+\.session\?\.support\) return (jsonError\([^;]*, 403\)|back\("forbidden"\))/.test(body);
    if (!call) {
      out[key] = PUBLIC_OR_SELF.has(key) ? EXPECTED[key] : "no guard found";
      continue;
    }
    const name = (call.expression as ts.Identifier).text;
    if (name === "isCronRequest") { out[key] = r("cron", "-", "-"); continue; }
    if (name === "requirePlatformOwner") { out[key] = r("platform owner", "always", "-"); continue; }
    if (name === "guard") {
      const opts = call.arguments[1];
      const aal2 = !!opts && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) => ts.isPropertyAssignment(p) && p.name.getText() === "aal2" && p.initializer.kind === ts.SyntaxKind.TrueKeyword);
      out[key] = r("admin", aal2 || inlineAal2 ? "always" : "switch", "refused"); // guard(): requireProfile(["admin"]) and refuses support (checked below)
      continue;
    }
    if (name === "mailGuard") { out[key] = r("admin", inlineAal2 ? "always" : "switch", supportRefused ? "refused" : "db"); continue; }
    // requireProfile(roles?)
    const arg = call.arguments[0];
    let roles: string[] | string;
    if (!arg) roles = "signed-in";
    else if (ts.isArrayLiteralExpression(arg)) {
      roles = arg.elements.flatMap((e): string[] => {
        if (ts.isStringLiteral(e)) return [e.text];
        if (ts.isSpreadElement(e) && ts.isIdentifier(e.expression)) {
          const constant = ROLE_CONSTANTS[e.expression.text];
          if (constant && imported.get(e.expression.text) === `${constant.module}#${e.expression.text}`) return [...constant.roles];
        }
        return [`<unresolved ${e.getText()}>`];
      });
    } else if (ts.isIdentifier(arg) && localRoles.has(arg.text)) roles = [...localRoles.get(arg.text)!];
    else roles = [`<unresolved ${arg.getText()}>`];
    out[key] = r(typeof roles === "string" ? roles : roles.join(","), inlineAal2 ? "always" : "switch", supportRefused ? "refused" : "db");
  }
  return out;
}

const API_DIR = path.resolve(__dirname, "../../app/api");
const routeFiles = (readdirSync(API_DIR, { recursive: true }) as string[])
  .filter((rel) => path.basename(rel) === "route.ts")
  .map((rel) => ({ rel, route: path.dirname(rel).split(path.sep).join("/") }))
  .sort((a, b) => a.route.localeCompare(b.route));
const found: Record<string, Row | string> = Object.assign({}, ...routeFiles.map(({ rel, route }) => readRoute(route, readFileSync(path.join(API_DIR, rel), "utf8"))));

describe("API route x role table (read from the source)", () => {
  it("every exported handler has a row (or is one the Design session is changing)", () => {
    expect(Object.keys(found).filter((key) => !EXPECTED[key] && !NOT_PINNED.has(key)).sort()).toEqual([]);
    expect(Object.keys(EXPECTED).filter((key) => !(key in found)).sort()).toEqual([]);
    expect(Object.keys(found).length).toBeGreaterThanOrEqual(50);
  });

  it("each handler's guard lets in exactly the pinned roles, with the pinned second-step and support rule", () => {
    const actual = Object.fromEntries(Object.keys(EXPECTED).map((key) => [key, found[key]]));
    expect(actual).toEqual(EXPECTED);
  });

  it("no workshop or viewer login reaches an admin or office route; office reaches no admin-only route", () => {
    const rolesOf = (row: Row) => (["signed-in", "public", "self"].includes(row.who) ? ["admin", "office", "workshop", "viewer"] : row.who.split(","));
    const officeOnlyOrAbove = Object.entries(EXPECTED).filter(([, row]) => !["signed-in", "public", "self", "cron", "platform owner"].includes(row.who));
    for (const [key, row] of officeOnlyOrAbove) {
      expect([key, rolesOf(row).includes("viewer")]).toEqual([key, false]);
      // Office also reaches the Xero after-issue send and the read-only accountant's summary (#47).
      if (key.startsWith("admin/") || key.startsWith("mail/") || key.startsWith("integrations/xero/") && !key.includes("after-issue") && key !== "integrations/xero/summary:GET") {
        expect([key, row.who]).toEqual([key, "admin"]);
      }
    }
    // The one exception besides job photos is D30-5 (Rhys): workshop staff tick "notify the admin" on their own pending reopen request
    // (reopen-requests/notify only e-mails the admins; the reopen itself waits for an admin's approval).
    expect(officeOnlyOrAbove.filter(([, row]) => row.who.includes("workshop")).map(([key]) => key)).toEqual(["job-photos/[id]:GET", "reopen-requests/notify:POST"]);
  });

  it("the shared guards: admin-users guard() asks for admin and refuses support; mailGuard asks for admin", () => {
    const adminUsers = readFileSync(path.resolve(__dirname, "../../lib/server/admin-users.ts"), "utf8");
    const guardBody = adminUsers.slice(adminUsers.indexOf("export async function guard("), adminUsers.indexOf("export async function audit("));
    expect(guardBody).toMatch(/requireProfile\(\["admin"\]\)/);
    expect(guardBody).toMatch(/if \(auth\.session\?\.support\) return jsonError\([^;]*403\)/);
    const mail = readFileSync(path.resolve(__dirname, "../../lib/m365/route.ts"), "utf8");
    const mailBody = mail.slice(mail.indexOf("export async function mailGuard("), mail.indexOf("export function graphFailure("));
    expect(mailBody).toMatch(/requireProfile\(\["admin"\]\)/);
  });
});

// ---- Part 2: every guarded handler called as each kind of login ---------------------------------------------------------------
// The real requireProfile against a faked Supabase. A login whose roles the row does not allow gets 403 with nothing done: no
// service-role client, no network call, no database call past the guard's own reads. A support session (the platform owner's admin
// membership) gets 403 on every "refused" row, also with nothing done.

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }), headers: async () => new Headers() }));

type Persona = { role: string; secondary?: string | null; support?: boolean };
let who: Persona = { role: "admin" };
const GUARD_RPCS = new Set(["current_user_organization_id", "my_session", "has_org_role", "is_platform_admin"]);
const workCalls: string[] = [];
const chain = (result: unknown, table: string) => {
  const c: unknown = new Proxy(() => undefined, {
    get: (_, prop) => {
      if (prop === "then") return undefined;
      if (prop === "maybeSingle" || prop === "single") {
        if (table !== "user_profiles") workCalls.push(`from:${table}`);
        return () => Promise.resolve({ data: result, error: null });
      }
      return () => c;
    },
  });
  return c;
};
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1", email: "a@example.test" } }, error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2", nextLevel: "aal2" }, error: null }) },
    },
    from: (table: string) => chain(table === "user_profiles"
      ? { id: "user-1", email: "a@example.test", full_name: "A", role: who.role, secondary_role: who.secondary ?? null, organization_id: "org-1", active: true, must_change_password: false }
      : null, table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (!GUARD_RPCS.has(name)) workCalls.push(`rpc:${name}`);
      if (name === "current_user_organization_id") return { data: "org-1", error: null };
      if (name === "my_session") {
        return { data: { user_id: "user-1", organization_id: "org-1", role: who.role, secondary_role: who.secondary ?? null, support: who.support === true, read_only: who.support === true, platform_admin: who.support === true, organization_count: 1 }, error: null };
      }
      if (name === "has_org_role") {
        const allowed = (args.allowed_roles as string[]) ?? [];
        return { data: allowed.includes(who.role) || allowed.includes(who.secondary ?? "-"), error: null };
      }
      if (name === "is_platform_admin") return { data: who.support === true, error: null };
      return { data: null, error: null };
    },
  }),
}));
// Hoisted: EMAIL_SEND_ROLES is imported from the mailer at the top, which loads supabase-admin before this line would run.
const { createSupabaseAdminClient } = vi.hoisted(() => ({ createSupabaseAdminClient: vi.fn(() => null) }));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient }));

const PERSONAS: Record<string, Persona> = {
  admin: { role: "admin" },
  office: { role: "office" },
  workshop: { role: "workshop" },
  viewer: { role: "viewer" },
  "workshop+office": { role: "workshop", secondary: "office" },
  "support(admin)": { role: "admin", support: true },
};
const rolesOf = (persona: Persona) => [persona.role, persona.secondary].filter(Boolean) as string[];

const UUID = "11111111-1111-4111-8111-111111111111";
const requestFor = (route: string, method: string) => {
  const url = new URL(`https://app.test/api/${route.replace("[id]", UUID).replace("[...path]", "calculate")}`);
  if (route === "integrations/xero/callback" || route === "integrations/microsoft/callback") { url.searchParams.set("code", "c"); url.searchParams.set("state", "s"); }
  return new Request(url, method === "GET" ? { method } : { method, body: "{}", headers: { "content-type": "application/json" } });
};
const contextFor = (route: string) => (route.includes("[id]") ? { params: Promise.resolve({ id: UUID }) } : route.includes("[...path]") ? { params: Promise.resolve({ path: ["calculate"] }) } : undefined);

/** A refusal: 403 (or the Xero / Microsoft callback's redirect back to the page with "forbidden"). */
const refused = (response: Response) => {
  if (response.status === 403) return true;
  const back = new URL(response.headers.get("location") ?? "https://x/").searchParams;
  return response.status === 303 && (back.get("xero") === "forbidden" || back.get("microsoft") === "forbidden");
};

const guardedRows = Object.entries(EXPECTED).filter(([, row]) => !["public", "self", "cron", "signed-in"].includes(row.who));

describe("API route x login matrix (each handler called as each login)", () => {
  const fetchSpy = vi.fn(async () => { throw new Error("network is not allowed in this test"); });
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
    process.env.REQUIRE_ADMIN_MFA = "false";
    process.env.AI_FINANCE_CHECK_ENABLED = "true"; // on, so the role check is what answers (off, the route is a 404 for everyone)
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete process.env.REQUIRE_ADMIN_MFA;
    delete process.env.AI_FINANCE_CHECK_ENABLED;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(guardedRows)("%s", async (key, row) => {
    const [route, method] = key.split(":");
    const mod = (await import(`@/app/api/${route}/route`)) as Record<string, (req: Request, ctx?: unknown) => Promise<Response>>;
    for (const [name, persona] of Object.entries(PERSONAS)) {
      who = persona;
      const allowedByRole = row.who === "platform owner" ? persona.support === true : row.who.split(",").some((role) => rolesOf(persona).includes(role));
      const mustRefuse = !allowedByRole || (persona.support === true && row.support === "refused");
      if (!mustRefuse) continue;
      workCalls.length = 0;
      createSupabaseAdminClient.mockClear();
      fetchSpy.mockClear();
      const response = await mod[method](requestFor(route, method), contextFor(route));
      expect([key, name, response.status, refused(response)]).toEqual([key, name, response.status, true]);
      expect([key, name, createSupabaseAdminClient.mock.calls.length, fetchSpy.mock.calls.length, workCalls]).toEqual([key, name, 0, 0, []]);
    }
  });
});
