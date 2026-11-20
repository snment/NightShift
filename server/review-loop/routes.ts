import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import { LoopError, type LoopActor, type ReviewLoop, type TransitionEvent } from "./loop.ts";
import type { DiffAction } from "./model.ts";

export interface WorkTaskRouteDeps {
  loop: ReviewLoop;
  botExists(id: string): boolean;
  /** The person behind a request, for the audit log. */
  person(auth: RequestAuth): string;
}

const TASK = /^\/api\/tasks\/([\w-]+)$/;
const TRANSITION = /^\/api\/tasks\/([\w-]+)\/transition$/;
const REQUEST_APPROVAL = /^\/api\/tasks\/([\w-]+)\/request-approval$/;
const APPROVE_DIFF = /^\/api\/tasks\/([\w-]+)\/approve-diff$/;

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * Open risk: a bot's shell reaches the server as loopback, like the person's own CLI, so `as_bot` is how a bot names
 * itself and a loopback call without it reads as the person. The diff approval card, answered through the shared card
 * route, is the approval path that a bot's shell cannot answer for the person.
 */
export function createWorkTaskRoutes(deps: WorkTaskRouteDeps): RouteHandler {
  const { loop } = deps;
  const actorOf = (auth: RequestAuth, body: Record<string, unknown>): LoopActor => {
    const bot = text(body.as_bot)?.trim();
    if (bot) {
      if (!deps.botExists(bot)) throw new LoopError(400, `unknown bot: ${bot}`);
      return { kind: "bot", id: bot };
    }
    return { kind: "person", id: deps.person(auth) };
  };
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/tasks" && !path.startsWith("/api/tasks/")) return PASS;
    try {
      if (path === "/api/tasks" && method === "GET") return json(res, 200, { tasks: loop.list() });
      if (path === "/api/tasks" && method === "POST") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const actor = actorOf(auth, body);
        const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string") : undefined;
        const task = loop.create({
          title: text(body.title) ?? "", project: text(body.project) ?? "",
          ...(text(body.description) !== undefined ? { description: text(body.description)! } : {}),
          ...(text(body.slug) ? { slug: text(body.slug)! } : {}),
          ...(text(body.room_id) ? { room_id: text(body.room_id)! } : {}),
          ...(text(body.base_branch) ? { base_branch: text(body.base_branch)! } : {}),
          ...(tags ? { tags } : {}),
          created_by: actor.kind === "bot" ? `bot:${actor.id}` : actor.id,
        }, actor);
        return json(res, 201, { task });
      }
      let m = TASK.exec(path);
      if (m && method === "GET") return json(res, 200, { task: loop.get(m[1]!) });
      if (m && method === "PATCH") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const task = loop.patch(m[1]!, {
          ...(text(body.title) !== undefined ? { title: text(body.title)! } : {}),
          ...(text(body.description) !== undefined ? { description: text(body.description)! } : {}),
          ...("room_id" in body ? { room_id: text(body.room_id) ?? null } : {}),
          ...(Array.isArray(body.tags) ? { tags: body.tags.filter((tag): tag is string => typeof tag === "string") } : {}),
          ...(text(body.status) !== undefined ? { status: text(body.status)! } : {}),
          ...(typeof body.diff_override === "boolean" ? { diff_override: body.diff_override } : {}),
        }, actorOf(auth, body));
        return json(res, 200, { task });
      }
      if (m && method === "DELETE") return json(res, 200, { deleted: loop.delete(m[1]!, { kind: "person", id: deps.person(auth) }) });
      m = TRANSITION.exec(path);
      if (m && method === "POST") {
        const body = (await readBody(req)) as Record<string, unknown>;
        return json(res, 200, { task: loop.transition(m[1]!, body as unknown as TransitionEvent, actorOf(auth, body)) });
      }
      m = REQUEST_APPROVAL.exec(path);
      if (m && method === "POST") {
        const body = (await readBody(req)) as Record<string, unknown>;
        return json(res, 200, { task: loop.requestDiffApproval(m[1]!, (text(body.action) ?? "push") as DiffAction, actorOf(auth, body)) });
      }
      m = APPROVE_DIFF.exec(path);
      if (m && method === "POST") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const decision = body.decision === "approved" || body.decision === "denied" ? body.decision : null;
        if (!decision) return json(res, 400, { error: "decision must be approved or denied" });
        const sha = text(body.diff_sha256);
        if (!sha) return json(res, 400, { error: "diff_sha256 is required: approve the exact diff you read" });
        return json(res, 200, { task: loop.decideDiffApproval(m[1]!, text(body.request_id) ?? "", decision, sha, actorOf(auth, body)) });
      }
      return json(res, 405, { error: `${method} ${path} is not a task route` });
    } catch (error) {
      if (error instanceof LoopError) return json(res, error.status, { error: error.message });
      throw error;
    }
  };
}
