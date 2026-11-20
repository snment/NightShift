import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { parseCommand } from "../headless/args.ts";
import { taskAuditRow } from "./audit.ts";
import { diffGate, diffSha256, localGit, parseNumstat } from "./git.ts";
import { validateHandoff, validateResearch } from "./handoff.ts";
import { diffApprovalCard, DIFF_APPROVAL_TOOL } from "./host.ts";
import { LoopError, ReviewLoop, type LoopActor, type TaskAuditEvent } from "./loop.ts";
import { slugify, type ReviewRole, type WorkTask } from "./model.ts";
import { WorkTaskStore } from "./store.ts";

const ROLES = { researcher: "bot-res", builder: "bot-build", reviewer: "bot-rev", keeper: "bot-keep" } as const;
const PERSON: LoopActor = { kind: "person", id: "loopback" };
const bot = (role: keyof typeof ROLES): LoopActor => ({ kind: "bot", id: ROLES[role] });

const HANDOFF = (slug: string) => `# Handoff: ${slug}

## Files changed
- docs/note.md:1 adds the note the task asked for.

## Decisions
- Kept it to one file.

## Tests
- Ran: none needed for a docs change.
- Not run: the full suite (docs only).

## Risky / unsure
- Nothing.

## Do not re-read
- README.md
`;

const RESEARCH = "# Research\n\n- https://example.com/spec (accessed 2026-11-20)\n- Claim X: UNVERIFIED\n";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeRepo(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.test");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

function commitIn(worktree: string, files: Record<string, string>, message = "work"): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(worktree, path)), { recursive: true });
    writeFileSync(join(worktree, path), text);
  }
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", message);
}

interface Harness {
  loop: ReviewLoop;
  store: WorkTaskStore;
  audit: TaskAuditEvent[];
  posts: string[];
  dispatched: Array<{ role: ReviewRole; botId: string; prompt: string }>;
  cards: Array<{ requestId: string; diff: string }>;
}

let root: string;
let repo: string;

function harness(roles: Partial<Record<ReviewRole, string>> = ROLES): Harness {
  const store = new WorkTaskStore(join(root, "data", "work-tasks.json"));
  const h: Harness = { loop: undefined as unknown as ReviewLoop, store, audit: [], posts: [], dispatched: [], cards: [] };
  h.loop = new ReviewLoop({
    store, git: localGit, worktreeRoot: join(root, "data", "worktrees"), roles: () => roles,
    audit: (event) => h.audit.push(event),
    post: (_task, text) => h.posts.push(text),
    dispatch: (role, botId, _task, prompt) => h.dispatched.push({ role, botId, prompt }),
    card: (_task, approval, diff) => { h.cards.push({ requestId: approval.request_id, diff }); return "room-thread"; },
  });
  return h;
}

function newTask(h: Harness, tags: string[] = ["research"], title = "Add a docs note"): WorkTask {
  return h.loop.create({ title, project: repo, tags, room_id: "room-1", created_by: "loopback" }, PERSON);
}

function researchDone(h: Harness, task: WorkTask): WorkTask {
  writeFileSync(join(task.worktree_path!, "docs-research.md"), RESEARCH);
  return h.loop.transition(task.id, { event: "research.done", research_path: "docs-research.md" }, bot("researcher"));
}

function build(h: Harness, task: WorkTask, files: Record<string, string> = { "docs/note.md": "a note\n" }): WorkTask {
  commitIn(task.worktree_path!, { ...files, [`docs/handoffs/${task.slug}.md`]: HANDOFF(task.slug) });
  return h.loop.transition(task.id, { event: "build.done" }, bot("builder"));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nightshift-loop-"));
  repo = makeRepo(root);
});

afterEach(() => {
  try { git(repo, "worktree", "prune"); } catch { /* best effort */ }
  removeTempDir(root);
});

describe("WorkTaskStore", () => {
  it("creates a task with the full model and keeps it across a reload", () => {
    const store = new WorkTaskStore(join(root, "work-tasks.json"), () => 1000);
    const task = store.create({ title: "Fix docs typo", project: repo, tags: ["dev", "dev"], created_by: "loopback" });
    expect(task).toMatchObject({
      slug: "fix-docs-typo", title: "Fix docs typo", status: "To Do", tags: ["dev"], owner_bot_id: null, branch: "feat/fix-docs-typo",
      base_branch: "main", review_round: 0, review_notes: null, research_path: null, handoff_path: null, room_id: null,
      token_usage: {}, approvals: [], created_by: "loopback", created_at: 1000, updated_at: 1000,
    });
    store.update(task.id, (t) => { t.status = "Working"; });
    const reloaded = new WorkTaskStore(join(root, "work-tasks.json"));
    expect(reloaded.get(task.id)?.status).toBe("Working");
    expect(reloaded.get("fix-docs-typo")?.id).toBe(task.id);
  });

  it("gives each task its own slug and refuses an unsafe one", () => {
    const store = new WorkTaskStore(join(root, "work-tasks.json"));
    expect(store.create({ title: "Same", project: repo, created_by: "x" }).slug).toBe("same");
    expect(store.create({ title: "Same", project: repo, created_by: "x" }).slug).toBe("same-2");
    expect(() => store.create({ title: "x", slug: "../evil", project: repo, created_by: "x" })).toThrow(/slug/);
    expect(slugify("Héllo, World!  ")).toBe("hello-world");
  });

  it("refuses a file that is not a task list", () => {
    writeFileSync(join(root, "bad.json"), "{}");
    expect(() => new WorkTaskStore(join(root, "bad.json"))).toThrow(/not a task list/);
  });
});

describe("status and tag routing", () => {
  it("runs To Do + research -> To Do + dev -> Needs Review + review -> Done", () => {
    const h = harness();
    let task = newTask(h);
    expect(task).toMatchObject({ status: "Working", owner_bot_id: ROLES.researcher, tags: ["research"] });
    expect(existsSync(task.worktree_path!)).toBe(true);
    expect(git(task.worktree_path!, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(`feat/${task.slug}`);
    expect(h.dispatched.at(-1)).toMatchObject({ role: "researcher", botId: ROLES.researcher });

    task = researchDone(h, task);
    expect(task).toMatchObject({ status: "Working", owner_bot_id: ROLES.builder, tags: ["dev"], research_path: "docs-research.md" });
    expect(h.dispatched.at(-1)!.prompt).toContain("docs-research.md");
    expect(h.dispatched.at(-1)!.prompt).toContain(`feat/${task.slug}`);

    task = build(h, task);
    expect(task).toMatchObject({ status: "Needs Review", owner_bot_id: ROLES.reviewer, tags: ["review"], review_round: 1, handoff_path: `docs/handoffs/${task.slug}.md` });
    const review = h.dispatched.at(-1)!;
    expect(review.role).toBe("reviewer");
    expect(review.prompt).toContain(`git diff main...feat/${task.slug}`);
    expect(review.prompt).toContain(`docs/handoffs/${task.slug}.md`);

    task = h.loop.transition(task.id, { event: "review.approve" }, bot("reviewer"));
    expect(task).toMatchObject({ status: "Done", owner_bot_id: null, tags: [] });
    expect(h.dispatched.at(-1)).toMatchObject({ role: "keeper", botId: ROLES.keeper });
    expect(h.posts.some((line) => line.includes("Done; nothing was pushed or merged"))).toBe(true);
  });

  it("starts a dev task straight with the Builder and never dirties the base checkout", () => {
    const h = harness();
    const task = newTask(h, ["dev"]);
    expect(task).toMatchObject({ status: "Working", owner_bot_id: ROLES.builder });
    build(h, task);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(git(repo, "log", "--oneline", "main").trim().split("\n")).toHaveLength(1);
    expect(git(repo, "log", "--oneline", `feat/${task.slug}`).trim().split("\n")).toHaveLength(2);
  });

  it("sends changes back to the Builder and reviews only the new hunks in round 2", () => {
    const h = harness();
    let task = build(h, newTask(h, ["dev"]));
    const firstHead = task.reviewed_head;
    task = h.loop.transition(task.id, { event: "review.changes", notes: "docs/note.md:1 say what the note is for" }, bot("reviewer"));
    expect(task).toMatchObject({ status: "Working", tags: ["dev"], owner_bot_id: ROLES.builder, review_notes: "docs/note.md:1 say what the note is for" });
    expect(h.dispatched.at(-1)!.prompt).toContain("docs/note.md:1 say what the note is for");
    task = build(h, task, { "docs/note.md": "a note about the loop\n" });
    expect(task.review_round).toBe(2);
    expect(h.dispatched.at(-1)!.prompt).toContain(`git diff ${firstHead}..feat/${task.slug}`);
  });

  it("stops at Blocked after 3 rounds of changes and never starts a 4th review", () => {
    const h = harness();
    let task = build(h, newTask(h, ["dev"]));
    for (let round = 1; round <= 3; round++) {
      expect(task.review_round).toBe(round);
      task = h.loop.transition(task.id, { event: "review.changes", notes: `docs/note.md:${round} still wrong` }, bot("reviewer"));
      if (round < 3) task = build(h, task, { "docs/note.md": `round ${round}\n` });
    }
    expect(task).toMatchObject({ status: "Blocked", owner_bot_id: null, review_round: 3 });
    expect(task.blocked_reason).toMatch(/review cap/);
    expect(h.dispatched.filter((one) => one.role === "reviewer")).toHaveLength(3);
    expect(h.dispatched.at(-1)!.role).toBe("keeper");
    expect(h.audit.map((event) => event.action)).toContain("task.review-cap");
    expect(() => h.loop.transition(task.id, { event: "resume", reset_rounds: true }, bot("builder"))).toThrow(LoopError);
  });

  it("asks for file:line review notes", () => {
    const h = harness();
    const task = build(h, newTask(h, ["dev"]));
    expect(() => h.loop.transition(task.id, { event: "review.changes", notes: "make it better" }, bot("reviewer"))).toThrow(/file:line/);
  });

  it("blocks a task when a role has no bot", () => {
    const h = harness({ builder: ROLES.builder });
    const task = newTask(h, ["research"]);
    expect(task).toMatchObject({ status: "Blocked", blocked_reason: "no researcher bot is set up" });
  });

  it("lets only the task's owner or a person move it on", () => {
    const h = harness();
    const task = newTask(h, ["dev"]);
    commitIn(task.worktree_path!, { "docs/note.md": "x\n", [`docs/handoffs/${task.slug}.md`]: HANDOFF(task.slug) });
    expect(() => h.loop.transition(task.id, { event: "build.done" }, bot("reviewer"))).toThrow(/only the task's builder/);
    expect(() => h.loop.patch(task.id, { status: "Done" }, bot("builder"))).toThrow(/only a person/);
    expect(() => h.loop.transition(task.id, { event: "stop" }, bot("builder"))).toThrow(/person or the Keeper/);
    expect(h.loop.transition(task.id, { event: "stop", reason: "waiting on design" }, bot("keeper")).status).toBe("Blocked");
    expect(h.loop.transition(task.id, { event: "resume" }, PERSON)).toMatchObject({ status: "Working", owner_bot_id: ROLES.builder });
  });

  it("routes again when a person sets status and tags", () => {
    const h = harness();
    const task = h.loop.create({ title: "Later", project: repo, created_by: "loopback" }, PERSON);
    expect(task).toMatchObject({ status: "To Do", owner_bot_id: null });
    expect(h.loop.patch(task.id, { tags: ["research"] }, PERSON)).toMatchObject({ status: "Working", owner_bot_id: ROLES.researcher });
  });

  it("records token counts per role", () => {
    const h = harness();
    const task = newTask(h, ["dev"]);
    h.loop.transition(task.id, { event: "usage", role: "builder", input_tokens: 1200, output_tokens: 300 }, bot("builder"));
    const after = h.loop.transition(task.id, { event: "usage", role: "builder", input_tokens: 100, output_tokens: 50 }, bot("builder"));
    expect(after.token_usage).toEqual({ builder: { inputTokens: 1300, outputTokens: 350 } });
    expect(() => h.loop.transition(task.id, { event: "usage", role: "builder", input_tokens: -1, output_tokens: 0 }, PERSON)).toThrow(/whole numbers/);
  });
});

describe("handoff and research packets", () => {
  it("accepts a packet with every section", () => {
    expect(validateHandoff(HANDOFF("x"))).toEqual({ ok: true, problems: [] });
  });

  it("names each missing or weak section", () => {
    const check = validateHandoff("# Handoff\n\n## Files changed\n- changed some files\n\n## Tests\n- all passed\n");
    expect(check.ok).toBe(false);
    expect(check.problems).toEqual(expect.arrayContaining([
      "missing section: Decisions", "missing section: Risky / unsure", "missing section: Do not re-read",
      "Files changed must name each change as path:line", expect.stringMatching(/not run/),
    ]));
  });

  it("rejects a pasted file", () => {
    const dump = `${HANDOFF("x")}\n\`\`\`ts\n${Array.from({ length: 40 }, (_, i) => `const a${i} = ${i};`).join("\n")}\n\`\`\`\n`;
    expect(validateHandoff(dump).problems).toEqual([expect.stringMatching(/fenced block has 40 lines/)]);
  });

  it("asks a research packet for a URL and the date it was read", () => {
    expect(validateResearch(RESEARCH).ok).toBe(true);
    expect(validateResearch("no sources").problems).toHaveLength(2);
  });

  it("keeps a task Working when its handoff is missing or incomplete", () => {
    const h = harness();
    const task = newTask(h, ["dev"]);
    commitIn(task.worktree_path!, { "docs/note.md": "x\n" });
    expect(() => h.loop.transition(task.id, { event: "build.done" }, bot("builder"))).toThrow(/handoff packet .* was not found/);
    commitIn(task.worktree_path!, { [`docs/handoffs/${task.slug}.md`]: "# Handoff\n" });
    expect(() => h.loop.transition(task.id, { event: "build.done" }, bot("builder"))).toThrow(/handoff packet rejected/);
    expect(h.loop.get(task.id).status).toBe("Working");
  });

  it("refuses a research packet without sources", () => {
    const h = harness();
    const task = newTask(h);
    writeFileSync(join(task.worktree_path!, "r.md"), "just memory");
    expect(() => h.loop.transition(task.id, { event: "research.done", research_path: "r.md" }, bot("researcher"))).toThrow(/research packet rejected/);
  });
});

describe("diff size gate", () => {
  it("counts lines and files from numstat", () => {
    const stat = parseNumstat("3\t1\ta.ts\n-\t-\timage.png\n10\t0\tb.ts\n");
    expect(stat).toEqual({ files: 3, lines: 14, paths: ["a.ts", "image.png", "b.ts"] });
    expect(diffGate({ files: 10, lines: 400, paths: [] }).over).toBe(false);
    expect(diffGate({ files: 11, lines: 1, paths: [] }).reason).toMatch(/11 changed files/);
    expect(diffGate({ files: 1, lines: 401, paths: [] }).reason).toMatch(/401 changed lines/);
  });

  it("flags a diff over 400 lines to split instead of reviewing it", () => {
    const h = harness();
    const task = build(h, newTask(h, ["dev"]), { "big.txt": `${Array.from({ length: 401 }, (_, i) => `line ${i}`).join("\n")}\n` });
    expect(task).toMatchObject({ status: "Blocked", owner_bot_id: null });
    expect(task.blocked_reason).toMatch(/split the task/);
    expect(h.dispatched.some((one) => one.role === "reviewer")).toBe(false);
    expect(h.audit.map((event) => event.action)).toContain("task.split-flagged");
  });

  it("flags more than 10 files, and lets a person allow the larger diff", () => {
    const h = harness();
    const files = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}.txt`, "x\n"]));
    let task = build(h, newTask(h, ["dev"]), files);
    expect(task.status).toBe("Blocked");
    h.loop.patch(task.id, { diff_override: true }, PERSON);
    task = h.loop.transition(task.id, { event: "resume" }, PERSON);
    expect(task.owner_bot_id).toBe(ROLES.builder);
    task = h.loop.transition(task.id, { event: "build.done" }, bot("builder"));
    expect(task).toMatchObject({ status: "Needs Review", owner_bot_id: ROLES.reviewer });
  });
});

describe("approval of the exact diff", () => {
  function doneTask(h: Harness): WorkTask {
    const task = build(h, newTask(h, ["dev"]));
    return h.loop.transition(task.id, { event: "review.approve" }, bot("reviewer"));
  }

  it("asks only for a reviewed task and shows the exact diff on the card", () => {
    const h = harness();
    const working = newTask(h, ["dev"]);
    expect(() => h.loop.requestDiffApproval(working.id, "push", bot("builder"))).toThrow(/reviewed task/);
    const task = h.loop.requestDiffApproval(doneTask(h).id, "push", bot("builder"));
    const approval = task.approvals[0]!;
    const diff = git(repo, "diff", `main...feat/${task.slug}`);
    expect(approval).toMatchObject({ action: "push", decision: "pending", diff_sha256: diffSha256(diff), thread_id: "room-thread" });
    expect(h.cards[0]!.diff).toBe(diff);
    const card = diffApprovalCard(task, approval, diff);
    expect(card.card).toMatchObject({ requestId: approval.request_id, requestType: "permission", tool: DIFF_APPROVAL_TOOL, options: ["Approve", "Deny"] });
    expect(card.text).toContain(diff.trim());
  });

  it("never lets a bot approve, and refuses another diff's sha", () => {
    const h = harness();
    const task = h.loop.requestDiffApproval(doneTask(h).id, "merge", PERSON);
    const { request_id: requestId, diff_sha256: sha } = task.approvals[0]!;
    expect(() => h.loop.decideDiffApproval(task.id, requestId, "approved", sha, bot("keeper"))).toThrow(/only a person/);
    expect(() => h.loop.decideDiffApproval(task.id, requestId, "approved", "0".repeat(64), PERSON)).toThrow(/not the diff/);
    const approved = h.loop.decideDiffApproval(task.id, requestId, "approved", sha, PERSON);
    expect(approved.approvals[0]).toMatchObject({ decision: "approved", decided_by: "loopback" });
    expect(git(repo, "log", "--oneline", "main").trim().split("\n")).toHaveLength(1);
  });

  it("goes stale when the branch changes after the card was shown", () => {
    const h = harness();
    const task = h.loop.requestDiffApproval(doneTask(h).id, "push", PERSON);
    commitIn(task.worktree_path!, { "docs/note.md": "changed after review\n" });
    const { request_id: requestId, diff_sha256: sha } = task.approvals[0]!;
    expect(() => h.loop.decideDiffApproval(task.id, requestId, "approved", sha, PERSON)).toThrow(/branch changed/);
    expect(h.loop.get(task.id).approvals[0]!.decision).toBe("stale");
  });

  it("answers its own card through the shared card route and passes on every other card", () => {
    const h = harness();
    const task = h.loop.requestDiffApproval(doneTask(h).id, "pr", PERSON);
    expect(h.loop.resolveCard("room-thread", "some-other-card", "allow", "approval card")).toBeNull();
    const answer = h.loop.resolveCard("room-thread", task.approvals[0]!.request_id, "deny", "approval card");
    expect(answer?.status).toBe(200);
    expect(h.loop.get(task.id).approvals[0]!.decision).toBe("denied");
  });
});

describe("audit log", () => {
  it("writes every lifecycle event in order", () => {
    const h = harness();
    let task = researchDone(h, newTask(h));
    task = build(h, task);
    h.loop.transition(task.id, { event: "usage", role: "reviewer", input_tokens: 10, output_tokens: 2 }, bot("reviewer"));
    task = h.loop.transition(task.id, { event: "review.approve" }, bot("reviewer"));
    task = h.loop.requestDiffApproval(task.id, "push", PERSON);
    h.loop.decideDiffApproval(task.id, task.approvals[0]!.request_id, "denied", task.approvals[0]!.diff_sha256, PERSON);
    expect(h.audit.map((event) => event.action)).toEqual([
      "task.created", "task.branch-created", "task.assigned", "task.research-written", "task.assigned",
      "task.handoff-written", "task.review-started", "task.assigned", "task.usage", "task.review-approved",
      "task.diff-approval-requested", "task.diff-approval-decided",
    ]);
    expect(h.audit.find((event) => event.action === "task.research-written")!.actor).toEqual(bot("researcher"));
  });

  it("maps an event to an admin-activity row of category task", () => {
    const row = taskAuditRow({ action: "task.review-approved", actor: bot("reviewer"), detail: { round: 1 },
      task: { id: "wt-1", slug: "s", title: "T", status: "Done", tags: [], owner_bot_id: null, review_round: 1, branch: "feat/s" } });
    expect(row).toMatchObject({ category: "task", action: "task.review-approved", target: { kind: "task", id: "wt-1", name: "s" },
      after: { by: "bot:bot-rev", status: "Done", round: 1, branch: "feat/s" }, actor: { kind: "cli" } });
    expect(taskAuditRow({ action: "task.created", actor: PERSON, task: { id: "a", slug: "a", title: "a", status: "To Do", tags: [], owner_bot_id: null, review_round: 0, branch: "feat/a" } }).actor)
      .toEqual({ kind: "loopback" });
  });
});

describe("command line", () => {
  it("parses the task verbs", () => {
    expect(parseCommand(["tasks"]).verb).toBe("tasks");
    expect(parseCommand(["task", "transition", "wt-1", "review.changes", "--notes", "a.ts:1 x", "--as-bot", "b1"])).toEqual({
      verb: "task transition", flags: { notes: "a.ts:1 x", "as-bot": "b1" }, positionals: ["wt-1", "review.changes"],
    });
    expect(parseCommand(["task", "create", "Fix it", "--project", ".", "--tags", "research"]).flags).toEqual({ project: ".", tags: "research" });
    expect(() => parseCommand(["task", "merge", "wt-1"])).toThrow(/task needs one of/);
  });
});

describe("store file", () => {
  it("is written as JSON beside the other registries", () => {
    const h = harness();
    newTask(h, ["dev"]);
    const saved = JSON.parse(readFileSync(join(root, "data", "work-tasks.json"), "utf8")) as WorkTask[];
    expect(saved).toHaveLength(1);
    expect(saved[0]!.status).toBe("Working");
  });
});
