import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import type { DiffStat, TaskGit } from "./git.ts";
import { appendUsage, flushUsageLedger, readUsage, type UsageRow } from "../usage-ledger.ts";
import { bookTaskTurnUsage, createNightShiftLoop, DIFF_APPROVAL_TOOL, type LoopStore } from "./host.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "nightshift-host-")); });
afterEach(() => removeTempDir(root));

const fakeGit = (diff = "diff --git a/x b/x\n+x\n"): TaskGit => ({
  ensureBranch: (_repo, _branch, _base, worktree) => worktree,
  head: () => "abc123",
  diffStat: (): DiffStat => ({ files: 1, lines: 1, paths: ["x"] }),
  diff: () => diff,
  readFile: () => null,
});

function fakeStore() {
  const messages: Array<{ threadId: string; message: Record<string, any> }> = [];
  const bots = ["Researcher", "Builder", "Reviewer", "Keeper"].map((name) => ({ id: `id-${name}`, name, color: "blue" as never, threadId: `t-${name}` }));
  const store: LoopStore = {
    bots,
    bot: (id) => bots.find((bot) => bot.id === id),
    group: (id) => (id === "room-1" ? { threadId: "t-room" } : undefined),
    appendMessage: (threadId, message) => { messages.push({ threadId, message }); return { ...message, id: "m", at: 0 } as never; },
  };
  return { store, messages };
}

describe("createNightShiftLoop", () => {
  it("finds the starter bots by name, posts to the room as Keeper and gives the bot its turn", async () => {
    const { store, messages } = fakeStore();
    const sent: Array<{ botId: string; threadId: string; text: string }> = [];
    const audit: string[] = [];
    const loop = createNightShiftLoop({ dataDir: root, store, git: fakeGit(), audit: (row) => audit.push(`${row.category}:${row.action}`),
      decide: () => undefined, send: async (botId, threadId, text) => { sent.push({ botId, threadId, text }); } });
    const task = loop.create({ title: "Docs", project: root, tags: ["research"], room_id: "room-1", created_by: "loopback" }, { kind: "person", id: "loopback" });
    expect(task.owner_bot_id).toBe("id-Researcher");
    expect(sent[0]).toMatchObject({ botId: "id-Researcher", threadId: "t-Researcher" });
    expect(sent[0]!.text).toContain("You are the Researcher");
    expect(messages[0]).toMatchObject({ threadId: "t-room", message: { role: "bot", kind: "text", from: { botId: "id-Keeper", name: "Keeper" } } });
    expect(audit).toEqual(["task:task.created", "task:task.branch-created", "task:task.assigned"]);
  });

  it("puts the exact diff on an approval card and logs that the card was shown", () => {
    const { store, messages } = fakeStore();
    const decisions: Array<Record<string, unknown>> = [];
    const loop = createNightShiftLoop({ dataDir: root, store, git: fakeGit("diff --git a/n b/n\n+exact\n"), audit: () => undefined,
      decide: (row) => decisions.push(row), send: async () => undefined });
    const task = loop.create({ title: "Docs", project: root, room_id: "room-1", created_by: "loopback" }, { kind: "person", id: "loopback" });
    loop.patch(task.id, { status: "Done" }, { kind: "person", id: "loopback" });
    const asked = loop.requestDiffApproval(task.id, "push", { kind: "person", id: "loopback" });
    const card = messages.find((one) => one.message.kind === "options")!;
    expect(card.threadId).toBe("t-room");
    expect(card.message.text).toContain("+exact");
    expect(card.message.card).toMatchObject({ requestId: asked.approvals[0]!.request_id, tool: DIFF_APPROVAL_TOOL });
    expect(decisions[0]).toMatchObject({ decision: "card-shown", tool: DIFF_APPROVAL_TOOL, threadId: "t-room" });
  });

  it("books a ledger row on the task its bot works on, only for turns in the bot's own chat", async () => {
    const { store } = fakeStore();
    const audit: Array<{ action: string; after?: Record<string, unknown> }> = [];
    const loop = createNightShiftLoop({ dataDir: root, store, git: fakeGit(), audit: (row) => audit.push(row),
      decide: () => undefined, send: async () => undefined });
    const task = loop.create({ title: "Docs", project: root, tags: ["research"], created_by: "loopback" }, { kind: "person", id: "loopback" });
    const row: Omit<UsageRow, "at"> = { botId: "id-Researcher", botName: "Researcher", threadId: "t-Researcher", instanceId: "claude",
      driverKind: "claudeAgent", model: "claude-opus-5-5", input: 1234, output: 321, cachedInput: 9000, cacheWrite: 77,
      costUsd: null, trigger: { kind: "bot" }, turnId: "turn-1" };
    expect(await appendUsage(root, row)).toBe(true);
    await flushUsageLedger(root);
    const [booked] = readUsage(root, { from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000) });
    expect(bookTaskTurnUsage(loop, store, { ...booked!, threadId: "t-room" })).toBeNull();
    expect(bookTaskTurnUsage(loop, store, { ...booked!, botId: "id-unknown" })).toBeNull();
    const after = bookTaskTurnUsage(loop, store, booked!)!;
    expect(after.id).toBe(task.id);
    expect(after.token_usage.researcher).toEqual({ inputTokens: 1234, outputTokens: 321, cachedInputTokens: 9000, cacheWriteTokens: 77, turns: 1, models: ["claude-opus-5-5"] });
    const usage = audit.find((one) => one.action === "task.usage")!;
    expect(usage.after).toMatchObject({ by: "bot:id-Researcher", role: "researcher", source: "ledger", inputTokens: 1234, outputTokens: 321,
      engine: "claudeAgent", model: "claude-opus-5-5", turnId: "turn-1" });
    expect(loop.get(task.id).token_usage.researcher!.inputTokens).toBe(1234);
  });

  it("never lets a failing loop fail the ledger's booking", () => {
    const { store } = fakeStore();
    const broken = { noteTurnUsage: () => { throw new Error("disk full"); } } as never;
    expect(bookTaskTurnUsage(broken, store, { botId: "id-Builder", threadId: "t-Builder", input: 1, output: 1 })).toBeNull();
  });

  it("keeps an unreadable task file aside and starts empty", () => {
    writeFileSync(join(root, "work-tasks.json"), "not json");
    const { store } = fakeStore();
    const loop = createNightShiftLoop({ dataDir: root, store, git: fakeGit(), audit: () => undefined, decide: () => undefined, send: async () => undefined });
    expect(loop.list()).toEqual([]);
    expect(readdirSync(root).some((name) => name.startsWith("work-tasks.json.unreadable-"))).toBe(true);
  });
});
