/** A routine of Keeper's whose prompt starts with this line asks the review loop for a research packet instead of a
 * plain bot turn: the title follows it, an optional `Base: BRANCH` line names the branch the worktree starts from, and
 * the rest is the task's description. */
export const ROUTINE_RESEARCH_MARK = "NightShift research:";
const BASE_LINE = /^Base:\s*(\S+)\s*$/;

export interface RoutineResearchSpec { title: string; description: string; base?: string }

export function routineResearchPrompt(spec: RoutineResearchSpec): string {
  return [`${ROUTINE_RESEARCH_MARK} ${spec.title.trim()}`, ...(spec.base ? [`Base: ${spec.base}`] : []), "", spec.description.trim()].join("\n").trimEnd();
}

export function parseRoutineResearch(prompt: string): RoutineResearchSpec | null {
  const lines = prompt.replace(/\r\n?/g, "\n").split("\n");
  const first = lines[0] ?? "";
  if (!first.startsWith(ROUTINE_RESEARCH_MARK)) return null;
  const title = first.slice(ROUTINE_RESEARCH_MARK.length).trim();
  if (!title) return null;
  let rest = lines.slice(1);
  const base = BASE_LINE.exec(rest[0] ?? "")?.[1];
  if (base) rest = rest.slice(1);
  return { title, description: rest.join("\n").trim(), ...(base ? { base } : {}) };
}
