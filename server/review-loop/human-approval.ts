// Security invariant: an approval of a MEMORY.md change or of a push, merge, PR or deploy diff is a person's. A bot's
// shell reaches this server as loopback, the same as the person's own terminal, and can say nothing that tells the two
// apart; but it runs only inside its bot's turn, so its bot is busy. A local approval without a session is therefore
// taken only while every bot is idle. A signed-in session (the app or a paired browser) approves at any time; the
// desktop app already refuses every local change that does not come from its own window. A denial is always taken.
//
// Open risk: on an owner-trust server a bot's shell can still pair itself a session through /api/auth/pairing and
// approve with it. OMB_LOOPBACK_TRUST=service closes that too: a local request may then only decline a card.
import type { RequestAuth } from "../request-auth.ts";

export const BUSY_APPROVAL_REFUSAL = "A bot is working right now, and a bot's shell reaches NightShift from this computer just as your own terminal does, so an approval from a command on this computer is taken only while every bot is idle. Approve it on its card in the signed-in app or browser, or again once every bot is idle.";
export const SERVICE_APPROVAL_REFUSAL = "This server does not treat commands on this computer as its owner, so approve it on its card in the signed-in app or browser.";

/** Why this request may not approve, or null. */
export function localApprovalRefusal(input: { auth: RequestAuth; desktopGuarded: boolean; botBusy: boolean }): string | null {
  if (input.auth.kind === "session" || input.desktopGuarded) return null;
  if (input.auth.trust === "service") return SERVICE_APPROVAL_REFUSAL;
  return input.botBusy ? BUSY_APPROVAL_REFUSAL : null;
}
