import { renameSync } from "node:fs";
import { join } from "node:path";

import type { AdminActionRow } from "../admin-activity.ts";
import type { DecisionRow } from "../decision-log.ts";
import type { MausColor, Message, OptionCardData } from "../store.ts";
import { taskAuditRow } from "./audit.ts";
import { localGit, type TaskGit } from "./git.ts";
import { ReviewLoop } from "./loop.ts";
import type { DiffApproval, ReviewRole, TurnUsage, WorkTask } from "./model.ts";
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
  bot(id: string): { id: string; name: string; threadId: string } | null | undefined;
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
    dispatch: (_role, botId, _task, prompt) => {
      const bot = bots.bot(botId);
      if (!bot?.threadId) return;
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
