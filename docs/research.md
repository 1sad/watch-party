# Group-watching app — feasibility research

Scope: a small self-hosted "watch together" app. Name-only join, room code/link, synced playback with heartbeat,
a chat box, and (separately) syncing third-party web players.

Verdict up front: **the app you described is a weekend-to-two-week build, and almost none of the hard parts are
video streaming.** The hard parts are (1) a shared clock, (2) deciding when to nudge vs. hard-seek, and (3) the
web-link case, which is not a streaming problem at all — it is a browser-extension problem.

---

## 1. What actually has to be built

| Part | Difficulty | Real work |
| --- | --- | --- |
| Name-only join, room codes, invite links | trivial | a map and a cookie |
| Video to a webpage | low | HTTP Range serving, or one offline transcode per file |
| Chat | trivial | the same WebSocket as sync, 100-message ring buffer |
| **Synced playback with heartbeat** | **medium** | clock offset estimation, drift thresholds, rate-nudge, echo suppression |
| **Syncing arbitrary third-party sites** | **high** | browser extension, frame discovery, per-site adapters, and it will break periodically |

If web-link sync were dropped, this is a 3–5 day project. With it, plan 2–4 weeks for "works on a handful of
sites", and accept that "works on every site" is a maintenance treadmill, not a finish line.

**Part 2** (§10 onward) covers the follow-ups: the media-server/plugin route, the AnimeX repo, sizing for 5
viewers with an upload-speed-based quality picker, one-transcode-for-everyone, subtitles and multiple audio
languages, the "pull from a streaming site" option, and why Metastream was buggy.

---

## 2. Reference projects: what to take, and under what licence

All of these are live and actively pushed (2026). Licences matter: if you copy code from an AGPL project and
host it as a service, you must publish your source.

| Project | Licence | What it is | What to take from it |
| --- | --- | --- | --- |
| **Syncplay** (~2.7k★, Python) | Apache-2.0 | Desktop sync for mpv/VLC/MPC over a JSON-over-TCP protocol | **The best-tuned sync numbers anywhere in open source.** `syncplay/constants.py` has the actual thresholds; `client.py::_slowDownToCoverTimeDifference` is the rate-nudge implementation; `client.py::_userOffset` is a **per-viewer offset** applied on both the report and the apply side — the precedent for different mirrors and sub/dub runtimes. Protocol is documented at syncplay.pl/about/protocol |
| **Jellyfin SyncPlay** (~59k★, C#) | GPL-2.0 | SyncPlay built into the media server | **The state machine**, not the code. `GroupStates/Playing|Paused|Waiting|Idle` plus scheduled start via `LastActivity = UtcNow + max(highestPing*2, defaultPing)`. GPL + C# + you'd inherit a media server, so read, don't vendor |
| **OpenTogetherTube** (~580★, TS) | AGPL-3.0 | Web rooms for YouTube/Vimeo/direct/HLS | The minimal position model: server holds `{playbackPosition, isPlaying}` and clients compute `offset + (now - start)*speed`. `common/timestamp.ts` is 6 lines. Client correction: `if (|expected - actual| > 1) setPosition()` |
| **WatchParty** (~1.3k★, TS, MIT) | MIT | Web rooms + screen share + WebTorrent + WebCodecs | `server/room.ts::setTimestamp` — per-client timestamp map normalized for emit latency, "only accept increasing timestamps so one lagging viewer can't hold the room back". Closest permissive licence for web-player logic |
| **KoalaSync** (MIT, 2026) | MIT | **Browser extension + relay** that syncs any `<video>` on any site | The whole web-link design: canonical media state, two-phase force sync, `expectedEvents` echo suppression, cross-origin frame targeting. `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`, `docs/KNOWN_LIMITATIONS.md` |
| **emby-watchparty** (MIT, 2026) | MIT | FastAPI+Vue party frontend that proxies an Emby/Jellyfin server | **Drift heartbeat** (`socket_handlers/drift.py`) and **seek-during-playback handshake** (`force_pause_before_seek` → ready check → resume). Also the "host has an account, guests don't" trick — exactly your name-only requirement |
| **CyTube** (~1.6k★, JS) | — | Old-school sync rooms, playlists, chat | Playlist/chat moderation ideas if you ever add a queue |

**On "could Jellyfin source help?"** For *design*, yes — its SyncPlay state machine and its latency-accounted
scheduled start are the two ideas worth stealing. For *code*, no: GPL-2.0, C#, and it is a media server. If you
already run Jellyfin, the sane move is to run `jellyfin` + its built-in SyncPlay, or `emby-watchparty` in front of
it, and not write anything. Jellyfin's blocker for your use case is that **every viewer needs an account**;
that is why `emby-watchparty` exists.

---

## 3. Recommended architecture

### 3.1 Shape

```
        ┌──────────────────────────────────────────────┐
        │  one container: Node/TS (or Go)              │
        │                                              │
        │  GET  /            -> SPA (join, room, chat)  │
        │  GET  /media/:id   -> file w/ HTTP Range      │
        │  WS   /ws          -> room state, chat, heartbeats
        │                                              │
        │  in-memory rooms:  sessions are ephemeral     │
        │  SQLite (optional) -> media index only        │
        └──────────────────────────────────────────────┘
                    ▲                    ▲
             browser (file)      browser + extension (web links)
```

No Redis, no accounts, no database for rooms. A room is a JS object with a 6-hour TTL. That is what makes it
"easy to set up": `docker run -p 8080:8080 -v ./media:/media thing`, plus Caddy in front for TLS.

### 3.2 The position model (steal this exactly)

Server stores one canonical state per room:

```ts
type Room = {
  media: { id: string; title: string; duration: number } | null;
  playing: boolean;
  position: number;       // seconds, at `updatedAt`
  updatedAt: number;      // server epoch ms
  rate: number;           // 1.0 normally
  revision: number;       // monotonically increasing; clients ignore stale
  host: string;
  members: Map<string, { name: string; driftStrikes: number; rtt: number }>;
};
```

Every client derives what it *should* be showing, rather than being told "seek now":

```ts
const expected = room.playing
  ? room.position + (serverNow() - room.updatedAt) / 1000
  : room.position;
```

That one formula is the whole trick. It means a late joiner, a client that stalled for 3 seconds, or a dropped
message all self-correct without extra messages. It is what OTR's `calculateCurrentPosition` does, and what
KoalaSync's canonical media state does.

`serverNow()` is the client's clock corrected by measured offset — see §4.

### 3.3 Message set (deliberately tiny)

```
c→s  join      {room, name}
s→c  welcome   {selfId, room, members[], chatTail[]}
c→s  play      {position}          s→c  play      {position, updatedAt, by, revision}
c→s  pause     {position}          s→c  pause     {position, updatedAt, by, revision}
c→s  seek      {position, wasPlaying}  s→c  seek  {position, updatedAt, by, revision, waitForReady?}
c→s  heartbeat {position, readyState}  s→c  nudge  {target, rate}      // to one client only
s→c  ready     {waiting[], ready[]}                                // seek-during-playback gate
c→s  readyAck  {}
c→s  chat      {text}              s→c  chat      {by, text, ts}
s→c  members   {…}
```

Note the asymmetry: **commands broadcast to everyone including the sender**, and the sender's handler is written
to be idempotent (already playing → `play()` is a no-op; position within 0.3 s → don't re-seek). This avoids the
"local fire + broadcast fire" duplicate-chat-message bug that emby-watchparty explicitly documents fixing.

### 3.4 Drift correction: the ladder

Do not seek on every heartbeat. Seek only when the gap is bigger than a human would notice as a glitch:

| Gap | Action | Why |
| --- | --- | --- |
| < 0.1 s | nothing | below perception |
| 0.1 – 1.5 s | set `playbackRate` to 0.95 (or 1.05) until gap < 0.1 s | inaudible, no visual jump |
| 1.5 – 4 s | rate nudge, or seek if paused | Syncplay's `DEFAULT_SLOWDOWN_KICKIN_THRESHOLD` |
| > 4–5 s | hard `currentTime = expected` | Syncplay's `DEFAULT_REWIND_THRESHOLD` / `DEFAULT_FASTFORWARD_THRESHOLD` |

Concrete numbers from Syncplay's `constants.py`, which are the product of years of real complaints:

```
SEEK_THRESHOLD                    = 1      # ignore smaller diffs on incoming state
SLOWDOWN_RATE                     = 0.95   # play at 95% to bleed off drift
DEFAULT_SLOWDOWN_KICKIN_THRESHOLD = 1.5
SLOWDOWN_RESET_THRESHOLD          = 0.1    # restore 1.0 once this close
DEFAULT_REWIND_THRESHOLD          = 4
DEFAULT_FASTFORWARD_THRESHOLD     = 5
FASTFORWARD_BEHIND_THRESHOLD      = 1.75
PROTOCOL_TIMEOUT                  = 12.5   # no ping in this long = drop the client
PING_MOVING_AVERAGE_WEIGHT        = 0.85   # smoothed RTT
AUTOPLAY_DELAY                    = 3.0    # scheduled start, seconds
```

Compare the looser settings elsewhere: OTR hard-seeks at >1 s; KoalaSync tolerates 2 s; emby-watchparty uses a
3 s threshold with 2 consecutive strikes before correcting. Those are all "good enough" values for a browser
where you cannot control the decoder. Pick 1.5 s / 4 s and you are in the well-tested zone.

`playbackRate` is safe for nudging: pitch is corrected by default (`preservesPitch`), and Gecko only mutes audio
outside 0.25–4.0, so 0.95 or 1.05 is inaudible (MDN).

---

## 4. Clock sync (the "heartbeat checking" part)

There are two separate loops, and conflating them is the most common design mistake.

**(a) Clock offset** — so "position at time T" means the same T for everyone. NTP-style, and cheap:

```
client sends  {t0: localNow}
server replies {t0, t1: serverRecv, t2: serverSend}
client at t3:
  rtt    = (t3 - t0) - (t2 - t1)
  offset = ((t1 - t0) + (t2 - t3)) / 2
```

Keep an exponentially weighted average of `offset`, weighted toward samples with the **smallest RTT** (the
min-RTT filter NTP uses; it rejects the samples that were queued behind a big packet). Jellyfin exposes exactly
this as `GET /SyncPlay/...` returning `UtcTimeResponse {requestReceptionTime, responseTransmissionTime}` — the
two-timestamp form exists precisely so the client can subtract server-side processing time.

One detail: use `performance.now()` for intervals and `Date.now()` only to anchor. Browser wall clocks jump.

**(b) Playback drift** — each client reports its actual `currentTime` every 3–5 s while playing. The server
computes `drift = |reported - expected|` and, if it exceeds threshold twice in a row, sends a targeted
correction to that client only. That is `drift.py` in emby-watchparty, ~40 lines.

Why "twice in a row": a single bad sample is usually a buffering stutter, and correcting it makes things worse.

**Scheduled start beats instant start.** When unpausing or resuming after a seek, don't say "play now" — say
"at server time X, position is P". Jellyfin does `LastActivity = UtcNow + max(highestPing*2, defaultPing)` so
even the slowest client receives the command before the start instant. Syncplay calls the same idea
`AUTOPLAY_DELAY = 3.0`. Without it, everyone starts when their own packet lands and you are 200–800 ms apart
before playback even begins.

---

## 5. Getting video to a webpage

Five options, ordered by how much you should want them.

**1. Direct file + HTTP Range (recommended for v1).** `<video src="/media/abc.mp4">`. The browser does its own
seeking and buffering via `Range: bytes=…` / `206 Partial Content` (MDN). No transcoding, no CPU, no HLS. Works
if the file is H.264 + AAC in MP4 with the `moov` atom at the front (`ffmpeg -movflags +faststart`). Express
`static`, Caddy `file_server`, and Go's `http.ServeFile` all do ranges correctly out of the box.

The only real constraint: browsers do not decode MKV/AC3/DTS reliably, and HEVC is patchy. So:

**2. One offline transcode per file (recommended companion to #1).** When a file is added, if it isn't
browser-safe, produce a streaming copy once (`-c:v libx264 -crf 21 -preset veryfast -c:a aac -movflags
+faststart`). Do it at import, not at play time. This keeps the server CPU at zero during movie night, which is
what "works well" actually means at 9 pm with five people watching.

**3. HLS + hls.js.** Needed only for per-viewer quality adaptation or for live. hls.js "relies on HTML5 video and
MediaSource Extensions", and uses Managed Media Source where MSE is absent (Safari iOS 17.1+). Caveat learned the
hard way by emby-watchparty: if the server stream-copies a VBR file, HLS segments lie about their duration and
seeking breaks; segment boundaries must land on keyframes, so either force keyframes at segment length
(`-force_key_frames` + `-hls_time`) or re-encode. This is a rabbit hole; skip it until you need it.

**4. Client-side transcode with WebCodecs** (what WatchParty does for "browser can't play this"). Chrome-only-ish,
costs the viewer's CPU, and you still need to serve the original bytes. Interesting, not required.

**5. WebTorrent / P2P.** Offloads bandwidth, but adds trackers, NAT issues, and a whole new failure surface.
Only worth it if server upload is your bottleneck.

Bandwidth arithmetic for the simple path: server upload = file bitrate × viewers. A 4 Mbit/s copy × 5 people =
20 Mbit/s. On a home connection that is the actual limiting factor, and it argues for the offline
1080p-at-moderate-bitrate copy rather than the 25 Mbit/s remux.

---

## 6. Syncing web links (unofficial streaming sites)

This is where the project either stays small or becomes a browser extension.

### 6.1 Why a web app cannot do it

Your page cannot touch a video inside a cross-origin iframe — that is the same-origin policy. So
`myapp.com/watch?url=someanime.site/ep/12` is not implementable in the general case. You have exactly three
options:

**A. Browser extension (this is what everyone does).** Content script injected into the page finds the `<video>`,
listens to `play/pause/seeked`, reports to your relay, and applies remote commands. Host permissions are
`<all_urls>` and `all_frames: true` so it also reaches nested players. This is Teleparty, KoalaSync, and
WatchParty's approach. It is the only one that works without re-hosting content.

Reality check from KoalaSync's own bug documentation: on `yummyanime.tv` with the Kodik mirror, the player sits
at **depth 2**, behind a same-origin wrapper, inside a cross-origin iframe that has **no `<video>` until playback
starts**, and the frame **re-navigates after load** (invalidating `documentId`). Unselected mirrors stay in the
DOM at 0×0. Whole documents exist about frame election because of this. Their tested-services list shows full
support for YouTube, Twitch, Emby, Jellyfin, Vix, Google Drive, Crunchyroll, JkAnime, Prime, Disney+ — and
"not tested" for a dozen others.

**B. Proxy the page through your server and inject your script.** Breaks on CSP, signed URLs, referrer checks,
relative asset paths, and turns you into a re-hoster of content you don't own. Not worth it.

**C. Stream someone's tab over WebRTC** (`getDisplayMedia` + your own SFU, or Neko for a shared remote browser).
Always works visually, needs no per-site logic, but: tab audio capture is Chromium-only, quality drops, you pay
upload bandwidth for video, and nobody can seek independently. WatchParty ships this as a fallback and it is
genuinely useful for "the site is hopeless" cases.

### 6.2 Minimum viable extension

```
extension/
  manifest.json      MV3, host_permissions ["<all_urls>"],
                     content_scripts: [{ all_frames: true, match_about_blank: true }]
  content.js         find <video> (incl. shadow DOM), report + apply, suppress echoes
  frame-target.js    pick which frame's <video> is the real player
  background.js      holds the WebSocket, dedupes, routes by frame
  popup.html/js      name, room code, join/leave
```

Three details that separate a demo from something usable:

1. **Echo suppression.** Keep a Set of `expectedEvents` with a timeout. When you programmatically `play()`, the
   element fires `play`; without suppression that bounces back to the server and ping-pongs forever. KoalaSync
   does exactly this, and expires entries by timeout.
2. **Frame election.** Several `<video>` and several frames will exist (ads, hidden preloads, parked mirrors).
   Pick by: visible size, `readyState`, playing, has `src`, not muted-and-0×0. Keep the choice sticky; re-elect
   only when the current one dies.
3. **Two-phase force sync for seeks during playback.** Seeks make everyone buffer, and whoever finishes first
   plays on alone. So: initiator broadcasts `prepare{target}` → everyone seeks while paused, waits for
   `readyState >= 3`, acks → initiator (or server) broadcasts `execute` → everyone plays. Give the ack window
   ~8 s, and always make the coordinator's timeout longer than the worker's (KoalaSync learned this the hard way:
   equal timeouts race).

### 6.3 Honest expectations

- Sites with a plain `<video>` (most unofficial anime/movie hosts): works, with occasional breakage when the host
  changes its player.
- Sites with a custom player over canvas, DRM (Widevine/PlayReady), or an Apple TV+-style player that fights
  `video.play()`: needs a per-site adapter, or does not work.
- You will be re-testing sites forever. Keep the adapter layer thin and the fallback ("just seek to what the
  server says") always present.

---

## 7. MVP scope and build order

**Phase 1 — self-hosted files (3–5 days).**
Room create/join by code, name only, chat, file serve with Range, position model, clock offset, drift ladder,
scheduled start. One Dockerfile + `docker-compose.yml` with Caddy for automatic TLS. Done correctly, this is
genuinely pleasant to use and needs zero maintenance.

**Phase 2 — heartbeats and polish (2 days).** `ready` gate on join ("Buffering… 2/5 ready"), buffering overlay,
auto-pause-if-everyone-stalled, host reassignment when the host leaves, kick, chat rate limit.

**Phase 3 — extension (1–2 weeks).** The relay is the *same server*; the extension is just another client type.
Ship with a generic `<video>` adapter and no site-specific code. Add adapters only for sites you actually use.

**Phase 4 — only if needed.** HLS/adaptive quality, subtitles, playlist, WebTorrent.

**Stack:** Node + TypeScript (`ws` or Socket.IO, Vite + Svelte/React, `hls.js` if and when). Chosen because all
four reference implementations are TS/JS, so patterns and the extension examples translate directly. Go is the
better answer if you want one static binary and no `node_modules`, but you'd be re-deriving the sync code.

---

## 8. Pitfalls checklist

- **Autoplay.** `play()` without a user gesture rejects with `NotAllowedError` (Chrome policy: muted always
  allowed; sound needs interaction, MEI, or PWA install). So the join screen must have a real button — that click
  is your gesture. Never assume play succeeded; check the promise.
- **iOS Safari.** Needs `playsinline`; backgrounded tabs throttle timers and can suspend the socket; no
  `getDisplayMedia`. Test on an actual iPhone early.
- **Seek storms.** User drags the scrubber → 200 `seeked` events. Debounce (~150 ms) before broadcasting, and
  ignore programmatic seeks.
- **Echo loops.** Commands you apply locally must not be reported as user actions. See §6.2.
- **One laggard holding the room.** Only accept monotonically increasing timestamps from clients (WatchParty's
  rule), and never let a client's report set the canonical state — only commands do.
- **Late joiners mid-movie.** They must buffer before the timeline matters. Show "starting at 41:12" and gate on
  `readyState`.
- **`currentTime` is not frame-accurate.** Setting it lands on a keyframe in some decoders. Expect ±1 frame,
  which is 40 ms — fine, and another reason not to chase sub-100 ms.
- **Chat needs sanitising** and a length/size cap even among friends, or one pasted 4 MB string kills the room.
- **Timezones/clock jumps.** Anchor on `performance.now()`, re-measure offset on reconnect.
- **Don't persist rooms.** In-memory + TTL, like KoalaSync: "zero-persistence, in-memory message bus". It removes
  a database, migrations, and a whole class of privacy questions.
- **Name collisions and impostors.** Deduplicate names, disconnect the older socket for the same identity
  (KoalaSync's "ghost peer" fix). Don't build auth to solve trolling in a room of invited friends — kick and move
  on.

---

## 9. Legal note (factual, not a lecture)

Serving *your own* video files to *your invited friends* is ordinary self-hosting. Syncing a page that each person
already opened in their own browser is closer to what a browser does natively — that is why the whole category
(Teleparty, KoalaSync, WatchParty) ships as extensions with no server-side content.

What changes the picture is **re-hosting**: proxying or caching someone else's stream through your server, or
running a scraper/indexer. That is the line to stay behind, and it is also the line that makes architecture
option B in §6.1 a bad idea for reasons more practical than legal. Don't build the aggregator; build the sync
layer.

---

## 10. The media-server route (Emby / Jellyfin) and whether a plugin is the answer

Yes, researched properly — `emby-watchparty` was read at source level, not just its README.

### 10.1 It is three different things, with different answers

**A. Jellyfin's own SyncPlay.** Built into the server since 10.6 — there is no official plugin needed, which is
why the old `jellyfin-plugin-syncplay` repo is gone. A community drop-in replacement exists
(`kontell/jellyfin-plugin-syncplayv2`, installable from the plugin catalog) for people unhappy with the built-in
behaviour.

Blockers for *your* requirement: every viewer needs a Jellyfin account on your server, and the sync quality is
whatever the individual client app does. Both are deal-breakers for "type a name and you're in".

**B. `emby-watchparty` in front of your existing server** (MIT). This is the closest existing thing to your spec.
What it actually does:

- FastAPI backend holds the *host's* Emby/Jellyfin token and proxies HLS. Guests are pure spectators with no
  media-server account — "any member with an account on the configured server can become the room's host; other
  viewers join as spectators without a media-server account".
- Socket.IO for `play`/`pause`/`seek`/`heartbeat`, plus a `force_pause_before_seek` → ready-check → resume
  handshake so a seek during playback doesn't leave whoever buffered first playing alone.
- Drift heartbeat (`socket_handlers/drift.py`): expected position = `state.time + elapsed since last update`;
  if a client is off by more than **3 s on two consecutive beats**, it gets a targeted `drift_correction`.
- It exists because of a document literally titled *"Emby quirks we learned the hard way"*, covering
  `EnableAutoStreamCopy=false` being the real "force a re-encode" flag, `EnableDirectPlay=false` being advisory
  only, HLS segments lying about duration on VBR stream-copies, and Emby restarting ffmpeg on every seek while
  hls.js does not.

Assessment: **if you already run Emby/Jellyfin, try this before writing anything.** It fits your "host has the
library, guests just join" shape. Weak points: 3 s drift tolerance is loose by Syncplay standards (you'd hear
that as an echo of yourself), and it is a single-maintainer project whose whole existence is fighting another
product's HLS pipeline.

**C. Write your own thin frontend against the Jellyfin API.** Same idea as B, your code, your UX. Most work, most
control. Only worth it if B's UX is wrong for you.

### 10.2 Plugin verdict

There are two kinds of "plugin" and only one of them helps:

- **Media-server plugin** (C#/Python inside Jellyfin): cannot give you accountless guests, because the auth model
  is the server's. You'd be fighting the host application. Also you'd be maintaining C# against a fast-moving
  server. Don't.
- **Browser extension**: this *is* the plugin that solves your web-link requirement (§6), and it also works on a
  Jellyfin/Emby/Plex page if you'd rather sync the existing player than build a new one. That is the version of
  "a plugin wouldn't be bad" that actually pays off.

## 11. `arindhimar/VideoStreamingPlatform` — checked, it does not have group watch

Fetched the repo and walked the file tree. It is **AnimeX**, 4 stars, last pushed November 2024: Flask backend,
FFmpeg conversion + HLS segmentation, background upload queue, MySQL, React + Tailwind admin dashboard, ImgBB for
images. Endpoints are anime/episode/genre CRUD plus `/stream/<anime>/<ep>/index.m3u8` and segment serving.

Searching the whole tree for `sync|party|socket|room|watch|chat|live` returns **zero files**. There is no
WebSocket layer, no room concept, no chat. So it is not the app with group watch, and it is not a starting point
for one — it is an upload-and-stream site.

What it *is* useful for: a worked example of the `upload → ffmpeg → HLS segments → m3u8` pipeline, if you decide
you want HLS rather than direct file serving. Note it segments to files on disk, which is the right call for VOD
and the wrong call for live.

One caution: an "anime streaming platform" with an admin upload panel is, structurally, a re-uploading site. The
code is fine to learn from; the product shape is the thing §16 argues against.

## 12. Sizing for 5 viewers, and the upload-speed → quality calculator

### 12.1 The formula

Only the **server's upload** matters, and it is divided by the number of simultaneous viewers:

```
budget_kbps   = measured_uplink_kbps × 0.8        // 20% headroom for retransmits, bursts, chat
per_viewer    = budget_kbps / viewers
pick          = highest ladder rung whose bitrate ≤ per_viewer
```

Measuring it without asking the host to type a number: have each joining browser download a 3–5 MB test payload
from the server, discard the first ~10% (TCP ramp-up), and average the rest. Every client is pulling the same
bytes from the same box, so **min(download speed across clients) ≈ the server's effective uplink**. Show it in
the join screen ("measured 23 Mbit/s → 5 viewers → 720p") and let the host override. `navigator.connection` is
not a substitute — it reports downlink coarsely and says nothing about your uplink.

### 12.2 The ladder (Apple's own H.264 variants, `AVERAGE-BANDWIDTH` kb/s)

Apple's HLS authoring spec is the most defensible ladder to copy, because it is tuned for real devices:

| 16:9 | H.264 kbit/s | | 16:9 | H.264 kbit/s |
| --- | --- | --- | --- | --- |
| 416×234 | 145 | | 960×540 | 2000 |
| 640×360 | 365 | | 1280×720 | 3000 |
| 768×432 | 730 | | 1280×720 | 4500 |
| 768×432 | 1100 | | 1920×1080 | 6000 |
| | | | 1920×1080 | 7800 |

The same document also fixes two things people get wrong: **keyframes every 2 seconds** (1.13) and **6-second
target segment duration** (7.5).

### 12.3 What 5 viewers actually gets you

| Server upload | Budget (80%) | Per viewer | Sensible pick |
| --- | --- | --- | --- |
| 10 Mbit/s | 8.0 | 1.6 | 768×432 @ 1100 (call it 432p) |
| 20 Mbit/s | 16.0 | 3.2 | 1280×720 @ 3000 |
| 25 Mbit/s | 20.0 | 4.0 | 1280×720 @ 3000 (4500 is just over) |
| 50 Mbit/s | 40.0 | 8.0 | 1920×1080 @ 7800 |
| 100 Mbit/s | 80.0 | 16.0 | 1080p @ 7800 and still idle |

So for a typical home connection and 5 people: **720p is the realistic target, 1080p needs ~50 Mbit/s up.**
That is the whole argument for pre-encoding instead of streaming the remux.

### 12.4 "Same transcode for everyone" is the right call — and it has one consequence

Agreed, and it is simpler than adaptive: one video rendition, one bitrate, everyone pulls identical bytes, so the
server and any cache in front of it do no work per viewer. The consequence is that **the weakest link sets the
quality for the whole room**, which for 5 friends is a fine trade.

Implementation note: transcode **once at the chosen rung when the host adds the file**, not per session. Store the
result (`<id>.1080p.mp4`), and reuse it for every later movie night. Live per-session transcoding is what turns a
"works well" project into a space heater.

If you ever want the cheap version of adaptive: keep two rungs (the picked one and one half-size) and serve the
smaller one only to clients that report `readyState` stalls. That is 10 lines of logic versus a full HLS ladder.

## 13. Subtitles — the easy half

Subtitles are per-viewer and **never affect sync**. Text subtitles are a solved problem:

- Convert to WebVTT at import: `ffmpeg -i in.mkv -map 0:s:0 -c:s webvtt out.en.vtt`.
- Serve them as sidecar files and put several `<track kind="subtitles">` elements in the player. Each viewer picks
  their own language, or none. No coordination with the room at all.
- If you go HLS later, Apple requires WebVTT specifically (5.2) with `X-TIMESTAMP-MAP` (5.3), and a subtitle
  playlist covering the whole runtime (5.5).

Three real-world caveats:

1. **ASS/SSA subtitles** (what most anime releases and many movie rips use) carry positioning, fonts, signs and
   typesetting. Converting to VTT keeps the words and throws away the styling — readable, but visibly worse. If
   that matters, render the real `.ass` in the browser with **JASSUB** (MIT, WASM libass, actively maintained) as
   an overlay on the video. Cost: ~a few hundred KB of WASM and a font set, no server work.
2. **Image-based subtitles** (PGS from Blu-ray, VobSub) cannot become text. Either burn them into the video (kills
   per-viewer choice) or OCR them. Decide per file; don't promise it generally.
3. **Forced / signs-only tracks** need to exist as a separate selectable track and be auto-selected, otherwise
   foreign-language dialogue in an English viewing is untranslated.

## 14. Multiple audio languages — the hard half, and why it forces HLS

This is the one requirement that changes the architecture, and it is worth knowing why.

**In a plain MP4, you cannot reliably switch audio language from JavaScript.** The API that would do it,
`HTMLMediaElement.audioTracks`, is marked **"Limited availability … not Baseline because it does not work in some
of the most widely-used browsers"** (MDN). So "one .mp4 with 3 audio tracks, pick yours" is not a viable design.

Two workable options:

| Option | Cost | Switching mid-film | Verdict |
| --- | --- | --- | --- |
| Separate complete file per language | 2–3× storage, 2–3× encode | reload = re-buffer = resync | only if you rarely switch |
| One video + N audio renditions (HLS `EXT-X-MEDIA`) | ~64–160 kbit/s per language | seamless | **recommended** |

Apple is explicit that alternate audio *must* be separate streams (9.7: "If you have alternative audio content
(languages/commentary/DVS), you MUST use separate audio streams"), and hls.js supports alternate audio renditions
for VOD and live. So:

```
# v.m3u8
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Japanese",LANGUAGE="ja",DEFAULT=YES,URI="ja.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="en",URI="en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=3200000,RESOLUTION=1280x720,AUDIO="aac"
720p.m3u8
```

Key point for your "same transcode for everyone" rule: **it survives.** The *video* is one shared rendition; only
the audio is duplicated per language. Everyone still downloads the same video bytes; the audio track choice is a
per-user setting that costs one extra ~128 kbit/s stream. That is the answer to "can I have both" — yes.

Practical gotchas:

- All renditions must be segment-aligned (same segment boundaries) or switching desyncs.
- Switching languages may cause a 1–2 s re-buffer in some players. Handle it as a room event: the switcher reports
  "switching audio", the room pauses for one second, everyone resumes on the scheduled-start rule (§4).
- Detect the source's audio languages at import (`ffprobe -show_streams`), list them in the room UI, and let each
  viewer choose. Never let the audio *choice* affect the canonical playback state — only play/pause/seek do.
- If a file has only one language, do nothing special; skip the whole HLS path and direct-play it.

Reality check on effort: subtitles as sidecars are a few hours. Multi-language audio is the reason to adopt HLS,
which drags in the keyframe/segment-duration discipline from §5 and the Emby-quirks class of problems. **Ship
single-audio + sidecar subtitles first**; add audio renditions when a real file needs it.

### Runtime differences between cuts

Observed in the wild: a dub that opens with a 5 s studio logo the original lacks. Three shapes, and only two of
them are fixable with one number:

| Difference | Fixable by a constant offset? |
| --- | --- |
| Extra content at the start (logo, "previously on", new OP) | yes — offset = the delta, applied to that viewer |
| Extra content at the end (longer ED, credits, next-episode preview) | yes, but offset = 0; you tolerate the tail diverging |
| A genuinely different edit (scenes trimmed, recap inserted mid-episode) | no — needs more than one anchor point |

The important consequence: **duration delta tells you the copies differ, but not which of the three you're in.**
Only observation does — if a viewer's position difference is constant from the first minute, it is padding; if it
grows, it is a different edit.

## 15. Option three: host pulls the video from a streaming site

Technically this is a well-trodden path: `yt-dlp` or `streamlink` resolves a page to a direct media URL or an
`.m3u8`, then you either download+remux it or proxy the HLS through your server. It only works on non-DRM hosts —
`yt-dlp` does not and will not decrypt DRM — which happens to be exactly the "unofficial site" category.

Two variants that look similar and are not:

**(a) Resolve, then re-serve from disk.** Host pastes a link, the server downloads/remuxes once, the file joins the
library, and playback is the normal path. Robust playback, works with all the sync machinery unchanged, no expiring
URLs. Cost: you are now storing and serving a copy, and the copy step is slow and fragile (signed URLs, referer
checks, cookies, ad segments spliced into the stream, per-episode playlists).

**(b) Live proxy the m3u8.** No copy on disk, but segment URLs expire in minutes, some hosts encrypt segments with
per-session keys, and every playlist refresh is a chance to break mid-film. You inherit someone else's CDN
behaviour as your uptime dependency.

Both put your box in the position of distributing someone else's stream to other people, which is the line
described in §9 — and unlike the extension approach, it is the *server* doing it. That is also the difference
between "a tool my friends use" and "a service that attracts attention".

My recommendation: implement **(a) as a manual, local-file workflow**. If the host obtains a file by whatever
means, the app plays it, synced, with subtitles. Do not ship a built-in resolver, and do not ship the proxy — the
first is a legal liability, the second is a reliability liability that will also be a legal one.

## 16. Why Metastream was buggy — a post-mortem worth reading before you build

Facts: `samuelmaddock/metastream`, 2.6k stars. **As of August 2024 it discontinued publishing under open source
and stopped accepting contributions**; the last open-source version (v0.10.4) lives on an `archive` branch. 182
open issues. It shipped as an Electron app plus browser extension, with WebRTC P2P sessions, a collaborative
queue, timestamp cue points, per-user playback permissions, and chat.

The bugginess is structural, not bad luck:

1. **It synced pages, not media.** Every site redesign, player swap, or new anti-automation measure is a bug in
   your product. KoalaSync's docs show the same tax being paid today, with whole documents about frame election.
2. **Electron wrapper.** You are shipping and updating a browser to five people. Every Chromium change becomes
   your release.
3. **P2P (WebRTC).** No server to be authoritative, so sync correctness depends on every peer's NAT, CPU, and
   tab state, and "who is right?" has no answer.
4. **Scope.** Queue, cue points, permissions, chat, host tools — each one a surface to break, none of them the
   thing you asked for.

What to keep from it: the UX idea of "paste a link, get a room". What to avoid: everything else on that list.
Your version should be server-authoritative (§3.2), one authoritative clock, no P2P, no Electron, and no
per-site code at launch.

## 17. Revised scope given all of the above

| Requirement | Verdict | Design |
| --- | --- | --- |
| Name-only join, room code | keep | in-memory rooms, no accounts, 6-char code + link |
| Chat | keep | same socket, ring buffer, rate limit |
| Synced playback + heartbeat | keep | canonical state, clock offset, drift ladder §3.4 |
| ≤ 5 viewers | easy | one rendition; 720p target on ~20–25 Mbit/s up |
| Upload test → quality | add | measure per-client download, min(), ÷ viewers, pick rung §12 |
| Same transcode for everyone | confirmed | pre-encode once per file at the chosen rung |
| Subtitles | add early | sidecar WebVTT, per-viewer; JASSUB if ASS styling matters |
| Multiple audio languages | later | forces HLS alternate audio (§14); one video, N audio |
| Jellyfin/Emby library | try first | `emby-watchparty`, or native SyncPlay if accounts are acceptable |
| Web links (playback sites) | separate product | browser extension, generic `<video>` adapter only |
| Pull from a streaming site | **don't** | re-hosting; keep it manual-file instead (§15) |
| Jellyfin plugin | no | can't do accountless guests; extension is the useful "plugin" (§10.2) |

## 18. "Emby watch party needs an Emby server" — correct, and agreed on building our own

`emby-watchparty` is a *frontend* for an existing Emby or Jellyfin instance: no media server, no app. It is worth
reading for its patterns (host-token-on-the-backend, drift heartbeat, seek-ready gate, the HLS quirk list) and
nothing else. Everything below assumes you own the stack.

## 19. "Plugin" = Metastream-style browser extension

Understood — not a media-server plugin. Metastream was actually extension + Electron shell + P2P sessions; you
want the extension part, which is also the only part that ever worked reliably. What it buys you:

- Each viewer's browser pulls video **directly from the site**. Your server carries a few hundred bytes a second.
  Zero video cost, zero re-encoding, zero bandwidth. This is the cheapest possible design.
- The room can carry a **URL**; the extension follows it. That is how you get "everyone lands on the same
  episode" without iframes: host sets the room URL, everyone's tab navigates, then playback sync takes over.

Costs: everyone must install it; everyone must be able to load the site themselves; no shared subtitles or quality
control; and every site change is your bug (§16).

So the honest shape is **one server, two front doors**: a hosted player for files and relayed links (works with
just a room code, no install), and an extension for "the site is the player". They share the same room, the same
canonical state, the same chat.

## 20. On-the-fly relay: don't download, proxy

You never need the whole file on disk. There are four ways to relay, and they should be built in this order.

### Mode 0 — no server video at all (extension path)

Each browser talks to the site. Your server only carries sync. Costs nothing; do nothing.

### Mode 1 — Range proxy (upstream is a single file)

The most underrated option: upstream gives you one `.mp4` that supports byte ranges. Your server answers the
browser's `Range: bytes=…` header by forwarding it upstream and returning `206 Partial Content` with the upstream
`Content-Range`. Result: **no disk, no transcoding, instant seeking**, because the browser's own media stack does
all of it. This is a ~40-line HTTP handler.

Details that matter:

- Forward `Range`; preserve `Content-Range`, `Content-Length`, `Accept-Ranges`, `Content-Type`, `ETag`.
- Handle upstream `302`s and set whatever `Referer`/`Origin`/`User-Agent` the host requires (many refuse without).
- `Cache-Control: no-store` on the proxied response, or you'll fill your disk with a cache of someone else's
  movie.
- Bind the proxy URL to a room session with a short TTL. An unauthenticated proxy URL is an open proxy, and open
  proxies get found.

### Mode 2 — HLS relay (upstream is an `.m3u8`)

Zero transcode, still no full download. Rewrite the playlist so every URI points at your server, then fetch
segments on demand:

- Resolve relative URIs against the playlist URL, absolute-ize them to `/r/<room>/seg/…`.
- Proxy `EXT-X-KEY` too — pass it through, don't extract it. hls.js handles AES-128, AES-256 and AES-256-CTR
  itself, and Safari does natively. You are a pipe, not a decryptor.
- Pass `EXT-X-MAP` (init segment) through unchanged; honour `EXT-X-BYTERANGE` by forwarding it.
- Keep an in-memory LRU of the last N segments so a jittery viewer doesn't hammer upstream, and so two viewers
  asking for the same segment cost one upstream fetch.
- Signed URLs die mid-film. Hold the resolver (yt-dlp/page scrape) and re-resolve on `403`, then swap the base URL
  under the same room without the player noticing.
- Watch for: master vs. media playlist, `EXT-X-MEDIA` audio/subtitle renditions, `EXT-X-DISCONTINUITY`.

Seeking is free here: the client asks for a later segment, you ask upstream for it. That is precisely the "not
having to download the whole file" behaviour you wanted, and it costs no CPU.

### Mode 3 — On-the-fly transcode (only when the source won't play)

Needed when the source is not browser-safe (HEVC/10-bit, x265, AC-3/E-AC-3 audio, MKV) or its bitrate blows the
bandwidth budget from §12. One pipeline for the whole room — 5 viewers cost the same CPU as 1.

Starting point, to be tuned:

```
ffmpeg -ss <start> -i <input> \
  -map 0:v:0 -map 0:a:0? \
  -c:v libx264 -preset veryfast -crf 21 -profile:v high -pix_fmt yuv420p \
  -force_key_frames "expr:gte(t,n_forced*2)" -sc_threshold 0 \
  -c:a aac -b:a 128k -ac 2 \
  -f hls -hls_time 4 -hls_playlist_type event \
  -hls_flags independent_segments \
  -copyts -output_ts_offset <start> \
  out.m3u8
```

Why each line matters:

- `-ss` **before** `-i` seeks via the index and lands on the nearest keyframe — fast. After `-i` it decodes and
  throws away everything before the point, which is unusably slow on a 20 GB file.
- `-force_key_frames … n_forced*2` with `-hls_time 4` makes every segment start on a keyframe. Without this you get
  the Emby failure mode: segments that lie about their duration and seeking that jumps to the wrong place.
- `-hls_playlist_type event` keeps all segments listed so viewers can seek backwards; `vod` finalises at the end;
  the default is a sliding live window.
- `-copyts` (+ `-output_ts_offset`) keeps the timeline continuous when you restart. **This is the gotcha nobody
  expects:** kill ffmpeg and restart at 600 s, and by default the new output starts at 0 → the player thinks it's
  a new video and every position calculation breaks. Verify the first segment's timestamps after a restart; this
  area is fiddly, and `-start_at_zero` is the other flag worth trying.
- **Seek during playback = kill ffmpeg and restart at the new offset**, costing ~1–3 s of black. That is not a bug
  in your design; it is what Emby itself does (their quirks doc §6), and it is why the room pauses and runs the
  ready-gate on a seek.

CPU, as a rule of thumb: 720p `veryfast` x264 is roughly 1–2 cores at realtime on a modern desktop; NVENC/QSV/VAAPI
is close to free. Because it's a single shared pipeline, that cost does not multiply by viewers.

### Mode 4 — Fallback: persist it

If upstream is hostile (no ranges, per-request tokens, slow, ads spliced into the middle), download once, remux,
keep the result, and serve it via Mode 1. Slow first time, perfect afterwards. Also the answer for "we're watching
this again next week".

### Starting before the file is complete

The user's requirement was explicit: no full download before playback. Every mode except 3 achieves that natively,
and mode 3 achieves it with a stream input. The mechanism, per mode:

**1. HTTP is already a streaming protocol.** A `GET` hands you bytes as fast as the network allows, and the browser's
media stack begins decoding as soon as it has the file header plus a couple of seconds of data. You do not need HLS
to start early — you need the index at the front (`-movflags +faststart`) and a correct `Range`/`206` reply. The
build-a-buffer-then-play behaviour people expect is the browser's, not something we implement.

**2. Windowed fetching, free backpressure.** The relay forwards the range the player asks for and then stops. The
player's own read-ahead (typically 10–30 s) is the download window; nothing else is prefetched. When the client
stops reading, the TCP window fills, the upstream response stalls, and the fetch pauses on its own. This is why the
server side should be a straight pipe (`pipeline(upstreamRes, clientRes)` in Node) and never buffer a whole file in
memory. Seek-before-downloaded is the same mechanism: the player asks for `bytes=<big number>-`, you ask upstream for
that same range. The middle of the file is never touched.

**3. HLS is segment-on-demand by construction.** The playlist lists twelve segments; the player asks for the seventh;
you fetch the seventh. The film is never "downloaded" — it is assembled by the client as it plays, and seeking is
just "ask for a different segment".

**4. Transcoding a stream (Mode 3).** ffmpeg accepts a URL or `pipe:` as input and emits segments as it encodes, so
playback can begin once the first segment exists (a few seconds). Two pacing choices, and they are genuinely
different products:

| Pacing | Behaviour | Good for |
| --- | --- | --- |
| `-re` (realtime) | ffmpeg consumes at 1×; everyone sits at the live edge; disk stays bounded with `delete_segments` | live sources; rooms that never seek; "my connection is the weak link" |
| as fast as possible | ffmpeg runs ahead and fills a segment cache; seeking works within what exists; seeking past it restarts the process | VOD, where people scrub |

**5. One upstream connection, five viewers — the thing that bites.** In a relay, *your* box is the only client the
source sees. Five viewers at the same timestamp will issue five near-identical range requests, and a naive proxy
turns that into five separate upstream fetches: five times the source's bandwidth, five chances of tripping a rate
limit, and five times the latency to fill a buffer. Mitigation for Mode 1 is a small shared block cache (e.g. 4 MB
blocks, LRU ~128 MB, with in-flight requests coalesced so concurrent askers wait on one fetch). For Mode 2 the
segment cache already does this. Do not skip it — it is the difference between "works for two people" and "works for
five".

**6. What you give up by not keeping the file.** (a) If upstream dies mid-film, the bytes you didn't cache are gone;
recovery means re-resolving. (b) Seeking backwards past the cache re-fetches (cheap for HLS, a re-encode for Mode 3).
(c) Disk stays small, which is the point. (d) If the source throttles per connection, the room shares one throttle —
again, that is the room's ceiling, not each viewer's.

**7. Optional "get ahead while paused".** A prefetch loop that requests the next few MB whenever the room is paused,
and stops when the room is near it. Bounded and opt-in; it is just repeated Range requests, no new machinery.

## 21. What the relay buys you for sync

Because you own the pipe, you get options the extension can never have:

- **(a) Shared VOD timeline** — normal seeking, each viewer buffers independently, drift corrected by §3.4. What
  people actually expect.
- **(b) Private broadcast** — pace the transcode to realtime (`-re`) and everyone watches the live edge. Nobody can
  pause independently, and drift becomes impossible because there is only one timeline being produced. Worth
  having as a "my connection is the weak one" mode, and it's ~20 lines simpler than (a).
- **(c) Hybrid** — pause/resume allowed; a seek re-anchors the room to a new shared timeline via the ready-gate.

You do not need `-re` for (a); it exists to simulate a live source, and using it on a seekable file just wastes
CPU headroom.

## 22. Relay bandwidth reality

- Your **upload** is the constraint: viewers × bitrate. Your download from upstream is not.
- Pick the rung from `min(server_uplink / viewers, your_throughput_from_source)` — if the site is slow for you,
  everyone suffers.
- Relay adds one hop of latency (~0.5–2 s) and makes your box the room's single point of failure. Both are
  acceptable for five friends; neither is acceptable as a public service.

## 23. Build order that matches all of this

| # | Step | Effort | Why here |
| --- | --- | --- | --- |
| 1 | Rooms, sync engine, chat, direct-play library | 3–5 d | the actual product |
| 2 | **Mode 1 Range proxy** (paste link → synced playback) | 1–2 d | covers most mp4-serving sites, no CPU, no disk |
| 3 | Extension (generic `<video>` + room-URL follow) | 1–2 wk | cheapest possible video path; covers "the site is the player" |
| 4 | Mode 2 HLS relay | 3–5 d | anime/movie hosts are mostly m3u8 |
| 5 | Subtitles: extract to VTT, per-viewer | 2–3 d | biggest perceived-quality win for the effort |
| 6 | Mode 3 transcode (incl. restart-on-seek) | ~1 wk | only for unplayable sources and bitrate control |
| 7 | Audio languages as HLS renditions | ~1 wk | the one genuinely architecture-forcing feature |

Note the ordering logic: **Modes 1 and 2 need no re-encoding at all.** They are the cheap, high-value half of "on
the fly". The transcode is the expensive half and is only justified for sources that browsers can't decode. Build
the pipe before the pump.

## 24. Extension minimum spec (Metastream-shaped, minus the mistakes)

```
manifest.json   MV3, host_permissions ["<all_urls>"], content_scripts all_frames:true
content.js      find <video> (incl. shadow DOM, incl. same-origin subframes)
                report play/pause/seeked/ratechange + currentTime
                apply remote commands; suppress echoes via an expectedEvents set
background.js   one WebSocket, one room, name only; routes by frameId
popup.html      name, room code, join/leave, "sync this tab"
```

Server-side it is just another client: same canonical state, same heartbeats, same chat. Two additions worth the
20 lines each:

- **Room URL follow.** The room stores `url`; on join, if the tab isn't there, the extension navigates. That's the
  "paste a link, everyone lands on the same episode" feel, without an iframe in sight. Be careful: the URL is
  broadcast to everyone in the room, so never store a tokenised or private link — strip the query, or keep the
  secret in the URL fragment (browsers don't send fragments to servers, and KoalaSync uses exactly this trick for
  its chat key).
- **Tab-lock.** While in a room, navigating away warns or auto-leaves, so a stray click doesn't silently break sync
  for that person.

Note that KoalaSync ships an in-page chat overlay as part of the same extension (`chat-overlay.js`,
`chat-overlay.css`, `chat-activity.js`, plus an end-to-end-encrypted chat mode keyed from the invite fragment). Two
things follow: it is a solved problem in this exact context, and the UI is a real chunk of the work — it is not
"just a text box" once it has to survive arbitrary pages, fullscreen, and sites that fight for the keyboard.

## 25. Reference index — repos, libraries, specs

Everything worth opening, with the licence, so nobody has to rediscover which ones can be copied and which can only
be read. "Lift" = copy code with attribution; "ideas only" = read the design and write our own.

### Prior art — whole projects

| Project | Link | Licence | Reuse | What to take |
| --- | --- | --- | --- | --- |
| **Syncplay** | github.com/Syncplay/syncplay | Apache-2.0 | lift | `constants.py` thresholds, `client.py::_userOffset`, the nudge ladder, the protocol page |
| **WatchParty** | github.com/howardchung/watchparty | MIT | lift | `server/room.ts::setTimestamp` reconciliation, room model, WebTorrent/WebCodecs experiments |
| **KoalaSync** | github.com/Shik3i/KoalaSync | MIT | lift | canonical media state, two-phase force sync, chat overlay, frame election, MV3 Chrome+Firefox build scripts |
| **emby-watchparty** | github.com/Oratorian/emby-watchparty | MIT | lift | `socket_handlers/drift.py`, the seek/ready handshake, the Emby HLS quirks document |
| **OpenTogetherTube** | github.com/dyc3/opentogethertube | AGPL-3.0 | ideas only | position math (`common/timestamp.ts`), player-adapter layout, `docs/synchronization.md` |
| **Jellyfin** | github.com/jellyfin/jellyfin | GPL-2.0 | ideas only | SyncPlay state machine (`GroupStates/*`), `UtcTimeResponse`, scheduled-start trick |
| **jellyfin-plugin-syncplayv2** | github.com/kontell/jellyfin-plugin-syncplayv2 | check repo | ideas only | what a plugin-based sync layer looks like |
| **CyTube** | github.com/calzoneman/sync | check repo | ideas only | playlist + chat moderation patterns |
| **Owncast** | github.com/owncast/owncast | MIT | lift | live-stream chat/UI patterns; not a sync system |
| **Neko** | github.com/m1k1o/neko | check repo | run as-is | shared remote browser, the fallback for sites an extension cannot drive |
| **Metastream** | github.com/samuelmaddock/metastream | OSS discontinued Aug 2024 | post-mortem | v0.10.4 on the `archive` branch; study, don't resurrect |
| **AnimeX / VideoStreamingPlatform** | github.com/arindhimar/VideoStreamingPlatform | check repo | ideas only | ffmpeg → HLS segmenting example; has no group watch |

### Libraries and tools

| Thing | Link | Licence | Use for |
| --- | --- | --- | --- |
| hls.js | github.com/video-dev/hls.js | Apache-2.0 | HLS playback, alternate audio, WebVTT renditions, AES-128/256 |
| shaka-player | github.com/shaka-project/shaka-player | Apache-2.0 | the alternative if DASH ever matters (it doesn't yet) |
| JASSUB | github.com/ThaUnknown/jassub | MIT | rendering real `.ass` subtitles in the browser (anime typesetting) |
| webextension-polyfill | github.com/mozilla/webextension-polyfill | MIT | one `browser.*` API across Chrome and Firefox |
| ws | github.com/websockets/ws | MIT | the WebSocket server |
| ffmpeg | ffmpeg.org | LGPL-2.1+ (GPL if built with GPL parts) | transcoding, probing, HLS segmentation — always as a subprocess, never linked |
| ffprobe | ships with ffmpeg | same | library metadata |
| Caddy | caddyserver.com | Apache-2.0 | TLS and reverse proxy, zero config |
| Node / Vite / Svelte | nodejs.org, vitejs.dev, svelte.dev | MIT | runtime and UI |
| yt-dlp | github.com/yt-dlp/yt-dlp | Unlicense (public domain) | **manual use only** — not bundled (ADR-007); no DRM support |
| streamlink | github.com/streamlink/streamlink | BSD-2-Clause | same role as yt-dlp for live HLS |

### Specs and documentation worth reading once

| Document | Where | Why |
| --- | --- | --- |
| Syncplay protocol | syncplay.pl/about/protocol | the state/ping message vocabulary, and why heartbeat timeout matters |
| Apple HLS authoring spec | developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices | the bitrate ladder, keyframe interval, 6 s segments, alternate audio, WebVTT rules |
| RFC 8216 | datatracker.ietf.org/doc/html/rfc8216 | HLS itself |
| RFC 9110 §14 | datatracker.ietf.org/doc/html/rfc9110 | `Range`, `206`, `Content-Range` — the semantics Mode 1 depends on |
| WHATWG HTML media | html.spec.whatwg.org/multipage/media.html | `currentTime`, `readyState`, `buffered`, `playbackRate` exactly as specified |
| MDN: HTTP range requests | developer.mozilla.org/docs/Web/HTTP/Guides/Range_requests | the client side of the same |
| MDN: `playbackRate` / `preservesPitch` | developer.mozilla.org/docs/Web/API/HTMLMediaElement/playbackRate | why the nudge is inaudible |
| MDN: `audioTracks` | developer.mozilla.org/docs/Web/API/HTMLMediaElement/audioTracks | the "limited availability" that forces HLS for multi-language |
| Chrome autoplay policy | developer.chrome.com/blog/autoplay | why the Join click is load-bearing |
| Chrome ESW lifetimes | developer.chrome.com/blog/longer-esw-lifetimes | 30 s idle rule for MV3 service workers |
| MDN: extension `background` | developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background | service worker vs event page |
| MDN: `host_permissions` | developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/manifest.json/host_permissions | install prompts, optional grants |
| MDN: WebRTC signaling / protocols | developer.mozilla.org/docs/Web/API/WebRTC_API | why "no host" still needs a rendezvous; STUN vs TURN |
| ffmpeg docs | ffmpeg.org/ffmpeg.html, ffmpeg.org/ffmpeg-formats.html | `-ss` before/after input, `-copyts`, `-output_ts_offset`, the HLS muxer's `hls_flags` |

### Commercial prior art (UX only, nothing to reuse)

Teleparty, Watch2Gether, Kosmi, Hyperbeam, Scener, TwoSeven, Rave (defunct). Useful for one question each: how the
invite looks, how the chat sits next to the video, how much chrome they put around the player. Our answer is
"less".

---

## 26. Sources

All read directly:

- Syncplay protocol specification — https://syncplay.pl/about/protocol/
- Syncplay tuning constants — `syncplay/constants.py`, github.com/Syncplay/syncplay
- Syncplay drift handling — `syncplay/client.py` (`_slowDownToCoverTimeDifference`, `_rewindPlayerDueToTimeDifference`)
- Jellyfin SyncPlay state machine — `MediaBrowser.Controller/SyncPlay/GroupStates/*.cs`, github.com/jellyfin/jellyfin
- Jellyfin latency-accounted start — `PlayingGroupState.cs` (`LastActivity = UtcNow.AddMilliseconds(max(highestPing*2, DefaultPing))`)
- Jellyfin time sync — `MediaBrowser.Model/SyncPlay/UtcTimeResponse.cs`
- Jellyfin 10.6.0 release notes (SyncPlay in core) — https://jellyfin.org/posts/jellyfin-10-6-0/
- Community SyncPlay plugin — github.com/kontell/jellyfin-plugin-syncplayv2
- OpenTogetherTube position math — `common/timestamp.ts`, `client/src/views/Room.vue`, `server/room.ts`; design note `docs/synchronization.md`
- WatchParty room/timestamp reconciliation — `server/room.ts::setTimestamp`, github.com/howardchung/watchparty
- KoalaSync architecture, protocol, limitations — `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`,
  `docs/KNOWN_LIMITATIONS.md`, `docs/nested-player-frame-targeting.md`, `docs/TESTED_SERVICES.md`,
  github.com/Shik3i/KoalaSync
- emby-watchparty (README, `backend/src/socket_handlers/drift.py`, `sync.py`,
  `documentations/Emby quirks we learned the hard way.md`) — github.com/Oratorian/emby-watchparty
- `arindhimar/VideoStreamingPlatform` — repo tree and README (no sync/room/chat code; AnimeX, Nov 2024)
- Metastream — github.com/samuelmaddock/metastream README ("As of August 2024, Metastream has discontinued
  publishing under open source")
- Apple, *HLS Authoring Specification for Apple Devices* — bitrate variants (1.25), keyframes every 2 s (1.13),
  6 s segments (7.5), separate audio streams for alternate languages (9.7), WebVTT subtitles (5.2–5.3)
- hls.js requirements, alternate audio, AES-128/256 decryption — github.com/video-dev/hls.js README
- ffmpeg documentation — `-ss`, `-copyts`, `-output_ts_offset` (ffmpeg.html); HLS muxer `hls_time`,
  `hls_playlist_type`, `hls_flags` (`independent_segments`, `append_list`, `delete_segments`),
  `hls_segment_type` (ffmpeg-formats.html)
- `HTMLMediaElement.playbackRate` / `preservesPitch` — MDN
- `HTMLMediaElement.audioTracks` — MDN ("Limited availability … not Baseline")
- HTTP range requests, `206 Partial Content`, `Content-Range` — MDN
- Chrome autoplay policy — developer.chrome.com/blog/autoplay
- Same-origin policy (why an iframe cannot be scripted) — MDN
- Extension `background` key: `service_worker` (Chrome) vs `scripts` event page (Firefox), `preferred_environment` — MDN
- `host_permissions` and install prompts in Firefox 127+ / Chrome — MDN
- MV3 service-worker lifetime: 30 s idle, events reset the timer, Chrome 110 removed the hard 5-minute cap —
  developer.chrome.com/blog/longer-esw-lifetimes
- WebRTC requires signaling that the spec does not provide; STUN for address discovery, TURN when a direct path
  fails — MDN (Signaling and video calling; WebRTC protocols)
- yt-dlp — no DRM decryption support (project FAQ / wiki)
- JASSUB (ASS subtitles rendered in the browser via WASM, MIT) — github.com/ThaUnknown/jassub

---

## 27. Sharing a self-hosted app with friends: what was checked (2026-11-16)

Checked because the plan at the time needed a public address for the host's PC. The conclusion that mattered is
that **none of this is needed** once the channel carries only chat and control (ADR-023) — it is recorded so nobody
re-runs the research, and because the numbers are the argument.

| Option | Public link, no guest install? | Host account? | Bandwidth / terms | Licence |
| --- | --- | --- | --- | --- |
| **Tailscale Funnel** | yes (`https://machine.tailnet.ts.net`) | yes | limit is **unpublished and non-configurable**; a third-party benchmark measured ~7 Mbit/s; still beta | client and `tsnet`: BSD-3-Clause |
| **Cloudflare Tunnel** | yes (own domain; no-account `*.trycloudflare.com` quick tunnel) | yes (free) | free on all plans, but the Service-Specific Terms require paid Stream/Images "in order to serve video and other large files", and Cloudflare may limit or disable an account that does so anyway | `cloudflared`: Apache-2.0 |
| **ngrok** (free → Hobbyist) | yes | yes | **1 GB/month** free, plus an interstitial page; Hobbyist $8–10/mo with 5 GB included, then $0.10/GB | proprietary |
| **zrok** (hosted) | yes | yes | **5 GB/day**; unverified accounts get an interstitial until a card is added | client Apache-2.0, self-host unlimited |
| **playit.gg** | yes, but HTTPS tunnels are Premium | yes | $3/mo for HTTPS; free is TCP/UDP only | proprietary |
| **localtunnel / bore** | yes | no | dev tools on shared community servers; no published terms for sustained video | MIT |
| **frp** (self-hosted) | yes | VPS account | ~$4–6/mo for the VPS; full control, no content clause | Apache-2.0 |
| **Tailscale / Headscale / WireGuard mesh** | **no** — guest installs a VPN client | yes | fails the "browser-only guest" requirement outright | Headscale BSD-3; WireGuard GPL-2.0 |

Sizing that kills the free tiers: 8 Mbit/s is ~3.6 GB/hour, so one three-hour evening is ~11 GB. A month of two
evenings a week is ~90 GB.

**Verdict at the time.** Cloudflare Tunnel on a cheap domain was the realistic answer — free, stable HTTPS, no
interstitial — with the exposure being legal rather than technical ("works until noticed"). Tailscale Funnel was
the cleanest design with a coin-flip bandwidth cap. Both are now irrelevant: the app makes direct connections to
opened ports (ADR-023), and the control channel is kilobytes, so no tunnel, no account and no quota enters the
picture.

**Unverified, and left that way deliberately:** whether Cloudflare counts a Tunnel hostname as "the CDN" for its
video clause; whether Tunnel has any bandwidth quota; the real Tailscale Funnel figure (the ~7 Mbit/s is a
competitor's benchmark, not a primary source); playit.gg's free throughput.

Sources: tailscale.com/kb/1223/funnel · pkg.go.dev/tailscale.com/tsnet · tailscale.com/tailscale-aup ·
developers.cloudflare.com/tunnel/ · cloudflare.com/service-specific-terms-application-services ·
ngrok.com/docs/pricing-limits/free-plan-limits/ · ngrok.com/pricing · zrok.io/pricing/ · playit.gg/pricing ·
github.com/localtunnel/localtunnel · github.com/ekzhang/bore · github.com/fatedier/frp ·
github.com/juanfont/headscale
