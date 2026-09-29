#!/usr/bin/env bash
# Linux smoke test: daemon (no AIBROKER_TRANSPORT) + tmux pane running a stand-in
# claude; deliver a message through the real send_to_session IPC path.
set -u
cd "$(dirname "$0")/../.."
REPO="$PWD"

export HOME="${HOME:-/home/node}"
export STANDIN_LOG=/tmp/standin-received.txt
export PATH="$REPO/test/linux:$PATH"
export TERM=xterm-256color LANG=C.UTF-8
unset AIBROKER_TRANSPORT TMUX ITERM_SESSION_ID TERM_PROGRAM
DLOG=/tmp/aibroker-daemon.log
fail() { echo "FAIL: $*"; echo "--- daemon log ---"; cat "$DLOG" 2>/dev/null; echo "--- pane ---"; tmux capture-pane -p -J -t smoke 2>/dev/null; exit 1; }
ok() { echo "ok: $*"; }

echo "platform: $(uname -sm), node $(node -v), $(tmux -V)"
mkdir -p "$HOME/.aibroker"

# 1. daemon, no transport override
node dist/daemon/cli.js start > "$DLOG" 2>&1 &
DPID=$!
for _ in $(seq 1 60); do [ -S /tmp/aibroker.sock ] && break; sleep 0.5; done
[ -S /tmp/aibroker.sock ] || fail "daemon socket never appeared"
ok "daemon up (pid $DPID), AIBROKER_TRANSPORT unset"

# 2. tmux session running the stand-in
tmux new-session -d -s smoke -x 200 -y 50 claude
tmux select-pane -t smoke -T smoke-claude
for _ in $(seq 1 20); do tmux capture-pane -p -t smoke | grep -q '❯' && break; sleep 0.25; done
tmux capture-pane -p -t smoke | grep -q '❯' || fail "stand-in claude did not draw its prompt"
ok "tmux pane running stand-in claude"

# 3. deliver through the real IPC path used by aibroker_send_to_session
MSG="hello-from-smoke-$$"
RESULT=$(node --input-type=module -e '
import { WatcherClient } from "./dist/ipc/client.js";
const c = new WatcherClient("/tmp/aibroker.sock");
const r = await c.call_raw("send_to_session", { target: "smoke-claude", message: process.argv[1], noReply: true });
console.log(JSON.stringify(r));
' "$MSG") || fail "send_to_session call threw"
echo "send_to_session -> $RESULT"

# 4. the line must arrive
for _ in $(seq 1 20); do grep -qxF "$MSG" "$STANDIN_LOG" && break; sleep 0.25; done
grep -qxF "$MSG" "$STANDIN_LOG" || fail "message did not reach the stand-in claude (file: $(cat "$STANDIN_LOG"))"
ok "message arrived in the pane's process: $(cat "$STANDIN_LOG")"

# 5. session_content over tmux (capture-pane path)
SID=$(node -e 'const r=JSON.parse(process.argv[1]); console.log(r.sessionId ?? "")' "$RESULT")
[ -n "$SID" ] || fail "send_to_session returned no sessionId"
# the stand-in redraws just after logging the line, so poll rather than race the repaint
for _ in $(seq 1 10); do
  CONTENT=$(node --input-type=module -e '
import { WatcherClient } from "./dist/ipc/client.js";
const c = new WatcherClient("/tmp/aibroker.sock");
const r = await c.call_raw("session_content", { sessionId: process.argv[1], lines: 20 });
console.log(JSON.stringify(r));
' "$SID") || fail "session_content call threw"
  echo "$CONTENT" | grep -q "$MSG" && break
  sleep 0.3
done
echo "session_content -> ${CONTENT:0:300}"
echo "$CONTENT" | grep -q "$MSG" || fail "session_content did not return the pane text"
ok "session_content read the pane via tmux"

# 6. status is not degraded
STATUS=$(node dist/daemon/cli.js status) || fail "status call failed"
echo "$STATUS"
echo "$STATUS" | grep -qiE "status:.*(degraded|down)|degraded" && fail "hub reports degraded"
ok "status not degraded"

# 7. no macOS-isms in the daemon log
# (the AIBP "terminal:iterm" plugin name is a label, not an iTerm call — match failures only)
BAD='osascript|impostor|lsappinfo|launchctl|degraded|iterm.*(fail|error|unreliable|enumerat)|enumerat.*iterm'
if grep -qiE "$BAD" "$DLOG"; then
  grep -iE "$BAD" "$DLOG"
  fail "daemon log mentions osascript/iTerm"
fi
ok "daemon log has no osascript/iTerm lines ($(wc -l < "$DLOG") lines)"

# 8. launch a plain directory through the transport (fresh tmux server, own stand-in log)
tmux kill-server 2>/dev/null; sleep 0.5
export STANDIN_LOG=/tmp/standin-launch.txt
PROJ="$(mktemp -d)/myproject"; mkdir -p "$PROJ"
AIB="node dist/daemon/cli.js"
LAUNCH=$($AIB launch "$PROJ") || fail "launch failed"
echo "$LAUNCH"
echo "$LAUNCH" | grep -q "Launched myproject" || fail "launch did not report the session"
echo "$LAUNCH" | grep -q "  tmux " || fail "launch did not print transport + id"
echo "$LAUNCH" | grep -q "attach: tmux attach -t aibroker" || fail "launch outside tmux did not say how to attach"
for _ in $(seq 1 30); do tmux capture-pane -p -t aibroker | grep -q '❯' && break; sleep 0.25; done
tmux capture-pane -p -t aibroker | grep -q '❯' || fail "launched stand-in claude did not draw its prompt"
[ "$(tmux display-message -p -t aibroker '#{window_name}|#{pane_title}')" = "myproject|myproject" ] || fail "window/pane title is not the name"
ok "launched $PROJ as tmux window 'myproject'"

# 8b. launching again attaches instead of duplicating
AGAIN=$($AIB launch "$PROJ") || fail "second launch failed"
echo "$AGAIN"
echo "$AGAIN" | grep -q "already running" || fail "second launch did not attach"
[ "$(tmux list-panes -a | wc -l)" = "1" ] || fail "second launch opened another pane"
ok "second launch attached, no duplicate pane"

# 9. sessions lists it (name, transport, state, dir)
LISTING=""
for _ in $(seq 1 20); do
  LISTING=$($AIB sessions) || fail "sessions failed"
  echo "$LISTING" | grep -q "myproject" && break; sleep 0.3
done
echo "$LISTING"
echo "$LISTING" | grep "myproject" | grep -q "tmux" || fail "sessions does not list myproject on tmux"
echo "$LISTING" | grep "myproject" | grep -q "$PROJ" || fail "sessions does not show the directory"
ok "aibroker sessions lists myproject (tmux, $PROJ)"

# 10. send by name reaches the launched session
LMSG="hello-launch-$$"
$AIB send myproject "$LMSG" || fail "send failed"
for _ in $(seq 1 20); do grep -qxF "$LMSG" "$STANDIN_LOG" && break; sleep 0.25; done
grep -qxF "$LMSG" "$STANDIN_LOG" || fail "send by name did not arrive (file: $(cat "$STANDIN_LOG"))"
ok "aibroker send myproject arrived: $LMSG"

# 11. pidfile, restart and stop without lsof and without a service
PIDFILE="$HOME/.aibroker/daemon.pid"
[ -f "$PIDFILE" ] || fail "daemon wrote no pidfile"
[ "$(stat -c %a "$PIDFILE")" = "600" ] || fail "pidfile is not 0600"
OLD=$(cat "$PIDFILE")
$AIB restart || fail "restart failed"
for _ in $(seq 1 60); do $AIB ping >/dev/null 2>&1 && break; sleep 0.5; done
$AIB ping >/dev/null 2>&1 || fail "daemon not back after restart"
NEW=$(cat "$PIDFILE")
[ "$OLD" != "$NEW" ] || fail "restart kept the same pid ($OLD)"
ok "restart: pid $OLD -> $NEW"
$AIB stop || fail "stop failed"
for _ in $(seq 1 40); do [ -S /tmp/aibroker.sock ] || break; sleep 0.25; done
[ ! -S /tmp/aibroker.sock ] || fail "socket still present after stop"
# gone, or a zombie nobody has reaped yet (the restarted daemon's parent is pid 1, i.e. this script)
for _ in $(seq 1 20); do ST=$(ps -o stat= -p "$NEW" 2>/dev/null | tr -d ' '); [ -z "$ST" ] || [ "${ST#Z}" != "$ST" ] && break; sleep 0.25; done
[ -z "$ST" ] || [ "${ST#Z}" != "$ST" ] || fail "daemon pid $NEW still alive after stop (state $ST)"
[ ! -f "$PIDFILE" ] || fail "pidfile left behind after stop"
ok "stop: daemon gone, socket and pidfile removed"

wait "$DPID" 2>/dev/null; tmux kill-server 2>/dev/null
echo "PASS"
