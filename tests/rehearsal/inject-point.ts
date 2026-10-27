/**
 * Where the upgrade rehearsal injects its failing statement into a migration (see withFailureMidway in upgrade.test.ts).
 * The statement is a top-level `DO $inject$ ... $inject$;`, so it must land exactly BETWEEN two top-level statements: never inside a
 * dollar-quoted body (there it is just text and nothing raises), a string, a comment, a quoted identifier, or the middle of a statement
 * (there it is a syntax error). `scanLines` is a character-level tokenizer that follows PostgreSQL's lexical rules for all of those.
 * Its picks are checked against PostgreSQL itself in inject-point.pg.test.ts.
 */
import { createHash } from "node:crypto";

/** A dollar-quote tag as PostgreSQL lexes it: `$$`, or `$` + identifier (letter or underscore first, then letters, digits, underscores) + `$`. */
export const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;

/** The lexical state at the start of a line (index lines.length = the end of the text). */
export type LineMark = {
  /** Not inside a dollar-quoted body, string, quoted identifier or comment. */
  top: boolean;
  /** A statement has started and its ';' has not been seen yet (the line starts mid-statement). */
  pending: boolean;
  /** Top-level statements completed (';' seen) before this point. */
  ended: number;
  /** Top-level statements started before this point. */
  started: number;
};

export function scanLines(lines: string[]): LineMark[] {
  const text = lines.join("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  type Mode = "top" | "line" | "block" | "str" | "estr" | "ident" | "dollar";
  let mode: Mode = "top";
  let depth = 0; // block comments nest in PostgreSQL
  let tag = "";
  let escaped = false; // E'...' : the previous character was a backslash
  let pending = false;
  let started = 0;
  let ended = 0;
  const marks: LineMark[] = [];
  const mark = () => marks.push({ top: mode === "top", pending, ended, started });
  const token = () => {
    if (!pending) {
      pending = true;
      started += 1;
    }
  };
  let li = 0;
  let p = 0;
  while (p < text.length) {
    if (li < lines.length && p === starts[li]) {
      mark();
      li += 1;
    }
    const c = text[p];
    const n = text[p + 1];
    if (mode === "top") {
      if (/\s/.test(c)) {
        p += 1;
      } else if (c === "-" && n === "-") {
        mode = "line";
        p += 2;
      } else if (c === "/" && n === "*") {
        mode = "block";
        depth = 1;
        p += 2;
      } else if (c === "'") {
        token();
        const prev = text[p - 1];
        mode = prev !== undefined && /[eE]/.test(prev) && !(p >= 2 && IDENT_CHAR.test(text[p - 2])) ? "estr" : "str";
        escaped = false;
        p += 1;
      } else if (c === '"') {
        token();
        mode = "ident";
        p += 1;
      } else if (c === "$" && !(p >= 1 && IDENT_CHAR.test(text[p - 1]))) {
        token();
        DOLLAR_TAG.lastIndex = p;
        const m = DOLLAR_TAG.exec(text);
        if (m) {
          mode = "dollar";
          tag = m[0];
          p += tag.length;
        } else {
          p += 1; // $1 and friends
        }
      } else if (c === ";") {
        pending = false;
        ended += 1;
        p += 1;
      } else {
        token();
        p += 1;
      }
    } else if (mode === "line") {
      if (c === "\n") mode = "top";
      p += 1;
    } else if (mode === "block") {
      if (c === "/" && n === "*") {
        depth += 1;
        p += 2;
      } else if (c === "*" && n === "/") {
        depth -= 1;
        mode = depth === 0 ? "top" : "block";
        p += 2;
      } else {
        p += 1;
      }
    } else if (mode === "str" || mode === "estr") {
      if (escaped) {
        escaped = false;
        p += 1;
      } else if (mode === "estr" && c === "\\") {
        escaped = true;
        p += 1;
      } else if (c === "'" && n === "'") {
        p += 2;
      } else {
        if (c === "'") mode = "top";
        p += 1;
      }
    } else if (mode === "ident") {
      if (c === '"' && n === '"') {
        p += 2;
      } else {
        if (c === '"') mode = "top";
        p += 1;
      }
    } else if (text.startsWith(tag, p)) {
      mode = "top"; // a dollar body is closed only by the identical tag
      p += tag.length;
    } else {
      p += 1;
    }
  }
  while (li <= lines.length) {
    mark();
    li += 1;
  }
  return marks;
}

/**
 * The index of the line to insert the failing statement before, or undefined if the file has no usable point.
 * The middle top-level "-- -----" section break (one that starts a line between statements, not inside a body, string, comment or
 * unfinished statement); else, in a file without such breaks, the first line start that follows a complete top-level statement
 * with at least one statement still to come.
 * `where = "late"`: the LAST such break (so the statements of the file's final section are still to come); without breaks, the last
 * line start that follows a complete statement with at least one statement still to come.
 */
export function injectPoint(lines: string[], where: "middle" | "late" = "middle"): number | undefined {
  const marks = scanLines(lines);
  const between = (i: number) => marks[i].top && !marks[i].pending;
  const breaks = lines.flatMap((line, i) => (line.startsWith("-- -----") && between(i) ? [i] : []));
  if (breaks.length) return where === "late" ? breaks[breaks.length - 1] : breaks[Math.floor(breaks.length / 2)];
  const total = marks[lines.length].started;
  const ok = (i: number) => i > 0 && between(i) && marks[i].ended >= 1 && marks[i].started < total;
  const at = where === "late" ? lines.map((_, i) => i).filter(ok).at(-1) : lines.findIndex((_, i) => ok(i));
  return at === -1 ? undefined : at;
}

/** The SQLSTATE of the injected failure (custom class "RH"): nothing else PostgreSQL raises uses it, so only the probe can produce it. */
export const INJECT_SQLSTATE = "RH001";

/** The exception message the probe raises, for a unique token, the object it reports on and whether that object existed at that point. */
export const probeMessage = (unique: string, what: string, existed: boolean) => `${unique}: ${what} existed mid-file = ${existed}`;

/** The top-level failing statement. `existsExpr` is a SQL boolean expression for "the object created by the first part is there". */
export const probeSql = (unique: string, what: string, existsExpr: string) =>
  `DO $inject$ BEGIN RAISE EXCEPTION USING ERRCODE = '${INJECT_SQLSTATE}', MESSAGE = format('%s: %s existed mid-file = %s', '${unique}', '${what}', (${existsExpr})::text); END $inject$;`;

/** One object the part of a migration above the injection point creates (or, for a dropped signature, removes), and how to test it. */
export type InjectCandidate = { index: number; what: string; exists: string };

/** A CHECK constraint (re)added by `above`, as its new definition (injectCandidates' last fallback). */
function checkDefinitions(above: string): InjectCandidate[] {
  return [...above.matchAll(/^ALTER TABLE public\.(\w+) ADD CONSTRAINT (\w+)\s+CHECK\s*\(([\s\S]*?)\);[ \t]*$/gm)].flatMap((m) => {
    const literals = [...new Set([...m[3].matchAll(/'((?:[^']|'')*)'/g)].map((l) => l[1].replace(/''/g, "'")))].sort();
    if (!literals.length) return [];
    const quoted = literals.map((l) => `'${l.replace(/'/g, "''")}'`).join(", ");
    return [{
      index: m.index,
      what: `check public.${m[1]}.${m[2]} as this file defines it`,
      exists: `EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.${m[1]}') AND c.conname = '${m[2]}' AND c.contype = 'c'`
        + ` AND ARRAY(SELECT DISTINCT x[1] COLLATE "C" AS v FROM regexp_matches(pg_get_constraintdef(c.oid), '''((?:[^'']|'''')*)''', 'g') AS x ORDER BY 1) = ARRAY[${quoted}]::text[])`,
    }];
  });
}

/**
 * The candidates for the rehearsal's probe in `above` (the text before the injection point), latest first: the functions, tables and
 * columns it creates, and (049) each signature it drops with `DROP FUNCTION IF EXISTS public.X(args)`. A dropped signature "exists" when it
 * is GONE (`to_regprocedure(...) IS NULL`): false before the file runs, true mid-file once the old form was dropped and replaced, false
 * again after a rollback (the old form is back). The rehearsal picks the first candidate that is not there yet.
 * After all of those, as fallbacks only (so no earlier file's pick changes): each function the part replaces, in any schema, as its NEW
 * BODY (077 creates nothing and only replaces security_audit.set_audit_hash). It "exists" when the stored body (prosrc) is exactly the
 * text between the file's dollar quotes: false before the file runs (the old body is stored), true mid-file, false after a rollback.
 * Last, also fallbacks only: each CHECK constraint the part (re)adds with `ALTER TABLE public.T ADD CONSTRAINT name CHECK (...)` that
 * names string literals, as its NEW DEFINITION (100 creates nothing: it widens record_archive_state's check and replaces a function). It
 * "exists" when a check constraint of that name on that table holds exactly the file's set of string literals: false before the file
 * runs (the old check, without the new value), true mid-file, false after a rollback.
 */
export function injectCandidates(above: string): InjectCandidate[] {
  const bodies = [...above.matchAll(/^CREATE OR REPLACE FUNCTION (\w+)\.(\w+)\([^)]*\)[^$]*?\bAS (\$\w*\$)([\s\S]*?)\3;/gm)].map((m) => ({
    index: m.index,
    what: `body of ${m[1]}.${m[2]}`,
    exists: `EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = '${m[1]}' AND p.proname = '${m[2]}' AND md5(p.prosrc) = '${createHash("md5").update(m[4], "utf8").digest("hex")}')`,
  }));
  return [
    ...[...above.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(/gi)].map((m) => ({ index: m.index, what: `function public.${m[1]}`, exists: `EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${m[1]}')` })),
    ...[...above.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?public\.(\w+)/gi)].map((m) => ({ index: m.index, what: `table public.${m[1]}`, exists: `(to_regclass('public.${m[1]}') IS NOT NULL)` })),
    ...[...above.matchAll(/ALTER TABLE public\.(\w+) ADD COLUMN IF NOT EXISTS (\w+)/gi)].map((m) => ({ index: m.index, what: `column public.${m[1]}.${m[2]}`, exists: `EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${m[1]}' AND column_name = '${m[2]}')` })),
    ...[...above.matchAll(/^DROP FUNCTION IF EXISTS public\.(\w+)\(([^)]*)\)\s*;/gim)].map((m) => {
      const signature = `public.${m[1]}(${m[2].replace(/\s+/g, " ").trim()})`;
      return { index: m.index, what: `${signature} gone`, exists: `(to_regprocedure('${signature}') IS NULL)` };
    }),
  ].sort((x, y) => y.index - x.index).concat(bodies.sort((x, y) => y.index - x.index), checkDefinitions(above).sort((x, y) => y.index - x.index));
}
