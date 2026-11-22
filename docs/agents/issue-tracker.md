# Issue tracker

Local and on the owner's machine. There is no external tracker, and none of it is in this repository: `.scratch/` is
git-ignored, and a fresh clone has the code and `docs/` only. A path below is a path on the owner's machine.

- One file per ticket: `.scratch/<feature>/issues/<id>.md`.
- `<id>` is the project's own ticket number — `T1`, `T2`, … — because those numbers are cited in `docs/spec.md`,
  `docs/decisions.md` and `docs/handoff.md` and must keep resolving (AGENTS.md rule 1). A ticket that has to be
  split keeps its number and takes a letter (`T7a`, `T7b`). A number is never reused.
- Every ticket carries `**Status:**` — `ready`, `claimed`, `done`, or `blocked` — and `**Blocked by:**`.
- One commit per ticket, message `T<n>: <title>`. Never two tickets in one commit.
- The phase record (state block, journal, sessions, ledger, review) lives in `.scratch/<feature>/spec.md`.
- The reviewer's report is `.scratch/<feature>/review.md`.
- Nothing outside `.scratch/` records ticket state. A commit message is not a tracker.
