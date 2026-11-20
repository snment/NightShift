export const WORK_TASK_STATUSES = ["To Do", "Working", "Needs Review", "Done", "Blocked"] as const;
export type WorkTaskStatus = typeof WORK_TASK_STATUSES[number];

export const ROUTING_TAGS = ["research", "dev", "review"] as const;
export type RoutingTag = typeof ROUTING_TAGS[number];

export const REVIEW_ROLES = ["researcher", "builder", "reviewer", "keeper"] as const;
export type ReviewRole = typeof REVIEW_ROLES[number];
export type UsageRole = Exclude<ReviewRole, "keeper">;

export const MAX_REVIEW_ROUNDS = 3;
export const MAX_DIFF_LINES = 400;
export const MAX_DIFF_FILES = 10;

export interface RoleUsage { inputTokens: number; outputTokens: number }

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

export function routingTag(task: Pick<WorkTask, "tags">): RoutingTag | null {
  for (const tag of ["review", "dev", "research"] as const) if (task.tags.includes(tag)) return tag;
  return null;
}
