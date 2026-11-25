import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { TEAM_MEMORY_FILE } from "./model.ts";

/** Keeper's whole proposed MEMORY.md, at the end of its reply, between these two tags. It writes nothing: NightShift
 * makes it a proposal, and only a person's approval of its diff saves it. */
const BLOCK = /<nightshift-memory(?:\s+summary="([^"\n]{0,300})")?\s*>\n([\s\S]*?)\n?<\/nightshift-memory>/;

/** At most this much of the current MEMORY.md goes into Keeper's prompt; the loader reads only the first 24 KB anyway. */
const PROMPT_MEMORY_CHARS = 24_000;

export const lf = (text: string) => text.replace(/\r\n?/g, "\n");

export function memoryPath(project: string): string {
  return join(resolve(project), TEAM_MEMORY_FILE);
}

export function readMemory(project: string): string {
  const path = memoryPath(project);
  return existsSync(path) ? lf(readFileSync(path, "utf8")) : "";
}

/** The proposal at the end of a Keeper reply, or null when it holds none. */
export function memoryBlockIn(reply: string): { text: string; summary?: string } | null {
  const found = BLOCK.exec(lf(reply));
  if (!found) return null;
  const text = found[2]!.endsWith("\n") ? found[2]! : `${found[2]!}\n`;
  return { text, ...(found[1]?.trim() ? { summary: found[1].trim() } : {}) };
}

/** What Keeper is told after a report: decide on a memory change, with the current file in hand, and say it in its reply. */
export function memoryProposalPrompt(project: string): string {
  const current = readMemory(project);
  const shown = current.length > PROMPT_MEMORY_CHARS ? `${current.slice(0, PROMPT_MEMORY_CHARS)}\n… (cut here)` : current;
  return `Then decide whether the team should keep anything from it beyond this week: a model id or tool the Builder must use or avoid, a breaking change, a retired tool, where the packets live. If it should, end your reply with the whole new ${TEAM_MEMORY_FILE} between <nightshift-memory summary="one line"> and </nightshift-memory>; NightShift shows the person the exact diff on an approval card and saves it only after they approve. If not, end with "No memory change." Use no tool for this, never write ${TEAM_MEMORY_FILE} yourself, and never put a key, token or password in it. The current ${TEAM_MEMORY_FILE} of ${project}:\n<current-memory>\n${shown || "(none yet)"}\n</current-memory>`;
}
