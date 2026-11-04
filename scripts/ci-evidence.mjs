#!/usr/bin/env node
// Evidence printers for the CI log. Every PASS/FAIL label below is computed from parsed real output (vitest/playwright
// reports, git diffs); nothing prints PASS because a command exited 0. Exit status is 1 when any FAIL label is printed
// (except `diff-audit`, which only reports findings).
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
const strip = s => s.replace(/\u001b\[[0-9;]*m/g, "");
let failed = false;
const out = (label, ok, text) => { if (!ok) failed = true; console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${text}`); };
const [cmd, ...args] = process.argv.slice(2);
const json = f => JSON.parse(readFileSync(f, "utf8"));
const cases = rep => rep.testResults.flatMap(f => f.assertionResults.map(a => ({ file: f.name.replace(/^.*\/tests\//, "tests/"), group: a.ancestorTitles.join(" > "), title: a.title, status: a.status })));

if (cmd === "vitest-summary") { // <json> <label>  (totals computed from the vitest JSON report)
  const rep = json(args[0]), files = rep.testResults.length, badFiles = rep.testResults.filter(f => f.status === "failed").length;
  console.log(`${args[1]} vitest totals: files=${files} (failed ${badFiles}) tests=${rep.numTotalTests} passed=${rep.numPassedTests} failed=${rep.numFailedTests} skipped/pending=${rep.numPendingTests + (rep.numTodoTests || 0)}`);
  out(`${args[1]} summary`, rep.numFailedTests === 0 && badFiles === 0 && rep.numTotalTests > 0, `${rep.numPassedTests}/${rep.numTotalTests} passed, ${rep.numFailedTests} failed`);
} else if (cmd === "list-all") { // <json> <label> [allowedSkipTitleRegex]
  const all = cases(json(args[0])), allow = args[2] ? new RegExp(args[2]) : null;
  for (const c of all) console.log(`  ${c.status.toUpperCase()} ${c.file} :: ${c.group ? c.group + " > " : ""}${c.title}`);
  const passed = all.filter(c => c.status === "passed"), skipped = all.filter(c => c.status === "skipped" || c.status === "todo"), stray = skipped.filter(c => !allow || !allow.test(c.title));
  out(`${args[1]} cases`, all.length > 0 && passed.length + skipped.length === all.length && stray.length === 0, `${passed.length} passed, ${skipped.length} skipped (${skipped.length - stray.length} allowed by title ${args[2] || "none"}), ${all.length - passed.length - skipped.length} failed, of ${all.length}`);
} else if (cmd === "db-skips") { // <json>
  const all = cases(json(args[0])), skipped = all.filter(c => c.status === "skipped" || c.status === "todo");
  const count = s => all.filter(c => c.status === s).length;
  console.log(`DB-COUNTS files=${new Set(all.map(c => c.file)).size} passed=${count("passed")} failed=${count("failed")} skipped=${skipped.length}`);
  for (const c of skipped) console.log(`  skipped: ${c.file} :: ${c.group} > ${c.title}`);
  const allowed = c => (/safeupdate/i.test(c.group) && /data-import/.test(c.file)) || (c.group === "timing" && /data-import\.test\.ts$/.test(c.file));
  const stray = skipped.filter(c => !allowed(c));
  out("DB-SKIPS", stray.length === 0 && count("failed") === 0, stray.length ? `${stray.length} skipped test(s) outside the safeupdate-gated and IMPORT_TIMING groups` : `all ${skipped.length} skipped test(s) belong to the safeupdate-gated (describe.runIf API/LOADABLE) or IMPORT_TIMING groups`);
} else if (cmd === "named") { // <json> <label> <file-suffix>...
  const [f, label, ...suffixes] = args, all = cases(json(f));
  for (const s of suffixes) {
    const mine = all.filter(c => c.file.endsWith(s));
    for (const c of mine) console.log(`  ${c.status.toUpperCase()} ${c.file} :: ${c.title}`);
    out(`${label} ${s}`, mine.length > 0 && mine.every(c => c.status === "passed"), `${mine.filter(c => c.status === "passed").length}/${mine.length} passed`);
  }
} else if (cmd === "source-tokens") { // <file> <tokens...>
  const [f, ...tokens] = args, src = readFileSync(f, "utf8").toLowerCase();
  for (const t of tokens) out(`SOURCE-COVERS ${t}`, src.includes(t.toLowerCase()), `${f} ${src.includes(t.toLowerCase()) ? "contains" : "does not contain"} "${t}"`);
} else if (cmd === "playwright") { // <json> <expectedPassed>
  const rep = json(args[0]), exp = Number(args[1]), rows = [];
  const walk = (suite, file) => { for (const sp of suite.specs || []) for (const t of sp.tests || []) rows.push({ file: sp.file || file, title: sp.title, status: (t.results || []).at(-1)?.status || t.status }); for (const c of suite.suites || []) walk(c, c.file || file); };
  for (const s of rep.suites || []) walk(s, s.file);
  for (const r of rows) console.log(`  ${r.status === "passed" ? "PASSED" : r.status.toUpperCase()} ${r.file} :: ${r.title}`);
  const st = rep.stats, n = k => rows.filter(r => r.status === k).length;
  out("REVIEWER-BROWSER", n("passed") === exp && rows.length === exp && st.unexpected === 0 && st.skipped === 0 && st.flaky === 0, `${n("passed")} passed, ${st.unexpected} failed, ${st.skipped} skipped, ${st.flaky} flaky of ${rows.length} (required: ${exp} passed, 0 failed, 0 skipped)`);
} else if (cmd === "diff-audit") { // <headRef> <baseRef>... ; first base is the #247 baseline used for added-line checks
  const [head, ...bases] = args, git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 28 });
  const show = (r, p) => { try { return git("show", `${r}:${p}`); } catch { return null; } };
  const count = (s, re) => (s.match(re) || []).length;
  const IT = /(^|[^\w.])(it|test)(\.\w+)*\(/gm, EX = /\bexpect(\.\w+)*\(/g;
  let findings = 0; const f = t => { findings++; console.log(`FINDING ${t}`); };
  for (const base of bases) {
    console.log(`--- audit ${head} against ${base}`);
    for (const l of git("diff", "--name-status", "--diff-filter=DR", base, head, "--", "tests").split("\n").filter(Boolean)) f(`test file removed/renamed vs ${base}: ${l}`);
    for (const p of git("diff", "--name-only", "--diff-filter=M", base, head, "--", "tests").split("\n").filter(p => /\.(ts|tsx|cjs|mjs)$/.test(p))) {
      const a = show(base, p), b = show(head, p); if (a == null || b == null) continue;
      const [ai, bi, ae, be] = [count(a, IT), count(b, IT), count(a, EX), count(b, EX)];
      if (bi < ai) f(`${p}: it/test( count ${ai} -> ${bi} vs ${base}`);
      if (be < ae) f(`${p}: expect( count ${ae} -> ${be} vs ${base}`);
    }
  }
  const base0 = bases[0], added = (paths) => git("diff", "-U0", "--no-color", base0, head, "--", ...paths).split("\n");
  const scan = (lines, re, kind, want = "+") => { let file = ""; lines.forEach(l => { if (l.startsWith("+++ b/")) file = l.slice(6); else if (l.startsWith("--- a/") && want === "-") file = l.slice(6); else if (l[0] === want && !l.startsWith(want.repeat(3)) && re.test(l)) f(`${kind}: ${file}: ${l.slice(1, 90).trim()}`); }); };
  scan(added(["tests"]), /(\.skip\b|\.only\b|\bxit\(|\bxdescribe\(|\bfixme\b|skipIf\()/, "skip/only/fixme added");
  const rc = git("diff", "--name-only", base0, head, "--", "lib/money.ts", "lib/costing.ts", "lib/server/costing-engine.ts", "lib/costing", "tests/fixtures/costing-golden.json", "tests/unit/costing-golden.test.ts").trim();
  if (rc) for (const l of rc.split("\n")) f(`rounding/costing file changed vs ${base0}: ${l}`);
  for (const w of ["+", "-"]) scan(git("diff", "-U0", "--no-color", base0, head, "--", "supabase", "lib", "app", "components").split("\n"), /(\bround\s*\(|ROUND_HALF|half[-_ ]?even|banker)/i, `rounding code line ${w === "+" ? "added" : "removed"} (round( / half-even)`, w);
  const snap = git("diff", "--stat", base0, head, "--", "tests/db/catalogue.snapshot.json").trim(); if (snap) f(`catalogue.snapshot.json changed vs ${base0}: ${snap.split("\n").pop()}`);
  const sql = ["supabase/release", "supabase/migrations", "supabase/verify"];
  scan(added(sql), /\bGRANT\b/i, "SQL GRANT added");
  scan(added(sql), /(\bREVOKE\b|\bPOLICY\b)/i, "SQL REVOKE/POLICY line removed", "-");
  const all = git("diff", "-U0", "--no-color", base0, head).split("\n");
  scan(all, /(eyJ[A-Za-z0-9_-]{30,}|sk-[A-Za-z0-9]{24,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{20,})/, "possible secret pattern in added line (content withheld)");
  console.log(`DIFF-AUDIT findings: ${findings}`); process.exit(0);
}
process.exit(failed ? 1 : 0);
