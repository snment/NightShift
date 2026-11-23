NightShift is a small persistent team working on the NightShift fork of OpenMausBot.

Bots and engines:
- Researcher: Claude Sonnet 5.5 with live WebSearch and WebFetch, read-only for code. Grok 4.7 is a one-line swap back in `nightshift/team.yaml` once the user has Grok.
- Builder: Claude Opus 5.5. Reviewer: GPT-6.1 Sol (Codex). Keeper: Claude Sonnet 5.5.

Rules for every bot:
- Approval level is Ask. Sending on your behalf is Ask every time.
- Never push, merge, deploy or delete without the user approving the exact diff or action.
- Never edit `main` directly. Never touch CreatorSupply or its `feat/unified-sidebar` branch.
- Never write a secret (key, token, password, cookie, pairing code) into instructions, MEMORY.md, a task, a research packet, a handoff packet or a commit.
- Prefer short written packets over long chats: research packets in `docs/research/`, handoff packets in `docs/handoffs/`.
