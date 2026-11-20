export const HANDOFF_SECTIONS = [
  { key: "files", label: "Files changed", heading: /^files?\s+changed\b/i },
  { key: "decisions", label: "Decisions", heading: /^decisions?\b/i },
  { key: "tests", label: "Tests", heading: /^tests?\b/i },
  { key: "risky", label: "Risky / unsure", heading: /^(risky|risks?|unsure)\b/i },
  { key: "doNotReRead", label: "Do not re-read", heading: /^do[\s-]+not[\s-]+re-?read\b/i },
] as const;

/** Longest fenced block a packet may carry: an excerpt, never a pasted file. */
export const MAX_FENCED_LINES = 30;
export const MAX_HANDOFF_LINES = 250;

const PATH_LINE = /[\w./\\-]+\.[\w]+:\d+/;

export interface HandoffCheck {
  ok: boolean;
  problems: string[];
}

export function handoffPathFor(slug: string): string {
  return `docs/handoffs/${slug}.md`;
}

function sections(text: string): Map<string, string> {
  const found = new Map<string, string>();
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      current = HANDOFF_SECTIONS.find((section) => section.heading.test(heading[1]!.trim()))?.key ?? null;
      if (current && !found.has(current)) found.set(current, "");
      continue;
    }
    if (current) found.set(current, `${found.get(current)}${line}\n`);
  }
  return found;
}

function longestFence(text: string): number {
  let longest = 0, inside = false, length = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (inside) longest = Math.max(longest, length);
      inside = !inside;
      length = 0;
    } else if (inside) length++;
  }
  return inside ? Math.max(longest, length) : longest;
}

export function validateHandoff(text: string): HandoffCheck {
  const problems: string[] = [];
  const found = sections(text);
  for (const section of HANDOFF_SECTIONS) {
    const body = found.get(section.key);
    if (body === undefined) problems.push(`missing section: ${section.label}`);
    else if (!body.trim()) problems.push(`empty section: ${section.label}`);
  }
  const files = found.get("files");
  if (files?.trim() && !PATH_LINE.test(files)) problems.push("Files changed must name each change as path:line");
  const tests = found.get("tests");
  if (tests?.trim() && !/not run/i.test(tests)) problems.push("Tests must say what was not run (write \"Not run: none\" if everything ran)");
  const fence = longestFence(text);
  if (fence > MAX_FENCED_LINES) problems.push(`a fenced block has ${fence} lines (at most ${MAX_FENCED_LINES}): link path:line instead of pasting files`);
  const lines = text.split(/\r?\n/).length;
  if (lines > MAX_HANDOFF_LINES) problems.push(`the packet has ${lines} lines (at most ${MAX_HANDOFF_LINES})`);
  return { ok: problems.length === 0, problems };
}

/** A research packet cites at least one URL and the date it was read. */
export function validateResearch(text: string): HandoffCheck {
  const problems: string[] = [];
  if (!/https?:\/\/\S+/.test(text)) problems.push("the research packet cites no URL");
  if (!/accessed[^\n]*\d{4}-\d{2}-\d{2}/i.test(text)) problems.push("the research packet gives no date accessed (accessed YYYY-MM-DD)");
  return { ok: problems.length === 0, problems };
}
