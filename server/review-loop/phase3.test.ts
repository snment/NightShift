import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { autoVerdict } from "../auto-approve.ts";
import { botPatch } from "../headless/team-apply.ts";
import { loadTeamFile } from "../headless/team-file.ts";
import { writeToolPaths } from "../own-file-reads.ts";
import type { RequestAuth } from "../request-auth.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { localGit } from "./git.ts";
import { createNightShift, type LoopStore } from "./host.ts";
import { BUSY_APPROVAL_REFUSAL, SERVICE_APPROVAL_REFUSAL, localApprovalRefusal } from "./human-approval.ts";
import { ReviewLoop, type LoopActor, type TaskAuditEvent } from "./loop.ts";
import { memoryBlockIn, memoryProposalPrompt } from "./memory-file.ts";
import { TeamMemory } from "./memory.ts";
import { researchPacketPath, type ReviewRole } from "./model.ts";
import { RESEARCH_ALLOW_KEYS, researchGrant, writesUnderResearch } from "./research-allow.ts";
import { routineResearchPrompt } from "./routine-research.ts";
import { createWorkTaskRoutes } from "./routes.ts";
import { WorkTaskStore } from "./store.ts";

const ROLES = { researcher: "bot-res", builder: "bot-build", reviewer: "bot-rev", keeper: "bot-keep" } as const;
const PERSON: LoopActor = { kind: "person", id: "loopback" };
const RESEARCH = "# Research\n\n- https://example.com/spec (accessed 2026-11-24)\n- Claim X: UNVERIFIED\n";
const MEMORY = "# Team memory\n\n## Conventions\n- Packets live in docs/research/.\n";
const ALL_KEYS = Object.values(RESEARCH_ALLOW_KEYS);

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

function harness(dataDir = join(root, "data")) {
  const store = new WorkTaskStore(join(dataDir, "work-tasks.json"));
  const audit: TaskAuditEvent[] = [];
  const dispatched: Array<{ role: ReviewRole; botId: string; prompt: string }> = [];
  const loop = new ReviewLoop({
    store, git: localGit, worktreeRoot: join(dataDir, "worktrees"), roles: () => ROLES,
    audit: (event) => audit.push(event), post: () => undefined,
    dispatch: (role, botId, task, prompt) => {
      if (role === "researcher" && task.worktree_path) mkdirSync(join(task.worktree_path, "docs", "research"), { recursive: true });
      dispatched.push({ role, botId, prompt });
    },
  });
  return { loop, store, audit, dispatched };
}

const routineRun = (runId = "run-1") => ({
  routineId: "routine-1", routineName: "Weekly research", runId, title: "Agent tooling scan 2026-11-24", description: "What changed this week.", project: repo,
});

function fakeStore(alwaysAllow: Record<string, string[]> = {}) {
  const messages: Array<{ threadId: string; message: Record<string, any> }> = [];
  const bots = ["Researcher", "Builder", "Reviewer", "Keeper"].map((name) => ({ id: `id-${name}`, name, color: "blue" as never, threadId: `t-${name}`, alwaysAllow: alwaysAllow[name] ?? [] }));
  const store: LoopStore = {
    bots,
    bot: (id) => bots.find((one) => one.id === id),
    group: () => undefined,
    appendMessage: (threadId, message) => { messages.push({ threadId, message }); return { ...message, id: "m", at: 0 } as never; },
  };
  return { store, messages };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nightshift-p3-"));
  repo = makeRepo();
});

afterEach(() => {
  try { git(repo, "worktree", "prune"); } catch { /* best effort */ }
  removeTempDir(root);
});

describe("the Researcher's allow-list", () => {
  const worktree = () => {
    const tree = join(root, "tree");
    mkdirSync(join(tree, "docs", "research"), { recursive: true });
    return tree;
  };

  it("lets web search, page fetches and a new or plain packet under docs/research/ through", () => {
    const tree = worktree();
    writeFileSync(join(tree, "docs", "research", "old.md"), "x");
    expect(researchGrant({ tool: "WebSearch" }, ALL_KEYS, null)).toBe("web-search");
    expect(researchGrant({ tool: "WebFetch" }, ALL_KEYS, null)).toBe("web-fetch");
    expect(researchGrant({ tool: "Write", writes: [join(tree, "docs", "research", "scan-2026-11-24.md")] }, ALL_KEYS, tree)).toBe("research-write");
    expect(researchGrant({ tool: "Edit", writes: [join(tree, "docs", "research", "old.md")] }, ALL_KEYS, tree)).toBe("research-write");
    expect(researchGrant({ tool: "Write", writes: [join(tree, "docs", "research", "sub", "a.md")] }, ALL_KEYS, tree)).toBe("research-write");
  });

  it("asks for a write outside docs/research/, one that climbs out with .., a stream name, and any other tool", () => {
    const tree = worktree();
    const ask = (path: string, tool = "Write") => researchGrant({ tool, writes: [path] }, ALL_KEYS, tree);
    expect(ask(join(tree, "README.md"))).toBeNull();
    expect(ask(join(tree, "docs", "notes.md"))).toBeNull();
    expect(ask(`${join(tree, "docs", "research")}/../../src/x.ts`)).toBeNull();
    expect(ask(join(root, "elsewhere.md"))).toBeNull();
    expect(ask(join(tree, "docs", "research", "a.md:hidden"))).toBeNull();
    expect(ask(join(tree, "docs", "research"))).toBeNull();
    expect(ask("docs/research/relative.md")).toBeNull();
    expect(researchGrant({ tool: "Write" }, ALL_KEYS, tree)).toBeNull();
    expect(ask(join(tree, "docs", "research", "a.md"), "NotebookEdit")).toBeNull();
    for (const tool of ["Bash", "PowerShell", "Read", "Glob", "mcp__x__WebSearch", "AskUserQuestion"]) {
      expect(researchGrant({ tool, writes: [join(tree, "docs", "research", "a.md")] }, ALL_KEYS, tree)).toBeNull();
    }
  });

  it("asks for a write through a link out of docs/research/, a hard link, or into a research folder that is itself a link", () => {
    const tree = worktree();
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(tree, "docs", "research", "out"), "junction");
    expect(writesUnderResearch(join(tree, "docs", "research", "out", "x.md"), tree)).toBe(false);
    writeFileSync(join(outside, "target.md"), "x");
    linkSync(join(outside, "target.md"), join(tree, "docs", "research", "hard.md"));
    expect(writesUnderResearch(join(tree, "docs", "research", "hard.md"), tree)).toBe(false);
    const linked = join(root, "linked-tree");
    mkdirSync(join(linked, "docs"), { recursive: true });
    symlinkSync(outside, join(linked, "docs", "research"), "junction");
    expect(writesUnderResearch(join(linked, "docs", "research", "x.md"), linked)).toBe(false);
  });

  it("allows nothing the bot's list does not hold, and no write without the task's worktree", () => {
    const tree = worktree();
    const path = join(tree, "docs", "research", "a.md");
    expect(researchGrant({ tool: "WebSearch" }, [], tree)).toBeNull();
    expect(researchGrant({ tool: "WebFetch" }, [RESEARCH_ALLOW_KEYS.WebSearch], tree)).toBeNull();
    expect(researchGrant({ tool: "Write", writes: [path] }, [RESEARCH_ALLOW_KEYS.WebSearch, RESEARCH_ALLOW_KEYS.WebFetch], tree)).toBeNull();
    expect(researchGrant({ tool: "Write", writes: [path] }, ALL_KEYS, null)).toBeNull();
  });

  it("answers without a card at Ask, and never past the outbound guard, a sandbox widening or a question", () => {
    expect(autoVerdict("ask", "WebFetch", { researchAllowed: "web-fetch" })).toMatchObject({ source: "research-allowlist", approve: expect.stringContaining("Researcher allow-list") });
    expect(autoVerdict("ask", "WebFetch", { researchAllowed: null })).toEqual({ approve: null, source: "no-grant" });
    expect(autoVerdict("ask", "Write", { researchAllowed: "research-write", requiresExplicitApproval: true }).approve).toBeNull();
    expect(autoVerdict("ask", "AskUserQuestion", { researchAllowed: "web-search" }).approve).toBeNull();
    expect(autoVerdict("ask", "mcp__gmail__send_email", { researchAllowed: "web-search" }).source).toBe("outbound-guard");
  });

  it("is the Researcher's alone, only in its own chat, and writes only into the worktree of the task it works on", () => {
    const { store } = fakeStore({ Researcher: ALL_KEYS, Keeper: ALL_KEYS, Builder: ALL_KEYS });
    const ns = createNightShift({ dataDir: join(root, "data"), store, git: localGit, cwdOf: () => repo, audit: () => undefined, decide: () => undefined, send: async () => undefined });
    expect(ns.researchGrant("id-Researcher", "t-Researcher", { tool: "WebSearch" })).toBe("web-search");
    expect(ns.researchGrant("id-Keeper", "t-Keeper", { tool: "WebSearch" })).toBeNull();
    expect(ns.researchGrant("id-Builder", "t-Builder", { tool: "WebFetch" })).toBeNull();
    expect(ns.researchGrant("id-Researcher", "t-other-chat", { tool: "WebFetch" })).toBeNull();
    const before = join(repo, "docs", "research", "x.md");
    expect(ns.researchGrant("id-Researcher", "t-Researcher", { tool: "Write", writes: [before] })).toBeNull();
    ns.routineTurn({ id: "run-1", routineId: "r-1", routineName: "Weekly", botId: "id-Keeper" }, routineResearchPrompt({ title: "Agent tooling scan", description: "x" }));
    const [task] = ns.loop.list();
    const packet = join(task!.worktree_path!, researchPacketPath(task!.slug, "2026-11-24"));
    expect(ns.researchGrant("id-Researcher", "t-Researcher", { tool: "Write", writes: [packet] })).toBe("research-write");
    expect(ns.researchGrant("id-Keeper", "t-Keeper", { tool: "Write", writes: [packet] })).toBeNull();
    expect(ns.researchGrant("id-Researcher", "t-Researcher", { tool: "Write", writes: [join(task!.worktree_path!, "README.md")] })).toBeNull();
    expect(ns.researchGrant("id-Researcher", "t-Researcher", { tool: "Bash" })).toBeNull();
  });

  it("reads a write tool's file path, and nothing else", () => {
    expect(writeToolPaths("Write", { file_path: "C:\\work\\a.md", content: "x" })).toEqual(["C:\\work\\a.md"]);
    expect(writeToolPaths("Edit", { file_path: "/work/a.md" })).toEqual(["/work/a.md"]);
    expect(writeToolPaths("Write", { file_path: "a.md" })).toBeUndefined();
    expect(writeToolPaths("Bash", { command: "echo" })).toBeUndefined();
  });
});

describe("the allow-list in the team file", () => {
  const teamFile = (bots: string) => {
    const path = join(root, "team.yaml");
    writeFileSync(path, `version: 1\nbots:\n${bots}`);
    return path;
  };

  it("reads the Researcher's three allowances, and refuses them on any other bot or an unknown one", () => {
    expect(loadTeamFile(teamFile("  - name: Researcher\n    computer: off\n    allowWithoutCard: [WebSearch, WebFetch, docs/research/]\n")).bots[0]!.allowWithoutCard)
      .toEqual(["WebSearch", "WebFetch", "docs/research/"]);
    expect(() => loadTeamFile(teamFile("  - name: Keeper\n    computer: off\n    allowWithoutCard: [WebSearch]\n"))).toThrow(/only the Researcher/);
    expect(() => loadTeamFile(teamFile("  - name: Researcher\n    computer: off\n    allowWithoutCard: [Bash]\n"))).toThrow(/must be one of WebSearch, WebFetch, docs\/research\//);
    expect(() => loadTeamFile(`${teamFile("  - name: Researcher\n    computer: off\n")}`.replace(/$/, ""))).not.toThrow();
  });

  it("adds the Researcher's keys beside its other grants, then has nothing to change, and takes stray keys off any other bot", () => {
    const desired = loadTeamFile(teamFile("  - name: Researcher\n    computer: off\n    allowWithoutCard: [WebSearch, WebFetch, docs/research/]\n")).bots[0]!;
    const echo = { name: "Researcher", computer: "off", alwaysAllow: ["cmd:git status"] };
    const { patch, changes } = botPatch(desired, echo, undefined);
    expect(patch.alwaysAllow).toEqual(["cmd:git status", ...ALL_KEYS]);
    expect(changes).toEqual(["allowed without a card: nothing → WebSearch, WebFetch, docs/research/"]);
    expect(botPatch(desired, { ...echo, alwaysAllow: [...ALL_KEYS].reverse() }, undefined).patch).toEqual({});
    const keeper = loadTeamFile(teamFile("  - name: Keeper\n    computer: off\n")).bots[0]!;
    expect(botPatch(keeper, { name: "Keeper", computer: "off", alwaysAllow: [RESEARCH_ALLOW_KEYS.WebSearch, "x"] }, undefined).patch).toEqual({ alwaysAllow: ["x"] });
    expect(botPatch(keeper, { name: "Keeper", computer: "off", alwaysAllow: ["x"] }, undefined).patch).toEqual({});
  });

  it("is what the starter team file declares, for the Researcher only", () => {
    const team = loadTeamFile(join(process.cwd(), "nightshift", "team.yaml"));
    expect(team.bots.filter((one) => one.allowWithoutCard?.length).map((one) => [one.name, one.allowWithoutCard])).toEqual([["Researcher", ["WebSearch", "WebFetch", "docs/research/"]]]);
  });
});

describe("research that finishes with nobody there", () => {
  it("finishes the task as the Researcher when its turn ends with the packet written, and Keeper reports it", () => {
    const h = harness();
    const task = h.loop.createForRoutine(routineRun());
    expect(h.dispatched[0]!.prompt).toContain(join(task.worktree_path!, "docs", "research", `${task.slug}.md`));
    expect(h.dispatched[0]!.prompt).not.toMatch(/task transition|openmausbot/);
    writeFileSync(join(task.worktree_path!, "docs", "research", `${task.slug}.md`), RESEARCH);
    const done = h.loop.researchTurnEnded(ROLES.researcher)!;
    expect(done).toMatchObject({ status: "Done", research_path: `docs/research/${task.slug}.md` });
    expect(h.audit.find((event) => event.action === "task.research-written")!.actor).toEqual({ kind: "bot", id: ROLES.researcher });
    expect(h.dispatched.at(-1)!.role).toBe("keeper");
    expect(h.loop.researchTurnEnded(ROLES.researcher)).toBeNull();
  });

  it("blocks the task and tells Keeper when the turn ends with no packet, or one the check refuses", () => {
    const h = harness();
    const task = h.loop.createForRoutine(routineRun());
    expect(h.loop.researchTurnEnded(ROLES.builder)).toBeNull();
    expect(h.loop.researchTurnEnded(ROLES.researcher)).toMatchObject({ status: "Blocked", blocked_reason: expect.stringContaining("without writing") });
    expect(h.dispatched.at(-1)).toMatchObject({ role: "keeper", prompt: expect.stringContaining("is Blocked") });
    const other = harness(join(root, "data2"));
    const second = other.loop.createForRoutine({ ...routineRun("run-2"), routineId: "routine-2", title: "Pricing check 2026-11-24" });
    writeFileSync(join(second.worktree_path!, "docs", "research", `${second.slug}.md`), "# No sources here\n");
    expect(other.loop.researchTurnEnded(ROLES.researcher)).toMatchObject({ status: "Blocked", blocked_reason: expect.stringContaining("research packet rejected") });
    expect(task.status).toBe("Working");
  });

  it("blocks the task of a bot whose turn failed or could not start, and tells Keeper", () => {
    const h = harness();
    const task = h.loop.createForRoutine(routineRun());
    expect(h.loop.turnFailed(ROLES.keeper, "x")).toBeNull();
    const blocked = h.loop.turnFailed(ROLES.researcher, "Only the app on this computer can let a bot use it.\nmore")!;
    expect(blocked).toMatchObject({ id: task.id, status: "Blocked", blocked_reason: "the researcher's turn failed: Only the app on this computer can let a bot use it." });
    expect(h.audit.at(-1)).toMatchObject({ action: "task.turn-failed", detail: { role: "researcher", botId: ROLES.researcher } });
    expect(h.dispatched.at(-1)!.role).toBe("keeper");
    expect(h.loop.turnFailed(ROLES.researcher, "again")).toBeNull();
  });

  it("finishes through the host only for a turn in the Researcher's own chat", () => {
    const { store } = fakeStore();
    const ns = createNightShift({ dataDir: join(root, "data"), store, git: localGit, cwdOf: () => repo, audit: () => undefined, decide: () => undefined, send: async () => undefined });
    ns.routineTurn({ id: "run-1", routineId: "r-1", routineName: "Weekly", botId: "id-Keeper" }, routineResearchPrompt({ title: "Agent tooling scan", description: "x" }));
    const [task] = ns.loop.list();
    writeFileSync(join(task!.worktree_path!, researchPacketPath(task!.slug, "2026-11-24")), RESEARCH);
    ns.turnEnded("id-Researcher", "t-somewhere-else", "");
    expect(ns.loop.get(task!.id).status).toBe("Working");
    ns.turnEnded("id-Researcher", "t-Researcher", "Packet written.");
    expect(ns.loop.get(task!.id).status).toBe("Done");
  });
});

describe("smaller trial defects", () => {
  it("names the packet with its date once", () => {
    expect(researchPacketPath("agent-tooling-scan-2026-11-23", "2026-11-23")).toBe("docs/research/agent-tooling-scan-2026-11-23.md");
    expect(researchPacketPath("agent-tooling-scan-2026-11-23-2", "2026-11-23")).toBe("docs/research/agent-tooling-scan-2026-11-23-2.md");
    expect(researchPacketPath("pricing-check", "2026-11-24")).toBe("docs/research/pricing-check-2026-11-24.md");
  });

  it("starts no new task for a routine while its earlier one is open, and a new one once it is Done", () => {
    const h = harness();
    const first = h.loop.createForRoutine(routineRun("run-1"));
    const again = h.loop.createForRoutine({ ...routineRun("run-2"), title: "Agent tooling scan 2026-12-01" });
    expect(again.id).toBe(first.id);
    expect(h.store.list()).toHaveLength(1);
    expect(h.audit.at(-1)).toMatchObject({ action: "task.routine-still-open", detail: { runId: "run-2" } });
    h.loop.transition(first.id, { event: "stop" }, PERSON);
    expect(h.loop.createForRoutine({ ...routineRun("run-3"), title: "Agent tooling scan 2026-12-08" }).id).toBe(first.id);
    writeFileSync(join(first.worktree_path!, "docs", "research", `${first.slug}.md`), RESEARCH);
    h.loop.transition(first.id, { event: "resume" }, PERSON);
    h.loop.researchTurnEnded(ROLES.researcher);
    const next = h.loop.createForRoutine({ ...routineRun("run-4"), title: "Agent tooling scan 2026-12-15" });
    expect(next.id).not.toBe(first.id);
    expect(h.store.list()).toHaveLength(2);
  });

  it("tells Keeper in one line that the routine found its earlier task still open", () => {
    const { store } = fakeStore();
    const ns = createNightShift({ dataDir: join(root, "data"), store, git: localGit, cwdOf: () => repo, audit: () => undefined, decide: () => undefined, send: async () => undefined });
    const prompt = routineResearchPrompt({ title: "Agent tooling scan", description: "x" });
    ns.routineTurn({ id: "run-1", routineId: "r-1", routineName: "Weekly", botId: "id-Keeper" }, prompt);
    expect(ns.routineTurn({ id: "run-2", routineId: "r-1", routineName: "Weekly", botId: "id-Keeper" }, prompt)).toMatch(/is still Working, so no new task was started/);
    expect(ns.loop.list()).toHaveLength(1);
  });

  it("names the bot in every transition its prompt gives it", () => {
    const h = harness();
    const task = h.loop.create({ title: "Fix it", project: repo, tags: ["dev"], created_by: "loopback" }, PERSON);
    expect(h.dispatched.at(-1)!.prompt).toContain(`task transition ${task.id} build.done --as-bot ${ROLES.builder}`);
    const review = h.loop.promptFor("reviewer", { ...h.loop.get(task.id), owner_bot_id: ROLES.reviewer, status: "Needs Review", tags: ["review"] });
    expect(review).toContain(`review.approve --as-bot ${ROLES.reviewer}`);
    expect(review).toContain(`--notes "path/to/file.ts:12 what to change" --as-bot ${ROLES.reviewer}`);
  });

  it("books a turn that spans a restart on the task its bot was handed, once", () => {
    const dataDir = join(root, "data");
    const before = harness(dataDir);
    const task = before.loop.createForRoutine(routineRun());
    writeFileSync(join(task.worktree_path!, "docs", "research", `${task.slug}.md`), RESEARCH);
    const after = harness(dataDir);
    expect(after.loop.researchTurnEnded(ROLES.researcher)!.status).toBe("Done");
    const booked = after.loop.noteTurnUsage({ botId: ROLES.researcher, input: 900, output: 120, cachedInput: 700, model: "claude-sonnet-5-5" })!;
    expect(booked.token_usage.researcher).toMatchObject({ inputTokens: 900, outputTokens: 120, cachedInputTokens: 700, turns: 1 });
    expect(harness(dataDir).loop.noteTurnUsage({ botId: ROLES.researcher, input: 5, output: 5 })).toBeNull();
  });
});

describe("approvals from this computer", () => {
  const loopback: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
  const service: RequestAuth = { kind: "loopback", scopes: ["client"], trust: "service" };
  const session = { kind: "session", session: { id: "s", label: "phone" }, via: "cookie", scopes: ["admin"] } as unknown as RequestAuth;

  it("takes a local approval only while every bot is idle, a signed-in one at any time, and in the desktop app as before", () => {
    expect(localApprovalRefusal({ auth: loopback, desktopGuarded: false, botBusy: true })).toBe(BUSY_APPROVAL_REFUSAL);
    expect(localApprovalRefusal({ auth: loopback, desktopGuarded: false, botBusy: false })).toBeNull();
    expect(localApprovalRefusal({ auth: service, desktopGuarded: false, botBusy: false })).toBe(SERVICE_APPROVAL_REFUSAL);
    expect(localApprovalRefusal({ auth: session, desktopGuarded: false, botBusy: true })).toBeNull();
    expect(localApprovalRefusal({ auth: loopback, desktopGuarded: true, botBusy: true })).toBeNull();
  });

  it("refuses a decide or an approve-diff the refusal names, takes a denial, and holds a card's Allow the same way", async () => {
    const team = new TeamMemory({ file: join(root, "data", "memory-proposals.json"), keeper: () => ROLES.keeper, audit: () => undefined, card: () => "t-keeper" });
    const loop = harness().loop;
    let busy = true;
    const handler = createWorkTaskRoutes({ loop, memory: team, botExists: () => true, person: () => "loopback",
      approvalRefusal: (auth) => localApprovalRefusal({ auth, desktopGuarded: false, botBusy: busy }) });
    const call = async (path: string, body: unknown) => {
      let out: { status: number; body: any } | undefined;
      await handler({ req: {} as never, res: {} as never, path, method: "POST", auth: loopback, url: new URL(`http://x${path}`),
        json: (_res: unknown, status: number, value: unknown) => { out = { status, body: value }; }, readBody: async () => body } as never);
      return out!;
    };
    const proposal = team.propose({ project: repo, text: `${MEMORY}- one more\n` }, { kind: "bot", id: ROLES.keeper });
    const approve = { decision: "approved", proposed_sha256: proposal.proposed_sha256 };
    expect(await call(`/api/team-memory/proposals/${proposal.id}/decide`, approve)).toMatchObject({ status: 403, body: { error: BUSY_APPROVAL_REFUSAL } });
    expect(team.resolveCard("t-keeper", proposal.id, "allow", "approval card", BUSY_APPROVAL_REFUSAL)).toMatchObject({ status: 403 });
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).toBe(MEMORY);
    expect(await call("/api/tasks/nope/approve-diff", { decision: "approved", diff_sha256: "a", request_id: "r" })).toMatchObject({ status: 403 });
    busy = false;
    expect((await call(`/api/team-memory/proposals/${proposal.id}/decide`, approve)).body.proposal.decision).toBe("approved");
    const second = team.propose({ project: repo, text: `${MEMORY}- one more\n- and another\n` }, { kind: "bot", id: ROLES.keeper });
    busy = true;
    expect((await call(`/api/team-memory/proposals/${second.id}/decide`, { decision: "denied", proposed_sha256: second.proposed_sha256 })).body.proposal.decision).toBe("denied");
  });
});

describe("Keeper's memory proposal in its reply", () => {
  it("reads the whole new file and its summary from the block at the end of a reply, and nothing else", () => {
    expect(memoryBlockIn(`Done.\n<nightshift-memory summary="Note the scan">\n# Team memory\n- a\n</nightshift-memory>`)).toEqual({ text: "# Team memory\n- a\n", summary: "Note the scan" });
    expect(memoryBlockIn("<nightshift-memory>\r\n# M\r\n</nightshift-memory>")).toEqual({ text: "# M\n" });
    expect(memoryBlockIn("No memory change.")).toBeNull();
  });

  it("gives Keeper the current MEMORY.md and the way to propose without a tool", () => {
    const prompt = memoryProposalPrompt(repo);
    expect(prompt).toContain("<nightshift-memory summary=");
    expect(prompt).toContain(MEMORY.trim());
    expect(prompt).toContain("Use no tool");
  });

  it("turns Keeper's block into a proposal on an approval card, writes nothing, and ignores any other bot's", () => {
    const { store, messages } = fakeStore();
    const ns = createNightShift({ dataDir: join(root, "data"), store, git: localGit, cwdOf: () => repo, audit: () => undefined, decide: () => undefined, send: async () => undefined });
    const block = `Report.\n<nightshift-memory summary="Scan cadence">\n${MEMORY}- The tooling scan runs Mondays.\n</nightshift-memory>`;
    ns.turnEnded("id-Researcher", "t-Researcher", block);
    ns.turnEnded("id-Keeper", "t-elsewhere", block);
    expect(ns.memory.list()).toEqual([]);
    ns.turnEnded("id-Keeper", "t-Keeper", block);
    expect(ns.memory.list()).toMatchObject([{ decision: "pending", summary: "Scan cadence", proposed_by: "bot:id-Keeper" }]);
    expect(messages.some((one) => one.threadId === "t-Keeper" && one.message.card?.title === "Save this change to MEMORY.md?")).toBe(true);
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).toBe(MEMORY);
    ns.turnEnded("id-Keeper", "t-Keeper", `<nightshift-memory>\n${MEMORY}- key sk-ant-api03-${"a".repeat(40)}\n</nightshift-memory>`);
    expect(messages.at(-1)!.message.text).toMatch(/did not propose that MEMORY\.md change: refused/);
  });
});
