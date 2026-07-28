# Issue tracker: Linear

Work on this fork is tracked in **Linear**, not GitHub Issues — GitHub hosts code and PRs only. Team: **Cyrus** (key `CYR`, e.g. `CYR-1`). Use the connected Linear MCP (`mcp__linear-server__*` / `mcp__…Linear…__*`) for all issue operations, never `gh issue`.

> This is the LinkedList fork of [cyrusagents/cyrus](https://github.com/cyrusagents/cyrus), self-hosted on Dokploy. We dogfood the planning skills here: plan changes to the fork as CYR issues via `/wayfinder`. See the command center's `wiki/self-hosting-cyrus-on-dokploy.md` and `wiki/wayfinder-on-cyrus.md` for the deployment + routing context.

## Conventions

- **Create an issue**: `save_issue` with `team: "Cyrus"`, `title`, `description` (Markdown), and optionally `assignee`, `priority`, `labels`, `parentId`, `state`.
- **Read an issue**: `get_issue` with `id` (identifier, e.g. `CYR-1`).
- **List issues**: `list_issues`, filtered by `team`, `state`, `label`, `assignee`, `parentId`, `query`.
- **Comment**: `save_comment` with `issueId` and `body` (Markdown).
- **Apply/remove labels**: `save_issue` with `id` and `labels` — replaces the full label set, so read current labels first if changing just one.
- **Close**: `save_issue` with `id` and `state` set to a Done/Canceled state name (see `list_issue_statuses`).
- PRs stay on GitHub (`LinkedListLLC/cyrus`), linked back to Linear with magic words (`Closes CYR-1`, `Fixes CYR-1`).

## State model & the Ready gate

This team's workflow states: **Backlog** (backlog), **Todo** (unstarted), **In Progress** / **In Review** (started), **Done** (completed), **Canceled**. Map wayfinder's open/closed lifecycle onto them:

| Wayfinder | Linear state |
|---|---|
| open / unresolved | Backlog / Todo / In Progress / In Review |
| **Ready / takeable** ← the gate | **Todo** |
| **claimed** (being worked) | assignee set → **In Progress** |
| **resolved** (closed) | **Done** |
| **out of scope** | **Canceled** |

**Ready gate:** only children in **Todo**, unblocked, and unassigned are on the frontier. Charting leaves not-yet-ready tickets in **Backlog** so nothing half-charted is auto-taken. For a background agent (the deployed Cyrus, routing on team `CYR`), promoting a ticket to **Todo** and assigning the agent is the deliberate "go" signal.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a parent issue with **child** issues as tickets, using Linear's native parent/child relationship.

- **Map**: a Linear issue labelled `wayfinder:map` (workspace label — already exists; create via `create_issue_label` if missing), holding the Notes / Decisions-so-far / Fog body in its description. Keep it in **Backlog** — it's an index, not a takeable ticket.
- **Child ticket**: `save_issue` with `parentId` set to the map, `labels: ["wayfinder:<type>"]` for `research`/`prototype`/`grilling`/`task`, and `state: "Todo"` when the question is specifiable *and* (once wired) unblocked; otherwise `state: "Backlog"`.
- **Blocking**: `save_issue`'s `blockedBy` field (Linear's native relation). A ticket is unblocked when every issue in `blockedBy` is in a Done/Canceled state.
- **Frontier query**: `list_issues` with `parentId` set to the map, `state: "Todo"`, then drop any with an open blocker or a non-null assignee; first in Linear's default order wins.
- **Claim**: `save_issue` with `id`, `assignee: "me"` (or the driving agent), and `state: "In Progress"` — the session's first write.
- **Resolve**: `save_comment` with the answer, then `save_issue` with `state` set to **Done**, then append a context pointer (gist + link) to the map's Decisions-so-far.
- **Out of scope**: `save_issue` with `state` set to **Canceled** + one line in the map's Out of scope section.

## Labels

Workspace labels (already present): `wayfinder:map`, `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task`.
