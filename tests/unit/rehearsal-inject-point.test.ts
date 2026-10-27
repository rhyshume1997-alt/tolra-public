/**
 * The upgrade rehearsal injects a failing top-level statement part-way through the newest migration. If that statement lands
 * inside a dollar-quoted body, string or comment it is only text (nothing raises); in the middle of a statement it is a syntax error.
 * These tests pin the picker (tests/rehearsal/inject-point.ts) to positions between two top-level statements. The same fixtures are
 * run through PostgreSQL itself in tests/rehearsal/inject-point.pg.test.ts.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { FIXTURES, legacyInjectPoint } from "../rehearsal/inject-fixtures";
import { DOLLAR_TAG, injectCandidates, injectPoint, scanLines } from "../rehearsal/inject-point";

const MIGRATIONS = path.resolve(__dirname, "../../supabase/migrations");
const lines = (text: string) => text.trim().split("\n");

/**
 * Written differently from scanLines, for real migrations only: every dollar body opened before the point is closed before it
 * (comment-only lines removed). A body opens at a tag that does not follow an identifier character (there it would be part of the
 * identifier) and closes at the next identical tag wherever it is, as PostgreSQL closes it: also right after a letter, as in 076's
 * format($q$ ... FROM %s%s$q$, ...), which counting only tags that follow no identifier character took for an open body.
 */
function noBodyOpenBefore(ls: string[], at: number) {
  const before = ls.slice(0, at).map((line) => line.replace(/^\s*--.*$/, "")).join("\n");
  const open = /(?<![A-Za-z0-9_$])\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/g;
  for (let from = 0; ; ) {
    open.lastIndex = from;
    const tag = open.exec(before);
    if (!tag) return true;
    const close = before.indexOf(tag[0], tag.index + tag[0].length);
    if (close < 0) return false;
    from = close + tag[0].length;
  }
}

describe("rehearsal injection point", () => {
  it("the tag rule is PostgreSQL's: identifier characters after the first, digits included; $1 and $ 1 are not tags", () => {
    const tag = (s: string) => {
      DOLLAR_TAG.lastIndex = 0;
      return DOLLAR_TAG.exec(s)?.[0] ?? null;
    };
    expect(tag("$$ x")).toBe("$$");
    expect(tag("$fn$ x")).toBe("$fn$");
    expect(tag("$fn1$ x")).toBe("$fn1$");
    expect(tag("$a1b$ x")).toBe("$a1b$");
    expect(tag("$_9$ x")).toBe("$_9$");
    expect(tag("$1$ x")).toBeNull(); // a digit cannot start a tag
    expect(tag("$1 + $2")).toBeNull();
    expect(/\$[A-Za-z_]*\$/y.exec("$fn1$")).toBeNull(); // the old rule missed them
  });

  for (const fx of FIXTURES) {
    it(`fixture: ${fx.name}`, () => {
      const ls = fx.sql.split("\n");
      const at = injectPoint(ls)!;
      expect(ls[at], "lands immediately before the expected line").toBe(fx.next);
      const marks = scanLines(ls);
      expect(marks[at]).toMatchObject({ top: true, pending: false, ended: fx.before });
    });
  }

  it("proof: on the body fixtures the old picker lands inside the body; the new one after the closing delimiter", () => {
    for (const fx of FIXTURES.filter((x) => /^(tag|a body)/.test(x.name))) {
      const ls = fx.sql.split("\n");
      const old = legacyInjectPoint(ls)!;
      expect(scanLines(ls)[old].top, `${fx.name}: old pick at line ${old}`).toBe(false);
      expect(ls[injectPoint(ls)! - 1]).toMatch(/^\$[A-Za-z0-9_]*\$;$/);
    }
  });

  it("the old picker is wrong on several of these fixtures (they are adversarial)", () => {
    const wrong = FIXTURES.filter((fx) => legacyInjectPoint(fx.sql.split("\n")) !== injectPoint(fx.sql.split("\n")));
    expect(wrong.length).toBeGreaterThanOrEqual(5);
  });

  it("with section breaks, picks the middle one", () => {
    const ls = lines(`
-- 1
SELECT 1;
-- -----
SELECT 2;
-- -----
SELECT 3;
-- -----
SELECT 4;
`);
    expect(injectPoint(ls)).toBe(ls.indexOf("-- -----", ls.indexOf("-- -----") + 1));
    expect(injectPoint(ls)).toBe(legacyInjectPoint(ls));
  });

  it("a break-like comment inside a body is ignored; the real break after the body is used", () => {
    const ls = lines(`
CREATE OR REPLACE FUNCTION public.h()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
-- -----
  PERFORM 1;
-- -----
END;
$$;
-- -----
SELECT 1;
`);
    expect(injectPoint(ls)).toBe(ls.lastIndexOf("-- -----"));
    const inBodyOnly = ls.filter((_, i) => i !== ls.lastIndexOf("-- -----"));
    expect(inBodyOnly[injectPoint(inBodyOnly)! - 1]).toBe("$$;");
  });

  it("late: the last top-level section break; without breaks, the last point with a statement still to come", () => {
    const ls = lines(`
SELECT 1;
-- -----
SELECT 2;
-- -----
SELECT 3;
-- -----
SELECT 4;
`);
    expect(injectPoint(ls, "late")).toBe(ls.lastIndexOf("-- -----"));
    const plain = lines(`
SELECT 1;
SELECT 2;
SELECT 3;
`);
    expect(injectPoint(plain, "late")).toBe(plain.indexOf("SELECT 3;"));
    expect(injectPoint(plain)).toBe(plain.indexOf("SELECT 2;"));
  });

  it("no usable point: a single statement, or nothing", () => {
    expect(injectPoint(["SELECT 1;"])).toBeUndefined();
    expect(injectPoint(["-- only a comment"])).toBeUndefined();
    expect(injectPoint(["SELECT 1;", "-- trailing comment"])).toBeUndefined();
  });

  it("proof on migrations: with their section breaks removed, the old picker lands inside a body, the new one never does", () => {
    let legacyInside = 0;
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql"))) {
      const ls = readFileSync(path.join(MIGRATIONS, f), "utf8").split("\n").filter((line) => !line.startsWith("-- -----"));
      const old = legacyInjectPoint(ls);
      if (old !== undefined && !scanLines(ls)[old].top) legacyInside++;
      const at = injectPoint(ls);
      if (at === undefined) continue;
      expect(scanLines(ls)[at], `${f}: new picker at line ${at}`).toMatchObject({ top: true, pending: false });
      expect(noBodyOpenBefore(ls, at), `${f}: a body is open before line ${at}`).toBe(true);
    }
    expect(legacyInside, "at least one real migration (breaks removed) trips the old picker").toBeGreaterThan(0);
  });

  it("every current migration: the chosen point lies between statements, outside every body (and exists)", () => {
    const files = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThan(30);
    for (const f of files) {
      const ls = readFileSync(path.join(MIGRATIONS, f), "utf8").split("\n");
      const marks = scanLines(ls);
      expect(marks[ls.length], `${f}: ends at top level with every statement complete`).toMatchObject({ top: true, pending: false });
      const at = injectPoint(ls);
      if (at === undefined) continue; // e.g. a one-statement file; the rehearsal itself refuses those
      expect(marks[at], `${f}: point at line ${at}`).toMatchObject({ top: true, pending: false });
      expect(noBodyOpenBefore(ls, at), `${f}: a body is open before line ${at}`).toBe(true);
    }
    const newest = readFileSync(path.join(MIGRATIONS, files.at(-1)!), "utf8").split("\n");
    expect(injectPoint(newest)).toBeDefined();
  });
});

describe("rehearsal candidates for 049 (R3.5: midway and late inside the file's one transaction)", () => {
  const file = readdirSync(MIGRATIONS).find((f) => f.endsWith("_paused_machine_ack.sql"))!;
  const ls = readFileSync(path.join(MIGRATIONS, file), "utf8").split("\n");
  const breaks = ls.flatMap((line, i) => (line.startsWith("-- -----") ? [i] : []));
  const above = (at: number) => ls.slice(0, at).join("\n");

  it("has five section breaks: middle is the start of section 3, late the start of section 5", () => {
    expect(breaks).toHaveLength(5);
    expect(injectPoint(ls, "middle")).toBe(breaks[2]);
    expect(injectPoint(ls, "late")).toBe(breaks[4]);
    expect(ls[breaks[2] + 1]).toMatch(/^-- ---- 3\. /);
    expect(ls[breaks[4] + 1]).toMatch(/^-- ---- 5\. /);
  });

  it("midway: start_machine_run was already dropped and replaced above the point; the dropped 6-argument signature is a candidate after the new function", () => {
    const candidates = injectCandidates(above(injectPoint(ls, "middle")!));
    const names = candidates.map((c) => c.what);
    // Latest first: the new start_machine_run (its name exists before 049, so the rehearsal skips it), then the dropped signature.
    expect(names.slice(0, 2)).toEqual(["function public.start_machine_run", "public.start_machine_run(UUID, UUID[], UUID, TIMESTAMPTZ, BOOLEAN, TEXT) gone"]);
    expect(candidates[1].exists).toBe("(to_regprocedure('public.start_machine_run(UUID, UUID[], UUID, TIMESTAMPTZ, BOOLEAN, TEXT)') IS NULL)");
    // Nothing of sections 3 to 5 is above it.
    expect(names.some((n) => /paused_machines|acknowledge_paused_machine/.test(n))).toBe(false);
    expect(names).toEqual(expect.arrayContaining(["table public.paused_ack_ops", "column public.machine_run_ops.request_sha256", "function public.paused_machine_current", "function public.machine_run_request_sha256"]));
  });

  it("late: the newest candidate is acknowledge_paused_machine (section 4); only section 5's assertions are still to come", () => {
    const candidates = injectCandidates(above(injectPoint(ls, "late")!));
    expect(candidates[0].what).toBe("function public.acknowledge_paused_machine");
    expect(ls.slice(injectPoint(ls, "late")!).join("\n")).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
  });

  it("the header comments name no object the candidate patterns would pick up", () => {
    const header = ls.slice(0, breaks[0]).join("\n");
    expect(injectCandidates(header)).toEqual([]);
  });
});

describe("rehearsal candidates for 077 (it creates nothing: the probe is security_audit.set_audit_hash's new body)", () => {
  const file = readdirSync(MIGRATIONS).find((f) => f.endsWith("_audit_hash_index_lookup.sql"))!;
  const text = readFileSync(path.join(MIGRATIONS, file), "utf8");
  const ls = text.split("\n");
  const above = (at: number) => ls.slice(0, at).join("\n");
  // The function body exactly as PostgreSQL stores it (prosrc): the text between the dollar quotes.
  const body = text.slice(text.indexOf("AS $$", text.indexOf("CREATE OR REPLACE FUNCTION security_audit.set_audit_hash()")) + "AS $$".length);
  const prosrc = body.slice(0, body.indexOf("$$;"));

  it("middle and late both fall after the function, and the only candidate is its new body (by md5 of the stored text)", () => {
    for (const where of ["middle", "late"] as const) {
      const at = injectPoint(ls, where)!;
      expect(above(at), where).toContain("CREATE OR REPLACE FUNCTION security_audit.set_audit_hash()");
      const candidates = injectCandidates(above(at));
      expect(candidates.map((c) => c.what), where).toEqual(["body of security_audit.set_audit_hash"]);
      expect(candidates[0].exists).toContain(`md5(p.prosrc) = '${createHash("md5").update(prosrc, "utf8").digest("hex")}'`);
      expect(candidates[0].exists).toContain("n.nspname = 'security_audit' AND p.proname = 'set_audit_hash'");
    }
    expect(injectPoint(ls, "late")).toBeGreaterThan(injectPoint(ls, "middle")!);
  });

  it("body candidates come after every object candidate, so no earlier file's pick changes", () => {
    const mixed = "CREATE OR REPLACE FUNCTION public.f()\nRETURNS void LANGUAGE sql AS $$ SELECT 1 $$;\nCREATE TABLE public.t (id int);\n";
    expect(injectCandidates(mixed).map((c) => c.what)).toEqual(["table public.t", "function public.f", "body of public.f"]);
    expect(injectCandidates("-- CREATE OR REPLACE FUNCTION security_audit.x() in a comment\n")).toEqual([]);
  });
});

describe("rehearsal candidates for 100 (it creates nothing: the probe is record_archive_state's new check, or set_archive_state's new body)", () => {
  const file = readdirSync(MIGRATIONS).find((f) => f.endsWith("_customer_archive.sql"))!;
  const text = readFileSync(path.join(MIGRATIONS, file), "utf8");
  const ls = text.split("\n");
  const above = (at: number) => ls.slice(0, at).join("\n");
  const CHECK = "check public.record_archive_state.record_archive_state_record_table_check as this file defines it";

  it("middle: after the check is re-added and before the function; the only candidate is the check, by its exact set of literals", () => {
    const at = injectPoint(ls, "middle")!;
    expect(above(at)).toContain("ADD CONSTRAINT record_archive_state_record_table_check");
    expect(above(at)).not.toContain("CREATE OR REPLACE FUNCTION public.set_archive_state");
    const candidates = injectCandidates(above(at));
    expect(candidates.map((c) => c.what)).toEqual([CHECK]);
    expect(candidates[0].exists).toContain("c.conrelid = to_regclass('public.record_archive_state') AND c.conname = 'record_archive_state_record_table_check' AND c.contype = 'c'");
    expect(candidates[0].exists).toContain("= ARRAY['customers', 'delivery_notes', 'invoices', 'jobs', 'purchase_orders', 'quotes', 'sales_orders']::text[])");
  });

  it("late: the function's new body first, then the check (both fallbacks: 100 creates no object)", () => {
    const candidates = injectCandidates(above(injectPoint(ls, "late")!));
    expect(candidates.map((c) => c.what)).toEqual(["function public.set_archive_state", "body of public.set_archive_state", CHECK]);
  });

  it("a check with no string literal gives no candidate; earlier files' lists are unchanged by the new fallback", () => {
    expect(injectCandidates("ALTER TABLE public.t ADD CONSTRAINT t_n CHECK (n > 0);\n")).toEqual([]);
    expect(injectCandidates("ALTER TABLE public.t ADD CONSTRAINT t_s CHECK (s IN ('a', 'it''s'));\n")[0].exists).toContain("ARRAY['a', 'it''s']::text[]");
    for (const f of readdirSync(MIGRATIONS).filter((x) => /^\d{3}_.+\.sql$/.test(x) && x < file)) {
      const fl = readFileSync(path.join(MIGRATIONS, f), "utf8").split("\n");
      for (const where of ["middle", "late"] as const) {
        const at = injectPoint(fl, where);
        if (!at) continue;
        const list = injectCandidates(fl.slice(0, at).join("\n"));
        const first = list.findIndex((c) => c.what.startsWith("check "));
        // Any check candidate an earlier file has sits after every object and body candidate, so its pick is unchanged.
        if (first >= 0) expect(list.slice(first).every((c) => c.what.startsWith("check ")), `${f} ${where}`).toBe(true);
      }
    }
  });
});
