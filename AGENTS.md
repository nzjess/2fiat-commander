# 2fiat Commander

If `tmp/HANDOFF.md` exists, read it first. It holds the project's current state, the agreed decisions, the working
agreements and the next task. Keep it current: update it at the end of every phase and whenever a decision is made, so a
fresh session can always pick up from it. `tmp/` is gitignored, so the handoff is never committed, and a fresh clone won't
have it.

Read `docs/2fiat-api.md` before changing anything in `packages/twofiat-client`.

Rules that always apply:
- Discuss a phase's design before coding it, and pause after each phase for review. Commit only when asked.
- Commits don't carry a co-author line.
- Keep `pnpm typecheck`, `pnpm lint` and `pnpm test` green.
- Real 2fiat data (`captures/`, `.env`) never goes into git or into chat. The app is read-only towards 2fiat.
