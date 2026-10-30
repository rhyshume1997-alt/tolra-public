// CSRF (security review S4, 30 Oct). Every route under app/api authenticates the browser by its Supabase session COOKIE (requireProfile,
// guard, mailGuard, requirePlatformOwner and the auth routes all read it through next/headers); none takes an Authorization header from
// the browser (the cron route's bearer secret is server to server). The auth cookie is SameSite=Lax (@supabase/ssr's default), and on
// top of that every state-changing handler (POST, PUT, PATCH, DELETE) must refuse a cross-site request with sameOrigin() FIRST, before
// any work: directly, or through a guard or same-file helper whose own first statement is that check.
//
// Part 1 pins what sameOrigin() accepts and refuses (it had no test of its own: the route tests mock it). Part 2 reads every route file
// and fails for a state-changing handler that does not start with the check, so a new route can't be added without it.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { sameOrigin } from "@/lib/server/auth";

const req = (headers: Record<string, string>, url = "https://acme.tolra.app/api/audit") => new Request(url, { method: "POST", headers });

describe("sameOrigin(): the CSRF check every state-changing route starts with", () => {
  it("accepts the app's own origin (Host, the deployment's X-Forwarded-Host, or the request URL's host)", () => {
    expect(sameOrigin(req({ origin: "https://acme.tolra.app", host: "acme.tolra.app", "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(sameOrigin(req({ origin: "https://acme.tolra.app", host: "internal:3000", "x-forwarded-host": "acme.tolra.app, proxy" }))).toBe(true);
    expect(sameOrigin(req({ origin: "https://acme.tolra.app" }))).toBe(true);
  });

  it("refuses another site, a sibling company's subdomain, another port or scheme-less junk", () => {
    expect(sameOrigin(req({ origin: "https://evil.example", host: "acme.tolra.app" }))).toBe(false);
    expect(sameOrigin(req({ origin: "https://beta.tolra.app", host: "acme.tolra.app" }))).toBe(false);
    expect(sameOrigin(req({ origin: "https://acme.tolra.app:8443", host: "acme.tolra.app" }))).toBe(false);
    expect(sameOrigin(req({ origin: "acme.tolra.app", host: "acme.tolra.app" }))).toBe(false);
  });

  it('refuses the opaque "null" origin (sandboxed iframes, data: pages, some redirects)', () => {
    expect(sameOrigin(req({ origin: "null", host: "acme.tolra.app" }))).toBe(false);
  });

  it("refuses Sec-Fetch-Site: cross-site even when no Origin is sent", () => {
    expect(sameOrigin(req({ "sec-fetch-site": "cross-site", host: "acme.tolra.app" }))).toBe(false);
    expect(sameOrigin(req({ "sec-fetch-site": "cross-site", origin: "https://acme.tolra.app", host: "acme.tolra.app" }))).toBe(false);
  });

  it("lets a request with no Origin through (curl, server to server): a browser always sends Origin on a POST, and the cookie is SameSite=Lax", () => {
    expect(sameOrigin(req({ host: "acme.tolra.app" }))).toBe(true);
  });
});

// ---- Part 2: every state-changing handler starts with the check ----------------------------------------------------------------

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Guards imported from elsewhere whose first statement is the sameOrigin check (verified below from their own source). */
const ORIGIN_GUARDS: Record<string, { file: string; fn: string }> = {
  guard: { file: "lib/server/admin-users.ts", fn: "guard" },
  mailGuard: { file: "lib/m365/route.ts", fn: "mailGuard" },
  requirePlatformOwner: { file: "lib/server/platform.ts", fn: "requirePlatformOwner" },
};

const ROOT = path.resolve(__dirname, "../..");
const strip = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isNonNullExpression(e) ? strip(e.expression) : e);
const parse = (file: string, source: string) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** `if (!sameOrigin(x)) return ..;` or `if (<anything> && !sameOrigin(x)) return ..;` (costing's forward(): only its POST changes anything). */
function isOriginCheck(s: ts.Statement): boolean {
  if (!ts.isIfStatement(s)) return false;
  const thenReturns = ts.isReturnStatement(s.thenStatement) || (ts.isBlock(s.thenStatement) && s.thenStatement.statements.length > 0 && ts.isReturnStatement(s.thenStatement.statements[s.thenStatement.statements.length - 1]));
  if (!thenReturns) return false;
  const negatedCall = (e: ts.Expression): boolean => {
    const x = strip(e);
    if (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.ExclamationToken) {
      const call = strip(x.operand);
      return ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === "sameOrigin";
    }
    if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return negatedCall(x.right);
    return false;
  };
  return negatedCall(s.expression);
}

function topLevelFunctions(sf: ts.SourceFile): Map<string, ts.FunctionLikeDeclaration> {
  const found = new Map<string, ts.FunctionLikeDeclaration>();
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name) found.set(s.name.text, s);
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) found.set(d.name.text, d.initializer);
      }
    }
  }
  return found;
}

const exported = (s: ts.Statement) => ts.canHaveModifiers(s) && (ts.getModifiers(s) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** The callee name when the statement is `const x = await g(..)` / `return g(..)` / `return await g(..)`. */
function calledFirst(s: ts.Statement): string | null {
  let e: ts.Expression | undefined;
  if (ts.isVariableStatement(s) && s.declarationList.declarations.length === 1) e = s.declarationList.declarations[0].initializer;
  else if (ts.isReturnStatement(s)) e = s.expression;
  if (!e) return null;
  const call = strip(e);
  return ts.isCallExpression(call) && ts.isIdentifier(call.expression) ? call.expression.text : null;
}

/** Why a handler is not origin-checked first, or null when it is. */
function originGap(fn: ts.FunctionLikeDeclaration, local: Map<string, ts.FunctionLikeDeclaration>, importedGuards: Set<string>, seen = new Set<string>()): string | null {
  const body = fn.body;
  if (!body || !ts.isBlock(body) || !body.statements.length) return "no body";
  const first = body.statements[0];
  if (isOriginCheck(first)) return null;
  const callee = calledFirst(first);
  if (callee && importedGuards.has(callee)) return null;
  if (callee && local.has(callee) && !seen.has(callee)) {
    seen.add(callee);
    return originGap(local.get(callee)!, local, importedGuards, seen);
  }
  return `first statement is not the sameOrigin check: ${first.getText().split("\n")[0].slice(0, 80)}`;
}

function analyseRoute(route: string, source: string, importedGuards = new Set(Object.keys(ORIGIN_GUARDS))) {
  const sf = parse(`${route}/route.ts`, source);
  const local = topLevelFunctions(sf);
  // Only an import from the guard's own module counts.
  const imported = new Set<string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !s.importClause?.namedBindings || !ts.isNamedImports(s.importClause.namedBindings)) continue;
    const from = (s.moduleSpecifier as ts.StringLiteral).text;
    for (const el of s.importClause.namedBindings.elements) {
      const name = el.name.text;
      const guard = ORIGIN_GUARDS[name];
      if (guard && importedGuards.has(name) && !el.propertyName && from === `@/${guard.file.replace(/\.ts$/, "")}`) imported.add(name);
    }
  }
  const results: Array<{ key: string; gap: string | null }> = [];
  for (const s of sf.statements) {
    if (!exported(s)) continue;
    const handlers: Array<[string, ts.FunctionLikeDeclaration | undefined]> = [];
    if (ts.isFunctionDeclaration(s) && s.name) handlers.push([s.name.text, s]);
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const init = d.initializer;
        handlers.push([d.name.text, init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : undefined]);
      }
    }
    for (const [name, fn] of handlers) {
      if (!STATE_CHANGING.has(name)) continue;
      results.push({ key: `${route}:${name}`, gap: fn ? originGap(fn, local, imported) : "exported handler could not be analysed" });
    }
  }
  return results;
}

const API_DIR = path.join(ROOT, "app/api");
const routeFiles = (readdirSync(API_DIR, { recursive: true }) as string[])
  .filter((rel) => path.basename(rel) === "route.ts")
  .map((rel) => ({ route: path.dirname(rel).split(path.sep).join("/"), source: readFileSync(path.join(API_DIR, rel), "utf8") }));
const results = routeFiles.flatMap(({ route, source }) => analyseRoute(route, source));

describe("every state-changing app/api handler refuses a cross-site request first", () => {
  it("finds the state-changing handlers", () => {
    expect(results.length).toBeGreaterThanOrEqual(35);
    for (const key of ["auth/signin:POST", "auth/signout:POST", "admin/users:PATCH", "ai-helper/key:DELETE", "mail/send:POST", "costing/[...path]:POST", "platform/organizations:POST"]) {
      expect(results.map((r) => r.key)).toContain(key);
    }
  });

  it("each one starts with sameOrigin(), directly or through an origin-checking guard or same-file helper", () => {
    expect(results.filter((r) => r.gap).map((r) => `${r.key} - ${r.gap}`)).toEqual([]);
  });

  it("each imported guard counted as origin-checking starts with the check in its own source", () => {
    for (const { file, fn } of Object.values(ORIGIN_GUARDS)) {
      const local = topLevelFunctions(parse(file, readFileSync(path.join(ROOT, file), "utf8")));
      const decl = local.get(fn);
      expect(decl, `${file} ${fn}`).toBeDefined();
      expect(originGap(decl!, new Map(), new Set()), `${file} ${fn}`).toBeNull();
    }
  });
});

describe("the structural check fails where it should (fixtures, not real routes)", () => {
  const IMPORTS = `import { forbiddenOrigin, requireProfile, sameOrigin } from "@/lib/server/auth";\nimport { guard } from "@/lib/server/admin-users";\n`;
  const gapsOf = (body: string) => analyseRoute("fixture", IMPORTS + body).filter((r) => r.gap).map((r) => r.key);

  it("no origin check, a check after the sign-in lookup, or one inside a branch", () => {
    expect(gapsOf(`export async function POST(request: Request) { const auth = await requireProfile(); return auth; }`)).toEqual(["fixture:POST"]);
    expect(gapsOf(`export async function DELETE(request: Request) { await requireProfile(); if (!sameOrigin(request)) return forbiddenOrigin(); }`)).toEqual(["fixture:DELETE"]);
    expect(gapsOf(`export const PATCH = async (request: Request) => { if (request.url) { if (!sameOrigin(request)) return forbiddenOrigin(); } };`)).toEqual(["fixture:PATCH"]);
    expect(gapsOf(`export async function PUT(request: Request) { if (sameOrigin(request)) return forbiddenOrigin(); }`)).toEqual(["fixture:PUT"]);
  });

  it("a look-alike guard imported from elsewhere, or a local helper without the check", () => {
    expect(analyseRoute("fixture", `import { guard } from "@/lib/other";\nexport async function POST(r: Request) { const c = await guard(r); return c; }`).filter((r) => r.gap)).toHaveLength(1);
    expect(gapsOf(`async function helper(r: Request) { return requireProfile(); }\nexport async function POST(r: Request) { return helper(r); }`)).toEqual(["fixture:POST"]);
  });

  it("passes the real shapes: a direct check, the admin guard, a helper that checks first, and GET is not judged", () => {
    expect(gapsOf(`export async function POST(request: Request) { if (!sameOrigin(request)) return forbiddenOrigin(); return requireProfile(); }`)).toEqual([]);
    expect(gapsOf(`export async function POST(request: Request) { const ctx = await guard(request); return ctx; }`)).toEqual([]);
    expect(gapsOf(`async function forward(r: Request, m: string) { if (m === "POST" && !sameOrigin(r)) return forbiddenOrigin(); return requireProfile(); }\nexport async function POST(r: Request) { return forward(r, "POST"); }`)).toEqual([]);
    expect(gapsOf(`export async function GET(request: Request) { return requireProfile(); }`)).toEqual([]);
  });
});
