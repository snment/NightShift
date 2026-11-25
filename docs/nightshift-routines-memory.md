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
  checked when the file is read: a bad expression is a usage error. The
  starter team's Monday 06:00 UTC is 01:00 on Monday in America/Toronto
  (02:00 while daylight saving time is on).
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
   gets the same task back. While an earlier task of the same routine is still
   open (any status but `Done`, `Blocked` included), a new run starts no task:
   Keeper says so in one line (`task.routine-still-open`).
2. Keeper's turn for the run is a one-line prompt: say the task was started.
3. The loop hands the task to the Researcher in its own chat, as for any
   research task. The Researcher writes `docs/research/<slug>.md` in the
   task's worktree with the Write tool (the slug already carries the date; a
   slug without one gets `-YYYY-MM-DD`), then ends its turn.
4. When the Researcher's turn in its own chat ends, the server looks for that
   packet. If it is there and passes the research check, the server finishes
   the task as `research.done` would, recorded as the Researcher. If there is
   no packet, or the check refuses it, the task is set to `Blocked` and Keeper
   tells the person. A Researcher turn that fails or cannot start (no engine,
   no computer) blocks the task the same way (`task.turn-failed`), so a task
   never sits at `Working` unseen.
5. A `routine` task ends at `Done` there: it does not go on to the Builder.
   Keeper is handed the result in its own chat, with the current `MEMORY.md`,
   reports it to the person, and decides on a memory change (below).

If the task cannot be made (Keeper has no folder, no git), Keeper's turn says
why instead.

### The Researcher's allow-list

Every bot runs at Ask, so every tool call that the engine leaves for a person
is an approval card. For the Researcher only, three kinds of call are answered
without one, so a research run finishes with nobody there:

```yaml
  - name: Researcher
    computer: off
    browser: false
    allowWithoutCard: [WebSearch, WebFetch, docs/research/]
```

- `WebSearch` and `WebFetch`: the engine's own web search and page fetch.
- `docs/research/`: Claude's `Write`, `Edit` and `MultiEdit` of a file under
  `docs/research/` of the worktree of the research task the Researcher is
  working on now. Each path must be absolute and, with every link followed,
  stay inside that folder: no `..`, no other folder, no junction or symbolic
  link out, no hard link, no Windows stream name, and `docs/research/` itself
  may not be a link.
- Only in the Researcher's own chat, where the loop hands it its turns.
- Everything else stays a card: a shell, a read, a write anywhere else, a
  question. No other bot may list `allowWithoutCard` (a usage error), and
  `team apply` takes these grants off any other bot that has them.

`team apply` stores the three as entries of the Researcher's "Always allow"
list (`nightshift-research:…`), so they show in its Settings and a person can
take them off there; `team export` writes them back and `--check` compares
them. The check is in `server/review-loop/research-allow.ts`, and the decision
log records each answer as `research-allowlist`.

The Researcher has no computer and no managed browser (`computer: off`):
on `computer: local` every turn fails on a server running without the desktop
app.

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

When the loop hands Keeper a finished task, its message carries the current
`MEMORY.md` and asks it to decide: keep something beyond this week (a model id
or tool the Builder must use or avoid, a breaking change, a retired tool), or
end with "No memory change." To propose, Keeper ends its reply with the whole
new file:

```text
<nightshift-memory summary="one line">
# Team memory
…
</nightshift-memory>
```

When that turn in Keeper's own chat ends, the server makes it a proposal from
Keeper, exactly as `team-memory propose --as-bot KEEPER_ID` would. Keeper calls
no tool for it, so it needs no approval card and runs while nobody is there;
the approval of the diff is still the person's. A block in any other bot's
reply, or in another chat, is ignored. A refused proposal (a secret, no
change) is said in Keeper's chat.

Keeper, a person, or a script may also propose from the command line:

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

### Who may approve

A bot's shell reaches the server as loopback, the same as the person's own
terminal, and a loopback call without `as_bot` counts as the person. So an
approval of a `MEMORY.md` change or of a diff (`team-memory decide`,
`task approve-diff`, or Allow on either card) is held to
`server/review-loop/human-approval.ts`:

- From a signed-in session (the app, a paired browser or device): always.
- From a command on this computer without a session: only while every bot is
  idle. A bot's shell runs only inside its own bot's turn, so its bot is busy;
  the refusal says to approve on the card in the signed-in app or browser, or
  again once every bot is idle.
- Under `OMB_LOOPBACK_TRUST=service`: never from a command on this computer.
- In the desktop app: as before; it already refuses every local change that
  does not come from its own window.
- A denial is always taken.

**Open risk:** on an owner-trust server (the self-hosted default), a bot's
shell can still pair itself a session through `/api/auth/pairing` and
`/api/auth/pair`, and then approve with that session. At Ask each of those
shell calls is an approval card a person sees. Running the server with
`OMB_LOOPBACK_TRUST=service` closes this as well (a local request may then
only decline a card, and cannot pair); the person then needs a signed-in
session to approve.

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
- **Token booking.** The bot each task last handed a turn to, and its role,
  are saved on the task (`turn_owners`). A turn that a restart cut across, or
  one that ends after the bot's own transition moved the task on, is booked on
  that task once from its usage-ledger row.

## Audit

The admin activity log gets:

- category `task`: `task.routine-started` (routine id, name and run id),
  `task.routine-still-open`, `task.redispatched`, `task.interrupted`,
  `task.turn-failed`, beside the Phase 1 events. Transitions the server makes
  for a bot (the Researcher's `research.done`) and those a bot runs with
  `--as-bot` (every prompt names it) are recorded as that bot, not the person;
- category `memory`: `memory.proposed`, `memory.approved`, `memory.denied`,
  `memory.stale`, `memory.refused` (reason `not-keeper` or `secret`, with the
  line numbers). The rows carry the project and the sha256 hashes, never the
  file's text.
