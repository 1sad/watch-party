# AGENTS.md — watch-party

A "watch together" app for five friends: a Windows program the host runs for the evening, sharing one link. It
carries its own browser window, everyone lands on the same streaming page, playback stays in step, and chat rides
the same connection. No accounts, no server to rent, no paid services. There is also a deliberately small "watch my
own file" mode, which exists mainly to test sync without a website in the way.

**Status: documents only. Zero code. Nothing here has been built or tested.**

**Rebuilt on 2026-11-16** around ADR-022 … ADR-027. If a document contradicts those, the ADRs win and the document
is stale.

## Read in this order

1. `README.md` — one screen of orientation.
2. `docs/open-questions.md` §A — the four blockers that change the architecture. Read before believing the spec.
3. `docs/spec.md` — requirements (R1–R36), model, protocol, sync, modes, milestones.
4. `docs/decisions.md` — ADR-001…033, each with the alternatives rejected and why. ADR-022 onward is current;
   **ADR-030…033 supersede earlier answers** and are the ones to read first.
5. `docs/handoff.md` — experiments, tickets, test recipes, risks.
6. `docs/research.md` — **reference, not required reading.** §25 is the link index (repos, libraries, licences);
   §27 is the tunnel research, kept only to show why none of it is needed.

Long documents; read the sections you need rather than everything at once.

## Rules for working here

1. **The docs are the contract.** `§` section numbers, `ADR-nnn` and `Rnn` are stable identifiers. Cite them
   ("ADR-024 says one writer, ever") instead of paraphrasing.
2. **A new decision needs a new ADR.** Anything that contradicts an existing one must update that ADR in the same
   change. A decision buried in code or a commit message does not count.
3. **A new feature needs a requirement.** Add `Rnn` to `spec.md §2` and a milestone row, or it is not in scope.
4. **No product code until E1 and E2 in `docs/handoff.md` are answered** and their results recorded (append a
   "Results" line under each). E1 decides whether direct connections work at all; E2 decides whether an embedded
   browser can drive these sites. Between them they can invalidate the architecture, not just the tickets.
5. **No new dependency without an ADR.** ADR-012, ADR-013 and ADR-022 already pick the stack; changing it is an ADR,
   not a diff.
6. **No paid service, no account, no server.** Not for hosting, not for networking, not for signalling (ADR-023).
   Proposing one is an ADR that reverses a stated requirement, with the user's answer attached.
7. **Use the glossary's words** (`docs/glossary.md`). If a term is missing, add it there rather than inventing a
   synonym.
8. **After editing any doc, re-check cross-references.** Every `§`, ADR and ticket reference must resolve; tickets
   stay continuous; section numbers stay continuous.
9. **Edit surgically.** These files are dense on purpose. Do not rewrite a section to change a sentence.

## Known-weak answers (attack these first)

The docs are honest about where they are thin:

- Whether the group's home connections can accept visitors at all is **unmeasured** (E1, ADR-023). This is the
  single largest assumption in the project.
- Whether an embedded browser can play these sites, with ads blocked, is **unmeasured** (E2, ADR-022).
- The 4-second hard-seek threshold is borrowed from Syncplay, not measured for this app (`spec.md §6.3`).
- "No interruption" when authority moves is a design argument, not a measurement (E7, R22).
- The rescue relay depends on reusing a page's stream outside the browser, which several sites prevent (E6,
  ADR-026).
- Constant offsets may not be enough for differently-edited copies; anchor points are deferred (`ADR-017`,
  `spec.md §4.5`).
- The ready gate uses `readyState >= 3`, which may be the wrong signal with MSE (`open-questions.md` §D).
- Plain HTTP on an opened port means chat is readable by anyone on the path (ADR-023). Accepted, not solved.

## Where things live

| | |
| --- | --- |
| Requirements, protocol, algorithms | `docs/spec.md` |
| Why any choice was made | `docs/decisions.md` |
| What is unproven | `docs/open-questions.md` |
| What to do next, and how to test it | `docs/handoff.md` |
| Prior art, numbers, links | `docs/research.md` |
| Vocabulary | `docs/glossary.md` |

## Definition of v1

See `docs/handoff.md` → "v1 is done when". If a proposed change does not move one of those six bullets, question
whether it belongs in v1.
