# AGENTS.md — watch-party

A "watch together" app for five friends: a Windows program the host runs for the evening, sharing one link. It
carries its own browser window, everyone lands on the same streaming page, playback stays in step, and chat rides
the same connection. No accounts, no server to rent, no paid services. There is also a deliberately small "watch my
own file" mode, which exists mainly to test sync without a website in the way.

**Status: Phase 1 (M1, "a room that syncs") is being built.** No milestone is complete and nothing has shipped. The
only status line kept current is `.scratch/phase-1-m1/spec.md` → `## Status`; read it before believing any claim
about what works.

**Rebuilt on 2026-11-16** around ADR-022 … ADR-027. **ADR-034** (the window is a .NET host around WebView2, the room
logic stays in TypeScript) and **ADR-035** (this phase's dependency list) are the newest. If a document contradicts
an ADR, the ADR wins and the document is stale.

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

## How to build and run it

Once per machine, before the first ticket: the .NET SDK, installed **per user** so nothing system-wide changes —
`dotnet-install.ps1 -Channel LTS -InstallDir "$env:LOCALAPPDATA\Microsoft\dotnet"` — and the WebView2 runtime, which
Windows 10/11 already has (check it before blaming the app: ADR-034). Node 24 is the other runtime and is present.
The SDK is **not on PATH** in a fresh shell: add `%LOCALAPPDATA%\Microsoft\dotnet` to `PATH` for the session, or call
`dotnet` by full path. Installed here: SDK 10.0.404, WebView2 runtime 157.

| Command | What it does |
| --- | --- |
| `npm run dev` | builds the page, starts the sidecar, opens the window. The normal way to run the app. **This build is production: the dev-only log lines are compiled out**, so a run for measuring is `dev:debug`. It builds the host as **Release**; `dotnet build` on its own builds Debug, so a host change needs `dotnet build host/WatchParty.Host -c Release` too, or a Release-only error stays invisible. |
| `npm run dev:debug` | the measuring build: the development page plus the window with its DevTools endpoint open on `127.0.0.1:9222` (loopback only, Debug host only); `npm run dev` opens no endpoint. A second window: `node scripts/run-host.mjs --cdp-port 9223`. |
| `node scripts/cdp.mjs <targets\|eval\|shot>` | drives a window `dev:debug` opened, with no mouse and no screen: `targets` lists its page as JSON, `eval <id\|index> <expression>` prints one value, `shot <id\|index> <file.png>` saves a picture and prints its path. `--port <n>` or `WP_DEBUG_PORT` picks the window. Nothing listening = one line on stderr, exit 1. |
| `powershell -NoProfile -File scripts/window-shot.ps1 <file.png> [title] [-Process <name>] [-Pid <n>] [-Pids <n,n>] [-Place]` | photographs the **whole window** — site view, strip and sidebar together — and prints the pid, the window rectangle, each capture's instant and the PNG's own size, so a cropped or stale capture shows in the output. `-Pid` picks a window by process (both of this app's windows share the title and process, so the plain form only ever sees the topmost); `-Pids a,b` puts several windows in one picture, top to bottom, from one command; `-Place` stacks them first and never moves one back. DPI-aware, so 125% scaling does not cut the edge off; `cdp.mjs shot` is still the tool for a single page. No focus needed. |
| `npm run check` | the typecheck (`svelte-check`, ADR-036). **Green as of 2026-11-21** — 0 errors, 2 warnings; the pre-commit hook runs it after `npm test`. |
| `npm test` | **the test command.** The timing maths — expected position, clock offset, the drift ladder, offset signs, scheduled start — under `node --test`. No framework, no watch mode; the exit code is the result. |
| `npm run test:integration` | two scripted clients and one authority over real sockets on localhost, one client deliberately slowed. |
| `dotnet build host/WatchParty.Host` | the window host alone. |

A pre-commit hook runs `npm test`, then `npm run check` (`.githooks/pre-commit`, ADR-036), printing one line per step when
it passes and the full output when it refuses. It is the only automated guardrail — there is no
CI and no remote — so **do not commit with `--no-verify`**. If the hook itself is wrong, fix the hook.

```
host/            the .NET window: window and WebView2 lifetime, request filtering, fullscreen
                 interception, the native file picker, starting and stopping the sidecar
src/shared/      types and the timing maths, imported by the sidecar and by the page
src/server/      the sidecar: room, protocol, chat, sync, file serving, and serving the page
src/ui/          what is drawn in the window: player, chat, roster, controls (Svelte)
tests/           node --test; unit under tests/unit, the two-client harness under tests/integration
```

Two rules follow from that shape. The page never touches the filesystem, and the host never touches room state. The
timing maths lives **only** in `src/shared/` — if one of its numbers appears twice, one copy is wrong.

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
10. **Log lines stay ASCII.** PowerShell's default `Get-Content` renders an em dash as `�?"`, so a quoted log line
    becomes garbage exactly when it is evidence (measured on ticket 04). Use `:` or `-`.

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
| How to test by hand, and the two-window gate | `docs/testing-manual.md` |
| Vocabulary | `docs/glossary.md` |

## Definition of v1

See `docs/handoff.md` → "v1 is done when". If a proposed change does not move one of those six bullets, question
whether it belongs in v1.
