# Guest side of the --real-claude step (sourced into a user script by vm-acceptance.sh; @RUN_G@ is
# replaced by the shared-folder path). Drives the real Claude Code in tmux session "demo" by reading
# the pane: first-run prompts are answered by their text, never by blind keystrokes.
T=demo; W=demo:demo; PL=@RUN_G@/pane-log.txt; : > $PL
tmux has-session -t $T 2>/dev/null || tmux new-session -d -s $T -x 200 -y 50
if [ -S "$XDG_RUNTIME_DIR/wayland-0" ]; then  # visible terminal when the desktop session exists
  WAYLAND_DISPLAY=wayland-0 DISPLAY=:0 setsid gnome-terminal --maximize -- tmux attach -t $T >/tmp/gt.log 2>&1 </dev/null &
  sleep 4
fi
tmux send-keys -t $T:0 -l 'mkdir -p ~/demo && aibroker launch ~/demo'; tmux send-keys -t $T:0 Enter
for i in $(seq 1 15); do tmux list-windows -t $T -F '#{window_name}' | grep -qx demo && break; sleep 2; done
tmux list-windows -t $T -F '#{window_name}' | grep -qx demo || { echo "no demo window after launch"; tmux list-windows -a; exit 1; }
cap() { tmux capture-pane -p -J -t $W -S -60; }
ready=0
# Menus open on the safe default ("No, exit"): move the cursor onto the wanted entry, then confirm.
pick() { if grep -q "❯ *\([0-9]*\. *\)\?$1" <<<"$c"; then tmux send-keys -t $W Enter; else tmux send-keys -t $W Down; fi; sleep 2; }
for i in $(seq 1 90); do
  c=$(cap); printf '%s\n' "$c" >> $PL
  if grep -q 'Yes, I trust this folder' <<<"$c"; then pick 'Yes, I trust this folder'; echo "answering: workspace trust"; continue; fi
  if grep -q 'Try the new fullscreen renderer' <<<"$c"; then pick 'Not now'; echo "answering: fullscreen renderer -> Not now"; continue; fi
  if tail -n 12 <<<"$c" | grep -q 'MCPs:'; then ready=1; break; fi
  sleep 3
done
cap > @RUN_G@/pane-ready.txt
[ $ready = 1 ] || { echo "claude never showed the PAI statusline"; cat @RUN_G@/pane-ready.txt; exit 1; }
m=$(cap | grep 'MCPs:' | tail -1); echo "statusline: $m"
grep -qi aibroker <<<"$m" && grep -qi pai <<<"$m" || { echo "MCPs line lacks Aibroker and PAI"; exit 1; }
ok=0; for i in $(seq 1 30); do aibroker sessions | grep -qE '^\s*demo\s+tmux\s+at-prompt(\s|$)' && ok=1 && break; sleep 2; done
aibroker sessions
[ $ok = 1 ] || { echo "aibroker sessions does not list demo as tmux + at-prompt"; tmux list-panes -a -F 'pane #{pane_id} cmd=#{pane_current_command} title=[#{pane_title}]'; exit 1; }
tmux send-keys -t $W -l "$(cat @RUN_G@/task-prompt.txt)"; sleep 1; tmux send-keys -t $W Enter
second=0; done=0
for i in $(seq 1 100); do  # 5 min
  [ "$(tmux list-panes -t $W | wc -l)" -ge 2 ] && second=1
  [ -f ~/demo/wordfreq.py ] && [ -f ~/demo/test_wordfreq.py ] && { done=1; break; }
  cap >> $PL; sleep 3
done
[ $done = 1 ] || { echo "wordfreq.py / test_wordfreq.py not created within 5 min"; cap; exit 1; }
finished() { pai worker ps --all | sed -n '/^FINISHED/,$p' | grep -q '\['; }
for i in $(seq 1 40); do  # the worker may finish a little after the files appear
  [ "$(tmux list-panes -t $W | wc -l)" -ge 2 ] && second=1
  finished && break; sleep 3
done
rc=0
pai worker ps --all
finished || { echo "no finished worker in pai worker ps"; rc=1; }
[ $second = 1 ] || { echo "window never had a second (worker) pane"; rc=1; }
(cd ~/demo && python3 -m unittest -v) || { echo "unittest in ~/demo failed"; rc=1; }
cap > @RUN_G@/pane-final.txt
n=0; for p in $(tmux list-panes -a -F '#{pane_id}'); do n=$((n+1)); tmux capture-pane -p -J -t $p -S -200 > @RUN_G@/pane-all-$n.txt; done
grep -hi 'hook error' $PL @RUN_G@/pane-*.txt | sed 's/^ *//' | sort -u | while IFS= read -r l; do echo "WARN: claude hook error: $l"; done
exit $rc
