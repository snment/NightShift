import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { OwnedFile } from "../atomic.ts";
import { branchFor, isSlug, slugify, type WorkTask } from "./model.ts";

export interface NewWorkTask {
  title: string;
  description?: string;
  project: string;
  slug?: string;
  room_id?: string | null;
  tags?: string[];
  base_branch?: string;
  routine_run_id?: string;
  created_by: string;
}

/** Saved like bots.json and groups.json: the whole list, temp file, fsync, rename, owner-only, on every change. */
export class WorkTaskStore {
  private readonly file: OwnedFile;
  private tasks: WorkTask[] = [];
  private readonly now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.now = now;
    this.file = new OwnedFile(path, { mode: 0o600 });
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) return;
    const text = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error(`${path} is not a task list`);
    this.tasks = parsed as WorkTask[];
    this.file.loaded(text);
  }

  list(): WorkTask[] {
    return this.tasks.map((task) => structuredClone(task));
  }

  get(idOrSlug: string): WorkTask | undefined {
    const task = this.tasks.find((one) => one.id === idOrSlug) ?? this.tasks.find((one) => one.slug === idOrSlug);
    return task ? structuredClone(task) : undefined;
  }

  create(input: NewWorkTask): WorkTask {
    const slug = input.slug ?? this.freeSlug(slugify(input.title));
    if (!isSlug(slug)) throw new Error(`slug must be lower-case letters, digits and single dashes: ${slug}`);
    if (this.tasks.some((task) => task.slug === slug)) throw new Error(`a task already uses the slug ${slug}`);
    const at = this.now();
    const task: WorkTask = {
      id: `wt-${randomUUID()}`,
      slug,
      title: input.title.trim(),
      description: input.description?.trim() ?? "",
      project: input.project,
      room_id: input.room_id ?? null,
      owner_bot_id: null,
      status: "To Do",
      tags: [...new Set(input.tags ?? [])],
      research_path: null,
      handoff_path: null,
      branch: branchFor(slug),
      base_branch: input.base_branch ?? "main",
      worktree_path: null,
      review_round: 0,
      review_notes: null,
      reviewed_head: null,
      diff_override: false,
      blocked_reason: null,
      token_usage: {},
      approvals: [],
      ...(input.routine_run_id ? { routine_run_id: input.routine_run_id } : {}),
      created_by: input.created_by,
      created_at: at,
      updated_at: at,
    };
    this.save([...this.tasks, task]);
    return structuredClone(task);
  }

  update(id: string, change: (task: WorkTask) => void): WorkTask {
    const index = this.tasks.findIndex((task) => task.id === id);
    if (index < 0) throw new Error(`no task ${id}`);
    const next = structuredClone(this.tasks[index]!);
    change(next);
    next.updated_at = this.now();
    const tasks = [...this.tasks];
    tasks[index] = next;
    this.save(tasks);
    return structuredClone(next);
  }

  delete(id: string): boolean {
    const tasks = this.tasks.filter((task) => task.id !== id);
    if (tasks.length === this.tasks.length) return false;
    this.save(tasks);
    return true;
  }

  private freeSlug(base: string): string {
    let slug = base;
    for (let n = 2; this.tasks.some((task) => task.slug === slug); n++) slug = `${base.slice(0, 44)}-${n}`;
    return slug;
  }

  /** Written before memory changes, so a failed write leaves the list as it was on disk. */
  private save(tasks: WorkTask[]): void {
    this.file.write(JSON.stringify(tasks, null, 2));
    this.tasks = tasks;
  }
}
