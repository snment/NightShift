export const WORK_TASK_STATUSES = ["To Do", "Working", "Needs Review", "Done", "Blocked"] as const;
export type WorkTaskStatus = typeof WORK_TASK_STATUSES[number];

export const ROUTING_TAGS = ["research", "dev", "review"] as const;
export type RoutingTag = typeof ROUTING_TAGS[number];

/** A task a routine started: research only, so `research.done` ends it at Done and Keeper reports it. */
export const ROUTINE_TAG = "routine";

/** The team memory file at a repository's root. Only Keeper proposes changes to it, and only a person's approval writes it. */
export const TEAM_MEMORY_FILE = "MEMORY.md";

export const REVIEW_ROLES = ["researcher", "builder", "reviewer", "keeper"] as const;
export type ReviewRole = typeof REVIEW_ROLES[number];
export type UsageRole = Exclude<ReviewRole, "keeper">;

export const MAX_REVIEW_ROUNDS = 3;
export const MAX_DIFF_LINES = 400;
export const MAX_DIFF_FILES = 10;

/** Tokens a role spent on a task. The optional fields come from the usage ledger's booked turns; a manual `usage`
 * transition sets only input and output. */
export interface RoleUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  turns?: number;
  models?: string[];
}

/** One turn as the usage ledger booked it (a subset of `UsageRow`). */
export interface TurnUsage {
  botId: string;
  threadId?: string;
  model?: string;
  driverKind?: string;
  turnId?: string;
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite?: number;
  reasoning?: number;
}

export type DiffAction = "push" | "merge" | "pr" | "deploy";
export const DIFF_ACTIONS: readonly DiffAction[] = ["push", "merge", "pr", "deploy"];

/** A request to push, merge, open a PR or deploy a task branch. `diff_sha256` pins the exact diff the person approves. */
export interface DiffApproval {
  request_id: string;
  action: DiffAction;
  diff_sha256: string;
  diff_stat: { files: number; lines: number };
  requested_by: string;
  requested_at: number;
  thread_id: string | null;
  decision: "pending" | "approved" | "denied" | "stale";
  decided_by?: string;
  decided_at?: number;
}

/** The review loop's unit of work, kept in `<data>/work-tasks.json` beside bots.json and groups.json. */
export interface WorkTask {
  id: string;
  slug: string;
  title: string;
  description: string;
  /** Path of the git repository the task changes. */
  project: string;
  room_id: string | null;
  owner_bot_id: string | null;
  status: WorkTaskStatus;
  tags: string[];
  research_path: string | null;
  handoff_path: string | null;
  branch: string;
  base_branch: string;
  worktree_path: string | null;
  review_round: number;
  review_notes: string | null;
  /** Branch head the Reviewer last read, so a later round reviews only the hunks after it. */
  reviewed_head: string | null;
  /** Set by a person only: lets a diff over the size gate go to review. */
  diff_override: boolean;
  blocked_reason: string | null;
  token_usage: Partial<Record<UsageRole, RoleUsage>>;
  approvals: DiffApproval[];
  /** The routine run that started this task; absent on tasks a person or bot made. */
  routine_run_id?: string | null;
  /** The hand-over a restart already gave back once (`role:bot:status:round`); a second restart on it blocks the task. */
  restart_handover?: string | null;
  /** Each bot last handed a turn on this task, by id, with the role it played; kept on disk, so the turn that ends with
   * the bot's own transition, or one a restart cut across, is still booked here once after the task has moved on. */
  turn_owners?: Record<string, UsageRole>;
  /** A routine task's own Researcher conversation, opened when the task is first handed out; kept on disk, so a
   * restart hands the task back to the same conversation. Absent: the Researcher's own chat. */
  research_thread_id?: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

const SLUG_MAX = 48;

export function slugify(text: string): string {
  const slug = text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, SLUG_MAX).replace(/-+$/g, "");
  return slug || "task";
}

export function isSlug(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(value) && !value.includes("--");
}

export function branchFor(slug: string): string {
  return `feat/${slug}`;
}

export function isWorkTaskStatus(value: unknown): value is WorkTaskStatus {
  return typeof value === "string" && (WORK_TASK_STATUSES as readonly string[]).includes(value);
}

export function withTag(tags: readonly string[], add: RoutingTag | null, ...remove: RoutingTag[]): string[] {
  const kept = tags.filter((tag) => !remove.includes(tag as RoutingTag) && tag !== add);
  return add ? [...kept, add] : kept;
}

const DATED = /\d{4}-\d{2}-\d{2}/;

/** Where the Researcher writes a task's packet: the slug once, with today's date only when the slug has none (a
 * routine's title already carries its date). */
export function researchPacketPath(slug: string, today: string): string {
  return `docs/research/${DATED.test(slug) ? slug : `${slug}-${today}`}.md`;
}

export function routingTag(task: Pick<WorkTask, "tags">): RoutingTag | null {
  for (const tag of ["review", "dev", "research"] as const) if (task.tags.includes(tag)) return tag;
  return null;
}
