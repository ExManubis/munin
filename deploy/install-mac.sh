#!/bin/bash
# Puts munin on this Mac, for a Mac that stays on (a Mac mini, say): the tracker as a launchd
# agent of yours, and tailscale serve in front, so munin is at https://<this Mac's tailnet name>
# for the people you name and nobody else.
#
#   git clone <munin's repository> ~/munin
#   ~/munin/deploy/install-mac.sh
#
# Run it as yourself, not with sudo, and again after pulling to update. It only touches munin's
# own things: ~/.munin, ~/Library/LaunchAgents/munin.*.plist, and this Mac's tailscale serve
# path /. Set MUNIN_USERS to say who may use munin, if it isn't you.
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
# What munin is now, for Settings to tell when there's something newer on GitHub.
version_file() {
  repo=$(git -C "$MUNIN_DIR" remote get-url origin 2> /dev/null | sed -e 's#.*github\.com[:/]##' -e 's#\.git$##')
  printf '{"commit": "%s", "repo": "%s"}\n' "$(git -C "$MUNIN_DIR" rev-parse HEAD)" "$repo" > "$1"
}
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
need node "brew install node"
need uv "brew install uv"
TAILSCALE=$(command -v tailscale || true)
if [ -z "$TAILSCALE" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale
fi
[ -n "$TAILSCALE" ] || fail "this needs Tailscale: https://tailscale.com/download, signed in."

# This Mac on the tailnet: its name for munin's address, and its owner for MUNIN_USERS.
read -r HOST OWNER HTTPS < <("$TAILSCALE" status --json | node -e '
  let text = "";
  process.stdin.on("data", (d) => { text += d; }).on("end", () => {
    const status = JSON.parse(text);
    const host = (status.Self?.DNSName || "").replace(/\.$/, "");
    const owner = status.User?.[status.Self?.UserID]?.LoginName || "";
    // tailscale serve needs HTTPS certificates on for the tailnet: the "https" capability.
    const https = "https" in (status.Self?.CapMap || {}) || (status.Self?.Capabilities || []).includes("https")
      || (status.CertDomains || []).length > 0;
    console.log(host || "-", owner || "-", https ? "yes" : "no");
  });') || true
[ -n "${HOST:-}" ] && [ "$HOST" != - ] || fail "Tailscale isn't up on this Mac: open it and sign in."
# Without HTTPS on, tailscale serve stops and waits for someone to turn it on.
[ "${HTTPS:-}" = yes ] || fail "Tailscale's HTTPS certificates aren't on for your tailnet, and tailscale serve needs them.
  Turn on MagicDNS and HTTPS Certificates at https://login.tailscale.com/admin/dns, then run this again."

say "Dependencies"
(cd "$MUNIN_DIR/tracker" && uv sync --frozen --no-dev --quiet)

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
say "Services"
# launchd starts its jobs with almost no PATH; the updater runs this script, which needs git, node
# and uv. Node's own folder, not a version manager's per-shell link to it (fnm, nvm).
NODE_DIR=$(dirname "$(node -p process.execPath)")
SERVICE_PATH="$NODE_DIR:$(dirname "$(command -v uv)"):$(dirname "$(command -v git)"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$AGENTS"
plist="$AGENTS/munin.tracker.plist"
render "$MUNIN_DIR/deploy/mac/munin.tracker.plist" "MUNIN_DIR=$MUNIN_DIR" "HOME=$HOME" "PATH=$SERVICE_PATH" > "$plist"
launchctl bootout "gui/$UID_NOW/munin.tracker" 2> /dev/null || true
# bootout can take a moment to let go.
for _ in 1 2 3 4 5 6 7 8 9 10; do launchctl bootstrap "gui/$UID_NOW" "$plist" 2> /dev/null && break || sleep 1; done
launchctl print "gui/$UID_NOW/munin.tracker" > /dev/null 2>&1 || fail "launchd didn't take $plist. Try: launchctl bootstrap gui/$UID_NOW $plist"

# munin's own agents moved out to figbots. A Mac set up before that still has their service:
# stop it and forget it, but leave their data in ~/.munin for figbots to take.
if [ -f "$AGENTS/munin.runtime.plist" ]; then
  say "munin's agents moved to figbots"
  launchctl bootout "gui/$UID_NOW/munin.runtime" 2> /dev/null || true
  rm -f "$AGENTS/munin.runtime.plist"
  "$TAILSCALE" serve --bg --set-path /runtime/api off > /dev/null 2>&1 || true
  echo "  Stopped munin.runtime. munin's agents are figbots now: https://github.com/ExManubis/figbots"
  echo "  Their data is still in $HERE; figbots' deploy/move-from-munin.sh takes it over."
fi
render "$MUNIN_DIR/deploy/mac/munin" "MUNIN_DIR=$MUNIN_DIR" "HOME=$HOME" > "$HERE/bin/munin"
chmod 755 "$HERE/bin/munin"

# The update button in Settings: munin.update runs deploy/update.sh when munin asks for it. While
# an update runs inside it, it's left loaded: reloading it would stop the update halfway.
updater="$AGENTS/munin.update.plist"
render "$MUNIN_DIR/deploy/mac/munin.update.plist" "MUNIN_DIR=$MUNIN_DIR" "HOME=$HOME" "PATH=$SERVICE_PATH" > "$updater"
if [ -z "${MUNIN_UPDATING:-}" ]; then
  launchctl bootout "gui/$UID_NOW/munin.update" 2> /dev/null || true
  for _ in 1 2 3 4 5; do launchctl bootstrap "gui/$UID_NOW" "$updater" 2> /dev/null && break || sleep 1; done
fi
version_file "$HERE/version"

TRACKER=$(setting MUNIN_PORT)
url="http://127.0.0.1:${TRACKER:=7777}/api/me"
for _ in $(seq 30); do curl -fsS -o /dev/null "$url" 2> /dev/null && break || sleep 1; done
curl -fsS -o /dev/null "$url" || fail "$url doesn't answer. See $HERE/logs/."

say "tailscale serve"
"$TAILSCALE" serve --bg --set-path / "http://127.0.0.1:$TRACKER"
# Serve can also stop without setting anything up, having said what's missing; check it took the path.
"$TAILSCALE" serve status --json | node -e '
  let text = "";
  process.stdin.on("data", (d) => { text += d; }).on("end", () => {
    const config = JSON.parse(text || "{}");
    const paths = Object.values(config.Web || {}).flatMap((site) => Object.keys(site.Handlers || {}));
    process.exit(paths.includes("/") ? 0 : 1);
  });' || fail "tailscale serve didn't take munin's path. See: tailscale serve status"

say "munin is at https://$HOST"
cat << EOF
  For: $(setting MUNIN_USERS)
  Agents: connect them in munin, under Settings
  Settings: $HERE/environment, then: launchctl kickstart -k gui/$UID_NOW/munin.tracker
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
