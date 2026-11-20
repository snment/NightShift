import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { MAX_DIFF_FILES, MAX_DIFF_LINES } from "./model.ts";

export interface DiffStat {
  files: number;
  lines: number;
  paths: string[];
}

export interface DiffGate {
  over: boolean;
  stat: DiffStat;
  reason: string | null;
}

/** The git a task needs. Nothing here pushes, merges or checks out in the base checkout. */
export interface TaskGit {
  /** Creates `branch` from `base` when missing and a worktree bound to it; returns the worktree path. */
  ensureBranch(repo: string, branch: string, base: string, worktree: string): string;
  head(repo: string, ref: string): string | null;
  diffStat(repo: string, base: string, branch: string): DiffStat;
  /** `base...branch`: what the branch adds since it left base. */
  diff(repo: string, base: string, branch: string): string;
  /** Committed on the branch first, else the worktree's copy. */
  readFile(repo: string, branch: string, worktree: string | null, path: string): string | null;
}

/** NIGHTSHIFT_GIT: an absolute path to git, for a server whose PATH has none (the sealed verification fixture). */
export function gitBinary(env: NodeJS.ProcessEnv = process.env): string {
  const named = env.NIGHTSHIFT_GIT?.trim();
  return named && isAbsolute(named) ? named : "git";
}

function git(cwd: string, args: string[]): string {
  return execFileSync(gitBinary(), args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

export function parseNumstat(text: string): DiffStat {
  const paths: string[] = [];
  let lines = 0;
  for (const row of text.split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(row);
    if (!m) continue;
    lines += (m[1] === "-" ? 0 : Number(m[1])) + (m[2] === "-" ? 0 : Number(m[2]));
    paths.push(m[3]!);
  }
  return { files: paths.length, lines, paths };
}

export function diffGate(stat: DiffStat): DiffGate {
  const reasons: string[] = [];
  if (stat.lines > MAX_DIFF_LINES) reasons.push(`${stat.lines} changed lines (limit ${MAX_DIFF_LINES})`);
  if (stat.files > MAX_DIFF_FILES) reasons.push(`${stat.files} changed files (limit ${MAX_DIFF_FILES})`);
  return { over: reasons.length > 0, stat, reason: reasons.length ? `diff too large to review: ${reasons.join(", ")}; split the task` : null };
}

export function diffSha256(diff: string): string {
  return createHash("sha256").update(diff).digest("hex");
}

export const localGit: TaskGit = {
  ensureBranch(repo, branch, base, worktree) {
    if (tryGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) === null) git(repo, ["branch", branch, base]);
    const target = resolve(worktree);
    const listed = git(repo, ["worktree", "list", "--porcelain"]).split(/\r?\n/)
      .filter((line) => line.startsWith("worktree ")).map((line) => resolve(line.slice("worktree ".length)));
    if (!listed.includes(target)) {
      if (existsSync(target)) throw new Error(`${target} exists and is not a worktree of ${repo}`);
      mkdirSync(dirname(target), { recursive: true });
      git(repo, ["worktree", "add", target, branch]);
    }
    return target;
  },
  head(repo, ref) {
    return tryGit(repo, ["rev-parse", "--verify", "--quiet", ref])?.trim() || null;
  },
  diffStat(repo, base, branch) {
    return parseNumstat(git(repo, ["diff", "--numstat", `${base}...${branch}`]));
  },
  diff(repo, base, branch) {
    return git(repo, ["diff", `${base}...${branch}`]);
  },
  readFile(repo, branch, worktree, path) {
    const committed = tryGit(repo, ["show", `${branch}:${path.replace(/\\/g, "/")}`]);
    if (committed !== null) return committed;
    if (worktree) {
      const file = join(worktree, path);
      if (existsSync(file)) return readFileSync(file, "utf8");
    }
    return null;
  },
};
