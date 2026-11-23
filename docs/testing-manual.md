# Testing by hand

Two windows, read from their own logs. This page is the recipe for the phase gate in `spec.md` §13, and for any
check that needs a real window rather than a test. It is written so that the next person does not have to rediscover
it: every command below was run on 2026-11-21 and its output is quoted.

**The one rule:** a screenshot proves what a window *looked* like, never *when*. Anything about timing is a number
read out of a log or an expression — not a picture. Two pictures taken 1.94 s apart once passed a check that said "the
same moment" (T7b2), and the difference was only visible by comparing the clock panels.

## 1. What the gate is

`spec.md` §13, the milestone gate: one file, two app windows on this machine, about ten minutes, one window stalled on
purpose. The gap must never be audible and the healthy window must never jump. **Two windows on this one machine** is
the gate; "on the other machine" needs a second machine on the LAN and is recorded as unproven, not skipped.

## 2. Before the first window

- `npm run build` state is irrelevant — `npm run dev:debug` rebuilds the page itself.
- **Use `npm run dev:debug`, not `npm run dev`.** Both open a window; only the debug build keeps the dev-only log
  lines. `npm run dev` compiles them out, which is right for a person and useless for a measurement.
- The .NET SDK is installed per user and is **not on PATH** in a fresh shell: add `%LOCALAPPDATA%\Microsoft\dotnet`,
  or call `dotnet` by full path.

## 3. Two windows, in order

```
npm run dev:debug
```
That is window A: the development page plus the window, with its DevTools endpoint on `127.0.0.1:9222`. It prints the
path of its log, and that path is also line 1 of the file.

```
node scripts/run-host.mjs --cdp-port 9223
```
That is window B — **not** `npm run dev:debug` a second time. Two windows need two ports *and* two browser profiles, and
the profile is derived from the port, so the second window must be started with a different one.

Join B to A's room with the invite link A shows (or the six-character room code). Both windows now play the same file
from A's sidecar.

To find the two logs afterwards:

```
Get-ChildItem logs -Filter *.log | Sort-Object Name | Select-Object -Last 2
```

The name is `host-<yyyyMMdd-HHmmss-fff>-<pid>.log`, so the newest window sorts last. Every line inside carries
`[host HH:mm:ss.fff]`, and the first line is that file's own path — which is how you tell which console belongs to
which window.

## 4. The gate, step by step

1. Open A with `npm run dev:debug`. Note its room code and its log path.
2. Open B with `node scripts/run-host.mjs --cdp-port 9223`. Join it with A's link.
3. Press play in A and let both run. Check A's roster shows two people.
4. Scrub A's player to the middle. B must be at the same position, within a fraction of a second, without a reload.
5. Stall one window on purpose — the dev switch T7b2 added. On this build the frozen window is pulled back by §6.3's
   four-second hard-seek rule, so the stall lasts about four seconds whatever the switch is set to (measured
   2026-11-22, ticket 49: `drift=-4.203 … action=seek` at the fourth second, the healthy window untouched). Do not
   fight it; the stall's job is the next step.
6. Watch the other window for the whole stall: **it must not jump.** A small rate change is allowed and intended; a
   jump, a freeze, or a double restart is a failure.
7. Drag the scrubber several times, quickly, in the **owner's** window: each drag must send one command, not a stream
   of corrections (R6), and the other window must arrive at that position once. A **guest's** drag sends nothing — one
   write per action (ADR-030) — and is undone locally; its evidence is the absence of a command, not a correction.
8. Ten minutes of that, with one stall in the middle, is the gate.

What a healthy run looked like on this machine (recorded, not imagined): a pause in one window stopped the other in
18 ms; a hard scrub sent one command, not a flood; a third window joining 30 s in landed within 118 ms; a reload
returned at the room's position.

## 5. The expected log lines

Host lines, quoted from a real run on 2026-11-21 (`logs/host-20261121-012102-329-23384.log`):

```
C:\dev\Code\misc\watch-party\logs\host-20261121-012102-329-23384.log
[host 01:21:02.363] dev: remote debugging on 127.0.0.1:9222 (Debug build only)
[host 01:21:03.148] sidecar: PORT 63144
[host 01:21:03.152] parsed sidecar PORT 63144; navigating to http://127.0.0.1:63144/
```

and, when the window closes, its own last line:

```
[host 01:14:16.477] closing: killing sidecar pid 18356
```

If `logs/` holds a file per window but one of them lacks its own `PORT` line, or shows a port another window also
names, the two are sharing a sidecar — that is the failure this log split exists to catch.

Website mode adds one prefix per speaker, quoted from a real run on 2026-11-21 (`logs/host-20261121-183017-716-5412.log`):

```
[host 18:19:54.330] page: [ws] hello
[host 18:20:13.698] page: [popup] cancelled host=example.com nav=1
[host 18:30:21.577] player: frame https://plyr.animex.one/e/...cnygl/1 554x312 duration=1420.0 reason=appeared
[host 18:30:19.109] site: bridge report frame=https://animex.one/watch/... seq=3 count=0 [none]
[host 18:19:52.101] site: ad list <n> host(s) from data/ad-hosts.txt
[host 18:19:58.744] site: navigation cancelled=2 host(s)=acscdn.com
```

- `page:` is what our page sent the host. `[ws] hello` is the room page's greeting: a window with no `page:` line at all
  never connected, which is a different failure from a page that loaded and voted nothing.
- `player:` is one line per election and is written in both builds. It names the frame the winner sits in, its size, its
  duration and the reason. A second line with a later timestamp is a re-election, so the gap between two lines is the
  number a replaced-mirror check quotes. Since ticket 06 two command shapes share the prefix, both in both builds:
  `player: applied reason=play target=83.500 from=80.120` when the room's command reached the site's player, and
  `player: drift expected=83.500 actual=83.608 delta=108` at most once a second for the elected player. A live sync
  check quotes those two lines rather than reading a picture. Both are the **site** player's lines. File mode has no
  site player to elect, so the same comparison is printed by the ladder as `[dev] correction member=<id> drift=<s>`
  in **seconds to three decimals** (`drift=-0.060` is -60 ms, not -0.06 ms; measuring build only, ticket 09c): a
  file-mode sync check quotes that line instead, and a website-mode check that
  finds no `player: drift` line has a bridge fault, not a timing fault.
- `site:` is the site view reporting to the host. A `bridge report` line is one frame's candidate list and is
  **measuring build only** (two lines a second per frame in a busy page); the ad-filter lines are in both builds.

The timing lines come from the drift ladder (`spec.md` §6.3) and are read from **each window's own log**. The fields to
compare are the ones §6.3 names: that window's reported offset, its round trip, and the delta against `expected()`.
The bar for the gate is the one in §6.3, not a number invented here. Two windows over 60 s measured offset −0.4 ms and
rtt 1.0 ms, with a 137 ms skew injected reading back as 136.5 ms with the right sign.

*This section is the part that goes stale first.* If a field named above does not appear in a real run, the run is
right and this page is wrong: correct it here rather than working around it.

**The Release host log has no invite line.** Measured on the 0.2.0 portable copy (ticket 83, 2026-11-23): 31 lines, and
none carries the room code or the link - they exist only on the start screen. For a packaged copy, photograph the start
screen with `window-shot.ps1` and read the code from the picture. If the page is already scrolled past the code, the
copy answers `http://127.0.0.1:<PORT>/discovery` **on loopback** (over the LAN it is `403`) with the JSON the start
screen renders - `roomCode`, `lanIp`, `localPort`, `invite.primary`, `invite.raw` - which is how ticket 87 read it on
0.2.1 (2026-11-23).

## 6. The clock panel: what it does and does not tell you

The clock panel in the page shows the **last ping** it received: `offset −0.6 ms`, `rtt 1.0 ms · 2 samples`, and
`local 01:21:08.263 · authority 01:21:08.262`.

It does **not** show when the screenshot was taken. So:

- Two windows side by side in one picture prove their offsets were similar, not that the picture is simultaneous.
- The `local`/`authority` times in the panel are the moment of that ping, which can be seconds before the picture.
- **To compare two windows at one moment, do not photograph them.** Read one number from each with a shell command
  (section 7), or read each window's own log for the same event. A pair of screenshots is evidence only when the
  numbers in them already agree and the question is visual.

## 7. Reading and photographing a window without a mouse

```
node scripts/cdp.mjs targets
node scripts/cdp.mjs eval 0 "document.querySelectorAll('video').length"
node scripts/cdp.mjs shot 0 .scratch/run.png
node scripts/cdp.mjs click 0 440 144
```

`targets` lists the open window's page as JSON; `eval` prints one value (a number, a string, `null`); `shot` saves a
picture and prints its path. Add `--port 9223` to address window B. If nothing is listening, `targets` prints one line
and exits 1 — it never hangs.

`click <id|index> <x> <y>` sends a real mouse press and release at a point in the page and prints the target, the point
and the page's `document.activeElement`; add `--double` for a double click. Use it whenever a page will only act on a
person's gesture: a `requestFullscreen()` reached by a real press is granted, while the same call from `eval` is
refused. A press grants that trust for about five seconds only, so prove a scripted call is refused in a freshly written
document, or at least six seconds after the last press (measured 2026-11-22, ticket 19). **That grant did not
reproduce in this app's own two views** on 2026-11-22 (ticket 23): there a trusted press is refused with `TypeError: not
granted` while `document.fullscreenEnabled` reads `true` and no permissions policy is sent, because this window owns
fullscreen itself (ADR-028). See "The probe page the repository owns" below.

A press also proves nothing while its document is hidden: `cdp.mjs click` waits on the page's next animation frame, so a
hidden view swallows the press and the call times out after 10 s (`Runtime.evaluate got no answer`) instead of failing.
Check `document.visibilityState` before believing a refusal (ticket 23).

Anything a person would read off the screen, ask the page for instead. That is what makes a check cheap and what makes
it possible for the lead to check a worker's claim without repeating the mouse work.

For the whole window — site view, strip and sidebar in one frame, which `shot` cannot give you — use the camera:

```
powershell -NoProfile -File scripts/window-shot.ps1 .scratch/run.png
powershell -NoProfile -File scripts/window-shot.ps1 .scratch/pair.png -Pids 1234,5678 -Place
```

It prints each window's pid, rectangle and capture instant plus the PNG's own size, so a cropped or stale picture shows
in its output rather than in your judgement. `-Pid`/`-Pids` pick by process, which is what two windows need: they share
a title, so the plain form only ever photographs the topmost. `-Place` stacks them first and never puts one back, so run
it last. A window restored from the taskbar draws again, but its page stays scrolled where it was: scrolled to the
top, this page puts the invite panel where the player should be (measured 2026-11-22, ticket 49), so scroll each
window to its player before the shot.

### Pictures at two window sizes

This phase's acceptance is a picture at a size nobody has to set by hand. `-Width`/`-Height` set a window's outer size
and `-Maximise` maximises it before the shot, both in physical pixels at the current scaling - the same unit the printed
rectangle reports - and both for one window only:

```
powershell -NoProfile -File scripts/window-shot.ps1 .scratch/<phase>/evidence/narrow.png -Pid <n> -Width 900 -Height 700
powershell -NoProfile -File scripts/window-shot.ps1 .scratch/<phase>/evidence/max.png -Pid <n> -Maximise
```

Each prints the rectangle Windows accepted beside the PNG's own size, after the window settles; a size the window refuses
(its minimum wins) still takes the picture but exits 3, so a wrong-size picture cannot pass for the size that was asked.
Both are refused with `-Place` or with two pids: size one window at a time, then photograph the pair with `-Place`. A
phase's acceptance pictures live under `.scratch/<phase>/evidence/`, named for the ticket that needed them (ticket 91).

### The rig for a live check

These traps have each cost a re-run, on 06b, on 07b, on 09b and on 21b. Do these before a live check, not after it fails.

1. **Every `cdp.mjs` call names its window.** Two windows means `--port 9223` on B and `--port 9222` on A, or
   `WP_DEBUG_PORT` in the environment. A call with no port reads the default window and quietly answers for the wrong one.
2. **Neither window may be minimised.** A host started `-WindowStyle Hidden` never draws, and the camera refuses it until
   the window is restored with `ShowWindow(SW_RESTORE)`. Start both windows visible.
3. **A local page server must answer `206`.** One that answers `200` with `accept-ranges` but no `206` makes
   `video.seekable` read `[0, 0]`, so every seek lands at 0 and the ladder looks broken. Serve real `Range` responses.
4. **PowerShell 5.1 cannot send a `Range` header.** `Invoke-WebRequest` drops it; the `206` proof is
   `curl.exe -s -o NUL -w "%{http_code}" -r 0-99 <url>`.
5. **A real press and a scripted call are not the same call.** A `click` grants the page transient trust for about five
   seconds; inside that window an `eval`led `requestFullscreen()` succeeds too, so a "trusted beats scripted" comparison
   run too soon reads inverted. Write a fresh document for the negative probe, or wait six seconds. On this engine
   (WebView2 157) the refusal reads `TypeError: Permissions check failed`, not the older `not granted`.
6. **A reload is not a re-election.** `location.reload()` on the site view can leave `player: none reason=replaced` with
   nothing taking its place; if the log shows that, restart both windows rather than chasing the bridge.
7. **`cdp.mjs eval` loses double quotes inside PowerShell.** The shell strips them before node sees them, so an
   expression containing `"` fails with `SyntaxError: Unexpected identifier` (measured 2026-11-22, ticket 21b). Use
   single quotes around selectors, or write the expression to a file and have a small driver read it.
8. **A still can be stale.** `window-shot.ps1` prints each capture's instant and the PNG's size, but WebView2 hands
   `PrintWindow` its last *composited* frame: on 2026-11-22 (21b) two windows photographed 0.9 s apart showed scenes about
   a minute apart while their logs put both players within half a second of each other. A picture proves layout, chrome and
   error text; the `player: drift` lines prove that two windows were at the same moment.
9. **A ten-minute gate runs on the user's own machine, so tell them before it starts.** On 2026-11-22 (ticket 49) the
   user hid a window to the taskbar and scrolled inside both while the run was in progress; that run happened to be
   clean, but its numbers would have had to be thrown away and the ten minutes paid again. Say when it starts and when
   it ends, and ask them not to touch the windows until it does.

### The probe page the repository owns

`tests/fixtures/probe.html` is the page to point a live check at when the check needs a page this project controls. Do
not rebuild another throwaway one on `127.0.0.1:8099`: tickets 08, 08b and 09a each rebuilt and lost one, and a
rebuilt page differs from the last in ways nobody records.

```
node tests/fixtures/serve.ts
```

It prints `probe page on http://127.0.0.1:8123/probe.html`; `PROBE_PORT` or a port argument moves it, and it binds
loopback only. Load it with `node scripts/cdp.mjs eval <index> 'location.href = "http://127.0.0.1:8123/probe.html"'`, or
start a window with `WATCHPARTY_SPIKE_URL` set to that URL. Pick the view by its `href` from `cdp.mjs targets`, not by
index: with no spike URL the app view is index 0 and the site view index 1, and the order reverses when a spike URL is
set (ticket 23).

The page carries `#fullscreen`, a `#playpause` button that writes what it received into `#label`, and a 60-second
`tests/fixtures/fixture.mp4`. `seekable` reads `60.00 of 60.00` because the server answers `Range` with `206` and a real
`Content-Range` (trap 3 above); `tests/unit/probe-server.test.ts` holds it to that under `npm test`.

The fullscreen button reports what it sends; it does not prove a grant. This window never grants `requestFullscreen()`
(ADR-028): a real press in the visible site view is heard and logged as `site: fullscreen=enter w=... h=...` while
`document.fullscreenElement` stays `null`. Quote that intent line, not a fullscreen element.

### A file long enough for a timed gate

`tests/fixtures/fixture.mp4` is **60 seconds**, which is right for the probe page and wrong for any check that runs for
minutes. On 2026-11-22 (ticket 50b) a ten-minute gate on it held two one-minute stretches, because the room paused
itself at the end of the film twice. Generate a long file once and keep it in the phase folder:

```
ffmpeg -y -f lavfi -i "testsrc2=size=640x360:rate=10:duration=720" -c:v libx264 -preset ultrafast -crf 32 -pix_fmt yuv420p <folder>\gate-720s.mp4
```

That yields 720.0 s and 44.5 MB (measured 2026-11-22, `.scratch/phase-3-m7/gate-720s.mp4`) and needs no network. If
ffmpeg is not installed, any long video will do. Point `WATCHPARTY_PICK_PATHS` at it and **read the host log's
`[media] registered ... duration=<n>` line before starting the clock** - a duration line costs a second, ten minutes on
the wrong file costs the run. The picture moves, so two windows can be compared by eye as well as by number.

## 8. If something is wrong

- The window opens but shows no page: read the newest log's first lines — a missing `PORT` line means the sidecar did
  not start.
- A second window cannot join: check it was started with `--cdp-port 9223`, and that both windows are looking at the
  same room code.
- `cdp.mjs` finds nothing: the window came from `npm run dev`, not `npm run dev:debug`.
- The logs are in the way: `logs/` is not committed; delete the old files freely.
- **A site navigates itself away.** Measured 2026-11-21: `bingebang.sx` replaces its player and sends the whole site view
  to `google.com` about 15 s after load, then covers it with a Google cookie-consent layer. A trusted press at a player
  control then lands on that layer or on `HTML.`, so the press proves nothing. Dismiss the consent (a trusted click on
  its reject button) or use the repository's own page for a layout or bridge check. Never read a site's own redirect as a
  fault in our bridge.
- **A sidecar started by hand is easy to leak.** `Get-Process node` should show nothing when no window is open; six
  orphaned `node src/server/main.ts` processes survived one afternoon of live checks on 2026-11-21, each holding a
  port. Closing a window with `CloseMainWindow()` takes its sidecar with it; `Stop-Process` on the host, or starting a
  sidecar yourself, does not.

## 9. What this page cannot prove

One machine cannot show that a guest on another network gets the same result (E1), and it cannot show the sixth
member's refusal against five real people. Both are recorded as unproven in `spec.md` §7, not skipped quietly.
