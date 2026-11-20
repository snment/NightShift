import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import type { DiffStat, TaskGit } from "./git.ts";
import { createNightShiftLoop, DIFF_APPROVAL_TOOL, type LoopStore } from "./host.ts";

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

  it("keeps an unreadable task file aside and starts empty", () => {
    writeFileSync(join(root, "work-tasks.json"), "not json");
    const { store } = fakeStore();
    const loop = createNightShiftLoop({ dataDir: root, store, git: fakeGit(), audit: () => undefined, decide: () => undefined, send: async () => undefined });
    expect(loop.list()).toEqual([]);
    expect(readdirSync(root).some((name) => name.startsWith("work-tasks.json.unreadable-"))).toBe(true);
  });
});
