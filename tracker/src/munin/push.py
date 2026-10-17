"""Push notifications: what waits for you reaches your devices, even with munin closed.

The tracker has its own keys (VAPID) and the devices that asked for its pushes, in push.json
next to its database, readable by its own user only. It pushes an agent's question for you and
work an agent sends to review. The runtime pushes its own things with keys of its own, so the
two services stay apart; the frontend subscribes each device to both.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
from pathlib import Path
from threading import Lock
from typing import Any

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid02
from pywebpush import WebPushException, webpush
from sqlalchemy import func, select

from munin import issues as svc
from munin.models import Comment, Event

POLL_SECONDS = 2.0


class PushError(ValueError):
    pass


def _first_line(text: str, limit: int = 140) -> str:
    line = next((part.strip() for part in str(text).splitlines() if part.strip()), "")
    return line if len(line) <= limit else f"{line[: limit - 1]}…"


class Push:
    def __init__(self, path: Path, subject: str):
        self.path = path
        self.subject = subject  # who's sending, as push services want it: a mailto: or https: address
        self.lock = Lock()
        saved: dict[str, Any] = {}
        if path.exists():
            saved = json.loads(path.read_text())
        if saved.get("private"):
            self.vapid = Vapid02.from_pem(saved["private"].encode())
        else:
            self.vapid = Vapid02()
            self.vapid.generate_keys()
        self.devices: list[dict[str, Any]] = saved.get("devices", [])
        if not saved.get("private"):
            self._save()

    @property
    def key(self) -> str:
        """The public key a browser subscribes with (applicationServerKey)."""
        point = self.vapid.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        return base64.urlsafe_b64encode(point).rstrip(b"=").decode()

    def _save(self) -> None:
        private = self.vapid.private_pem().decode()
        temp = self.path.with_suffix(f".{os.getpid()}.tmp")
        temp.write_text(json.dumps({"private": private, "devices": self.devices}, indent=2) + "\n")
        temp.chmod(0o600)
        temp.replace(self.path)

    def subscribe(self, subscription: dict[str, Any]) -> None:
        endpoint = str(subscription.get("endpoint") or "")
        keys = subscription.get("keys") or {}
        if not endpoint.startswith("https://") or not keys.get("p256dh") or not keys.get("auth"):
            raise PushError("That isn't a push subscription from a browser.")
        with self.lock:
            self.devices = [d for d in self.devices if d["endpoint"] != endpoint]
            self.devices.append({"endpoint": endpoint, "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]}})
            self._save()

    def unsubscribe(self, endpoint: str) -> None:
        with self.lock:
            self.devices = [d for d in self.devices if d["endpoint"] != endpoint]
            self._save()

    def send(self, payload: dict[str, Any]) -> int:
        """Push to every device; a device its push service says is gone is forgotten. Returns how many got it."""
        sent, gone = 0, []
        for device in list(self.devices):
            try:
                webpush(
                    subscription_info=device,
                    data=json.dumps(payload),
                    vapid_private_key=self.vapid,
                    vapid_claims={"sub": self.subject},
                    ttl=24 * 60 * 60,
                    timeout=10,
                )
                sent += 1
            except WebPushException as error:
                if error.response is not None and error.response.status_code in (404, 410):
                    gone.append(device["endpoint"])
            except Exception:  # noqa: BLE001 - a push service that's down mustn't stop the others
                pass
        for endpoint in gone:
            self.unsubscribe(endpoint)
        return sent


def notice(session, event: Event) -> dict[str, Any] | None:
    """The push for an event, if it's one you'd want on your phone."""
    if event.kind == "comment" and event.new:
        comment = session.get(Comment, int(event.new))
        if comment and comment.asks_human and comment.author_kind == "agent":
            return {
                "title": f"{comment.author} asks about {event.issue.ref}",
                "body": _first_line(comment.body) or event.issue.title,
                "url": f"#/inbox/{comment.id}",
                "tag": f"tracker-question-{comment.id}",
            }
    if event.kind == "status" and event.new == "in_review" and event.actor_kind == "agent":
        return {
            "title": f"{event.issue.ref} is ready for review",
            "body": f"{event.actor}: {event.issue.title}",
            "url": f"#/issues/{event.issue.ref}",
            "tag": f"tracker-review-{event.issue.ref}",
        }
    return None


async def watch(push: Push, sessions, changes) -> None:
    """Follow the tracker's events from now on and push the ones that wait for you."""

    def newest() -> int:
        with sessions() as s:
            return s.scalar(select(func.max(Event.id))) or 0

    def notices(after: int) -> tuple[int, list[dict[str, Any]]]:
        with sessions() as s:
            events = svc.events_after(s, after, 200)
            return (events[-1].id if events else after), [n for n in (notice(s, e) for e in events) if n]

    last = await asyncio.to_thread(newest)
    seen = changes.revision
    while True:
        await asyncio.sleep(POLL_SECONDS)
        if changes.revision == seen or not push.devices:
            seen = changes.revision
            if not push.devices:
                last = await asyncio.to_thread(newest)  # nobody to tell: what happens now isn't owed later
            continue
        seen = changes.revision
        last, found = await asyncio.to_thread(notices, last)
        for payload in found:
            await asyncio.to_thread(push.send, payload)


@contextlib.asynccontextmanager
async def watching(push: Push, sessions, changes):
    task = asyncio.create_task(watch(push, sessions, changes))
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
