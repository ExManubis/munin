#!/usr/bin/env bash
# Puts munin on this server: the tracker as a systemd service, and tailscale serve in front, so
# munin is at https://<this machine's tailnet name> for the people you name and nobody else.
#
#   sudo git clone <munin's repository> /opt/munin
#   sudo /opt/munin/deploy/install.sh
#
# Run it again after pulling to update. It only touches munin's own things: the munin user,
# /var/lib/munin, /etc/munin, the munin-tracker service, /usr/local/bin/munin, and this machine's
# tailscale serve path /. Set MUNIN_USERS to say who may use munin, if it isn't you (the
# machine's Tailscale owner) or the machine is tagged.
set -euo pipefail

MUNIN_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DATA=/var/lib/munin
CONF=/etc/munin

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() {
  echo "munin: $*" >&2
  exit 1
}
need() { command -v "$1" > /dev/null 2>&1 || fail "this needs $1. $2"; }
setting() { sed -n "s/^$1=//p" "$CONF/environment" | tail -1; }

[ "$(id -u)" = 0 ] || fail "run this as root: sudo $0"
case "$MUNIN_DIR" in
  /home/* | /root/*) fail "munin's services can't read $MUNIN_DIR. Put the checkout somewhere like /opt/munin." ;;
esac
need git "On Debian or Ubuntu: apt install git"
need curl "On Debian or Ubuntu: apt install curl"
need node "https://nodejs.org/en/download"
need uv "curl -LsSf https://astral.sh/uv/install.sh | sh, and put it on root's PATH."
need tailscale "https://tailscale.com/download, then: tailscale up"

# This machine on the tailnet: its name for munin's address, and its owner for MUNIN_USERS.
read -r HOST OWNER HTTPS < <(tailscale status --json | node -e '
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
[ -n "${HOST:-}" ] && [ "$HOST" != - ] || fail "Tailscale isn't up on this machine: tailscale up"
# Without HTTPS on, tailscale serve stops and waits for someone to turn it on.
[ "${HTTPS:-}" = yes ] || fail "Tailscale's HTTPS certificates aren't on for your tailnet, and tailscale serve needs them.
  Turn on MagicDNS and HTTPS Certificates at https://login.tailscale.com/admin/dns, then run this again."

say "The munin user and its folders"
id munin > /dev/null 2>&1 || useradd --system --user-group --home-dir "$DATA" --shell /usr/sbin/nologin munin
install -d -o munin -g munin -m 750 "$DATA"
install -d -m 755 "$CONF"

say "Dependencies"
# uv puts a Python here if this machine has no 3.13, where the munin user can read it.
export UV_PYTHON_INSTALL_DIR="$MUNIN_DIR/.python"
(cd "$MUNIN_DIR/tracker" && uv sync --frozen --no-dev --quiet)

say "Settings in $CONF"
if [ ! -f "$CONF/environment" ]; then
  USERS=${MUNIN_USERS:-}
  if [ -z "$USERS" ]; then
    [ "$OWNER" != - ] && [ "$OWNER" != tagged-devices ] \
      || fail "this machine is tagged, so say who may use munin: sudo MUNIN_USERS=you@example.com $0"
    USERS=$OWNER
  fi
  sed -e "s|@PUBLIC_URL@|https://$HOST|" -e "s|@USERS@|$USERS|" "$MUNIN_DIR/deploy/environment.example" > "$CONF/environment"
  chmod 644 "$CONF/environment"
  echo "Wrote $CONF/environment for $USERS."
else
  echo "Kept $CONF/environment."
fi
say "Services"
sed -e "s|@MUNIN_DIR@|$MUNIN_DIR|g" "$MUNIN_DIR/deploy/munin-tracker.service" > /etc/systemd/system/munin-tracker.service
sed -e "s|@MUNIN_DIR@|$MUNIN_DIR|g" "$MUNIN_DIR/deploy/munin" > /usr/local/bin/munin
chmod 755 /usr/local/bin/munin
systemctl daemon-reload
systemctl enable --quiet munin-tracker
systemctl restart munin-tracker

# munin's own agents moved out to figbots. A server set up before that still has their service:
# stop it and forget it, but leave their data in $DATA for figbots to take.
if [ -f /etc/systemd/system/munin-runtime.service ]; then
  say "munin's agents moved to figbots"
  systemctl disable --now --quiet munin-runtime || true
  rm -f /etc/systemd/system/munin-runtime.service
  systemctl daemon-reload
  tailscale serve --bg --set-path /runtime/api off > /dev/null 2>&1 || true
  echo "  Stopped munin-runtime. munin's agents are figbots now: https://github.com/ExManubis/figbots"
  echo "  Their data is still in $DATA; figbots' deploy/move-from-munin.sh takes it over."
fi

TRACKER=$(setting MUNIN_PORT)
url="http://127.0.0.1:${TRACKER:=7777}/api/me"
for _ in $(seq 30); do curl -fsS -o /dev/null "$url" 2> /dev/null && break || sleep 1; done
curl -fsS -o /dev/null "$url" || fail "$url doesn't answer. See: journalctl -u munin-tracker"

say "tailscale serve"
tailscale serve --bg --set-path / "http://127.0.0.1:$TRACKER"
# Serve can also stop without setting anything up, having said what's missing; check it took the path.
tailscale serve status --json | node -e '
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
  Settings: $CONF/environment, then: sudo systemctl restart munin-tracker
  A project: sudo munin project add MUN munin --description "What it is, and how work gets delivered"
  Logs: journalctl -u munin-tracker -f
EOF
