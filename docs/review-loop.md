# The NightShift review loop

One task at a time moves through Researcher → Builder → Reviewer, with a person
approving any push, merge, PR or deploy. The code is `server/review-loop/`.

## Tasks

Tasks live in `<data>/work-tasks.json`, written like `bots.json` and
`groups.json` (whole file, temp file, fsync, rename, owner-only). A task has
`id`, `slug`, `title`, `description`, `project` (the repository path),
`room_id`, `owner_bot_id`, `status` (`To Do`, `Working`, `Needs Review`,
`Done`, `Blocked`), `tags`, `research_path`, `handoff_path`, `branch`
(`feat/<slug>`), `base_branch`, `worktree_path`, `review_round`,
`review_notes`, `reviewed_head`, `diff_override`, `blocked_reason`,
`token_usage` (per role), `approvals`, `created_by`, `created_at`, and
`updated_at`.

## Routing

The bots are found by their names in `nightshift/team.yaml`: Researcher,
Builder, Reviewer and Keeper.

| Task | Goes to | What happens |
| --- | --- | --- |
| `To Do` + `research` | Researcher | `Working`. Writes `docs/research/<slug>-YYYY-MM-DD.md` (the date once: a slug that has one keeps it) in the task worktree, cites each URL with "accessed YYYY-MM-DD", marks unverified claims `UNVERIFIED`, and ends its turn. The server then finishes it as `research.done`, recorded as the Researcher, which sets `To Do` + `dev`; no packet, or one the check refuses, sets `Blocked` and tells Keeper ([the Researcher's allow-list](nightshift-routines-memory.md#the-researchers-allow-list)). |
| `To Do` + `dev` | Builder | `Working` on `feat/<slug>` in its own worktree. Commits `docs/handoffs/<slug>.md`; `build.done` then sets `Needs Review` + `review`. |
| `Needs Review` + `review` | Reviewer | `review_round` + 1. Reviews the diff only. `review.approve` sets `Done` and tells Keeper. `review.changes` (with `file:line` notes) sends it back to `To Do` + `dev`. In round 3, it sets `Blocked` instead. |

Changing a task's status or tags routes it again. With no bot for a role, the
task is set to `Blocked`. Only the task's current owner, or a person, can move it
on. Only a person or Keeper can `stop`, `resume` or `reassign` it, and only a
person can reset the review rounds or allow a larger diff.

## Guardrails

- **Handoff packet.** `build.done` refuses a packet that is missing any of
  these sections:
  - Files changed (with `path:line`)
  - Decisions
  - Tests (including what was not run)
  - Risky / unsure
  - Do not re-read

  It also refuses a fenced block over 30 lines (a pasted file) and a packet over
  250 lines.
- **Diff size.** If `base...feat/<slug>` changes more than 400 lines or more
  than 10 files, the task is set to `Blocked`, asking for a split. Only a
  person's `task update --allow-large-diff` lets it through.
- **Diff-only review.**
  - Round 1 reads the handoff packet, `git diff --stat base...branch`,
    `git diff base...branch`, the touched files, and their direct imports and
    tests.
  - Round 2 and later read only `git diff <last reviewed head>..branch`.
- **Branch per task.** Each task's worktree is at
  `<data>/worktrees/<slug>`. Nothing checks out, commits or pushes in the base
  checkout.
- **Push, merge, PR or deploy.** `task request-approval` works only on a
  `Done` task. It posts an approval card with the exact diff and its sha256,
  in the task's room or Keeper's chat.
  - Answer the card, or run `task approve-diff --sha256`.
  - The answer is recorded and audited. If the branch changes after the card
    was shown, the request goes stale.
  - The loop never pushes or merges. The person does.

## Audit

Every event is written to the admin activity log (`<data>/admin-activity/`)
with category `task`. The events are: created, assigned, branch-created,
research-written, handoff-written, review-started, review-approved,
review-changes, review-cap, split-flagged, blocked, resumed, reassigned, usage
(tokens per role, from the usage ledger or a manual transition), diff-approval-requested, diff-approval-decided, deleted,
routine-started, redispatched, interrupted.

## Routines, restarts and MEMORY.md

A Keeper routine whose prompt starts with `NightShift research:` creates a
research-only task (tags `research` + `routine`) that ends at `Done` once the
packet is written, and Keeper reports it. A restart hands a task a bot was
working on back to it once. A bot's branch may not change `MEMORY.md`; Keeper
proposes changes as a diff a person approves. See
[NightShift routines and team memory](nightshift-routines-memory.md).

## Token usage

Every turn the usage ledger books (`<data>/usage/`) is also booked on the task
its bot is working on, as `token_usage.<role>` and a `task.usage` audit event
with `source: "ledger"`. The role's counts add up `inputTokens`,
`outputTokens`, and, when the engine reports them, `cachedInputTokens`,
`cacheWriteTokens` and `reasoningTokens`, with `turns` and the `models` used.

- A bot's turns count for the task and role the loop last handed it, including
  the turn that ends with its own transition. After that, its turns count for
  nothing until it is handed a task again.
- Only turns in the bot's own chat, or in a routine task's own Researcher
  conversation, count: that is where the loop hands it its turns.
- A turn whose engine reported no tokens books nothing.
- After a restart, a bot that still owns a task books on that task.

The manual `usage` transition still adds to the same counts, with
`source: "manual"`.

## Driving it

```sh
openmausbot task create "Fix docs typo" --project . --tags research --room ROOM_ID
openmausbot tasks
openmausbot task show fix-docs-typo
openmausbot task transition fix-docs-typo research.done --research-path docs/research/fix-docs-typo-2026-11-20.md --as-bot RESEARCHER_ID
openmausbot task transition fix-docs-typo build.done --as-bot BUILDER_ID
openmausbot task transition fix-docs-typo review.approve --as-bot REVIEWER_ID
openmausbot task transition fix-docs-typo usage --role reviewer --input-tokens 1200 --output-tokens 300
openmausbot task request-approval fix-docs-typo --action push
```

The REST endpoints:

- `GET /api/tasks`
- `POST /api/tasks`
- `GET`, `PATCH` and `DELETE /api/tasks/:id`
- `POST /api/tasks/:id/transition`
- `POST /api/tasks/:id/request-approval`
- `POST /api/tasks/:id/approve-diff`

**Open risk:** a bot's shell reaches the server as loopback, just like the
person's CLI. `as_bot` names the bot (every prompt the loop gives a bot names
it), and a loopback call without it counts as the person. An approval of a
diff, by `approve-diff` or on its card, is therefore taken from a command on
this computer only while every bot is idle; a signed-in session approves at
any time ([who may approve](nightshift-routines-memory.md#who-may-approve)).

## Verifying it

`server/review-loop/*.test.ts` cover the store, the routing, the 3-round cap,
the handoff validator, the diff gate, worktree isolation, diff approval, the
audit events, token usage from the ledger and the HTTP routes.

On a verification fixture (`scripts/control-omb.ts launch`), the server's PATH
holds only `node`. To let the loop run git there, set `NIGHTSHIFT_GIT` to an
absolute path to git; nothing else crosses. Without it, a new task is set to
`Blocked` with `could not create feat/<slug>: spawnSync git ENOENT`.
