# munin on a server

munin on a machine on your tailnet, with its agents working there too, and you checking in from your laptop or phone at `https://<machine>.<tailnet>.ts.net`.

```
your laptop, your phone ──tailnet──▶ tailscale serve (HTTPS, says who you are)
                                      ├─ /           tracker         127.0.0.1:7777   munin-tracker.service
                                      ├─ /runtime/api agent runtime  127.0.0.1:7779   munin-runtime.service
                                      └─ /mcp        tracker, for outside agents, with their tokens
munin-runtime ──docker exec──▶ a container per coder: its own folder, nothing else
```

Both services listen on 127.0.0.1 only, run as the `munin` user, and keep everything in `/var/lib/munin`. People get in through `tailscale serve`, and only the ones in `MUNIN_USERS`.

## Before

On a Mac, see [On a Mac](#on-a-mac) at the end. Otherwise, a Linux machine with systemd (Debian or Ubuntu, say) that has:

- **Tailscale**, up (`tailscale up`), with MagicDNS and HTTPS Certificates turned on for the tailnet, at [login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns). `tailscale serve` needs both: without HTTPS, it waits for someone to turn it on, so the installer checks first and stops if it's off.
- **Docker**, running. Each coder works in a container of its own.
- **Node 22.19 or later** and **uv**, installed system-wide (not under a home folder, which the services can't read), and **git** and **curl**.

## Install

```bash
sudo git clone <munin's repository> /opt/munin
sudo /opt/munin/deploy/install.sh
```

It makes the `munin` user (in the `docker` group), installs both services' dependencies, writes the settings, pulls the coders' image, starts `munin-tracker` and `munin-runtime`, and sets up `tailscale serve`. It ends with munin's address, once `tailscale serve status` shows munin's two paths. If the machine is tagged in Tailscale, or munin is for someone other than the machine's owner, say who may use it: `sudo MUNIN_USERS=you@example.com /opt/munin/deploy/install.sh`.

Then:

- **Models:** in munin, Settings → Models and providers → Paste key, with a key from [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys). The runtime asks OpenRouter whether it works, keeps it in `/var/lib/munin/keys.json` (only the `munin` user can read it), and uses it at once; it never shows it again, and coders' containers don't see that file. `OPENROUTER_API_KEY` in `/etc/munin/secrets` works too, and a pasted key wins over it.
- **A project:** `sudo munin project add MUN munin --description "What it is, and how work gets delivered"`. `sudo munin …` is the tracker's command line, as the munin user with munin's settings.
- **Its code:** in munin, Settings → Code. The source has to be reachable by the `munin` user: a public URL, a URL with credentials the munin user has (an SSH key in `/var/lib/munin/.ssh`), or a folder it can read.
- **Agents that push:** put a token in `/etc/munin/secrets` (`GH_TOKEN=…`), add `MUNIN_AGENT_ENV=GH_TOKEN` to `/etc/munin/environment`, and say in the project's brief how to push with it.
- **Outside agents:** `sudo munin agent add claude-code` prints the command for Claude Code on your laptop, with munin's public address.
- **Coders' tools:** the default image, `buildpack-deps:bookworm-scm`, has git and little else. Build one with your projects' tools and set `MUNIN_AGENT_IMAGE`.

## Update

```bash
cd /opt/munin && sudo git pull && sudo deploy/install.sh
```

It keeps `/etc/munin/environment` and `/etc/munin/secrets` as they are.

## Where things are

| | |
|---|---|
| Settings | `/etc/munin/environment` (both services), `/etc/munin/secrets` (the runtime only, root-only file) |
| Data | `/var/lib/munin`: `munin.db` (the tracker), `runtime.sqlite` (the agents), `keys.json` (model keys pasted in Settings), `agents/` (their folders, clones and worktrees), `repos/` (munin's clones) |
| Services | `systemctl status munin-tracker munin-runtime`; logs: `journalctl -u munin-tracker -u munin-runtime -f` |
| Edge | `tailscale serve status` |
| Coders' containers | `docker ps --filter label=munin.agent` |

To back up, copy `/var/lib/munin` with the services stopped, or the two databases with `sqlite3 <file> ".backup <copy>"`.

## Who gets in

- **People:** `tailscale serve` removes any `Tailscale-User-Login` header the caller sent and sets it from who's actually calling, so the tracker and the runtime trust it on requests that came through it. Requests to munin's public name are let in only for the logins in `MUNIN_USERS`; everyone else gets a 403, and so do tagged devices, which carry no identity. Tailscale's ACLs decide who can reach the machine at all. The square at the top right shows who's looking, by the name Tailscale has for them; comments still go out under `MUNIN_USER`.
- **Agents:** `/mcp` takes an agent token instead, from wherever the agent runs. munin's own coders call it from the runtime, on this machine (`MUNIN_TRACKER_MCP`).
- **Coders' containers** see their own folder, with their own clones, and run as the `munin` user's id. Each sits behind a small firewall container that blocks this machine and the tailnet but not the internet, so a coder can't reach munin's web API (not on 127.0.0.1, its gateway, or this machine's tailnet address, where `tailscale serve` would say the caller is the machine's owner), its databases or its keys. The firewall container needs the internet once, to fetch `alpine:3.20` and `iptables`.
- **This machine:** anything running on it outside the containers, as root or as `munin`, can still do anything munin can.

## How this was tested

Without a real server: `install.sh` ran as root in a Debian container with Docker, with stand-ins for `systemctl` (starting each unit's `ExecStart` as its `User`, with its environment files) and for `tailscale` (a made-up tailnet name and owner; also with HTTPS off, and with a `serve` that sets nothing up, where the installer stopped and said why). A stand-in for `tailscale serve` that does what its source does (HTTPS in front, the mount path stripped and the rest joined to the target's path, the browser's Host kept, identity headers replaced) put munin at `https://munin-test.tail1234.ts.net` for Chromium:

- you made a coder there, it got its tracker token through the edge, and it talked to you;
- a stranger got a 403, even with your login forged in the header;
- a coder's command ran in its container as the `munin` user, and couldn't see munin's databases or keys.

The first real run found that `tailscale serve` sits waiting when the tailnet's HTTPS certificates are off, with its message hidden by the installer; the installer now checks for them first, and shows what Serve says. Real runs will tell the rest: systemd's sandboxing options, and your distribution's packages.

## Remove

```bash
sudo tailscale serve --bg --set-path /runtime/api off   # munin's two paths only; anything else stays
sudo tailscale serve --bg --set-path / off
sudo systemctl disable --now munin-tracker munin-runtime
sudo rm /etc/systemd/system/munin-*.service /usr/local/bin/munin
docker ps -aq --filter label=munin.agent | xargs -r docker rm -f
# and, to drop the data too: sudo rm -r /var/lib/munin /etc/munin; sudo userdel munin
```

## On a Mac

For a Mac that stays on, a Mac mini say, `deploy/install-mac.sh` does the same on macOS:

```bash
git clone <munin's repository> ~/munin
~/munin/deploy/install-mac.sh
```

It needs Tailscale (the app, signed in, with MagicDNS and HTTPS Certificates on for the tailnet, as above), Docker Desktop or OrbStack (running, and set to start when you sign in), and Node 22.19 or later, uv and git (`brew install node uv git`). Run it as yourself, in a session where you're signed in to the Mac, not with sudo. How it differs from Linux:

- **It runs as you.** Docker Desktop and OrbStack belong to the signed-in user, and coders need Docker, so the tracker and the runtime are launchd agents of yours (`~/Library/LaunchAgents/munin.tracker.plist` and `munin.runtime.plist`) rather than services of their own user. They restart when they stop, and start when you sign in: turn on automatic login for a Mac that runs on its own.
- **Everything is in `~/.munin`:** settings in `environment`, keys in `secrets` (and model keys pasted in Settings in `keys.json`), the databases, the agents' folders and clones, logs in `logs/`, and the command line as `~/.munin/bin/munin`. Restart a service with `launchctl kickstart -k gui/$(id -u)/munin.runtime`.
- **The Mac mustn't sleep.** The script says so if it would: System Settings > Energy, or `sudo pmset -a sleep 0`.
- **Docker Desktop opens a way to the Mac.** Checked on Docker Desktop 4.95: a container reaches the Mac's own 127.0.0.1 through `host.docker.internal`, and munin sees those requests as coming from 127.0.0.1, so `curl -H 'Host: 127.0.0.1:7777' http://host.docker.internal:7777/api/me` got in as you. A container also reached munin through the Mac's tailnet address, where `tailscale serve` named the caller as the Mac's owner. The firewall container in front of each coder's container (above) blocks both, and was checked to: munin by name, by IP and over the tailnet are refused, the internet still works, and a container sharing its network can't change the rules even as root. OrbStack hasn't been checked, but the firewall doesn't depend on which one runs. `MUNIN_AGENT_NETWORK=none` in `~/.munin/environment` takes the internet away too.

It was rehearsed on Linux, as a normal user, with stand-ins for `uname`, `launchctl` (starting each plist's command with only the plist's environment), `tailscale` and `pmset`. Three runs: the first stopped where the image couldn't be pulled (Docker Hub's rate limit; now a copy already there is enough), the second set munin up, the third updated it in place. It hasn't run on a real Mac yet.

To remove it:

```bash
launchctl bootout gui/$(id -u)/munin.tracker; launchctl bootout gui/$(id -u)/munin.runtime
rm ~/Library/LaunchAgents/munin.*.plist
tailscale serve --bg --set-path /runtime/api off; tailscale serve --bg --set-path / off
docker ps -aq --filter label=munin.agent | xargs docker rm -f
# and, to drop the data too: rm -r ~/.munin
```

## Notifications on your phone

Turn on notifications under Settings → Notifications on each device. They're push notifications, so they need munin over HTTPS, which `tailscale serve` gives it. On an iPhone, open munin in Safari, add it to the home screen (Share → Add to Home Screen), open it from there, and turn notifications on there. An agent's question, an approval it waits for, work ready for review and what your assistants say then reach the phone with munin closed.
