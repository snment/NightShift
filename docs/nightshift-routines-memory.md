# NightShift routines and team memory

Phase 2 adds three things on top of the [review loop](review-loop.md) and the
routine engine ([routine schedules](routine-schedules.md)):

- routines declared in the team file and applied with `team apply`;
- a research routine that runs through the review loop while nobody is there;
- `MEMORY.md` changes that are shown as a diff and saved only after a person
  approves them.

Nothing here pushes, merges, deploys, sends, pays or deletes. Every bot stays
at Ask.

## Routines in the team file

A team file may list `routines`. Each is a cron routine for one bot in the
file:

```yaml
routines:
  - name: Weekly agent tooling scan
    bot: Keeper
    schedule: { cron: "0 6 * * MON", timeZone: UTC }
    research:
      title: Agent tooling scan
      base: nightshift/phase0
      description: |
        What changed in the last week in the engines the bots run on.
    enabled: true
```

- `schedule` is the routine engine's cron (five fields, an IANA time zone),
  checked when the file is read: a bad expression is a usage error.
- Give a routine either `prompt` (text or `{ file: PATH }`) or a `research`
  block, not both. A `research` routine belongs to Keeper.
- `enabled` turns a new routine on or off. Left out, a new routine is turned
  on and an existing one keeps its switch.
- `team apply` creates a routine that is missing (matched by bot and name) and
  changes the prompt, schedule or switch of one that differs. It never deletes
  a routine. `team apply --check` prints `No changes.` when the workspace
  matches, and `team export` writes the bots' cron routines back, so a file
  round-trips.

The routine itself is an ordinary routine: the Automations list shows it,
and its catch-up after downtime, its ledger and its restart rules are the
engine's.

## The research routine

A `research` block is stored as the routine's prompt, starting with the line
`NightShift research: <title>`, then an optional `Base: <branch>` line, then
the description (`server/review-loop/routine-research.ts`).

When a run of Keeper's routine starts with that line:

1. The server creates a review-loop task in plain code, before any AI turn:
   title `<title> YYYY-MM-DD`, the description, project = Keeper's folder
   (`cwd`), base = the `Base:` branch, tags `research` + `routine`. A run
   creates one task only: a rerun of the same run (after a crash or a retry)
   gets the same task back.
2. Keeper's turn for the run is a one-line prompt: say the task was started.
3. The loop hands the task to the Researcher in its own chat, as for any
   research task. The Researcher writes `docs/research/<slug>-YYYY-MM-DD.md`
   in the task's worktree and runs `task transition … research.done`.
4. A `routine` task ends at `Done` there: it does not go on to the Builder.
   Keeper is handed the result in its own chat, reports it to the person, and
   may propose a `MEMORY.md` change.

If the task cannot be made (Keeper has no folder, no git), Keeper's turn says
why instead. Any tool the Researcher wants that needs approval waits as an
approval card, as at Ask everywhere.

A routine owned by any other bot, or whose prompt does not start with that
line, runs as an ordinary routine.

### Events

The routine engine starts runs from a schedule, a webhook or a connected-app
event; it has no trigger for the review loop's own events. The loop already
acts on them directly: when a task reaches `Done` (a review approved, or a
routine's research written), Keeper is handed the task with an instruction to
report it and to propose any memory change. That is the "task Done → Keeper
reports and proposes memory" event. A routine started by a review-loop event
would need a new trigger kind in `server/routines.ts`; it was not built.

## MEMORY.md: diff before save

`MEMORY.md` at a repository's root is the team's memory. Keeper owns it.

```sh
openmausbot team-memory propose --project . --file /tmp/memory.md --summary "Note the routine" --as-bot KEEPER_ID
openmausbot team-memory proposals
openmausbot team-memory show ID
openmausbot team-memory decide ID --sha256 SHA --approve   # or --deny
```

- A proposal is the whole new file. The server works out the diff against
  the current `MEMORY.md` and posts it on an approval card in Keeper's chat,
  with the sha256 of the proposed text.
- Nothing is written until a person approves: on the card, or with
  `team-memory decide` naming the sha256. A denied proposal, or one still
  waiting, leaves the file untouched.
- If `MEMORY.md` changed after the diff was shown, the approval goes stale
  and nothing is written; Keeper proposes again. A newer proposal for the same
  repository makes an older pending one stale.
- Only Keeper (or a person) may propose. A bot's branch that changes
  `MEMORY.md` is refused at `research.done` and `build.done`.
- A proposal whose added lines look like a key, a token or a password (the
  credential shapes in `shared/redact.ts`) is refused, and nothing is stored.
- Proposals are kept in `<data>/memory-proposals.json`, written whole, so a
  pending one survives a restart and its card still answers.

REST: `GET`, `POST /api/team-memory/proposals`,
`GET /api/team-memory/proposals/:id`,
`POST /api/team-memory/proposals/:id/decide` (`decision`, `proposed_sha256`).

**Open risk:** as for the diff approval, a bot's shell reaches the server as
loopback, and a loopback call without `as_bot` counts as the person. The card
is the approval path a bot's shell cannot answer for the person.

## Restarts

- **Routine runs** follow the engine's rules: a run cut by a restart is picked
  up once in the same conversation, and schedules catch up after downtime
  ([routine schedules](routine-schedules.md)). A research run that already made
  its task gets the same task back.
- **Review-loop tasks.** A minute after the server starts, every task a bot
  was working on (`Working`, or `Needs Review` with a Reviewer) whose bot is
  idle is handed back to that bot, told that it was cut off and to check what
  it already did (`task.redispatched`). If a second restart cuts the same
  hand-over, the task is set to `Blocked` as interrupted and Keeper tells the
  person (`task.interrupted`); a person resumes it. A task the restart caught
  after it was saved but before it was handed out (`To Do`, tagged `research`
  or `dev`, no owner) is handed out then, and a rerun of its routine run hands
  it out too.
- **Memory proposals** are on disk; a pending one is still pending.

## Audit

The admin activity log gets:

- category `task`: `task.routine-started` (routine id, name and run id),
  `task.redispatched`, `task.interrupted`, beside the Phase 1 events;
- category `memory`: `memory.proposed`, `memory.approved`, `memory.denied`,
  `memory.stale`, `memory.refused` (reason `not-keeper` or `secret`, with the
  line numbers). The rows carry the project and the sha256 hashes, never the
  file's text.
