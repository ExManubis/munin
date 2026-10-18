"""Updates: what munin is now (the version file its install script writes next to the database),
what's newer on GitHub's main, and asking for an update, which munin-update (Linux) or munin.update
(a Mac) carries out as their own job, since an update restarts munin."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path

CHECK_EVERY = 60 * 60  # seconds between looks at GitHub
_seen: dict = {"at": 0.0, "commit": None, "found": None}


def installed(data_dir: Path) -> dict | None:
    """{"commit", "repo"} from the install script, or None when munin wasn't installed by one."""
    try:
        return json.loads((data_dir / "version").read_text())
    except (OSError, ValueError):
        return None


def _newer(repo: str, commit: str, api: str, token: str | None) -> dict:
    """What main has that this commit doesn't: how many commits, and the releases among them."""
    request = urllib.request.Request(
        f"{api}/repos/{repo}/compare/{commit}...main",
        headers={"Accept": "application/vnd.github+json", **({"Authorization": f"Bearer {token}"} if token else {})},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        found = json.load(response)
    # A release is a merge of staging into main; its PR title says what's in it.
    releases = []
    for c in found.get("commits", []):
        lines = c["commit"]["message"].splitlines()
        if lines and lines[0].startswith("Merge pull request") and lines[0].endswith("/staging") and len(lines) > 2:
            releases.append(lines[2].strip().removeprefix("Release: "))
    return {"behind": found.get("ahead_by", 0), "releases": releases[::-1]}


def status(data_dir: Path, api: str, token: str | None) -> dict:
    """What Settings shows: the commit munin runs, whether it can update itself, and what's newer.
    GitHub is asked at most once an hour; if it can't be reached, nothing is newer."""
    mine = installed(data_dir)
    out = {"commit": None, "can_update": False, "behind": 0, "releases": []}
    if not mine or not mine.get("commit"):
        return out
    out.update(commit=mine["commit"][:7], can_update=True)
    if not mine.get("repo"):
        return out
    fresh = _seen["commit"] == mine["commit"] and time.monotonic() - _seen["at"] < CHECK_EVERY
    if not fresh:
        try:
            _seen["found"] = _newer(mine["repo"], mine["commit"], api, token)
        except (urllib.error.URLError, OSError, ValueError, KeyError):
            _seen["found"] = None
        _seen.update(at=time.monotonic(), commit=mine["commit"])
    if _seen["found"]:
        out.update(_seen["found"])
    return out


def request(data_dir: Path) -> None:
    """Ask for an update: the updater, watching for this file, takes it from here."""
    (data_dir / "update-requested").write_text(str(time.time()))
