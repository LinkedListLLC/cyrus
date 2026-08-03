# Personas (label-routed system prompts)

Cyrus selects a **persona** — a system prompt plus a tool policy — from the labels on the Linear
issue it has been assigned. Nine personas exist. Eight are markdown files loaded from disk, and one
(`review`) is built in TypeScript and is deliberately not label-routed at all.

This document is the reference for what each persona is for, how one is chosen, and what
configuration it needs. For the review persona specifically, see
[REVIEW_ON_STATUS.md](REVIEW_ON_STATUS.md) — it is the shape every other persona was rewritten to
match.

## The personas

| Persona | Prompt | Write access | For |
|---|---|---|---|
| `builder` | `packages/edge-worker/prompts/builder.md` | yes | Implementing a specified feature |
| `debugger` | `prompts/debugger.md` | yes | Diagnosing and fixing a defect |
| `scoper` | `prompts/scoper.md` | **read-only** | Turning a loose idea into a codebase-grounded spec |
| `orchestrator` | `prompts/orchestrator.md` | yes | Decomposing a large issue into sub-tasks |
| `graphite-orchestrator` | `prompts/graphite-orchestrator.md` | yes | The same, on Graphite stacked PRs |
| `wayfinder` | `prompts/wayfinder.md` | **read-only** | A Wayfinder map / research / grilling ticket |
| `wayfinder-task` | `prompts/wayfinder-task.md` | yes | A Wayfinder task / prototype ticket |
| `refactorer` | `prompts/refactorer.md` | yes | Reducing complexity a review already flagged |
| `review` | `src/prompts/reviewOnStatusPrompt.ts` | **read-only** | Reviewing a PR when an issue reaches In Review |

`scoper` is read-only by *configuration*, not by construction — it is read-only wherever its
`labelPrompts` entry sets `allowedTools: "readOnly"`, which is what the deployed config does. Only
`review` is read-only unconditionally, because it never goes through the label ladder.

### The house shape

Every persona prompt follows the same skeleton, taken from the review prompt:

```
<version-tag value="<name>-vN.N.N" />

You are <one line of identity>.

## Hard constraints    — what the persona cannot do; "do not try; do not ask to"
## How to work         — ordered and priority-ranked
## Skills              — prefer this repository's own skills where present
## Output format       — "Your final message IS what gets posted to Linear"
```

Three rules are load-bearing and are why the review persona was verifiable:

1. **An explicit output contract.** The session's final message is posted to Linear verbatim, so
   the prompt states its exact structure. This is also how a persona is verified in production —
   you check the shape of what it posted.
2. **Cite `file:line`.** A finding without a location is not actionable.
3. **An honesty clause.** "Say when you are unsure"; "do not invent findings to look thorough".

The `<version-tag>` is not decoration: `PromptBuilder.extractVersionTag` parses it and records it
as the session's `systemPromptVersion`. A prompt without one logs no version — which is how
`scoper.md` ran untracked for several releases. `PromptBuilder.persona-routing.test.ts` now fails
if any prompt file is missing its tag or if the tag names a different persona than the filename.

### Skill routing is a soft preference

The prompts name the repository's own skills (`/implement`, `/tdd`, `/to-spec`, `/research`,
`/grilling`, `/domain-modeling`, `/prototype`, `/diagnosing-bugs`, `/code-review`) because Cyrus
auto-loads a repository's committed `.claude/skills/` whenever it works there.

The repositories differ, so every mention is phrased as a preference and every Skills section ends
with the same escape hatch: *"If a skill named here is absent from this repository, follow the
guidance above directly rather than reporting a missing tool."* Repositories carrying the Matt
Pocock engineering pack get the skill; the cyrus repository itself carries only its own bundled
skills (`debug`, `implementation`, `investigate`, `summarize`, `verify-and-ship`) and degrades to
the inline guidance.

## Configuration

A persona is selected by label, via each repository's `labelPrompts` in `~/.cyrus/config.json`.
Matching is case-insensitive on the label name. The file hot-reloads — no redeploy.

```json
{
  "id": "job-boards",
  "labelPrompts": {
    "wayfinder":      { "labels": ["wayfinder:map", "wayfinder:research", "wayfinder:grilling"], "allowedTools": "readOnly" },
    "wayfinder-task": { "labels": ["wayfinder:task", "wayfinder:prototype"], "allowedTools": "all" },
    "debugger":       { "labels": ["Bug"] },
    "builder":        { "labels": ["Feature"] },
    "scoper":         { "labels": ["Scoper"], "allowedTools": "readOnly" },
    "orchestrator":   { "labels": ["Orchestrator"] }
  }
}
```

Global fallbacks for any persona go in `promptDefaults` at the top level of the config, keyed by
the same names.

**Deployed state (2026-08-03).** The three repositories in the self-hosted instance — `cyrus`,
`SalonPrive`, `job-boards` — carry the same three keys and no `appendInstruction`. The keys are
`wayfinder` and `wayfinder-task` as shown above, plus `refactorer` on the `Refactor` label with
`allowedTools: "all"`. The refactorer gets `all` and not `safe` because the `safe` preset withholds
`Bash`. A refactorer that cannot run the tests cannot prove that the behaviour did not change. That
proof is the persona's whole purpose. The `scoper` / `builder` / `orchestrator` entries stay
unrouted; give them their own labels to make them reachable again.

### Tool presets

`allowedTools` accepts a preset string or a verbatim array. The presets:

| Preset | Resolves to | Has `Bash`? |
|---|---|---|
| `readOnly` | `READONLY_CODE_TOOLS` (cyrus-core) | narrowed — read-only `git`/`gh` only |
| `safe` | `getSafeTools()` (cyrus-claude-runner) | **no** |
| `all` | `getAllTools()` | yes |
| `coordinator` | `getCoordinatorTools()` | yes |

> ### ⚠️ `safe` means "no shell", not "sensible default"
>
> `getSafeTools()` is literally `availableTools.filter(t => t !== "Bash")`. A persona configured
> `safe` can edit files and then has **no way to run the tests, the linter, `git`, or
> `gh pr create`** — it can write code and cannot verify or ship it.
>
> This is [CYR-21](https://linear.app/linkedlist/issue/CYR-21). It was latent until PR #8 made the
> SDK `tools` option derive from `allowedTools`; before that a `safe` session kept `Bash` by
> accident, so the preset's name was never tested against its behaviour. **Any persona that has to
> *do* something wants `all`, not `safe`** — the deployed config uses `all` for exactly this reason.
>
> `safe` is only right for a persona that produces text and nothing else — and for those,
> `readOnly` is usually the better answer, because it grants the narrow read-only `git`/`gh`
> commands an investigator actually needs.

**MCP tools are not affected by the preset.** None of `getAllTools()` / `getSafeTools()` contains
an `mcp__` entry, which looks like it would leave a Wayfinder persona unable to claim its ticket.
It does not, for three separate reasons: `deriveBuiltInTools` skips `mcp__` entries outright (*"MCP
tools are not governed by `tools`"*, `built-in-tool-restrictions.ts:178`); `canUseTool` intercepts
only restricted `Bash` and `AskUserQuestion`, returning `allow` for everything else; and
`deriveBuiltInDisallowedTools` never emits an `mcp__` deny rule. `READONLY_CODE_TOOLS` lists the
prefixes explicitly anyway, so the read-only path does not rely on that reasoning.

**`readOnly` changed in CYR-37.** It previously resolved to `SLACK_DEFAULT_ALLOWED_TOOLS` — the
Slack *chat* toolset, which has no `Grep`, no `Glob`, and no git inspection commands. A `scoper`
configured `readOnly` therefore could not search the codebase it was scoping; it could only `Read`
paths whose names it already knew. `READONLY_CODE_TOOLS` is the curated read-only *code* set:

- `Read`, `Glob`, `Grep`
- `Bash(git log:*)`, `Bash(git diff:*)`, `Bash(git show:*)`, `Bash(git status:*)`,
  `Bash(git blame:*)`, `Bash(gh pr view:*)`, `Bash(gh pr diff:*)` — enumerated individually, never
  `Bash(git:*)`, which would also permit `git push`
- `WebFetch`, `WebSearch`
- `Task` and the task-lifecycle tools — an investigator fans out; a reviewer does not
- `Skill`, `ToolSearch`, `Monitor`
- `mcp__linear`, `mcp__cyrus-tools`, `mcp__cyrus-docs`

`mcp__linear` is included deliberately, for the same reason it is included for a review: a
read-only persona must still claim its ticket, post its answer, and update the map. That is a
write to the issue tracker, never to code.

**Slack chat is unaffected by the repoint.** `buildChatAllowedTools()` reads
`SLACK_DEFAULT_ALLOWED_TOOLS` directly and never routes through `resolveToolPreset`.

Pair `readOnly` with `REVIEW_DISALLOWED_TOOLS` (or an equivalent `disallowedTools` array) when the
read-only property has to be enforced rather than merely configured — a deny rule beats an allow
rule, and beats Claude Code's internal read-only pre-approval, which `allowedTools` alone does not.
See the comment on `MUTATING_BASH_DENY_RULES` for the measurement behind that.

## Flow — how a persona is chosen

1. An issue is assigned to Cyrus. `EdgeWorker` collects its labels.
2. `PromptBuilder.determineSystemPromptFromLabels` iterates the session's repositories in array
   order. **First match wins**; a later repository matching a *different* persona logs a conflict
   warning and is ignored.
3. Within one repository, `matchSystemPromptForRepo` checks, in this order:
   1. `graphite-orchestrator` — requires **both** a graphite label and an orchestrator label.
   2. `wayfinder`, `wayfinder-task`, `scoper`, `refactorer`, `debugger`, `builder`, `orchestrator`.
      The constraining personas come first, then the ones that describe subject matter. (This list
      previously read `wayfinder, wayfinder-task, debugger, builder, scoper, orchestrator`, which
      had not matched the code since `scoper` was moved ahead of `debugger`.)
4. The matched prompt is read from `packages/edge-worker/prompts/<type>.md`, resolved relative to
   the compiled module (`join(__dirname, "..", "prompts", …)`).
5. `ToolPermissionResolver` resolves the tool policy for that persona through its five-rung ladder:
   repository `labelPrompts[type].allowedTools` → global `promptDefaults[type].allowedTools` →
   repository `allowedTools` → workspace `linearAllowedTools` → the platform default.

### Why the Wayfinder pair is first in the array

Order in that array is a behavioural decision, not tidiness. A `wayfinder:*` label describes **how
the session must behave** — plan rather than build, resolve one ticket, never self-answer a HITL
question — which has to beat a label that merely describes the subject matter. An issue labelled
both `Bug` and `wayfinder:research` is a research question *about* a bug; if `debugger` won, the
session would arrive with write tools and an instruction to ship a fix.
`PromptBuilder.persona-routing.test.ts` pins this.

### `review` is deliberately outside all of this

`EdgeWorker` passes `undefined` for both `labels` and `issueDescription` when it builds a review
session, precisely so that a label cannot reshape a review, and it bypasses the five-rung ladder
with a hardcoded `REVIEW_ALLOWED_TOOLS` + `REVIEW_DISALLOWED_TOOLS`. **Do not add `review` as a
`labelPrompts` key.** It is the template for the other personas, not a peer of them.

## The Wayfinder personas

[Wayfinder](https://www.aihero.dev/skills-wayfinder) plans a body of work too large for one agent
session as a **map** issue (`wayfinder:map`) whose child tickets are questions whose resolution is
a *decision*, not a slice of a build. Cyrus is the worker on that map; the interactive `/wayfinder`
session stays the cartographer.

The split between the two personas is **the write boundary**, so that Wayfinder's two rules most
likely to be violated are enforced by configuration rather than by prose:

| Label | Persona | Tools | Why |
|---|---|---|---|
| `wayfinder:map` | `wayfinder` | `readOnly` | Charting is a human act |
| `wayfinder:research` | `wayfinder` | `readOnly` | Research must not implement |
| `wayfinder:grilling` | `wayfinder` | `readOnly` | "A grilling agent that answers its own questions has broken this" |
| `wayfinder:task` | `wayfinder-task` | `all` | The one ticket type that *does* |
| `wayfinder:prototype` | `wayfinder-task` | `all` | Needs to build the throwaway artifact |

**`wayfinder-task` is `all`, not `safe`** — see the CYR-21 warning under *Tool presets*. A task
ticket's whole purpose is to *do* the thing that unblocks a decision: provision the access, move
the data, stand up the rough prototype. `safe` withholds `Bash`, so such a session could not run a
single command. This document said `safe` when it was first written; the deployed config was
already `all`, and reading the live config before applying it is what caught the discrepancy.

Both prompts carry the same protocol:

- **Claim first** — assign the ticket before any work, so concurrent sessions skip it.
- **At most one ticket per session** (research excepted, because independent reads compose).
- **Resolve** = resolution comment on the ticket → close it → append one line (gist + link) to the
  map's *Decisions so far*. The map is an index, not a store.
- **Refer to tickets by name**, never a bare `#42`.
- **Out of scope ≠ resolved** — cancel the ticket and log it under *Out of scope*.
- **Never cite the map's identifier** in a commit message, PR body, or branch name, and re-assert
  the map's Backlog state in the same `save_issue` that appends to *Decisions so far*. This one is
  ours, not Matt Pocock's: Linear's GitHub integration reads identifiers out of commits and pushes
  and will silently move the map out of Backlog. Observed on Racemappr's RAC-953, 2026-07-26.
- **A delegated ticket belongs to the session you delegated it to.**
  `mcp__cyrus-tools__linear_agent_session_create` hands over the claim, the resolution, the close and
  the map line, so the delegating session must not also work that ticket. It does not wait for the
  report either: `EdgeWorker.handleResumeParentSession` resumes the parent with the child's final
  message as a new prompt when the child finishes, so the parent keeps working its own tickets and
  ends its turn meanwhile. Also ours, not Matt Pocock's — the interactive `/wayfinder` session has no
  sub-agent to delegate to, while a Cyrus map session does. Observed on CYR-58, 2026-07-29: a map
  session delegated a child ticket and then resolved the same ticket itself.
- **`wayfinder:research` may resolve several tickets, and delegation is not a resolution** — the
  one-ticket limit counts the tickets the session resolves itself, so one session may delegate many.

These rules previously lived in a ~1,200-character `appendInstruction` string duplicated into every
repository's config entry. They now live in the personas, and that string can be deleted.

## The refactorer persona

`refactorer` is the persona that runs **after** a code review, to act on the complexity findings the
review produced. It is the write-capable other half of `review`: the reviewer can name a method that
is too complex but cannot touch it, and the builder that wrote the method has already moved on.

It is label-routed like every other persona — it is **not** chained automatically off the end of a
review. A review posts its findings to the issue; a human (or an orchestrator) then applies the
`Refactor` label, and the next session arrives as the refactorer. Nothing in `EdgeWorker` triggers
it on review completion, and this document does not claim it does.

```json
"refactorer": { "labels": ["Refactor"], "allowedTools": "all" }
```

**`all`, not `safe`.** The persona must run the tests to prove behaviour did not change, so it needs
`Bash` — see the `safe` warning above.

Three properties are load-bearing:

- **It reads the review before it edits.** The prompt requires a completed review and tells the
  session to stop and say so when it cannot find one. A refactorer that invents its own targets is
  just an unreviewed rewrite.
- **Behaviour must not change.** Same outputs, same exception types, same error messages. The tests
  are the evidence, so the prompt requires a green run before the refactor as well as after, and a
  characterisation test first where coverage is missing.
- **Only what the review flagged.** Findings that need a design decision rather than an extraction
  are reported, not acted on.

### The skill's parameters are not filled in for you

The persona's primary skill is
[`refactor-method-complexity-reduce`](https://github.com/github/awesome-copilot), vendored into
`.agents/skills/` and bundled into the runtime plugin, so it is available in **every** session on
every repository — not only in this one.

The skill comes from a Copilot prompt library, and its text carries the literal placeholders
`${input:methodName}` and `${input:complexityThreshold}`. **Nothing substitutes them.** Claude Code
has no equivalent of Copilot's `${input:…}` prompting, so a session that invokes the skill bare gets
instructions with no target method and no threshold. The persona prompt therefore tells the session
to state both values in the invocation, and
`PromptBuilder.persona-routing.test.ts` fails if that instruction is removed. The default threshold
is a cognitive complexity of **15** where the issue or the review does not name one.

## Checking a config: `cyrus personas`

Run it wherever a real `config.json` lives — in the container that is
`/root/.cyrus/config.json`. It answers "which persona would this issue get, and what tools would
it have?" by putting a label set through the **real** `PromptBuilder` and `ToolPermissionResolver`,
not a second copy of the rules.

```bash
cyrus personas                            # matrix over every configured label, plus the no-label case
cyrus personas "Bug,wayfinder:research"   # one label set
cyrus personas --repo job-boards          # narrow to one repository
cyrus personas --json                     # machine-readable
```

For each combination it prints the persona, prompt file, version tag, whether the session can
write, whether it has a shell, and the tool counts.

**It raises two warnings, and both are defects that actually shipped:**

- **A persona that can write but has no shell.** This is the `safe` preset trap described above — a
  session that can edit files and then cannot run the tests, the linter, `git`, or `gh`. Set
  `wayfinder-task` to `safe` and this fires immediately; that is the four-day discrepancy the
  command exists to make visible.
- **A prompt file with no `<version-tag>`**, whose sessions therefore log no `systemPromptVersion`
  — the `scoper.md` defect.

The value is that it reads the **deployed** config. A dry-run against a hard-coded fixture would
have agreed with this document and missed the drift, which is exactly what happened.

## Modules touched

| File | Change |
|---|---|
| `packages/core/src/allowed-tools-defaults.ts` | New `READONLY_CODE_TOOLS` |
| `packages/core/src/index.ts` | Exports it |
| `packages/core/src/config-schemas.ts` | `wayfinder` + `wayfinder-task` in `LabelPromptsSchema` and `PromptDefaultsSchema` |
| `packages/core/schemas/*.json` | Regenerated (`pnpm --filter cyrus-core generate:json-schema`) — generated, never hand-edited |
| `packages/edge-worker/src/ToolPermissionResolver.ts` | `readOnly` repointed; `PromptType` widened |
| `packages/edge-worker/src/PromptBuilder.ts` | `SystemPromptResult["type"]` widened; `promptTypes` array reordered |
| `packages/edge-worker/src/EdgeWorker.ts` | Four prompt-type unions widened |
| `packages/edge-worker/src/prompts/failureModePromptAddendum.ts` | Doc comment: 5 → 7 flavors |
| `packages/edge-worker/prompts/wayfinder.md` | New |
| `packages/edge-worker/prompts/wayfinder-task.md` | New |
| `packages/edge-worker/prompts/builder.md` | Rewritten, 192 → 74 lines |
| `packages/edge-worker/prompts/debugger.md` | Rewritten, 129 → 69 lines |
| `packages/edge-worker/prompts/scoper.md` | Rewritten; version tag added |

`orchestrator.md`, `graphite-orchestrator.md` and `reviewOnStatusPrompt.ts` are unchanged.

No build change was needed: `packages/edge-worker`'s `copy-prompts` script already does
`cp -r prompts dist/`, and the runtime resolves prompts relative to the compiled module.

## Tests

| Test | Covers |
|---|---|
| `PromptBuilder.persona-routing.test.ts` › routes the three read-only wayfinder labels | `wayfinder:map`/`:research`/`:grilling` → `prompts/wayfinder.md`, read from disk |
| › routes the two write wayfinder labels | `wayfinder:task`/`:prototype` → `prompts/wayfinder-task.md` |
| › prefers wayfinder over debugger | `Bug` + `wayfinder:research` → `wayfinder` (the array ordering) |
| › prefers wayfinder-task over builder | `Feature` + `wayfinder:prototype` → `wayfinder-task` |
| › leaves non-wayfinder routing untouched | `Bug`/`Feature`/`Scoper` still route as before |
| › matches wayfinder labels case-insensitively | `Wayfinder:Research` → `wayfinder` |
| › parses a `<version-tag>` out of every prompt file | Every persona prompt is versioned, and the version names its own file |
| `ToolPermissionResolver.allowed-tools-fallback.test.ts` › scoper with `readOnly` can search | `Grep`/`Glob`/`Bash(git log:*)` present, `mcp__linear` present, `Write`/`Edit`/`NotebookEdit` absent |
| › no unnarrowed Bash and no mutating git | The allow-list carries no bare `Bash`, no `Bash(git:*)`, no `Bash(gh:*)` |
| › expands a repo-level `readOnly` preset string | Rung 3 of the ladder resolves to the new set |
| `EdgeWorker.dynamic-tools.test.ts` › repository-specific prompt type config | Rung 1 resolves `readOnly` to the new set |
| `EdgeWorker.multi-repo-tools.test.ts` › union across repos | Multi-repo union uses the new set |
| `json-schema-export.test.ts` › promptDefaults keys | The two new keys reach the generated schema |

The `<version-tag>` test was mutation-checked: stripping the tag from `scoper.md` fails it with
*"scoper.md has no `<version-tag>`"*. That is the regression the original `scoper.md` needed.

Suite state: `cyrus-edge-worker` 888 passed (76 files); `cyrus-core` 150 passed (12 files); all
other packages green. Two pre-existing, unrelated failures exist on `main` and still do:
`cloudflare-tunnel-client` has no test directory and a bare `vitest` script, and
`cursor-runner`'s `test:run` hardcodes an unresolvable vitest path.

## Verified vs assumed

- **Verified by unit test:** label → prompt-file routing for all seven personas, including the
  ordering guarantee and case-insensitivity; that every prompt file on disk carries a correctly
  named version tag; that `readOnly` now yields `Grep`/`Glob`/git-log and still yields
  `mcp__linear` while withholding `Write`/`Edit`/`NotebookEdit`, at every rung of the ladder that
  can produce it.
- **Verified by inspection of the loader:** prompts resolve from
  `join(__dirname, "..", "prompts", …)`, so both the source tree and the container (which builds
  from source via `COPY . .` + `pnpm build`) read `packages/edge-worker/prompts/*.md`. The
  `dist/prompts/` copy the build also produces is for npm consumers and is not what the running
  worker reads.
- **Verified by regenerating:** the JSON schema diff is pure addition — the two new keys and
  nothing else.
- **Assumed, not verified:** that the rewritten prompts produce better sessions. Prompt quality is
  not unit-testable. The output contracts are the verification surface — check a session's posted
  message against the contract for its persona.
- **Not verified:** any behaviour of a live Linear workspace. No end-to-end run was performed as
  part of this change.

## Known limitations

- **Deleting the Task-tool mandate is a real behaviour change.** `builder` and `debugger` sessions
  previously carried ~150 lines instructing them to route every file read through a `Task`
  subagent. They will now read files directly, which uses more context per session and may change
  where long sessions hit their limit. The rewritten prompts still point at `Task` for broad
  parallel search; they no longer forbid direct reads. Watch the first few runs.
- **Repointing `readOnly` changes production behaviour** for every repository whose config sets it
  — currently the `scoper` entry on all three deployed repositories. That is the intent, but it is
  a tool-policy change riding alongside a prompt sweep.
- **Skill routing is best-effort.** A persona naming `/implement` in a repository that lacks it
  falls back to the inline guidance. Nothing verifies the skill exists before the prompt names it.
- **The prompt-type union is repeated across ~8 files.** A missed site is a compile error, not a
  silent runtime failure — but the JSON schemas are generated separately, and forgetting to
  regenerate them makes the config reject the new keys at load time rather than at build time.
- **HITL only works if a human tends the Linear thread.** A `wayfinder:grilling` or
  `wayfinder:prototype` ticket assigned to Cyrus will correctly stall waiting for a reply. If
  nobody answers, the ticket stays open and assigned — by design, but it looks like a hang.
- **Nothing enforces "one ticket per session" mechanically.** It is a prompt rule. The write
  boundary is enforced by tool policy; the ticket count is not.
