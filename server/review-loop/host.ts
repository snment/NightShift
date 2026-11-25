import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

import type { AdminActionRow } from "../admin-activity.ts";
import type { DecisionRow } from "../decision-log.ts";
import type { MausColor, Message, OptionCardData } from "../store.ts";
import { memoryAuditRow, taskAuditRow } from "./audit.ts";
import { localGit, type TaskGit } from "./git.ts";
import { LoopError, ReviewLoop, type RoutineResearch } from "./loop.ts";
import { RESEARCH_DIR, researchGrant, type ResearchGrant } from "./research-allow.ts";
import { parseRoutineResearch } from "./routine-research.ts";
import { MEMORY_APPROVAL_TOOL, MEMORY_PROPOSALS_FILE, TeamMemory, type MemoryProposal } from "./memory.ts";
import { memoryBlockIn } from "./memory-file.ts";
import { routingTag, TEAM_MEMORY_FILE, type DiffApproval, type ReviewRole, type TurnUsage, type WorkTask } from "./model.ts";
import { WorkTaskStore } from "./store.ts";

export const WORK_TASKS_FILE = "work-tasks.json";
export const DIFF_APPROVAL_TOOL = "nightshift_diff_approval";

/** The starter team's bot names (nightshift/team.yaml), by role. */
export const ROLE_BOT_NAMES: Record<ReviewRole, string> = { researcher: "Researcher", builder: "Builder", reviewer: "Reviewer", keeper: "Keeper" };

/** A card shows at most this much of the diff; its sha256 always covers the whole diff. */
const CARD_DIFF_CHARS = 12_000;

/** What the loop needs of the bot and room store. */
export interface LoopStore {
  bots: ReadonlyArray<{ id: string; name: string; color: MausColor; threadId: string }>;
  bot(id: string): { id: string; name: string; threadId: string; alwaysAllow?: string[] } | null | undefined;
  group(id: string): { threadId: string } | null | undefined;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
}

export interface NightShiftLoopDeps {
  dataDir: string;
  store: LoopStore;
  audit(row: Omit<AdminActionRow, "at">): void;
  decide(row: Omit<DecisionRow, "at">): void;
  /** Gives the bot a turn in its own chat. */
  send(botId: string, threadId: string, text: string): Promise<unknown>;
  git?: TaskGit;
}

export function diffApprovalCard(task: WorkTask, approval: DiffApproval, diff: string): { text: string; card: OptionCardData } {
  const shown = diff.length > CARD_DIFF_CHARS ? `${diff.slice(0, CARD_DIFF_CHARS)}\n… (${diff.length - CARD_DIFF_CHARS} more characters; git diff ${task.base_branch}...${task.branch})` : diff;
  return {
    text: `Exact diff for ${approval.action} of ${task.branch} (sha256 ${approval.diff_sha256}):\n\n\`\`\`diff\n${shown}\n\`\`\``,
    card: {
      title: `Approve ${approval.action} of ${task.branch}?`,
      subtitle: `${task.title}: ${approval.diff_stat.files} files, ${approval.diff_stat.lines} lines against ${task.base_branch}. sha256 ${approval.diff_sha256.slice(0, 16)}. Approving lets you ${approval.action} it; no bot does.`,
      options: ["Approve", "Deny"],
      requestId: approval.request_id,
      requestType: "permission",
      tool: DIFF_APPROVAL_TOOL,
      fixedOptions: true,
    },
  };
}

export function memoryApprovalCard(proposal: MemoryProposal): { text: string; card: OptionCardData } {
  const shown = proposal.diff.length > CARD_DIFF_CHARS ? `${proposal.diff.slice(0, CARD_DIFF_CHARS)}\n… (${proposal.diff.length - CARD_DIFF_CHARS} more characters; openmausbot team-memory show ${proposal.id})` : proposal.diff;
  return {
    text: `Keeper proposes this change to MEMORY.md in ${proposal.project} (sha256 ${proposal.proposed_sha256}):${proposal.summary ? `\n${proposal.summary}` : ""}\n\n\`\`\`diff\n${shown}\n\`\`\``,
    card: {
      title: "Save this change to MEMORY.md?",
      subtitle: `Nothing is written until you approve. sha256 ${proposal.proposed_sha256.slice(0, 16)}.`,
      options: ["Approve", "Deny"],
      requestId: proposal.id,
      requestType: "permission",
      tool: MEMORY_APPROVAL_TOOL,
      fixedOptions: true,
    },
  };
}

export interface NightShift {
  loop: ReviewLoop;
  memory: TeamMemory;
  /** An answer to one of the loop's or memory's cards, or null for any other card. */
  resolveCard(threadId: string, requestId: string, behavior: string, person: string, refusal?: string | null): { status: number; body: unknown } | null;
  /** A routine run's turn: a research routine of Keeper's starts a review-loop task and gets a one-line prompt back;
   * any other routine gets null and runs as it is. */
  routineTurn(run: { id: string; routineId: string; routineName: string; botId: string }, prompt: string): string | null;
  /** The Researcher's allow-list answer to one permission ask in its own chat, or null when a person must answer. */
  researchGrant(botId: string, threadId: string, ask: { tool: string; writes?: readonly string[] }): ResearchGrant | null;
  /** A turn in a bot's own chat ended well: the Researcher's packet, if it wrote one, finishes its task, and a
   * MEMORY.md block at the end of Keeper's reply becomes a proposal on an approval card. */
  turnEnded(botId: string, threadId: string, reply: string): void;
  /** A turn in a bot's own chat failed or could not start: the task it worked on is Blocked and Keeper is told. */
  turnFailed(botId: string, threadId: string, cause: string): void;
}

export function createNightShift(deps: NightShiftLoopDeps & { cwdOf(botId: string): string | undefined }): NightShift {
  const loop = createNightShiftLoop(deps);
  const keeper = () => deps.store.bots.find((bot) => bot.name === ROLE_BOT_NAMES.keeper);
  const from = () => { const k = keeper(); return k ? { from: { botId: k.id, name: k.name, color: k.color } } : {}; };
  const memory = new TeamMemory({
    file: join(deps.dataDir, MEMORY_PROPOSALS_FILE),
    keeper: () => keeper()?.id,
    audit: (event) => deps.audit(memoryAuditRow(event)),
    card: (proposal) => {
      const threadId = keeper()?.threadId;
      if (!threadId) return null;
      const shown = memoryApprovalCard(proposal);
      deps.store.appendMessage(threadId, { role: "bot", kind: "options", text: shown.text, card: shown.card, ...from() });
      const k = keeper();
      deps.decide({ threadId, requestId: proposal.id, ...(k ? { botId: k.id, botName: k.name } : {}), tool: MEMORY_APPROVAL_TOOL,
        summary: shown.card.title, decision: "card-shown", source: "question" });
      return threadId;
    },
    post: (proposal, text) => { if (proposal.thread_id) deps.store.appendMessage(proposal.thread_id, { role: "bot", kind: "text", text, ...from() }); },
  });
  return {
    loop,
    memory,
    resolveCard: (threadId, requestId, behavior, person, refusal = null) =>
      memory.resolveCard(threadId, requestId, behavior, person, refusal) ?? loop.resolveCard(threadId, requestId, behavior, person, refusal),
    turnEnded: (botId, threadId, reply) => {
      if (deps.store.bot(botId)?.threadId !== threadId) return;
      guarded("finish the Researcher's task", () => loop.researchTurnEnded(botId));
      const block = botId === keeper()?.id ? memoryBlockIn(reply) : null;
      const project = block ? deps.cwdOf(botId) : undefined;
      if (!block || !project) return;
      try {
        memory.propose({ project, text: block.text, ...(block.summary ? { summary: block.summary } : {}) }, { kind: "bot", id: botId });
      } catch (error) {
        const reason = error instanceof LoopError ? error.message : String(error);
        deps.store.appendMessage(threadId, { role: "bot", kind: "text", text: `NightShift did not propose that ${TEAM_MEMORY_FILE} change: ${reason}`, ...from() });
      }
    },
    turnFailed: (botId, threadId, cause) => {
      if (deps.store.bot(botId)?.threadId === threadId) guarded("block the task of a failed turn", () => loop.turnFailed(botId, cause));
    },
    researchGrant: (botId, threadId, ask) => {
      const researcher = deps.store.bots.find((bot) => bot.name === ROLE_BOT_NAMES.researcher);
      if (!researcher || researcher.id !== botId || researcher.threadId !== threadId) return null;
      const task = loop.list().find((one) => one.owner_bot_id === botId && one.status === "Working" && routingTag(one) === "research");
      return researchGrant(ask, deps.store.bot(botId)?.alwaysAllow ?? [], task?.worktree_path ?? null);
    },
    routineTurn: (run, prompt) => {
      const spec = parseRoutineResearch(prompt);
      if (!spec || run.botId !== keeper()?.id) return null;
      const input: RoutineResearch = {
        routineId: run.routineId, routineName: run.routineName, runId: run.id, title: `${spec.title} ${new Date().toISOString().slice(0, 10)}`,
        description: spec.description, project: deps.cwdOf(run.botId) ?? "", ...(spec.base ? { base_branch: spec.base } : {}),
      };
      try {
        const task = loop.createForRoutine(input);
        if (task.routine_run_id !== run.id) {
          return `The routine "${run.routineName}" ran, but its earlier research task "${task.title}" (${task.slug}) is still ${task.status}${task.blocked_reason ? `: ${task.blocked_reason}` : ""}, so no new task was started. Say so in one line in this chat and do nothing else.`;
        }
        return `The routine "${run.routineName}" started research task "${task.title}" (${task.slug}) for the Researcher; it is ${task.status}${task.blocked_reason ? `: ${task.blocked_reason}` : ""}. Say so in one line in this chat and do nothing else. You will be handed the packet when it is done.`;
      } catch (error) {
        const reason = error instanceof LoopError ? error.message : String(error);
        console.warn(`[review-loop] routine ${run.routineId} could not start its research task: ${reason}`);
        return `The routine "${run.routineName}" could not start its research task: ${reason}. Tell the person in one line and do nothing else.`;
      }
    },
  };
}

/** The loop's bookkeeping never fails a turn. */
function guarded(what: string, run: () => unknown): void {
  try {
    run();
  } catch (error) {
    console.warn(`[review-loop] could not ${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function createNightShiftLoop(deps: NightShiftLoopDeps): ReviewLoop {
  const file = join(deps.dataDir, WORK_TASKS_FILE);
  let store: WorkTaskStore;
  try {
    store = new WorkTaskStore(file);
  } catch (error) {
    const aside = `${file}.unreadable-${Date.now()}`;
    renameSync(file, aside);
    console.warn(`[review-loop] ${file} could not be read (${(error as Error).message}); kept it as ${aside} and started an empty list`);
    store = new WorkTaskStore(file);
  }
  const { store: bots } = deps;
  const keeper = () => bots.bots.find((bot) => bot.name === ROLE_BOT_NAMES.keeper);
  const as = () => {
    const k = keeper();
    return k ? { from: { botId: k.id, name: k.name, color: k.color } } : {};
  };
  return new ReviewLoop({
    store,
    git: deps.git ?? localGit,
    worktreeRoot: join(deps.dataDir, "worktrees"),
    roles: () => {
      const roles: Partial<Record<ReviewRole, string>> = {};
      for (const [role, name] of Object.entries(ROLE_BOT_NAMES) as Array<[ReviewRole, string]>) {
        const bot = bots.bots.find((one) => one.name === name);
        if (bot) roles[role] = bot.id;
      }
      return roles;
    },
    audit: (event) => deps.audit(taskAuditRow(event)),
    post: (task, text) => {
      const room = task.room_id ? bots.group(task.room_id) : undefined;
      if (room) bots.appendMessage(room.threadId, { role: "bot", kind: "text", text, ...as() });
    },
    dispatch: (role, botId, task, prompt) => {
      const bot = bots.bot(botId);
      if (!bot?.threadId) return;
      if (role === "researcher" && task.worktree_path) {
        try { mkdirSync(join(task.worktree_path, ...RESEARCH_DIR), { recursive: true }); } catch { /* the write then asks the person */ }
      }
      deps.send(botId, bot.threadId, prompt).catch((error: unknown) => {
        console.warn(`[review-loop] could not give ${bot.name} its turn: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
    card: (task, approval, diff) => {
      const threadId = (task.room_id ? bots.group(task.room_id)?.threadId : undefined) ?? keeper()?.threadId;
      if (!threadId) return null;
      const shown = diffApprovalCard(task, approval, diff);
      bots.appendMessage(threadId, { role: "bot", kind: "options", text: shown.text, card: shown.card, ...as() });
      const k = keeper();
      deps.decide({ threadId, requestId: approval.request_id, ...(k ? { botId: k.id, botName: k.name } : {}), tool: DIFF_APPROVAL_TOOL,
        summary: shown.card.title, decision: "card-shown", source: "question" });
      return threadId;
    },
  });
}

/** Books a turn from the usage ledger on the task its bot works on. Only turns in the bot's own chat count: that is
 * where the loop hands it its turns. Never throws, so the ledger's bookkeeping never fails a turn. */
export function bookTaskTurnUsage(loop: ReviewLoop, store: Pick<LoopStore, "bot">, turn: TurnUsage): WorkTask | null {
  try {
    const bot = store.bot(turn.botId);
    if (!bot || (turn.threadId !== undefined && turn.threadId !== bot.threadId)) return null;
    return loop.noteTurnUsage(turn);
  } catch (error) {
    console.warn(`[review-loop] could not book a turn's tokens on its task: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
