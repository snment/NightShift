import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { lineDiff } from "../../shared/line-diff.ts";
import { holdsCredential, redactSecretsInText } from "../../shared/redact.ts";
import { OwnedFile, writeFileAtomic } from "../atomic.ts";
import { LoopError, type LoopActor } from "./loop.ts";
import { TEAM_MEMORY_FILE } from "./model.ts";

export const MEMORY_PROPOSALS_FILE = "memory-proposals.json";
export const MEMORY_APPROVAL_TOOL = "nightshift_memory_approval";

/** A proposed MEMORY.md is at most this big; the loader reads only the first 24 KB anyway. */
const MAX_MEMORY_BYTES = 64_000;

export type MemoryDecision = "pending" | "approved" | "denied" | "stale";

/** One proposed change to a repository's MEMORY.md, kept until a person answers it. */
export interface MemoryProposal {
  id: string;
  project: string;
  /** sha256 of MEMORY.md when the change was proposed ("" when there was none); a different file at approval is stale. */
  base_sha256: string;
  /** sha256 of the proposed text: the exact content an approval writes. */
  proposed_sha256: string;
  proposed: string;
  diff: string;
  summary: string;
  proposed_by: string;
  proposed_at: number;
  thread_id: string | null;
  decision: MemoryDecision;
  decided_by?: string;
  decided_at?: number;
}

export type MemoryAuditAction = "memory.proposed" | "memory.refused" | "memory.approved" | "memory.denied" | "memory.stale";

export interface MemoryAuditEvent {
  action: MemoryAuditAction;
  proposal: Pick<MemoryProposal, "id" | "project" | "base_sha256" | "proposed_sha256" | "decision"> | null;
  actor: LoopActor;
  detail?: Record<string, unknown>;
}

export interface TeamMemoryDeps {
  file: string;
  /** The Keeper's bot id now, or undefined when there is none. */
  keeper(): string | undefined;
  audit(event: MemoryAuditEvent): void;
  /** Shows the diff as an approval card; returns the thread it is in. */
  card?(proposal: MemoryProposal): string | null;
  /** One line after a decision, in the thread the card is in. */
  post?(proposal: MemoryProposal, text: string): void;
  /** Writes the approved text in place of MEMORY.md, atomically. */
  write?(path: string, text: string): void;
  now?(): number;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const lf = (text: string) => text.replace(/\r\n?/g, "\n");

export function memoryPath(project: string): string {
  return join(resolve(project), TEAM_MEMORY_FILE);
}

function readMemory(project: string): string {
  const path = memoryPath(project);
  return existsSync(path) ? lf(readFileSync(path, "utf8")) : "";
}

/** The lines a proposal adds that look like a credential (a provider key, a token, a password assignment). */
export function secretLines(before: string, after: string): number[] {
  const added = new Set(lineDiff(before, after).filter((line) => line.startsWith("+")).map((line) => line.slice(1)));
  return after.split("\n").flatMap((line, index) => added.has(line) && (holdsCredential(line) || redactSecretsInText(line) !== line) ? [index + 1] : []);
}

export function unifiedMemoryDiff(before: string, after: string): string {
  return [`--- a/${TEAM_MEMORY_FILE}`, `+++ b/${TEAM_MEMORY_FILE}`, ...lineDiff(before, after)].join("\n");
}

const writeOwned = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, text, { mode: 0o644 });
};

/** Keeper's proposed changes to MEMORY.md. Nothing is written until a person approves the exact diff; a denied,
 * pending or stale proposal leaves the file as it is. Proposals are saved on every change, so a restart keeps them. */
export class TeamMemory {
  private readonly deps: TeamMemoryDeps;
  private readonly store: OwnedFile;
  private proposals: MemoryProposal[] = [];

  constructor(deps: TeamMemoryDeps) {
    this.deps = deps;
    this.store = new OwnedFile(deps.file, { mode: 0o600 });
    mkdirSync(dirname(deps.file), { recursive: true });
    if (!existsSync(deps.file)) return;
    const text = readFileSync(deps.file, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error(`${deps.file} is not a proposal list`);
    this.proposals = parsed as MemoryProposal[];
    this.store.loaded(text);
  }

  list(): MemoryProposal[] {
    return this.proposals.map((one) => structuredClone(one));
  }

  get(id: string): MemoryProposal {
    const found = this.proposals.find((one) => one.id === id);
    if (!found) throw new LoopError(404, `no memory proposal ${id}`);
    return structuredClone(found);
  }

  propose(input: { project: string; text: string; summary?: string }, actor: LoopActor): MemoryProposal {
    if (actor.kind === "bot" && actor.id !== this.deps.keeper()) {
      this.audit("memory.refused", null, actor, { reason: "not-keeper", project: input.project });
      throw new LoopError(403, `only Keeper proposes changes to ${TEAM_MEMORY_FILE}`);
    }
    if (actor.kind === "system") throw new LoopError(403, `only Keeper or a person proposes changes to ${TEAM_MEMORY_FILE}`);
    if (!input.project?.trim()) throw new LoopError(400, "project (the repository path) is required");
    const project = resolve(input.project);
    if (!existsSync(project)) throw new LoopError(400, `${project} does not exist`);
    const proposed = lf(input.text ?? "");
    if (!proposed.trim()) throw new LoopError(400, `the proposed ${TEAM_MEMORY_FILE} is empty`);
    if (Buffer.byteLength(proposed, "utf8") > MAX_MEMORY_BYTES) throw new LoopError(400, `the proposed ${TEAM_MEMORY_FILE} is over ${MAX_MEMORY_BYTES} bytes`);
    const current = readMemory(project);
    if (current === proposed) throw new LoopError(409, `the proposal is the same as the current ${TEAM_MEMORY_FILE}`);
    const secrets = secretLines(current, proposed);
    if (secrets.length) {
      this.audit("memory.refused", null, actor, { reason: "secret", project, lines: secrets });
      throw new LoopError(400, `refused: line${secrets.length === 1 ? "" : "s"} ${secrets.join(", ")} of the proposal look like a key, token or password. ${TEAM_MEMORY_FILE} never holds secrets.`);
    }
    const proposal: MemoryProposal = {
      id: `memory-approval-${randomUUID()}`, project, base_sha256: current ? sha256(current) : "", proposed_sha256: sha256(proposed), proposed,
      diff: unifiedMemoryDiff(current, proposed), summary: input.summary?.trim().slice(0, 300) ?? "",
      proposed_by: actor.kind === "bot" ? `bot:${actor.id}` : actor.id, proposed_at: this.now(), thread_id: null, decision: "pending",
    };
    const previous = this.proposals;
    const next = previous.map((one) => one.project === project && one.decision === "pending" ? { ...one, decision: "stale" as const } : one);
    this.save([...next, proposal]);
    for (const old of previous.filter((one) => one.project === project && one.decision === "pending")) this.audit("memory.stale", { ...old, decision: "stale" }, actor, { replacedBy: proposal.id });
    const threadId = this.deps.card?.(proposal) ?? null;
    if (threadId) this.change(proposal.id, (one) => { one.thread_id = threadId; });
    const saved = this.get(proposal.id);
    this.audit("memory.proposed", saved, actor, { lines: proposal.diff.split("\n").length - 2, threadId });
    return saved;
  }

  /** Writes MEMORY.md only on an approval, and only when the file is still the one the diff was made against. */
  decide(id: string, decision: "approved" | "denied", proposedSha: string | undefined, actor: LoopActor): MemoryProposal {
    if (actor.kind !== "person") throw new LoopError(403, `only a person approves a change to ${TEAM_MEMORY_FILE}`);
    const proposal = this.get(id);
    if (proposal.decision !== "pending") throw new LoopError(409, `that proposal is already ${proposal.decision}`);
    if (proposedSha !== undefined && proposedSha !== proposal.proposed_sha256) throw new LoopError(409, "that is not the change this proposal shows");
    const current = readMemory(proposal.project);
    const stale = decision === "approved" && (current ? sha256(current) : "") !== proposal.base_sha256;
    const outcome: MemoryDecision = stale ? "stale" : decision;
    if (outcome === "approved") (this.deps.write ?? writeOwned)(memoryPath(proposal.project), proposal.proposed);
    const next = this.change(id, (one) => { one.decision = outcome; one.decided_by = actor.id; one.decided_at = this.now(); });
    this.audit(outcome === "approved" ? "memory.approved" : outcome === "denied" ? "memory.denied" : "memory.stale", next, actor, {});
    if (stale) {
      this.deps.post?.(next, `${TEAM_MEMORY_FILE} changed after this diff was shown, so nothing was written. Keeper can propose it again.`);
      throw new LoopError(409, `${TEAM_MEMORY_FILE} changed after this diff was shown; propose it again`);
    }
    this.deps.post?.(next, outcome === "approved" ? `Saved ${TEAM_MEMORY_FILE} (sha256 ${next.proposed_sha256.slice(0, 12)}).` : `Not saved: the ${TEAM_MEMORY_FILE} change was denied.`);
    return next;
  }

  /** An answer to one of these cards through the shared card route, or null for any other card. */
  resolveCard(threadId: string, requestId: string, behavior: string, person: string): { status: number; body: unknown } | null {
    const found = this.proposals.find((one) => one.id === requestId && one.thread_id === threadId);
    if (!found) return null;
    if (behavior !== "allow" && behavior !== "deny") return { status: 400, body: { error: "answer this card with allow or deny" } };
    try {
      const proposal = this.decide(found.id, behavior === "allow" ? "approved" : "denied", undefined, { kind: "person", id: person });
      return { status: 200, body: { ok: true, outcome: "answered", proposal } };
    } catch (error) {
      if (error instanceof LoopError) return { status: error.status, body: { error: error.message } };
      throw error;
    }
  }

  private change(id: string, edit: (proposal: MemoryProposal) => void): MemoryProposal {
    const proposals = this.proposals.map((one) => structuredClone(one));
    const target = proposals.find((one) => one.id === id)!;
    edit(target);
    this.save(proposals);
    return structuredClone(target);
  }

  private save(proposals: MemoryProposal[]): void {
    this.store.write(JSON.stringify(proposals, null, 2));
    this.proposals = proposals;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private audit(action: MemoryAuditAction, proposal: MemoryProposal | null, actor: LoopActor, detail: Record<string, unknown>): void {
    const snapshot = proposal ? { id: proposal.id, project: proposal.project, base_sha256: proposal.base_sha256, proposed_sha256: proposal.proposed_sha256, decision: proposal.decision } : null;
    this.deps.audit({ action, proposal: snapshot, actor, detail });
  }
}
