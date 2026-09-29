#!/usr/bin/env bash
# VM acceptance (SPEC-linux-tmux R11): revert a Parallels Ubuntu VM to a clean snapshot, install
# the packed build as a fresh user and run the Linux target flow. Run from the macOS host:
#   AIBROKER_VM_NAME=... AIBROKER_VM_SNAPSHOT=... AIBROKER_VM_SHARE_HOST=... AIBROKER_VM_SHARE_GUEST=... \
#     [AIBROKER_VM_USER=<existing desktop user>] npm run test:vm [-- --keep] [-- --reboot] [-- --adapters]
#       [-- --pai <tgz> [--postgres] [--real-claude]]
# AIBROKER_VM_USER: use that (logged-in) user instead of creating a fresh one; it and its files are never
# deleted (~/.claude holds the login), the harness removes only paths it created. --real-claude needs it.
# The revert is the only destructive action; it touches only the named VM. The base snapshot is never
# deleted; the only snapshots ever deleted are earlier "aib-stage: ..." ones, when --save-stages replaces them.
# Runs as ONE blocking command (guest polling is internal); it exits when the summary and RESULT are printed.
#
# Stage snapshots (runs need not always start from the base):
#   --save-stages        after a stage completes OK, snapshot the VM as "aib-stage: <stage>" (replacing an
#                        earlier one of that name): prereqs (apt, user, and with --postgres docker + the
#                        pgvector/pgvector:pg17 image), aibroker (install + setup), pai (PAI install + setup)
#   --start-at <stage>   prereqs|aibroker|pai: revert to that stage snapshot instead of the base and skip the
#                        steps it contains (SKIP (stage)). Missing stage -> error naming --save-stages.
#                        If the packed tarball's sha256 differs from the one the stage was saved with
#                        (recorded with the snapshot ids in $AIBROKER_VM_SHARE_HOST/stages.json), that
#                        component is reinstalled and the run says so. pai needs --pai; --postgres must
#                        match the stage.
# A step whose CLI verb is missing from the packed build reports SKIP, not FAIL.
set -u
cd "$(dirname "$0")/../.."
REPO="$PWD"

KEEP=0; REBOOT=0; ADAPTERS=0; PAI_TGZ=""; POSTGRES=0; REAL=0; SAVE=0; START_AT=""; START_RANK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1 ;; --reboot) REBOOT=1 ;; --adapters) ADAPTERS=1 ;;
    --pai) shift; PAI_TGZ="${1:-}"; [ -f "$PAI_TGZ" ] || { echo "--pai needs a tarball path"; exit 2; } ;;
    --postgres) POSTGRES=1 ;; --real-claude) REAL=1 ;; --save-stages) SAVE=1 ;;
    --start-at) shift; START_AT="${1:-}"
      case "$START_AT" in prereqs) START_RANK=1 ;; aibroker) START_RANK=2 ;; pai) START_RANK=3 ;;
        *) echo "--start-at needs prereqs|aibroker|pai"; exit 2 ;; esac ;;
    *) echo "unknown flag: $1 (--keep --reboot --adapters --pai <tgz> --postgres --real-claude --save-stages --start-at <stage>)"; exit 2 ;;
  esac
  shift
done
[ $POSTGRES = 1 ] && [ -z "$PAI_TGZ" ] && { echo "--postgres needs --pai"; exit 2; }
[ $REAL = 1 ] && [ -z "$PAI_TGZ" ] && { echo "--real-claude needs --pai"; exit 2; }
[ "$START_AT" = pai ] && [ -z "$PAI_TGZ" ] && { echo "--start-at pai needs --pai"; exit 2; }
[ $REAL = 1 ] && [ -z "${AIBROKER_VM_USER:-}" ] && { echo "--real-claude needs AIBROKER_VM_USER (the logged-in user)"; exit 2; }
for v in AIBROKER_VM_NAME AIBROKER_VM_SNAPSHOT AIBROKER_VM_SHARE_HOST AIBROKER_VM_SHARE_GUEST; do
  [ -n "${!v:-}" ] || { echo "refusing to run: $v is not set"; exit 2; }
done
VM="$AIBROKER_VM_NAME"; SNAP="$AIBROKER_VM_SNAPSHOT"
PRLCTL="${PRLCTL:-$(command -v prlctl || echo /usr/local/bin/prlctl)}"
[ -x "$PRLCTL" ] || { echo "prlctl not found"; exit 2; }
U="${AIBROKER_VM_USER:-aibtest}"; OWN=0; [ -n "${AIBROKER_VM_USER:-}" ] && OWN=1
# With an existing user the stand-in claude must not overwrite the real one: it lives in its own dir.
STANDIN_DIR='$HOME/.local/share/aibroker-vm-standin'
TS=$(date +%Y%m%d-%H%M%S)
RES="$AIBROKER_VM_SHARE_HOST/results/$TS"
RUN_H="$AIBROKER_VM_SHARE_HOST/run-$TS"; RUN_G="$AIBROKER_VM_SHARE_GUEST/run-$TS"
mkdir -p "$RES" "$RUN_H"; chmod 755 "$AIBROKER_VM_SHARE_HOST" "$RUN_H"

STAGES="$AIBROKER_VM_SHARE_HOST/stages.json"
stage_get() {  # $1 = stage, $2 = field
  node -e 'try{const v=(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]]||{})[process.argv[3]];if(v!==undefined)console.log(v)}catch{}' "$STAGES" "$1" "$2"
}
stage_put() {  # $1 = stage, then field=value pairs
  node -e 'const fs=require("fs"),f=process.argv[1];let j={};try{j=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
    const [,,st,...kv]=process.argv;j[st]={};for(const p of kv){const i=p.indexOf("=");j[st][p.slice(0,i)]=p.slice(i+1)}
    fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$STAGES" "$@"
}
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
SUMMARY=(); FAILED=0; SKIP=""; CN=0
prl() { "$PRLCTL" "$@"; }
# prlctl exec sometimes fails to read a job result ("PrlJob_Get...: Invalid argument", ~3% of calls); rerun then.
# Guest commands are therefore written to be safe to run twice.
pexec() {
  local out rc n
  for n in 1 2 3 4; do
    out=$(prl exec "$VM" "$1" 2>&1); rc=$?
    printf '%s' "$out" | grep -q 'PrlJob_.*Invalid argument' || break
    sleep 2
  done
  [ -n "$out" ] && printf '%s\n' "$out"; return $rc
}
gr() { pexec "$1"; }   # root in the guest; one command string
# As the test user: the snippet goes through a file on the shared folder, so no quoting layers.
user_script() {  # $1 = file name in the share, $2 = body
  {
    echo 'export XDG_RUNTIME_DIR=/run/user/$(id -u) PATH=$HOME/.local/bin:$PATH TERM=xterm-256color LANG=C.UTF-8 STANDIN_LOG=/tmp/standin-received.txt'
    echo 'export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus; unset TMUX'
    echo "$2"
  } > "$RUN_H/$1"; chmod 644 "$RUN_H/$1"
}
gu() {
  CN=$((CN + 1)); local f="cmd-$CN.sh"
  user_script "$f" "$1"
  pexec "runuser -l $U -c 'bash $RUN_G/$f'"
}
# Long guest step (prlctl drops long jobs): runs detached under nohup, the host polls the exit-code file
# on the shared folder. $1 = user|root, $2 = name, $3 = max seconds, $4 = body. Prints the log.
detached() {
  local who=$1 name=$2 max=$3 body=$4 f="det-$2.sh" i rc
  rm -f "$RUN_H/$name.rc" "$RUN_H/$name.log"
  if [ "$who" = user ]; then user_script "$f" "$body"; else printf '%s\n' "$body" > "$RUN_H/$f"; chmod 644 "$RUN_H/$f"; fi
  printf 'bash %s/%s > %s/%s.log 2>&1; echo $? > %s/%s.rc\n' "$RUN_G" "$f" "$RUN_G" "$name" "$RUN_G" "$name" > "$RUN_H/$name.run.sh"
  chmod 644 "$RUN_H/$name.run.sh"
  if [ "$who" = user ]; then pexec "runuser -l $U -c 'nohup setsid bash $RUN_G/$name.run.sh </dev/null >/dev/null 2>&1 &'"
  else pexec "nohup setsid bash $RUN_G/$name.run.sh </dev/null >/dev/null 2>&1 &"; fi >/dev/null
  for i in $(seq 1 $((max / 3))); do [ -s "$RUN_H/$name.rc" ] && break; sleep 3; done
  [ -f "$RUN_H/$name.log" ] && cat "$RUN_H/$name.log"
  [ -s "$RUN_H/$name.rc" ] || { echo "detached $name: no exit code after ${max}s"; return 1; }
  rc=$(cat "$RUN_H/$name.rc"); return "$rc"
}
wait_exec() {  # bounded wait for prlctl exec to answer
  local i; for i in $(seq 1 "${1:-90}"); do prl exec "$VM" true >/dev/null 2>&1 && return 0; sleep 2; done
  echo "guest never answered prlctl exec"; return 1
}
# poll a user-side condition for up to $2 seconds
until_user() { gu "for i in \$(seq 1 $2); do { $1; } >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1"; }
has_verb() { grep -qE "^ +$1( |\$)" "$RES/help.txt" 2>/dev/null; }
need_verb() { has_verb "$1" || { SKIP="verb missing: $1"; return 77; }; }

step() {
  local name=$1 t0=$SECONDS rc; shift; SKIP=""
  "$@" >"$RES/$name.out" 2>&1; rc=$?
  local t=$((SECONDS - t0)) r
  case $rc in 0) r=PASS ;; 77) r="SKIP ($SKIP)" ;; *) r=FAIL; FAILED=1 ;; esac
  SUMMARY+=("$(printf '%-20s %-5s %4ss  %s' "$name" "${r%% *}" "$t" "$SKIP")")
  echo "[$name] $r (${t}s)" | tee -a "$RES/steps.log"
  local w; while IFS= read -r w; do SUMMARY+=("  $w"); done < <(grep -h '^WARN' "$RES/$name.out" | sort -u)
  [ $rc != 0 ] && [ $rc != 77 ] && tail -n 15 "$RES/$name.out" | sed 's/^/    | /'
  return 0
}

# ---- steps -------------------------------------------------------------------------------
s_pack() {
  npm run build || return 1
  npm pack --pack-destination "$RUN_H" || return 1
  cp test/linux/claude "$RUN_H/claude"; cp templates/systemd/aibroker.service "$RUN_H/aibroker.service"
  chmod 755 "$RUN_H/claude"; chmod 644 "$RUN_H"/*.tgz "$RUN_H/aibroker.service"
  ls "$RUN_H"/aibroker-*.tgz
}
s_revert() {
  local id="$SNAP"
  [ -n "$START_AT" ] && { id=$(stage_get "$START_AT" id); echo "reverting to stage '$START_AT' ($id)"; }
  case "$id" in "{"*) ;; *) id=$(prl snapshot-list "$VM" -j | node -e '
    const j=JSON.parse(require("fs").readFileSync(0,"utf8")); const n=process.argv[1];
    for (const [k,v] of Object.entries(j)) if (v.name===n) { console.log(k); break; }' "$SNAP") ;; esac
  [ -n "$id" ] || { echo "snapshot '$SNAP' not found on $VM"; return 1; }
  prl status "$VM"
  prl stop "$VM" --kill || true
  prl snapshot-switch "$VM" --id "$id" || return 1
  prl status "$VM"
}
skip_stage() { SKIP="stage"; return 77; }
s_help() { gu 'aibroker help' | tee "$RES/help.txt"; }
snap_ids() {  # $1 = exact snapshot name -> ids, one per line
  prl snapshot-list "$VM" -j | node -e '
    const j=JSON.parse(require("fs").readFileSync(0,"utf8"));
    for (const [k,v] of Object.entries(j)) if (v.name===process.argv[1]) console.log(k)' "$1"
}
s_save_stage() {  # $1 = stage; replaces only an earlier "aib-stage: " snapshot of the same name
  local n="aib-stage: $1" id
  case "$n" in "aib-stage: "?*) ;; *) echo "refusing: '$n' is not an aib-stage name"; return 1 ;; esac
  for id in $(snap_ids "$n"); do echo "replacing old $n $id"; prl snapshot-delete "$VM" --id "$id" || return 1; done
  prl snapshot "$VM" -n "$n" -d "aibroker vm acceptance stage" || return 1
  id=$(snap_ids "$n" | head -1); [ -n "$id" ] || { echo "snapshot '$n' not found after creation"; return 1; }
  stage_put "$1" "id=$id" "name=$n" "tarballSha256=$TGZ_SHA" "paiSha256=${PAI_SHA:-}" "postgres=$POSTGRES"
  echo "saved $n $id"
}
save_stage() { [ $SAVE = 1 ] && [ $FAILED = 0 ] && step "save-$1" s_save_stage "$1"; return 0; }
s_start() {
  prl status "$VM" | grep -q running || prl start "$VM" || return 1
  wait_exec 90 || return 1
  gr 'uname -srm; . /etc/os-release; echo $PRETTY_NAME'
}
s_clean_baseline() {  # proves the revert: bare guest has none of the prerequisites
  local t; for t in node npm tmux ffmpeg; do
    if gr "command -v $t" >/dev/null 2>&1; then echo "$t already present: snapshot is not clean"; return 1; fi
    echo "$t absent"
  done
  gr 'node --version' 2>&1 && return 1
  echo "node --version fails, as expected"; return 0
}
s_prereqs() {  # exactly the apt line docs/linux.md gives
  local line; line=$(grep -m1 -oE 'apt(-get)? install [^#`]*[a-z]' docs/linux.md)
  [ -n "$line" ] || { echo "docs/linux.md has no apt line; using default"; line="apt install nodejs npm tmux ffmpeg"; }
  echo "doc line: sudo $line"
  detached root prereqs 900 "export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=600 update -qq && apt-get -o DPkg::Lock::Timeout=600 -y ${line#* }" || return 1
  gr 'node --version; npm --version; tmux -V; ffmpeg -version | head -1' || return 1
  gr 'test "$(node -p "process.versions.node.split(\".\")[0]")" -ge 22' || { echo "node < 22"; return 1; }
}
s_user() {
  if [ $OWN = 1 ]; then gr "id $U" || { echo "AIBROKER_VM_USER $U does not exist"; return 1; }
  else gr "id $U || useradd -m -s /bin/bash $U" || return 1; fi
  gr "loginctl enable-linger $U" || return 1
  until_user 'test -S $XDG_RUNTIME_DIR/bus' 30 || { echo "user manager not up"; return 1; }
  gr "loginctl show-user $U -p Linger"
}
s_install() {
  gu "cp $RUN_G/aibroker-*.tgz /tmp/aibroker.tgz && npm install -g --prefix ~/.local /tmp/aibroker.tgz" || return 1
  if [ $OWN = 1 ]; then  # keep the real claude; the stand-in is reached through AIBROKER_CLAUDE_BIN
    gu "mkdir -p $STANDIN_DIR && cp $RUN_G/claude $STANDIN_DIR/claude && chmod +x $STANDIN_DIR/claude; command -v aibroker claude; aibroker --version" || return 1
  else gu "cp $RUN_G/claude ~/.local/bin/claude && chmod +x ~/.local/bin/claude; command -v aibroker claude; aibroker --version" || return 1; fi
  gu 'aibroker help' > "$RES/help.txt" 2>&1; cat "$RES/help.txt"
}
s_setup() {
  need_verb setup || return 77
  gu 'aibroker setup'
}
s_service_fallback() {  # until `setup` exists: the manually proven unit install
  has_verb setup && { SKIP="setup installs the service"; return 77; }
  gu "cli=\$(readlink -f ~/.local/bin/aibroker); mkdir -p ~/.config/systemd/user
sed \"s|^ExecStart=.*|ExecStart=\$(command -v node) \$cli start|\" $RUN_G/aibroker.service > ~/.config/systemd/user/aibroker.service
grep ^ExecStart ~/.config/systemd/user/aibroker.service
systemctl --user daemon-reload && systemctl --user enable --now aibroker"
}
s_service_active() {
  until_user 'systemctl --user is-active aibroker && aibroker ping' 40 || { gu 'systemctl --user status aibroker --no-pager; journalctl --user -u aibroker --no-pager | tail -20'; return 1; }
  gu 'systemctl --user is-active aibroker; aibroker ping'
}
s_doctor() { need_verb doctor || return 77; gu 'aibroker doctor'; }
s_tmux() {
  gu 'tmux has-session -t work || tmux new-session -d -s work -x 200 -y 50; tmux list-sessions'
}
s_launch() {
  has_verb launch || { SKIP="verb missing: launch (dir mode)"; return 77; }
  local bin=""; [ $OWN = 1 ] && bin="AIBROKER_CLAUDE_BIN=$STANDIN_DIR/claude "
  gu "mkdir -p ~/src/myproject && ${bin}aibroker launch ~/src/myproject" || return 1
  until_user "tmux list-windows -a -F '#{window_name}' | grep -qx myproject" 20 || { gu 'tmux list-windows -a'; return 1; }
  until_user "tmux capture-pane -p -t \$(tmux list-panes -a -F '#{session_name}:#{window_name}' | grep ':myproject\$' | head -1) | grep -q '❯'" 20 || { echo "stand-in claude never drew its prompt"; return 1; }
  gu 'tmux list-windows -a'
}
s_sessions() {
  grep -q '^\[launch\] PASS' "$RES/steps.log" || { SKIP="launch did not run"; return 77; }
  gu 'aibroker sessions' | tee -a /dev/stderr | grep myproject | grep -q tmux
}
s_send() {
  need_verb send || return 77
  grep -q '^\[launch\] PASS' "$RES/steps.log" || { SKIP="launch did not run"; return 77; }
  gu 'aibroker send myproject "hello-from-vm"' || return 1
  until_user 'grep -qxF hello-from-vm $STANDIN_LOG' 20 || { gu 'cat $STANDIN_LOG'; return 1; }
}
s_status() {
  gu 'aibroker status 2>&1' | tee /dev/stderr | grep -qi degraded && { echo "status is degraded"; return 1; }
  gu 'aibroker status 2>&1 | grep -qi tmux' || { echo "status does not name transport tmux"; return 1; }
  gu 'journalctl --user -u aibroker --no-pager | grep -ci osascript | grep -qx 0' || { echo "osascript lines in journal"; return 1; }
}
s_aibp_label() {  # R6: the terminal plugin is labelled by transport, not terminal:iterm, on tmux hosts
  gu 'journalctl --user -u aibroker --no-pager | grep -m3 "terminal:"; ! journalctl --user -u aibroker --no-pager | grep -q "terminal:iterm"' || { echo "AIBP still registers terminal:iterm on Linux (R6)"; return 1; }
}
s_stop_start() {
  gu 'aibroker stop' || return 1
  until_user '! systemctl --user is-active aibroker && [ ! -S /tmp/aibroker.sock ]' 20 || { echo "still running after stop"; return 1; }
  gu 'systemctl --user start aibroker' || return 1
  until_user 'aibroker ping' 30 || { echo "not back after start"; return 1; }
  if has_verb restart; then
    local before; before=$(gu 'systemctl --user show aibroker -p MainPID --value')
    gu 'aibroker restart' || return 1
    until_user 'aibroker ping' 30 || { echo "not back after restart"; return 1; }
    [ "$(gu 'systemctl --user show aibroker -p MainPID --value')" != "$before" ] || { echo "restart kept the same pid"; return 1; }
  else
    echo "no restart verb; using systemctl"
    gu 'systemctl --user restart aibroker' && until_user 'aibroker ping' 30 || return 1
  fi
}
s_snapshot_restore() {
  grep -q '^\[launch\] PASS' "$RES/steps.log" || { SKIP="launch did not run"; return 77; }
  gu 'aibroker sessions snapshot' || return 1
  gu 'tmux kill-window -t myproject; tmux list-windows -a' || true
  gu 'aibroker sessions restore' || return 1
  until_user "tmux list-windows -a -F '#{window_name}' | grep -qx myproject" 30 || { gu 'tmux list-windows -a'; return 1; }
}
s_reboot() {
  [ $REBOOT = 1 ] || { SKIP="flag --reboot not given"; return 77; }
  prl restart "$VM" || return 1
  sleep 15; wait_exec 90 || return 1
  until_user 'systemctl --user is-active aibroker && aibroker ping' 90 || { gu 'systemctl --user status aibroker --no-pager'; return 1; }
  gu 'uptime -p; systemctl --user is-active aibroker; aibroker ping'
}
s_adapters() {
  [ $ADAPTERS = 1 ] || { SKIP="flag --adapters not given"; return 77; }
  [ -n "${AIBROKER_VM_ADAPTER_TGZ:-}" ] || { SKIP="AIBROKER_VM_ADAPTER_TGZ not set"; return 77; }
  local d t bin rc=0 found=0
  local IFS=:
  for d in $AIBROKER_VM_ADAPTER_TGZ; do
    for t in "$d"/whazaa-*.tgz "$d"/telex-*.tgz "$d"/tekmidian-telex-*.tgz; do
      [ -f "$t" ] || continue; found=1

      # Map tarball filename to bin name (whazaa, telex)
      case "$(basename "$t")" in
        whazaa-*) bin=whazaa ;;
        telex-*) bin=telex ;;
        tekmidian-telex-*) bin=telex ;;
        *) echo "unknown adapter: $t"; rc=1; continue ;;
      esac

      cp "$t" "$RUN_H/$bin.tgz"; chmod 644 "$RUN_H/$bin.tgz"
      gu "npm install -g --prefix ~/.local $RUN_G/$bin.tgz" || { rc=1; continue; }

      # Start watcher via service verb
      local start_out
      if [ "$bin" = "telex" ]; then
        start_out=$(gu "TELEGRAM_API_ID=1 TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef ~/.local/bin/$bin service start 2>&1") || {
          echo "$bin: service start failed"
          echo "$start_out"
          gu "journalctl --user -u $bin-watcher -n 30"
          rc=1; continue
        }
        # For telex, verify the unit contains Environment= lines for credentials
        if ! gu "grep -q '^Environment=.*TELEGRAM_API_ID' ~/.config/systemd/user/$bin-watcher.service && grep -q '^Environment=.*TELEGRAM_API_HASH' ~/.config/systemd/user/$bin-watcher.service"; then
          echo "$bin-watcher: unit missing Environment= lines for credentials"
          rc=1; continue
        fi
      else
        start_out=$(gu "~/.local/bin/$bin service start 2>&1") || {
          echo "$bin: service start failed"
          echo "$start_out"
          gu "journalctl --user -u $bin-watcher -n 30"
          rc=1; continue
        }
      fi

      # Wait for watcher to be active; clean exits (exit code 0) are acceptable (no credentials)
      local journal_tail exit_code log_mode status_line
      if ! until_user "systemctl --user is-active $bin-watcher" 30; then
        journal_tail=$(gu "journalctl --user -u $bin-watcher -n 30")
        exit_code=$(echo "$journal_tail" | grep -oP 'code=exited status=\K[0-9]+' | tail -1)
        if [ "$exit_code" = 0 ]; then
          status_line="exited(no credentials)"
        else
          status_line="exited(failed)"
          echo "$bin-watcher: failed to become active"
          rc=1; continue
        fi
        echo "$journal_tail"
      else
        status_line="active"
      fi

      # Verify log permissions
      log_mode=$(gu "stat -c %a ~/.local/state/$bin/watch.log")
      [ "$log_mode" = 600 ] || { echo "$bin: watch.log not 0600"; rc=1; }

      # Print summary line per adapter
      echo "$bin: unit installed, $status_line, log $log_mode"

      # Stop watcher cleanly
      gu "~/.local/bin/$bin service stop" || { echo "$bin: service stop failed"; rc=1; continue; }

      # Verify unit file is removed
      until_user "[ ! -f ~/.config/systemd/user/$bin-watcher.service ]" 30 || { echo "$bin-watcher: unit still present"; rc=1; continue; }
    done
  done
  [ $found = 1 ] || { SKIP="no adapter tarballs in AIBROKER_VM_ADAPTER_TGZ"; return 77; }
  return $rc
}
s_docker() {
  [ $POSTGRES = 1 ] || { SKIP="flag --postgres not given"; return 77; }
  detached root docker 1500 "export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=600 update -qq && apt-get -o DPkg::Lock::Timeout=600 -y install docker.io docker-compose-v2
usermod -aG docker $U && systemctl enable --now docker && docker pull pgvector/pgvector:pg17" || return 1
  gr 'docker --version; systemctl is-active docker; docker image inspect pgvector/pgvector:pg17 >/dev/null && echo pgvector image present'
}
s_pai_install() {
  [ -n "$PAI_TGZ" ] || { SKIP="flag --pai not given"; return 77; }
  cp "$PAI_TGZ" "$RUN_H/pai.tgz"; chmod 644 "$RUN_H/pai.tgz"
  detached user pai_install 600 "npm install -g --prefix ~/.local $RUN_G/pai.tgz; echo npm-rc=\$?; pai --version" || return 1
}
s_pai_setup() {
  [ -n "$PAI_TGZ" ] || { SKIP="flag --pai not given"; return 77; }
  local cmd='pai setup --yes --storage sqlite </dev/null'
  [ $POSTGRES = 1 ] && cmd='sg docker -c "PAI_PG_SHARED_BUFFERS=256MB pai setup --yes --storage postgres </dev/null"'
  detached user pai_setup 900 "$cmd" > "$RES/pai-setup.log" 2>&1; local rc=$?
  cat "$RES/pai-setup.log"
  [ $rc = 0 ] || { echo "pai setup rc=$rc"; return 1; }
  ! grep -qi 'not found' "$RES/pai-setup.log" || { echo "pai setup printed 'not found'"; return 1; }
  until_user 'systemctl --user is-active pai-daemon.service' 60 || { echo "pai-daemon not active"; gu 'systemctl --user status pai-daemon.service --no-pager'; return 1; }
  gu 'pai worker providers' | tee /dev/stderr | grep -qi 'workers are on' || { echo "providers: workers are not on"; return 1; }
  gu 'test -f ~/.claude/statusline-command.sh' || { echo "statusline-command.sh missing"; return 1; }
  gu 'node -e "const m=Object.keys(require(process.env.HOME+\"/.claude.json\").mcpServers||{}).map(k=>k.toLowerCase()); console.log(m); process.exit(m.includes(\"aibroker\")&&m.includes(\"pai\")?0:1)"' || { echo "mcpServers lacks aibroker and pai"; return 1; }
}
s_pai_postgres() {
  [ $POSTGRES = 1 ] || { SKIP="flag --postgres not given"; return 77; }
  gu 'sg docker -c "docker ps --filter name=pai-pgvector --format \"{{.Names}} {{.Status}}\""' | tee /dev/stderr | grep -q 'pai-pgvector.*(healthy)' || { echo "pai-pgvector not healthy"; return 1; }
  gu 'pai daemon status' | tee /dev/stderr | grep -q 'Daemon running' || { echo "daemon not running"; return 1; }
  local backend; backend=$(gu 'jq -r .storageBackend ~/.claude/pai/config.json') || { echo "failed to read storageBackend"; gu 'jq .storage ~/.claude/pai/config.json'; return 1; }
  [ "$backend" = "postgres" ] || { echo "storageBackend is $backend, not postgres"; gu 'jq .storage ~/.claude/pai/config.json'; return 1; }
  detached user pai_memory 600 'pai memory index --all && pai memory search aibroker' || return 1
}
s_real_claude() {
  [ $REAL = 1 ] || { SKIP="flag --real-claude not given"; return 77; }
  cp test/linux/task-prompt.txt "$RUN_H/task-prompt.txt"; chmod 644 "$RUN_H/task-prompt.txt"
  local body rc=0; body=$(cat test/linux/real-claude-guest.sh)
  detached user real_claude 900 "${body//@RUN_G@/$RUN_G}" || rc=$?
  cp "$RUN_H"/pane-*.txt "$RES/" 2>/dev/null
  return $rc
}
s_uninstall() {
  need_verb uninstall || return 77
  gu 'aibroker uninstall' || return 1
  gu '[ ! -e ~/.config/systemd/user/aibroker.service ] && [ -d ~/.aibroker ]' || { echo "unit still present or ~/.aibroker gone"; return 1; }
}
s_collect() {
  gu 'journalctl --user -u aibroker --no-pager' > "$RES/journal-aibroker.txt" 2>&1
  gu 'aibroker doctor' > "$RES/doctor.txt" 2>&1
  gu 'cat ~/.aibroker/*.log 2>/dev/null | tail -200' > "$RES/aibroker-logs.txt" 2>&1
  [ $OWN = 1 ] && gu "rm -rf $STANDIN_DIR"  # the only path this harness created in that user's home
  ls "$RES"
}

# ---- run ---------------------------------------------------------------------------------
T0=$SECONDS
echo "results: $RES"
if [ -n "$START_AT" ]; then  # fail before anything is touched
  sid=$(stage_get "$START_AT" id)
  { [ -n "$sid" ] && prl snapshot-list "$VM" -j | grep -qF "$sid"; } || { echo "no saved stage '$START_AT' (aib-stage: $START_AT) for $VM: run once with --save-stages first"; exit 2; }
  [ "$POSTGRES" = "$(stage_get "$START_AT" postgres)" ] || { echo "stage '$START_AT' was saved with a different --postgres setting"; exit 2; }
fi
step pack s_pack
[ $FAILED = 1 ] && { echo "build/pack failed; VM untouched"; exit 1; }
TGZ_SHA=$(sha "$(ls "$RUN_H"/aibroker-*.tgz | head -1)"); PAI_SHA=""; [ -n "$PAI_TGZ" ] && PAI_SHA=$(sha "$PAI_TGZ")
# What the chosen stage already contains, and whether the tarballs changed since it was saved.
DO_PRE=1; DO_AIB=1; DO_PAI=1
[ $START_RANK -ge 1 ] && DO_PRE=0
if [ $START_RANK -ge 2 ]; then
  DO_AIB=0
  if [ "$(stage_get "$START_AT" tarballSha256)" != "$TGZ_SHA" ]; then DO_AIB=1; echo "aibroker tarball differs from stage '$START_AT': reinstalling aibroker"; fi
fi
if [ $START_RANK -ge 3 ]; then
  DO_PAI=0
  if [ "$(stage_get pai paiSha256)" != "$PAI_SHA" ]; then DO_PAI=1; echo "PAI tarball differs from stage 'pai': reinstalling PAI"; fi
fi
maybe() { if [ "$1" = 1 ]; then shift; step "$@"; else step "$2" skip_stage; fi; }  # maybe <do> <name> <fn>
step revert s_revert
step start s_start
if [ $FAILED = 0 ]; then
  maybe $DO_PRE clean_baseline s_clean_baseline
  maybe $DO_PRE prereqs s_prereqs
  [ $FAILED = 0 ] && step user s_user
  [ $FAILED = 0 ] && maybe $DO_PRE docker s_docker
  [ $DO_PRE = 1 ] && save_stage prereqs
  [ $FAILED = 0 ] && maybe $DO_AIB install s_install
  [ $DO_AIB = 0 ] && step help s_help
  if [ $FAILED = 0 ]; then
    maybe $DO_AIB setup s_setup
    maybe $DO_AIB service_fallback s_service_fallback
    [ $DO_AIB = 1 ] && save_stage aibroker
    step service_active s_service_active
    step doctor s_doctor
    maybe $DO_PAI pai_install s_pai_install
    maybe $DO_PAI pai_setup s_pai_setup
    [ $DO_PAI = 1 ] && [ -n "$PAI_TGZ" ] && save_stage pai
    step tmux s_tmux
    step launch s_launch
    step sessions s_sessions
    step send s_send
    step status s_status
    step aibp_label s_aibp_label
    step stop_start s_stop_start
    step snapshot_restore s_snapshot_restore
    step reboot s_reboot
    step adapters s_adapters
    step pai_postgres s_pai_postgres
    step real_claude s_real_claude
    step uninstall s_uninstall
  fi
  step collect s_collect
fi
[ $KEEP = 1 ] || prl stop "$VM" >/dev/null 2>&1
rm -rf "$RUN_H"

echo; echo "== VM acceptance summary ($((SECONDS - T0))s, VM $([ $KEEP = 1 ] && echo left running || echo stopped)) =="
printf '%s\n' "${SUMMARY[@]}" | tee "$RES/summary.txt"
[ $FAILED = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
exit $FAILED
