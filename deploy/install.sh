#!/usr/bin/env bash
# Puts munin on this server: the tracker and the agent runtime as systemd services, each coder in a
# container of its own, and tailscale serve in front, so munin is at https://<this machine's
# tailnet name> for the people you name and nobody else.
#
#   sudo git clone <munin's repository> /opt/munin
#   sudo /opt/munin/deploy/install.sh
#
# Run it again after pulling to update. It only touches munin's own things: the munin user,
# /var/lib/munin, /etc/munin, the munin-tracker and munin-runtime services, /usr/local/bin/munin,
# and this machine's tailscale serve paths / and /runtime/api. Set MUNIN_USERS to say who may use
# munin, if it isn't you (the machine's Tailscale owner) or the machine is tagged.
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
need node "Node 22.19 or later: https://nodejs.org/en/download"
need npm "It comes with Node."
need uv "curl -LsSf https://astral.sh/uv/install.sh | sh, and put it on root's PATH."
need docker "https://docs.docker.com/engine/install/"
need tailscale "https://tailscale.com/download, then: tailscale up"
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)' \
  || fail "this needs Node 22.19 or later; this is $(node --version)."
NODE=$(command -v node)
case "$NODE" in
  /home/* | /root/*) fail "Node is in a home folder ($NODE), which munin's services can't read. Install it system-wide." ;;
esac
docker info > /dev/null 2>&1 || fail "Docker isn't running: systemctl start docker"

# This machine on the tailnet: its name for munin's address, and its owner for MUNIN_USERS.
read -r HOST OWNER < <(tailscale status --json | node -e '
  let text = "";
  process.stdin.on("data", (d) => { text += d; }).on("end", () => {
    const status = JSON.parse(text);
    const host = (status.Self?.DNSName || "").replace(/\.$/, "");
    const owner = status.User?.[status.Self?.UserID]?.LoginName || "";
    console.log(host || "-", owner || "-");
  });') || true
[ -n "${HOST:-}" ] && [ "$HOST" != - ] || fail "Tailscale isn't up on this machine: tailscale up"

say "The munin user and its folders"
id munin > /dev/null 2>&1 || useradd --system --user-group --home-dir "$DATA" --shell /usr/sbin/nologin munin
usermod -aG docker munin
install -d -o munin -g munin -m 750 "$DATA"
install -d -m 755 "$CONF"

say "Dependencies"
# uv puts a Python here if this machine has no 3.13, where the munin user can read it.
export UV_PYTHON_INSTALL_DIR="$MUNIN_DIR/.python"
(cd "$MUNIN_DIR/tracker" && uv sync --frozen --no-dev --quiet)
(cd "$MUNIN_DIR/runtime" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

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
if [ ! -f "$CONF/secrets" ]; then
  install -m 600 /dev/null "$CONF/secrets"
  printf '%s\n' "# Keys for the runtime, one per line, like:" "# OPENROUTER_API_KEY=sk-or-..." "# GH_TOKEN=... (and MUNIN_AGENT_ENV=GH_TOKEN in environment)" > "$CONF/secrets"
fi

if [ "$(setting MUNIN_AGENT_SANDBOX)" = docker ]; then
  IMAGE=$(setting MUNIN_AGENT_IMAGE)
  say "The coders' image, ${IMAGE:=buildpack-deps:bookworm-scm}"
  docker pull --quiet "$IMAGE" > /dev/null
fi

say "Services"
for unit in munin-tracker munin-runtime; do
  sed -e "s|@MUNIN_DIR@|$MUNIN_DIR|g" -e "s|@NODE@|$NODE|g" "$MUNIN_DIR/deploy/$unit.service" > "/etc/systemd/system/$unit.service"
done
sed -e "s|@MUNIN_DIR@|$MUNIN_DIR|g" "$MUNIN_DIR/deploy/munin" > /usr/local/bin/munin
chmod 755 /usr/local/bin/munin
systemctl daemon-reload
systemctl enable --quiet munin-tracker munin-runtime
systemctl restart munin-tracker munin-runtime

TRACKER=$(setting MUNIN_PORT)
RUNTIME=$(setting MUNIN_RUNTIME_PORT)
for url in "http://127.0.0.1:${TRACKER:=7777}/api/me" "http://127.0.0.1:${RUNTIME:=7779}/runtime/api/me"; do
  for _ in $(seq 30); do curl -fsS -o /dev/null "$url" 2> /dev/null && break || sleep 1; done
  curl -fsS -o /dev/null "$url" || fail "$url doesn't answer. See: journalctl -u munin-tracker -u munin-runtime"
done

say "tailscale serve"
tailscale serve --bg --set-path / "http://127.0.0.1:$TRACKER" > /dev/null
# Only /runtime/api: the frontend's own files under /runtime/ come from the tracker, with the rest of it.
tailscale serve --bg --set-path /runtime/api "http://127.0.0.1:$RUNTIME/runtime/api" > /dev/null

say "munin is at https://$HOST"
cat << EOF
  For: $(setting MUNIN_USERS)
  Settings: $CONF/environment; keys like OPENROUTER_API_KEY in $CONF/secrets,
            then: sudo systemctl restart munin-runtime
  A project: sudo munin project add MUN munin --description "What it is, and how work gets delivered"
  Logs: journalctl -u munin-tracker -u munin-runtime -f
EOF
