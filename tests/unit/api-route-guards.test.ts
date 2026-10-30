// Every API route guards itself. middleware.ts lets every /api/ path through untouched (`if (isApi) return response;`), so a route
// handler with no guard of its own is open to the internet. This test reads every app/api/**/route.ts and, for each exported handler
// (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS), requires a guard statement at the TOP LEVEL of the handler, before anything else that
// matters, or that the route is on PUBLIC_ROUTES below with the reason it is safe without one. A guard statement is one of:
//   const x = await requireProfile(..);  if (isErrorResponse(x)) return ..;     (or `if (x instanceof NextResponse) return ..`)
//   if (!isCronRequest(request)) return ..;
//   return helper(..);   where helper is a function in the same file that starts with a guard statement (costing's forward()).
// The guard must be the symbol imported from its own module (GUARD_IMPORTS); isErrorResponse and NextResponse likewise.
//
// Before the guard only these may run: reading the route's own `params`, same-origin checks, building error answers, reading the URL and
// headers, regex tests and same-file helpers that do no more than that (SAFE_CALLS, SAFE_METHODS). Any other call (awaited or not, an IIFE,
// `void sideEffect()`, the service-role client, fetch) or any other await is work before the guard, and fails.
//
// Not covered, deliberately: what the guard functions themselves check (they have their own tests); getters or proxies that do work on a
// property read; work hidden in a call this list treats as safe (e.g. a `.get()` on something that isn't a URL or Headers); a handler built
// by a wrapper (`export const GET = wrap(fn)`), which is reported as "could not be analysed" and so fails until it is listed.
//
// Adding a route: start with a guard statement, or add it to PUBLIC_ROUTES with why it needs no sign-in.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Each guard and the module it must be imported from. */
const GUARD_IMPORTS: Record<string, string> = {
  requireProfile: "@/lib/server/auth",
  guard: "@/lib/server/admin-users",
  mailGuard: "@/lib/m365/route",
  requirePlatformOwner: "@/lib/server/platform",
  isCronRequest: "@/lib/server/cron-auth",
};
const CHECK_IMPORTS: Record<string, string> = { isErrorResponse: "@/lib/server/auth", NextResponse: "next/server" };
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
/** Plain functions that may run before the guard: checks and error answers, nothing that reads or writes data. */
const SAFE_CALLS = new Set(["sameOrigin", "forbiddenOrigin", "jsonError", "encodeURIComponent", "String", "Number", "Boolean"]);
/** Methods that may run before the guard: building a response, a regex test, reading the URL or headers. */
const SAFE_METHODS = new Set(["json", "redirect", "test", "get", "has"]);
const SAFE_NEW = new Set(["URL", "Headers"]);

/** Deliberately public handlers ("<path under app/api>:<METHOD>") and why each is safe without a guard. */
const PUBLIC_ROUTES: Record<string, string> = {
  "health:GET": "Uptime check: answers only { ok, database } from the auth service's own health endpoint. No data, no service role.",
  "branding:GET": "Sign-in page branding: only an active company that opted in, only public fields; every miss gets the same empty answer.",
  "branding/logo:GET": "Sign-in page logo: only an active company that opted in, only its own current logo; the bucket stays private and every miss gets the same empty 404.",
  "favicon:GET": "The product icon (a fixed image); no company data, no database.",
  "auth/signin:POST": "Signing in: same-origin, rate limited per IP and per account (fails closed); service role only for the limiter and the username lookup.",
  "auth/reset:POST": "Forgot password: same-origin, rate limited (fails closed), same answer whether or not the account exists.",
  "auth/signout:POST": "Ends the caller's own session (same-origin); touches nothing else.",
  "auth/session:GET": "Answers only the caller's own user id and e-mail from their own cookie, or null.",
  "auth/change-password:POST": "Self-authenticates inline (auth.getUser() before any write); every write is to the caller's own login (user.id).",
  "my-company-logos:GET": "Self-authenticates inline (auth.getUser()); the service role reads only the companies my_organizations() returns AS THE CALLER.",
  // 107 (E2): the accountant's Xero connect link, opened signed out. Each grants exactly one company's Xero Connect and nothing else.
  "integrations/invite/[token]:GET": "The accountant's one-use Xero connect link's page: rate limited; only an open link's company name (integration_invite_peek, service role) and a Continue button. Nothing is used up; a bad link gets a fixed page.",
  "integrations/invite/[token]:POST": "The connect link's Continue button: same origin, rate limited; only an open link (integration_invite_redeem, service role, used up at once, its admin still an admin) starts that one company's Xero Connect.",
  "integrations/invite/callback:GET": "Xero's return for a connect link: only a state a link started in the last 10 minutes (integration_oauth_consume_invite: single use, invite states only) completes that link's company, as its admin; a fixed page, nothing else.",
};

type Finding = { route: string; method: string; ok: boolean; reason: string };
type Fn = ts.FunctionLikeDeclaration;
type Outcome = { ok: true } | { ok: false; reason: string };

const strip = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) ? strip(e.expression) : e);

function isParamsRead(expr: ts.Expression): boolean {
  const inner = strip(expr);
  if (ts.isIdentifier(inner)) return inner.text === "params";
  return ts.isPropertyAccessExpression(inner) && inner.name.text === "params";
}

/** Analyses one route file's source. Exported handlers only; same-file helpers are followed. */
function analyseRoute(route: string, source: string): Finding[] {
  const file = ts.createSourceFile(`${route}.ts`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const topLevel = new Map<string, Fn>();
  const anyLocal = new Map<string, Fn>();
  const handlers = new Map<string, Fn | null>();
  const imported = new Map<string, string>(); // local name -> "module#importedName"
  const exported = (node: ts.Node) => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const spec of bindings.elements) imported.set(spec.name.text, `${statement.moduleSpecifier.text}#${(spec.propertyName ?? spec.name).text}`);
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      topLevel.set(statement.name.text, statement);
      if (exported(statement) && METHODS.has(statement.name.text)) handlers.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const init = d.initializer;
        const fn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : null;
        if (fn) topLevel.set(d.name.text, fn);
        if (exported(statement) && METHODS.has(d.name.text)) handlers.set(d.name.text, fn ?? (init && ts.isIdentifier(init) ? topLevel.get(init.text) ?? null : null));
      }
    } else if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const spec of statement.exportClause.elements) {
        if (METHODS.has(spec.name.text)) handlers.set(spec.name.text, null); // resolved below, once every local is known
      }
    }
  }
  for (const statement of file.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const spec of statement.exportClause.elements) {
      if (METHODS.has(spec.name.text)) handlers.set(spec.name.text, topLevel.get((spec.propertyName ?? spec.name).text) ?? null);
    }
  }
  // Helpers declared anywhere (e.g. `const back = (..) => NextResponse.redirect(..)` inside a handler).
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      anyLocal.set(node.name.text, node.initializer);
    }
    if (ts.isFunctionDeclaration(node) && node.name) anyLocal.set(node.name.text, node);
    ts.forEachChild(node, collect);
  };
  collect(file);

  const importedAs = (name: string, table: Record<string, string>) => {
    const want = Object.entries(table).find(([, module]) => imported.get(name)?.startsWith(`${module}#`));
    return want && imported.get(name) === `${want[1]}#${want[0]}` ? want[0] : null;
  };
  const guardName = (expr: ts.Expression): string | null => {
    const e = strip(expr);
    const call = ts.isAwaitExpression(e) ? strip(e.expression) : e;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return null;
    return importedAs(call.expression.text, GUARD_IMPORTS);
  };
  const guardCall = (expr: ts.Expression): ts.CallExpression => {
    const e = strip(expr);
    return strip(ts.isAwaitExpression(e) ? e.expression : e) as ts.CallExpression;
  };
  const returns = (s: ts.Statement) => ts.isReturnStatement(s) || (ts.isBlock(s) && s.statements.length > 0 && ts.isReturnStatement(s.statements[0]));

  /** Work or a misplaced guard anywhere inside `node` (nested function bodies don't run where they are written). */
  const scan = (node: ts.Node, seen: Set<Fn>): string | null => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) return null;
    if (ts.isAwaitExpression(node)) return isParamsRead(node.expression) ? null : scan(node.expression, seen) ?? `await before the guard: ${node.getText().slice(0, 80)}`;
    if (ts.isNewExpression(node)) {
      if (!ts.isIdentifier(node.expression) || !SAFE_NEW.has(node.expression.text)) return `new before the guard: ${node.getText().slice(0, 80)}`;
      return (node.arguments ?? []).reduce<string | null>((found, arg) => found ?? scan(arg, seen), null);
    }
    // A tagged template (`` sendAlert`x` ``) is a call too.
    if (ts.isTaggedTemplateExpression(node)) return scan(node.template, seen) ?? `call before the guard: ${node.getText().slice(0, 80)}`;
    if (ts.isCallExpression(node)) {
      const callee = strip(node.expression);
      if (ts.isIdentifier(callee) && importedAs(callee.text, GUARD_IMPORTS)) return `guard not used as a top-level guard statement: ${node.getText().slice(0, 80)}`;
      const inner = (ts.isPropertyAccessExpression(callee) ? scan(callee.expression, seen) : null)
        ?? node.arguments.reduce<string | null>((found, arg) => found ?? scan(arg, seen), null);
      if (inner) return inner;
      if (ts.isPropertyAccessExpression(callee) && SAFE_METHODS.has(callee.name.text)) return null;
      if (ts.isIdentifier(callee) && SAFE_CALLS.has(callee.text) && !anyLocal.has(callee.text)) return null;
      const local = ts.isIdentifier(callee) ? anyLocal.get(callee.text) : undefined;
      if (local) {
        if (seen.has(local) || !local.body) return null;
        seen.add(local);
        return scan(local.body, seen);
      }
      return `call before the guard: ${node.getText().slice(0, 80)}`;
    }
    return ts.forEachChild(node, (child) => scan(child, seen) ?? undefined) ?? null;
  };

  const analyse = (fn: Fn, seen: Set<Fn>): Outcome => {
    if (seen.has(fn) || !fn.body) return { ok: false, reason: "no guard" };
    seen.add(fn);
    const statements: readonly ts.Statement[] = ts.isBlock(fn.body) ? fn.body.statements : [ts.factory.createReturnStatement(fn.body)];
    for (let i = 0; i < statements.length; i += 1) {
      const s = statements[i];
      // const x = await guard(..); if (isErrorResponse(x) | x instanceof NextResponse) return ..;
      if (ts.isVariableStatement(s) && s.declarationList.declarations.length === 1) {
        const d = s.declarationList.declarations[0];
        if (d.initializer && guardName(d.initializer)) {
          if (!ts.isAwaitExpression(strip(d.initializer))) return { ok: false, reason: "guard call is not awaited" };
          const args = guardCall(d.initializer).arguments.reduce<string | null>((found, arg) => found ?? scan(arg, new Set()), null);
          if (args) return { ok: false, reason: args };
          const next = statements[i + 1];
          const name = ts.isIdentifier(d.name) ? d.name.text : null;
          const cond = next && ts.isIfStatement(next) ? strip(next.expression) : null;
          const checks = !!name && !!cond && (
            (ts.isCallExpression(cond) && ts.isIdentifier(cond.expression) && importedAs(cond.expression.text, CHECK_IMPORTS) === "isErrorResponse"
              && cond.arguments.length === 1 && ts.isIdentifier(cond.arguments[0]) && cond.arguments[0].text === name)
            || (ts.isBinaryExpression(cond) && cond.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && ts.isIdentifier(cond.left) && cond.left.text === name
              && ts.isIdentifier(cond.right) && importedAs(cond.right.text, CHECK_IMPORTS) === "NextResponse"));
          if (!checks || !returns((next as ts.IfStatement).thenStatement)) return { ok: false, reason: "guard's answer is not checked and returned" };
          // The refusal branch runs for an unauthenticated caller, so it may not do work either.
          const refusal = scan((next as ts.IfStatement).thenStatement, new Set());
          return refusal ? { ok: false, reason: `work in the refusal branch: ${refusal}` } : { ok: true };
        }
      }
      // if (!isCronRequest(request)) return ..;
      if (ts.isIfStatement(s)) {
        const cond = strip(s.expression);
        if (ts.isPrefixUnaryExpression(cond) && cond.operator === ts.SyntaxKind.ExclamationToken && guardName(cond.operand) && returns(s.thenStatement)) {
          const args = guardCall(cond.operand).arguments.reduce<string | null>((found, arg) => found ?? scan(arg, new Set()), null);
          if (args) return { ok: false, reason: args };
          const refusal = scan(s.thenStatement, new Set());
          return refusal ? { ok: false, reason: `work in the refusal branch: ${refusal}` } : { ok: true };
        }
      }
      // return helper(..);  -- the helper's refusal is this handler's answer.
      if (ts.isReturnStatement(s) && s.expression) {
        const e = strip(s.expression);
        const call = ts.isAwaitExpression(e) ? strip(e.expression) : e;
        const helper = ts.isCallExpression(call) && ts.isIdentifier(call.expression) ? topLevel.get(call.expression.text) : undefined;
        if (helper && ts.isCallExpression(call)) {
          const args = call.arguments.reduce<string | null>((found, arg) => found ?? scan(arg, new Set()), null);
          return args ? { ok: false, reason: args } : analyse(helper, seen);
        }
      }
      const problem = scan(s, new Set());
      if (problem) return { ok: false, reason: problem };
      if (ts.isReturnStatement(s) || ts.isThrowStatement(s)) return { ok: false, reason: "no guard" };
    }
    return { ok: false, reason: "no guard" };
  };

  return [...handlers].map(([method, fn]) => {
    if (!fn) return { route, method, ok: false, reason: "exported handler could not be analysed" };
    const outcome = analyse(fn, new Set());
    return outcome.ok ? { route, method, ok: true, reason: "guarded" } : { route, method, ok: false, reason: outcome.reason };
  });
}

/** Every finding that is neither guarded nor on the public list. */
function gaps(findings: Finding[], publicRoutes: Record<string, string>): Finding[] {
  return findings.filter((f) => !f.ok && !publicRoutes[`${f.route}:${f.method}`]);
}

const API_DIR = path.resolve(__dirname, "../../app/api");
const routeFiles = (readdirSync(API_DIR, { recursive: true }) as string[])
  .filter((rel) => path.basename(rel) === "route.ts")
  .map((rel) => ({ route: path.dirname(rel).split(path.sep).join("/"), source: readFileSync(path.join(API_DIR, rel), "utf8") }))
  .sort((a, b) => a.route.localeCompare(b.route));
const findings = routeFiles.flatMap(({ route, source }) => analyseRoute(route, source));

describe("every app/api route handler guards itself (middleware lets /api/ through)", () => {
  it("finds the route files and their handlers", () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(35);
    expect(findings.length).toBeGreaterThanOrEqual(routeFiles.length);
  });

  it("each handler calls a known guard first (and returns its refusal), or is on the public list with a reason", () => {
    expect(gaps(findings, PUBLIC_ROUTES).map((f) => `${f.route}:${f.method} - ${f.reason}`)).toEqual([]);
  });

  it("the public list names only handlers that exist, each with a reason", () => {
    const present = new Set(findings.map((f) => `${f.route}:${f.method}`));
    expect(Object.keys(PUBLIC_ROUTES).filter((key) => !present.has(key))).toEqual([]);
    for (const reason of Object.values(PUBLIC_ROUTES)) expect(reason.length).toBeGreaterThan(20);
  });

  it("the routes that use the service role on a company's behalf, or send e-mail, are guarded, not public", () => {
    for (const key of ["admin/alert-test:POST", "send-job:POST", "mail/send:POST", "cron/ip-purge:GET", "cron/daily:GET", "job-photos/[id]:GET", "integrations/xero/send:POST", "integrations/xero/after-issue:POST", "integrations/xero/callback:GET",
      "integrations/xero/disconnect:POST", "integrations/xero/test:POST", "integrations/microsoft/connect:POST", "integrations/microsoft/callback:GET",
      "integrations/microsoft/disconnect:POST", "integrations/microsoft/test:POST", "integrations/invite:POST", "integrations/invite:DELETE", "integrations/status:GET",
      "integrations/app-credentials:GET", "integrations/app-credentials:POST", "integrations/app-credentials:DELETE", "admin/users:POST", "admin/users:PATCH", "admin/users/sign-in:GET", "admin/users/sign-in:POST",
      "admin/users/password:POST", "admin/users/mfa-reset:POST", "admin/users/companies:POST", "platform/organizations:POST"]) {
      expect(PUBLIC_ROUTES[key]).toBeUndefined();
      expect(findings.find((f) => `${f.route}:${f.method}` === key)).toMatchObject({ ok: true });
    }
  });
});

describe("the check itself fails on an unguarded route (fixtures, not real routes)", () => {
  const IMPORTS = `
    import { NextResponse } from "next/server";
    import { forbiddenOrigin, isErrorResponse, jsonError, requireProfile, sameOrigin } from "@/lib/server/auth";
    import { guard } from "@/lib/server/admin-users";
    import { isCronRequest } from "@/lib/server/cron-auth";
    import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";
    import { sendAlert } from "@/lib/server/error-alert";
  `;
  const one = (source: string) => analyseRoute("fixture/new", IMPORTS + source);
  const reasonOf = (source: string) => {
    const found = one(source);
    expect(found).toHaveLength(1);
    expect(found[0].ok).toBe(false);
    expect(gaps(found, PUBLIC_ROUTES)).toHaveLength(1);
    return found[0].reason;
  };
  const CHECKED = `const auth = await requireProfile(["admin"]);\n if (isErrorResponse(auth)) return auth;`;

  it("no guard at all", () => {
    expect(reasonOf(`export async function GET() {
      const admin = createSupabaseAdminClient();
      return Response.json(await admin.from("invoices").select("*"));
    }`)).toMatch(/before the guard/);
    expect(reasonOf(`export async function GET() { return Response.json({ ok: true }); }`)).toBe("no guard");
  });

  it("a guard after a side effect (awaited, un-awaited `void`, an IIFE, the service-role client)", () => {
    expect(reasonOf(`export async function POST() { await createSupabaseAdminClient()!.from("jobs").delete().eq("id", "x"); ${CHECKED} }`)).toMatch(/before the guard/);
    expect(reasonOf(`export async function POST() { void sendAlert("x"); ${CHECKED} }`)).toMatch(/call before the guard: sendAlert/);
    expect(reasonOf(`export async function POST() { (async () => { await sendAlert("x"); })(); ${CHECKED} }`)).toMatch(/call before the guard/);
    expect(reasonOf(`export async function POST() { const admin = createSupabaseAdminClient(); ${CHECKED} return Response.json(admin); }`)).toMatch(/call before the guard: createSupabaseAdminClient/);
  });

  it("an early return of an imported function before the guard", () => {
    expect(reasonOf(`export async function POST(r: Request) { if (r.headers.get("x")) return sendAlert(r); ${CHECKED} }`)).toMatch(/call before the guard: sendAlert/);
    expect(reasonOf(`export async function POST(r: Request) { return sendAlert(r); }`)).toMatch(/call before the guard: sendAlert/);
  });

  it("a guard only inside an if branch", () => {
    expect(reasonOf(`export async function POST(r: Request) {
      if (r.headers.get("x")) { ${CHECKED} }
      return Response.json(await createSupabaseAdminClient()!.from("jobs").select());
    }`)).toMatch(/guard not used as a top-level guard statement/);
  });

  it("an un-awaited guard call: the checked value is a promise, so the check never refuses", () => {
    expect(reasonOf(`export async function POST() { const auth = requireProfile(["admin"]); if (isErrorResponse(auth)) return auth; return Response.json(auth); }`)).toBe("guard call is not awaited");
  });

  it("work inside the refusal branch (it runs for a caller who is not allowed in)", () => {
    expect(reasonOf(`export async function POST() { const auth = await requireProfile(["admin"]); if (isErrorResponse(auth)) return Response.json(await createSupabaseAdminClient()!.from("jobs").select()); return auth; }`))
      .toMatch(/work in the refusal branch/);
    expect(reasonOf(`export async function GET(r: Request) { if (!isCronRequest(r)) return Response.json(await createSupabaseAdminClient()!.from("jobs").select()); return Response.json({}); }`))
      .toMatch(/work in the refusal branch/);
  });

  it("a tagged template call before the guard", () => {
    expect(reasonOf("export async function POST() { void sendAlert`x`; " + CHECKED + " }")).toMatch(/call before the guard: sendAlert/);
  });

  it("a guard whose answer is ignored, or checked against a different variable", () => {
    expect(reasonOf(`export async function POST() { const auth = await requireProfile(["admin"]); return Response.json({ id: auth }); }`)).toBe("guard's answer is not checked and returned");
    expect(reasonOf(`export async function POST() { const other = 1; const auth = await requireProfile(["admin"]); if (isErrorResponse(other)) return other; return Response.json(auth); }`))
      .toBe("guard's answer is not checked and returned");
    expect(reasonOf(`export async function POST() { const auth = await requireProfile(["admin"]); if (isErrorResponse(auth)) console.log("refused"); return Response.json(auth); }`))
      .toBe("guard's answer is not checked and returned");
  });

  it("an inverted check: if (isCronRequest(r)) return ..", () => {
    expect(reasonOf(`export async function GET(r: Request) { if (isCronRequest(r)) return Response.json({}); return Response.json(await createSupabaseAdminClient()!.rpc("purge")); }`))
      .toMatch(/guard not used as a top-level guard statement/);
  });

  it("a look-alike guard: a local function of the same name, a method `x.requireProfile()`, or one imported from elsewhere", () => {
    expect(analyseRoute("fixture/new", `
      import { isErrorResponse } from "@/lib/server/auth";
      async function requireProfile() { return { ok: true }; }
      export async function POST() { const auth = await requireProfile(); if (isErrorResponse(auth)) return auth; return Response.json(auth); }`)[0])
      .toMatchObject({ ok: false });
    expect(reasonOf(`export async function POST() { const auth = await helpers.requireProfile(); if (isErrorResponse(auth)) return auth; return Response.json(auth); }`))
      .toMatch(/before the guard/);
    expect(analyseRoute("fixture/new", `
      import { isErrorResponse } from "@/lib/server/auth";
      import { requireProfile } from "@/lib/fake-auth";
      export async function POST() { const auth = await requireProfile(); if (isErrorResponse(auth)) return auth; return Response.json(auth); }`)[0])
      .toMatchObject({ ok: false });
  });

  it("arrow-function and re-exported handlers are checked too", () => {
    expect(reasonOf(`export const DELETE = async () => { await fetch("https://x.test"); return new Response(null); };`)).toMatch(/before the guard/);
    expect(reasonOf(`async function handler() { return Response.json(await sendAlert()); }\nexport { handler as PUT };`)).toMatch(/before the guard/);
  });

  it("passes a guarded handler: sync checks and the route's params first, a same-file helper followed, the cron check", () => {
    expect(one(`
      export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
        const { id } = await params;
        if (!/^[0-9a-f-]{36}$/.test(id)) return jsonError("Not found", 404);
        if (!sameOrigin(request)) return forbiddenOrigin();
        const auth = await requireProfile(["admin"]);
        if (isErrorResponse(auth)) return auth;
        return Response.json(await auth.supabase.from("jobs").select("id").eq("id", id));
      }`)).toEqual([expect.objectContaining({ ok: true })]);
    expect(one(`
      async function forward(request: Request) {
        const ctx = await guard(request);
        if (ctx instanceof NextResponse) return ctx;
        return Response.json(await ctx.admin.from("x").select());
      }
      export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
        return forward(request, (await params).path);
      }`)).toEqual([expect.objectContaining({ ok: true })]);
    expect(one(`
      export async function GET(request: Request) {
        if (!isCronRequest(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
        return Response.json(await createSupabaseAdminClient()!.rpc("purge"));
      }`)).toEqual([expect.objectContaining({ ok: true })]);
  });
});

// The Xero routes that write with the service role refuse every support session (read-only or elevated: Rhys, Wed 21 Oct, Xero is an
// admin's) before the service-role client is created, with the same check and wording as the Xero PR 2 branch.
const createSupabaseAdminClient = vi.fn(() => ({}));
let session: { read_only: boolean; support: boolean } | null = null;
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient }));
vi.mock("@/lib/integrations/server", () => ({
  DbError: class extends Error {},
  xeroReady: () => ({ config: {}, key: Buffer.alloc(32) }),
  sendQueued: vi.fn(async () => ({ sent: 0 })),
  disconnectCompany: vi.fn(async () => ({ removedAtXero: false })),
}));
vi.mock("@/lib/server/auth", () => ({
  sameOrigin: () => true,
  forbiddenOrigin: () => NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  isErrorResponse: (v: unknown) => v instanceof NextResponse,
  jsonError: (m: string, s: number) => NextResponse.json({ error: m }, { status: s }),
  readJson: async (r: Request) => ({ ok: true, data: await r.json() }),
  requireProfile: vi.fn(async () => ({ supabase: {}, user: { id: "u1" }, profile: { organization_id: "org-1", role: "admin" }, session })),
}));

describe("Xero service-role routes refuse every support session", () => {
  beforeEach(() => { createSupabaseAdminClient.mockClear(); });
  const post = (body: unknown = {}) => new Request("https://app.example.test/x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const routes = [
    ["send", () => import("@/app/api/integrations/xero/send/route"), {}],
    ["after-issue", () => import("@/app/api/integrations/xero/after-issue/route"), { doc_type: "invoice", doc_id: "11111111-1111-4111-8111-111111111111" }],
    ["disconnect", () => import("@/app/api/integrations/xero/disconnect/route"), {}],
  ] as const;

  it.each(routes)("%s: read-only and elevated support get 403 and no service-role client", async (_name, load, body) => {
    for (const s of [{ read_only: true, support: true }, { read_only: false, support: true }]) {
      session = s;
      createSupabaseAdminClient.mockClear();
      const response = await (await load()).POST(post(body));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Support access can't change Xero settings." });
      expect(createSupabaseAdminClient).not.toHaveBeenCalled();
    }
  });

  it.each(routes)("%s: the company's own admin still goes through", async (_name, load, body) => {
    for (const s of [null, { read_only: false, support: false }]) {
      session = s;
      createSupabaseAdminClient.mockClear();
      const response = await (await load()).POST(post(body));
      expect(response.status).toBe(200);
      expect(createSupabaseAdminClient).toHaveBeenCalledTimes(1);
    }
  });
});
