# munin on a server

munin on a machine on your tailnet, with its agents working there too, and you checking in from your laptop or phone at `https://<machine>.<tailnet>.ts.net`.

```
your laptop, your phone ──tailnet──▶ tailscale serve (HTTPS, says who you are)
                                      ├─ /           tracker         127.0.0.1:7777   munin-tracker.service
                                      ├─ /runtime/api agent runtime  127.0.0.1:7779   munin-runtime.service
                                      └─ /mcp        tracker, for outside agents, with their tokens
munin-runtime ──docker exec──▶ a container per coder: its folder and munin's clones, nothing else
```

Both services listen on 127.0.0.1 only, run as the `munin` user, and keep everything in `/var/lib/munin`. People get in through `tailscale serve`, and only the ones in `MUNIN_USERS`.

## Before

A Linux machine with systemd (Debian or Ubuntu, say) that has:

- **Tailscale**, up (`tailscale up`), with MagicDNS and HTTPS certificates turned on for the tailnet (in the admin console, under DNS). `tailscale serve` needs both.
- **Docker**, running. Each coder works in a container of its own.
- **Node 22.19 or later** and **uv**, installed system-wide (not under a home folder, which the services can't read), and **git** and **curl**.

## Install

```bash
sudo git clone <munin's repository> /opt/munin
sudo /opt/munin/deploy/install.sh
```

It makes the `munin` user (in the `docker` group), installs both services' dependencies, writes the settings, pulls the coders' image, starts `munin-tracker` and `munin-runtime`, and sets up `tailscale serve`. It ends with munin's address. If the machine is tagged in Tailscale, or munin is for someone other than the machine's owner, say who may use it: `sudo MUNIN_USERS=you@example.com /opt/munin/deploy/install.sh`.

Then:

- **Models:** put `OPENROUTER_API_KEY=…` in `/etc/munin/secrets` (only the runtime reads it) and `sudo systemctl restart munin-runtime`.
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
| Data | `/var/lib/munin`: `munin.db` (the tracker), `runtime.sqlite` (the agents), `agents/` (their folders and worktrees), `repos/` (munin's clones) |
| Services | `systemctl status munin-tracker munin-runtime`; logs: `journalctl -u munin-tracker -u munin-runtime -f` |
| Edge | `tailscale serve status` |
| Coders' containers | `docker ps --filter label=munin.agent` |

To back up, copy `/var/lib/munin` with the services stopped, or the two databases with `sqlite3 <file> ".backup <copy>"`.

## Who gets in

- **People:** `tailscale serve` removes any `Tailscale-User-Login` header the caller sent and sets it from who's actually calling, so the tracker and the runtime trust it on requests that came through it. Requests to munin's public name are let in only for the logins in `MUNIN_USERS`; everyone else gets a 403, and so do tagged devices, which carry no identity. Tailscale's ACLs decide who can reach the machine at all.
- **Agents:** `/mcp` takes an agent token instead, from wherever the agent runs. munin's own coders call it from the runtime, on this machine (`MUNIN_TRACKER_MCP`).
- **Coders' containers** see their own folder and munin's clones, run as the `munin` user's id, and can't reach this machine's 127.0.0.1, so they can't reach munin's web API, its databases or its keys.
- **This machine:** anything running on it outside the containers, as root or as `munin`, can still do anything munin can.

## How this was tested

Without a real server: `install.sh` ran as root in a Debian container with Docker, with stand-ins for `systemctl` (starting each unit's `ExecStart` as its `User`, with its environment files) and for `tailscale` (a made-up tailnet name and owner). A stand-in for `tailscale serve` that does what its source does (HTTPS in front, the mount path stripped and the rest joined to the target's path, the browser's Host kept, identity headers replaced) put munin at `https://munin-test.tail1234.ts.net` for Chromium:

- you made a coder there, it got its tracker token through the edge, and it talked to you;
- a stranger got a 403, even with your login forged in the header;
- a coder's command ran in its container as the `munin` user, and couldn't see munin's databases or keys.

The first real run will tell the rest: Tailscale's HTTPS certificates, systemd's sandboxing options, and your distribution's packages.

## Remove

```bash
sudo tailscale serve --bg --set-path /runtime/api off   # munin's two paths only; anything else stays
sudo tailscale serve --bg --set-path / off
sudo systemctl disable --now munin-tracker munin-runtime
sudo rm /etc/systemd/system/munin-*.service /usr/local/bin/munin
docker ps -aq --filter label=munin.agent | xargs -r docker rm -f
# and, to drop the data too: sudo rm -r /var/lib/munin /etc/munin; sudo userdel munin
```
