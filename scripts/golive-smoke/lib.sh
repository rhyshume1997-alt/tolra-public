# Shared shell helpers of the go-live smoke job (sourced, never run). Loopback database only.
#
#   smoke_line <n> <name> PASS|FAIL <detail>   appends "SMOKE <n> <name>: PASS|FAIL <detail>" to the results file and prints it
#   known_gap <name> <detail>                  appends "KNOWN GAP <name>: <detail>"
#   psql_q ...                                 psql on TEST_DATABASE_URL (from .env.test.local), ON_ERROR_STOP, unaligned, '|' separated
#
# GOLIVE_SMOKE_DIR (default work/golive-smoke) holds the results file and the evidence. It is NOT under test-results/: Playwright
# empties test-results/ when it starts, and the lines written before the browser walk must survive it.
GOLIVE_SMOKE_DIR="${GOLIVE_SMOKE_DIR:-$PWD/work/golive-smoke}"
GOLIVE_SMOKE_RESULTS="${GOLIVE_SMOKE_RESULTS:-$GOLIVE_SMOKE_DIR/results.txt}"
mkdir -p "$GOLIVE_SMOKE_DIR"
export GOLIVE_SMOKE_DIR GOLIVE_SMOKE_RESULTS

smoke_line() {
  local n="$1" name="$2" verdict="$3"; shift 3
  local line="SMOKE $n $name: $verdict [$(date -u +%H:%M:%SZ)] $*"
  printf '%s\n' "${line//$'\n'/ }" >> "$GOLIVE_SMOKE_RESULTS"
  printf '%s\n' "${line//$'\n'/ }"
}

known_gap() {
  local name="$1"; shift
  local line="KNOWN GAP $name: $*"
  printf '%s\n' "${line//$'\n'/ }" >> "$GOLIVE_SMOKE_RESULTS"
  printf '%s\n' "${line//$'\n'/ }"
}

load_test_env() {
  [ -f .env.test.local ] || { echo "no .env.test.local: start the disposable stack first (scripts/test-backend.sh start)" >&2; return 1; }
  set -a; . ./.env.test.local; set +a
  case "$TEST_DATABASE_URL" in
    postgresql://*@127.0.0.1:*) ;;
    *) echo "Refusing: $TEST_DATABASE_URL is not the local disposable database" >&2; return 1 ;;
  esac
}

psql_q() { psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -X -At -F '|' "$@"; }
