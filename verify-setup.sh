#!/usr/bin/env bash
# Pre-workshop laptop check. Run it from anywhere: ./verify-setup.sh
#
# Checks, in order, stopping at the first failure with a one-line fix:
#   node       Node >= 22.13
#   docker     Docker installed and the daemon running
#   compose    `docker compose` available
#   npm        `npm ci` installs the app's dependencies     (VERIFY_SKIP_NPM=1 skips)
#   build      `docker compose build` builds the image      (VERIFY_SKIP_BUILD=1 skips)
#   honeycomb  TLS to api.honeycomb.io:443, no API key  (VERIFY_SKIP_NET=1 skips)
# Prints PASS on the last line when everything is fine. It never switches git branches.
set -uo pipefail
cd "$(dirname "$0")" || exit 1

HONEYCOMB_HOST="api.honeycomb.io"

ok() { echo "ok $1"; }
skip() { echo "skip $1"; }
fail() {
  echo "FAIL $1"
  echo "  fix: $2"
  exit 1
}

# --- node: numeric compare of major.minor against 22.13 ------------------------------------------
node_version="$(node -p process.versions.node 2> /dev/null)" ||
  fail node "install Node 22 (e.g. nvm install 22 && nvm use 22; this repo's .nvmrc says 22.22.0)"
IFS=. read -r node_major node_minor _ <<< "$node_version"
if ! [[ "${node_major:-}" =~ ^[0-9]+$ && "${node_minor:-}" =~ ^[0-9]+$ ]]; then
  fail node "could not read the Node version ('$node_version'); install Node 22 (nvm install 22)"
fi
if ((node_major < 22 || (node_major == 22 && node_minor < 13))); then
  fail node "Node $node_version is too old; need 22.13 or newer: nvm install 22 && nvm use 22"
fi
echo "node $node_version"
ok node

# --- docker: CLI present and daemon answering -----------------------------------------------------
command -v docker > /dev/null 2>&1 ||
  fail docker "install Docker Desktop (https://docs.docker.com/get-docker/) and start it"
docker info > /dev/null 2>&1 ||
  fail docker "start Docker Desktop (the docker daemon is not running), then re-run this script"
docker_version="$(docker version --format '{{.Server.Version}}' 2> /dev/null)"
[ -n "$docker_version" ] || docker_version="$(docker --version 2> /dev/null | sed -E 's/^Docker version ([^,]+).*/\1/')"
echo "docker $docker_version"
ok docker

# --- compose: the v2 plugin (`docker compose`, not `docker-compose`) -----------------------------
docker compose version > /dev/null 2>&1 ||
  fail compose "update Docker Desktop (or install the docker compose plugin)"
ok compose

# --- npm: dependencies install from the lockfile ------------------------------------------------
if [ "${VERIFY_SKIP_NPM:-}" = "1" ]; then
  skip npm
else
  npm ci > /dev/null 2>&1 || fail npm "run 'npm ci' in this directory and read its error (often a proxy or registry setting)"
  ok npm
fi

# --- build: the image builds (pulls node:22.22.0-alpine the first time) -------------------------
if [ "${VERIFY_SKIP_BUILD:-}" = "1" ]; then
  skip build
else
  docker compose build > /dev/null 2>&1 || fail build "run 'docker compose build' here and read its error (often a pull blocked by a proxy)"
  ok build
fi

# --- honeycomb: can we open TLS to the US ingest endpoint? Any HTTP status means yes. -----------
honeycomb_reachable() {
  [ "${VERIFY_FAKE_NET_FAIL:-}" = "1" ] && return 1 # test hook
  if command -v curl > /dev/null 2>&1; then
    local code
    code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 15 "https://$HONEYCOMB_HOST/" 2> /dev/null)"
    [ -n "$code" ] && [ "$code" != "000" ] && return 0
  fi
  if command -v openssl > /dev/null 2>&1; then
    openssl s_client -connect "$HONEYCOMB_HOST:443" -servername "$HONEYCOMB_HOST" < /dev/null > /dev/null 2>&1 && return 0
  fi
  return 1
}
if [ "${VERIFY_SKIP_NET:-}" = "1" ]; then
  skip honeycomb
else
  honeycomb_reachable ||
    fail honeycomb "cannot reach https://$HONEYCOMB_HOST:443; check your network, proxy or VPN (it must allow outbound HTTPS to $HONEYCOMB_HOST)"
  ok honeycomb
fi

# --- branch note: informational only, never switches branches -----------------------------------
if [ "$(git rev-parse --abbrev-ref HEAD 2> /dev/null)" = "main" ]; then
  echo "You are on main; the workshop starts on checkpoint-0: npm run catchup -- 0"
fi

echo "PASS"
