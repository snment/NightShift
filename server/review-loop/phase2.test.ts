import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_BOT_NAME } from "../../shared/default-bot.ts";
import { parseCommand } from "../headless/args.ts";
import { loadTeamFile } from "../headless/team-file.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { memoryAuditRow } from "./audit.ts";
import { localGit } from "./git.ts";
import { createNightShift, type LoopStore } from "./host.ts";
import { LoopError, ReviewLoop, type LoopActor, type TaskAuditEvent } from "./loop.ts";
import { MEMORY_APPROVAL_TOOL, secretLines, TeamMemory, type MemoryAuditEvent } from "./memory.ts";
import type { ReviewRole } from "./model.ts";
import { parseRoutineResearch, routineResearchPrompt } from "./routine-research.ts";
import { createWorkTaskRoutes } from "./routes.ts";
import { WorkTaskStore } from "./store.ts";

const ROLES = { researcher: "bot-res", builder: "bot-build", reviewer: "bot-rev", keeper: "bot-keep" } as const;
const PERSON: LoopActor = { kind: "person", id: "loopback" };
const bot = (role: keyof typeof ROLES): LoopActor => ({ kind: "bot", id: ROLES[role] });
const RESEARCH = "# Research\n\n- https://example.com/spec (accessed 2026-11-23)\n- Claim X: UNVERIFIED\n";
const MEMORY = "# Team memory\n\n## Conventions\n- Packets live in docs/research/.\n";

let root: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeRepo(): string {
  const path = join(root, "repo");
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  git(path, "config", "user.email", "test@example.test");
  git(path, "config", "user.name", "Test");
  git(path, "config", "commit.gpgsign", "false");
  writeFileSync(join(path, "README.md"), "hello\n");
  writeFileSync(join(path, "MEMORY.md"), MEMORY);
  git(path, "add", ".");
  git(path, "commit", "-q", "-m", "base");
  return path;
}

function commitIn(worktree: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(worktree, path)), { recursive: true });
    writeFileSync(join(worktree, path), text);
  }
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "work");
}

function harness(dataDir = join(root, "data")) {
  const store = new WorkTaskStore(join(dataDir, "work-tasks.json"));
  const audit: TaskAuditEvent[] = [];
  const dispatched: Array<{ role: ReviewRole; botId: string; prompt: string }> = [];
  const posts: string[] = [];
  const loop = new ReviewLoop({
    store, git: localGit, worktreeRoot: join(dataDir, "worktrees"), roles: () => ROLES,
    audit: (event) => audit.push(event), post: (_task, text) => posts.push(text),
    dispatch: (role, botId, _task, prompt) => dispatched.push({ role, botId, prompt }),
  });
  return { loop, store, audit, dispatched, posts };
}

const routineRun = (runId = "run-1") => ({
  routineId: "routine-1", routineName: "Weekly research", runId, title: "Agent tooling 2026-11-23", description: "What changed this week.", project: repo,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nightshift-p2-"));
  repo = makeRepo();
});

afterEach(() => {
  try { git(repo, "worktree", "prune"); } catch { /* best effort */ }
  removeTempDir(root);
});

describe("routine research", () => {
  it("writes and reads the research line, with and without a base branch", () => {
    const prompt = routineResearchPrompt({ title: "Agent tooling", description: "What changed.", base: "nightshift/phase0" });
    expect(prompt).toBe("NightShift research: Agent tooling\nBase: nightshift/phase0\n\nWhat changed.");
    expect(parseRoutineResearch(prompt)).toEqual({ title: "Agent tooling", description: "What changed.", base: "nightshift/phase0" });
    expect(parseRoutineResearch("NightShift research: Only a title")).toEqual({ title: "Only a title", description: "" });
    expect(parseRoutineResearch("Summarise my inbox")).toBeNull();
    expect(parseRoutineResearch("NightShift research:   ")).toBeNull();
  });

  it("starts a research-only task for the Researcher, once per run, and ends it at Done with a report from Keeper", () => {
    const h = harness();
    const task = h.loop.createForRoutine(routineRun());
    expect(task).toMatchObject({ status: "Working", owner_bot_id: ROLES.researcher, tags: ["research", "routine"], routine_run_id: "run-1", created_by: "routine:routine-1" });
    expect(h.loop.createForRoutine(routineRun()).id).toBe(task.id);
    expect(h.store.list()).toHaveLength(1);
    expect(h.dispatched.map((one) => one.role)).toEqual(["researcher"]);
    writeFileSync(join(task.worktree_path!, "packet.md"), RESEARCH);
    const done = h.loop.transition(task.id, { event: "research.done", research_path: "packet.md" }, bot("researcher"));
    expect(done).toMatchObject({ status: "Done", owner_bot_id: null, research_path: "packet.md", tags: ["routine"] });
    const report = h.dispatched.at(-1)!;
    expect(report.role).toBe("keeper");
    expect(report.prompt).toContain("packet.md");
    expect(report.prompt).toContain(`team-memory propose --project ${repo}`);
    expect(report.prompt).toContain(`--as-bot ${ROLES.keeper}`);
    expect(h.audit.map((event) => event.action)).toEqual(["task.created", "task.routine-started", "task.branch-created", "task.assigned", "task.research-written"]);
    expect(h.audit[1]!.detail).toEqual({ routineId: "routine-1", routineName: "Weekly research", runId: "run-1" });
    expect(h.dispatched.some((one) => one.role === "builder")).toBe(false);
  });

  it("gives Keeper's research routine a one-line prompt in place of its own, and leaves every other routine as it is", () => {
    const { store } = fakeStore();
    const sent: string[] = [];
    const ns = createNightShift({ dataDir: join(root, "data"), store, git: localGit, cwdOf: () => repo, audit: () => undefined, decide: () => undefined,
      send: async (_botId, _threadId, text) => { sent.push(text); } });
    const prompt = routineResearchPrompt({ title: "Agent tooling", description: "What changed." });
    const turn = ns.routineTurn({ id: "run-9", routineId: "r-1", routineName: "Weekly research", botId: "id-Keeper" }, prompt);
    expect(turn).toMatch(/started research task "Agent tooling \d{4}-\d{2}-\d{2}"/);
    expect(sent[0]).toContain("You are the Researcher");
    expect(ns.routineTurn({ id: "run-10", routineId: "r-2", routineName: "Other", botId: "id-Researcher" }, prompt)).toBeNull();
    expect(ns.routineTurn({ id: "run-11", routineId: "r-3", routineName: "Inbox", botId: "id-Keeper" }, "Summarise my inbox")).toBeNull();
    expect(ns.loop.list()).toHaveLength(1);
  });

  it("tells Keeper to report a routine that could not start its task", () => {
    const { store } = fakeStore();
    const ns = createNightShift({ dataDir: join(root, "data"), store, git: localGit, cwdOf: () => undefined, audit: () => undefined, decide: () => undefined, send: async () => undefined });
    expect(ns.routineTurn({ id: "run-1", routineId: "r-1", routineName: "Weekly", botId: "id-Keeper" }, "NightShift research: T")).toContain("could not start its research task");
  });
});

describe("restart recovery", () => {
  it("hands a cut-off task back to its bot once, and blocks it as interrupted after a second restart", () => {
    const dataDir = join(root, "data");
    const first = harness(dataDir);
    const task = first.loop.createForRoutine(routineRun());
    const second = harness(dataDir);
    const found = second.loop.recoverAfterRestart(() => false);
    expect(found.map((one) => one.outcome)).toEqual(["redispatched"]);
    expect(second.dispatched[0]).toMatchObject({ role: "researcher", botId: ROLES.researcher });
    expect(second.dispatched[0]!.prompt).toMatch(/^NightShift restarted while you worked on this task/);
    expect(second.audit.map((event) => event.action)).toEqual(["task.redispatched"]);
    const third = harness(dataDir);
    expect(third.loop.recoverAfterRestart(() => false).map((one) => one.outcome)).toEqual(["interrupted"]);
    expect(third.store.get(task.id)).toMatchObject({ status: "Blocked", owner_bot_id: null });
    expect(third.audit.map((event) => event.action)).toEqual(["task.blocked", "task.interrupted"]);
    expect(third.dispatched.at(-1)!.role).toBe("keeper");
  });

  it("leaves a bot that is already working again, and tasks nobody owns", () => {
    const dataDir = join(root, "data");
    const first = harness(dataDir);
    first.loop.createForRoutine(routineRun());
    first.loop.create({ title: "Waiting", project: repo, tags: [], created_by: "loopback" }, PERSON);
    const again = harness(dataDir);
    expect(again.loop.recoverAfterRestart(() => true)).toEqual([]);
    expect(again.dispatched).toEqual([]);
  });

  it("hands out a routine task the restart caught after it was saved but before it was handed out", () => {
    const dataDir = join(root, "data");
    const cut = harness(dataDir);
    const saved = cut.store.create({ title: "Agent tooling 2026-11-23", project: repo, tags: ["research", "routine"], routine_run_id: "run-1", created_by: "routine:routine-1" });
    const rerun = harness(dataDir);
    const task = rerun.loop.createForRoutine(routineRun());
    expect(task).toMatchObject({ id: saved.id, status: "Working", owner_bot_id: ROLES.researcher });
    expect(rerun.dispatched.map((one) => one.role)).toEqual(["researcher"]);
    expect(rerun.loop.createForRoutine(routineRun()).id).toBe(saved.id);
    expect(rerun.dispatched).toHaveLength(1);
  });

  it("hands out an unrouted task on restart, and leaves Blocked and untagged tasks alone", () => {
    const dataDir = join(root, "data");
    const cut = harness(dataDir);
    const saved = cut.store.create({ title: "Cut short", project: repo, tags: ["research", "routine"], routine_run_id: "run-1", created_by: "routine:routine-1" });
    cut.loop.create({ title: "Waiting", project: repo, tags: [], created_by: "loopback" }, PERSON);
    const stopped = cut.loop.create({ title: "Stopped", project: repo, tags: ["research"], created_by: "loopback" }, PERSON);
    cut.loop.transition(stopped.id, { event: "stop" }, PERSON);
    const after = harness(dataDir);
    const found = after.loop.recoverAfterRestart(() => false);
    expect(found.map((one) => [one.task.id, one.outcome])).toEqual([[saved.id, "routed"]]);
    expect(after.store.get(saved.id)).toMatchObject({ status: "Working", owner_bot_id: ROLES.researcher });
    expect(after.dispatched.map((one) => one.role)).toEqual(["researcher"]);
    expect(after.audit.map((event) => event.action)).toEqual(["task.branch-created", "task.assigned"]);
  });

  it("keeps a resumed task working when the bot moves it on after the restart", () => {
    const dataDir = join(root, "data");
    const first = harness(dataDir);
    const task = first.loop.createForRoutine(routineRun());
    const second = harness(dataDir);
    second.loop.recoverAfterRestart(() => false);
    writeFileSync(join(task.worktree_path!, "packet.md"), RESEARCH);
    expect(second.loop.transition(task.id, { event: "research.done", research_path: "packet.md" }, bot("researcher")).status).toBe("Done");
    expect(harness(dataDir).loop.recoverAfterRestart(() => false)).toEqual([]);
  });
});

describe("MEMORY.md stays Keeper's", () => {
  it("refuses a Builder branch that changes MEMORY.md, and a person may still move it on", () => {
    const h = harness();
    const task = h.loop.create({ title: "Note", project: repo, tags: ["dev"], created_by: "loopback" }, PERSON);
    const handoff = "# Handoff\n\n## Files changed\n- docs/n.md:1 x\n\n## Decisions\n- x\n\n## Tests\n- Ran: none\n- Not run: all\n\n## Risky / unsure\n- x\n\n## Do not re-read\n- x\n";
    commitIn(task.worktree_path!, { "MEMORY.md": `${MEMORY}- sneaked in\n`, [`docs/handoffs/${task.slug}.md`]: handoff });
    expect(() => h.loop.transition(task.id, { event: "build.done" }, bot("builder"))).toThrow(/only Keeper proposes team memory changes/);
    expect(h.store.get(task.id)!.status).toBe("Working");
  });
});

function fakeStore() {
  const messages: Array<{ threadId: string; message: Record<string, any> }> = [];
  const bots = ["Researcher", "Builder", "Reviewer", "Keeper"].map((name) => ({ id: `id-${name}`, name, color: "blue" as never, threadId: `t-${name}` }));
  const store: LoopStore = {
    bots,
    bot: (id) => bots.find((one) => one.id === id),
    group: () => undefined,
    appendMessage: (threadId, message) => { messages.push({ threadId, message }); return { ...message, id: "m", at: 0 } as never; },
  };
  return { store, messages };
}

describe("MEMORY.md diff before save", () => {
  const memory = (events: MemoryAuditEvent[] = [], file = join(root, "data", "memory-proposals.json")) =>
    new TeamMemory({ file, keeper: () => ROLES.keeper, audit: (event) => events.push(event), card: () => "t-keeper" });
  const proposed = `${MEMORY}- Routine packets are reported by Keeper.\n`;

  it("shows the exact diff and writes MEMORY.md only after a person approves it", () => {
    const events: MemoryAuditEvent[] = [];
    const team = memory(events);
    const proposal = team.propose({ project: repo, text: proposed, summary: "Note the routine" }, bot("keeper"));
    expect(proposal).toMatchObject({ decision: "pending", thread_id: "t-keeper", proposed_by: `bot:${ROLES.keeper}` });
    expect(proposal.diff).toContain("+- Routine packets are reported by Keeper.");
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).toBe(MEMORY);
    expect(() => team.decide(proposal.id, "approved", proposal.proposed_sha256, bot("keeper"))).toThrow(/only a person/);
    expect(() => team.decide(proposal.id, "approved", "0".repeat(64), PERSON)).toThrow(/not the change/);
    expect(team.decide(proposal.id, "approved", proposal.proposed_sha256, PERSON).decision).toBe("approved");
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).toBe(proposed);
    expect(events.map((event) => event.action)).toEqual(["memory.proposed", "memory.approved"]);
  });

  it("leaves the file untouched when the change is denied or still pending, and keeps a pending one across a restart", () => {
    const file = join(root, "data", "memory-proposals.json");
    const pending = memory([], file).propose({ project: repo, text: proposed }, bot("keeper"));
    const restarted = memory([], file);
    expect(restarted.get(pending.id).decision).toBe("pending");
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).toBe(MEMORY);
    expect(restarted.decide(pending.id, "denied", pending.proposed_sha256, PERSON).decision).toBe("denied");
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).toBe(MEMORY);
    expect(() => restarted.decide(pending.id, "approved", pending.proposed_sha256, PERSON)).toThrow(/already denied/);
  });

  it("goes stale when MEMORY.md changed after the diff was shown, and a newer proposal replaces a pending one", () => {
    const events: MemoryAuditEvent[] = [];
    const team = memory(events);
    const first = team.propose({ project: repo, text: proposed }, bot("keeper"));
    const second = team.propose({ project: repo, text: `${proposed}- one more\n` }, bot("keeper"));
    expect(team.get(first.id).decision).toBe("stale");
    writeFileSync(join(repo, "MEMORY.md"), `${MEMORY}- a person edited it\n`);
    expect(() => team.decide(second.id, "approved", second.proposed_sha256, PERSON)).toThrow(/changed after this diff was shown/);
    expect(team.get(second.id).decision).toBe("stale");
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).toBe(`${MEMORY}- a person edited it\n`);
    expect(events.map((event) => event.action)).toEqual(["memory.proposed", "memory.stale", "memory.proposed", "memory.stale"]);
  });

  it("lets only Keeper (or a person) propose, and refuses a change that holds a key, a token or a password", () => {
    const events: MemoryAuditEvent[] = [];
    const team = memory(events);
    expect(() => team.propose({ project: repo, text: proposed }, bot("builder"))).toThrow(/only Keeper/);
    for (const secret of ["- staging key sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345", "- deploy with password=hunter22hunter22", "- GITHUB ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "- header Authorization: Bearer abcdefghijklmnop1234"]) {
      expect(() => team.propose({ project: repo, text: `${MEMORY}${secret}\n` }, bot("keeper"))).toThrow(/look like a key, token or password/);
    }
    expect(team.list()).toEqual([]);
    expect(events.map((event) => [event.action, event.detail?.reason])).toEqual([["memory.refused", "not-keeper"], ...Array(4).fill(["memory.refused", "secret"])]);
    expect(JSON.stringify(events)).not.toContain("hunter22");
    expect(secretLines(MEMORY, `${MEMORY}- no keys, tokens or passwords here\n`)).toEqual([]);
    expect(existsSync(join(root, "data", "memory-proposals.json"))).toBe(false);
  });

  it("answers its own card through the shared card route, writes an audit row of category memory, and passes on other cards", () => {
    const { store, messages } = fakeStore();
    const rows: Array<Record<string, any>> = [];
    const ns = createNightShift({ dataDir: join(root, "data"), store, git: localGit, cwdOf: () => repo, audit: (row) => rows.push(row), decide: () => undefined, send: async () => undefined });
    const proposal = ns.memory.propose({ project: repo, text: proposed }, { kind: "bot", id: "id-Keeper" });
    const card = messages.find((one) => one.message.kind === "options")!;
    expect(card.threadId).toBe("t-Keeper");
    expect(card.message.card).toMatchObject({ requestId: proposal.id, tool: MEMORY_APPROVAL_TOOL, options: ["Approve", "Deny"] });
    expect(card.message.text).toContain("+- Routine packets are reported by Keeper.");
    expect(ns.resolveCard("t-Keeper", "someone-else", "allow", "approval card")).toBeNull();
    expect(ns.resolveCard("t-Keeper", proposal.id, "allow", "approval card")).toMatchObject({ status: 200 });
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).toBe(proposed);
    expect(rows.map((row) => `${row.category}:${row.action}`)).toEqual(["memory:memory.proposed", "memory:memory.approved"]);
    expect(JSON.stringify(rows)).not.toContain("Routine packets");
    expect(memoryAuditRow({ action: "memory.refused", proposal: null, actor: { kind: "bot", id: "b" }, detail: { reason: "secret" } }))
      .toMatchObject({ category: "memory", target: { kind: "memory", id: "MEMORY.md" }, after: { by: "bot:b", reason: "secret" } });
  });

  it("serves proposals over REST and asks for the sha of the change a person approves", async () => {
    const team = memory();
    const loop = harness().loop;
    const handler = createWorkTaskRoutes({ loop, memory: team, botExists: (id) => Object.values(ROLES).includes(id as never), person: () => "loopback" });
    const call = async (method: string, path: string, body?: unknown) => {
      let out: { status: number; body: any } | undefined;
      await handler({ req: {} as never, res: {} as never, path, method, auth: {} as never, url: new URL(`http://x${path}`),
        json: (_res: unknown, status: number, value: unknown) => { out = { status, body: value }; }, readBody: async () => body } as never);
      return out!;
    };
    const made = await call("POST", "/api/team-memory/proposals", { project: repo, text: proposed, as_bot: ROLES.keeper });
    expect(made.status).toBe(201);
    const id = made.body.proposal.id as string;
    expect((await call("GET", "/api/team-memory/proposals")).body.proposals).toHaveLength(1);
    expect((await call("POST", `/api/team-memory/proposals/${id}/decide`, { decision: "approved" })).status).toBe(400);
    expect((await call("POST", `/api/team-memory/proposals/${id}/decide`, { decision: "approved", proposed_sha256: made.body.proposal.proposed_sha256, as_bot: ROLES.keeper })).status).toBe(403);
    expect((await call("POST", `/api/team-memory/proposals/${id}/decide`, { decision: "approved", proposed_sha256: made.body.proposal.proposed_sha256 })).body.proposal.decision).toBe("approved");
    expect((await call("POST", "/api/team-memory/proposals", { project: repo, text: `${proposed}- x\n`, as_bot: ROLES.builder })).status).toBe(403);
  });
});

describe("the starter team file", () => {
  it("declares Keeper's research routine, keeps every bot at Ask, and keeps the Grok swap line", () => {
    const path = fileURLToPath(new URL("../../nightshift/team.yaml", import.meta.url));
    const team = loadTeamFile(path);
    expect(team.bots.map((one) => one.name)).toEqual([DEFAULT_BOT_NAME, "Researcher", "Builder", "Reviewer", "Keeper"]);
    expect(team.bots.filter((one) => one.approval !== "ask").map((one) => `${one.name}: ${one.approval ?? "not set"}`)).toEqual([]);
    expect(team.bots.find((one) => one.name === "Researcher")).toMatchObject({ computer: "off", browser: { enabled: false }, model: { instanceId: "claude", model: "claude-sonnet-5-5" } });
    expect(team.routines).toHaveLength(1);
    const [routine] = team.routines;
    expect(routine).toMatchObject({ bot: "Keeper", enabled: true, schedule: { type: "cron", timeZone: "UTC" } });
    expect(parseRoutineResearch(routine!.prompt)).toMatchObject({ title: "Agent tooling scan", base: "nightshift/phase0" });
    expect(readFileSync(path, "utf8")).toContain("# model: grok/grok-4.7");
  });

  it("parses the team-memory verbs", () => {
    expect(parseCommand(["team-memory", "propose", "--project", ".", "--file", "m.md", "--as-bot", "k"])).toMatchObject({ verb: "team-memory propose", flags: { project: ".", file: "m.md", "as-bot": "k" } });
    expect(parseCommand(["team-memory", "decide", "id-1", "--sha256", "abc", "--approve"])).toMatchObject({ verb: "team-memory decide", positionals: ["id-1"], flags: { approve: true } });
  });
});

describe("LoopError", () => {
  it("is what the routes turn into a status", () => {
    expect(new LoopError(403, "x").status).toBe(403);
  });
});
