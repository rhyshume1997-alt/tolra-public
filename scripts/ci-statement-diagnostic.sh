#!/usr/bin/env bash
# CI statement diagnostic (informational). Finds WHICH of release 159's two storage.objects policy statements a disposable database refuses, with
# its SQLSTATE and PostgreSQL source location, WITHOUT changing the database.
#
# Inputs : TEST_DATABASE_URL (loopback disposable database only). `--guard-only` reads SQL on stdin and only judges it (used by the tests).
# Outputs: a sanitised report on stdout: per probe the command tag (ok) or SQLSTATE + message + server source location (or "unavailable");
#          the fingerprint of everything the probes could change, read in two separate fresh sessions (before / after) and compared here;
#          one final line each for the rollback (ROLLBACK CONFIRMED | ROLLBACK NOT CONFIRMED) and the state (UNCHANGED | CHANGED | UNVERIFIED).
#          NOT CONFIRMED, CHANGED and UNVERIFIED also print a GitHub ::error:: annotation. The script always exits 0 (informational).
# Must not change: this script never commits, switches role, grants, or connects as another login; it never prints a connection string, a
#          password or any database setting outside the four named ones. The wrapper's own BEGIN / ROLLBACK are separate -c commands, never
#          part of the inspected SQL. Release SQL is never read, run or edited here; the two probes are copied verbatim from release 159's
#          file (supabase/release/159_drawings_update_roles.release.sql, statements at its lines 65-66 and 70). Disposable CI only.
set -u
export LC_ALL=C

APP="ci-statement-diagnostic-$$"
MODE=run
[ "${1:-}" = "--guard-only" ] && MODE=guard

WORK="$(mktemp -d 2>/dev/null || echo "/tmp/ci-statement-diagnostic.$$")"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT
HELPER="$WORK/diag.py"

# ---------------------------------------------------------------------------------------------------------------------------------------
# The helper (python3 is on every runner; no new dependency). Commands: guard | summary | settings | redact.
# ---------------------------------------------------------------------------------------------------------------------------------------
cat > "$HELPER" <<'PY'
import os, re, sys

DENY_FIRST = {"begin", "start", "commit", "end", "abort", "rollback", "savepoint", "release", "prepare", "set", "reset", "discard"}

def scan(sql):
    """Splits SQL into top-level statements. Comments, '...' and E'...' strings, "..." identifiers and $tag$...$tag$ bodies are skipped, so a
    word inside any of them is never a statement. Returns (statements, meta_command_line or None); a statement is (first_line, last_line, words)."""
    i, n, line = 0, len(sql), 1
    stmts, words, first, meta = [], [], None, None
    at_line_start = True
    while i < n:
        c = sql[i]
        if c == "\n":
            line += 1; i += 1; at_line_start = True; continue
        if c in " \t\r\f":
            i += 1; continue
        two = sql[i:i + 2]
        if two == "--":
            while i < n and sql[i] != "\n": i += 1
            continue
        if two == "/*":
            depth, i = 1, i + 2
            while i < n and depth:
                if sql[i:i + 2] == "/*": depth += 1; i += 2
                elif sql[i:i + 2] == "*/": depth -= 1; i += 2
                else:
                    if sql[i] == "\n": line += 1
                    i += 1
            continue
        if c == "\\" and at_line_start and meta is None:
            meta = line
        at_line_start = False
        if c == "'":
            prev = sql[i - 1] if i else ""
            escape = prev in "eE" and (i < 2 or not (sql[i - 2].isalnum() or sql[i - 2] == "_"))
            i += 1
            while i < n:
                if escape and sql[i] == "\\": i += 2; continue
                if sql[i] == "'":
                    if sql[i + 1:i + 2] == "'": i += 2; continue
                    i += 1; break
                if sql[i] == "\n": line += 1
                i += 1
            if first is None: first = line
            continue
        if c == '"':
            i += 1
            while i < n:
                if sql[i] == '"':
                    if sql[i + 1:i + 2] == '"': i += 2; continue
                    i += 1; break
                if sql[i] == "\n": line += 1
                i += 1
            if first is None: first = line
            words.append('"quoted"')
            continue
        if c == "$":
            m = re.match(r"\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$", sql[i:])
            if m:
                tag = m.group(0)
                end = sql.find(tag, i + len(tag))
                end = n if end < 0 else end + len(tag)
                line += sql.count("\n", i, end)
                i = end
                if first is None: first = line
                words.append("$body$")
                continue
        if c == ";":
            if words: stmts.append((first, line, words))
            words, first = [], None
            i += 1
            continue
        if first is None: first = line
        m = re.match(r"[A-Za-z_][A-Za-z0-9_$]*", sql[i:])
        if m:
            words.append(m.group(0).lower()); i += len(m.group(0)); continue
        i += 1
    if words: stmts.append((first, line, words))
    return stmts, meta

def cmd_guard(sql):
    stmts, meta = scan(sql)
    if meta is not None:
        print("guard refused: a psql meta-command (backslash) at line %d" % meta); return 3
    for first, last, words in stmts:
        head = words[0]
        if head in DENY_FIRST:
            print("guard refused: transaction or session control '%s' at line %d" % (head.upper(), first)); return 3
    print("guard ok: %d statements" % len(stmts)); return 0

ERR = re.compile(r"^(?:psql:[^:]*:(\d+): )?ERROR:\s+(?:([0-9A-Z]{5}):\s+)?(.*)$")

def first_error(block):
    ls = block.split("\n")
    for k, l in enumerate(ls):
        m = ERR.match(l)
        if m:
            loc = None
            for l2 in ls[k + 1:k + 6]:
                if l2.startswith("LOCATION:"): loc = l2.split(":", 1)[1].strip(); break
                if ERR.match(l2): break
            return {"line": m.group(1), "sqlstate": m.group(2), "message": m.group(3).strip(), "location": loc}
    return None

def cmd_summary(text):
    """One line per probe (marker 'PROBE n: title'). psql prints no input line for -c commands, so the line is always reported unavailable."""
    out, failed = [], []
    blocks = re.split(r"(?m)^PROBE (\d+): ", text)
    for k in range(1, len(blocks), 2):
        n, body = blocks[k], blocks[k + 1]
        title, _, rest = body.partition("\n")
        err = first_error(rest)
        if err:
            failed.append(n)
            note = ""
            if n == "3" and (err["sqlstate"] == "42704" or "does not exist" in err["message"]): note = " [control unavailable: the fixed public policy is not there]"
            out.append("probe %s (%s): FAILED sqlstate=%s message=\"%s\" server-location=%s source-line=unavailable%s" % (n, title.strip(), err["sqlstate"] or "unavailable", err["message"], err["location"] or "unavailable", note))
        else:
            tag = [l.strip() for l in rest.split("\n") if re.match(r"^(ALTER POLICY|COMMENT|CREATE [A-Z ]+|DROP [A-Z ]+|SELECT \d+)$", l.strip())]
            out.append("probe %s (%s): ok command-tag=%s" % (n, title.strip(), tag[0] if tag else "none"))
    if failed:
        out.append("FIRST failing probe: %s" % failed[0])
        if len(failed) > 1: out.append("later failing probes (may be consequences of the first): %s" % ", ".join(failed[1:]))
    else:
        out.append("first failing probe: none")
    print("\n".join(out)); return 0

def redact(text):
    pw = os.environ.get("DIAG_PW", "")
    text = re.sub(r"(?i)\bpostgres(?:ql)?://\S+", "[connection string redacted]", text)
    text = re.sub(r"(?i)[A-Za-z0-9_.%+-]+:[^\s:@/]+@[A-Za-z0-9_.\-\[\]]+(?::\d+)?(?:/\S*)?", "[connection string redacted]", text)
    text = re.sub(r"(?i)(password|passwd|pwd|secret|token|apikey|api_key)\s*=\s*\S+", r"\1=[redacted]", text)
    if pw: text = text.replace(pw, "[redacted]")
    return text

def cmd_settings(text, allowed):
    names = set(allowed)
    rows = []
    for l in text.split("\n"):
        if "|" in l:
            name, _, val = l.partition("|")
            if name.strip() in names: rows.append("%s = %s" % (name.strip(), val.strip()))
    print("\n".join(rows) if rows else "(none of the allowlisted settings is present)"); return 0

if __name__ == "__main__":
    cmd = sys.argv[1]
    data = sys.stdin.read()
    if cmd == "guard": sys.exit(cmd_guard(data))
    if cmd == "summary": sys.exit(cmd_summary(data))
    if cmd == "settings": sys.exit(cmd_settings(data, sys.argv[2:]))
    if cmd == "redact": sys.stdout.write(redact(data)); sys.exit(0)
    sys.exit(2)
PY

if [ "$MODE" = guard ]; then
  python3 "$HELPER" guard
  exit $?
fi

# ---------------------------------------------------------------------------------------------------------------------------------------
say() { printf '%s\n' "$*" | python3 "$HELPER" redact; }
say_block() { python3 "$HELPER" redact; }

URL="${TEST_DATABASE_URL:-}"
if [ -z "$URL" ]; then say "statement diagnostic: TEST_DATABASE_URL is not set; nothing was run"; exit 0; fi
if ! [[ "$URL" =~ ^[Pp][Oo][Ss][Tt][Gg][Rr][Ee][Ss]([Qq][Ll])?://([^@/]*)@(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?(/|$) ]]; then
  say "statement diagnostic: refused, not the local disposable database; nothing was run"; exit 0
fi
USERINFO="${BASH_REMATCH[2]}"
export DIAG_PW=""
case "$USERINFO" in *:*) DIAG_PW="${USERINFO#*:}" ;; esac
if ! command -v psql >/dev/null 2>&1; then say "statement diagnostic: psql is not available; nothing was run"; exit 0; fi

export PGOPTIONS="-c statement_timeout=30000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=60000"
export PGCONNECT_TIMEOUT=10
export PGAPPNAME="$APP"

# One psql run. Output (stdout and stderr together) goes to RUN_OUT and psql's own exit status to RUN_RC, captured before any filter, so no
# status is lost to a pipe. Nothing is printed here: every printed line goes through the redaction filter.
run_psql() { RUN_OUT="$(timeout 120 psql "$URL" -X -At -v ON_ERROR_STOP=0 "$@" 2>&1)"; RUN_RC=$?; }

FP_SQL="select 'FP ' || concat_ws(' ', 'policies=' || (select md5(coalesce(string_agg(concat_ws('|', schemaname, tablename, policyname, permissive, roles::text, cmd, coalesce(qual, ''), coalesce(with_check, '')), E'\n' order by schemaname, tablename, policyname), '')) from pg_policies), 'comment159=' || coalesce((select md5(d.description) from pg_policy po join pg_description d on d.objoid = po.oid and d.classoid = 'pg_policy'::regclass and d.objsubid = 0 where po.polrelid = to_regclass('storage.objects') and po.polname = 'job drawings org update'), 'none'), 'table=' || coalesce((select md5(concat_ws('|', c.relowner::regrole::text, coalesce(c.relacl::text, ''), c.relrowsecurity::text, c.relforcerowsecurity::text)) from pg_class c where c.oid = to_regclass('storage.objects')), 'missing'))"

# A fresh-session fingerprint. Empty, failed or unreadable is "" and later reported UNVERIFIED; it is never treated as a value.
fingerprint_fresh() { run_psql -c "$FP_SQL"; FPR="$(printf '%s\n' "$RUN_OUT" | grep -m1 '^FP policies=' || true)"; if [ "$RUN_RC" -ne 0 ]; then FPR=""; fi; }

# The only four database settings this script reads, each by exact name (current_setting(name, true)); nothing is selected by pattern.
SETTINGS_SQL="select 'supautils.policy_grants|' || coalesce(current_setting('supautils.policy_grants', true), 'not set or not readable') union all select 'supautils.drop_trigger_grants|' || coalesce(current_setting('supautils.drop_trigger_grants', true), 'not set or not readable') union all select 'supautils.privileged_role|' || coalesce(current_setting('supautils.privileged_role', true), 'not set or not readable') union all select 'supautils.reserved_roles|' || coalesce(current_setting('supautils.reserved_roles', true), 'not set or not readable')"
ALLOWED_SETTINGS=(supautils.policy_grants supautils.drop_trigger_grants supautils.privileged_role supautils.reserved_roles)

ANNOTATIONS=""
note_error() { ANNOTATIONS="${ANNOTATIONS}::error title=statement diagnostic::$1"$'\n'; }

# Residual risk (stated, accepted for speed): this step runs BEFORE the Database suite. A CHANGED or UNVERIFIED result means this run's required
# results are void and must be treated as such; no lock is held past the step's 3-minute timeout.
say "== statement diagnostic (informational; disposable database; every probe runs inside a transaction that is rolled back) =="
run_psql -c "select 'ok'"
if [ "$RUN_RC" -ne 0 ]; then say "statement diagnostic: the database could not be reached (psql exit $RUN_RC); nothing was run"; exit 0; fi

say "-- the four named settings (nothing else is read)"
run_psql -c "$SETTINGS_SQL"
printf '%s\n' "$RUN_OUT" | python3 "$HELPER" settings "${ALLOWED_SETTINGS[@]}" | say_block

# ----------------------------------------------------------------------------------------------------------------------
# The probes. 1 and 2 are release 159's two storage.objects statements, copied verbatim; 3 is a control on ONE fixed public policy that exists at
# baseline (migration 131's list), never a dynamically chosen one.
# PROBE-SQL-BEGIN
P1_TITLE='ALTER POLICY "job drawings org update" ON storage.objects (release 159, first statement)'
P1_SQL='ALTER POLICY "job drawings org update" ON storage.objects USING (false) WITH CHECK (false)'
P2_TITLE='COMMENT ON POLICY "job drawings org update" ON storage.objects (release 159, second statement)'
P2_SQL="COMMENT ON POLICY \"job drawings org update\" ON storage.objects IS 'release 159 (supabase/release/159_drawings_update_roles.release.sql): browser roles cannot replace an object in job-drawings; rolled back by 159_drawings_update_roles.rollback.sql'"
P3_TITLE='control: COMMENT ON POLICY "customers rbac select" ON public.customers (a table the login owns)'
P3_SQL="COMMENT ON POLICY \"customers rbac select\" ON public.customers IS 'ci-statement-diagnostic control'"
# PROBE-SQL-END

say "== probes =="
ok=1
for p in 1 2 3; do
  eval "sql=\$P${p}_SQL"
  verdict="$(printf '%s' "$sql" | python3 "$HELPER" guard)"; grc=$?
  if [ "$grc" -ne 0 ]; then say "probe $p: $verdict; the probes were not run"; ok=0; fi
done

ROLLBACK_LINE="ROLLBACK NOT CONFIRMED"; STATE_LINE="fingerprint UNVERIFIED"
if [ "$ok" = 1 ]; then
  fingerprint_fresh; before="$FPR"
  PROBE_ARGS=()
  for p in 1 2 3; do
    eval "title=\$P${p}_TITLE"; eval "sql=\$P${p}_SQL"
    PROBE_ARGS+=(-c "\\warn PROBE $p: $title" -c "$sql")
  done
  # The wrapper's own BEGIN and ROLLBACK are separate -c commands, never joined to the inspected SQL.
  run_psql -v ON_ERROR_ROLLBACK=on -v VERBOSITY=verbose -v SHOW_CONTEXT=always -c 'BEGIN' "${PROBE_ARGS[@]}" -c "$FP_SQL" -c 'ROLLBACK'
  out="$RUN_OUT"; rc="$RUN_RC"
  printf '%s\n' "$out" | say_block
  inside="$(printf '%s\n' "$out" | grep -m1 '^FP policies=' || true)"
  confirmed="no"
  if [ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -qx 'ROLLBACK'; then confirmed="yes"; fi
  if [ "$confirmed" != "yes" ]; then
    # The wrapper still attempts the rollback: a session that is gone is rolled back by the server; any backend of THIS run still inside a
    # transaction is ended, which rolls it back. The fresh-session read below still runs.
    run_psql -c "select 'ended ' || count(*) from (select pg_terminate_backend(pid) from pg_stat_activity where application_name = '$APP' and pid <> pg_backend_pid()) t"
    say "ROLLBACK was not confirmed by the transaction session (psql exit $rc); cleanup attempt: $(printf '%s' "$RUN_OUT" | head -c 200)"
  fi
  fingerprint_fresh; after="$FPR"
  say "fingerprint before : ${before:-unreadable}"
  say "fingerprint inside : ${inside:-unreadable}"
  say "fingerprint after  : ${after:-unreadable}"
  if [ -z "$before" ] || [ -z "$after" ]; then STATE_LINE="fingerprint UNVERIFIED"
  elif [ "$before" = "$after" ]; then STATE_LINE="fingerprint UNCHANGED"
  else STATE_LINE="fingerprint CHANGED"; fi
  if [ "$confirmed" = "yes" ]; then ROLLBACK_LINE="ROLLBACK CONFIRMED"; fi
  say "-- probe results (the statements are -c commands, so psql gives no input line: source-line is always unavailable here)"
  printf '%s\n' "$out" | python3 "$HELPER" summary | say_block
  [ "$confirmed" = "yes" ] || note_error "ROLLBACK NOT CONFIRMED (psql exit $rc); the fresh-session state is reported separately; this run's required results are void if the state is not UNCHANGED"
  [ "$STATE_LINE" = "fingerprint UNCHANGED" ] || note_error "$STATE_LINE after the probes; this run's required results are void"
fi

# Annotations first, so that the last two lines of the report are always the two verdicts.
if [ -n "$ANNOTATIONS" ]; then printf '%s' "$ANNOTATIONS" | say_block; fi
say "== result =="
if [ "$ok" != 1 ]; then say "no transaction was run (the guard refused the probes)"; exit 0; fi
say "$ROLLBACK_LINE"
say "$STATE_LINE"
exit 0
