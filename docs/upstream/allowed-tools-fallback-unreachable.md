# Upstream report — the platform-default `allowedTools` fallback is unreachable

**Status:** not filed upstream. This is a written-up report for `cyrusagents/cyrus`;
whether to open an issue or PR there is William's call, not the agent's.

**Affected upstream commits:** `5d171dc`, `28bc725` (May 2026)
**Found in fork:** LinkedListLLC/cyrus, tracked as
[CYR-28](https://linear.app/linkedlist/issue/CYR-28)

## Summary

Two lines in two packages combine so that `ToolPermissionResolver`'s final
fallback — the per-platform default allow-list — is dead code. In the default
configuration (nothing sets `LINEAR_ALLOWED_TOOLS` and nothing sets
`linearAllowedTools` in `config.json`), a session that does not match an
earlier rung of the priority ladder resolves to an **empty** allow-list.

## The two lines

`apps/cli/src/services/WorkerService.ts`

```ts
linearAllowedTools:
    process.env.LINEAR_ALLOWED_TOOLS?.split(",").map((t) => t.trim()) ||
    edgeConfig.linearAllowedTools ||
    [],                                  // <-- unconfigured becomes an EMPTY ARRAY
```

`packages/edge-worker/src/ToolPermissionResolver.ts`, `buildAllowedToolsForRepo`

```ts
// 4. Workspace default allowed tools
if (this.config.linearAllowedTools) {          // <-- [] is TRUTHY
    return this.config.linearAllowedTools;
}
// 5. Final fallback — Linear platform default.
return [...LINEAR_DEFAULT_ALLOWED_TOOLS];      // <-- UNREACHABLE
```

The CLI turns "not configured" into `[]`; the resolver reads a present-but-empty
list as "the operator chose to allow nothing" and returns it, so rung 5 can
never run.

The same unguarded pattern appears once more in the zero-repository branch of
`buildAllowedTools`, where `??` also fails to catch `[]`:

```ts
const baseTools = this.config.linearAllowedTools ?? [...LINEAR_DEFAULT_ALLOWED_TOOLS];
```

### The asymmetry that makes this clearly unintentional

Every sibling path in the same file already guards correctly:

| path | guard |
|---|---|
| `buildChatAllowedTools` (`slackAllowedTools`) | `&& …length > 0` ✅ |
| `buildGithubAllowedTools` (`githubAllowedTools`) | `&& …length > 0` ✅ |
| `WorkerService` `defaultDisallowedTools` | defaults to `undefined` ✅ |
| `buildAllowedToolsForRepo` rung 4 (`linearAllowedTools`) | bare truthiness ❌ |

Only the Linear allow-list path is missing the guard, on both sides of the wire.

## Severity upstream vs. in this fork

Upstream this is **latent**. `allowedTools` is only an auto-approve list there,
so an empty list means "auto-approve nothing" — every tool still needs
confirmation, but the session is not crippled.

In this fork it is **critical**. [CYR-15 / PR #8](https://github.com/LinkedListLLC/cyrus/pull/8)
made the SDK `tools` option derive from `allowedTools`, which converts "approve
nothing" into "**have** nothing". Confirmed live before the fix: a `builder`
session and an unlabelled session each came back with only
`["AskUserQuestion", "Glob", "Grep", "Read"]`.

Upstream should still want the fix — rung 5 being unreachable is a bug on its
own terms, and any future change that gives `allowedTools` teeth inherits the
critical version of it.

## Reproduction

Measured against the real resolver at fork commit `61bfc2a`, no repo-level
`allowedTools` set. `allowed` is the resolved list length; `tools` is
`deriveBuiltInTools(allowed).length`.

| `linearAllowedTools` | prompt type | allowed | tools |
|---|---|---|---|
| `[]` | builder / orchestrator / debugger / none | **0** | **0** |
| absent | builder / orchestrator / debugger / none | 33 | 31 |
| `[]` | scoper (has `allowedTools: "readOnly"` on the label) | 20 | 18 |

`scoper` is unaffected only because a label-level `allowedTools` returns at
rung 1 and never reaches the bug. Any prompt type without an explicit
label-level list is affected, including the unlabelled default session.

## A third defect, same shape — rung 3

Rung 3 returns `repository.allowedTools` verbatim, but `resolveToolPreset` only
runs at rungs 1 and 2. A repo-level preset *string* is therefore treated as one
literal tool name:

```
repository.allowedTools = "all"   -> allowed=1  tools=0   (silently nothing)
repository.allowedTools = [...33] -> allowed=33 tools=31  (correct)
```

Note that `RepositoryConfigSchema` types this field as `z.array(z.string())`, so
a preset string is not valid per the schema. It is still reachable at runtime:
**neither config loader validates against the Zod schema.** Both
`ConfigService.load()` (apps/cli) and `ConfigManager.loadConfigSafely()`
(packages/edge-worker) do a raw `JSON.parse` and cast. A hand-edited or
server-pushed `config.json` reaches the resolver unchecked. Whether to fix the
absent validation is a separate, larger question — the resolver should not
silently resolve to zero tools either way.

## Fix applied in this fork

1. Guard rung 4 on a non-empty array: `if (this.config.linearAllowedTools?.length)`.
2. Guard the zero-repository branch the same way.
3. Change the CLI default from `[]` to `undefined`, matching the
   `defaultDisallowedTools` line directly beneath it.
4. Pass rung 3 through `resolveToolPreset`. It returns arrays unchanged
   (`if (Array.isArray(preset)) return preset`), so it is idempotent and does
   not violate rung 3's documented "verbatim — no platform-default merging"
   contract; it only expands preset strings that would otherwise resolve to
   nothing.
5. Parse `LINEAR_ALLOWED_TOOLS` / `DISALLOWED_TOOLS` so that an empty or
   blank-only value means "unset". `"".split(",")` yields `[""]`, which is
   truthy and a bogus one-entry allow-list — the same class of defect.

Items 1 and 3 are both required. Either alone leaves the trap set for the next
caller: the resolver guard alone still lets a literal `"linearAllowedTools": []`
in `config.json` wipe out tools, and the CLI change alone leaves the resolver
mis-reading an empty list from any other source.
