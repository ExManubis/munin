# design

Exports of the designs in the Paper file "munin": the issue tracker (page "Issues v3") and munin's agents (page "Agents v1"). Each artboard has three files:

- `.png`: a 2× screenshot from Paper
- `.jsx`: Paper's JSX export with inline styles, wrapped in a component
- `.html`: the same markup as a standalone page you can open in a browser. Fonts load from Google Fonts.

The logo images point at the brand kit in `../brand/logo/treatments/` instead of Paper's asset host. The agents' Figbot faces point at `figbot/`, SVGs rendered from the Figbot model in figment-engineering.

### Issues v3

| Artboard | Files |
|---|---|
| 00 Foundations | [png](00-foundations.png) · [jsx](00-foundations.jsx) · [html](00-foundations.html) |
| 01 Inbox | [png](01-inbox.png) · [jsx](01-inbox.jsx) · [html](01-inbox.html) |
| 02 All issues | [png](02-all-issues.png) · [jsx](02-all-issues.jsx) · [html](02-all-issues.html) |
| 03 Issue (live run) | [png](03-issue-live-run.png) · [jsx](03-issue-live-run.jsx) · [html](03-issue-live-run.html) |
| 04 New issue | [png](04-new-issue.png) · [jsx](04-new-issue.jsx) · [html](04-new-issue.html) |
| 05 Settings · Agents & MCP | [png](05-settings-agents-mcp.png) · [jsx](05-settings-agents-mcp.jsx) · [html](05-settings-agents-mcp.html) |
| 06 Mobile inbox | [png](06-mobile-inbox.png) · [jsx](06-mobile-inbox.jsx) · [html](06-mobile-inbox.html) |
| 07 Type pairings | [png](07-type-pairings.png) · [jsx](07-type-pairings.jsx) · [html](07-type-pairings.html) |

### Agents v1

| Artboard | Files |
|---|---|
| 08 Agent foundations | [png](08-agent-foundations.png) · [jsx](08-agent-foundations.jsx) · [html](08-agent-foundations.html) |
| 09 Agents · hugin | [png](09-agents-hugin.png) · [jsx](09-agents-hugin.jsx) · [html](09-agents-hugin.html) |
| 10 Agents · forge | [png](10-agents-forge.png) · [jsx](10-agents-forge.jsx) · [html](10-agents-forge.html) |
| 11 Agent profile · hugin | [png](11-agent-profile.png) · [jsx](11-agent-profile.jsx) · [html](11-agent-profile.html) |
| 12 New agent | [png](12-new-agent.png) · [jsx](12-new-agent.jsx) · [html](12-new-agent.html) |
| 13 Tracker under the topbar | [png](13-tracker-topbar.png) · [jsx](13-tracker-topbar.jsx) · [html](13-tracker-topbar.html) |
| 14 Phone · agents | [png](14-mobile-agents.png) · [jsx](14-mobile-agents.jsx) · [html](14-mobile-agents.html) |
| 15 Phone · hugin | [png](15-mobile-conversation.png) · [jsx](15-mobile-conversation.jsx) · [html](15-mobile-conversation.html) |

These are snapshots. Paper is the source of truth, so re-export after changing the designs there.

`brief-agents.md` is the brief for page "Agents v1": munin's own agents, the topbar, and the tracker under it. Its last section lists what changed while designing.
