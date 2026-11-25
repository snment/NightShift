// Security invariant: the Researcher's one allow-list. Its web search, its page fetches and its writes of files under
// docs/research/ in the worktree of the research task it is working on are answered without a card; every other call,
// and every call of every other bot, still asks the person. A write passes only when each path, with every link
// followed, stays inside that folder and names a plain file there.
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { WRITE_TOOL_NAMES } from "../own-file-reads.ts";

/** What the team file may list under `allowWithoutCard`, and only for the Researcher. */
export const RESEARCH_ALLOWANCES = ["WebSearch", "WebFetch", "docs/research/"] as const;
export type ResearchAllowance = typeof RESEARCH_ALLOWANCES[number];

/** The bot's "Always allow" entry for each allowance. No other code reads these keys, so on any other bot they allow
 * nothing. */
export const RESEARCH_ALLOW_KEYS: Record<ResearchAllowance, string> = {
  WebSearch: "nightshift-research:WebSearch",
  WebFetch: "nightshift-research:WebFetch",
  "docs/research/": "nightshift-research:write:docs/research/",
};

export const RESEARCH_DIR = ["docs", "research"] as const;

const WRITE_TOOLS: ReadonlySet<string> = new Set(WRITE_TOOL_NAMES);

/** One plain name: no `..`, no Windows stream (`file.md:x`), no device or hidden trick. */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isResearchAllowKey(key: string): boolean {
  return Object.values(RESEARCH_ALLOW_KEYS).includes(key);
}

export function allowancesIn(keys: readonly string[] | undefined): ResearchAllowance[] {
  return RESEARCH_ALLOWANCES.filter((allowance) => keys?.includes(RESEARCH_ALLOW_KEYS[allowance]));
}

const inside = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

function real(path: string): string | null {
  try { return realpathSync.native(path); } catch { return null; }
}

/** Whether a write to `path` lands on a plain file under `<worktree>/docs/research/`, links followed. */
export function writesUnderResearch(path: string, worktree: string): boolean {
  if (!isAbsolute(path) || !isAbsolute(worktree)) return false;
  const tree = real(worktree);
  const dir = tree ? real(join(tree, ...RESEARCH_DIR)) : null;
  if (!tree || !dir || !inside(dir, tree) || relative(join(tree, ...RESEARCH_DIR), dir) !== "") return false;
  const target = resolve(path);
  const lexicalRoot = [resolve(worktree, ...RESEARCH_DIR), dir].find((root) => inside(target, root));
  if (!lexicalRoot) return false;
  const names = relative(lexicalRoot, target).split(sep);
  if (!names.every((name) => PLAIN_NAME.test(name))) return false;
  let existing = lexicalRoot;
  for (const name of names) {
    const next = join(existing, name);
    let stat;
    try { stat = lstatSync(next); } catch { break; }
    if (stat.isSymbolicLink()) return false;
    existing = next;
  }
  const settled = real(existing);
  if (!settled || (settled !== dir && !inside(settled, dir))) return false;
  if (existing === join(lexicalRoot, ...names)) {
    const stat = lstatSync(existing);
    if (!stat.isFile() || stat.nlink > 1) return false;
  }
  return true;
}

export type ResearchGrant = "web-search" | "web-fetch" | "research-write";

/** The allowance that answers this ask, or null when a person must. `granted` is the bot's own "Always allow" list;
 * `worktree` the worktree of the research task the bot is working on now, or null when it is on none. */
export function researchGrant(ask: { tool: string; writes?: readonly string[] }, granted: readonly string[], worktree: string | null): ResearchGrant | null {
  const allowed = allowancesIn(granted);
  if (ask.tool === "WebSearch") return allowed.includes("WebSearch") ? "web-search" : null;
  if (ask.tool === "WebFetch") return allowed.includes("WebFetch") ? "web-fetch" : null;
  if (!WRITE_TOOLS.has(ask.tool) || !allowed.includes("docs/research/") || !worktree || !ask.writes?.length) return null;
  return ask.writes.every((path) => writesUnderResearch(path, worktree)) ? "research-write" : null;
}
