// Security invariant: an approval of a MEMORY.md change or of a push, merge, PR or deploy diff is a person's. A bot's
// shell reaches this server as loopback, the same as the person's own terminal, and can say nothing that tells the two
// apart; but it runs only inside its bot's turn, so its bot is busy. A local approval without a session is therefore
// taken only while every bot is idle. A signed-in session (the app or a paired browser) approves at any time; the
// desktop app already refuses every local change that does not come from its own window. A denial is always taken.
//
// Open risk: on an owner-trust server a bot's shell can still pair itself a session through /api/auth/pairing and
// approve with it. OMB_LOOPBACK_TRUST=service (NightShift's way of running, nightshift/start.ps1) closes that too: a
// local request may then only decline, or take a bot's own review-loop step naming that bot.
import type { RequestAuth } from "../request-auth.ts";

export const BUSY_APPROVAL_REFUSAL = "A bot is working right now, and a bot's shell reaches NightShift from this computer just as your own terminal does, so an approval from a command on this computer is taken only while every bot is idle. Approve it on its card in the signed-in app or browser, or again once every bot is idle.";
export const SERVICE_PERSON_REFUSAL = "This server does not treat commands on this computer as a person: sign in in the app or browser, or run the command with --token-file (openmausbot connect makes one). A command on this computer may only decline, or take a bot's own step with --as-bot.";
export const SERVICE_APPROVAL_REFUSAL = "This server does not treat commands on this computer as its owner, so approve it on its card in the signed-in app or browser.";

/** Why this request may not approve, or null. */
export function localApprovalRefusal(input: { auth: RequestAuth; desktopGuarded: boolean; botBusy: boolean }): string | null {
  if (input.auth.kind === "session" || input.desktopGuarded) return null;
  if (input.auth.trust === "service") return SERVICE_APPROVAL_REFUSAL;
  return input.botBusy ? BUSY_APPROVAL_REFUSAL : null;
}

/** A session-less local caller on a service-trust server: a bot's shell as far as the server can tell. */
export function serviceCaller(auth: RequestAuth): boolean {
  return auth.kind === "loopback" && auth.trust === "service";
}
