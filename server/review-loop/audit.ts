import type { AdminActionRow, AdminActor } from "../admin-activity.ts";
import type { TaskAuditEvent } from "./loop.ts";
import type { MemoryAuditEvent } from "./memory.ts";

/** One review-loop event as an admin-activity row (category "task"): who, when, what, on which task. */
export function taskAuditRow(event: TaskAuditEvent): Omit<AdminActionRow, "at"> {
  const { task, actor, detail } = event;
  return {
    category: "task",
    action: event.action,
    target: { kind: "task", id: task.id, name: task.slug },
    after: {
      by: actor.kind === "bot" ? `bot:${actor.id}` : actor.kind === "system" ? "review-loop" : actor.id,
      status: task.status,
      tags: task.tags,
      owner: task.owner_bot_id,
      round: task.review_round,
      branch: task.branch,
      ...detail,
    },
    actor: personActor(actor.kind === "person" ? actor.id : null),
  };
}

/** `loopback` is this computer's own CLI or app; any other id is the signed-in person's label. Bots and the loop
 * itself write as the command line, with `after.by` naming them. */
export function personActor(person: string | null): AdminActor {
  if (person === null) return { kind: "cli" };
  if (person === "loopback") return { kind: "loopback" };
  return { kind: "session", sessionId: "", label: person };
}

/** One team-memory event as an admin-activity row (category "memory"). It names the file and the hashes, never its text. */
export function memoryAuditRow(event: MemoryAuditEvent): Omit<AdminActionRow, "at"> {
  const { proposal, actor, detail } = event;
  return {
    category: "memory",
    action: event.action,
    target: { kind: "memory", id: proposal?.id ?? "MEMORY.md", name: proposal?.project ?? "MEMORY.md" },
    after: {
      by: actor.kind === "bot" ? `bot:${actor.id}` : actor.kind === "system" ? "review-loop" : actor.id,
      ...(proposal ? { project: proposal.project, decision: proposal.decision, baseSha256: proposal.base_sha256, proposedSha256: proposal.proposed_sha256 } : {}),
      ...detail,
    },
    actor: personActor(actor.kind === "person" ? actor.id : null),
  };
}
