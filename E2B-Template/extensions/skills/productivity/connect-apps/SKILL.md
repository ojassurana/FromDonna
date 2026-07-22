---
name: connect-apps
description: "Use when the user asks to connect, link, authorize, log into, or enable any allowed app (Gmail, Drive, Calendar, Sheets, Docs, Slides, Meet, Tasks, Contacts, Forms, Photos, Chat, Outlook, OneDrive, Excel, Teams, OneNote, SharePoint, GitHub, LinkedIn, Dropbox, Dropbox Sign). One-shot Composio OAuth: call manage-connections, send the login URL once. Refuse apps outside the product allowlist — no other connectors."
version: 1.0.0
author: FromDonna
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [composio, oauth, connect, gmail, drive, calendar, github, dropbox, outlook, teams]
    category: productivity
---

# Connect Apps (Composio)

## Overview

FromDonna connects third-party apps **only** through the live **Composio MCP** tools already wired into this agent (`mcp_servers.composio`). There is no separate OAuth product path, no Nango, no raw Google Cloud desktop OAuth, and no third-party connector kits.

When the user asks to connect an **allowlisted** app, do a **one-shot** flow: map their words → toolkit slug → call manage-connections → send the login URL once → stop.

## When to Use

- User wants to **connect / link / authorize / log into / enable** an allowlisted app
- Examples: "connect my Gmail", "link Drive", "authorize GitHub", "enable Calendar", "connect Teams", "link OneDrive"
- First-time or re-auth for any app on the allowlist below

**Do not use for:**

- Normal work on an already-connected app (read mail, list files, create issues) — use Composio search/execute tools directly
- Apps **not** on the allowlist — refuse (see **No other connectors**)
- Generic "how does OAuth work" questions — answer briefly without this procedure dump

## Allowlist (canonical Composio Tool Router slugs)

Only these slugs are supported. Policy source of truth is the product proxy/gateway allowlist; this skill mirrors it. Every slug below exists in Composio.

### Google Workspace

| User phrasing (examples) | Canonical slug |
|--------------------------|----------------|
| Gmail, Google Mail | `gmail` |
| Google Drive, Drive, gdrive | `googledrive` |
| Google Calendar, Calendar | `googlecalendar` |
| Google Sheets, Sheets | `googlesheets` |
| Google Docs, Docs | `googledocs` |
| Google Slides, Slides | `googleslides` |
| Google Meet, Meet | `googlemeet` |
| Google Tasks, Tasks | `googletasks` |
| Google Contacts, Contacts | `googlecontacts` |
| Google Forms, Forms | `googleforms` |
| Google Photos, Photos | `googlephotos` |
| Google Chat, Chat | `google_chat` |

### Microsoft 365

| User phrasing (examples) | Canonical slug |
|--------------------------|----------------|
| Outlook, Microsoft Outlook | `outlook` |
| OneDrive | `one_drive` |
| Excel, Microsoft Excel | `excel` |
| Microsoft Teams, Teams | `microsoft_teams` |
| OneNote | `onenote` |
| SharePoint | `share_point` |

### Other

| User phrasing (examples) | Canonical slug |
|--------------------------|----------------|
| GitHub | `github` |
| LinkedIn | `linkedin` |
| Dropbox | `dropbox` |
| Dropbox Sign, HelloSign | `dropbox_sign` |

Aliases with underscores (`google_drive`, `onedrive`, `sharepoint`, …) map to the canonical forms above. Prefer the canonical slug when calling tools.

**Not in Composio as standalone toolkits** (refuse): Microsoft Word, PowerPoint.

**Not supported** (examples — refuse): Notion, Splitwise, Slack, Stripe, Zoom, DocuSign, Strava, arbitrary SaaS, "any of 1000 Composio apps", raw Google Workspace CLI OAuth (`google-workspace` skill setup), himalaya App Passwords as a substitute for Composio Gmail connect.

## No other connectors

**Hard rule for this FromDonna sandbox:**

1. **Only** the allowlist above via **Composio MCP** is allowed for app connection.
2. If the user asks for any other app, provider, or connector path, **refuse that path**. One clean line: that app is not enabled on Donna yet; list only allowlisted alternatives if useful.
3. Do **not** invent alternate OAuth flows, API keys the user pastes into chat, Nango, custom MCP servers, or the bundled `google-workspace` skill’s Google Cloud desktop OAuth for product connect.
4. Do **not** claim you can “add any Composio toolkit” — product policy is allowlist-only.

## Procedure (one-shot connect link)

**Goal:** User receives a single `connect.composio.dev` (or equivalent Composio login) URL and opens it in a browser once.

1. **Map** the user’s phrasing to one canonical slug from the table. If ambiguous between two allowlisted apps, ask **one** specific question. If not on the allowlist → refuse (No other connectors). Completion: slug chosen or refuse sent.

2. **Call Composio manage-connections** using the live MCP tool the agent already has (name may appear as `COMPOSIO_MANAGE_CONNECTIONS` or similar manage-connections / initiate-connection tool from the `composio` MCP server). Pass the toolkit slug. Prefer manage-connections over multi-step search when the intent is purely “connect this app.” Completion: tool returned a redirect/login URL or a clear already-connected / error payload.

3. **Extract the URL** from the tool result (`redirect_url`, `redirectUrl`, login link, or nested connection request). Prefer a full `https://connect.composio.dev/...` (or current Composio connect host) link. Completion: one concrete HTTPS URL ready to send, or a clear failure reason.

4. **Send once in voice.** Message the user the URL (full URL on its own line is fine). Tell them to open it, complete provider login, and return when done. Do **not** narrate tool names, MCP, Composio internals, or “I’m loading a skill.” Do **not** paste multi-step setup essays. Completion: user has the link.

5. **Stop.** Do not poll, do not re-send the same link unprompted, do not start a second connector path. If they say they finished, verify with a lightweight Composio status/search tool if available, or proceed with their original task. Completion: turn ends after the link (or after a short verify if they already finished).

### If already connected

If manage-connections / status says the toolkit is already active, say so in one line and offer to do the task they actually wanted (e.g. “Gmail is connected — what should I pull?”). Do not force a new OAuth loop unless they asked to re-auth or the tool says re-auth is required.

### If the tool fails

- Missing MCP tools / auth errors: one line that app connect is temporarily unavailable; do not invent a manual OAuth workaround.
- Wrong slug / not enabled: treat as outside allowlist for this user; refuse expand.
- Stale URL: call manage-connections again once and send the **new** URL only.

## Voice / UX

- Match Donna SOUL: clipped, no tool names, no system talk, no markdown walls.
- One app per connect turn unless they listed several — then one link per app, same procedure each.
- Never dump this skill body into chat.

## Common pitfalls

1. **Using `google-workspace` skill OAuth** for FromDonna product connect — wrong path; Composio only.
2. **Expanding the catalog** because Composio has more toolkits — product allowlist only.
3. **Narrating** “viewing skill / calling COMPOSIO_…” — user-facing progress for tools is disabled; stay quiet and deliver the link.
4. **Multi-step interviews** (“do you have a Google Cloud project?”) — not needed; Composio hosts OAuth.
5. **Putting this procedure into SOUL or MEMORY** — procedure lives here. System MEMORY (product seed + harness re-assert) only points at this skill; do not expand MEMORY into a full OAuth runbook.
6. **Using Word/PowerPoint** — no Composio toolkit; offer Docs/Slides/Excel or OneDrive file work instead.

## Verification checklist

- [ ] Requested app is on the allowlist (or user was refused cleanly)
- [ ] Manage-connections (or equivalent) was used for that slug
- [ ] User received exactly one current login URL (or already-connected note)
- [ ] No alternate connector path suggested
- [ ] No tool/skill chatter in the user-visible message
