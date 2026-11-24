/**
 * BOUNDARY (Quotes module 3, READ-ONLY LIVE PREVIEW). Inputs: the SOURCE TEXT of the new live files (the route page, components/quotes/preview/QuotesLive.tsx, lib/quote-list-load.ts,
 * lib/quote-live-gate.ts), the route gate, and middleware.ts's route table (read as text). Output: pass/fail. The guard FAILS if any live file contains a database write
 * (.insert/.update/.upsert/.delete/.rpc), storage, a fetch (any, and fetch('/api')), e-mail, send, mailto or window.open, or imports anything outside a small read-only allow-list (so no write helper
 * such as lib/archive's setState, e-mail, PDF, audit or export code can be imported). It also checks the route is OFF BY DEFAULT (notFound() unless QUOTE_LIVE_PREVIEW_ENABLED is exactly \"true\" and VERCEL_ENV is exactly \"preview\"), is dynamic, sits behind the
 * /quotes middleware prefix for admin and office, and is wrapped in RoleGate.
 * Must not change: never loosen the patterns or widen the allow-list to let a change pass; a new import needs an owner decision. No network, no Supabase.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, useRouter: () => ({ push: () => undefined }) }));

const root = path.resolve(__dirname, "../..");
const LIVE_FILES = [
  "app/(dashboard)/quotes/preview-live/page.tsx",
  "components/quotes/preview/QuotesLive.tsx",
  "lib/quote-list-load.ts",
  "lib/quote-live-gate.ts",
];
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

/** Code only: block comments, line comments and string/template contents removed, so words in prose or labels never trip or hide a pattern. */
function codeOnly(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "/*") { const end = source.indexOf("*/", i + 2); i = end < 0 ? source.length : end + 2; continue; }
    if (two === "//" && source[i - 1] !== ":") { const end = source.indexOf("\n", i); i = end < 0 ? source.length : end; continue; }
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) { if (source[j] === "\\") j += 1; j += 1; }
      out += `${ch}${ch}`;
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
const importsOf = (source: string) => Array.from(source.matchAll(/^\s*import\s+(?:type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)).map((m) => m[1]);

/** The ONLY modules the live files may import. Everything here reads or is pure; none writes, sends, exports or opens a window. */
const ALLOWED_IMPORTS = new Set([
  "react", "next", "next/navigation", "@supabase/supabase-js",
  "@/components/role-gate", "@/components/quotes/preview/QuotesPreview", "@/components/quotes/preview/QuotesLive",
  "@/lib/dates", "@/lib/friendly-error", "@/lib/quote-list-load", "@/lib/quote-live-gate", "@/lib/supabase", "@/lib/use-user", "@/lib/fetch-all",
  "@/lib/customer-po", "@/lib/db-features", "@/lib/quote-status", "@/lib/quote-versions",
]);

const FORBIDDEN: Array<[string, RegExp]> = [
  ["a database insert", /\.\s*insert\s*\(/],
  ["a database update", /\.\s*update\s*\(/],
  ["a database upsert", /\.\s*upsert\s*\(/],
  ["a database delete", /\.\s*delete\s*\(/],
  ["a database function call (rpc)", /\.\s*rpc\s*\(/],
  ["storage", /\.\s*storage\b|\bstorage\s*\./],
  ["a fetch call", /\bfetch\s*\(/],
  ["a request to /api", /["'`]\/api\//],
  ["e-mail or send", /\b(e-?mail\w*|send\w*|mailto\w*|openMailDraft|mail)\b/i],
  ["window.open", /window\s*\.\s*open\b|\bopen\s*\(\s*["'`]/],
  ["a form post or navigation to leave the page", /\blocation\s*\.\s*(assign|replace|href)\b|\bform\.submit\b/],
  ["a download", /\bdownloadFile\b|\bcreateObjectURL\b|\.download\s*=/],
  ["an audit write", /\bauditEvent\b/],
];

describe("quotes live: the new files are read-only", () => {
  for (const file of LIVE_FILES) {
    const source = read(file);
    const code = codeOnly(source);
    it(`${file}: no write, send, e-mail, upload, export or window call`, () => {
      for (const [what, pattern] of FORBIDDEN) expect(pattern.test(code), `${file} contains ${what}`).toBe(false);
    });
    it(`${file}: imports only from the read-only allow-list`, () => {
      for (const spec of importsOf(source)) expect(ALLOWED_IMPORTS.has(spec), `${file} imports "${spec}", which is not on the read-only allow-list`).toBe(true);
    });
    it(`${file}: states its boundary at the top`, () => {
      expect(source.slice(0, 1200)).toMatch(/BOUNDARY/);
    });
  }
  it("the guard itself catches what it must (self-test on bad examples)", () => {
    const bad = [
      'await supabase.from("quotes").insert({ a: 1 });', 'supabase.from("quotes").update({ a: 1 })', 'supabase.rpc("accept_quote", {})', 'supabase.storage.from("quote-attachments")',
      'await fetch("/api/email/send")', "window.open(url)", 'const href = "mailto:a@b.example"; sendEmail(x)', 'import { setState } from "@/lib/archive";',
    ];
    const hits = bad.map((line) => FORBIDDEN.some(([, p]) => p.test(codeOnly(line))) || importsOf(line).some((s) => !ALLOWED_IMPORTS.has(s)));
    expect(hits).toEqual(bad.map(() => true));
    expect(codeOnly("// supabase.rpc(x)\n/* .insert( */ const a = 'send';")).not.toMatch(/rpc|insert|send/);
  });
  it("does not import the archive hook (its setState calls rpc) or any module that writes", () => {
    for (const file of LIVE_FILES) for (const spec of importsOf(read(file))) expect(spec).not.toMatch(/lib\/archive|audit|email|pdf|export|print|offline|supabase-business|attachment|upload|xero|company$/);
  });
});

describe("quotes live: the route is gated", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("isProductionDeployment is true only for VERCEL_ENV === production", async () => {
    const { isProductionDeployment } = await import("@/lib/quote-live-gate");
    expect(isProductionDeployment("production")).toBe(true);
    for (const v of ["preview", "development", "", "Production", "prod", undefined]) expect(isProductionDeployment(v)).toBe(false);
  });
  it("the flag name is exactly QUOTE_LIVE_PREVIEW_ENABLED", async () => {
    const { QUOTE_LIVE_FLAG } = await import("@/lib/quote-live-gate");
    expect(QUOTE_LIVE_FLAG).toBe("QUOTE_LIVE_PREVIEW_ENABLED");
  });
  it("quoteLivePreviewOpen is OFF by default and opens only for flag === 'true' AND VERCEL_ENV === 'preview'", async () => {
    const { quoteLivePreviewOpen } = await import("@/lib/quote-live-gate");
    // The one opening combination.
    expect(quoteLivePreviewOpen({ QUOTE_LIVE_PREVIEW_ENABLED: "true", VERCEL_ENV: "preview" })).toBe(true);
    // Default: nothing set, or only one of the two.
    expect(quoteLivePreviewOpen({})).toBe(false);
    expect(quoteLivePreviewOpen({ VERCEL_ENV: "preview" })).toBe(false);
    expect(quoteLivePreviewOpen({ QUOTE_LIVE_PREVIEW_ENABLED: "true" })).toBe(false);
    // The flag must be exactly "true": no other spelling opens it, even on a preview.
    for (const flag of ["", "false", "TRUE", "True", "1", "yes", "on", " true", "true ", "tru", "enabled"]) {
      expect(quoteLivePreviewOpen({ QUOTE_LIVE_PREVIEW_ENABLED: flag, VERCEL_ENV: "preview" })).toBe(false);
    }
    // VERCEL_ENV must be exactly "preview": production, development, other spellings and unset are all closed, even with the flag on.
    for (const vercelEnv of ["production", "development", "", "Preview", "PREVIEW", " preview", "preview ", "prod", undefined]) {
      expect(quoteLivePreviewOpen({ QUOTE_LIVE_PREVIEW_ENABLED: "true", VERCEL_ENV: vercelEnv })).toBe(false);
    }
  });
  it("quoteLivePreviewOpen reads process.env when called with no argument", async () => {
    const { quoteLivePreviewOpen } = await import("@/lib/quote-live-gate");
    vi.stubEnv("QUOTE_LIVE_PREVIEW_ENABLED", "true");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(quoteLivePreviewOpen()).toBe(true);
    vi.stubEnv("VERCEL_ENV", "production");
    expect(quoteLivePreviewOpen()).toBe(false);
  });
  it("the page returns notFound() unless the flag is 'true' AND VERCEL_ENV is 'preview', and renders the screen only then", async () => {
    const page = (await import("@/app/(dashboard)/quotes/preview-live/page")).default;
    // Default off: preview without the flag, and the flag's other spellings.
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("QUOTE_LIVE_PREVIEW_ENABLED", "");
    expect(() => page()).toThrow("NEXT_NOT_FOUND");
    vi.stubEnv("QUOTE_LIVE_PREVIEW_ENABLED", "TRUE");
    expect(() => page()).toThrow("NEXT_NOT_FOUND");
    vi.stubEnv("QUOTE_LIVE_PREVIEW_ENABLED", "1");
    expect(() => page()).toThrow("NEXT_NOT_FOUND");
    // Flag on but not a preview deployment: production, local (unset) and development are closed.
    vi.stubEnv("QUOTE_LIVE_PREVIEW_ENABLED", "true");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(() => page()).toThrow("NEXT_NOT_FOUND");
    vi.stubEnv("VERCEL_ENV", "");
    expect(() => page()).toThrow("NEXT_NOT_FOUND");
    vi.stubEnv("VERCEL_ENV", "development");
    expect(() => page()).toThrow("NEXT_NOT_FOUND");
    // The only open combination.
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(page()).toBeTruthy();
  });
  it("the page reads the gate before it returns the screen, and is dynamic so the check runs per request", () => {
    const page = read("app/(dashboard)/quotes/preview-live/page.tsx");
    expect(page).toContain('export const dynamic = "force-dynamic"');
    expect(page).toContain("if (!quoteLivePreviewOpen()) notFound();");
    expect(page.indexOf("notFound()")).toBeLessThan(page.indexOf("<QuotesLive />"));
    expect(page).toMatch(/robots: \{ index: false, follow: false \}/);
  });
  it("the gate file is the only place that reads the flag, and uses exact comparisons", () => {
    const gate = read("lib/quote-live-gate.ts");
    expect(gate).toContain('env.QUOTE_LIVE_PREVIEW_ENABLED === "true"');
    expect(gate).toContain('env.VERCEL_ENV === "preview"');
    for (const file of LIVE_FILES.filter((f) => f !== "lib/quote-live-gate.ts")) {
      expect(read(file).replace(/\/\*[\s\S]*?\*\//g, "")).not.toContain("QUOTE_LIVE_PREVIEW_ENABLED");
    }
  });
  it("middleware limits /quotes and everything under it to admin and office (prefix match), so /quotes/preview-live inherits it", () => {
    const mw = read("middleware.ts");
    expect(mw).toContain('["/quotes", ["admin", "office"]]');
    expect(mw).toContain('path === prefix || path.startsWith(prefix + "/")');
    // No earlier rule could match it first and loosen it.
    const table = mw.slice(mw.indexOf("const ROUTE_ROLES"), mw.indexOf("];", mw.indexOf("const ROUTE_ROLES")));
    const prefixes = Array.from(table.matchAll(/\["(\/[^"]*)"/g)).map((m) => m[1]);
    const matching = prefixes.filter((p) => "/quotes/preview-live" === p || "/quotes/preview-live".startsWith(`${p}/`));
    expect(matching).toEqual(["/quotes"]);
  });
  it("the screen is wrapped in RoleGate for admin and office, as the real page is", () => {
    expect(read("components/quotes/preview/QuotesLive.tsx")).toContain('<RoleGate allowed={["admin", "office"]}>');
    expect(read("app/(dashboard)/quotes/page.tsx")).toContain('RoleGate allowed={["admin", "office"]}');
  });
  it("the live files are not linked from the real Quotes page or any shared file", () => {
    expect(read("app/(dashboard)/quotes/page.tsx")).not.toMatch(/preview-live|QuotesLive|quote-list-load/);
    expect(read("components/sidebar.tsx")).not.toMatch(/preview-live/);
  });
});
