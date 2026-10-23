/**
 * Adversarial SQL for the injection-point picker. Each fixture is a script of temp-object statements that PostgreSQL runs as-is.
 * `next` is the exact line the failing statement must land immediately before; `before` is how many complete statements PostgreSQL
 * must see in the text above that point. Used by the unit test (positions) and inject-point.pg.test.ts (PostgreSQL as the oracle).
 */
export type Fixture = { name: string; sql: string; next: string; before: number };

const f = (name: string, sql: string, next: string, before: number): Fixture => ({ name, sql: sql.trim(), next, before });

export const FIXTURES: Fixture[] = [
  f("tag with digits after the first character ($fn1$)", `
CREATE FUNCTION pg_temp.fx_a() RETURNS int LANGUAGE plpgsql AS $fn1$
BEGIN
  PERFORM 1;
  RETURN 1;
END;
$fn1$;
SELECT 'after';
`, "SELECT 'after';", 1),
  f("tag with digits in the middle ($a1b$) holding a differently tagged and an empty body", `
CREATE FUNCTION pg_temp.fx_b() RETURNS int LANGUAGE plpgsql AS $a1b$
BEGIN
  EXECUTE $$ SELECT 1; $$;
  EXECUTE $x2$ SELECT 2; $x2$;
  RETURN 1;
END;
$a1b$;
SELECT 'after';
`, "SELECT 'after';", 1),
  f("underscore and trailing digits in a tag ($_t9$), body closed on the same line as ';'", `
CREATE FUNCTION pg_temp.fx_c() RETURNS int LANGUAGE sql AS $_t9$ SELECT 1; $_t9$ STABLE;
SELECT 'after';
`, "SELECT 'after';", 1),
  f("dollar markers inside single-quoted strings ('$$' and 'it''s $x$')", `
SELECT '$$' AS a,
       'it''s $x$' AS b,
       '$fn1$' AS c;
SELECT 'after';
`, "SELECT 'after';", 1),
  f("dollar markers and ';' inside a -- line comment of an unfinished statement", `
SELECT 1 AS a, -- costs $$ here; and $t$ there;
       2 AS b;
SELECT 'after';
`, "SELECT 'after';", 1),
  f("dollar markers and ';' inside a block comment, with nested block comments", `
SELECT 1 /* outer $$ ; /* inner $x$ ; */ still comment $$ ; */ AS a,
       2 AS b;
SELECT 'after';
`, "SELECT 'after';", 1),
  f("E'' strings with backslash escapes (\\' and \\\\)", `
SELECT E'it\\'s $$ ;' AS a,
       E'back\\\\' AS b, 'tail $$' AS c;
SELECT 'after';
`, "SELECT 'after';", 1),
  f("double-quoted identifiers containing $ and ;, and an unquoted identifier with $", `
CREATE TEMP TABLE "we$$ird;" ("a$b$" text,
  c$d$ int);
SELECT 'after';
`, "SELECT 'after';", 1),
  f("section-comment marker inside an unfinished statement (no valid break: falls back to the statement end)", `
SELECT 1 AS a,
-- -----------------------------------------------------------------------------------------------------
       2 AS b;
SELECT 'after';
`, "SELECT 'after';", 1),
  f("section-comment marker inside an unfinished statement; the real break after a statement is used", `
SELECT 1 AS a,
-- -----------------------------------------------------------------------------------------------------
       2 AS b;
SELECT 'a';
-- -----------------------------------------------------------------------------------------------------
SELECT 'after';
`, "-- -----------------------------------------------------------------------------------------------------", 2),
  f("section-comment marker line inside a multi-line string literal", `
SELECT 'a
-- -----
b' AS a;
SELECT 'after';
`, "SELECT 'after';", 1),
  f("a body is closed by its own tag only: $outer$ ... $$ ... $outer$ with a ';' after every line", `
CREATE FUNCTION pg_temp.fx_d() RETURNS int LANGUAGE plpgsql AS $outer$
BEGIN
  PERFORM 'x$outer';
  PERFORM $$ y; $$;
  RETURN 1;
END;
$outer$;
SELECT 'after';
`, "SELECT 'after';", 1),
  f("049's shape: the old signature dropped and the new one created in one section; the middle break after them is the point", `
CREATE FUNCTION pg_temp.fx_e(a int) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
-- -----------------------------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS pg_temp.fx_e(int);
CREATE OR REPLACE FUNCTION pg_temp.fx_e(a int, b jsonb DEFAULT NULL) RETURNS int LANGUAGE plpgsql AS $fn$
BEGIN
  RETURN 2;
END
$fn$;
-- -----------------------------------------------------------------------------------------------------
SELECT 'after';
-- -----------------------------------------------------------------------------------------------------
SELECT 'end';
`, "-- -----------------------------------------------------------------------------------------------------", 3),
];

/** The picker as it was before the fix (kept only to show what it did wrong): section breaks anywhere, else the first line ending in ';'. */
export function legacyInjectPoint(ls: string[]): number | undefined {
  const breaks = ls.flatMap((line, i) => (line.startsWith("-- -----") ? [i] : []));
  let at: number | undefined = breaks[Math.floor(breaks.length / 2)];
  if (at === undefined) {
    const ends = ls.flatMap((line, i) => (/;\s*$/.test(line) && !line.trimStart().startsWith("--") ? [i + 1] : []));
    at = ends.find((i) => ls.slice(i).some((line) => /^\s*[A-Za-z]/.test(line)));
  }
  return at;
}
