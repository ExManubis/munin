"""GitHub, as far as the tracker uses it: what a pull request is called and whether it's open,
merged or closed. A public repository answers without a token (60 requests an hour); a token,
kept in github.json next to the database and readable by the tracker's own user only, lifts that
and reaches private repositories."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.github.com"
PULL_URL = re.compile(r"^https://github\.com/([\w.-]+)/([\w.-]+)/pull/(\d+)(?:/[\w./-]*)?(?:[#?].*)?$")  # /files, #diff… too


class GitHubError(Exception):
    pass


def parse_pull_url(url: str) -> tuple[str, int, str]:
    """"https://github.com/owner/repo/pull/12" → ("owner/repo", 12, the clean URL)."""
    match = PULL_URL.match((url or "").strip())
    if not match:
        raise GitHubError("That isn't a pull request on GitHub. It looks like https://github.com/owner/repo/pull/12.")
    owner, name, number = match.groups()
    return f"{owner}/{name}", int(number), f"https://github.com/{owner}/{name}/pull/{number}"


class GitHub:
    def __init__(self, path: Path | None, api: str | None = None):
        self.path = path
        self.api = (api or os.environ.get("MUNIN_GITHUB_API") or API).rstrip("/")  # GitHub Enterprise, or a stand-in
        self.token: str | None = None
        if path and path.exists():
            self.token = json.loads(path.read_text()).get("token") or None

    def set_token(self, token: str | None) -> None:
        self.token = (token or "").strip() or None
        if not self.path:
            return
        temp = self.path.with_suffix(f".{os.getpid()}.tmp")
        temp.write_text(json.dumps({"token": self.token}) + "\n")
        temp.chmod(0o600)
        temp.replace(self.path)

    @property
    def hint(self) -> str | None:
        return self.token[-4:] if self.token else None

    def pull(self, repo: str, number: int) -> dict:
        """{"title", "state"}, state being "open", "merged" or "closed"."""
        request = urllib.request.Request(
            f"{self.api}/repos/{repo}/pulls/{number}",
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "munin",
                **({"Authorization": f"Bearer {self.token}"} if self.token else {}),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                body = json.loads(response.read())
        except urllib.error.HTTPError as error:
            if error.code == 404:
                raise GitHubError(f"GitHub has no pull request {repo}#{number}{'' if self.token else ', or it is private: add a token in Settings'}.") from error
            if error.code in (401, 403):
                raise GitHubError(f"GitHub refused ({error.code}): {'the token in Settings may be wrong or expired' if self.token else 'too many requests without a token; add one in Settings'}.") from error
            raise GitHubError(f"GitHub answered {error.code}.") from error
        except (urllib.error.URLError, TimeoutError) as error:
            raise GitHubError("Can't reach GitHub right now.") from error
        state = "merged" if body.get("merged_at") else body.get("state") or "open"
        return {"title": body.get("title"), "state": state}


POLL_SECONDS = float(os.environ.get("MUNIN_GITHUB_POLL", "120"))


def refresh(github: GitHub, sessions) -> int:
    """Ask GitHub about every linked pull request that may still change. Returns how many changed."""
    from munin import issues as svc
    from munin.models import Issue, utcnow

    changed = 0
    finished: dict[int, list] = {}  # issue id → its pull requests that closed without merging
    with sessions() as s:
        for pull in svc.pulls_to_check(s):
            try:
                found = github.pull(pull.repo, pull.number)
            except GitHubError:
                continue
            if (found["state"], found["title"]) != (pull.state, pull.title):
                if found["state"] in ("merged", "closed") and found["state"] != pull.state:
                    finished.setdefault(pull.issue_id, [])
                    if found["state"] == "closed":
                        finished[pull.issue_id].append(pull)
                pull.state, pull.title = found["state"], found["title"]
                changed += 1
            pull.checked_at = utcnow()
        s.commit()
        for issue_id, closed in finished.items():
            svc.settle_pull_requests(s, s.get(Issue, issue_id), closed)
    return changed


async def watch(github: GitHub, sessions) -> None:
    while True:
        await asyncio.to_thread(refresh, github, sessions)
        await asyncio.sleep(POLL_SECONDS)


@contextlib.asynccontextmanager
async def watching(github: GitHub, sessions):
    task = asyncio.create_task(watch(github, sessions))
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
