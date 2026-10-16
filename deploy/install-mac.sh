#!/bin/bash
# Puts munin on this Mac, for a Mac that stays on (a Mac mini, say): the tracker and the agent
# runtime as launchd agents of yours, each coder in a container of its own (Docker Desktop or
# OrbStack), and tailscale serve in front, so munin is at https://<this Mac's tailnet name> for
# the people you name and nobody else.
#
#   git clone <munin's repository> ~/munin
#   ~/munin/deploy/install-mac.sh
#
# Run it as yourself, not with sudo, and again after pulling to update. It only touches munin's
# own things: ~/.munin, ~/Library/LaunchAgents/munin.*.plist, and this Mac's tailscale serve
# paths / and /runtime/api. Set MUNIN_USERS to say who may use munin, if it isn't you.
#
# Written for macOS's own bash 3.2 and BSD tools.
set -euo pipefail

MUNIN_DIR=$(cd "$(dirname "$0")/.." && pwd)
HERE="$HOME/.munin"
AGENTS="$HOME/Library/LaunchAgents"
UID_NOW=$(id -u)

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() {
  echo "munin: $*" >&2
  exit 1
}
need() { command -v "$1" > /dev/null 2>&1 || fail "this needs $1. $2"; }
setting() { sed -n "s/^$1=//p" "$HERE/environment" | tail -1; }
# A template with @NAME@ filled in from NAME=value arguments; plists get their values XML-escaped.
render() {
  node -e '
    const fs = require("fs");
    const [file, ...pairs] = process.argv.slice(1);
    const xml = file.endsWith(".plist");
    const esc = (v) => (xml ? v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : v);
    let text = fs.readFileSync(file, "utf8");
    for (const pair of pairs) {
      const at = pair.indexOf("=");
      text = text.split(`@${pair.slice(0, at)}@`).join(esc(pair.slice(at + 1)));
    }
    process.stdout.write(text);
  ' "$@"
}

[ "$(uname -s)" = Darwin ] || fail "this is for macOS. On Linux, use deploy/install.sh."
[ "$UID_NOW" != 0 ] || fail "run this as yourself, not with sudo: munin's services run as you."
need git "xcode-select --install, or: brew install git"
need curl "It comes with macOS."
need node "Node 22.19 or later: brew install node"
need npm "It comes with Node."
need uv "brew install uv"
need docker "Docker Desktop (docker.com) or OrbStack (orbstack.dev)."
TAILSCALE=$(command -v tailscale || true)
if [ -z "$TAILSCALE" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale
fi
[ -n "$TAILSCALE" ] || fail "this needs Tailscale: https://tailscale.com/download, signed in."
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)' \
  || fail "this needs Node 22.19 or later; this is $(node --version)."
NODE=$(command -v node)
docker info > /dev/null 2>&1 || fail "Docker isn't running. Open Docker Desktop (or OrbStack), and set it to start when you sign in."

# This Mac on the tailnet: its name for munin's address, and its owner for MUNIN_USERS.
read -r HOST OWNER < <("$TAILSCALE" status --json | node -e '
  let text = "";
  process.stdin.on("data", (d) => { text += d; }).on("end", () => {
    const status = JSON.parse(text);
    const host = (status.Self?.DNSName || "").replace(/\.$/, "");
    const owner = status.User?.[status.Self?.UserID]?.LoginName || "";
    console.log(host || "-", owner || "-");
  });') || true
[ -n "${HOST:-}" ] && [ "$HOST" != - ] || fail "Tailscale isn't up on this Mac: open it and sign in."

say "Dependencies"
(cd "$MUNIN_DIR/tracker" && uv sync --frozen --no-dev --quiet)
(cd "$MUNIN_DIR/runtime" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

say "Settings in $HERE"
mkdir -p "$HERE/logs" "$HERE/bin"
chmod 700 "$HERE"
if [ ! -f "$HERE/environment" ]; then
  USERS=${MUNIN_USERS:-}
  if [ -z "$USERS" ]; then
    [ "$OWNER" != - ] && [ "$OWNER" != tagged-devices ] \
      || fail "this Mac is tagged, so say who may use munin: MUNIN_USERS=you@example.com $0"
    USERS=$OWNER
  fi
  render "$MUNIN_DIR/deploy/mac/environment.example" "PUBLIC_URL=https://$HOST" "USERS=$USERS" "HOME=$HOME" > "$HERE/environment"
  echo "Wrote $HERE/environment for $USERS."
else
  echo "Kept $HERE/environment."
fi
if [ ! -f "$HERE/secrets" ]; then
  (umask 077 && printf '%s\n' "# Keys for the runtime, one per line, like:" "# OPENROUTER_API_KEY=sk-or-..." "# GH_TOKEN=... (and MUNIN_AGENT_ENV=GH_TOKEN in environment)" > "$HERE/secrets")
fi

if [ "$(setting MUNIN_AGENT_SANDBOX)" = docker ]; then
  IMAGE=$(setting MUNIN_AGENT_IMAGE)
  say "The coders' image, ${IMAGE:=buildpack-deps:bookworm-scm}"
  # Up to date if Docker Hub lets us; the copy already here does otherwise (it rate-limits pulls).
  docker pull --quiet "$IMAGE" > /dev/null 2>&1 || docker image inspect "$IMAGE" > /dev/null 2>&1 \
    || fail "couldn't pull $IMAGE. Try: docker pull $IMAGE"
fi

say "Services"
# launchd starts them with almost no PATH, and the runtime needs docker and git.
SERVICE_PATH="$(dirname "$NODE"):$(dirname "$(command -v docker)"):$(dirname "$(command -v git)"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$AGENTS"
for name in tracker runtime; do
  plist="$AGENTS/munin.$name.plist"
  render "$MUNIN_DIR/deploy/mac/munin.$name.plist" "MUNIN_DIR=$MUNIN_DIR" "NODE=$NODE" "HOME=$HOME" "PATH=$SERVICE_PATH" > "$plist"
  launchctl bootout "gui/$UID_NOW/munin.$name" 2> /dev/null || true
  # bootout can take a moment to let go.
  for _ in 1 2 3 4 5 6 7 8 9 10; do launchctl bootstrap "gui/$UID_NOW" "$plist" 2> /dev/null && break || sleep 1; done
  launchctl print "gui/$UID_NOW/munin.$name" > /dev/null 2>&1 || fail "launchd didn't take $plist. Try: launchctl bootstrap gui/$UID_NOW $plist"
done
render "$MUNIN_DIR/deploy/mac/munin" "MUNIN_DIR=$MUNIN_DIR" "HOME=$HOME" > "$HERE/bin/munin"
chmod 755 "$HERE/bin/munin"

TRACKER=$(setting MUNIN_PORT)
RUNTIME=$(setting MUNIN_RUNTIME_PORT)
for url in "http://127.0.0.1:${TRACKER:=7777}/api/me" "http://127.0.0.1:${RUNTIME:=7779}/runtime/api/me"; do
  for _ in $(seq 30); do curl -fsS -o /dev/null "$url" 2> /dev/null && break || sleep 1; done
  curl -fsS -o /dev/null "$url" || fail "$url doesn't answer. See $HERE/logs/."
done

say "tailscale serve"
"$TAILSCALE" serve --bg --set-path / "http://127.0.0.1:$TRACKER" > /dev/null
# Only /runtime/api: the frontend's own files under /runtime/ come from the tracker, with the rest of it.
"$TAILSCALE" serve --bg --set-path /runtime/api "http://127.0.0.1:$RUNTIME/runtime/api" > /dev/null

say "munin is at https://$HOST"
cat << EOF
  For: $(setting MUNIN_USERS)
  Settings: $HERE/environment; keys like OPENROUTER_API_KEY in $HERE/secrets,
            then: launchctl kickstart -k gui/$UID_NOW/munin.runtime
  A project: $HERE/bin/munin project add MUN munin --description "What it is, and how work gets delivered"
  Logs: tail -f $HERE/logs/*.log
EOF

# A Mac that sleeps takes munin with it.
SLEEP=$(pmset -g 2> /dev/null | awk '$1 == "sleep" { print $2 }' | head -1)
if [ -n "$SLEEP" ] && [ "$SLEEP" != 0 ]; then
  say "This Mac sleeps after $SLEEP minutes, and munin with it"
  echo "  Keep it awake: System Settings > Energy (\"Prevent automatic sleeping\"), or: sudo pmset -a sleep 0"
fi
echo "  After a restart, munin starts when you sign in: turn on automatic login for a Mac that runs on its own."
