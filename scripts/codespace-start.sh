#!/usr/bin/env bash
# Codespace postStartCommand: make sure the app (scripts/dev.mjs) and the load generator
# (scripts/load.mjs) are running. Idempotent: run it as often as you like.
#
# For each of them:
#   pidfile holds a live pid -> send it SIGHUP (dev.mjs restarts its services and re-reads .env;
#                               load.mjs just carries on)          prints "app: restarted" / "load: restarted"
#   otherwise                 -> start it detached (setsid + nohup), logging to a file, and record
#                               its pid in the pidfile               prints "app: started" / "load: started"
#
#   app:  pidfile .dev.pid,  log .dev.log
#   load: pidfile .load.pid, log .load.log
# Pidfiles and logs live in the current directory (the workspace root in a Codespace).
#
# Env: CODESPACE_START_DRY_RUN=1  print what would happen; no signals, no processes, no files.
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN="${CODESPACE_START_DRY_RUN:-}"

# Prints the pid in pidfile $1 if it names a running process; fails otherwise (missing, garbage, stale).
live_pid() {
  local pidfile="$1" pid
  [ -f "$pidfile" ] || return 1
  pid="$(tr -d '[:space:]' < "$pidfile")"
  [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] || return 1
  kill -0 "$pid" 2> /dev/null || return 1
  echo "$pid"
}

# ensure <name> <pidfile> <logfile> <script> [ENV=value ...]
ensure() {
  local name="$1" pidfile="$2" logfile="$3" script="$4" pid
  shift 4
  if pid="$(live_pid "$pidfile")"; then
    [ "$DRY_RUN" = 1 ] || kill -HUP "$pid"
    echo "$name: restarted"
  else
    if [ "$DRY_RUN" != 1 ]; then
      # Detach fully: the devcontainer lifecycle runner tears down the hook's process group when the
      # hook exits, so nohup alone is not enough. setsid gives the process its own session (Linux;
      # macOS has no setsid, so fall back to plain nohup there).
      if command -v setsid >/dev/null 2>&1; then
        env "$@" setsid nohup node "$SCRIPTS_DIR/$script" >> "$logfile" 2>&1 < /dev/null &
      else
        env "$@" nohup node "$SCRIPTS_DIR/$script" >> "$logfile" 2>&1 < /dev/null &
      fi
      echo $! > "$pidfile"
    fi
    echo "$name: started"
  fi
}

# dev.mjs writes (and on exit removes) its own pidfile; point it at the same one.
ensure app .dev.pid .dev.log dev.mjs "DEV_PIDFILE=$PWD/.dev.pid"
ensure load .load.pid .load.log load.mjs
