import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { diffGate, diffSha256, type TaskGit } from "./git.ts";
import { handoffPathFor, validateHandoff, validateResearch } from "./handoff.ts";
import {
  DIFF_ACTIONS, MAX_REVIEW_ROUNDS, REVIEW_ROLES, ROUTINE_TAG, TEAM_MEMORY_FILE, routingTag, withTag, isWorkTaskStatus,
  type DiffAction, type DiffApproval, type ReviewRole, type RoleUsage, type TurnUsage, type UsageRole, type WorkTask,
} from "./model.ts";
import type { NewWorkTask, WorkTaskStore } from "./store.ts";

export type LoopActor = { kind: "person"; id: string } | { kind: "bot"; id: string } | { kind: "system"; id: "review-loop" };

const SYSTEM: LoopActor = { kind: "system", id: "review-loop" };

export type TaskAuditAction =
  | "task.created" | "task.updated" | "task.assigned" | "task.branch-created" | "task.research-written" | "task.handoff-written"
  | "task.review-started" | "task.review-approved" | "task.review-changes" | "task.review-cap" | "task.split-flagged"
  | "task.blocked" | "task.resumed" | "task.reassigned" | "task.usage"
  | "task.diff-approval-requested" | "task.diff-approval-decided" | "task.deleted"
  | "task.routine-started" | "task.redispatched" | "task.interrupted";

export interface TaskAuditEvent {
  action: TaskAuditAction;
  task: Pick<WorkTask, "id" | "slug" | "title" | "status" | "tags" | "owner_bot_id" | "review_round" | "branch">;
  actor: LoopActor;
  detail?: Record<string, unknown>;
}

export interface ReviewLoopDeps {
  store: WorkTaskStore;
  git: TaskGit;
  /** The bot that plays each role now, by id. */
  roles(): Partial<Record<ReviewRole, string>>;
  /** Where a task's worktree lives; never inside the base checkout's tracked tree. */
  worktreeRoot: string;
  audit(event: TaskAuditEvent): void;
  /** One line in the task's room (the team channel). */
  post?(task: WorkTask, text: string): void;
  /** Hands the bot its next turn. */
  dispatch?(role: ReviewRole, botId: string, task: WorkTask, prompt: string): void;
  /** Shows the exact diff to a person as an approval card; returns the thread the card is in. */
  card?(task: WorkTask, approval: DiffApproval, diff: string): string | null;
}

export class LoopError extends Error {
  readonly status: 400 | 403 | 404 | 409;

  constructor(status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

export type TransitionEvent =
  | { event: "research.done"; research_path: string }
  | { event: "build.done"; handoff_path?: string }
  | { event: "review.approve"; notes?: string }
  | { event: "review.changes"; notes: string }
  | { event: "stop"; reason?: string }
  | { event: "resume"; reset_rounds?: boolean }
  | { event: "reassign"; bot_id: string; role?: ReviewRole }
  | { event: "usage"; role: UsageRole; input_tokens: number; output_tokens: number };

/** One run of a routine that asks the loop for a research packet. */
export interface RoutineResearch {
  routineId: string;
  routineName: string;
  runId: string;
  title: string;
  description: string;
  project: string;
  base_branch?: string;
  room_id?: string | null;
}

/** What a restart found of a task a bot was working on. */
export interface RestartedTask {
  task: WorkTask;
  outcome: "redispatched" | "interrupted";
}

export interface TaskPatch {
  title?: string;
  description?: string;
  room_id?: string | null;
  tags?: string[];
  status?: string;
  diff_override?: boolean;
}

const FILE_LINE = /[\w./\\-]+\.[\w]+:\d+/;

const touchesTeamMemory = (paths: readonly string[]) => paths.some((path) => path.replace(/\\/g, "/").replace(/^\.\//, "") === TEAM_MEMORY_FILE);

const memoryProposal = (project: string, keeper: string | undefined) => `If the team should remember something from it, write the whole new ${TEAM_MEMORY_FILE} to a file outside the repository and propose it with: node --experimental-strip-types server/openmausbot.ts team-memory propose --project ${project} --file NEW_MEMORY_FILE --summary "one line"${keeper ? ` --as-bot ${keeper}` : ""}. The person sees the exact diff and approves it before it is saved; never write ${TEAM_MEMORY_FILE} yourself and never put a key, token or password in it.`;

function snapshot(task: WorkTask): TaskAuditEvent["task"] {
  const { id, slug, title, status, tags, owner_bot_id, review_round, branch } = task;
  return { id, slug, title, status, tags: [...tags], owner_bot_id, review_round, branch };
}

const USAGE_ROLES: readonly UsageRole[] = ["researcher", "builder", "reviewer"];

const isUsageRole = (role: ReviewRole): role is UsageRole => (USAGE_ROLES as readonly string[]).includes(role);

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);

export class ReviewLoop {
  private readonly deps: ReviewLoopDeps;
  /** The task and role each bot was last handed. The turn that ends with the bot's own transition is booked after
   * the task has moved on, so it still counts here once. Kept in memory: after a restart, a bot that still owns a
   * task is found from the task list instead. */
  private readonly turnOwners = new Map<string, { taskId: string; role: UsageRole }>();

  constructor(deps: ReviewLoopDeps) {
    this.deps = deps;
  }

  list(): WorkTask[] {
    return this.deps.store.list();
  }

  get(id: string): WorkTask {
    const task = this.deps.store.get(id);
    if (!task) throw new LoopError(404, `no task ${id}`);
    return task;
  }

  create(input: NewWorkTask, actor: LoopActor): WorkTask {
    if (!input.title?.trim()) throw new LoopError(400, "title is required");
    if (!input.project?.trim()) throw new LoopError(400, "project (the repository path) is required");
    let task: WorkTask;
    try {
      task = this.deps.store.create(input);
    } catch (error) {
      throw new LoopError(409, (error as Error).message);
    }
    this.audit("task.created", task, actor, { project: task.project, base: task.base_branch });
    this.post(task, `New task "${task.title}" (${task.slug}) [${task.status}${task.tags.length ? ` + ${task.tags.join(", ")}` : ""}]`);
    return this.route(task);
  }

  /** Starts a research-only task for one routine run. A run that already started one (a restart reran its start)
   * gets that task back, so a run never makes two. */
  createForRoutine(input: RoutineResearch): WorkTask {
    const existing = this.deps.store.list().find((task) => task.routine_run_id === input.runId);
    if (existing) return existing;
    if (!input.title.trim()) throw new LoopError(400, "the routine names no research title");
    if (!input.project.trim()) throw new LoopError(400, "the routine's bot has no project folder");
    const actor: LoopActor = SYSTEM;
    let task: WorkTask;
    try {
      task = this.deps.store.create({
        title: input.title, description: input.description, project: input.project, tags: ["research", ROUTINE_TAG],
        routine_run_id: input.runId, created_by: `routine:${input.routineId}`,
        ...(input.base_branch ? { base_branch: input.base_branch } : {}), ...(input.room_id ? { room_id: input.room_id } : {}),
      });
    } catch (error) {
      throw new LoopError(409, (error as Error).message);
    }
    this.audit("task.created", task, actor, { project: task.project, base: task.base_branch });
    this.audit("task.routine-started", task, actor, { routineId: input.routineId, routineName: input.routineName, runId: input.runId });
    this.post(task, `Routine "${input.routineName}" started research task "${task.title}" (${task.slug}) for Researcher.`);
    return this.route(task);
  }

  /** After a restart: a task a bot was working on gets its turn again, told that it was cut off, once. A second
   * restart on the same hand-over blocks it as interrupted, so nothing loops and nothing is silently lost. */
  recoverAfterRestart(busy: (botId: string) => boolean): RestartedTask[] {
    const found: RestartedTask[] = [];
    for (const task of this.deps.store.list()) {
      const working = (task.status === "Working" || (task.status === "Needs Review" && task.tags.includes("review"))) && task.owner_bot_id;
      if (!working) continue;
      const role = this.roleOf(task);
      if (!role || this.deps.roles()[role] !== task.owner_bot_id) continue;
      if (busy(task.owner_bot_id!)) continue;
      const handover = `${role}:${task.owner_bot_id}:${task.status}:${task.review_round}`;
      if (task.restart_handover === handover) {
        const next = this.block(task, "interrupted by a second NightShift restart before the bot finished; a person resumes it");
        this.audit("task.interrupted", next, SYSTEM, { role });
        this.tellKeeper(next, `Task "${next.title}" (${next.slug}) was cut off by a restart twice and is Blocked. Tell the person; they can resume it.`);
        found.push({ task: next, outcome: "interrupted" });
        continue;
      }
      const next = this.update(task, (t) => { t.restart_handover = handover; }, null);
      this.audit("task.redispatched", next, SYSTEM, { role, botId: next.owner_bot_id });
      this.post(next, `NightShift restarted while ${role} worked on "${next.title}"; handed it its turn again.`);
      this.handOver(role, next.owner_bot_id!, next, `NightShift restarted while you worked on this task. Check what you already did before doing it again.

${this.promptFor(role, next)}`);
      found.push({ task: next, outcome: "redispatched" });
    }
    return found;
  }

  private roleOf(task: WorkTask): ReviewRole | null {
    const tag = routingTag(task);
    if (task.status === "Working" && tag === "research") return "researcher";
    if (task.status === "Working" && tag === "dev") return "builder";
    if (task.status === "Needs Review" && tag === "review") return "reviewer";
    return null;
  }

  patch(id: string, patch: TaskPatch, actor: LoopActor): WorkTask {
    const current = this.get(id);
    if (actor.kind !== "person") throw new LoopError(403, "only a person edits a task directly; bots use a transition");
    if (patch.status !== undefined && !isWorkTaskStatus(patch.status)) throw new LoopError(400, `unknown status: ${patch.status}`);
    if (patch.status === "Needs Review") {
      const moved = this.update(current, (task) => {
        if (patch.tags) task.tags = [...new Set(patch.tags)];
      }, actor, patch);
      return this.submitBuild(moved, moved.handoff_path ?? undefined, actor);
    }
    const task = this.update(current, (task) => {
      if (patch.title !== undefined) task.title = patch.title.trim() || task.title;
      if (patch.description !== undefined) task.description = patch.description;
      if (patch.room_id !== undefined) task.room_id = patch.room_id;
      if (patch.tags !== undefined) task.tags = [...new Set(patch.tags)];
      if (patch.diff_override !== undefined) task.diff_override = patch.diff_override;
      if (patch.status !== undefined) {
        task.status = patch.status as WorkTask["status"];
        if (task.status === "To Do" || task.status === "Done") task.owner_bot_id = null;
        if (task.status !== "Blocked") task.blocked_reason = null;
      }
    }, actor, patch);
    return this.route(task);
  }

  transition(id: string, change: TransitionEvent, actor: LoopActor): WorkTask {
    const task = this.get(id);
    switch (change.event) {
      case "research.done": return this.submitResearch(task, change.research_path, actor);
      case "build.done": return this.submitBuild(task, change.handoff_path, actor);
      case "review.approve": return this.approve(task, change.notes, actor);
      case "review.changes": return this.requestChanges(task, change.notes, actor);
      case "stop": return this.stop(task, change.reason, actor);
      case "resume": return this.resume(task, change.reset_rounds === true, actor);
      case "reassign": return this.reassign(task, change.bot_id, change.role, actor);
      case "usage": return this.recordUsage(task, change.role, change.input_tokens, change.output_tokens, actor);
      default: throw new LoopError(400, `unknown event: ${(change as { event?: unknown }).event}`);
    }
  }

  delete(id: string, actor: LoopActor): boolean {
    const task = this.get(id);
    if (actor.kind !== "person") throw new LoopError(403, "only a person deletes a task");
    const gone = this.deps.store.delete(task.id);
    if (gone) this.audit("task.deleted", task, actor);
    return gone;
  }

  requestDiffApproval(id: string, action: DiffAction, actor: LoopActor): WorkTask {
    const task = this.get(id);
    if (!DIFF_ACTIONS.includes(action)) throw new LoopError(400, `action must be one of ${DIFF_ACTIONS.join(", ")}`);
    if (task.status !== "Done") throw new LoopError(409, `a ${action} needs a reviewed task (Done); this one is ${task.status}`);
    const diff = this.deps.git.diff(task.project, task.base_branch, task.branch);
    const stat = this.deps.git.diffStat(task.project, task.base_branch, task.branch);
    const approval: DiffApproval = {
      request_id: `diff-approval-${randomUUID()}`, action, diff_sha256: diffSha256(diff),
      diff_stat: { files: stat.files, lines: stat.lines }, requested_by: actor.id, requested_at: Date.now(), thread_id: null, decision: "pending",
    };
    approval.thread_id = this.deps.card?.(task, approval, diff) ?? null;
    const next = this.update(task, (t) => {
      for (const open of t.approvals) if (open.decision === "pending" && open.action === action) open.decision = "stale";
      t.approvals.push(approval);
    }, null);
    this.audit("task.diff-approval-requested", next, actor, { requestId: approval.request_id, action, diffSha256: approval.diff_sha256, files: stat.files, lines: stat.lines });
    this.post(next, `${action} of ${next.branch} waits for a person to approve the exact diff (${stat.files} files, ${stat.lines} lines, sha256 ${approval.diff_sha256.slice(0, 12)}).`);
    return next;
  }

  /** Records the person's answer. It never pushes, merges or deploys: the person does that. */
  decideDiffApproval(id: string, requestId: string, decision: "approved" | "denied", sha256: string | undefined, actor: LoopActor): WorkTask {
    if (actor.kind !== "person") throw new LoopError(403, "only a person approves a push, merge, PR or deploy");
    const task = this.get(id);
    const approval = task.approvals.find((one) => one.request_id === requestId);
    if (!approval) throw new LoopError(404, `no approval request ${requestId}`);
    if (approval.decision !== "pending") throw new LoopError(409, `that request is already ${approval.decision}`);
    if (sha256 !== undefined && sha256 !== approval.diff_sha256) throw new LoopError(409, "that is not the diff this request shows");
    const current = diffSha256(this.deps.git.diff(task.project, task.base_branch, task.branch));
    const stale = decision === "approved" && current !== approval.diff_sha256;
    const next = this.update(task, (t) => {
      const one = t.approvals.find((a) => a.request_id === requestId)!;
      one.decision = stale ? "stale" : decision;
      one.decided_by = actor.id;
      one.decided_at = Date.now();
    }, null);
    this.audit("task.diff-approval-decided", next, actor, { requestId, action: approval.action, decision: stale ? "stale" : decision, diffSha256: approval.diff_sha256 });
    if (stale) throw new LoopError(409, "the branch changed after this diff was shown; request approval again");
    this.post(next, decision === "approved"
      ? `Approved: a person may now ${approval.action} ${next.branch} at diff ${approval.diff_sha256.slice(0, 12)}. Agents never ${approval.action} on their own.`
      : `Denied: ${approval.action} of ${next.branch}.`);
    return next;
  }

  /** An answer to one of this loop's approval cards through the shared card route, or null for any other card. */
  resolveCard(threadId: string, requestId: string, behavior: string, person: string): { status: number; body: unknown } | null {
    const task = this.deps.store.list().find((one) => one.approvals.some((a) => a.request_id === requestId && a.thread_id === threadId));
    if (!task) return null;
    if (behavior !== "allow" && behavior !== "deny") return { status: 400, body: { error: "answer this card with allow or deny" } };
    try {
      const next = this.decideDiffApproval(task.id, requestId, behavior === "allow" ? "approved" : "denied", undefined, { kind: "person", id: person });
      return { status: 200, body: { ok: true, outcome: "answered", task: next } };
    } catch (error) {
      if (error instanceof LoopError) return { status: error.status, body: { error: error.message } };
      throw error;
    }
  }

  private submitResearch(task: WorkTask, path: string, actor: LoopActor): WorkTask {
    this.mustBe(task, "Working", "research");
    this.mustPlay(task, "researcher", actor);
    if (!path?.trim()) throw new LoopError(400, "research_path is required");
    const text = this.deps.git.readFile(task.project, task.branch, task.worktree_path, path) ?? this.readWorkspace(task, path);
    if (text === null) throw new LoopError(400, `research packet ${path} was not found`);
    const check = validateResearch(text);
    if (!check.ok) throw new LoopError(400, `research packet rejected: ${check.problems.join("; ")}`);
    this.refuseTeamMemory(task, actor);
    if (task.tags.includes(ROUTINE_TAG)) return this.finishRoutineResearch(task, path, actor);
    const next = this.update(task, (t) => {
      t.research_path = path;
      t.tags = withTag(t.tags, "dev", "research");
      t.status = "To Do";
      t.owner_bot_id = null;
    }, null);
    this.audit("task.research-written", next, actor, { researchPath: path });
    this.post(next, `Research packet ready: ${path}. Handing to Builder.`);
    return this.route(next);
  }

  private submitBuild(task: WorkTask, path: string | undefined, actor: LoopActor): WorkTask {
    if (!(task.tags.includes("dev") && task.status === "Working") && !(actor.kind === "person" && task.status === "Needs Review")) {
      throw new LoopError(409, `build.done needs a Working task tagged dev; this one is ${task.status} + ${task.tags.join(", ") || "no tags"}`);
    }
    this.mustPlay(task, "builder", actor);
    const handoff = path?.trim() || handoffPathFor(task.slug);
    const text = this.deps.git.readFile(task.project, task.branch, task.worktree_path, handoff);
    if (text === null) throw new LoopError(400, `handoff packet ${handoff} was not found on ${task.branch}`);
    const check = validateHandoff(text);
    if (!check.ok) throw new LoopError(400, `handoff packet rejected: ${check.problems.join("; ")}`);
    this.refuseTeamMemory(task, actor);
    const gate = diffGate(this.deps.git.diffStat(task.project, task.base_branch, task.branch));
    if (gate.stat.files === 0) throw new LoopError(409, `${task.branch} has no changes against ${task.base_branch}; commit on the branch first`);
    if (gate.over && !task.diff_override) return this.flagSplit(task, gate.reason!, gate.stat, actor);
    const next = this.update(task, (t) => {
      t.handoff_path = handoff;
      t.tags = withTag(t.tags, "review", "dev", "research");
      t.status = "Needs Review";
      t.owner_bot_id = null;
    }, null);
    this.audit("task.handoff-written", next, actor, { handoffPath: handoff, files: gate.stat.files, lines: gate.stat.lines });
    this.post(next, `Handoff packet ready: ${handoff} (${gate.stat.files} files, ${gate.stat.lines} lines). Handing to Reviewer.`);
    return this.route(next);
  }

  private finishRoutineResearch(task: WorkTask, path: string, actor: LoopActor): WorkTask {
    const next = this.update(task, (t) => {
      t.research_path = path;
      t.tags = withTag(t.tags, null, "research");
      t.status = "Done";
      t.owner_bot_id = null;
    }, null);
    this.audit("task.research-written", next, actor, { researchPath: path, routine: true });
    this.post(next, `Research packet ready: ${path}. Done; Keeper reports it.`);
    this.tellKeeper(next, `Routine research task "${next.title}" (${next.slug}) is Done. The Researcher wrote ${path} in ${next.worktree_path ?? next.project}. Report it to the person in two or three lines: what was found and where the packet is. Nothing was pushed or merged. ${memoryProposal(next.project, this.deps.roles().keeper)}`);
    return next;
  }

  /** Only Keeper proposes changes to the team memory, and only through an approval card: a bot's branch may not touch it. */
  private refuseTeamMemory(task: WorkTask, actor: LoopActor): void {
    if (actor.kind === "person") return;
    if (touchesTeamMemory(this.deps.git.diffStat(task.project, task.base_branch, task.branch).paths)) {
      throw new LoopError(403, `${task.branch} changes ${TEAM_MEMORY_FILE}; only Keeper proposes team memory changes, and a person approves them. Take ${TEAM_MEMORY_FILE} out of the branch.`);
    }
  }

  private approve(task: WorkTask, notes: string | undefined, actor: LoopActor): WorkTask {
    this.mustBe(task, "Needs Review", "review");
    this.mustPlay(task, "reviewer", actor);
    const next = this.update(task, (t) => {
      t.status = "Done";
      t.owner_bot_id = null;
      t.tags = withTag(t.tags, null, "review");
      t.review_notes = notes?.trim() || null;
    }, null);
    this.audit("task.review-approved", next, actor, { round: next.review_round });
    this.post(next, `Reviewer approved "${next.title}" in round ${next.review_round}. Done; nothing was pushed or merged.`);
    this.tellKeeper(next, `Task "${next.title}" (${next.slug}) is Done after ${next.review_round} review round(s) on ${next.branch}. Report it to the person; a push or merge still needs their approval of the exact diff. ${memoryProposal(next.project, this.deps.roles().keeper)}`);
    return next;
  }

  private requestChanges(task: WorkTask, notes: string, actor: LoopActor): WorkTask {
    this.mustBe(task, "Needs Review", "review");
    this.mustPlay(task, "reviewer", actor);
    if (!notes?.trim() || !FILE_LINE.test(notes)) throw new LoopError(400, "review notes must point at file:line");
    if (task.review_round >= MAX_REVIEW_ROUNDS) {
      const next = this.update(task, (t) => {
        t.status = "Blocked";
        t.owner_bot_id = null;
        t.review_notes = notes;
        t.blocked_reason = `review cap: ${MAX_REVIEW_ROUNDS} rounds asked for changes; a person decides what happens next`;
      }, null);
      this.audit("task.review-changes", next, actor, { round: next.review_round });
      this.audit("task.review-cap", next, SYSTEM, { rounds: MAX_REVIEW_ROUNDS });
      this.post(next, `Stopped "${next.title}" after ${MAX_REVIEW_ROUNDS} review rounds. Waiting for you.`);
      this.tellKeeper(next, `Task "${next.title}" (${next.slug}) hit the ${MAX_REVIEW_ROUNDS}-round review cap and is Blocked. Ask the person how to proceed. Latest notes:\n${notes}`);
      return next;
    }
    const next = this.update(task, (t) => {
      t.status = "To Do";
      t.owner_bot_id = null;
      t.review_notes = notes;
      t.tags = withTag(t.tags, "dev", "review");
    }, null);
    this.audit("task.review-changes", next, actor, { round: next.review_round });
    this.post(next, `Reviewer asked for changes in round ${next.review_round}. Back to Builder on ${next.branch}.`);
    return this.route(next);
  }

  private stop(task: WorkTask, reason: string | undefined, actor: LoopActor): WorkTask {
    this.mustSteer(actor);
    const next = this.update(task, (t) => {
      t.status = "Blocked";
      t.owner_bot_id = null;
      t.blocked_reason = reason?.trim() || `stopped by ${actor.id}`;
    }, null);
    this.audit("task.blocked", next, actor, { reason: next.blocked_reason });
    this.post(next, `Stopped "${next.title}": ${next.blocked_reason}`);
    return next;
  }

  private resume(task: WorkTask, resetRounds: boolean, actor: LoopActor): WorkTask {
    this.mustSteer(actor);
    if (task.status !== "Blocked") throw new LoopError(409, `only a Blocked task resumes; this one is ${task.status}`);
    if (resetRounds && actor.kind !== "person") throw new LoopError(403, "only a person resets the review rounds");
    const tag = routingTag(task) ?? "dev";
    const next = this.update(task, (t) => {
      t.status = tag === "review" ? "Needs Review" : "To Do";
      t.tags = withTag(t.tags, tag);
      t.blocked_reason = null;
      if (resetRounds) t.review_round = 0;
    }, null);
    this.audit("task.resumed", next, actor, { resetRounds });
    return this.route(next);
  }

  private reassign(task: WorkTask, botId: string, role: ReviewRole | undefined, actor: LoopActor): WorkTask {
    this.mustSteer(actor);
    if (!botId?.trim()) throw new LoopError(400, "bot_id is required");
    if (role !== undefined && !REVIEW_ROLES.includes(role)) throw new LoopError(400, `unknown role ${role}`);
    const next = this.update(task, (t) => {
      t.owner_bot_id = botId;
    }, null);
    this.audit("task.reassigned", next, actor, { from: task.owner_bot_id, to: botId, role: role ?? null });
    if (role) this.handOver(role, botId, next, this.promptFor(role, next));
    return next;
  }

  /** Books one turn from the usage ledger on the task its bot is working on, or returns null when the bot is on no
   * task or the engine reported no tokens. */
  noteTurnUsage(turn: TurnUsage): WorkTask | null {
    const owner = this.turnOwnerOf(turn.botId);
    if (!owner) return null;
    const task = this.deps.store.get(owner.taskId);
    if (!task) {
      this.turnOwners.delete(turn.botId);
      return null;
    }
    if (task.owner_bot_id !== turn.botId) this.turnOwners.delete(turn.botId);
    const usage: RoleUsage = {
      inputTokens: count(turn.input), outputTokens: count(turn.output),
      cachedInputTokens: count(turn.cachedInput), cacheWriteTokens: count(turn.cacheWrite), reasoningTokens: count(turn.reasoning),
    };
    if (usage.inputTokens + usage.outputTokens + usage.cachedInputTokens! + usage.cacheWriteTokens! === 0) return null;
    return this.addUsage(task, owner.role, usage, { kind: "bot", id: turn.botId }, {
      source: "ledger", ...(turn.model ? { model: turn.model } : {}), ...(turn.driverKind ? { engine: turn.driverKind } : {}),
      ...(turn.turnId ? { turnId: turn.turnId } : {}), ...(turn.threadId ? { threadId: turn.threadId } : {}),
    }, turn.model);
  }

  private turnOwnerOf(botId: string): { taskId: string; role: UsageRole } | null {
    const known = this.turnOwners.get(botId);
    if (known) return known;
    const roles = this.deps.roles();
    const role = USAGE_ROLES.find((one) => roles[one] === botId);
    const task = role ? this.deps.store.list().find((one) => one.owner_bot_id === botId) : undefined;
    return role && task ? { taskId: task.id, role } : null;
  }

  private recordUsage(task: WorkTask, role: UsageRole, input: number, output: number, actor: LoopActor): WorkTask {
    if (!USAGE_ROLES.includes(role)) throw new LoopError(400, "role must be researcher, builder or reviewer");
    if (![input, output].every((n) => Number.isInteger(n) && n >= 0)) throw new LoopError(400, "token counts must be whole numbers, 0 or more");
    return this.addUsage(task, role, { inputTokens: input, outputTokens: output }, actor, { source: "manual" });
  }

  private addUsage(task: WorkTask, role: UsageRole, usage: RoleUsage, actor: LoopActor, detail: Record<string, unknown>, model?: string): WorkTask {
    const next = this.update(task, (t) => {
      const prior = t.token_usage[role] ?? { inputTokens: 0, outputTokens: 0 };
      const sum: RoleUsage = { inputTokens: prior.inputTokens + usage.inputTokens, outputTokens: prior.outputTokens + usage.outputTokens };
      for (const key of ["cachedInputTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
        const total = (prior[key] ?? 0) + (usage[key] ?? 0);
        if (total > 0) sum[key] = total;
      }
      if (detail.source === "ledger" || prior.turns !== undefined) sum.turns = (prior.turns ?? 0) + (detail.source === "ledger" ? 1 : 0);
      const models = [...new Set([...(prior.models ?? []), ...(model ? [model] : [])])];
      if (models.length) sum.models = models;
      t.token_usage[role] = sum;
    }, null);
    const { cachedInputTokens, cacheWriteTokens, reasoningTokens } = usage;
    this.audit("task.usage", next, actor, {
      role, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      ...(cachedInputTokens ? { cachedInputTokens } : {}), ...(cacheWriteTokens ? { cacheWriteTokens } : {}), ...(reasoningTokens ? { reasoningTokens } : {}),
      ...detail, total: next.token_usage[role],
    });
    return next;
  }

  private route(task: WorkTask): WorkTask {
    const tag = routingTag(task);
    if (task.status === "To Do" && (tag === "research" || tag === "dev")) {
      const ready = this.ensureWorktree(task);
      return ready.status === "Blocked" ? ready : this.assign(ready, tag === "research" ? "researcher" : "builder");
    }
    if (task.status === "Needs Review" && tag === "review" && !task.owner_bot_id) return this.startReview(task);
    return task;
  }

  private ensureWorktree(task: WorkTask): WorkTask {
    const worktree = task.worktree_path ?? join(this.deps.worktreeRoot, task.slug);
    let path: string;
    try {
      path = this.deps.git.ensureBranch(task.project, task.branch, task.base_branch, worktree);
    } catch (error) {
      return this.block(task, `could not create ${task.branch}: ${(error as Error).message.split("\n")[0]}`);
    }
    if (task.worktree_path === path) return task;
    const next = this.update(task, (t) => { t.worktree_path = path; }, null);
    this.audit("task.branch-created", next, SYSTEM, { branch: next.branch, base: next.base_branch, worktree: path });
    return next;
  }

  private startReview(task: WorkTask): WorkTask {
    if (task.review_round >= MAX_REVIEW_ROUNDS) {
      const next = this.block(task, `review cap: ${MAX_REVIEW_ROUNDS} rounds already ran; a person decides what happens next`);
      this.audit("task.review-cap", next, SYSTEM, { rounds: MAX_REVIEW_ROUNDS });
      return next;
    }
    const gate = diffGate(this.deps.git.diffStat(task.project, task.base_branch, task.branch));
    if (gate.over && !task.diff_override) return this.flagSplit(task, gate.reason!, gate.stat, SYSTEM);
    const previous = task.reviewed_head;
    const head = this.deps.git.head(task.project, task.branch);
    const next = this.update(task, (t) => {
      t.review_round += 1;
      t.reviewed_head = head;
    }, null);
    this.audit("task.review-started", next, SYSTEM, { round: next.review_round, head, since: previous, files: gate.stat.files, lines: gate.stat.lines });
    return this.assign(next, "reviewer", previous);
  }

  private assign(task: WorkTask, role: ReviewRole, reviewedBefore?: string | null): WorkTask {
    const botId = this.deps.roles()[role];
    if (!botId) return this.block(task, `no ${role} bot is set up`);
    const next = this.update(task, (t) => {
      t.owner_bot_id = botId;
      if (t.status === "To Do") t.status = "Working";
    }, null);
    this.audit("task.assigned", next, SYSTEM, { role, botId });
    this.handOver(role, botId, next, this.promptFor(role, next, reviewedBefore));
    return next;
  }

  private handOver(role: ReviewRole, botId: string, task: WorkTask, prompt: string): void {
    if (isUsageRole(role)) this.turnOwners.set(botId, { taskId: task.id, role });
    this.deps.dispatch?.(role, botId, task, prompt);
  }

  private flagSplit(task: WorkTask, reason: string, stat: { files: number; lines: number }, actor: LoopActor): WorkTask {
    const next = this.block(task, reason);
    this.audit("task.split-flagged", next, actor, { files: stat.files, lines: stat.lines });
    this.tellKeeper(next, `Task "${next.title}" (${next.slug}) is Blocked: ${reason}. Ask the person to split it, or to allow the larger diff.`);
    return next;
  }

  private block(task: WorkTask, reason: string): WorkTask {
    const next = this.update(task, (t) => {
      t.status = "Blocked";
      t.owner_bot_id = null;
      t.blocked_reason = reason;
    }, null);
    this.audit("task.blocked", next, SYSTEM, { reason });
    this.post(next, `Blocked "${next.title}": ${reason}`);
    return next;
  }

  promptFor(role: ReviewRole, task: WorkTask, reviewedBefore?: string | null): string {
    const id = `task ${task.id} (${task.slug})`;
    const done = (event: string, extra = "") => `node --experimental-strip-types server/openmausbot.ts task transition ${task.id} ${event}${extra}`;
    const head = `NightShift ${id}: "${task.title}"\n${task.description ? `\n${task.description}\n` : ""}`;
    const today = new Date().toISOString().slice(0, 10);
    if (role === "researcher") {
      return `${head}\nYou are the Researcher. Search the live web first, open the official page, and write docs/research/${task.slug}-${today}.md in ${task.worktree_path} (the task's worktree, never the base checkout) with each source's URL and "accessed ${today}". Mark anything you could not verify UNVERIFIED. Do not edit code.\nWhen the packet is written, run: ${done("research.done", ` --research-path docs/research/${task.slug}-${today}.md`)}`;
    }
    if (role === "builder") {
      const notes = task.review_round > 0 && task.review_notes ? `\nReview round ${task.review_round} asked for these changes; fix only these:\n${task.review_notes}\n` : "";
      return `${head}\nYou are the Builder. Work only in ${task.worktree_path} on branch ${task.branch} (from ${task.base_branch}); commit only there. Never push, merge, open a PR or deploy.\n${task.research_path ? `Read the research packet: ${task.research_path}\n` : ""}${notes}Keep the diff under 400 lines and 10 files. Before finishing, commit docs/handoffs/${task.slug}.md with these sections: Files changed (path:line and why), Decisions, Tests (run, pass/fail, and Not run), Risky / unsure, Do not re-read. Never paste whole files.\nThen run: ${done("build.done")}`;
    }
    if (role === "reviewer") {
      const scope = reviewedBefore
        ? `Round ${task.review_round}: read only the hunks since your last review: git diff ${reviewedBefore}..${task.branch}`
        : `Read only: ${task.handoff_path}, git diff --stat ${task.base_branch}...${task.branch}, git diff ${task.base_branch}...${task.branch}, and the touched files with their direct imports and tests`;
      return `${head}\nYou are the Reviewer, round ${task.review_round} of at most ${MAX_REVIEW_ROUNDS}. Diff-only review, in ${task.project}. ${scope}. Re-run only the affected tests. Do not edit code; review notes only.\nApprove with: ${done("review.approve")}\nOr ask for changes with file:line notes: ${done("review.changes", ' --notes "path/to/file.ts:12 what to change"')}`;
    }
    return `${head}\nYou are the Keeper. ${task.status === "Done" ? "Report this finished task to the person." : `This task is ${task.status}${task.blocked_reason ? `: ${task.blocked_reason}` : ""}. Ask the person what to do.`}`;
  }

  private tellKeeper(task: WorkTask, text: string): void {
    const keeper = this.deps.roles().keeper;
    if (keeper) this.deps.dispatch?.("keeper", keeper, task, text);
  }

  private mustBe(task: WorkTask, status: WorkTask["status"], tag: string): void {
    if (task.status !== status || !task.tags.includes(tag)) {
      throw new LoopError(409, `this needs a ${status} task tagged ${tag}; this one is ${task.status} + ${task.tags.join(", ") || "no tags"}`);
    }
  }

  private mustPlay(task: WorkTask, role: ReviewRole, actor: LoopActor): void {
    if (actor.kind === "person") return;
    if (actor.kind !== "bot" || actor.id !== task.owner_bot_id || this.deps.roles()[role] !== actor.id) {
      throw new LoopError(403, `only the task's ${role} (or a person) can do that`);
    }
  }

  private mustSteer(actor: LoopActor): void {
    if (actor.kind === "person") return;
    if (actor.kind === "bot" && actor.id === this.deps.roles().keeper) return;
    throw new LoopError(403, "only a person or the Keeper stops, resumes or reassigns a task");
  }

  private readWorkspace(task: WorkTask, path: string): string | null {
    return this.deps.git.readFile(task.project, task.base_branch, task.project, path);
  }

  private update(task: WorkTask, change: (task: WorkTask) => void, actor: LoopActor | null, patch?: object): WorkTask {
    const next = this.deps.store.update(task.id, change);
    if (actor) this.audit("task.updated", next, actor, { fields: Object.keys(patch ?? {}) });
    return next;
  }

  private audit(action: TaskAuditAction, task: WorkTask, actor: LoopActor, detail?: Record<string, unknown>): void {
    this.deps.audit({ action, task: snapshot(task), actor, ...(detail ? { detail } : {}) });
  }

  private post(task: WorkTask, text: string): void {
    if (task.room_id) this.deps.post?.(task, text);
  }
}
