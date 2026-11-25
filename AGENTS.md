# AGENTS.md — watch-party

A "watch together" app for five friends: a Windows program the host runs for the evening, sharing one link. It
carries its own browser window, everyone lands on the same streaming page, playback stays in step, and chat rides
the same connection. No accounts, no server to rent, no paid services. There is also a deliberately small "watch my
own file" mode, which exists mainly to test sync without a website in the way.

**Status: phases 1-6 are closed** — M1, M2a, M7 "portable build", the invite work (0.2.1) and **M2b "the window uses
its space" (0.3.0)**: two screens, the picture filling the window with a 380 px chat column beside it, the address bar
and Open a file at every moment, and the room following a page's own navigation. **M2c "the room behaves"**
(`spec.md` §13) is done - its tickets are complete: the evening's faults are fixed, the chat is the room's log, and YouTube plays in the app's own player;
**M3 "the room obeys"** follows it. 51 and 52 are `blocked` on the M3 plan (the phase record the owner keeps on their
machine).
**0.4.0 is the shipped build** — its portable files are attached
to the `v0.4.0` tag in GitHub Releases; nothing is on a store or a server. The only status line kept current is the phase record on the owner's machine (`.scratch/<phase>/spec.md`) → `## Status`;
read it before believing any claim about what works. **The working record -
specs, tickets, session notes, costs - is kept on the owner's machine and is not in this public repo**, so a fresh
clone has the code and `docs/` only.

**Rebuilt on 2026-11-16** around ADR-022 … ADR-027. **ADR-055** (the narrow layout is the page's when no window says
otherwise) and **ADR-054** (a browser guest is a viewer like any other) are the newest, planned as **M2d "browser join"**
for phase 7 with requirements **R51-R56** (`.scratch/phase-7-browser-join/spec.md`, kept locally). ADR-053 (a person's
identity lives in a cookie the app sets on its own host) sits beside them; ADR-054 amends ADR-006 (a cooperating player
may be driven through the API it publishes) and ADR-055 amends ADR-047 (the 380/900 threshold). Beside them sit phase
6's **ADR-049** to **ADR-052** (the chat column is the room's log; a new film starts at zero and the put-back has a
bound; YouTube plays in a player the app owns; a pasted page keeps its query and its fragment). Before them **ADR-048** (the room follows a page's own navigation, not only the address bar) amends ADR-047 (two screens; the picture fills the window with the chat beside it) amends ADR-038, and before it **ADR-046** (a joined guest's media URL carries the room code), **ADR-045** (the UPnP search leaves
UDP 1900) and **ADR-044** (every request is gated on the code); **ADR-043** (the portable copy is its folder, and nothing leaves
it) amends ADR-042; ADR-041 (one portable executable; the browser is the only dependency outside
it), ADR-040 (the ad list is share-alike data), ADR-038 (two views), ADR-039 (a quarter-second deadband) and ADR-034
(the .NET host around WebView2) are the ones that bind the code. If a document contradicts an ADR, the ADR wins and
the document is stale.

## Read in this order

1. `README.md` — one screen of orientation.
2. `docs/open-questions.md` §A — the four blockers that change the architecture. Read before believing the spec.
3. `docs/spec.md` — requirements (R1–R41), model, protocol, sync, modes, milestones.
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
| `npm run dev` | builds the page, starts the sidecar, opens the window. The normal way to run the app. **The page it builds is production: the page's dev-only log lines are compiled out**, so a run for measuring is `dev:debug`. The **host** is built by `scripts/run-host.mjs` with `-c Debug` under both commands (measured 2026-11-21, ticket 08), so `#if DEBUG` host code is live in `dev` too, and a Release-only fault stays invisible: build it separately with `dotnet build host/WatchParty.Host -c Release`. |
| `npm run dev:debug` | the measuring build: the development page plus the window with its DevTools endpoint open on `127.0.0.1:9222` (loopback only, Debug host only); `npm run dev` opens no endpoint. A second window: `node scripts/run-host.mjs --cdp-port 9223`; put A's invite link in quotes after it (`node scripts/run-host.mjs --cdp-port 9223 "watchparty://join?..."`) and the second window opens on that room's watching screen instead of its own front door (T131). |
| `node scripts/cdp.mjs <targets\|eval\|shot\|click\|type\|key>` | drives a window `dev:debug` opened, with no mouse and no screen: `targets` lists its page as JSON, `eval <id\|index> <expression>` prints one value, `shot <id\|index> <file.png>` saves a picture and prints its path, `click <id\|index> <x> <y> [--double]` sends a **real** press and prints the point and `document.activeElement` — a page's `requestFullscreen()` is granted only from one (ticket 19, `docs/testing-manual.md` §7). `type <id\|index> <text> [--at <x> <y>]` enters text as a person's input does (`Input.insertText`, so the page's own handler runs), and `key <id\|index> <key>` sends a real key gesture (`isTrusted: true`), knowing `Space`, `Enter`, `Escape`, the arrows and a single character (tickets 108, 111). `--port <n>` or `WP_DEBUG_PORT` picks the window. Nothing listening = one line on stderr, exit 1. |
| `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/resize-probe.ps1 -Pid <n> [-Count 120] [-IntervalMs 17]` | drives a **scripted drag** on one window: posts `WM_ENTERSIZEMOVE`, sends `SetWindowPos` at the interval, reads the window's own rectangle back after each move, prints a per-move table (index, `hh:mm:ss.fff`, requested, actual, gap in px), the largest gap and where, first/last requested, final actual, moves read back, pacing, and how long the window kept moving after the last request, then posts `WM_EXITSIZEMOVE`. Exit 0 only when every move was read back; exit 2 with one line when the pid has no visible top-level window (ticket 151). Two numbers it exists to protect: **outer pixels are not CSS px** - the wide/narrow decision is the page's CSS width, and outer 1140 is 899 CSS px at 125%, so a drag that must cross 900 CSS px starts above 1142 outer; and `Start-Sleep` sleeps a 15.6 ms tick, so the tool raises the timer resolution to keep a 17 ms interval. |
| `node scripts/upnp-probe.mjs [--port <n>] [--map]` | asks the router for a gateway the way the library does, and prints what came back: one `PROBE: st=<1\|2> answers=<n> location=<url\|none>` line per M-SEARCH (version 2, then version 1) plus one `ANSWER:` line per reply. `--port 0` binds an ephemeral port instead of the library's hardcoded UDP 1900 — on Windows the SSDP service already holds 1900, so the same search gets **no** answer there while an ephemeral port is answered in milliseconds (ticket 66). Use it before blaming a router. Reads the network. Without `--map` it writes nothing; with it, it drives the app's own module through a real `AddPortMapping`, `GetExternalIPAddress` and `DeletePortMapping` on a throwaway port, so a router mapping is created and removed. |
| `powershell -NoProfile -File scripts/window-shot.ps1 <file.png> [title] [-Process <name>] [-Pid <n>] [-Pids <n,n>] [-Place] [-MaxHeight <px>] [-Width <px>] [-Height <px>] [-Maximise]` | photographs the **whole window** — site view, strip and sidebar together — and prints the pid, the window rectangle, each capture's instant and the PNG's own size, so a cropped or stale capture shows in the output. `-Pid` picks a window by process (both of this app's windows share the title and process, so the plain form only ever sees the topmost); `-Pids a,b` puts several windows in one picture, top to bottom, from one command; `-Place` stacks them first and never moves one back. **`-MaxHeight <px>`** needs `-Place`: a stack that does not fit that many physical pixels (or the screen's height, when shorter) is shrunk before capture, and the tool prints the heights it used and the space it fitted them into, so a 1080 px screen needs no hand-resizing; a stack that still does not fit fails and says which window refused to shrink (ticket 89). **`-Width <px>`/`-Height <px>`** set the window's outer size and **`-Maximise`** maximises it before the picture, both physical pixels, both for one window only and both refused with `-Place` or with two pids; each prints the rectangle Windows accepted next to the PNG's own size, and a size the window refuses (its minimum wins) still takes the picture but exits 3 (ticket 91). DPI-aware, so 125% scaling does not cut the edge off; `cdp.mjs shot` is still the tool for a single page. No focus needed. |
| `node tests/fixtures/serve.ts` | the fixture server: `probe.html` (a 60 s film, a play/pause button that reports what it got, a fullscreen button, `?blockplay=1` and `?blockplay=all`), `probe-loop.html` (leaves itself on every load, rendering `leaving <n>`) and `probe-swap.html` (a muted film at 50 s and a `#swap` that replaces the player at 0), on `http://127.0.0.1:8123/` - `PROBE_PORT` or a port argument moves it, loopback only, and it answers byte ranges with `206`. A live check points a window at one of these instead of rebuilding a page (tickets 08, 144). |
| `design/prototype.html` | the interface prototype (ticket 143) - **opened, not run**: a static page of the two screens with sample content, for rearranging and sending back. It is not built, not served and not part of the app; photograph it with `window-shot.ps1` (`docs/testing-manual.md` §7). |
| `npm run check` | the typecheck (`svelte-check`, ADR-036). **Green as of 2026-11-21** — 0 errors, 2 warnings; the pre-commit hook runs it after `npm test`. |
| `npm test` | **the test command.** The timing maths - expected position, clock offset, the drift ladder, offset signs, scheduled start - under `node --test`. No framework, no watch mode; the exit code is the result. **A test that overruns is killed, not waited for:** `--test-timeout` 10 s here and 45 s for `test:integration`, with `--test-force-exit` so a leaked child cannot keep the run alive. That is what bounds the pre-commit hook (ticket 12, measured: without the force-exit a hung run was still alive at 133 s). |
| `npm run test:integration` | two scripted clients and one authority over real sockets on localhost, one client deliberately slowed. |
| `powershell -NoProfile -File scripts/portable-launch.ps1 -Exe <path> [-Count 2] [-CdpPort <n>] [-WaitSec <n>] [-Restore] [-Close] [-Sweep]` | the packaged-copy rig: copies the exe to a fresh folder under `%TEMP%\wp-portable-<stamp>\`, launches it with `PATH` cut to `C:\Windows\System32` and no `WATCHPARTY_*`, waits for its log and prints one block per copy - pid, log path, `PORT`, runtime folder. `-Count 2` assigns two DevTools ports (9222, 9223) and refuses one already listening; the **room** port is the sidecar's own (`listen(0)`), read back from the log and required to differ. Leaves the windows visible; exits non-zero when a copy never logs a `PORT`. **Run it from a console or capture its output: both return** (ticket 46b rebuilt the rig on `Win32_Process.Create`; `... -Count 2 | Out-String` returned in 3,766 ms with exit 0, and `>` behaved the same). A caller that used `Start-Process -RedirectStandardOutput <file>` gets an empty `$LASTEXITCODE` and must read the exit status from the captured file. It passes a **closed environment** (no `WATCHPARTY_*` from the caller, no `WEBVIEW2_*`) and sets `WATCHPARTY_CDP_PORT` on each copy, which only a Debug host reads; a check that needs another override starts the copy itself, not the rig (tickets 47b, 48). Each copy's block also prints `registration: before=<value\|none> after=<value\|none>` for `HKCU\Software\Classes\watchparty\shell\open\command`, because every start of the app rewrites that key to its own exe and each copy therefore steals the scheme from the last; **`-Restore`** on its own (no `-Exe`, launches nothing) then points it back at the newest `host\WatchParty.Host\bin\Debug\**\WatchParty.Host.exe`, or removes the `HKCU\Software\Classes\watchparty` tree when there is none, printing which of the two it did and the value written - it touches no other key (ticket 89). **`-Close`** closes only the pids this invocation started - one `WM_CLOSE` per window, so each host runs its own goodbye and a guest copy may take that budget; a window still open after 10 s is ended, and a sidecar it left behind goes with it, printing one line per pid and `closed: <n> copy/copies`; given alone it launches nothing and says so. **`-Sweep`** removes only `%TEMP%\wp-portable-*` folders from earlier runs, and keeps any folder a live process still runs from (ticket 109). |
| `dotnet build host/WatchParty.Host` | the window host alone. |
| `npm run portable` | builds `release/WatchParty-<version>-portable.exe`: one self-contained .NET exe carrying a zip payload (a pinned Node 24 `node.exe`, the sidecar and shared sources, **production** dependencies only, the built page, the ad list and a `package.json`), embedded as a resource. Downloads the pinned Node dist and verifies it against `SHASUMS256.txt`, cached in `release/cache/`; `WATCHPARTY_NODE_BIN` points at a local binary for an offline build. Prints the exe size, the payload's file count and hash, and the Node version and checksum (ticket 45, ADR-042). The exe unpacks itself once into `<its folder>\runtime\<version>-<hash8>` and keeps its profile and logs in that folder too - the whole app is the folder it sits in (ADR-043; 46c-46d moved the last of it, and ADR-043 records the .NET loader's `%TEMP%\.net` cache as the one exception); `release/` is git-ignored. **`npm run portable:full`** adds a pinned fixed WebView2 runtime (158.0.4370.33, its 417 MB cab cached in `release/cache/` and sha256-checked) to the same payload - 501 MB - and logs `engine: folder=<extracted> version=<v>` where the plain build logs `engine: folder=none (machine runtime)`; with neither engine the window shows one plain sentence (tickets 47, 47b). **`npm run portable:debug`** builds the same shape with the Debug host and the development page (`page: development`), the DevTools endpoint the rig's `-CdpPort` drives, and `NODE_ENV=development`: it is what the packaged gate runs, and the Release copy refuses its endpoint (ticket 48). |

A pre-commit hook runs `npm test`, then `npm run check` (`.githooks/pre-commit`, ADR-036), printing one line per step when
it passes and the full output when it refuses. It is the only automated guardrail — there is no CI, and since 2026-11-22
the one remote is the private `github.com/1sad/watch-party` (no workflow runs there either) — so **do not commit with `--no-verify`**. If the hook itself is wrong, fix the hook. **In
PowerShell its progress lines arrive on stderr and surface as a `NativeCommandError` with exit 1 while the commit
lands** - confirm with `git log --oneline -1` before believing a commit failed (every worker in phase 3 hit this).

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
11. **A new version is the user's call.** Building a portable file, tagging a version or attaching anything to GitHub
    Releases happens only when the user asks for it in that session. A closed milestone, a green test run or a phase
    close is not an instruction to publish a new build; ordinary session commits and pushes are separate and continue
    as the kit says.

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
- **Windows Firewall asks once per program path** the first time a copy listens: allow **private networks** only (the
  public box is for machines on the same untrusted wifi, and chat is plain text). Every new folder is a new program to
  Windows, so a fresh packaged copy asks again. Cancelling blocks friends but breaks no test here - two windows on one
  machine never cross the firewall (measured by the user's question, 2026-11-22). A WISP travel router puts the group
  behind two NATs: the prompt then does nothing for internet joining, which is the E1 question above.

## Where things live

| | |
| --- | --- |
| Requirements, protocol, algorithms | `docs/spec.md` |
| Why any choice was made | `docs/decisions.md` |
| What is unproven | `docs/open-questions.md` |
| What to do next, and how to test it | `docs/handoff.md` |
| Prior art, numbers, links | `docs/research.md` |
| How to test by hand, and the two-window gate | `docs/testing-manual.md` |
| Costs, per session and per phase (kept locally, not published) | `.scratch/COSTS.md` - `verify-cost.ps1` in the agent kit reads them from the local API and rewrites the file with `-Write` |
| Vocabulary | `docs/glossary.md` |

## Definition of v1

See `docs/handoff.md` → "v1 is done when". If a proposed change does not move one of those six bullets, question
whether it belongs in v1.
