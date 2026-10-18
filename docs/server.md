# munin on a server

munin on a machine on your tailnet, with you checking in from your laptop or phone at `https://<machine>.<tailnet>.ts.net`. Agents connect to it over MCP from wherever they run.

```
your laptop, your phone ──tailnet──▶ tailscale serve (HTTPS, says who you are)
                                      └─ /   tracker   127.0.0.1:7777   munin-tracker.service
                                             (the web UI, /api, and /mcp for agents, with their tokens)
```

The tracker listens on 127.0.0.1 only, runs as the `munin` user, and keeps everything in `/var/lib/munin`. People get in through `tailscale serve`, and only the ones in `MUNIN_USERS`.

## Before

On a Mac, see [On a Mac](#on-a-mac) at the end. Otherwise, a Linux machine with systemd (Debian or Ubuntu, say) that has:

- **Tailscale**, up (`tailscale up`), with MagicDNS and HTTPS Certificates turned on for the tailnet, at [login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns). `tailscale serve` needs both: without HTTPS, it waits for someone to turn it on, so the installer checks first and stops if it's off.
- **uv**, installed system-wide (not under a home folder, which the service can't read), and **git**, **curl** and **node** (the installer reads Tailscale's status with it).

## Install

```bash
sudo git clone <munin's repository> /opt/munin
sudo /opt/munin/deploy/install.sh
```

It makes the `munin` user, installs the tracker's dependencies, writes the settings, starts `munin-tracker`, and sets up `tailscale serve`. It ends with munin's address, once `tailscale serve status` shows munin's path. If the machine is tagged in Tailscale, or munin is for someone other than the machine's owner, say who may use it: `sudo MUNIN_USERS=you@example.com /opt/munin/deploy/install.sh`.

Then:

- **A project:** `sudo munin project add MUN munin --description "What it is, and how work gets delivered"`. `sudo munin …` is the tracker's command line, as the munin user with munin's settings.
- **Outside agents:** `sudo munin agent add claude-code` prints the command for Claude Code on your laptop, with munin's public address.
## Update

```bash
cd /opt/munin && sudo git pull && sudo deploy/install.sh
```

It keeps `/etc/munin/environment` as it is.

**If this machine was set up before munin's agents moved to [figbots](https://github.com/ExManubis/figbots):** running the installer again stops and removes the old `munin-runtime` service and the `/runtime/api` path in `tailscale serve`. The agents' data stays in `/var/lib/munin` (`runtime.sqlite`, `agents/`, `repos/`, `keys.json`), for figbots' `deploy/move-from-munin.sh` to take over. A leftover `/etc/munin/secrets` isn't used anymore.

## Where things are

| | |
|---|---|
| Settings | `/etc/munin/environment` |
| Data | `/var/lib/munin/munin.db` |
| Service | `systemctl status munin-tracker`; logs: `journalctl -u munin-tracker -f` |
| Edge | `tailscale serve status` |

To back up, copy `/var/lib/munin` with the service stopped, or the database with `sqlite3 /var/lib/munin/munin.db ".backup <copy>"`.

## Who gets in

- **People:** `tailscale serve` removes any `Tailscale-User-Login` header the caller sent and sets it from who's actually calling, so the tracker trusts it on requests that came through it. Requests to munin's public name are let in only for the logins in `MUNIN_USERS`; everyone else gets a 403, and so do tagged devices, which carry no identity. Tailscale's ACLs decide who can reach the machine at all. The square at the top right shows who's looking, by the name Tailscale has for them; comments still go out under `MUNIN_USER`.
- **Agents:** `/mcp` takes an agent token instead, from wherever the agent runs.
- **This machine:** anything running on it as root or as `munin` can still do anything munin can. Run agents as another user.

## How this was tested

Without a real server: `install.sh` ran as root in a Debian container, with stand-ins for `systemctl` (starting the unit's `ExecStart` as its `User`, with its environment file) and for `tailscale` (a made-up tailnet name and owner; also with HTTPS off, and with a `serve` that sets nothing up, where the installer stopped and said why). A stand-in for `tailscale serve` that does what its source does (HTTPS in front, the mount path stripped, the browser's Host kept, identity headers replaced) put munin at `https://munin-test.tail1234.ts.net` for Chromium, where a stranger got a 403, even with your login forged in the header.

The first real run found that `tailscale serve` sits waiting when the tailnet's HTTPS certificates are off, with its message hidden by the installer; the installer now checks for them first, and shows what Serve says. Real runs will tell the rest: systemd's sandboxing options, and your distribution's packages.

## Remove

```bash
sudo tailscale serve --bg --set-path / off   # munin's path only; anything else stays
sudo systemctl disable --now munin-tracker
sudo rm /etc/systemd/system/munin-tracker.service /usr/local/bin/munin
# and, to drop the data too: sudo rm -r /var/lib/munin /etc/munin; sudo userdel munin
```

## On a Mac

For a Mac that stays on, a Mac mini say, `deploy/install-mac.sh` does the same on macOS:

```bash
git clone <munin's repository> ~/munin
~/munin/deploy/install-mac.sh
```

It needs Tailscale (the app, signed in, with MagicDNS and HTTPS Certificates on for the tailnet, as above), and node, uv and git (`brew install node uv git`). Run it as yourself, in a session where you're signed in to the Mac, not with sudo. How it differs from Linux:

- **It runs as you.** The tracker is a launchd agent of yours (`~/Library/LaunchAgents/munin.tracker.plist`) rather than a service of its own user. It restarts when it stops, and starts when you sign in: turn on automatic login for a Mac that runs on its own.
- **Everything is in `~/.munin`:** settings in `environment`, the database, logs in `logs/`, and the command line as `~/.munin/bin/munin`. Restart the service with `launchctl kickstart -k gui/$(id -u)/munin.tracker`.
- **The Mac mustn't sleep.** The script says so if it would: System Settings > Energy, or `sudo pmset -a sleep 0`.

It was rehearsed on Linux, as a normal user, with stand-ins for `uname`, `launchctl` (starting the plist's command with only the plist's environment), `tailscale` and `pmset`. It hasn't run on a real Mac yet.

If the Mac was set up before munin's agents moved to figbots, running `install-mac.sh` again stops and removes the old `munin.runtime` launchd agent and the `/runtime/api` path in `tailscale serve`. The agents' data stays in `~/.munin`, for figbots' `deploy/move-from-munin.sh`.

To remove it:

```bash
launchctl bootout gui/$(id -u)/munin.tracker
rm ~/Library/LaunchAgents/munin.tracker.plist
tailscale serve --bg --set-path / off
# and, to drop the data too: rm -r ~/.munin
```

## Notifications on your phone

Turn on notifications under Settings → Notifications on each device. They're push notifications, so they need munin over HTTPS, which `tailscale serve` gives it. On an iPhone, open munin in Safari, add it to the home screen (Share → Add to Home Screen), open it from there, and turn notifications on there. An agent's question and work ready for review reach the phone with munin closed.
