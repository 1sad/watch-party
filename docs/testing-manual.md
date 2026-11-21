# Testing by hand

Two windows, read from their own logs. This page is the recipe for the phase gate in `spec.md` §7 C, and for any
check that needs a real window rather than a test. It is written so that the next person does not have to rediscover
it: every command below was run on 2026-11-21 and its output is quoted.

**The one rule:** a screenshot proves what a window *looked* like, never *when*. Anything about timing is a number
read out of a log or an expression — not a picture. Two pictures taken 1.94 s apart once passed a check that said "the
same moment" (T7b2), and the difference was only visible by comparing the clock panels.

## 1. What the gate is

`spec.md` §7 C, the milestone gate: one file, two app windows on this machine, about ten minutes, one window stalled on
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
5. Stall one window on purpose — the dev switch T7b2 added — and leave it stalled for at least ten seconds.
6. Watch the other window for the whole stall: **it must not jump.** A small rate change is allowed and intended; a
   jump, a freeze, or a double restart is a failure.
7. Drag the scrubber several times, quickly, in both windows. Each drag must move the other window once, not a stream
   of corrections (R6).
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
  number a replaced-mirror check quotes.
- `site:` is the site view reporting to the host. A `bridge report` line is one frame's candidate list and is
  **measuring build only** (two lines a second per frame in a busy page); the ad-filter lines are in both builds.

The timing lines come from the drift ladder (`spec.md` §6.3) and are read from **each window's own log**. The fields to
compare are the ones §6.3 names: that window's reported offset, its round trip, and the delta against `expected()`.
The bar for the gate is the one in §6.3, not a number invented here. Two windows over 60 s measured offset −0.4 ms and
rtt 1.0 ms, with a 137 ms skew injected reading back as 136.5 ms with the right sign.

*This section is the part that goes stale first.* If a field named above does not appear in a real run, the run is
right and this page is wrong: correct it here rather than working around it.

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
```

`targets` lists the open window's page as JSON; `eval` prints one value (a number, a string, `null`); `shot` saves a
picture and prints its path. Add `--port 9223` to address window B. If nothing is listening, `targets` prints one line
and exits 1 — it never hangs.

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
it last.

## 8. If something is wrong

- The window opens but shows no page: read the newest log's first lines — a missing `PORT` line means the sidecar did
  not start.
- A second window cannot join: check it was started with `--cdp-port 9223`, and that both windows are looking at the
  same room code.
- `cdp.mjs` finds nothing: the window came from `npm run dev`, not `npm run dev:debug`.
- The logs are in the way: `logs/` is not committed; delete the old files freely.
- **A sidecar started by hand is easy to leak.** `Get-Process node` should show nothing when no window is open; six
  orphaned `node src/server/main.ts` processes survived one afternoon of live checks on 2026-11-21, each holding a
  port. Closing a window with `CloseMainWindow()` takes its sidecar with it; `Stop-Process` on the host, or starting a
  sidecar yourself, does not.

## 9. What this page cannot prove

One machine cannot show that a guest on another network gets the same result (E1), and it cannot show the sixth
member's refusal against five real people. Both are recorded as unproven in `spec.md` §7, not skipped quietly.
