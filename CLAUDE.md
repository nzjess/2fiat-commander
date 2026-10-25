# 2fiat Commander

Start by reading `docs/HANDOFF.md`. It holds the project's current state, the agreed decisions, the working
agreements and the next task. Read `docs/2fiat-api.md` before changing anything in `packages/twofiat-client`.

Keep `docs/HANDOFF.md` current: update it at the end of every phase and whenever a decision is made, so a fresh
session can always pick up from it.

Rules that always apply:
- Discuss a phase's design before coding it, and pause after each phase for review. Commit only when asked.
- Keep `pnpm typecheck`, `pnpm lint` and `pnpm test` green.
- Real 2fiat data (`captures/`, `.env`) never goes into git or into chat. The app is read-only towards 2fiat.
