import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { EXIT, flag, usageError } from "./args.ts";
import type { VerbContext, VerbOutcome } from "./context.ts";

type Rec = Record<string, any>;

const list = (value: string | undefined) => value?.split(",").map((one) => one.trim()).filter(Boolean);

function line(task: Rec): string {
  const owner = task.owner_bot_id ? ` owner ${task.owner_bot_id}` : "";
  const tags = task.tags?.length ? ` + ${task.tags.join(", ")}` : "";
  return `${task.id}  ${task.slug}  [${task.status}${tags}] round ${task.review_round}${owner}  ${task.title}`;
}

function detail(task: Rec): string[] {
  const usage = Object.entries(task.token_usage ?? {}).map(([role, n]: [string, any]) => `${role} ${n.inputTokens} in / ${n.outputTokens} out`);
  return [
    line(task),
    `  branch ${task.branch} from ${task.base_branch}${task.worktree_path ? ` (worktree ${task.worktree_path})` : ""}`,
    ...(task.research_path ? [`  research ${task.research_path}`] : []),
    ...(task.handoff_path ? [`  handoff ${task.handoff_path}`] : []),
    ...(task.blocked_reason ? [`  blocked: ${task.blocked_reason}`] : []),
    ...(task.review_notes ? [`  review notes: ${task.review_notes}`] : []),
    ...(usage.length ? [`  tokens: ${usage.join("; ")}`] : []),
    ...(task.approvals ?? []).map((a: Rec) => `  ${a.action} approval ${a.request_id}: ${a.decision} (sha256 ${a.diff_sha256})`),
  ];
}

async function call(ctx: VerbContext, path: string, method = "GET", body?: Rec): Promise<Rec> {
  const client = await ctx.client();
  return client.json<Rec>(path, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const asBot = (ctx: VerbContext): Rec => {
  const bot = flag(ctx.flags, "as-bot");
  return bot ? { as_bot: bot } : {};
};

const done = (task: Rec): VerbOutcome => ({ result: { task }, exitCode: EXIT.done, human: detail(task) });

const needId = (ctx: VerbContext): string => {
  const id = ctx.positionals[0]?.trim();
  if (!id) throw usageError(`${ctx.verb} needs a task id or slug`, "openmausbot tasks lists them");
  return encodeURIComponent(id);
};

export async function tasksVerb(ctx: VerbContext): Promise<VerbOutcome> {
  if (ctx.verb === "tasks") {
    const { tasks = [] } = await call(ctx, "/api/tasks");
    return { result: { tasks }, exitCode: EXIT.done, human: tasks.length ? tasks.map(line) : ["No tasks."] };
  }
  if (ctx.verb === "task create") {
    const title = ctx.positionals[0]?.trim();
    if (!title) throw usageError("task create needs a title");
    const project = flag(ctx.flags, "project");
    if (!project) throw usageError("task create needs --project PATH (the repository the task changes)");
    const { task } = await call(ctx, "/api/tasks", "POST", {
      title, project: resolve(project),
      ...(flag(ctx.flags, "description") ? { description: flag(ctx.flags, "description") } : {}),
      ...(flag(ctx.flags, "slug") ? { slug: flag(ctx.flags, "slug") } : {}),
      ...(flag(ctx.flags, "room") ? { room_id: flag(ctx.flags, "room") } : {}),
      ...(flag(ctx.flags, "base") ? { base_branch: flag(ctx.flags, "base") } : {}),
      ...(list(flag(ctx.flags, "tags")) ? { tags: list(flag(ctx.flags, "tags")) } : {}),
      ...asBot(ctx),
    });
    return done(task);
  }
  if (ctx.verb === "task show") return done((await call(ctx, `/api/tasks/${needId(ctx)}`)).task);
  if (ctx.verb === "task update") {
    const body: Rec = { ...asBot(ctx) };
    for (const [option, field] of [["status", "status"], ["title", "title"], ["description", "description"], ["room", "room_id"]] as const) {
      const value = flag(ctx.flags, option);
      if (value !== undefined) body[field] = value;
    }
    if (flag(ctx.flags, "tags") !== undefined) body.tags = list(flag(ctx.flags, "tags")) ?? [];
    if (ctx.flags["allow-large-diff"] === true) body.diff_override = true;
    return done((await call(ctx, `/api/tasks/${needId(ctx)}`, "PATCH", body)).task);
  }
  if (ctx.verb === "task transition") {
    const event = ctx.positionals[1]?.trim();
    if (!event) throw usageError("task transition needs an event: research.done, build.done, review.approve, review.changes, stop, resume, reassign or usage");
    const body: Rec = { event, ...asBot(ctx) };
    const map = [["research-path", "research_path"], ["handoff-path", "handoff_path"], ["notes", "notes"], ["reason", "reason"], ["bot", "bot_id"], ["role", "role"]] as const;
    for (const [option, field] of map) {
      const value = flag(ctx.flags, option);
      if (value !== undefined) body[field] = value;
    }
    if (ctx.flags["reset-rounds"] === true) body.reset_rounds = true;
    if (event === "usage") {
      body.role = flag(ctx.flags, "role");
      body.input_tokens = Number(flag(ctx.flags, "input-tokens") ?? "0");
      body.output_tokens = Number(flag(ctx.flags, "output-tokens") ?? "0");
    }
    return done((await call(ctx, `/api/tasks/${needId(ctx)}/transition`, "POST", body)).task);
  }
  if (ctx.verb === "task request-approval") {
    return done((await call(ctx, `/api/tasks/${needId(ctx)}/request-approval`, "POST", { action: flag(ctx.flags, "action") ?? "push", ...asBot(ctx) })).task);
  }
  if (ctx.verb === "task approve-diff") {
    const approve = ctx.flags.approve === true, deny = ctx.flags.deny === true;
    if (approve === deny) throw usageError("say --approve or --deny");
    const request = flag(ctx.flags, "request"), sha = flag(ctx.flags, "sha256");
    if (!request || !sha) throw usageError("task approve-diff needs --request ID and --sha256 of the diff you read (task show prints both)");
    return done((await call(ctx, `/api/tasks/${needId(ctx)}/approve-diff`, "POST", { request_id: request, diff_sha256: sha, decision: approve ? "approved" : "denied" })).task);
  }
  throw usageError(`unknown verb ${ctx.verb}`);
}

function proposalLines(proposal: Rec, withDiff: boolean): string[] {
  return [
    `${proposal.id}  [${proposal.decision}]  ${proposal.project}  sha256 ${proposal.proposed_sha256}${proposal.summary ? `  ${proposal.summary}` : ""}`,
    ...(withDiff ? String(proposal.diff ?? "").split("\n").map((row) => `  ${row}`) : []),
  ];
}

export async function teamMemoryVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const shown = (proposal: Rec, withDiff = true): VerbOutcome => ({ result: { proposal }, exitCode: EXIT.done, human: proposalLines(proposal, withDiff) });
  if (ctx.verb === "team-memory proposals") {
    const { proposals = [] } = await call(ctx, "/api/team-memory/proposals");
    return { result: { proposals }, exitCode: EXIT.done, human: proposals.length ? proposals.flatMap((one: Rec) => proposalLines(one, false)) : ["No memory proposals."] };
  }
  if (ctx.verb === "team-memory propose") {
    const project = flag(ctx.flags, "project"), file = flag(ctx.flags, "file");
    if (!project || !file) throw usageError("team-memory propose needs --project PATH and --file NEW_MEMORY_FILE (the whole new MEMORY.md)");
    let text: string;
    try {
      text = readFileSync(resolve(file), "utf8");
    } catch (error) {
      throw usageError(`${file} could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
    const { proposal } = await call(ctx, "/api/team-memory/proposals", "POST", {
      project: resolve(project), text, ...(flag(ctx.flags, "summary") ? { summary: flag(ctx.flags, "summary") } : {}), ...asBot(ctx),
    });
    return { ...shown(proposal), human: [...proposalLines(proposal, true), "Waiting for a person to approve it; MEMORY.md is unchanged until then."] };
  }
  const id = ctx.positionals[0]?.trim();
  if (!id) throw usageError(`${ctx.verb} needs a proposal id`, "openmausbot team-memory proposals lists them");
  if (ctx.verb === "team-memory show") return shown((await call(ctx, `/api/team-memory/proposals/${encodeURIComponent(id)}`)).proposal);
  if (ctx.verb === "team-memory decide") {
    const approve = ctx.flags.approve === true, deny = ctx.flags.deny === true;
    if (approve === deny) throw usageError("say --approve or --deny");
    const sha = flag(ctx.flags, "sha256");
    if (!sha) throw usageError("team-memory decide needs --sha256 of the change you read (team-memory show prints it)");
    return shown((await call(ctx, `/api/team-memory/proposals/${encodeURIComponent(id)}/decide`, "POST", { proposed_sha256: sha, decision: approve ? "approved" : "denied" })).proposal, false);
  }
  throw usageError(`unknown verb ${ctx.verb}`);
}
