# Handoff

## State

- **Nothing is built.** This folder contains six documents and zero code. The one exception during research was a
  throwaway spike used to answer E2; its results are recorded below and the code was deleted on 2026-11-20.
- **The documents were rebuilt on 2026-11-16** around six decisions (ADR-022 … ADR-027): the desktop app is the front
  door, the product is website mode, the network is peer-to-peer with no services and no accounts, everyone
  controls everything, the room outlives its host in website mode, and file mode is a test rig. Ticket numbers were
  deliberately reset to T1 that day, because the milestone structure changed; the old T-numbers no longer mean
  anything.
- What is still unverified is in `open-questions.md`, ordered by how much it would change the plan. Read that after
  this file.

## Before writing product code: nine experiments

Each is a few hours at most and can kill a large part of the plan. **E1 and E2 come first**: every other
experiment assumes the app can get a connection and drive a page, and if either fails the architecture changes, not
the code.

### E1 — Can your friends' connections accept visitors at all? (gates all of ADR-023)

Every person who might host, on their own home network:

1. Open the router's admin page and find the UPnP setting. Record on/off.
2. From a machine outside the house (a phone on mobile data is fine), try to reach a port opened on that network.
   Cheapest test: run `python -m http.server 8000` on the PC, use the router's UPnP screen (or any small UPnP test
   tool) to map 8000, then hit the public address from the phone.
3. Record the public address the router reports and compare it with what the PC's own "what is my IP" lookup says.
   **If they differ, that network is behind a shared address (CGNAT) and can never host.**

**Pass:** a random high port is reachable from outside on every host's connection.
**Record:** per person — UPnP present, mapping succeeded, addresses matched.
**Fail case that matters:** CGNAT. That person cannot host at all, and there is no free fix; they can still join
someone else's room. If it is more than one person, ADR-023 needs revisiting before a line of code is written.

**Results (2026-11-17 - owner's PC, Windows): FAIL for this host.**

- Router LAN `<router LAN>`. UPnP service **on**, and demonstrably working: a live redirect already exists
  (`UDP <port> -> <host LAN>`), created by Tailscale asking for it. So the "can the router open a door" half of
  E1 is answered **yes**.
- **The blocker is one level up.** The router's own WAN address is a private `<router WAN>` with gateway `<gateway>`,
  and a NAT-PMP public-address request returns that same private address. The router therefore has no public address of
  its own; it sits behind the provider's NAT. What the world sees (`<public IP>`, confirmed both by an external IP
  lookup and by the router's own "Public IP" field) is shared with other subscribers. No IPv6.
- This connection is a **public city hotspot** in WISP mode, not a normal home line.
- **Consequence:** inbound connections cannot reach this machine, and no router setting fixes it. The owner cannot
  be the one whose PC keeps the room. Either a member with a normal connection hosts, or ADR-023's "no service" rule
  is revisited (`open-questions.md` A1).
- **Still to record:** the same three answers for each friend. One normal connection in the group is enough for v1.
- **Context added 2026-11-17:** the owner's connection at the time was a shared hotspot, not a home line of their own.
  The assumption is that other members have ordinary home lines, and
  supporting evidence is that the group has hosted peer-to-peer games before. Treat that as **provisional pass**,
  not proof: games commonly succeed through hole-punching or the game's own relay rather than a reachable port.
  One targeted question settles it - *did the host ever forward a port, or did it just work?* - and a "just worked"
  answer is exactly the UPnP-plus-real-address case this architecture needs.

### E2 — Does the app approach work? (gates ADR-022)

One afternoon, no product code: a minimal Windows app that embeds WebView2, loads a real episode page from the
group's actual sites, injects a script that reads `video.currentTime`, and blocks one known ad host.

**Pass:** the page plays inside the embedded window, the script can read and set `currentTime`, the ad host's
requests do not complete, and fullscreen inside the window is not broken.
**Also record:** which sites refuse to play in an embedded browser (user-agent sniffing, top-level-window checks),
and whether any of them can be coaxed with a different user agent.
**Fail case that matters:** a site that requires a real browser tab. That site becomes rescue-only (E6) or
add-on-only.

**Results (2026-11-20 — throwaway Electron/Chromium spike, since deleted): PASS on the first site tried.**

- **Site:** `animex.one` (`/watch/overgeared-212888-episode-1`).
- **The player is in a cross-origin frame** — the page is `animex.one`, the player is served from
  `plyr.animex.one`. 0 videos in the top frame, 1 in the player frame, found immediately. This is the exact case
  that is expensive with a browser add-on and free when we own the window, so it is the most useful result here.
- **Player:** 1124×632, `readyState` 4, duration 1419.96 s, paused at t=8. Fullscreen requested successfully and
  the film stayed inside our window rather than taking the whole screen — which the user liked, and which makes the
  sidebar and a cinema overlay both possible.
- **`src` is a `blob:` URL** — the player is fed in pieces (MSE). Consequence: reading `video.src` will never give
  us a stream address, so the rescue (E6) has to look at the media requests instead. Recorded under E6.
- **Ads:** 1 request cancelled with a hand-written 12-host list. Not evidence that filtering works well; evidence
  that blocking at this layer is possible. A real filter list is required (T30).
- **Not yet tested:** a second site, a site with a user-agent check, and whether an ad being blocked ever breaks a
  player. E2 is passed for *this* site, not proven in general — repeat on each site the group uses and append here.
- **Caveat that applied to the spike:** Electron is Chromium-by-another-name; the shipping app would be
  WebView2. A pass there was strong evidence, and a failure would have been retested in Edge before being
  believed.

**Extended results (2026-11-20): eleven sites, eleven playable players.**

| # | Site | Where the player lives | Plays | Seek +2 s | Fullscreen |
| --- | --- | --- | --- | --- | --- |
| 1 | `animex.one` | cross-origin frame (`plyr.animex.one`) | yes | yes | stays in our window |
| 2 | `bingebang.sx` | same page | yes — cycled servers first | yes | takes the screen |
| 3 | `cinejoy.pk` | same page | yes | yes | takes the screen |
| 4 | `movieorca.bz` → `vidfast.vc` | frame | yes — popup closed, manual play | yes | stays in our window |
| 5 | `watched.cx` | same page, **direct `.mp4` with a token** | yes — muted by default | yes | takes the screen |
| 6 | `fprime.at` | same page | yes | yes | takes the screen |
| 7 | `guts.to` → `play.vhscdn.to` | frame | yes | yes | stays in our window |
| 8 | `anichi.cz` → `megaplay.buzz` | frame | yes — manual play (autoplay blocked) | yes | stays in our window |
| 9 | `anizone.to` | same page | yes | yes | takes the screen — **subtitles missing**; a banner ad (a-ads.com) not on our list |
| 10 | `xanime.me` | same page | yes — manual play | yes | takes the screen |
| 11 | `gotaku.to` → `gotakuplay.nl` | frame | yes | yes | takes the screen |

What the eleven establish:

- **The app shape works.** 11/11 found a drivable player and 11/11 accepted a scripted seek. No site needed a real
  browser tab.
- **Cross-origin player frames are the norm, not the exception** (6 of 11). That is the single strongest argument
  for owning the window: the add-on plan would have been fighting this on day one.
- **`blob:`/MSE players are the norm** (9 of 11): a stream address is never readable from the element, which is
  recorded under E6.
- **Fullscreen is a lottery**: 7 took the screen, 4 stayed inside. Not a site bug — ours. ADR-028.
- **Ad blocking did not break a single player** (7–9 requests cancelled per site). It is also not sufficient: a
  banner from a host outside the twelve-entry list still appeared. T30.
- **One site serves a direct MP4 with a token** (watched.cx) and one page used WebRTC (the firewall prompt). The
  rescue is therefore per-site (E6) and peer-to-peer plumbing needs a notice (R35).
- **Two sites needed a manual play click** and one needed a popup dismissed. Autoplay policy, nothing to fix.
- **Subtitles can go missing** even when the site has them (anizone). Open question, recorded in
  `open-questions.md` §D — for anime this matters more than ads.
- **Still untested:** a site that refuses an embedded browser outright, and whether any player breaks specifically
  because an ad request was cancelled.

### E3 — Do the target sites expose a plain video? (decides what can be driven)

Open one real episode page on each site the group uses, in the app's window. In its devtools, filter Network for
`m3u8` and `mp4`, then in the console:

```js
[...document.querySelectorAll('video')].map(v => ({
  src: v.currentSrc, readyState: v.readyState, h: v.clientHeight, w: v.clientWidth
}))
```

**Pass:** a `<video>` with a non-empty `currentSrc` → the player can be driven.
**Also record:** how many `<video>` elements exist (ads, preloads, parked mirrors), because that is what the frame
election in spec §10.1 is for.
**Fail case that matters:** no `<video>` until play is pressed, or a canvas player with no element at all.

### E4 — Sync spike, no UI (~150 lines)

One program that serves two windows the same file, holds the room object from `spec.md §4`, and runs the correction
ladder. Then:

- `document.querySelector('video').currentTime -= 2` in one window → expect a 0.95× nudge, not a jump.
- the same with `-= 10` → expect a hard seek.
- throttle one window to "Slow 3G" → expect it to catch up without touching the other.

**Pass:** max observed `|expected - actual|` < 400 ms steady state, and no oscillation after a correction.
**Why it comes before the app shell:** this is the only part that is genuinely hard, and it can be tested without
any networking, any UI, or any website.

### E5 — How different are the mirrors, really? (decides how much of §4.5 earns its place)

Take one episode the group actually watches. Switch mirrors and record `video.duration`,
`video.videoWidth/Height`, and the page path for each; if a dub exists, record its duration too. Then check the
same three points (5, 20, 40 min) on each copy and see whether the gap is constant or growing.

**Pass:** mirrors differ by < 1 s in duration → per-viewer offset is nearly pointless; a warning badge is enough.
**Front/tail difference** → a constant offset fixes it, as designed.
**Progressive difference** → **anchor points move into v1** (`decisions.md` ADR-017).

### E6 — Can a page's stream be reused outside the browser? (gates the rescue, ADR-026)

Take a site that plays fine. With the page playing in the app's window, log the requests the player makes for
segments, then from a plain HTTP client outside the browser (same machine, no cookies) try fetching one of those
segment addresses.

**Pass:** the segment comes back without the browser's cookies or session, so the owner's app can relay it to one
stranded member.
**Likely partial:** some sites will 403 without a cookie or a matching referer. Record which treat it that way; pass
the cookie/referer through where the server has them.
**Fail case that matters:** DRM, or per-segment tokens bound to a browser. That site is rescue-impossible, and the
answer is "install the add-on" or "watch it alone".

**Note from E2 (2026-11-20):** on the first site tested the player is fed by MSE and its `video.src` is a `blob:`
address, so there is no stream address to read from the element. The rescue therefore has to take the media
requests the page makes (visible at the network layer) rather than asking the player what it is playing. Record the
request list, not the element, when running this experiment.

### E7 — Does the mesh hold? (gates M4)

Three apps on three different networks, one room, then kill the app holding authority with Task Manager.

**Pass:** nobody's picture stops, chat keeps working, a new authority appears within 2 s, a late joiner can still be
admitted by any remaining member.
**Record:** how long the transfer took, and whether any two apps failed to connect directly at all (that would be
the STUN/TURN problem returning through the back door — see `open-questions.md` §D).

### E8 — Does the add-on build and survive in both browsers? (only when M5 starts)

Load the unpacked build in Chrome and Firefox, join the same room from each, leave both idle for 15 minutes.

**Pass:** the background survives idle in both (Chrome may restart it and must reconnect invisibly), the content
script finds the video on three different sites, and the Firefox install prompt text is acceptable.
**Record:** anything the polyfill gets wrong, and whether Firefox's `<all_urls>` prompt scares a real user.

### E9 — ffmpeg seek-restart timestamps (v2 only; do not run before then)

Only matters if Modes 1–4 are built (`spec.md §7.4`). The command and the pass condition are unchanged from the
previous revision of this file, and live in research §20: the first segment's start time must be ≈ the seek point,
monotonic, with no discontinuity, or every position calculation breaks across a restart.

### E10 — Does the bridge work in WebView2? (gates M2's browser work)

E2 was a throwaway **Electron** spike; the shipping engine is WebView2 (ADR-034), and M1 never injected a script into
a page it did not serve. Re-run the part that matters, on the engine we ship, before any product code: a script added
with `AddScriptToExecuteOnDocumentCreatedAsync` must (a) run inside a **cross-origin player frame**, (b) post a message
the host receives with `e.Source` naming that frame, (c) accept a command back into that frame, and (d) read and set
that frame's `currentTime`; and (e) the request filter must still block an ad host without breaking the player.

**Pass:** all five, on a site from E2's table whose player is in a cross-origin frame (`animex.one`).
**Fail case that matters:** the frame's script cannot reach the host. Then the bridge is a different design (CDP per
frame) and M2 is re-cut rather than patched.
**Record:** the site, the WebView2 version, and the quoted lines, under **Results** here.

**Results:** **Pass**, 2026-11-21, WebView2 runtime 157, on `animex.one` (E2's site whose player sits in a
cross-origin frame):
- (a) a script added with `AddScriptToExecuteOnDocumentCreatedAsync` ran inside that frame, and (b) the host received
  its message with `e.Source` naming the frame: `site: source=https://plyr.animex.one/:t=80: count=1 w=842 h=474
  readyState=4 duration=1420.0436 t=80`, then `t=80.209911` exactly 1.000 s of host clock later - `t` advances 1:1
  with wall clock.
- (c) a command posted back into that frame landed, and (d) moved the frame's own player: `t=276.262522` at
  08:54:49.250, `spike: command posted to 1 child frame(s) and the top document for t=120` at 08:54:49.367,
  `t=120.769168` at 08:54:50.250 and `121.780072` a second later, `readyState=4` throughout.
- (e) the request filter still blocked an ad host while the player kept playing: `blocked
  https://acscdn.com/script/aclib.js`, blocked count > 0, `readyState=4`.

The raw log lines and their log file names stay in tickets 01 and 01b (the ticket files, kept locally and not published).

### The TURN experiment is dead

The old E5 ("does WebRTC need TURN for this group?") is deleted, not postponed. ADR-023 dropped WebRTC: the mesh is
plain WebSocket over an opened port, so there is no NAT negotiation to fail. If E7 shows two apps that genuinely
cannot connect, the answer is not TURN — it is "that pair cannot be in the same room", because adding TURN
reintroduces the server this architecture exists to avoid.

## Ticket list

One ticket per commit. Each has an acceptance test; do not start the next until it passes. Ticket numbers start at
T1 again as of 2026-11-16.

### M1 — A room that syncs (file mode as the test rig)

| # | Ticket | Acceptance |
| --- | --- | --- |
| T1 | App shell: window, WebView2 host, ad-filter hooks, one `npm run dev` (or equivalent) | the window opens and loads a page |
| T2 | Listener + address discovery: open a port via UPnP, learn the public address, build the invite link | E1's checks reproduce from the app itself; the link is copyable |
| T3 | Room create/join over one direct connection; `anonymous` and late naming; member list | three windows in one room, R1–R3, R26 |
| T4 | Chat: ring buffer, receipts, rate limit, system messages | R4, R5; 120 messages then a late joiner sees 100 |
| T5 | Clock sync (`ping`/`pong`, min-RTT filter), expose `authorityNow()` | measured offset stable ±20 ms on LAN |
| T6 | Position model + `state` broadcast + idempotent command handlers | R6; no double-apply in the logs |
| T7 | Drift ladder (nudge/hard seek) + 3 s reports + strikes | R8, R9 |
| T8 | Scheduled start (start in the future, all clients timer-play) | all windows start on the same beat |
| T9 | File mode: pick one file on the owner's disk, serve it with Range, check browser-safety at pick time | R11; scrubber seeks instantly; unsafe files are refused with a reason |

### M2 — Website mode (the product)

| # | Ticket | Acceptance |
| --- | --- | --- |
| T10 | Embedded browser: load a page, fullscreen, devtools off in release, keyboard focus rules | a real episode plays inside our window |
| T11 | Ad filtering on by default, with an off switch and a visible count | R20; known ad hosts never complete |
| T12 | Page following: `setPage` navigates every other app | R21 |
| T13 | Player discovery and frame election inside our browser | the right `<video>` is chosen on a page with ads and preloads |
| T14 | Report/apply commands to the page's player + echo suppression | R17; two windows stay in step through seeks and pauses |
| T15 | Per-viewer offset: "align here", ±1/±5 nudges, mismatch badge, per-source memory | a 6 s offset is set in one click and survives to next week |
| T16 | Ready gate on seek during playback | R10; nobody plays alone |

### M2b - The window uses its space

One line: runs **before M3** (the user's order, 2026-11-23) - two screens, the picture filling the window with a
380 px chat column beside it, chat below under 900 px, a remembered size; ADR-047, R39-R40, tracked as phase 5.

### M3 - Resilience and polish

| # | Ticket | Acceptance |
| --- | --- | --- |
| T17 | Reconnect/resume; buffering overlay; "waiting for 2 of 5" | a dropped connection rejoins and resyncs with no room disruption |
| T18 | Source-mismatch badges and the suggestion (ADR-021) | a member on a different mirror is flagged and can fix it in one click |
| T19 | Quit/join polish: leave notice, host-has-no-player state, blocked autoplay overlay | every §14 row that does not need the mesh is exercised by hand |

### M4 — Peer mesh and takeover

| # | Ticket | Acceptance |
| --- | --- | --- |
| T20 | Full mesh: every app connects to every app; peers exchanged after join | a room of 4 has 6 connections and no relay |
| T21 | Room replication and repair-from-authority | a late joiner gets room + chat tail from any member |
| T22 | Authority transfer: deterministic candidate, epoch bump, notice, stale-epoch rejection | R22; E7 passes |

### M5 — Add-on

| # | Ticket | Acceptance |
| --- | --- | --- |
| T23 | MV3 scaffold, popup, join by link, background connection with backoff | joins the same room as the app |
| T24 | Content script: find the video, report, apply, suppress echoes | two browser tabs on the same page stay aligned |
| T25 | Chat overlay: shadow DOM, constructed stylesheet, fullscreen re-parenting, keyboard/click isolation | R18, R19 |
| T26 | Dual-browser build: two manifests, polyfill, two artefacts | E8 passes |

### M6 — Rescue and Linux

| # | Ticket | Acceptance |
| --- | --- | --- |
| T27 | Rescue request/approve and single-member relay, fed by the page's own stream | R25; one stranded member watches while the rest stay on the site |
| T28 | Linux build | the same room joins from a Linux app |

### Cross-cutting, pick up when they block

Appended rather than inserted, so ticket numbers stay continuous (T1…T30).

| # | Ticket | Acceptance |
| --- | --- | --- |
| T29 | Cinema mode: translucent chat over the picture, fades after ~3 s idle, returns on pointer/key/new message, remembered per member | R28; demonstrated in a film-length sitting without the panel annoying anyone |
| T30 | Replace the hand-written ad host list with a real filter list that can be updated without a release | ads on the group's real sites stop appearing, and no player is broken by it (log what was blocked, one switch, per-site exception) |
| T31 | App-owned fullscreen: intercept the page's request, fill our window, wire the site's own button to it | R30; a site that used to take the screen no longer does, chat stays visible |
| T32 | Staged room changes: `setPage` with a 2 s window, Cancel, `pageCommitted` broadcast; the initiator sees their own page at once, nobody else moves | R31, R36; clicking a title and cancelling leaves the other window untouched — not even a flicker |
| T33 | Control role: owner has it, promotion UI in the roster, refusal message, grants persisted per install and restored on reconnect, control travels with authority, Take control when none is online | R33; a non-controller's pause says why, a promoted member's works, a reconnect keeps it, and an empty roster of controllers shows Take control |
| T34 | Personal-choice isolation: mirror, sub/dub, audio, subtitles, volume never broadcast | R34; two members on different dubs stay aligned and neither is switched |
| T35 | Realign triggers: player replaced, navigation finished, window focus regained | R32; a mirror switch mid-film keeps everyone's position |
| T36 | Address bar: right-click menu (cut/copy/paste/select all) and a Paste button | R29 |
| T37 | Block peer-to-peer plumbing by default: disable `RTCPeerConnection` before page scripts run, one-line notice, per-site Allow switch (remembered) | R35; the site that triggered the firewall prompt shows the notice, no firewall prompt appears, and Allow restores it |
| T38 | *Later, after the real shell exists.* Spike: load uBlock Origin Lite inside WebView2 | if it runs, decide the GPL question before adopting; if it does not, stay with T30's engine |

## How to test without five friends

- **Two app windows on one machine** — the baseline for everything.
- **Fake drift:** `currentTime += 2` / `-= 2` in the page's console; watch which correction fires (log the ladder
  decision, don't guess).
- **Fake slow client:** throttle one window. If a 3G client drags the room, the strike logic is wrong.
- **Fake clock skew:** offset `Date.now()` in one window via a dev-only flag; the formula should still land right.
- **Fake seek storm:** drag the scrubber hard; expect one broadcast, not two hundred.
- **Fake a stranded member:** block the site's hostname in one app's filter list. Rescue should be offered there and
  nowhere else.
- **Fake a host departure:** Task Manager, end the app that holds authority. Nothing on screen should stop.
- **Same machine, different networks:** a phone hotspot is the cheapest second network, and it is the only way to
  find out that two apps cannot reach each other before a friend does.

## Risks

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| A group member's connection cannot accept visitors (CGNAT) | medium | E1 before anything; that person joins rooms rather than hosting |
| A target site refuses to play in an embedded browser | medium | E2; fall back to the add-on for that site, or rescue |
| Ad filtering breaks a player it did not mean to | medium | one switch, per-site exception, and log what was blocked |
| Authority transfer loses a message or duplicates one | medium | one writer, epoch on every authority-bearing frame, replica repair never merge |
| Mesh connections fail between some pairs | medium | E7; a pair that cannot connect must be told plainly, not silently degraded |
| Sites break the player | high, recurring | generic adapter only, never per-site code in v1; expect maintenance |
| Drift ladder feels "laggy" to users | medium | Syncplay's constants are tuned; don't invent new ones; make the nudge invisible |
| Offset hides a real desync | medium | never auto-set; badge the duration mismatch; show each offset in the roster |
| Rescue turns the owner into a distributor | medium | one member only, opt-in per person, never the default, never the whole room |
| The room dies with the owner in file mode and someone expected otherwise | low | say it before the film starts; that is the only honest answer |
| Scope creep (library, transcoding, queue, phone app) | high | ADR-027 and §0; anything not in `spec.md §2` needs a new ADR |

### Measured 2026-11-23 - what a caller who knows only the address can reach

The owner asked whether the opened port endangers a participant. Measured on the owner's machine against the running
build, from the machine's own LAN address (`192.168.x.y:59820`, then two more runs on 51613 and 50927), which stands
in for a stranger's view because the server sees a non-loopback caller either way:

| Request, over the LAN address | Answer |
| --- | --- |
| `/`, `/discovery`, `/healthz`, `/join`, `/join?c=WRONG`, `/bridge.js`, `/fixture`, and `/` with a wrong `wp_key` cookie | `403` **and the gate page**: `<!doctype html>`, one code form (`id="c"`), 1162 bytes, no bundle, no version, no roster, no chat, no room code |
| `/media/<id>` with no code, and with a wrong one (0.2.1, ticket 87) | `403` **and the gate page**, no file bytes, and the media route never runs: the gate answers first. With `?c=<the real code>` the same URL answers `206` with the file's bytes (ADR-046) |
| `/join?c=<the real room code>` | `200`, the app - from an address not currently barred; `403` while it is |
| `/` on `127.0.0.1` (the owner's own window) | `200`, the app |

So a stranger who knows only the address learns that this is Watch Party (harmless) and **nothing about the room**: no
room code, no roster, no chat, no version. The room code carried in the invite link is the whole secret (ADR-044).
What remains true and not fixed here: chat is plain text to anyone on the path who has the link (ADR-023), and the
owner's own address is visible to every participant.

**Guessing has a price** (ticket 71, live on 2026-11-23: 21 calls, and the 22nd call carrying the room's real code
was still refused). A wrong code is billed against the caller, at both doors, from one shared book (ADR-044,
`docs/decisions.md:1203-1208`): five refused joins close a socket; twenty refused joins from one address inside 60 s
bar that address for 60 s, and a barred address is refused for the whole minute even when it then presents the real
code; one ASCII `[gate]` line in the sidecar's output records the bar. A visit that presents no code is never counted.
So the `/join?c=<the real room code>` row above holds for an address that is not barred: a reader who repeats this
crawl by trying the wrong code twenty times first will then see the real code refused too, and that is the bar
working, not this record being wrong.

To repeat it: `npm run dev:debug`, read `sidecar: PORT <n>` from `logs/host-*.log`, then **read the body of a 4xx** -
`curl.exe -i http://<this machine's LAN address>:<port>/`. `Invoke-WebRequest` throws on 4xx and a `catch` that prints
only the status sees no page at all.

> **Corrected 2026-11-23 (review of phase 4):** the first version of this section said the unauthorised answer was
> `403` with *no page*, and read a deviation from ADR-044 out of it. Both were wrong: the instrument never read a 403
> body. The build serves the gate page ADR-044 asks for. Ticket 70 was filed on that false premise and is withdrawn.

## v1 is done when

- Two people in different houses watch a streaming page for an hour and the gap never becomes audible.
- One of them adds a 5 s mirror offset in one click and never touches it again.
- A third person joins 20 minutes in from a plain link and lands within half a second.
- The person who started the room closes their app mid-film: nobody's picture stops, chat keeps working, and the
  room has a new host inside 2 s.
- Type "ar" into the chat while the film is playing and nothing pauses.
- Watching your own file works with two machines on one wifi, and the app says plainly that it will not work across
  the ocean.
- Nothing was paid for, and nobody signed up for anything.

## Don't

- Don't add a paid tunnel, a rented server, a meeting service, or an account (ADR-023).
- Don't put peer-to-peer *video* in v1 (ADR-014) — the mesh carries messages, not pictures.
- Don't add a resolver or downloader (ADR-007). The rescue reuses what the page already plays; it does not hunt.
- Don't sync a cross-origin iframe we don't control (ADR-006).
- Don't store the page address with its query string (spec §10.3).
- Don't let a member's position report mutate room state (invariant 1).
- Don't correct drift on a single bad sample, or more than once per 5 s per client.
- Don't let two apps write room state; authority is one writer, and the epoch is how it stays one (ADR-024).
- Don't broadcast a personal choice — mirror, sub/dub, audio, subtitles, volume (ADR-030, invariant 10).
- Don't hand fullscreen back to the page, however loudly a site asks (ADR-028).
- Don't let a player tell us where it is on load; command it, never read it (ADR-029, invariant 9).
- Don't ship per-site adapters before the generic one is boringly reliable.

## Next session: how to brief the work

- Read `open-questions.md` first and settle §A; those items change the architecture, not the tickets.
- Give an implementer one ticket at a time, with the acceptance line pasted in verbatim.
- Reference ADRs by number when a choice comes up ("ADR-024 says one writer, ever").
- If a ticket needs a new dependency, that is an ADR, not a decision made in the diff.
