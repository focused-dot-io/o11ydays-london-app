#!/usr/bin/env bash
# npm run catchup -- N: jump to workshop checkpoint N (one of 0 1 2 2-cut 3 4).
#
# 1. git fetch origin
# 2. If you have uncommitted changes (including new files), park them on a new branch
#    my-work-<YYYYMMDD-HHMMSS> so nothing is lost. Gitignored files (.env, your agent settings with
#    keys) are never committed and stay where they are.
# 3. git checkout -B checkpoint-N origin/checkpoint-N  (resets your local checkpoint-N to origin's)
# 4. If .dev.pid names a running app (the Codespace starts it detached), send it SIGHUP so it
#    restarts on the new code. Otherwise print a hint to restart npm run dev yourself.
#
# Works on the git repo of the current directory. Safe to run again.
set -euo pipefail

usage() {
  echo "usage: npm run catchup -- <checkpoint>   where <checkpoint> is one of: 0 1 2 2-cut 3 4" >&2
  exit 1
}

[ "$#" -eq 1 ] || usage
N="$1"
case "$N" in
  0 | 1 | 2 | 2-cut | 3 | 4) ;;
  *) usage ;;
esac
BRANCH="checkpoint-$N"

# Prints the pid in pidfile $1 if it names a running process; fails otherwise (missing, garbage, stale).
# Same check as scripts/codespace-start.sh.
live_pid() {
  local pidfile="$1" pid
  [ -f "$pidfile" ] || return 1
  pid="$(tr -d '[:space:]' < "$pidfile")"
  [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] || return 1
  kill -0 "$pid" 2> /dev/null || return 1
  echo "$pid"
}

git rev-parse --is-inside-work-tree > /dev/null 2>&1 || {
  echo "catchup: $(pwd) is not inside a git repository." >&2
  exit 1
}

git fetch origin

if ! git rev-parse --verify --quiet "refs/remotes/origin/$BRANCH" > /dev/null; then
  echo "catchup: origin/$BRANCH does not exist (after git fetch origin)." >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  PARK="my-work-$(date +%Y%m%d-%H%M%S)"
  git checkout -b "$PARK"
  git add -A
  git commit -m "Parked work before catch-up to $BRANCH"
  echo "Parked your uncommitted work on branch $PARK"
fi

git checkout -B "$BRANCH" "origin/$BRANCH"
echo "Now on $BRANCH"

if pid="$(live_pid "$(git rev-parse --show-toplevel)/.dev.pid")"; then
  kill -HUP "$pid"
  echo "app: restarted on $BRANCH"
else
  echo "Restart npm run dev to run $BRANCH (stop it and start it again)."
fi
