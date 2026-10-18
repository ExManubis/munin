"""What agents spent on issues, as they reported it."""

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from munin import issues as svc
from munin.issues import Actor, Invalid
from munin.models import Usage

MAX_COST_USD = 1000
MAX_TOKENS = 100_000_000


def report(
    s: Session,
    actor: Actor,
    ref: str,
    cost_usd: float,
    tokens_in: int | None = None,
    tokens_out: int | None = None,
    model: str | None = None,
) -> Usage:
    if actor.kind != "agent":
        raise Invalid("Only agents report usage.")
    issue = svc.get_issue(s, ref)
    if not 0 <= cost_usd <= MAX_COST_USD:
        raise Invalid(f"cost_usd must be between 0 and {MAX_COST_USD}, not {cost_usd}.")
    for tokens in (tokens_in, tokens_out):
        if tokens is not None and not 0 <= tokens <= MAX_TOKENS:
            raise Invalid(f"Token counts must be between 0 and {MAX_TOKENS:,}, not {tokens}.")
    row = Usage(
        issue_id=issue.id, agent=actor.name, cost_usd=cost_usd, tokens_in=tokens_in, tokens_out=tokens_out, model=model
    )
    s.add(row)
    s.commit()
    return row


def totals(s: Session, issue_ids: list[int]) -> dict[int, dict]:
    """Cost, tokens and cost per agent for each issue that has reports. Others are left out."""
    if not issue_ids:
        return {}
    tokens = func.coalesce(func.sum(func.coalesce(Usage.tokens_in, 0) + func.coalesce(Usage.tokens_out, 0)), 0)
    rows = s.execute(
        select(Usage.issue_id, Usage.agent, func.sum(Usage.cost_usd), tokens)
        .where(Usage.issue_id.in_(issue_ids))
        .group_by(Usage.issue_id, Usage.agent)
    )
    found: dict[int, dict] = {}
    for issue_id, agent, cost, used in rows:
        total = found.setdefault(issue_id, {"cost": 0.0, "tokens": 0, "agents": {}})
        total["cost"] += cost
        total["tokens"] += used
        total["agents"][agent] = cost
    return found
