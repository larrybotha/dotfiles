#!/usr/bin/env bash

set -o pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PWB="$ROOT/scripts/pwb"
INSTALL="$ROOT/scripts/install"
# shellcheck source=pins disable=SC1091
. "$ROOT/scripts/pins"
export FAKE_CLI_VERSION="$CLI_PIN"
export FAKE_CHROMIUM_REV="$CHROMIUM_REV"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/pwb-test.XXXXXX") || exit 1
FAKEBIN="$TMP/bin"
STATE="$TMP/state"
HOME_DIR="$TMP/home"
CACHE="$TMP/cache"
FAILURES=0
CASE=""

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$FAKEBIN" "$STATE/sessions" "$HOME_DIR" "$CACHE" \
  "$STATE/chromium-$CHROMIUM_REV"
: >"$STATE/chromium-$CHROMIUM_REV/INSTALLATION_COMPLETE"
NOCLI_BIN="$TMP/nocli"
mkdir -p "$NOCLI_BIN"
ln -s "$(command -v jq)" "$NOCLI_BIN/jq"

cat >"$FAKEBIN/playwright-cli" <<'FAKE'
#!/usr/bin/env bash
set -o pipefail

state="${FAKE_STATE:?}"
mkdir -p "$state/sessions" "$state/meta"

version="${FAKE_CLI_VERSION:?}"
rev="${FAKE_CHROMIUM_REV:?}"
session=""
profile=""
config=""
args=("$@")
i=0
while [ "$i" -lt "${#args[@]}" ]; do
  arg="${args[$i]}"
  case "$arg" in
    --version) printf '%s\n' "$version"; exit 0 ;;
    -s=*) session="${arg#-s=}" ;;
  esac
  i=$((i + 1))
done

if [ "${1:-}" = "--help" ]; then
  printf '### Help\n%s\n' "${2:-}"
  exit 0
fi

cmd=""
for arg in "$@"; do
  case "$arg" in
    --json|--raw|-s=*) ;;
    *) cmd="$arg"; break ;;
  esac
done

case "$cmd" in
  install-browser)
    dry=0
    for arg in "$@"; do
      [ "$arg" = "--dry-run" ] && dry=1
    done
    if [ "$dry" = "1" ]; then
      printf 'Chrome for Testing (playwright chromium v%s)\n' "$rev"
      printf '  Install location:    %s/chromium-%s\n' "$state" "$rev"
    else
      mkdir -p "$state/chromium-$rev"
      : >"$state/chromium-$rev/INSTALLATION_COMPLETE"
    fi
    exit 0
    ;;
  list)
    if [ "${FAKE_DUMP_ENV:-0}" = "1" ]; then
      env >"$state/env-list"
    fi
    if [ "${FAKE_LIST_FAIL:-0}" = "1" ]; then
      exit 1
    fi
    if [ "${FAKE_LIST_INVALID:-0}" = "1" ]; then
      printf 'not-json\n'
      exit 0
    fi
    printf '{"browsers":['
    first=1
    for f in "$state"/sessions/*; do
      [ -e "$f" ] || continue
      name=$(basename "$f")
      [ "$first" -eq 1 ] || printf ','
      first=0
      printf '{"name":"%s"}' "$name"
    done
    printf ']}\n'
    ;;
  open)
    if [ "${FAKE_OPEN_EXIT:-0}" != "0" ]; then
      [ -z "${FAKE_OPEN_STDOUT:-}" ] || printf '%s\n' "$FAKE_OPEN_STDOUT"
      [ -z "${FAKE_OPEN_STDERR:-}" ] || printf '%s\n' "$FAKE_OPEN_STDERR" >&2
      exit "$FAKE_OPEN_EXIT"
    fi
    for arg in "$@"; do
      case "$arg" in
        --profile=*) profile="${arg#--profile=}" ;;
        --config=*) config="${arg#--config=}" ;;
      esac
    done
    [ -n "$session" ] || exit 1
    printf 'profile=%s\nconfig=%s\n' "$profile" "$config" >"$state/meta/$session"
    touch "$state/sessions/$session"
    printf '{"status":"open","session":"%s"}\n' "$session"
    ;;
  close)
    [ -n "$session" ] || exit 1
    if [ "${FAKE_CLOSE_NOOP:-0}" = "1" ]; then
      printf '{"status":"closed","session":"%s"}\n' "$session"
      exit 0
    fi
    if [ "${FAKE_CLOSE_DELAY:-0}" = "1" ]; then
      ( sleep 1; rm -f "$state/sessions/$session" "$state/meta/$session" ) &
      printf '{"status":"closed","session":"%s"}\n' "$session"
      exit 0
    fi
    rm -f "$state/sessions/$session"
    rm -f "$state/meta/$session"
    printf '{"status":"closed","session":"%s"}\n' "$session"
    ;;
  config-print)
    meta="$state/meta/$session"
    if [ "${FAKE_CONFIG_STDERR:-0}" = "1" ]; then
      printf '{stderr from CLI}\n' >&2
    fi
    printf '### Result\n'
    if [ "${FAKE_CONFIG_INVALID:-0}" = "1" ]; then
      printf 'not-json\n'
      exit 0
    fi
    if [ "${FAKE_CONFIG_DRIFT:-0}" = "1" ]; then
      printf '{"browser":{"browserName":"chromium","launchOptions":{"headless":true,"channel":"chromium"},"userDataDir":"/wrong"},"outputDir":"/wrong"}\n'
      exit 0
    fi
    if [ -f "$meta" ]; then
      profile=$(sed -n 's/^profile=//p' "$meta")
      config=$(sed -n 's/^config=//p' "$meta")
      output=$(jq -r '.outputDir' "$config" 2>/dev/null)
    fi
    printf '{"browser":{"browserName":"chromium","launchOptions":{"headless":true,"channel":"chromium"},"userDataDir":"%s"},"outputDir":"%s"}\n' "$profile" "$output"
    if [ "${FAKE_CONFIG_TRAILING:-0}" = "1" ]; then
      printf '### Events\ntrailing section\n'
    fi
    ;;
  snapshot)
    if [ "${FAKE_DUMP_ENV:-0}" = "1" ]; then
      env >"$state/env"
    fi
    printf '### Snapshot\n- ref e1\n'
    ;;
  goto)
    printf '{"status":"goto"}\n'
    ;;
  *)
    printf '{"status":"ok","command":"%s"}\n' "$cmd"
    ;;
esac
FAKE
chmod 0755 "$FAKEBIN/playwright-cli"

pwb_run() {
  HOME="$HOME_DIR" XDG_CACHE_HOME="$CACHE" FAKE_STATE="$STATE" \
    PATH="$FAKEBIN:$PATH" "$PWB" "$@"
}

pass() {
  printf 'ok: %s\n' "$CASE"
}

fail() {
  printf 'FAIL: %s: %s\n' "$CASE" "$*" >&2
  FAILURES=$((FAILURES + 1))
}

expect_status() {
  local expected="$1"
  shift
  "$@"
  local actual=$?
  if [ "$actual" -ne "$expected" ]; then
    fail "expected status $expected, got $actual"
  fi
}

expect_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" != "$expected" ]; then
    fail "$label: expected '$expected', got '$actual'"
  fi
}

json_field() {
  jq -r "$1"
}

mode_of() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

CASE="help"
out=$(pwb_run help) || fail "help failed"
expect_eq "$(printf '%s' "$out" | head -n 1)" "Usage:" "help first line"

CASE="help command passthrough"
out=$(pwb_run help screenshot) || fail "help screenshot failed"
case "$out" in
  *"### Help"*screenshot*) ;;
  *) fail "help did not reach playwright-cli: $out" ;;
esac

CASE="help wrapper builtin"
out=$(pwb_run help status) || fail "help status failed"
expect_eq "$(printf '%s' "$out" | head -n 1)" "Usage:" "builtin help first line"
expect_status 2 pwb_run help screenshot pdf

CASE="artifact arg guard"
expect_status 2 pwb_run screenshot --full-page /tmp/shot.png
expect_status 2 pwb_run screenshot shot.png
expect_status 2 pwb_run screenshot ./shot.jpg
expect_status 2 pwb_run pdf /tmp/page.pdf
expect_status 2 pwb_run pdf page.pdf
expect_status 0 pwb_run screenshot --filename=/tmp/shot.png
expect_status 0 pwb_run screenshot --filename /tmp/shot.png --full-page
expect_status 0 pwb_run screenshot e12
expect_status 0 pwb_run screenshot 'a[href="/x"]'
expect_status 0 pwb_run screenshot 'div.note span'
expect_status 0 pwb_run pdf --filename=/tmp/page.pdf

CASE="artifact guard quoted and uppercase paths"
expect_status 2 pwb_run screenshot --full-page '/tmp/shot with spaces.png'
expect_status 2 pwb_run screenshot 'shot with spaces.png'
expect_status 2 pwb_run screenshot shot.PNG
expect_status 2 pwb_run screenshot dir.something/shot
expect_status 2 pwb_run screenshot '~/shot'
expect_status 0 pwb_run screenshot https://example.test/shot

REPO="$TMP/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
CASE="git root session"
out=$(cd "$REPO" && pwb_run session --json) || fail "session failed"
S_ROOT=$(printf '%s' "$out" | json_field .session)
case "$S_ROOT" in
  pi-repo-*) ;;
  *) fail "unexpected session: $S_ROOT" ;;
esac

CASE="subdirectory shares session"
mkdir -p "$REPO/src/deep"
out=$(cd "$REPO/src/deep" && pwb_run session --json) || fail "subdir session failed"
S_SUB=$(printf '%s' "$out" | json_field .session)
expect_eq "$S_SUB" "$S_ROOT" "subdir session"

CASE="symlinked cwd shares session"
ln -s "$REPO" "$TMP/repo-link"
out=$(cd "$TMP/repo-link" && pwb_run session --json) || fail "symlink session failed"
expect_eq "$(printf '%s' "$out" | json_field .session)" "$S_ROOT" "symlink session"

CASE="truncated basename"
LONG="$TMP/$(printf 'a%.0s' $(seq 1 40))"
mkdir -p "$LONG"
out=$(cd "$LONG" && pwb_run session --json) || fail "truncated session failed"
S_LONG=$(printf '%s' "$out" | json_field .session)
PREFIX="pi-$(printf 'a%.0s' $(seq 1 32))-"
case "$S_LONG" in
  "$PREFIX"*) ;;
  *) fail "unexpected truncated session: $S_LONG" ;;
esac

CASE="session json keys"
keys=$(printf '%s' "$out" | jq -r 'keys | join(",")')
expect_eq "$keys" "config,output,profile,root,session,workspace" "keys"

CASE="suffix"
out=$(cd "$REPO" && PWB_SESSION_SUFFIX=agent-1 pwb_run session --json) || fail "suffix failed"
S_SUFFIX=$(printf '%s' "$out" | json_field .session)
case "$S_SUFFIX" in
  "$S_ROOT"-agent-1) ;;
  *) fail "unexpected suffix session: $S_SUFFIX" ;;
esac

CASE="suffix json keys"
keys=$(printf '%s' "$out" | jq -r 'keys | join(",")')
expect_eq "$keys" "config,output,profile,root,session,workspace" "suffix keys"

CASE="empty suffix"
out=$(cd "$REPO" && PWB_SESSION_SUFFIX= pwb_run session --json) || fail "empty suffix failed"
expect_eq "$(printf '%s' "$out" | json_field .session)" "$S_ROOT" "empty suffix session"

CASE="invalid suffix"
expect_status 2 env PWB_SESSION_SUFFIX=../x HOME="$HOME_DIR" XDG_CACHE_HOME="$CACHE" FAKE_STATE="$STATE" PATH="$FAKEBIN:$PATH" "$PWB" session
expect_status 2 env PWB_SESSION_SUFFIX=abcdefghijklmnopq HOME="$HOME_DIR" XDG_CACHE_HOME="$CACHE" FAKE_STATE="$STATE" PATH="$FAKEBIN:$PATH" "$PWB" session

CASE="sanitized basename"
DIR="$TMP/Bad Name!"
mkdir -p "$DIR"
out=$(cd "$DIR" && pwb_run session --json) || fail "sanitized session failed"
S_BAD=$(printf '%s' "$out" | json_field .session)
case "$S_BAD" in
  pi-Bad-Name-*) ;;
  *) fail "unexpected sanitized session: $S_BAD" ;;
esac

CASE="empty basename"
out=$(cd / && pwb_run session --json) || fail "root session failed"
S_ROOTDIR=$(printf '%s' "$out" | json_field .session)
case "$S_ROOTDIR" in
  pi-workspace-*) ;;
  *) fail "unexpected root session: $S_ROOTDIR" ;;
esac

CASE="path"
out=$(cd "$REPO" && pwb_run path output) || fail "path failed"
S_JSON=$(cd "$REPO" && pwb_run session --json)
expect_eq "$out" "$(printf '%s' "$S_JSON" | json_field .output)" "path output"

CASE="config generation"
cd "$REPO" || exit 1
pwb_run open http://example.test >/dev/null || fail "open failed"
S_JSON=$(pwb_run session --json)
SROOT=$(printf '%s' "$S_JSON" | json_field .root)
OUT=$(printf '%s' "$S_JSON" | json_field .output)
CONFIG=$(printf '%s' "$S_JSON" | json_field .config)
[ -f "$CONFIG" ] || fail "config missing"
expect_eq "$(jq -r '.outputDir' "$CONFIG")" "$OUT" "config outputDir"
expect_eq "$(jq -r '.browser.browserName' "$CONFIG")" "chromium" "browserName"
expect_eq "$(mode_of "$CONFIG")" "600" "config mode"
expect_eq "$(mode_of "$OUT")" "700" "output mode"

CASE="live open refusal"
expect_status 1 pwb_run open http://example.test

CASE="restart"
pwb_run open --restart http://example.test >/dev/null || fail "restart failed"

CASE="reserved flags"
expect_status 2 pwb_run open --config=/tmp/x
expect_status 2 pwb_run open --config /tmp/x
expect_status 2 pwb_run open --session=x
expect_status 2 pwb_run open --browser=firefox

CASE="reserved flag matrix"
for arg in -s --session --config --profile --persistent --user-data-dir --browser --cdp --endpoint --extension --executable-path --channel; do
  expect_status 2 pwb_run open "$arg"
  expect_status 2 pwb_run open "$arg=x"
done

CASE="pass-through leading session"
expect_status 2 pwb_run -s=other list
expect_status 2 pwb_run --session=other list
expect_status 2 pwb_run -s other list
expect_status 2 pwb_run --session other list

CASE="blocked commands"
expect_status 1 pwb_run attach default
expect_status 1 pwb_run close-all
expect_status 1 pwb_run delete-data
expect_status 1 pwb_run install
expect_status 1 pwb_run -g attach default
expect_status 1 pwb_run --all close-all
expect_status 1 pwb_run --raw -g kill-all
expect_status 1 pwb_run -- attach default

CASE="device does not consume reserved flags"
expect_status 2 pwb_run open --device --config=/tmp/x

CASE="open exit normalization"
( export FAKE_OPEN_EXIT=7; expect_status 1 pwb_run open http://example.test )

CASE="env scrub"
( export FAKE_DUMP_ENV=1 PLAYWRIGHT_MCP_FOO=1 PLAYWRIGHT_CLI_SESSION=other; pwb_run snapshot >/dev/null ) || fail "snapshot failed"
if grep -q '^PLAYWRIGHT_MCP_FOO=' "$STATE/env"; then fail "PLAYWRIGHT_MCP_FOO leaked"; fi
if grep -q '^PLAYWRIGHT_CLI_SESSION=' "$STATE/env"; then fail "PLAYWRIGHT_CLI_SESSION leaked"; fi

CASE="list failure is not absence"
( export FAKE_LIST_FAIL=1; expect_status 1 pwb_run close )
( export FAKE_LIST_INVALID=1; expect_status 1 pwb_run close )

CASE="env scrub initial list"
( export FAKE_DUMP_ENV=1 PLAYWRIGHT_MCP_FOO=1; pwb_run close >/dev/null ) || fail "close with dump failed"
if grep -q '^PLAYWRIGHT_MCP_FOO=' "$STATE/env-list"; then fail "list leaked PLAYWRIGHT_MCP_FOO"; fi

CASE="multi-poll close"
pwb_run open http://example.test >/dev/null || fail "open before multi-poll close failed"
( export FAKE_CLOSE_DELAY=1; pwb_run close >/dev/null ) || fail "multi-poll close failed"
[ ! -e "$STATE/sessions/$S_ROOT" ] || fail "multi-poll session still live"

CASE="close"
pwb_run close >/dev/null || fail "close failed"
[ ! -e "$STATE/sessions/$S_ROOT" ] || fail "session still live"
out=$(pwb_run close) || fail "second close failed"
expect_eq "$(printf '%s' "$out" | json_field .status)" "not-open" "second close status"

CASE="config drift"
( export FAKE_CONFIG_DRIFT=1; expect_status 1 pwb_run open http://example.test )
[ ! -e "$STATE/sessions/$S_ROOT" ] || fail "drift left session live"

CASE="config-print invalid JSON"
( export FAKE_CONFIG_INVALID=1; expect_status 1 pwb_run open http://example.test )
[ ! -e "$STATE/sessions/$S_ROOT" ] || fail "invalid JSON left session live"

CASE="open output buffered on verify failure"
out=$( ( export FAKE_CONFIG_INVALID=1; pwb_run open http://example.test ) 2>/dev/null )
status=$?
expect_eq "$status" "1" "invalid JSON open status"
case "$out" in
  *'"status":"open"'*) fail "open output leaked before verification" ;;
esac

CASE="config-print trailing section"
( export FAKE_CONFIG_TRAILING=1; pwb_run open http://example.test >/dev/null ) \
  || fail "trailing section rejected"
[ -e "$STATE/sessions/$S_ROOT" ] || fail "trailing section left session closed"
pwb_run close >/dev/null || fail "cleanup close failed"

CASE="config-print stderr not parsed as JSON"
S_CFG_ROOT=$(pwb_run session --json | json_field .root)
( export FAKE_CONFIG_STDERR=1; pwb_run open http://example.test >/dev/null ) \
  || fail "stderr poisoned config parse"
[ -e "$STATE/sessions/$S_ROOT" ] || fail "stderr case left session closed"
if ls -a "$S_CFG_ROOT" | grep -q 'config-print.stderr'; then
  fail "config-print stderr temp file left behind"
fi
pwb_run close >/dev/null || fail "cleanup close failed"

CASE="open failure preserves diagnostics"
errfile="$TMP/open.err"
out=$( export FAKE_OPEN_EXIT=7 FAKE_OPEN_STDOUT=open-out FAKE_OPEN_STDERR=open-err; pwb_run open http://example.test 2>"$errfile" )
status=$?
expect_eq "$status" "1" "open failure status"
case "$out" in
  *open-out*) ;;
  *) fail "lost CLI stdout on failed open: $out" ;;
esac
grep -q open-err "$errfile" || fail "lost CLI stderr on failed open"

CASE="status rejects arguments"
expect_status 2 pwb_run status --json

CASE="status"
out=$(pwb_run status) || fail "status failed"
expect_eq "$(printf '%s' "$out" | json_field .status)" "not-open" "status not-open"
pwb_run open http://example.test >/dev/null || fail "open before status failed"
out=$(pwb_run status) || fail "status open failed"
expect_eq "$(printf '%s' "$out" | json_field .status)" "open" "status open"
pwb_run close >/dev/null || fail "close after status failed"
( export FAKE_LIST_FAIL=1; expect_status 1 pwb_run status )

CASE="reset confirmation"
expect_status 1 pwb_run reset

CASE="reset"
pwb_run open http://example.test >/dev/null || fail "open before reset failed"
out=$(pwb_run reset --yes) || fail "reset failed"
expect_eq "$(printf '%s' "$out" | json_field .status)" "removed" "reset status"
[ ! -e "$SROOT" ] || fail "root still exists"

CASE="reset absent"
out=$(pwb_run reset --yes) || fail "absent reset failed"
expect_eq "$(printf '%s' "$out" | json_field .status)" "absent" "absent status"

CASE="reset closes live session with missing root"
pwb_run open http://example.test >/dev/null || fail "open before missing-root reset failed"
rm -rf "$SROOT"
out=$(pwb_run reset --yes) || fail "missing-root reset failed"
expect_eq "$(printf '%s' "$out" | json_field .status)" "absent" "missing-root reset status"
[ ! -e "$STATE/sessions/$S_ROOT" ] || fail "missing-root reset left session live"

CASE="reset symlink refusal"
pwb_run session >/dev/null
rm -rf "$SROOT"
ln -s /tmp "$SROOT"
expect_status 1 pwb_run reset --yes
rm -f "$SROOT"

CASE="doctor normal"
expect_status 0 pwb_run doctor

CASE="doctor missing cli"
expect_status 1 env HOME="$HOME_DIR" XDG_CACHE_HOME="$CACHE" PATH="$NOCLI_BIN:/usr/bin:/bin" "$PWB" doctor

CASE="doctor cli mismatch"
expect_status 1 env FAKE_CLI_VERSION=0.0.0 HOME="$HOME_DIR" XDG_CACHE_HOME="$CACHE" \
  FAKE_STATE="$STATE" PATH="$FAKEBIN:$PATH" "$PWB" doctor

CASE="doctor chromium mismatch"
expect_status 1 env FAKE_CHROMIUM_REV=1 HOME="$HOME_DIR" XDG_CACHE_HOME="$CACHE" \
  FAKE_STATE="$STATE" PATH="$FAKEBIN:$PATH" "$PWB" doctor

CASE="close timeout"
pwb_run open http://example.test >/dev/null || fail "open before timeout failed"
(
  export FAKE_CLOSE_NOOP=1
  HOME="$HOME_DIR" XDG_CACHE_HOME="$CACHE" FAKE_STATE="$STATE" \
    PATH="$FAKEBIN:$PATH" timeout 20 "$PWB" close
) >/dev/null 2>&1
status=$?
expect_eq "$status" "1" "close timeout status"
pwb_run close >/dev/null || fail "cleanup close failed"

CASE="shell syntax"
bash -n "$PWB" || fail "bash -n failed"
bash -n "$INSTALL" || fail "install bash -n failed"

CASE="shellcheck"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "$PWB" "$INSTALL" || fail "shellcheck failed"
else
  printf 'skip: shellcheck\n'
fi

if [ "$FAILURES" -ne 0 ]; then
  printf '%d failure(s)\n' "$FAILURES" >&2
  exit 1
fi

printf 'all pwb tests passed\n'
