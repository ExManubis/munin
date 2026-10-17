# Brief: Agents (Paper page "Agents v1")

For whoever builds these artboards in Paper, a person or Claude Code with the Paper plugin. Paper is the source of truth once they exist; this brief is the starting spec.

## Why

munin is one app with one frontend and several backend services (`docs/architecture.md`). So far the frontend is only the tracker. Next comes munin's own agents: they run on your server and you talk to them, in the spirit of Grok Bot and Hermes. Each agent has a role:

- **coders** take issues, write code and send it to review;
- **assistants** keep your calendar and mail in order;
- **writers and researchers** do what you'd expect;
- **companions** are just fun to talk to.

The app gets a topbar that switches between its parts: AGENTS and TRACKER. Each part has its own sidebar. The tracker's sidebar stays as it is.

The look borrows ideas from Grok Bot, not its style:

- a list of agents that tells you who needs you;
- one ongoing conversation per agent;
- what the agent did, as quiet lines between messages;
- questions as cards with options.

Everything is drawn in munin's design language: no bubbles, no rounded corners, and no colour except in the agents' faces.

## Before you start

1. Pull `main` of `ExManubis/munin`. Read `design/README.md`.
2. Open the Paper file "munin". Study page "Issues v3", especially:
   - 00 Foundations: the rules;
   - 01 Inbox: sidebar, list rows, YOUR MOVE;
   - 03 Issue (live run): run steps, thread, steer box, properties panel;
   - 05 Settings: tabs, toggle rows, tables;
   - 06 Mobile inbox: phone header, full-width answer, bottom bar.
3. Create a page "Agents v1". Copy components from "Issues v3" rather than redrawing them, so sizes and styles match exactly.

## Rules (from 00 Foundations, unchanged)

- **Colour.**
  - Ink `#0A0A0A` with the 14 px grid of `#1E1E1E` dots fading toward the edges.
  - Text: `#EDEDED` for what matters, `#CFCFCF` for reading text, `#7A7A7A` for secondary.
  - `#2A2A2A` for lines and fills only.
  - `#4E4E4E` only for viewfinder corners.
  - **The one exception (new on this page):** each agent's Figbot is drawn in that agent's colour (see Faces). Nothing else gets colour, not even for the fun agents.
- **Type.**
  - IBM Plex Mono for chrome and data: 11/16, caps at 0.12 em for labels and buttons; 22/28 for titles.
  - Red Hat Text for reading: 13/18, 14/20, 14/22 for long text, 15–17 on the phone.
- **One meaning per device.**
  - Dotted borders mean you can act on it.
  - The primary button is a solid `#EDEDED` block, at most one per artboard.
  - Secondary buttons are dotted and grey, and turn white on hover. Tertiary is a dotted underline.
  - Every button shows its key.
- **Identity.**
  - Agents are Figbots, each in its own colour (new on this page; it replaces the outlined square with eyes).
  - People are solid squares with an initial (Mikkel: `M`).
- **Status** uses the pixel squares from Foundations, unchanged.
- **No** bubbles, rounded corners, emoji, brand logos of other apps, or colour outside the agents' faces.
- **The logo** comes from the brand kit at whole-number scales. Never retype "munin" in another font.

## New pieces

### Topbar (desktop)

- **Size:** 48 px tall, full width, 1 px `#2A2A2A` rule underneath. 20 px side padding.
- **Left:** the dither lockup at 118 × 22, moved up from the tracker sidebar.
- **Tabs,** 32 px after the lockup:
  - `AGENTS` and `TRACKER`, in Plex Mono 11 caps.
  - The current tab is `#EDEDED` with a 1 px underline, like the client tabs in 05; the other is `#7A7A7A`.
  - Tabs don't show keys; ⌘K lists them (`G A`, `G T`).
- **Right,** from left to right:
  - The search field from the tracker sidebar ("Search or jump to…", `⌘K`), 240 px wide. It searches agents, issues and projects.
  - A dotted chip `4 WAITING ON YOU`: questions from conversations plus the tracker inbox. It opens a list of them and is hidden at zero.
  - The person square `M`, which opens settings.
- **What moves out of the tracker sidebar:** the lockup and search (into the topbar) and the bottom row with your name and SETTINGS (the `M` square). The rest of the tracker sidebar stays as it is, except that the agent squares become Figbots (see 13).

### Faces

Every agent is a **Figbot**: the halftone sphere with two eyes from `figment-engineering/figbot` (see `figbot/out/sheet.png` there). The outlined square with eyes is retired. Every agent has the same face. **Colour is what tells agents apart.** Each agent picks one when it's created, and the halftone dots are drawn in it. The black ground and the eye holes stay `#0A0A0A`.

| Colour | Hex |
|---|---|
| white (default) | `#EDEDED` |
| ember | `#F2A65A` |
| coral | `#F07C6B` |
| rose | `#E98BB8` |
| iris | `#A99BF5` |
| sky | `#6FB3F2` |
| teal | `#4FC7B8` |
| moss | `#9CCB6B` |
| straw | `#E3CF6E` |

White is the default for a new agent and can be kept like any other colour. Outside agents (codex, figbot) are always white: the original Figbot. Claude (claude-code, or claude-1 and on from `munin run`) gets Claude's spark instead, in its terracotta and the brand's dither.

**Expression shows state.** The expressions are Figbot's own poses (`POSES` in `figbot/src/model.ts`):

- **working:** `thinking`. In the product it moves through Figbot's loop and blinks.
- **idle:** `idle`.
- **asks you:** `curious`.
- **failed or blocked:** `worried`.
- **paused:** `sleepy`, with the dots at 50 % opacity.
- **just finished something:** `happy` for a few seconds, then back to `idle`. It only shows in the product. On the artboards, use it only in 08.

`excited` is spare. Companions may use it in conversation.

**Sizes and grids.** Render the face from Figbot's model; don't redraw it by hand. Use `cells(pose, n, n)`, and draw the dots with `svgBody` from `figbot/src/svg.ts`, with the agent's colour in place of `FG_COLOR` and no background.

| Size | Grid | Where |
|---|---|---|
| 18 px | 18 cells, 1 px each | lists, rows, message rows |
| 36 px | 24 cells, 1.5 px each | headers, the colour picker |
| 72 px | 36 cells, 2 px each | profile |
| 100 px and up | 48 cells | setup's portraits and its last screen |

18 px is the smallest size and should read like the site's 16 px Figbot icon (`public/icons/figbot.svg`). If the eyes don't read at 18, note it under "Changed while designing" rather than redrawing them.

**The colour appears only in the face.** Names, role tags, rows and selection stay in the five greys.

### Role tag

The role in Plex Mono 11 caps at 0.12 em, `#7A7A7A`, after the name: `ASSISTANT`, `CODER`, `REVIEWER`, `WRITER`, `RESEARCHER`, `COMPANION`. No box. It's a label, not a control.

### Conversation pieces

- **Message row.** It works like the thread in 03:
  - Line 1: face or person square (18), the name in Red Hat 14 `#EDEDED`, and the time in Plex Mono 11 `#7A7A7A`.
  - Body below it, indented to the name: Red Hat 14/22 `#CFCFCF`.
  - Your messages look the same, with the `M` square. They aren't right-aligned and have no bubble.
  - Messages from the same author within a few minutes drop the first line.
- **Action line.** Something the agent did, in Plex Mono 11/16 `#7A7A7A`, indented to the body.
  - It starts with a 12 px glyph: the status pixel square for anything that moves an issue, otherwise a plain 4 × 4 `#7A7A7A` pixel.
  - Then the verb, then the object in `#CFCFCF`.
  - Issue ids and links have a dotted underline (tertiary).
  - Consecutive actions stack 4 px apart.
  - Examples: `took MUN-46 · Stream tool output to Telegram`, `ran routine · Morning briefing`, `sent mail · Re: Offsite in Aarhus`.
- **Time rule:** `TODAY · 09:15` in Plex Mono 11 caps, left-aligned, followed by a 1 px `#2A2A2A` line to the right edge.
- **Run:** a collapsed line `RUN 2 · 14 STEPS · 6 MIN` with tertiary `EXPAND`. Expanded, it shows the step list from 03: a time column, the step text, and a 1 px rule on the left. The newest step reads `now`, with a cursor.
- **Question card.** YOUR MOVE from Foundations and 01, inside the thread:
  - The label `HUGIN ASKS`, or `FORGE ASKS ON MUN-46` when it's about an issue.
  - The question in Red Hat 15/22 `#EDEDED`.
  - Numbered dotted options with a line of detail each, then "Or answer in your own words…".
  - The primary `SEND TO HUGIN ⌘↵`.
  - Answered cards keep the chosen option with its filled check, drop the rest, and add `You · 07:44` in Plex Mono 11.
- **Approval card.** When an agent wants to do something switched on under ASK ME FIRST (send mail, accept an invite, …), it asks with this instead of a question card:
  - The label `HUGIN WANTS TO SEND MAIL`, then what it will do in Plex Mono 11 `#CFCFCF`: `Re: Offsite in Aarhus → Paul Eriksen`. The draft itself is quoted in the message above the card.
  - Three dotted rows, each with a key and a line of detail. Picking one acts at once, so the card has no send button and no primary:
    1. `Allow once`: "Send this one. Ask again next time."
    2. `Always allow`: "Stop asking before hugin sends mail."
    3. `Deny`: "Don't send. Tell hugin why below."
  - Answered, it keeps the chosen row with its filled check and `You · 07:44`, like a question card. After `Always allow` it adds a grey line: "Sending mail no longer asks first. Turn it back on in hugin's profile." with `PROFILE` as a tertiary link.
- **Work strip** (when an agent is working on an issue): a 40 px band under the conversation header, with a 1 px rule below it.
  - Left: the Working pixel, `MUN-46` in Plex Mono, the title in Red Hat 13, then `· 6 min · editing gateway/telegram.py` in grey.
  - Right: tertiary `VIEW RUN R` and `STOP S`.
- **Composer:** the dotted steer box from 03, pinned to the bottom of the conversation.
  - Placeholder "Message hugin…", with `⌘↵` in a key box.
  - For an agent that's working, the placeholder is "Steer forge…" and the helper line underneath says "forge reads your message before its next step."

### Agents sidebar

- **Size:** 232 px wide, like the tracker sidebar.
- **Top:** the label `AGENTS` and the count `7`.
- **Rows:** 56 px each, 10 px side padding.
  - Line 1: face (18), the name in Red Hat 14 `#EDEDED`, the role tag, and on the right the time (Plex Mono 11) or an `ASKS` chip (the dotted row chip from Foundations).
  - Line 2: one line of Red Hat 13 `#7A7A7A`, ellipsised. It's the agent's last message or what it's doing: "working on MUN-46".
- **Order:** agents waiting on you first, then by last activity.
- **Selected row:** `#EDEDED` at 6 % (`#EDEDED0F`), like the tracker's nav.
- **Bottom:** a full-width secondary button `NEW AGENT N`.

## The cast

Use these everywhere so the artboards tell one story. Times are 24-hour, Copenhagen.

| Agent | Role | Colour | Model | State | Sidebar line 2 |
|---|---|---|---|---|---|
| hugin | ASSISTANT | sky | haiku-5.5 · OpenRouter | idle, asks you | Move the dentist to which slot? |
| forge | CODER | ember | opus-5.5 · OpenRouter | working on MUN-46, asks you | Telegram caps a message at 4,096… |
| vera | REVIEWER | iris | sonnet-5.5 · OpenRouter | idle | MUN-45 is merged. Nothing else to review yet. |
| quill | WRITER | rose | sonnet-5.5 · OpenRouter | idle | Draft 2 of "Why munin" is ready. |
| atlas | RESEARCHER | teal | sonnet-5.5 · OpenRouter | working | Reading: "Durable execution in practice" |
| pip | COMPANION | straw | haiku-5.5 · OpenRouter | idle | Ready for round two of the riddle? |
| moss | COMPANION | moss | llama · Ollama, on the server | paused | Paused by you yesterday |

Waiting on you: four items.

- hugin's dentist question (in its conversation).
- forge's question on MUN-46, which is in both its conversation and the tracker inbox.
- In the tracker only:
  - claude-code wants a review of PR #212 on MUN-41;
  - figbot failed on MUN-38.

## Artboards

Number them after Issues v3. Desktop is 1440 wide; the phone is 390 × 844.

### 08 Agent foundations (1440 × as tall as needed)

A sheet in the style of 00, with sections:

- **FACES:** the nine colours as idle Figbots at 18, 36 and 72, with their names and hex values, white first and marked as the default. Caption: outside agents are always white.
- **STATES:** one Figbot (hugin, sky) in each of working, idle, asks you, failed, paused and just finished, at 36, with a person square for comparison. Caption: "Colour says who. Expression says what it's doing."
- **ROLES:** the six role tags.
- **TOPBAR:** the bar on its own, with a caption.
- **CONVERSATION:** each piece on its own, with a short caption:
  - message row, your message, action line, issue action, time rule;
  - run collapsed and expanded;
  - work strip and composer.
- **YOUR MOVE IN A CONVERSATION:** a question card open and answered, then an approval card open and answered with `Always allow`.
- **ROUTINES:** two routine rows, one on a schedule and one on a trigger, with a caption listing the triggers (see 11).

### 09 Agents · hugin (1440 × 900)

- **Layout:** topbar (AGENTS current) / agents sidebar (hugin selected) / conversation / a right panel `ABOUT`, the width of 03's PROPERTIES.
- **Conversation header,** 52 px:
  - Left: face (18), `hugin`, `ASSISTANT`.
  - Right: `haiku-5.5 · OpenRouter`, then secondary `PROFILE P`.
- **Thread:**

```
TODAY · 07:30
  · ran routine · Morning briefing
hugin  07:30
  Morning. Three things today: Weekly Dev / Eng moved to 11:00, Paul is
  waiting for your answer about the offsite, and the dentist at 15:00
  clashes with the design review.
  · read calendar · 6 events today
  · read mail · 2 unread from Paul
M Mikkel  07:42
  Tell Paul yes to the offsite. And move the dentist, please.
  · drafted reply · Re: Offsite in Aarhus
hugin  07:43
  Here's the reply to Paul.
  │ Hi Paul, count me in for the offsite. I'll book the train once the
  │ agenda is out. Mikkel
  [answered approval card: HUGIN WANTS TO SEND MAIL · "Allow once" ✓ · You · 07:44]
  · sent mail · Re: Offsite in Aarhus → Paul Eriksen
TODAY · 09:15
hugin  09:15
  The dentist has two free slots this week.
  [open card] HUGIN ASKS
  Move the dentist to which slot?
  1  Thursday 10:00     Your morning is clear.
  2  Friday 14:30       Right after lunch with Sara.
  Or answer in your own words…
  SEND TO HUGIN ⌘↵
```

  The quoted draft has a 1 px `#2A2A2A` rule on its left and is set in Red Hat 13 `#CFCFCF`.
- **Composer:** "Message hugin…".
- **ABOUT panel** (label/value rows like PROPERTIES):
  - Role: Assistant
  - Model: haiku-5.5 · OpenRouter
  - Today: $0.08 · 41k tokens
  - `ROUTINES`:
    - Morning briefing · weekdays 07:30 · next tomorrow 07:30
    - Inbox sweep · every 2 h · next 11:15
    - Paul first · when mail from Paul Eriksen arrives · last today 07:12
  - `APPS`: Calendar, Gmail and Web, each a plain row with the 4 × 4 pixel.
  - Then secondary `PROFILE P` and tertiary `PAUSE`.

### 10 Agents · forge (1440 × 900)

- **Layout:** as 09, with forge selected.
- **Work strip:** `MUN-46 Stream tool output to Telegram · 6 min · editing gateway/telegram.py`.
- **Thread:**

```
YESTERDAY · 18:10
M Mikkel  18:10
  When the gateway work is in, take the Telegram streaming issue.
forge  18:11
  Will do. MUN-45 is in review with vera, so I'll start on MUN-46 when it lands.
TODAY · 13:56
  ▣ vera moved MUN-45 to Done
  ◧ took MUN-46 · Stream tool output to Telegram
forge  13:57
  Starting on MUN-46. Plan: buffer the output and edit one message every
  1.5 s, which stays under Telegram's rate limit.
  RUN 2 · 14 STEPS · 6 MIN   (expanded, last four)
    14:02  Read gateway/telegram.py and gateway/stream.py
    14:05  Edited gateway/stream.py  +62 −8
    14:06  Ran pytest gateway/  41 passed
    now    Editing gateway/telegram.py to split long messages ▍
  [open card] FORGE ASKS ON MUN-46
  Telegram caps a message at 4,096 characters. When output runs past
  that, start a new message or attach the rest as a file?
  1  Start a new message   Easy to read on the phone.
  2  Attach as a file      One message, but you have to open it.
  Or answer in your own words…
  SEND TO FORGE ⌘↵
  Also in the tracker's inbox. Answering here answers there.
```

- **Composer:** "Steer forge…", with the helper line.
- **ABOUT panel:**
  - Role: Coder
  - Model: opus-5.5 · OpenRouter
  - Today: $1.92 · 640k tokens
  - Works in: `~/agents/forge/munin` · branch `mun-46-stream`
  - Tracker: MUN, WEB · takes issues
  - `ROUTINES`:
    - Nightly tests · 02:00 · "Pull main, run the suite, file what fails"
    - Fix what vera flags · when vera requests changes on forge's PR · last yesterday 16:40

### 11 Agent profile · hugin (1440 × 1100)

- **Layout:** topbar / agents sidebar (hugin selected) / a content column 720 wide, like 05's.
- **Header:**
  - Figbot at 72 in sky, `idle`, then `hugin` in Plex Mono 22/28, `ASSISTANT`.
  - "Idle · last active 09:15 · since 24 September".
  - Tertiary `CHAT C`, `PAUSE` and `DELETE`.
- **Sections** (section labels like 05):
  - **BRIEF:** a dotted text area, Red Hat 14/22: "You're hugin, Mikkel's assistant. Keep his calendar and inbox in order, and say things once, briefly. Ask before you send mail or accept invites for him. Start weekdays with a briefing; after that, only interrupt for things that can't wait."
  - **MODEL:** dotted selects `OpenRouter ▾`, `haiku-5.5 ▾` and `Thinking: low ▾`. Hint: "About $0.10 a day at this pace."
  - **ABILITIES:** toggle rows like "What agents can do without asking" in 05.
    - On: Apps ("Calendar and Gmail are connected." plus tertiary `CONNECT AN APP`) and Web ("Search and read pages").
    - Off: Code ("A folder, a shell and git"), Tracker ("Take, review and file issues in munin") and Images ("Make pictures").
  - **ASK ME FIRST:** toggle rows. Sending mail: on. Accepting or declining invites: on. Moving my own events: off. Caption: "Anything switched on becomes an approval in your conversation. Always allow on that card switches it off here."
  - **ROUTINES:** rows with a name, what starts it, one line of what it does, the next run (or the last run, for triggers) and tertiary `EDIT`. A routine starts on a schedule or on a trigger:
    - **Mail:** mail arrives, matched by sender or subject.
    - **Calendar:** an event is added, moved or about to start.
    - **Tracker:** an issue moves to a status, is assigned, gets a review request or changes requested, or a run fails.

    Rows:
    - Morning briefing · Weekdays 07:30 · "Summarise the day: calendar, mail that needs me, the weather in Copenhagen." · next tomorrow 07:30
    - Inbox sweep · Every 2 hours, 08–18 · "Flag mail that needs a reply today." · next 11:15
    - Paul first · When mail from Paul Eriksen arrives · "Tell me right away and draft a reply." · last today 07:12

    Then secondary `NEW ROUTINE`.
  - **MEMORY:** "What hugin remembers about you · 23 notes", three of them, and tertiary `VIEW ALL`:
    - Prefers mornings for appointments.
    - Paul Eriksen is his manager.
    - Takes the train to Aarhus.
  - **USAGE:** today $0.08, this week $0.61, this month $2.40. Field: "Pause hugin at $10 a month".

### 12 New agent (1440 × 1000)

- **Layout:** topbar / agents sidebar (no row selected, `NEW AGENT` pressed) / content column.
- **Header:** title `New agent` in Plex Mono 22/28, then "Pick a role to start from. You can change everything later."
- **ROLE:** six dotted cards in a 3 × 2 grid. Each has a key square, a name (Red Hat 14), a line (Red Hat 13 grey) and its default abilities (Plex Mono 11 caps grey):
  1. Coder · "Takes issues, writes code, sends it to review." · CODE · TRACKER
  2. Reviewer · "Reviews other agents' work and merges it." · CODE · TRACKER
  3. Assistant · "Keeps your calendar, mail and reminders in order." · APPS · WEB
  4. Writer · "Drafts, edits and keeps one voice." · WEB
  5. Researcher · "Reads up on a question and reports back with sources." · WEB
  6. Companion · "Someone to talk to. Riddles, ideas, bad puns." · JUST TALK

  6 is selected and shows the filled check.
- **NAME:** a dotted input, `pip`.
- **COLOUR:** the nine colours as idle Figbots at 36, each in a dotted box with its name under it in Plex Mono 11 caps grey. White comes first and is preselected for a new agent; here pip has picked straw, which shows the filled check. Colours already taken by other agents are still offered, with the agent's name in grey: "hugin". Two agents can share a colour, but it isn't suggested.
- **MODEL:** `OpenRouter ▾`, `haiku-5.5 ▾`. Hint: "A companion doesn't need a big model. About $0.02 a conversation."
- **BRIEF,** filled in from the role and editable: "You're pip. You're curious and cheerful, and you like riddles, word games and odd facts. Keep replies short. When Mikkel seems busy, let him be."
- **Primary:** `CREATE PIP ⌘↵`, with "Abilities, routines and a budget are in pip's profile." beside it.

### 13 Tracker under the topbar (1440 × 900)

01 Inbox with the topbar (TRACKER current) and the slimmer sidebar. The nav and projects stay as they are. The agent squares become Figbots at 18: your own agents in their colours, outside agents in white, each with the expression for its state. They still read "3 agents working, 2 idle".

- **Inbox list:**
  - `Inbox 3 open`
  - WAITING ON YOU:
    - figbot FAILED (as in 01), its white Figbot `worried`
    - claude-code REVIEW (as in 01), its white Figbot `curious`
    - forge ASKS · MUN-46 · "Telegram caps a message at 4,096 characters. New message or a file?"
  - LATELY, which replaces "To triage" (munin has no triage):
    - vera moved MUN-45 to Done · 13:56
    - forge took MUN-46 · 13:56
    - claude-code merged #209 into main · 3h
- **Detail pane:** forge's question on MUN-46, with the two options from 10 and the primary `SEND TO FORGE ⌘↵`. Under it: "Also in your conversation with forge."

### 14 Phone · agents (390 × 844)

- **Header,** like 06: "Agents" in Red Hat 17, then `4 waiting` in Plex Mono 11 grey, and the raven mark on the right.
- **Rows:** the sidebar rows at phone size (face 18, name Red Hat 15, role tag, line 2 in Red Hat 14 grey, `ASKS` chips).
- **Bottom bar,** like 06's, with the items Agents (a white idle Figbot at 18, current), Tracker (06's inbox glyph), New and Search. New is a new agent here and a new issue in Tracker.

### 15 Phone · hugin (390 × 844)

- **Header:**
  - Left: `‹` back, then face (18), `hugin`, `ASSISTANT`.
  - Right: tertiary `PROFILE`.
- **Thread:** the end of 09, from `TODAY · 09:15`. The question card is full width, like 06: dotted options, "Or write an answer…", and a full-width primary `SEND TO HUGIN`.
- **Bottom:** the bottom bar hides inside a conversation; the composer "Message hugin…" sits at the bottom instead.

## When it's done

1. **Check each artboard against the rules above:**
   - one primary;
   - dotted only on things you can act on;
   - only the five greys, plus agent colours inside Figbots and nowhere else;
   - no rounded corners or bubbles;
   - keys on buttons;
   - Figbots rendered from the model on the grids in Faces, at whole-number scales;
   - each agent always in its colour from the cast, with the expression for its state.
2. **Export each artboard into `design/`** like the existing ones: a 2× PNG, the JSX, and a standalone HTML.
   - Names: `08-agent-foundations`, `09-agents-hugin`, `10-agents-forge`, `11-agent-profile`, `12-new-agent`, `13-tracker-topbar`, `14-mobile-agents`, `15-mobile-conversation`.
   - Point logo images at `../brand/logo/treatments/`, as the existing exports do.
3. **Add the artboards to the table in `design/README.md`,** under a heading for page "Agents v1".
4. **Note anything this brief got wrong** or that didn't work on the canvas at the end of this file, under "Changed while designing". Don't change other files.

## Changed while designing

- **36 px faces use a 24-dot grid (1.5 px a dot), not 18.** At 18 dots the expressions blur together; happy is hard to tell from idle. This is the one place a face isn't drawn at a whole-number scale.
- **At 18 px, the colour reads but the expression barely does.** State still shows through the row's chip and line 2, so rows don't rely on the face for it.
- **The `ASKS` chip sits at the end of line 2 in the agents sidebar,** not line 1. At 232 px, the name, the role tag and the chip don't fit on one line; line 1 always ends with the time.
- **White is a colour you can pick, and the default** for a new agent (Mikkel, after reviewing 08 and 09).
- **11 and 12 are taller than 1100 and 1000.** The sections don't fit, so both artboards fit their content (about 1770 and 1290).
- **hugin's profile header reads "Asks you", not "Idle",** with the `curious` face, to match the open dentist question in 09.
- **pip isn't in 12's sidebar,** because pip is the agent being created there. The other artboards show the sidebar after pip exists.
- **The phone composer's key box shows `↑`,** not `⌘↵`.

## Changed while building the dummy frontend

- **No answer field inside an open question card in a conversation.** The message box answers it: its placeholder reads "Answer hugin, or pick an option…", and a line under it says the message answers the question. The tracker inbox has no message box, so its card keeps the field.
- **PROFILE and the model are only in the ABOUT panel.** The conversation header shows the face, name and role. Where the panel doesn't fit (narrower than about 1000 px, and on the phone), the header gets a tertiary `PROFILE` link instead.
- **The agents sidebar is 288 px,** not 232, so line 2 has room next to the `ASKS` chip. The tracker's sidebar stays 232.
- **`Always allow` shows `UNDO` for 8 seconds** after `PROFILE` on the answered card, because one click changes a permission for good.
- **Settings sits behind the `M` square:** models and providers, outside agents (the old Agents & MCP page, with munin's own agents marked `OWN`), notifications, and a reset for the dummy's sample agents. The tracker sidebar's row of faces opens it.
- **The `WAITING ON YOU` chip opens a list** of everything waiting, from conversations and the tracker inbox. A question about an issue is listed once. On the phone, the count in the Agents header opens the same list.


## Changed while building setup

- **Big faces (100 px and up) use a 48-dot grid,** finer than the profile's 36, for setup's portraits and its last screen (Mikkel, from the setup preview).
- **The shading is figment's own again,** after a softer version for a while (Mikkel, comparing the two).
- **A face blends into a new expression** over 0.35 s, as figment's timeline does, blinking through a change of eye shape.
- **The agent's Figbot fills the foot of the conversation's ABOUT panel,** as wide as the panel: the panel's left border and a line above it frame it, and the window's right and bottom edges cut it.
- **Idle, paused and happy faces glance about now and then,** and paused ones move too. Before, only working faces moved.

## Changed while giving agents a character (MUN-34)

- **HOW IT TALKS, under BRIEF, on the profile and on New agent.** A text area like the brief's with a few made-up exchanges that show how the agent sounds, where `You:` is you and the agent's lines carry its name. On New agent it fills in from the role, like the brief. It can be emptied.
- **The brief is two paragraphs:** who the agent is, then how it works. Its lead reads "Who hugin is and how it works." Setup's portrait shows only the first paragraph.
- **A reviewer starts on a different maker's model from your coders'** when one is offered, and New agent's hint says why.

## Changed while giving agents memory and a track record (MUN-35)

- **MEMORY is in three kinds,** each with a label in Plex Mono 11 caps and how full it is, `ABOUT YOU 620 / 1,500`, turning `#EDEDED` when the kind is full: about you, about the work, and about itself. Each note has tertiary `EDIT` and `FORGET` on hover; `EDIT` turns the note into a field (Return saves, Escape doesn't).
- **TRACK RECORD, between ROUTINES and MEMORY,** as label/value rows like PROPERTIES: Shipped, Sent back, Reviewed, Works in and Last shipped, from the tracker. An agent with the Tracker ability that hasn't done anything there yet says so; one without it and with nothing in the tracker has no section.

## Changed while giving agents skills (MUN-36)

- **SKILLS, between ROUTINES and TRACK RECORD,** in routine rows: the skill's name in Plex Mono, its description, how often it's been used (`Used 6 times · 2d ago`, `Not used yet`, `Not used in a month`), whose it is when another agent shared it (`vera's`), and tertiary `SHARE` and `EDIT` (`READ` for another agent's). Then secondary `WRITE A SKILL`.
- **Editing a skill** is a sheet with its SKILL.md in a Plex Mono text area; a new one starts from a template with When to use, Steps, Pitfalls and How to check. **Sharing** is a sheet of dotted checkbox rows like the Apps picker: "Every agent, now and later", then each agent.
- **A skill's approval card** quotes the skill between the target and the options, under its description, scrolling past 280 px. Its rows read `Save it`, `Always allow` and `Don't save it`.
- **Agents' Markdown** shows headings, as short bold lines, and numbered lists.

