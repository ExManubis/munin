"""A stand-in for an agent CLI: takes the top todo issue, comments and moves it to review."""

import os

import httpx2

URL, TOKEN = os.environ["MUNIN_URL"], os.environ["MUNIN_TOKEN"]
HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
}


def call(tool, **arguments):
    """The tool's text, and whether it was an error."""
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": arguments}}
    result = httpx2.post(URL, json=body, headers=HEADERS).json()["result"]
    return result["content"][0]["text"], result.get("isError", False)


pile = [line.split()[0] for line in call("list_issues", project="MUN", status="todo")[0].splitlines()]
issue = next(ref for ref in pile if not call("update_issue", issue=ref, status="in_progress")[1])
call("add_comment", issue=issue, body="Did the thing.\nDetails.")
call("update_issue", issue=issue, status="in_review")
print(f"Finished {issue}.")
