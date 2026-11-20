import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { PASS } from "../routes/table.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { localGit } from "./git.ts";
import { ReviewLoop } from "./loop.ts";
import { createWorkTaskRoutes } from "./routes.ts";
import { WorkTaskStore } from "./store.ts";

let root: string, repo: string, server: Server, base: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "nightshift-routes-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.test");
  git(repo, "config", "user.name", "T");
  writeFileSync(join(repo, "README.md"), "x\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  const loop = new ReviewLoop({
    store: new WorkTaskStore(join(root, "data", "work-tasks.json")), git: localGit, worktreeRoot: join(root, "data", "worktrees"),
    roles: () => ({ researcher: "r", builder: "b", reviewer: "v", keeper: "k" }), audit: () => undefined,
  });
  const route = createWorkTaskRoutes({ loop, botExists: (id) => ["r", "b", "v", "k"].includes(id), person: () => "loopback" });
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    void route({ req, res, url, path: url.pathname, method: req.method!, auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody })
      .then((out) => { if (out === PASS) json(res, 404, { error: "pass" }); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { git(repo, "worktree", "prune"); } catch { /* best effort */ }
  removeTempDir(root);
});

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() as Record<string, any> };
};

describe("/api/tasks", () => {
  it("creates, lists, shows and transitions a task", async () => {
    const created = await call("POST", "/api/tasks", { title: "Docs note", project: repo, tags: ["research"] });
    expect(created.status).toBe(201);
    expect(created.body.task).toMatchObject({ slug: "docs-note", status: "Working", owner_bot_id: "r" });
    expect((await call("GET", "/api/tasks")).body.tasks).toHaveLength(1);
    expect((await call("GET", "/api/tasks/docs-note")).body.task.id).toBe(created.body.task.id);
    const wrongBot = await call("POST", `/api/tasks/${created.body.task.id}/transition`, { event: "research.done", research_path: "x.md", as_bot: "b" });
    expect(wrongBot.status).toBe(403);
    const unknownBot = await call("POST", `/api/tasks/${created.body.task.id}/transition`, { event: "stop", as_bot: "nobody" });
    expect(unknownBot).toMatchObject({ status: 400, body: { error: "unknown bot: nobody" } });
    const stopped = await call("POST", `/api/tasks/${created.body.task.id}/transition`, { event: "stop", as_bot: "k", reason: "later" });
    expect(stopped.body.task).toMatchObject({ status: "Blocked", blocked_reason: "later" });
  });

  it("answers 404 for a missing task and passes on other paths", async () => {
    expect((await call("GET", "/api/tasks/nope")).status).toBe(404);
    expect((await call("GET", "/api/other")).body.error).toBe("pass");
  });

  it("needs the exact diff's sha256 to approve", async () => {
    const created = await call("POST", "/api/tasks", { title: "x", project: repo });
    const res = await call("POST", `/api/tasks/${created.body.task.id}/approve-diff`, { request_id: "r1", decision: "approved" });
    expect(res).toMatchObject({ status: 400, body: { error: expect.stringMatching(/diff_sha256 is required/) } });
    const bot = await call("PATCH", `/api/tasks/${created.body.task.id}`, { status: "Done", as_bot: "b" });
    expect(bot.status).toBe(403);
  });
});
