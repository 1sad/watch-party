# Decisions

Each entry: what we chose, why, what we rejected, what it costs us. Numbered so later sessions can cite them
("per ADR-005…"). Anything marked **unverified** is a grill target in `open-questions.md`.

---

## ADR-001 — Build our own; do not depend on Emby or Jellyfin

**Decision.** Standalone app. No media-server dependency.

**Why.** `emby-watchparty` fits the shape (host has the account, guests don't) but it is a frontend *for* an
Emby/Jellyfin instance, and it spends its existence fighting that server's HLS pipeline. We want the same
behaviour without adopting a second product's bugs, its auth model, and its upgrade cycle.

**Rejected.** (a) Jellyfin + built-in SyncPlay — every viewer needs an account. (b) `emby-watchparty` — needs a
media server. (c) A Jellyfin plugin — cannot create accountless guests, and it is C# against a moving target.

**Cost.** We implement media serving ourselves. Mitigation: Modes 1–2 are proxies, so the first two milestones
need no encoder at all.

---

## ADR-002 — One server-authoritative timeline, not peer authority

**Decision.** The server owns `{playing, position, updatedAt, revision}`. Clients derive, never dictate.

**Why.** Every "who is right?" bug in peer-synced systems (Metastream's P2P sessions, KoalaSync's unauthenticated
`peerId`) comes from having no authority. One authority also makes late join and reconnect trivial: the snapshot
is the truth.

**Rejected.** P2P authority, "first peer is host and the others trust it" (fine when it works, undebuggable when
it doesn't), and last-writer-wins command fan-out.

**Cost.** A server must exist for the web rooms. For the extension-only case see ADR-005.

---

## ADR-003 — Store a position-and-timestamp, not "seek to X now"

**Decision.** Mutations write `position` at `updatedAt`; clients compute `position + (now - updatedAt)`.

**Why.** It makes drift self-healing: a client that missed a message, stalled for 3 s, or joined late converges
from arithmetic instead of from a resync round-trip. This is what OpenTogetherTube, KoalaSync, and Jellyfin all
converge on.

**Rejected.** Broadcasting imperative "seek to 41:12 now" commands and hoping everyone applies them simultaneously.

**Cost.** Requires a decent clock-offset estimate (ADR-003 depends on §6.1 of the spec). Without it, the formula
is confidently wrong.

---

## ADR-004 — One rendition; the weakest link sets the room's quality

> **Amended 2026-11-16 (ADR-027):** this rule now governs file mode only, and file mode is a test rig. In website
> mode the site picks the quality per viewer and we get no say, so there is no ladder, no capacity probe and no
> "weakest link". Nothing here is built in v1; R15 is tagged v2.

**Decision.** Transcode once per file at a rung chosen by the capacity probe (`min(uplink/viewers)`), reuse it.
No adaptive ladder in v1.

**Why.** Five viewers pulling identical bytes is cache-friendly, CPU-free at play time, and predictable. Adaptive
streaming exists to serve heterogeneous clients; a movie night with five friends does not need it.

**Rejected.** Per-viewer ABR (complexity, CPU, and it undermines "same picture for everyone"), and streaming the
original remux (a 25 Mbit/s file × 5 = 125 Mbit/s of upload).

**Cost.** One person on bad wifi drags the room to 480p. Acceptable; the UI shows why.

---

## ADR-005 — Serverless extension: possible, but it saves less than it looks like

> **Amended 2026-11-16 (ADR-024):** the "stretch milestone M6" is gone, and so is the WebRTC plan. The peer mesh is
> plain WebSocket over an opened port (ADR-023), carrying chat and control only. **The analysis below still holds**
> and is worth keeping: "no host at all is not free", and the reasons are why every pair of apps still needs one
> reachable side. What changed is that we decided the port is the cheaper answer than the rendezvous.

**Decision.** Define the protocol transport-agnostically now; ship the WebSocket relay first; add a WebRTC
data-channel transport as a stretch milestone (M6) with a designated peer as authority.

**The user question.** Can the extension work with no host at all — just people with it installed, sharing a code?

**Answer, precisely.**

1. **No host for the *video* is already true.** In the extension path each browser pulls from the site itself.
   The server carries only sync frames (~1 KB/s total). So "serverless" does not save bandwidth — it saves you
   *running a box*.
2. **No host *at all* is not free.** WebRTC requires a rendezvous: "a form of discovery and media format
   negotiation must take place… called signaling" (MDN). WebRTC does not specify it; you supply it. Three shapes:
   - **Public rendezvous, your code names the topic.** A public relay (Nostr relay, an MQTT-over-WebSocket
     broker, a free hosted WebSocket) carries the offer/answer and later the tiny sync frames. Users type a code;
     the code is hashed into a topic. Nobody runs a server, but *someone else's* server is still in the path.
   - **Manual signaling.** Copy/paste an offer blob, get an answer blob back. Genuinely serverless, genuinely
     unusable as "just share a code" — it is a handshake, done once per pair.
   - **A peer as relay.** Impossible from an extension: content scripts cannot listen on ports, and MV3 workers
     are killed when idle.
3. **NAT traversal needs help regardless.** WebRTC uses STUN for address discovery and TURN when a direct path
   fails (MDN). Without TURN, a meaningful minority of network pairs simply cannot connect. **Unverified** how big
   that minority is for our specific group — it is the first experiment in `open-questions.md`.
4. **Authority returns as a problem.** With no server, who decides the true position? You need one peer as clock
   authority plus an election when they leave — the same shape KoalaSync implements with `hostPeerId`, and the
   same class of bug it documents as accepted (`NOFIX-1`).
5. **MV3 lifetime.** The background worker dies after ~30 s without events, so a long-lived socket is not
   guaranteed; the transport must tolerate being torn down and rebuilt.

**Why not v1.** A relay is ~150 lines and removes four failure modes (TURN, authority election, public-relay
rate limits, worker lifetime). For five friends the operational cost is one container.

**What we do now.** Keep `transport` in the wire model (`web` | `extension` | future `webrtc`), keep the sync
engine free of transport assumptions, and do not let server-only fields leak into client math. That is what makes
M6 additive rather than a rewrite.

**Rejected.** (a) Extension that only works peer-to-peer with public relays from day one — highest bug surface,
worst debuggability. (b) Bundling a local helper binary ("just run this exe") — that is a server with extra steps
and worse security.

**Cost.** If the host's box is off, no rooms. That is the trade for reliability.

---

## ADR-006 — Never sync inside a third-party iframe

**Decision.** No `myapp.com/watch?url=…` embedding. Third-party pages are synced by the extension, or not at all.

**Why.** A page cannot script a cross-origin iframe (same-origin policy). Proxying the HTML to inject a script
breaks on CSP, signed assets, referrer checks, and turns the box into a re-hoster.

**Rejected.** HTML-rewriting proxy, and "iframe with postMessage" (only works if the site cooperates).

**Cost.** The extension is mandatory for that feature. Non-extension users get links only.

> **Amended 2026-11-26 (ADR-054):** driving a **cooperating** player is not the shape this ADR rejects. Where a site
> publishes its own embed API for a page to call - YouTube's IFrame API is the one this app already uses (ADR-051) - an
> app page may carry that player and drive it through the API, in the app's own window and in an ordinary browser alike.
> Nothing here permits framing a site that offers no such API: an ordinary website is still synced by the extension, or
> not at all, and the proxy stays rejected for the reasons above.

---

## ADR-007 — No built-in site resolver or downloader in v1

**Decision.** The app plays files it is given and URLs a user pastes. It does not ship `yt-dlp` integration or a
site scraper.

**Why.** It converts a sync tool into a distributor, it breaks weekly, and it makes the operator the interesting
party in any dispute. The user can obtain a file by their own means; the app's job starts after that.

**Rejected.** A `/resolve?url=` endpoint, a background downloader, and a "watch anything" search box.

**Cost.** "Paste a page link and it just works" is not a v1 feature. Mode 1/2 accept *direct media URLs*, which the
user supplies.

---

## ADR-008 — Sidecar WebVTT for subtitles; JASSUB later if ASS matters

**Decision.** Convert text subtitle tracks to `.vtt` at import, serve as files, render as `<track>`s per viewer.

**Why.** Zero server work, per-viewer selection, no effect on sync. Image-based subs cannot become text, so they
get a clear "not supported" message rather than a broken toggle.

**Rejected.** Burning subtitles in (kills choice), storing raw ASS and rendering it at launch (heavier; but a real
option later via JASSUB).

**Cost.** Anime typesetting looks worse than the source. Tracked as a later enhancement.

---

## ADR-009 — Multiple audio languages are a separate, later milestone

**Decision.** v1 is single-audio. Multi-language uses HLS alternate audio renditions (`EXT-X-MEDIA`), one video
plus N audio streams.

**Why.** The obvious API, `HTMLMediaElement.audioTracks`, is not Baseline — it does not work in some major
browsers. Doing it properly forces HLS, which forces keyframe and segment discipline.

**Rejected.** Separate complete file per language (2–3× storage, and switching means a reload plus resync).

**Cost.** v1 is single-language. Fine for most films; a real limitation for anime.

---

## ADR-010 — Rooms live in memory

> **Amended 2026-11-16 (ADR-024):** still no database, and now not even a TTL. A room exists only while at least one
> app is in it; there is no machine left running to hold one, so R16 is dropped rather than deferred.

**Decision.** No database. A room is an object with a 6-hour TTL. Chat is a 100-message ring buffer.

**Why.** Removes migrations, backups, and a class of privacy questions. KoalaSync's whole threat model is built on
"zero-persistence, in-memory message bus" and it holds up.

**Rejected.** SQLite/Postgres for rooms, Redis for shared state.

**Cost.** Restarting the server ends all rooms. Acceptable for family-and-friends use; would not be for a product.

---

## ADR-011 — Name-only identity; anyone can control by default

> **Amended 2026-11-16 (ADR-025):** the `host` control mode is **removed**, not defaulted. Everyone controls
> everything. "Host" now means only "the app currently holding authority", and a name may be set after joining
> (R26). The reasoning about accounts and trolling is unchanged.

**Decision.** No accounts. A display name, deduplicated. Default control mode `everyone`, with `host` available.

**Why.** The friction of an account is the thing that kills these tools for casual groups. Trolling inside an
invited room of five friends is a social problem; the fix is kick, not auth.

**Rejected.** Passwords, OAuth, signed peer identities.

**Cost.** Someone with a modified client can seize host in a room they were invited to. Accepted, documented
(KoalaSync reaches the same conclusion as `NOFIX-1`).

---

## ADR-012 — Node + TypeScript, `ws`, Vite + Svelte

> **Amended 2026-11-16 (ADR-022):** same languages, different shell. The client is a desktop app embedding WebView2,
> not an SPA served by a browser-facing server. `ws` survives — now as the direct connection between apps rather than
> a socket into a shared server.
>
> **Amended 2026-11-20 (ADR-034):** same languages, and now a named process: TypeScript runs in a sidecar spawned by a
> small .NET host, which owns the window and the WebView2 control. `npm run dev` starts both.

**Decision.** One Node process, plain `ws` (not Socket.IO), a small SPA.

**Why.** Every reference implementation worth copying (WatchParty, KoalaSync, OTR) is TS/JS, so patterns
translate directly, and the extension shares the wire types. `ws` over Socket.IO because we control both ends and
do not need fallbacks or rooms-in-a-namespace.

**Rejected.** Go (better deploy story, but everything to copy is JS), Python/FastAPI (fine, but then the extension
and server speak different languages), Socket.IO (transport fallbacks we don't need, plus a protocol we don't own).

**Cost.** `node_modules` in the image. Mitigation: single stage build, no dev deps at runtime.

---

## ADR-013 — hls.js for HLS, not shaka-player

> **Amended 2026-11-16 (ADR-027):** HLS is v2. Nothing loads hls.js in v1, because the only HLS sources would be
> relayed ones and the relay is not built. The comparison stands for when it returns.

**Decision.** `hls.js` when HLS is needed.

**Why.** HLS-only is fine (we are not doing DASH), it handles alternate audio and WebVTT renditions, AES-128/256,
and it is the library every reference project uses.

**Rejected.** shaka-player (more capable, more surface, DASH we don't need), native-only HLS (Safari-only).

**Cost.** Safari plays HLS natively; we keep the native path and only load hls.js where MSE is needed.

---

## ADR-014 — No Electron, no peer-to-peer video, no queue

> **Amended 2026-11-16 (ADR-022):** we do now ship a desktop program, but still not a browser: it borrows the engine
> Windows already has. Peer-to-peer **video** remains out, forever — the mesh carries chat and control only. The queue
> is still out.

**Decision.** Browser only, server-relayed control, one media at a time.

**Why.** These are the three scope items that most plausibly explain Metastream's bug load (see research §16):
shipping a browser, making correctness depend on five NATs, and building a queue nobody asked for.

**Cost.** No desktop app, no "watch my local file without uploading" between friends. Deliberate.

---

## ADR-015 — One codebase, two manifests (Chrome + Firefox)

> **Amended 2026-11-16 (ADR-022):** this is now the *fallback* client's rule, and its scope is website mode only. It
> is built after the app (M5), not first. Everything below about manifests, lifetimes and store distribution still
> applies when it is built.

**Decision.** Shared extension source, two generated manifests. Chrome uses `background.service_worker`; Firefox
uses `background.scripts` (an event page) plus `browser_specific_settings.gecko.id`. Promise-based APIs via
`webextension-polyfill`.

**Why.** Both are Manifest V3 now, but the background lifetime model differs: Chrome kills a service worker after
~30 s without events, Firefox unloads a non-persistent event page without a 30 s timer. One manifest cannot
satisfy both stores. Both browsers show the requested host permissions in the install prompt (Firefox from 127),
so `<all_urls>` needs a plain-English explanation in the listing.

**Rejected.** Chrome-only (the user needs Firefox); a build-time framework that hides the difference (more
dependency than the difference is worth); per-site permission requests in v1 (better trust story, but three extra
UI flows — revisit if the store prompt scares people).

**Cost.** Two build artefacts, two store accounts, and a test matrix that doubles. Mitigation: the diff is
manifest plus a handful of API shims; the sync engine is transport- and browser-agnostic.

---

## ADR-016 — Host failover with epochs; the old host never reclaims

> **Amended 2026-11-16 (ADR-024, ADR-025):** the mechanism survives almost verbatim; the words and one rule change.
> Authority transfers to the earliest-joined online member with an epoch bump, and a returning member never
> auto-reclaims. What is new is that the transfer is now expected to be **invisible** in website mode, because no
> video depends on the room; and that "owner" is a separate concept that never moves.

**Decision.** Presence via 5 s heartbeats, `suspect` at 10 s, `offline` at 20 s. On host offline, promote the
earliest-joined online member, bump `room.host.epoch`, broadcast `hostChanged`. Host-only commands carry the epoch;
stale ones are rejected. A returning host is demoted with an explicit notice.

**Why.** The requirement was threefold: the host must learn, everyone must learn, and control must move without
breaking. Two of those are easy; the third only works with a version number on the role, otherwise a host that
was merely paused in a lift can resume and fight the new one. "Never auto-reclaim" is what prevents the
`peerId`-impersonation class of bug KoalaSync documents as accepted.

**Rejected.** (a) No failover — a dead host freezes the room's controls. (b) First-to-reconnect reclaims — two
hosts, silently. (c) Electing by "who has the best connection" — non-deterministic, and every client must agree.

**Honest limitation.** A disconnected host *cannot* be told at the moment it happens. What we guarantee is local
detection in ~10 s, a clear banner, and an explicit "you were replaced by X" on return. Anything else would be
pretending.

**Cost.** One epoch field on host commands, one promotion rule, and a demotion notice. About a day of work,
including the edge cases (host is the only member; host has no player but a live socket; simultaneous drops).

---

## ADR-017 — Per-viewer timeline offset; room-level audio language when we own the file

**Decision.** Two mechanisms for "we're not watching the same cut":

1. **When we serve the file:** the room has one video timeline and N audio renditions. Sub/dub differences
   *cannot happen* — only the audio stream changes.
2. **When the extension drives a site:** each member carries `timelineOffset` seconds, applied symmetrically
   (`target + offset`, `report − offset`), exactly as Syncplay's `_userOffset` does.

**Why.** Different mirrors and different dubs are a real, observed problem. A single number per member, settable
with one "Align here" click while paused, fixes every *constant* difference with no protocol change and no
server-side mapping table. Syncplay has shipped this for years, which is the strongest available evidence that
it is the right level of complexity.

**Rejected.** (a) Forcing everyone onto the same mirror — fights the user, and some mirrors are blocked per ISP.
(b) Auto-detecting offsets by audio fingerprinting — a research project. (c) Anchor-point mapping in v1 — real but
rare, and it belongs after the simple case works.

**Cost / limits.** A genuinely different edit drifts progressively and no constant fixes it. That is why the spec
holds **anchor points** (`{roomTime, myTime}` pairs, piecewise-linear, one click to add) as the v2 answer, and why
a duration mismatch beyond 2.5 s downgrades a member's sync to advisory rather than pretending it is exact.

---

## ADR-018 — The media library is a folder scan, not a media server

> **Amended 2026-11-16 (ADR-027):** the library is v2. File mode is "pick one file" and nothing scans a folder in
> v1. The design below is kept for when that changes; it is not a commitment.

**Decision.** Scan configured folders, `ffprobe` each changed file into a JSON cache, show a grid, extract
subtitles and thumbnails lazily. Host-only browsing. No accounts, no online metadata, no transcoding farm.

**Why.** The value the group wants is "pick a file from my library and watch it together". Jellyfin's value beyond
that (users, permissions, remote access, metadata) is exactly the part we decided not to own (ADR-001). Lazy work
keeps a 500-file scan instant and the first play the only slow moment.

**Rejected.** Embedding Jellyfin (ADR-001); scraping TMDB/anime APIs (ADR-007 spirit); a database for the library
(JSON cache is enough at this scale; if it isn't, SQLite is a contained change).

**Cost.** Ugly titles from bad filenames. Acceptable; renaming files is the fix, and a manual title override can
come later.

---

## ADR-019 — One-click rooms; invites ride in the URL fragment

> **Amended 2026-11-16 (ADR-023):** the invite is ours now. It is a `watchparty://` link carrying the owner's address
> and the room code, and it no longer lands on a third-party page — so the fragment trick has nothing to hide from and
> is gone. "One click, one link, nothing typed" survives unchanged.

**Decision.** Extension: "Start room here" creates the room and copies the invite. Invite with a source page is
`<site-url>#wp=CODE`; the fragment is read by the extension and stripped with `history.replaceState`.

**Why.** The two friction points are "host has to set something up" and "guest has to be told something". A
toolbar button plus a link they already know how to click removes both. The fragment is the only part of a URL
that browsers never send to the server, so the invite leaks nothing to the third-party site — and it works on any
domain without our page being involved.

**Rejected.** A separate landing page for every invite (extra hop, extra click, and the guest loses the page
context); query strings (sent to the site, logged in its access logs); room codes typed by hand as the primary
path (kept as the fallback for web-only guests).

**Cost.** Two invite formats to explain, and the extension must clean up the fragment on join.

---

## ADR-020 — Chat is server-owned and rendered by two front doors

**Decision.** One chat per room, held on the server as a 100-message ring buffer, rendered by the web room **and**
by a shadow-DOM overlay injected by the extension. Same message list, same send path, same system messages.

**Why.** The two front doors look different but must not feel different: sending from the page and reading in the
overlay has to just work, including for someone who joins late. Keeping history on the server makes that true for
free; keeping it in either client makes it a sync problem on top of a sync problem.

**Rejected.** (a) An overlay that renders only messages sent after it opened — halves the feature for a tenth of
the work. (b) Embedding a third-party chat (Discord widget) — external dependency, worse fit, and it breaks the
"same room" idea. (c) A separate always-on-top chat window as the *primary* UI — actually less fragile, but it
loses the in-page context, so it is the fallback rather than the design.

**Cost.** The overlay needs the four survival tricks in spec §10.6 (shadow DOM, constructed stylesheet,
fullscreen re-parenting, keyboard/click isolation). That is a day of work and the main source of "it looks broken
on site X" reports.

---

## ADR-021 — Offsets are suggested from stable observation, never from duration

**Decision.** A member's `timelineOffset` is set by one click (align / nudge), and *suggested* when their
`myPosition − expected` has been stable to ±0.5 s for 10 s with the correction ladder idle. Suggestions are stored
per source key (origin + rounded duration), not per room.

**Why.** The observed case is concrete: a dub with a 5 s logo the sub lacks. Duration delta (5 s) tells you *that*
the copies differ, but not whether the extra time is at the front (needs +5) or the tail (needs 0). Stable
observation tells you which. And requiring an idle ladder is what prevents a bad connection being mistaken for
content and permanently baked in as an offset.

**Rejected.** (a) Auto-applying without asking — a single mis-detection is then sticky and mysterious. (b) Using
duration delta as the offset — wrong for tail differences. (c) Nothing at all — the 5 s logo then shows up as a
permanent, uncorrectable argument between two viewers.

**Cost.** One extra server-side check per report and a bit of UI. The subtle failure — a member with a genuinely
drifting network looks "stable" during a long buffering lull — is handled by the ladder-idle requirement and by
never auto-applying.

---

# Part 2 — ADR-022 to ADR-027 (2026-11-16)

The user restated the product: **the group watches streaming sites, not downloaded files; the app must be free
forever, account-free, and need no server anybody has to run or rent; the host starts a program for the evening,
shares one link, and closes it afterwards.** ADR-022 to ADR-027 record what that changes. Where they contradict an
earlier ADR, the earlier ADR is amended in place and says so.

## ADR-022 — The desktop app is the front door; the add-on is a website-only fallback

**Decision.** The primary client is a Windows desktop app. It carries a browser window built on the engine Windows
already ships (WebView2 — the same engine as Edge, present on effectively every Windows 10/11 machine) and blocks
ad and tracker requests at the network level. The browser add-on is a later, *narrower* client: website mode only —
navigate the tab to the room's page, sync it, carry chat.

**Why.** Four of the riskiest problems in the add-on plan disappear entirely, because we own the browser instead of
negotiating with someone else's page: the chat panel that gets lost when a site goes fullscreen (spec §10.6), the
site's keyboard shortcuts stealing the chat input, strict page policies blocking our styling, and the background
worker being killed mid-film. Ad filtering is a product requirement on these sites, and an app is where that
belongs — an add-on cannot block ads for someone who does not already run an adblocker. It also avoids asking five
people to install a browser extension, which two of the major browsers make awkward.

**Rejected.** (a) Add-on first (ADR-015's original plan) — keeps all four problems and does nothing for ads.
(b) Electron — ships a whole browser per friend, ~10× the download, and is the shape ADR-014 rejected. (c) A web
page alone — cannot touch another site's player (ADR-006).

**Cost.** Windows first; Linux and Android are later ports, and there is no phone path for the add-on. Shipping an
unsigned Windows program has its own friction (SmartScreen warnings), and there are now two clients to keep in
step rather than one.

**Amends.** ADR-014 (no Electron) still holds: we are not shipping a browser, we are borrowing the one already
installed. ADR-015 (one codebase, two manifests) survives as the *fallback* client's rule.

> **Amended 2026-11-20 (ADR-034):** the window is created by a small .NET WinForms host, and the product logic runs in
> a Node sidecar that host spawns. WebView2 is still the engine and is still not bundled.

> **Amended 2026-11-22 (ADR-041/042):** `portable` still borrows the engine Windows already has; `portable-full`
> carries a fixed WebView2 runtime so a machine without one can run. That is still a runtime, not a browser: no page is
> shipped and nothing is rewritten in C#.

---

## ADR-023 — Free and accountless: direct connections with automatic router opening

**Decision.** Every running app asks its router to open one high-numbered port (UPnP/NAT-PMP), learns its own
public address, and puts that address in the invite link. Members connect **directly to each other** over plain
WebSocket on those ports. No paid tunnel, no rented server, no third-party meeting service, no accounts, no
WebRTC/STUN/TURN.

**Why.** It is the user's stated requirement, and it is sufficient because of what travels: only chat and
play/pause/seek — kilobytes per second — never video, because in website mode every app streams from the site
itself. The earlier blocker (see the tunnel research in `research.md` §27) was bandwidth, and bandwidth is not on
this path. Dropping WebRTC also drops NAT traversal *as a negotiation problem*: one side has an open door, the
other dials out, which is what NAT is built to allow.

**Rejected.** Tailscale (an install per friend), Cloudflare Tunnel (its terms forbid unpaid video serving — moot
here, but it also needs an account and a domain), ngrok/zrok free tiers (volume-capped), a public rendezvous
service (someone else's uptime, explicitly rejected by the user), and paste-it-back handshakes (three clicks per
person per evening).

**Cost / risk.** Two classes of connection cannot host at all: routers with UPnP disabled, and ISPs that put
several premises behind one shared public address (CGNAT). No code fixes either; the answer for that person is a
VPN or a rented box, both of which the user has ruled out. Plain HTTP on an open port also means chat is readable
by anyone on the path, and the room code is the only secret. **E1 settles how much of this bites the real group
before anything is built on it.**

> **Amended 2026-11-17 (E1 result):** UPnP being available is **necessary but not sufficient**, and the owner's own
> connection proved it: the router opened a port on request, but the provider NATs the whole line, so there is no
> public address for anyone to reach. That connection cannot host, full stop. The decision below therefore holds
> only for members whose provider gives them a real address; the host role has to fall to one of those, and the app
> must test its own reachability at start and say so plainly. If no member qualifies, this ADR is reopened — the
> candidate being a funnel for the control channel only, which is cheap because no video travels on it.

---

## ADR-024 — Website mode is peer-to-peer, and the room outlives its owner

**Decision.** In website mode every app holds a direct connection to every other app. Room state is replicated;
exactly one app holds **authority** at a time (ADR-002 survives intact), and authority passes to another connected
app when the owner leaves or goes silent. Local-file mode is the deliberate exception: that room dies with the
owner's app, because the owner holds the only copy of the bytes.

**Why.** In website mode the film has nothing to do with the room — each app is streaming from the site — so
losing the app that holds authority changes nothing on screen. That is what makes "no interruption" true rather
than aspirational, and it is why the user's answer is implementable here and not in file mode. Replicating the
room also means a late joiner can be told the room's state and chat tail by any member, not just by one.

**Rejected.** (a) A central relay — needs an account or a server to run, and reintroduces exactly the single point
of failure the user wants gone. (b) Room dies with the owner in website mode — the thing being corrected.

**Cost.** Authority transfer, mesh upkeep and admitting new members are real distributed-systems work; a few
hundred milliseconds pass while authority moves, invisible only because no video depends on it. This is the single
largest piece of engineering in the project and it is deliberately sequenced after a working single-authority
version (ADR-027).

**Amends.** ADR-002 (one server-authoritative timeline) becomes "one *app*-authoritative timeline": the authority
is a role, not a machine. ADR-005's WebRTC transport is dropped — the mesh runs on plain WebSocket. ADR-016's
promotion rule becomes authority transfer with no vote.

---

## ADR-025 — Everyone controls; "owner" and "host" are different words

> **Amended 2026-11-20 (ADR-030):** the shared-control rule is **reversed**. Control is host-only by default and
> delegable, and personal preferences (mirror, sub/dub, audio, subtitles, volume) are never broadcast. The
> owner-versus-host distinction below survives unchanged, and so does the reasoning about why two words are needed.

**Decision.** Any member may change the page, the film, play, pause, seek, and pick their own subtitles. Two words
do different jobs:

- **Owner** — the member whose app is serving local file bytes. Cannot be handed over. If they leave, that room
  ends.
- **Host** — whoever currently holds room authority. Moves automatically, by rule, with a notice; nobody votes.

**Why.** The user's requirement is shared control, so the old `controlMode: 'host' | 'everyone'` switch (ADR-011)
is removed rather than defaulted. Splitting the words is what lets "closing the program ends the room" and "the
room survives the host leaving" both be true without contradiction.

**Rejected.** (a) Keeping a host-only control mode — the user does not want one. (b) One word for both roles —
the source of the contradiction this ADR removes.

**Cost.** Two words to learn, and the roster must show both (who owns the media, who holds authority) or people
will not understand why a control moved.

**Supersedes.** The `controlMode` field and host-only mutation rules in ADR-011; the demotion story in ADR-016 is
replaced by ordinary authority transfer (a returning member is a normal member, as before).

---

## ADR-026 — Rescue relay: one stranded viewer, fed the stream the page already plays

**Decision.** A member who cannot load the site (geo-block, broken player, a dead mirror) can request a **rescue**.
The owner approves with one click. The owner's app then relays that *one* viewer's picture, using the stream the
owner's own app is already playing — read from the page it is running, not scraped from scratch. Everyone else
keeps watching from the site.

**Why.** This is the one failure the peer-to-peer model cannot fix by itself, and the user identified it as the
difference between a tool that works for four of five people and one that works for five. It costs one viewer's
worth of the owner's upload, adds no link-hunting (ADR-007 stays intact — we reuse a stream the owner's browser
legitimately has), and needs no new protocol beyond a request and an approval.

**Rejected.** (a) Relaying for the whole room — spends the owner's upload for everybody and puts them squarely in
the distributing position research §9 and §15 warn about. (b) A built-in link extractor — ADR-007. (c) Telling the
stranded person to sort out their connection — the honest but useless answer.

**Cost.** Only works where the page's stream is fetchable from the owner's machine outside the browser, which many
sites make hard by tying URLs to the browser session: that is **E6**, and it may fail on some sites. The owner's
upload carries that viewer for the whole film. And this is the single feature that makes the owner a distributor
of someone else's stream, which is the risk research §15 named — accepted by the user, recorded here.

---

## ADR-027 — Scope order: website mode first, files second

**Decision.** Build order: app shell with the browser window and ad filtering → website mode (page navigation,
sync, chat) → peer mesh and authority transfer → add-on fallback → local file mode (deliberately small) → rescue
relay → Linux.

**Why.** The user's watching is 80% streaming sites, so the file path is a *test rig*: it is the only way to prove
the sync engine without depending on someone else's website behaving. Everything that only serves files — the
folder library, transcoding, the HLS relay, audio languages — falls behind the website path.

**Rejected.** Library-first (the original M1/M2 order) — it would build the side dish before the meal.

**Cost.** The media library, Modes 1–4, subtitles-per-file and multiple audio languages are all now v2 or later,
and `open-questions.md` records that honestly rather than keeping them in a milestone table pretending otherwise.

---

## Research note — tunnels and public links (2026-11-16)

Recorded because it was checked and the answer is what makes ADR-023 viable on a zero budget. Sources and dates in
`research.md` §27.

- **Tailscale Funnel** gives a public `https://machine.tailnet.ts.net` URL that outsiders can open with no client,
  but the bandwidth limit is **unpublished and non-configurable** (a third party measured ~7 Mbit/s — right at a
  five-viewer budget, with no headroom) and it is still beta.
- **Cloudflare Tunnel** works and is free, but its Service-Specific Terms reserve the right to cut off unpaid
  accounts serving "video and other large files", and whether a Tunnel hostname counts as "the CDN" is not stated.
- **ngrok free** is 1 GB/month and **zrok** is 5 GB/day; one three-hour evening at 8 Mbit/s is ~11 GB. Both also
  add an interstitial page.
- Irrelevant now: none of these were needed once the control channel stopped carrying video.

---

# Part 3 — ADR-028 to ADR-030 (2026-11-20)

From eleven sites tested against the E2 spike. Nine of the eleven findings were UI failures rather than playback
failures, which is what makes them cheap to fix.

## ADR-028 - The app owns fullscreen; the page never takes the screen

> **Amended 2026-11-22 (ticket 23):** `ContainsFullScreenElementChanged` is not the mechanism this app uses, and it
> never fires for the page's own request. Measured 2026-11-22 (WebView2 157, ticket 23, both views, no permissions
> policy sent): the engine refuses the page's `requestFullscreen()` with `TypeError: Permissions check failed`, so
> there is no fullscreen element for the event to report. The app follows the page's *intent* across the bridge
> instead: the page posts `fullscreen` and the host logs `site: fullscreen=enter w=<n> h=<n>`. The decision this ADR
> makes - the app owns the layout, the page never takes the screen - stands unchanged.

**Decision.** When a page asks for fullscreen, the app intercepts it and refuses to leave its own window. Our own
control fills the window with the picture; the site's fullscreen button is wired to the same thing. Nothing the page
does can hide our UI.

**Why.** Measured across eleven real sites: **seven** took the whole screen and **four** stayed inside the window.
That inconsistency alone kills cinema mode (R28) and hides the chat, the roster and the "you are 4 s behind" warning
exactly when the film starts. Fullscreen is a layout decision, and only one party can own it.

**Rejected.** (a) Let the page decide (today's behaviour) — inconsistent, and the overlay is impossible.
(b) Chat in a separate always-on-top window — loses the in-page feel and fights Windows window focus.
(c) Hide our UI during real fullscreen and rely on keyboard shortcuts — unusable for chat.

**Cost.** A player that "looks wrong" when fullscreen is denied (rare; the picture simply stays in the window), and
one browser-specific hook each for Electron (`enter-html-full-screen`) and WebView2
(`ContainsFullScreenElementChanged`). Tested per site in E2; three sites already behave as if designed for this.

---

## ADR-029 — Player-originated changes are room commands, but only from the controller; and a player is always a
follower on load

**Decision.** Two rules that together make anime players livable:

1. **A player is always a follower.** Whenever a player element appears or reappears — page load, mirror switch,
   episode change, a site rebuilding its own player — the client never adopts the player's position. It commands the
   player to the room's expected position.
2. **What a controller's player does on its own is a room event.** Skip-intro is a seek; auto-next and clicking an
   episode in the site's list are page changes. A non-controller's player doing the same is accepted *locally*, not
   fought, and converges through the ladder and offset instead.

**Why.** These sites are full of scripts that move the playhead: skip intro, skip outro, auto-next, quality reloads,
mirror fallback. Either you fight them forever, or you make them room events. Making them room events is one rule
instead of per-site code, and rule 1 is what makes a mirror switch keep the time rather than restarting at zero —
including for whoever pressed the button.

**Rejected.** (a) Suppress all player-originated movement — the ladder then fights the page in a loop, and the
"skip intro" that everyone has enabled becomes unusable. (b) Broadcast every player movement including
non-controllers' — five people's mirrors produce five different skips and a seek storm.

**Cost.** A non-controller whose mirror skips at a different point drifts by that amount, permanently. That is a
*content* difference, so the honest fix is the offset (ADR-021) and its suggestion; the badge already catches the
case where it is unexplained.

---

## ADR-030 — Control is a role again; personal preferences never leave the window

> **Amended 2026-11-20:** room actions are now **staged** for five seconds before they take effect (ADR-032 as amended 2026-11-24: two seconds until then), so a
> misclick costs nothing; and control survives a reconnect and follows the host role (ADR-033). Everything below
> about *which* actions need control, and about personal choices never being broadcast, stands.

**Decision.** Split every action into two kinds:

- **Room actions** — play, pause, seek, choose the page, choose the film, choose the episode, and whether a
  skip is followed. These require **control**. The owner has it always; anyone may be granted it for the session,
  and the roster shows who has it. Room actions are staged for five seconds before they reach anyone (ADR-032 as amended 2026-11-24).
- **Personal choices** — which mirror or server, sub or dub, audio track, subtitles, volume, quality, sidebar or
  cinema. These are never broadcast and never touch room state.

**Why.** Two separate problems, one rule. A stray click on episode 7 dragging five people is a real annoyance; and
sub-versus-dub is a *preference*, so making it a room event would force one person's taste on everyone. It works
without special handling because each app has its own browser: switching to dub changes only that window, and the
per-member offset absorbs the runtime difference.

**Rejected.** (a) Everyone controls everything (ADR-025) — a misclick moves the room, and a personal sub/dub choice
becomes a group decision. (b) Host-only with no delegation — the host becomes the remote and cannot relax for a
minute. (c) Broadcasting source changes and letting each client ignore them — a broadcast nobody should act on is a
bug waiting to be mistaken for a feature.

**Cost.** One more role in the protocol and the roster, and a member who wants to skip the intro in a host-only room
has to ask. Worth it: the alternative is a room that reacts to whoever clicked last.

**Supersedes** ADR-025's control rule. Its owner/host distinction and its "everyone can see who is in charge" intent
both survive; only the rule that everyone may act is reversed.

---

## ADR-031 — Peer-to-peer plumbing is blocked by default

**Decision.** The app disables `RTCPeerConnection` in every page before the page's own scripts run, and offers a
per-site **Allow** switch. When a page tries to use it, one line appears: *"this site tried to connect directly to
other computers — blocked"*, with the reason and the switch. Nothing else changes; if a player genuinely needs it,
allowing takes one click and is remembered for that site.

**Why.** The user's stated preference, and the asymmetry justifies it: a blocked feature costs a minute of
confusion, while a page quietly uploading pieces of a film to strangers is the one pattern in this product that
produces cease-and-desist letters in Germany — uploads are traceable and monitored, whereas downloading is the same
exposure as watching on any such site. We cannot tell which pages upload without looking, and looking per site is
worse than blocking all of them and asking.

**Rejected.** (a) Allow by default with a notice — the notice arrives after the connection is already open, which is
too late for the thing being protected against. (b) Block silently — a player that breaks would look like our bug.
(c) Block with no override — a site whose player depends on it would have no answer.

**Cost.** A site whose *player* uses peer-to-peer delivery will not play until the member allows it, so the message
has to make that obvious. Measured context: only 1 of the 11 sites tested triggered it, and on that one the video
itself came over plain HTTPS — so what got blocked was something else on the page, which is exactly the case worth
blocking.

---

## ADR-032 — Room changes are staged for two seconds before they commit

> **Amended 2026-11-21 (ADR-029, `spec.md` §5):** while a change is pending, the initiator's page is a **preview** —
> not a follower yet. No realignment runs against it, it sends no position reports, and no room command reaches it
> until the window ends. On Cancel it navigates back and realigns to the committed room; on commit it becomes the
> page, and the room's playback resets to position 0, paused (§5, `pageCommitted`).

> **Amended 2026-11-24 (phase 6, R31):** the stage is **five seconds**, not two — the owner found two too short to
> catch a misclick. The countdown, the Cancel and the commit order are unchanged. The title and the "Why" paragraph
> keep the original number because that is the argument they were written with.

**Decision.** A room action from a controller (change page, episode, or film) does **not** reach anyone immediately.
The authority holds it as pending for **5 s** (two seconds until 2026-11-24, phase 6: the owner found two too short to
catch a misclick; the countdown and Cancel are unchanged), showing the initiator a countdown with **Cancel**. If they cancel
inside the window, nothing happens and nobody else ever learns it did — not a flicker, not a toast. If they don't,
the change commits and every app navigates as one.

The initiator **does** see their own new page immediately, so they can tell whether they picked the right episode.
Only the other members wait; their screens stay exactly where they were until the commit.

**Why.** The user's reasoning, and it is the right way round: an undo-and-revert is visible even when it is undone —
five people watch a page load, a player appear, and then vanish. Staging means the mistake is invisible because it
never happened outside one window. Two seconds is long enough to catch a misclick and short enough that nobody
notices the delay when the click was intended.

**Rejected.** (a) Apply immediately, then offer Undo — the revert is visible and the room's position for the aborted
page is briefly nonsense. (b) Ask for confirmation before committing — a dialog on every episode click is
unbearable when clicking through six episodes. (c) No protection at all — one stray click moves five people.

**Cost.** Two new protocol states (`setPage` carrying a staging delay, and `cancelPage`), a pending entry the
authority must expire if the initiator disconnects mid-window, and a rule for what happens when two controllers
stage different pages at once: the later request replaces the earlier pending one, and the first initiator's
countdown is cancelled with a toast.

---

## ADR-033 — Control survives a reconnect and follows the host role

**Decision.** Three rules, so nobody is ever locked out of their own room:

1. **A grant persists.** Control is bound to a member's stable id, which the app stores, so reconnecting — including
   after a crash, a lost connection or a browser restart — restores it. It is lost only if the member joins from a
   fresh install or a different machine, in which case they are a new member and must be granted again.
2. **Control moves with the host role.** When authority transfers (ADR-024), control transfers with it, so the room
   always has at least one person able to act.
3. **Anyone can claim it when nobody has it.** If no online member holds control — everyone who had it left — the
   roster shows **Take control** to every member, and the first to press it gets it. The roster shows who has it, so
   this is never a silent grab.

**Why.** Leaving the room with no controller is the one failure that makes the whole product feel broken: the film
keeps playing and nobody can pause it. The user named the popup option explicitly, and making it visible-but-available
is better than automatic promotion of a random member, who may be the person least able to pick the next episode.

**Rejected.** (a) Automatic promotion of the earliest-joined member — deterministic, but it hands the remote to
whoever joined first, which is not the same as whoever is willing. (b) Grants expire with the session — a Wi-Fi
blip would silently demote someone mid-film. (c) Owner-only control with no escape hatch — one person's crash
freezes the room.

**Cost.** A stable member id per install, one more roster state, and an edge case: two people pressing **Take
control** at the same instant resolve by the authority's arrival order, second one gets a "Sam got there first"
notice.

---

## Research note — filter lists (2026-11-20)

uBlock Origin's own filter lists are reusable, and using them does not make our app GPL: the lists are data, and
redistributing them with their notices is fine. **Bundling the uBlock Origin Lite *extension*** is the thing with
consequences — it is GPL-3.0, it needs MV3 support in whichever engine we embed, and Electron's extension support is
materially incomplete (its own docs still describe an MV2-era background script), so a failure in the spike would
prove nothing about WebView2. Accepted plan: our own blocker, driven by those lists (T30), with a separate later
spike for loading uBOL inside WebView2 as a quality upgrade (T38) once the real shell exists.

---

## ADR-034 — The window is a small .NET host around WebView2; the room stays in TypeScript

> **Amended 2026-11-21 (ADR-038):** the window holds **two** WebView2 controls - our page and the site - not one
> filling it. Everything else here stands, including "the host contains no product logic".
>
> **Amended 2026-11-22 (ADR-028):** the capability list below names `ContainsFullScreenElementChanged` for
> app-owned fullscreen. It is **not** what fullscreen uses. Measured 2026-11-22 (ticket 23, WebView2 157, both
> views, no permissions policy): the engine never grants the page's `requestFullscreen()`, so there is no
> fullscreen element and the event never fires. Fullscreen follows the page's bridge `fullscreen` intent instead,
> logged as `site: fullscreen=enter w=<n> h=<n>`. Every other capability in that list is unchanged.

**Decision.** The app is one install, one launch and one window, made of two processes that start and stop together:

- a **native host** — a .NET WinForms executable in `host/`. It owns the window, one WebView2 control filling it, the
  request filter, fullscreen interception, the native "pick a file" dialog, and the lifetime of the other process. It
  contains no product logic.
- a **sidecar** — Node 24 + TypeScript in `src/`. It owns the room, the protocol, chat, the clock, the position model,
  the drift ladder and file serving. **One listener, two jobs**: it serves the page the window loads and it accepts
  the room's connections, on the port opened at startup and bound to all interfaces, because a guest has to reach
  it. The window itself loads that page from `127.0.0.1`.

The engine is WebView2, the runtime Windows already has (ADR-022), so nothing is bundled and ADR-014's ban on
shipping a browser stands.

**Why.** ADR-012 and ADR-022 together leave exactly one question open: which process creates the native window.
Every capability M2 depends on is a first-party API of the .NET WebView2 control — `AddWebResourceRequestedFilter`
in its three-argument form with `WebResourceRequested` for ad filtering (R20; the two-argument form is documented as
"does not behave as expected for iframes", and 6 of the 11 sites in E2 keep the player in a cross-origin frame),
`ContainsFullScreenElementChanged` for app-owned fullscreen (ADR-028), `AddScriptToExecuteOnDocumentCreatedAsync` —
which runs before any page script and in child frames too — for blocking peer-to-peer plumbing (ADR-031),
`PermissionRequested` for granting the page the `Autoplay` permission so a scheduled start is not refused by the
autoplay policy (§14), and `ExecuteScriptAsync`/CDP for driving the player (M2). The alternative hosts are thin
cross-language wrappers over the same runtime — the Go, Rust and C++ "webview" libraries, Python's pywebview — which
expose a single JS-evaluation bridge and none of those hooks. Choosing one of those is choosing to reopen this
decision at M2. .NET is the supported path, it installs per user with no admin rights and no system change, and its
surface here is a few hundred lines that one person can read in a sitting.

> **Amended 2026-11-21 (measurement, no new decision):** the `PermissionRequested` lever above is **not** a lever we
> have. Measured on WebView2 runtime 157 (phase 1, ticket 01): it does not fire for autoplay, so nothing in the app can
> grant the page the `Autoplay` permission that way. The rest of the capability list stands. What does let a scheduled
> start play (`spec.md` §14) is unmeasured; when it is measured, this line names it.

> **Amended 2026-11-26 (ticket 184):** a start that fails says which of the two faults it is. No engine at all keeps
> the missing-runtime sentence, which names both ways to get one. An engine that is installed and still will not start
> names the profile folder it could not use and asks the person to close any other Watch Party window - the old
> "missing or blocked" sentence named a cause that was not there (runtime 157.0.4341.46 was installed and found) and
> left nothing to do. The window also lets go of its views before drawing that sentence, so a failed start does not
> hold the profile the next launch asks for. And a developer profile is a profile like any other: it sits at
> `<Debug folder>\profile-dev-<port>`, beside the binary that uses it, not in `%TEMP%` (ADR-043) - measured
> 2026-11-26, WebView2 157 refused a user-data folder under `%TEMP%` with `0x8000FFFF` while the same folder inside
> the app folder opened the page. The packaged copy's `<exe folder>\profile` is unchanged.

**Rejected.** (a) Electron — banned twice (ADR-014, ADR-022) and it ships a browser to every friend. (b) A webview
wrapper in Go or Rust — one binary and a smaller footprint, but no request filter, no fullscreen event and no
pre-page script hook, so M2 would have to bypass or replace it. (c) Python with pywebview — the same wrapper limits
plus a third language in a project whose sync maths is copied from TypeScript references. (d) The whole app in C# —
reverses ADR-012, loses the reference implementations the ladder and clock filter are lifted from, and splits the wire
types away from the add-on. (e) WPF instead of WinForms — viable and better at high DPI; rejected because the native
layout is one WebView2 filling the window, so a richer layout system buys nothing, and it stays the fallback if DPI
scaling bites.

**Cost.** Two runtimes and two processes per person. The non-functional target "≤ 300 MB resident with a page open"
becomes a number to measure rather than assume, and it is the risk this decision carries. The build is `dotnet build`
plus `npm`, so `npm run dev` is an orchestrator rather than a compiler. And two lifetimes must be supervised: if the
window closes the sidecar must die, and if the sidecar dies the window must say so instead of showing a dead page.

**Amends.** ADR-012 (Node + TypeScript + `ws` + Vite/Svelte) is unchanged and now names where it runs: a sidecar on
loopback. ADR-022 (WebView2, not a bundled browser) is unchanged and now names who creates the window.

---

## ADR-035 — M1's dependency list, and the five things it deliberately does not add

> **Amended 2026-11-21 (ADR-036):** two dev-only dependencies are added — `typescript` and `svelte-check`. Neither
> ships in the app, and neither replaces anything in this list: `node --test` is still the test runner and the
> "no test framework" answer below still holds.
>
> **Amended 2026-11-21 (ADR-037):** type declarations only — `@types/node`, `@types/ws`, `vite/client` — are added
> and are not counted against this list. They ship nothing and change no runtime.
>
> **Amended 2026-11-22 (ADR-040):** the licence constraint at the foot of this ADR binds **code** dependencies, and a
> shipped **data file** may be share-alike: `data/ad-hosts.txt` is CC BY-SA 3.0, carrying its attribution and licence
> in the file, because share-alike binds the list and not the program that reads it. "Permissive" is unchanged for
> every dependency in the table, and the GPL/AGPL refusal is unchanged.

**Decision.** M1 adds the following and nothing else. Already decided elsewhere and only cited here: `ws`
(ADR-012), TypeScript (ADR-012), Vite + Svelte + `@sveltejs/vite-plugin-svelte` (ADR-012), hls.js (not loaded before
v2, ADR-013). New in this phase:

| Dependency | Where | Why it earns its place |
| --- | --- | --- |
| `@achingbrain/nat-port-mapper` | npm, sidecar | UPnP-IGD, NAT-PMP and PCP in one maintained client. ADR-023 requires the app itself to open the port and learn its own address; hand-rolling SSDP discovery plus SOAP against routers that implement the standard badly is the classic way to lose two evenings. |
| `Microsoft.Web.WebView2` | NuGet, host | The window's engine, and the only source of the request-filter, fullscreen, permission and script APIs ADR-034 depends on. |

**Deliberately not added, with the cheaper answer each time:**

- **No test framework** (`vitest`, `jest`, `mocha`). Node 24 runs TypeScript directly and ships `node --test`, so
  `npm test` is a Node flag rather than a dependency tree. The tests are pure functions and sockets; nothing needs a
  DOM.
- **No HTTP framework** (`express`, `fastify`). The sidecar serves one page and one file: `node:http` plus `node:fs`
  is smaller than any framework's own dependency tree.
- **No `mime` package.** File mode plays MP4/WebM and refuses the rest (R11, §7.2), so a four-entry map
  (`mp4`, `m4v`, `webm`, `mov`) is the whole requirement.
- **No `uuid` package.** `node:crypto` has `randomUUID`.
- **No database, ORM or state library.** The room is in memory and stays there (ADR-010).

**Why a list and not a rule.** AGENTS.md rule 5 requires an ADR for every new dependency; this is that ADR for the
phase, so a reviewer can check the phase against one table instead of reconstructing intent from `package.json`.

**Cost.** `nat-port-mapper` brings a few transitive packages, and it is the only dependency whose failure is
environmental — a router that ignores UPnP. If it cannot be made to work, the fallback is a hand-written SSDP/SOAP
client, not an unmaintained substitute; that fallback is a code change, not a new ADR.

**Constraint carried into every ticket.** Permissive licences only. A dependency's licence is read before it is
installed; anything GPL or AGPL in the app itself is refused. The uBlock-extension GPL question is separate and later
(T38).

## ADR-036 — A dev-only typechecker, and a pre-commit hook as the only guardrail

**Decision.** Two `devDependencies` — `typescript` and `svelte-check` — plus one script (`npm run check`) and one
committed hook (`.githooks/pre-commit`, activated with `git config core.hooksPath .githooks`). The hook runs
`npm test`, and runs `npm run check` once the baseline is green. Neither dependency is imported by the app; neither
reaches a build that ships.

> **Amended 2026-11-21 (ADR-037):** "and nothing else" reads as "nothing else with a runtime shape". Type
> declarations (`@types/node`, `@types/ws`, `vite/client`) are added under ADR-037, because the checker cannot see
> the standard library without them. The first measurement on the real tree was 127 errors, so the hook shipped with
> `npm test` alone and T8a2 owns a green baseline.

> **Amended 2026-11-26 (ADR-036):** the hook's body is a Node script (`#!/usr/bin/env node`, ESM because the repo's
> `package.json` is `"type": "module"`), not `#!/bin/sh`. Git starts the interpreter named in the shebang directly, and
> a node body has no `sh` in its path: the agent's confined shell could not start `sh.exe` (`sh.exe: couldn't create
> signal pipe, Win32 error 5`), so nine commits in one afternoon were made with `--no-verify` after the three steps were
> run by hand. The hook's location, its activation (`git config core.hooksPath .githooks`), the three steps and their
> order, one line per passing step, the full output on refusal and the scanner-missing skip are unchanged. The
> `.gitattributes` rule (`.githooks/* text eol=lf`) still holds: a CRLF shebang breaks the interpreter line.

**Why a typechecker, and why not the two things already here.** Tests run TypeScript by *stripping* the types
(Node 24) and Vite transpiles it the same way (esbuild): both delete the annotations without ever reading them, so a
wrong type is invisible until the line runs, and a renamed field is invisible until it is `undefined` at runtime. The
build is not a check either — it is run by hand, and `npm test` covers `tests/unit` and nothing else. `tsc --noEmit`
alone would still miss the `.svelte` files, which is most of what a player is; `svelte-check` wraps `tsc` and reads
the markup, so it is one command instead of two. `typescript` is its peer dependency, not a second tool.

**Why a hook, and why nothing else.** There is no remote and no CI. A commit is the only moment where a mistake is
cheap to catch, and on this project it is also the moment where a mistake is cheapest to *see*: the tree is clean
apart from the work under review. Without the hook, "does it still typecheck?" is a question someone remembers to
ask, which is the same as not asking it.

**The cost, stated so nobody is surprised.** A hook that takes long gets `--no-verify`'d, and then it protects
nothing. So the hook's budget is about 20 seconds and it deliberately excludes `npm run test:integration` — that
suite is 23 s and climbing and it opens real sockets. The consequence is unavoidable and should be written down: the
protocol's integration assertions are **not** guarded by the hook, only by whoever runs them. If that turns out to
bite, the fix is a faster suite or a second hook for the files that need it — not a slower hook.

**Why not a CI service.** There is no remote to run a pipeline against, and a hosted runner is a paid service
(ADR-023). Same answer if a remote appears later: the hook stays the local gate, and CI becomes a second copy of the
same two commands.

**What this does not decide.** The baseline may not be green. A typechecker added to a fourteen-ticket tree finds
things, and those things are tickets, not a licence to edit whatever turns red on the way past. If the first run is
red the hook ships with `npm test` alone, the errors are recorded, and a green baseline is its own ticket.

**Refused, with the cheaper answer each time.** `vitest`/`jest` with type-aware assertions — `node --test` stays
(ADR-035). `husky` — it is a dependency that installs a shell script; `core.hooksPath` is a git setting and the hook
is a file in the repo. `lint-staged` — the suites are small enough that running both whole is under the budget, and
a partial run is a way to miss the thing that broke.

## ADR-037 — Type declarations for what is already installed are not dependencies

> **Amends ADR-035** and **ADR-036**: `@types/node`, `@types/ws` and the `vite/client` type entry are permitted,
> dev-only, and do not count against either list.

**Decision.** The typechecker added in ADR-036 may be given the compiler's description of what the app already
imports: `@types/node` for `node:http`/`node:fs`/`node:crypto`, `@types/ws` for `ws` (ADR-012), and `vite/client` for
`import.meta.env` (ADR-012). `@types/node` tracks the runtime's major version, not the package manager's latest.

**Why these are not the thing ADR-035 refused.** A `@types/*` package emits no code: it is `.d.ts` files read only by
the checker, and `npm ls --omit=dev` does not change. ADR-035's argument is about what the app ships and what a
person has to audit; a declaration adds neither. Refusing them would have meant refusing to let the checker see the
standard library.

**Why not the cheaper answers.** Excluding the tests from `tsconfig.json` and leaving the sources alone was the other
option: 79 of the 127 errors measured on 2026-11-21 are `Cannot find name 'node:…'`, which no amount of narrowing
makes correct. Adding `// @ts-nocheck` to the files that import `node:` is the same move with extra steps, and it
turns a check into decoration — which is what ADR-036 exists to avoid.

**What this does not decide.** Whether the genuine strict-mode errors (about 30, measured on 2026-11-21: `possibly
null`, a `.unref` on a number, implicit `any` in tests) are fixed or suppressed. They are T8a2. Suppression is
allowed only as one line at the site with a reason next to it; a project-wide relaxation, or a `strict: false`, is
not.

---

## ADR-038 — The window holds two views: our page, and the site

> **Amends ADR-034:** the window contains **two** WebView2 controls, not one filling it.
>
> **Amended 2026-11-22 (ticket 37, the user's answer):** a room that holds a file **may take a page**. The address
> bar stays available while a file plays, so that transition has a route, and the page commit clears the file in
> every window: `media` becomes `null` in the same handler that sets `roomPage`, so `spec.md` §4.2's invariant holds
> from that moment and the site view is the one that is shown and navigated.
>
> **Amended 2026-11-22 (ticket 41, what the stage shows):** while a room that holds a file stages a page, the room is
> still a file — `page` is `null` and `media` is set — so the staged page is a window-local preview of a page the room
> has not committed, not a second kind of media. For the stage's five seconds (two when this was decided on 2026-11-22) both views are up: the site view appears
> at once and the host docks the app view to its page-mode width, so the file's picture is briefly a 380 px column.
> A commit clears the file (above) and the layout stays; a cancel hides the site view and the file room is as it was.
>
> **Amended 2026-11-23 (ADR-047, ticket 103):** the sentence "the file's picture is briefly a 380 px column" no longer
> describes what happens. For the stage's five seconds (two when this was decided on 2026-11-23) the host docks the app view and sets `data-panel="chat"`, so the
> page draws its chat column and no picture; the file's picture is hidden for that stretch rather than squeezed
> into a column. The rest of this amendment stands.

**Decision.** The window is a native frame around two WebView2 controls, with a layout the host owns:

- **The app view** — our Svelte page, still served by the sidecar and loaded from `127.0.0.1`. It is the room's only
  client: chat, roster, controls, and the address bar across the top. It may not navigate — `NavigationStarting`
  cancels anything that is not the sidecar's own origin — and it keeps the file picker's `WebMessage` bridge to
  itself.
- **The site view** — a second control, its own engine, loading whatever page the room names. The request filter, the
  fullscreen interception and the popup policy apply to this view alone. Nothing of ours runs in it except one bridge
  script, injected by the host with `AddScriptToExecuteOnDocumentCreatedAsync` so it exists in every frame — including
  the cross-origin player frames E2 found on 6 of 11 sites — before any page script.
- **The host** — a relay and a layout, still no room logic. Site to app: the bridge's `WebMessageReceived` is re-posted
  to the app view together with the source frame's URL. App to site: a command is posted to the site view and handed to
  the bridge, which applies it to the elected player.
- **With no page, there is no site view.** File mode hides it and the app view fills the window exactly as in M1: a
  room is either a site or a file, never both (§4.2), and the file-mode picture must not be squeezed into a column.
  The one exception is the staged preview described above: the room is still a file, the site view appears at once,
  and the column lasts only until the commit or the cancel.
- **Popups never open a window.** A site view's `NewWindowRequested` is cancelled and the app says so in one line
  naming the host it asked for (R37). On E2's sites the popup was an ad; a second window would also be a second
  browser we cannot sync.

**Why two views and not one.** ADR-006 already forbids syncing a third-party page through an iframe we host: our page
cannot script a cross-origin frame, and proxying the HTML breaks on CSP. A single top-level engine cannot show our UI
and the site at once either. Injecting our Svelte UI into the site's DOM would put our state, our CSS and our key
handling inside a page we do not control, where one site's script or CSP can break the sidebar for the evening.

**Why the app view stays on loopback.** It keeps all room logic in TypeScript (ADR-034). It closes a leak M1 never
looked at: `WebMessageReceived` never reads `e.Source`, so any document the engine loads could send `pick`/`probe`;
with our bridge confined to the app view's origin, a third-party page has no bridge to abuse. And it makes R19's
"typing in chat never pauses the film" free — focus in the app view cannot reach the site's keyboard shortcuts.

**Rejected.** (a) One engine with our UI injected into the site — the sidebar inherits the site's CSP, DOM and script
faults. (b) Our UI in an iframe over the site — forbidden by ADR-006 and unscriptable. (c) An address bar drawn by
WinForms — R29 wants a right-click menu and a visible Paste button, which the HTML bar gets for free, and native
widgets would put product logic in the host. (d) A second browser or process — banned by ADR-022.

**Cost.** Two renderers per person, so the "≤ 300 MB with a page open" target now counts both, and it becomes a number
to measure. Every command crosses three hops (site → host → app → sidecar) — fine, because only reports and commands
cross it, never pixels — but it is one more place for a message to be dropped, so the bridge's messages carry a
sequence number. Two controls also mean focus, z-order and lifetime are now the host's problem in a way one control
never was.

**Amends.** ADR-034: "one WebView2 control filling it" becomes two. Its other rules stand unchanged — the split, the
relay and the fullscreen toggle are window mechanics, not product logic.

## ADR-039 - The room may sit a quarter of a second apart

**Decision.** The correction ladder's deadband is **0.25 s**, not the 0.1 s borrowed from Syncplay (`spec.md` §6.3): a
window within a quarter of a second of `expected` is left alone, and the rate nudge runs from 0.25 s up to 4 s - the
1.5-4 s band nudges too - and the nudge stops when the gap is back under 0.25 s. The four-second hard seek, the
"more than 1.75 s behind" trigger, the two
consecutive bad reports, the once-per-five-seconds limit and the restore to `playbackRate = 1` are unchanged.

**Why.** Measured on 2026-11-21 (phase 1): a healthy window sits 0.086-0.112 s behind, so with a 0.1 s deadband ordinary
jitter alone puts it over the line and it is rate-nudged while nothing is wrong - the picture changes speed for no
reason a person asked for. Asked how far apart two windows may be, the user answered a quarter of a second is fine.
A quarter covers the jitter and still corrects what a real stall needs.

**Rejected.** (a) Keep 0.1 s - it is Syncplay's number, tuned for a different client measuring a different delta; here
it fires on jitter, which costs more than the few milliseconds of accuracy it buys. (b) 0.5 s or a full second - the
user allowed it ("it doesn't have to be perfect"), but the room then sits that far apart in normal running, and the
correction that eventually fires starts from further away and lasts longer. Nothing is gained once jitter is covered.
(c) A deadband adapted to each client's measured jitter - better in principle and unmeasurable here until E5 says how
much mirrors differ.

**Cost.** The room is looser by design: two windows a quarter second apart are in step. Nothing else moves; the ladder's
other constants and the wire format are untouched.

> **Amended 2026-11-28 (ticket 198):** the deadband stays 0.25 s, but the nudge now stops **at half of it** - 0.125 s,
> derived from `CORRECTION_DEADBAND_SECONDS` rather than added as a second number - because the phase-7 gate found a phone
> parked *on* the line: `drift=-0.255` ... `-0.277` with `strikes=10 action=nudge`, each nudge ending on its first 200 ms
> watch tick, since stopping "under 0.25 s" let a corrected client land at about 0.24 s and fall 5-30 ms back over it. With
> the half-deadband stop the same phone sits at 0.09-0.13 s, the nudge fires two or three times instead of endlessly, the
> picture runs 5 % fast for about 7 s and then holds 1x, and no desktop client is nudged at all. The decision above still
> holds in every part except that stop point: a client inside the quarter second is left alone, and the ladder simply aims
> inside it instead of at its edge.

---

## ADR-040 - The ad list is data from EasyList, under a share-alike licence

**Decision.** The app ships one data file, `data/ad-hosts.txt`: 43,021 bare hosts, each the `||host^` rule of
EasyList's `easylist_adservers.txt` at commit `f49a0ca` (2026-11-21), from
`https://raw.githubusercontent.com/easylist/easylist/master/easylist/easylist_adservers.txt`. The host's request
filter reads it (R20, ADR-034) and treats a bare host as that host and its subdomains. The file's first line carries
the source, the commit and the licence, so the provenance travels with the data.

**Licence.** EasyList is dual-licensed **GPLv3 or CC BY-SA 3.0**. This project takes **CC BY-SA 3.0** for the list.
ADR-035's licence constraint is met as **amended 2026-11-22 by this ADR**: "permissive" binds code dependencies, a
shipped data file may be share-alike when it carries its own attribution and licence, and neither the GPL nor the
AGPL refusal moves. The list is redistributed as a data file with its attribution and licence in the file, which is
what CC BY-SA asks of a redistributed copy. Share-alike binds the list itself, not the program that reads it: a
request filter that loads a host list creates no adaptation of the list.

**Why not the alternatives.** (a) Hand-write a list: 43,021 hosts is maintenance nobody here will do, and a short
list blocks few ads. (b) Ship no list: R20 is unmet, and ads in the site view are the first thing the user sees.
(c) uBlock Origin's lists: GPL, and ADR-035 leaves that question to T38 - the same obligation with a heavier file.
(d) Fetch the list at run time: a network call at every start, the no-account promise bent, and the licence question
just moves to the user's machine.

**Cost.** A share-alike obligation on this one file: wherever it is redistributed it keeps its attribution and
CC BY-SA, and a list derived from it stays CC BY-SA. If that ever becomes unacceptable the list is replaceable data -
one file, one header, one test - not an architectural dependency. Refreshing it means a later download at a newer
commit with the header's date and sha updated.

## ADR-041 - The app ships as one portable executable; the browser engine is the only dependency it does not carry

**Decision** (the user's, 2026-11-22). The app ships as a single executable per build, for Windows 10/11 x64, run from
any folder or removable drive: no installer, no administrator rights, no separate runtime to install. Everything the
app itself needs is inside the file - the .NET runtime, the Node runtime that runs the room logic, and the built page.
The browser engine is the one exception, and there are **two builds**: `portable`, which uses the WebView2 runtime the
machine already has, and `portable-full`, which bundles a fixed WebView2 runtime for a machine without it. Both are
built from the same sources and tested the same way; the second exists so the first's assumption can be measured, not
assumed. **No rework** is part of the decision: the room logic stays in TypeScript on Node, and Node is embedded in the
executable rather than replaced.

**Why.** The only way a friend watches tonight is a file they can run. An installer is a step someone can refuse, a
runtime download is a step that can fail on a hotel network, and .NET or Node being absent from a clean machine is
exactly the case a group of five will hit. Shipping two builds answers the one question we cannot answer from here -
whether WebView2 can be assumed - by measuring it on a machine that lacks it.

**Rejected.** (a) Rewriting the room's logic in C# so the whole app is one .NET program: it would delete the constraint
the user set (no rework), duplicate the timing maths that ADR-036 and `AGENTS.md` keep in one place, and buy nothing a
bundled runtime does not. (b) Installer-only, as §13 previously assumed: it needs trust and a click, and it cannot be
carried on a stick. (c) A single build either way: without the browser it fails on a stripped Windows install, and
with it, every share is ~300 MB for a machine that already had the engine. (d) A folder of files (exe, Node, page):
that is a portable install, not one file, and the user asked for one.

**Cost.** Roughly 140-170 MB for `portable` and about 300 MB for `portable-full`; two artifacts to test at each
release; and one behaviour to decide at build time - the `watchparty://` invite link is registered by an installer, so a
portable copy either writes that registration on first run (a small trace) or runs without one-click links. Nothing
else moves: the room, the page and the host keep their current shapes, which is what makes this M7 and not a rewrite.

> **Amended 2026-11-22 (ADR-042):** the `watchparty://` registration is not an installer's job, and there is no
> installer (the Decision above). ADR-042 leaves the registration exactly as it is: it is already rewritten on every
> start from the running executable's own path, and ticket 50 measured a packaged copy taking its own invite link back.
> The Cost paragraph's "decide at build time" is the state before that answer.




## ADR-042 - The portable build carries a payload and unpacks itself once into the user's folder

> **Amended 2026-11-22 (ADR-043):** the payload, the profile, the logs and any settings live in the exe's own folder, not under `%LOCALAPPDATA%`; a read-only stick is no longer a goal.

**Decision** (2026-11-22, forced by M7; ADR-041 is the decision above it). One build script produces all three
artifacts from the same sources. The `portable` executable embeds **one zip** holding a pinned Node 24 `node.exe`, the
sidecar's TypeScript sources with their production dependencies, the built page, the ad list and a `package.json`. On
first run the exe extracts that zip to `%LOCALAPPDATA%\watch-party\runtime\<version>-<hash8>\` - written to a temporary
folder and renamed, stamp last, so a rebuild of the same version cannot run the previous payload - and, from then on,
treats that folder as its program root: `node.exe` is `runtime\node.exe`, the page is `dist\`, the ad list is `data\`. The browser
profile and the host log live under `%LOCALAPPDATA%\watch-party\` as well, never beside the exe, so a copy on a
read-only stick still runs. Older runtime folders are pruned, best effort, on start. **`portable-full`** carries the
same payload plus the fixed WebView2 runtime package, extracted the same way and passed to the engine as
`BrowserExecutableFolder`; on Windows 10 the extracted folder also receives the two `icacls` grants Microsoft requires
for a fixed runtime. **A third flavour, `portable-debug`**, is built by the same script with the Debug host and the
development page: it is the only build whose DevTools endpoint and development log lines exist, so it is what the
two-window gate runs on. It is never handed to a friend. The `watchparty://` registration is left exactly as it is: it
is already rewritten on every start from the running executable's own path, so a portable copy points the scheme at
itself, and that copy is the only one a friend has.

**Why.** The host finds the repository by walking up for a `package.json`, starts the sidecar as `node
src/server/main.ts` relative to it, and the sidecar computes `dist\`, the bridge script and `package.json` from its own
module URL. Moving the folder is therefore the smallest change that keeps the room logic untouched, which ADR-041
requires. One zip rather than hundreds of embedded files keeps the build script honest (it can list what it packed)
and keeps extraction to one pass. Unpacking once per version rather than per run keeps start-up fast and lets a second
copy run beside the first. The measuring flavour exists because the two mouse-less seams (`WATCHPARTY_CDP_PORT`,
`WATCHPARTY_PICK_PATHS`) are compiled into Debug only, and the production page compiles its log lines out - without it
M7's own done condition ("passes the two-window gate") could not be measured from a packaged copy at all.

**Rejected.** (a) A Node single-executable application plus a bundler: a new build step, and `ws` and the NAT-PMP
package load modules in ways a bundler cannot follow; it also breaks "no rework". (b) The exe plus a loose folder of
runtime files: that is two things to send and a folder a stick cannot hold read-only. (c) Re-extracting to the user's
temp folder on every run: ~90 MB copied per start, and two copies would race over the same path. (d) Shipping the
payload as hundreds of embedded resources: no single manifest to check and a slower first run. (e) Turning the Debug
seams on in the Release build: that ships an open remote-control port to five friends. (f) Registering the invite
scheme only on first run with a prompt: it already works per user with no admin, and a prompt is a step a friend can
refuse.

**Cost.** About 90 MB of extracted runtime per version on disk (~350 MB for `portable-full`), a first run that unpacks
before the window appears, one pinned Node build and one fixed-engine cab downloaded at build time (build assets, not
dependencies the app imports), and three artifacts to build and test. The build is Windows x64 only, as R38 says.
## ADR-043 - The portable build is a folder, and nothing leaves it

**Date:** 2026-11-22. **Status:** current. **Supersedes:** ADR-042 in part (the location of the unpacked payload and the profile).

**Decision (the user's, 2026-11-22).** The portable copy is the exe **and the folder it sits in**. On first run the exe
unpacks its payload into `<exe folder>\runtime\<version>-<hash8>\` and runs from there; the browser profile, the host
log and any settings live in that same folder. Everything the app needs travels inside the file, and everything it
writes stays inside the folder: copy the folder and the state goes with it, delete it and nothing is left behind.

**What this reverses.** ADR-042 put the unpacked payload under `%LOCALAPPDATA%\watch-party\runtime\` and ticket 46 put
the browser profile under `%LOCALAPPDATA%\watch-party\profile-<pid>`. Both move into the exe's folder. A read-only
stick was a goal of ADR-042 and is now impossible by construction: the folder must be writable, so the friend's copy is
"a folder you can write in", never `Program Files`.

**Why.** A folder is what "portable" means to the user: hand one over, run it, move it, delete it. State under
`%LOCALAPPDATA%` outlives the folder, accumulates (13 profile folders had already built up), signs the host out of the
streaming site every evening because the key is a fresh pid, and makes "delete the app" untrue.

**Alternatives rejected.** (a) Payload beside the exe, profile in `%LOCALAPPDATA%` - the split the user rejected.
(b) A roaming profile under `%APPDATA%` - still outside the folder. (c) Unpack nothing and run from memory - Node cannot
run from memory and the engine needs a profile on disk.

**Consequences.** A first run in a read-only folder fails with one plain sentence, not a half-run. Two copies in one
folder share a profile; one folder is one installation. The .NET single-file loader's `%TEMP%\.net\` extraction and any
WebView2 writes outside the profile must be measured and either moved or recorded as the one documented exception
(ticket 46d).

**Recorded exception (2026-11-22, ticket 46d; measured).** The record this ADR asked for. The single-file loader
extracts the bundled native libraries **before `Main` runs**, so a process cannot redirect its own extraction: one build
writes two copies of `WebView2Loader.dll` (194,912 B each, 389,824 B) into `%TEMP%\.net\WatchParty-0.1.0-portable\<bundle id>\`,
once per build, and never again for that build - a second run added 0 entries, measured over five runs of two copies.
Nothing else escapes: `%LOCALAPPDATA%` gained 0 entries across a run, no `Microsoft\EdgeWebView` folder is created, and
every write the app itself makes is inside the folder. **This is the one documented exception.** It is accepted because
each alternative spends the single file: native libraries published beside the exe put `WebView2Loader.dll` (194,912 B)
next to it, and a launcher that sets `DOTNET_BUNDLE_EXTRACT_BASE_DIR` is a second file plus a re-exec on the friend's
machine. Stale bundle folders from earlier builds are not pruned - four (1,559,296 B) had accumulated on this machine -
and removing them would itself be a write outside the folder, against a directory the loader owns; Windows' own temp
cleanup is where that belongs.

---

## ADR-044 - The invite link is the key, and the room seats ten

**Decision.** A caller who arrives at the room's port with nothing but the address gets a gate page and no more: no
roster, no chat, no room state, no version. The link carries the room code and that code is the only credential; a
wrong one is refused, and repeated refusals close the door on that caller. Refusals have numbers, and both doors share
one book: five refused joins close a socket (`SOCKET_REFUSAL_LIMIT`); twenty refused joins from one address inside a
minute bar it for sixty seconds (`ADDRESS_REFUSAL_LIMIT`, `ADDRESS_REFUSAL_WINDOW_MS`), and a barred address is
refused for the whole sixty seconds even when it then presents the real code (`ADDRESS_BLOCK_MS`) - over the socket
and at the HTTP gate alike (`src/server/socket.ts:106-109`, `app.ts:8`). A visit that presents no code is never
counted. The room holds **ten** members, not five.

> **Amended 2026-11-23 (ADR-046):** the code also travels on the media URL (`/media/<id>?c=<code>`). That is how a
> guest's own window fetches the room's file; a request carrying no code, or a wrong one, is still refused, and
> `/media/*` is not exempt from the gate.

**Why.** The first release handed the room code to anyone who could reach the port (`GET /discovery` returned
`roomCode` and the whole invite link unconditionally), so an open port was a room with the key taped to the door -
one finding from the 2026-11-22 recon, recorded in `.scratch/phase-4-invite/spec.md`. The user's answer was the
cheapest correct one: the link already travels between friends, so make it the key rather than adding an identity
("no accounts" stands, ADR-030). Ten seats because the group is larger than the five the design was sized for, and
nothing on the control path scales with members: only chat and play/pause/seek travel, kilobytes per second
(ADR-023), so a tenth seat costs the host's uplink nothing measurable.

**Rejected.** Accounts, passwords and signed identities (ADR-030 stands: trolling in an invited room is a social
problem, and the recorded answer is a remove button, not a sign-in). A separate long token beside the code - it
doubles the thing a person has to keep, when the code is already in every link. Approving each newcomer by hand -
one interruption per friend per evening. Leaving the five-seat cap as a "constraint of the design": it was a
consequence of the sync maths being written for five mirrors, not a limit the code enforces for a reason.

**Cost / risk.** The gate page is one more screen and one more route to keep honest; a caller who never received the
link cannot be helped over the phone without reading six characters aloud, which is the intended friction. Ten
members widen the roster the page must draw and the chat tail the socket sends on join. The port is still plain HTTP
and chat is still readable on the path (ADR-023); this ADR closes the door, not the window.

## ADR-045 - The app speaks UPnP itself, from an ephemeral port

**Decision.** The app keeps `@achingbrain/nat-port-mapper` for NAT-PMP and stops using it for UPnP. Its own SSDP search
- one M-SEARCH with `ST: urn:schemas-upnp-org:device:InternetGatewayDevice:2` and one with `:1`, from a socket bound to
an **ephemeral** port - finds the gateway, and the app's own SOAP calls (`AddPortMapping`, `GetExternalIPAddress`,
`DeletePortMapping`) do the rest. No new dependency: node's `dgram` and `http` are enough.

**Why.** Measured on 2026-11-22 (ticket 66): the library binds UDP 1900 hardcoded
(`node_modules/@achingbrain/nat-port-mapper/dist/src/upnp/discovery.js:36-43`, `port: 1900` at `:40`; no override in its
public API; 4.0.5 is the latest published). Windows' SSDP service (SSDPSRV) already holds 1900 on every interface, so
the router's unicast replies never reach the app: the same M-SEARCH got **zero** answers on 1900 and one answer from an
ephemeral port, in the same minute, and `findGateways()` returned `gateways=0 waited_ms=6013`. That is the failure a
friend reported as eight silent seconds - the router was answering, and the app could not hear it.
`scripts/upnp-probe.mjs` reproduces both sides in one call, and it shipped with ticket 66.

**Rejected.** Patching or forking the dependency: its API exposes no port, so a patch pins us to a private copy of a
library to change one line, and the next upstream release re-opens it. Relying on NAT-PMP alone: routers that offer
only UPnP would never work, and NAT-PMP is absent on many. Leaving it and reporting "no router answered" for ever:
dishonest, because the router does answer, and `spec.md` §14 asks for the true reason.

**Cost / risk.** A hundred and fifty lines or so against a protocol with real variants across vendors; SOAP faults have
to be surfaced rather than swallowed; a mapping left behind must be removed when the room closes, or given a lease, so
a crashed run does not strand a port on a participant's router. It cannot be unit-tested against a router, so
`scripts/upnp-probe.mjs` is the instrument and every claim about it is a live measurement. NAT-PMP stays first because
it answers in a quarter of a second when it answers at all; the app's own UPnP search is the fallback.

## ADR-046 - The room's file travels with the code in its URL

**Decision.** The URL a window fetches the room's file from carries the room code: `/media/<id>?c=<code>`. That is the
same code, in the same `c` parameter the invite link uses on `/join`; no second credential exists. The gate admits
`/media/*` on that code exactly as it admits `/join`, and answers `403` to a request with no code or a wrong one. A
window already entitled through its `wp_key` cookie keeps working unchanged.

**Why.** ADR-044 closed the room's door by making the code the only credential, and the code arrives in the link. But a
guest's page is served by its **own** sidecar on `127.0.0.1`: it holds no `wp_key` cookie for the owner's origin, and
the media URL carried no code, so the door refused the film to a window that had already been let into the room. The
0.2.0 packaged gate measured it (2026-11-23, ticket 84): the guest joined in 104 ms, then sent 51 reports, every one
`readyState=0`, its player black, while the owner played. On the owner's own route the same URL answered `403` without
the key and `206` with it. Before ADR-044 the same run stayed in step for ten minutes (0.1.0, ticket 50b), so the door
did not protect the film - it removed it.

**Rejected.** Exempting `/media/*` from the gate: it puts the film behind nothing but an address, which is the room
code taped to the door again, and the media id is only a per-session id. A second token for media: two credentials to
keep in step for one link. Proxying the guest's media through its own sidecar: a second network path and a second copy
of the file's bytes for one person's eyes. A cross-origin cookie negotiation (a credentialed `fetch` that sets `wp_key`
on the owner's origin): a CORS surface and a fragile first-frame ordering for the same result.

**Cost / risk.** The media URL is a bearer URL: anyone who has it can stream the file until the room closes, exactly as
anyone who has the invite link can join. That is ADR-044's own bargain, stated here so nobody reads it as new. The
owner's page also requests `/media/<id>?c=<code>` now - one URL shape for the room's file.

---

## ADR-047 - The app has two screens, and the picture fills the window with the chat beside it

> **Amends ADR-038:** its layout sentences (the 380 px app-view dock, the file-mode picture not being squeezed, the
> staged preview's column) become the watching-screen rule below. Its two-view decision, the bridge, the request
> filter, the fullscreen interception and "the host contains no product logic" all stand unchanged.
>
> **Consistent with ADR-043:** the window's remembered size is a file **beside the profile** - the app's own folder in
> a packaged copy, the dev profile folder in a dev window - like the profile and the logs.
>
> **Amended 2026-11-23 (ticket 103, the tickets critic):** the room is **live from the sidecar's boot**, so the first
> screen is the room's front door rather than a pre-room state, and the screen predicate reads room state plus one
> window-local flag. The first screen carries the invite **in full**, including the router-failure card. Narrow adds a
> height rule. The address bar's Paste button **acts** as well as fills and sits inside its field, and both routes to
> something to watch are present at every moment. The column width is a CSS variable the host sets. The remembered
> size is per profile. A bare connection loss is **not** a room end: it keeps the watching screen with a lost-connection
> line, and rejoining is M3's business.

> **Amended 2026-11-24 (ticket 121, on the measurement ticket 112 found):** the client-width formula below is **not**
> what the page sees as `innerWidth`. Measured at 125% scaling: a 1142 px outer window is a 900 CSS px page while
> `ClientSize.Width * 96 / DeviceDpi` reads 899, so the flip sat one physical pixel low. While the app view fills the
> window the measure is therefore **`window.innerWidth`, read from the page**; the client-width formula stays the
> host's dock decision and the fallback for when the page cannot answer. The 900 constant, and the host's ownership of
> it, are unchanged.

**Decision.** The page shows exactly one of two screens, chosen by one predicate over room state and one flag the
window owns:

- **The first screen** — invite and join. It shows the host's room **in full**: the room code, the invite link and
  its Copy button, the raw address-and-code fallback, the same-network link, the router's state ("Asking your router
  to open a port…"), and when no public link exists the failure card with **Try again** and the manual port-forward
  instructions (`spec.md` §8, §14). Below them is the join box and the line a failed link leaves. It has no picture,
  no chat and no file picker.
- **The watching screen** — the room. Pressing **Start a room** switches to it at once (the user's answer,
  2026-11-23), so a new room's link is in the invite bar from its first second. A guest who arrives by a link that
  connects lands on it; a link that fails leaves the first screen showing the reason.

**The room is live before the first press.** The sidecar creates the room, its code and its invite when the app
starts, and the page connects to it on its first `/discovery` answer; nothing the person presses creates a room. So
**Start a room** is not creation — it is entering the room's own screen, and the first screen is that room's front
door, already live and already joinable. While the host sits on it the room does nothing else: a friend who joins
early lands on the watching screen and waits on an empty picture area with the roster, and the host's first screen
still says the link is live. The predicate is therefore `first` until the window has **entered** its room — by
**Start a room** for the host, or by a link or the join box for a guest — and `watching` after that; the flag resets
when the room ends. The page never invents a second room, and a window that joined someone else's room never shows an
invite payload of its own while it is in it.

**The watching screen's layout.** The picture takes whatever is left; the chat is a **380 px column on its right**
(the width the app-view dock already uses), with the address bar as the page's own top row **above both** (2026-11-24,
ticket 125), the invite bar as the column's first row under that bar, and the controls under the picture. The picture is
the site view in website mode and our own `<video>` in file mode, and the rule is the same in both:

- **Window 900 px wide or more** (the page's own width in CSS pixels, 2026-11-24 amendment): picture left, chat column right, invite bar
  on top of the column.
- **Window narrower than 900 px:** the chat column moves **below** the picture (in website mode the host docks the app
  view along the bottom; in file mode the page stacks them). It is never squeezed beside the picture. The picture is
  bounded to **at most 60% of the content height** so the chat always has room, keeps its 16:9 shape inside that
  bound, and the page itself never scrolls: only the chat's own list does.

**One threshold, owned by the host.** The app view is 380 px wide in website mode whatever the window is, so its own
width cannot say whether the window is narrow. The measure is **the app view's own `window.innerWidth`, asked of the page**, while the app view fills the window; the
client-width formula (`ClientSize.Width * 96 / DeviceDpi`) is the host's dock decision and the fallback for when the
page cannot answer, because it is a pixel low at a fractional scaling (2026-11-24 amendment). In page mode the measure
is the window's own width. **Amended 2026-11-24 (phase 6):** the host publishes the layout once the drag ends, not on
every `ClientSizeChanged` - during a live resize it resizes the two views and nothing else, because a drag awaited two
page scripts per pixel and the window lagged behind the mouse. On a settled resize the host sets
`data-layout="wide|narrow"` on the app view's root
element and docks its two views to match; the page's CSS reads the attribute for the **threshold** and carries no width
number of its own for it. A page with no attribute (a browser, a test) is `wide`.

> **Amended 2026-11-26 (ADR-055):** a page with **no host to ask** decides for itself from its own CSS width, and the
> fallback threshold lives in exactly one place in the page's stylesheet. A window host's attribute, when present, still
> wins; what changes is only who answers when nobody is there - a phone browser was `wide` before this line and got a
> 380 px column beside a sliver of picture.

**One column width, owned by the host too.** The 380 px lives in the host's dock today; a file-mode page needs the same
number and must not spell it a second time. The host sets `--chat-column: 380px` on the app view's root element beside
the layout attribute, and the page's CSS uses `var(--chat-column, 380px)` — the fallback is for a browser or a test,
not a second source of truth.

**What can be watched is chosen on the watching screen.** The address bar and the file picker live there; an empty room
shows an empty picture area, and **the bar above it** carries both routes (paste a page address, Open a file). The bar is
the page's own top row, a `<header>` above `<main>`: it spans the window whenever the page lays out the picture and the
column itself (file mode, and the empty screen), and when the host docks the app view as the chat column it is that
column's top row, above the invite bar (2026-11-24, ticket 125 - the shipped markup decides this, not a second panel). Nothing picks
media from the first screen. Both routes are present at **every** moment on the watching screen **in the owner's window** (a guest has no
file to serve, R11): a room playing a page still offers **Open a file**, and a room playing a file still offers the
address bar (ADR-038's 2026-11-22 amendment already lets a file room take a page). The address bar's **Paste** button both fills the field
and takes the room there in the same press — one press is a route, not half of one — and the button is drawn **inside**
the field's own box rather than beside it, so the bar costs no extra width. Enter and the address bar's right-click
menu keep working as R29 says.

**The host's dock wins.** When the host docks the app view as a column - website mode, and the staged-preview stretch
while a file room previews a page - it also sets `data-panel="chat"` on the app view's root element, and the page then
renders the chat column alone (address bar, invite bar, chat, roster, controls) with no picture. `data-panel="chat"`
**wins over** `data-layout`: the app view is the chat column at every window width, so a narrow page-mode window must
not draw a second, empty picture. Otherwise the page owns the picture-and-chat layout. The staged preview therefore
keeps its five seconds (two until 2026-11-24; ADR-038, R31) without squeezing a picture into a 380 px column.

**The invite bar** carries the room code, the link and one copy button, with the raw address and code one click
inside. It is a row of the chat column, not a second panel and not a modal, and it stays visible in fullscreen. A
guest's bar has no link to offer (the invite payload is the host's): it shows the room code and one line saying the
link is the host's to share.

> **Amended 2026-11-26 (ADR-054, R51), then again the same day (ADR-056):** the bar's invitation is **one plain
> address**, `http://<address>:<port>/join?c=<code>`, read as a chip beside the room code and copied by one **Invite**
> button that says on itself that it copied (and says so in words when the browser refuses), on the front door **and on
> every guest's bar** (tickets 185 and 192). The two forms this amendment first allowed - the `watchparty://` link and the
> plain address, each labelled, each with its own Copy - are withdrawn by ADR-056, and so is the sentence above that gives
> a guest's bar no invitation to offer: a guest's own address bar already holds the same address and the same code, so the
> invitation is not a secret the owner keeps.

**Room end.** A guest whose room ends returns to the first screen with one line saying so; the dead room's code and
link are cleared, and the window's **entered** flag is reset, so the first screen is that machine's own front door
again — its own sidecar's room, its own code and link. A bare socket close is **not** a room end: it keeps the
watching screen with one lost-connection line and no retry control, because a wifi blip must not cost the room and
rejoining is M3's (`spec.md` §6's "connection drops", T17). Only a `roomOver` frame the room itself sent ends a room.
The host's dead-sidecar page is unchanged: a sidecar that stops is a fault to report, not the end of a room.

**Window size.** The first launch of a copy is maximised; after that the window reopens at the size and state it was
closed at, clamped to a screen that exists and never smaller than 640x420. The remembered size belongs to the
**profile**: two windows that share one profile share one size, and a dev window with its own profile has its own.

**Fullscreen** keeps the chat column (R30) and changes nothing but the window's size; the empty 48 px band the host
draws above the site view is not drawn at all, because there is nothing for it to hold.

**Deferred.** Chat that hides itself or floats over the picture is a later phase. The column is the panel that will
later be able to float; no code for it is written now.

**Why.** Today the page is one scrolling column, 832 px wide at most (`max-width: 52rem`) and left-aligned, with the
chat under the player: maximising it adds margin, not picture. The invite - needed once - and the link - needed all
evening - share that column with the chat and the controls, and the room's end leaves a dead player in place. The
user's six points (`.scratch/phase-5-layout/answers.md`) are the requirement. Three answers given while the plan was
being repaired (2026-11-23) sharpened it: the address bar's Paste must **act**, not merely fill; its button belongs
inside the field; and a room that is on a page must still be able to **open a file**, and a room on a file still able
to take a page — "both any time seamlessly".

**Rejected.** (a) A top bar spanning the whole window for the invite - the site view is a native control filling the
window, so the page cannot draw over it, and a WinForms-drawn bar would put product logic in the host (ADR-034,
ADR-038). (b) A CSS-only breakpoint - see "one threshold" above; in website mode the app view is 380 px wide at every
window size. (c) One screen with panels that show and hide - the user asked for two screens, and that is what leaves
a dead player. (d) An invite modal or a second panel - the user asked for "minimally somewhere", not a dialog.
(e) A separate **Go** button beside Paste - it makes the same act two targets and still leaves Paste looking inert;
Paste filling and sending in one press is the shorter route. (f) A mode switch between "website" and "file" - the two
routes coexist in one bar, so no one has to leave a mode to use the other.

**Cost.** There is no resize handler in the host today; resizing now runs layout code, and a dropped layout message
shows as a wrong column until the next resize. Two dock shapes double the window states the pictures and the gate must
cover. The threshold is one more number to keep in step with the manual's pictures, and it lives in C# only. A fresh
portable folder has no saved size, so its first run is maximised like any other first run. The first screen's
**entered** flag is window-local: a host who reloads while a room is live lands back on the first screen (the room
keeps running, the invite is still there, one press returns). The Paste-inside-the-field button needs the field to
reserve room for it, so a very long address shows fewer characters before it scrolls. Each route always present costs
a row on a 640 px-wide window, which is why the bar's controls are one row and compact.

## ADR-048 - The room follows the page's own navigation, not only the address bar

> **Amends nothing.** It completes R21 and `spec.md` §1's second route ("or simply browses inside the app: search,
> pick a title, pick an episode"), which ADR-038's two views made possible but never wired. It lives beside ADR-032
> (staged changes) and ADR-030 (personal choices stay in the window).

> **Amended 2026-11-24 (ADR-052):** Rejected (d) below - sharing the query string - is now the decision: the room
> stores the pasted address's query and fragment. The rest of this ADR stands, including the loop protections.

**Decision.** `room.page` is the address the room is on, and a site's **own** navigation is a page change like one
typed into the address bar:

- **The top document's address is what counts.** The bridge marks every message with `top` (`window === window.top`)
  and posts one `pageAddress` message whenever the top document's address changes — after the document loads, and
  after a same-document route change (`pushState`, `replaceState`, `popstate`), which is how most sites switch
  episodes without a reload. Same-document changes are why the host's `NavigationCompleted` alone is not enough.
- **Only the top document may report it.** A player frame is often a different origin (E2: 6 of 11 sites), so a
  frame's address is its own and never the room's page. The host relays `pageAddress` only when the sender is the top
  document (`frame is null` in `RelaySiteEvent`); anything else is dropped like an unknown kind.
- **A controller's navigation is staged, not adopted.** When a window that holds control sees the address change to
  something other than the room's page and other than its own pending preview, it sends the ordinary `setPage` — the
  same five-second window (two until 2026-11-24, ADR-032 as amended), Cancel and `pageCommitted` reset to position 0, paused that ADR-032 already defines. A
  mis-click on a thumbnail is therefore as cheap as a mis-typed address, and nothing about the room's protocol
  changes.
- **A guest's navigation is put back.** A window that does not hold control does not change the room. When its site
  view lands anywhere other than `roomPage`, the page navigates it back and says so in one line. Two windows on two
  documents is the fault this ADR exists to stop: the timing maths would otherwise keep syncing one film's clock onto
  another film.
- **The same address is not a change.** A reload, a route change that canonicalises to the room's page, or the
  navigation the preview itself caused is ignored. The comparison uses `canonicalPage` (ADR-032's rule), so a
  trailing difference in case or a fragment never causes a second stage.
- **What is shared is unchanged.** The room still stores `protocol//host/path`; the query string and fragment are
  dropped (ADR-032, `spec.md` §10.3), and which mirror, quality or subtitles the page is showing stays in each window
  (ADR-030).

**What this answers.** On 2026-11-23 the user reported switching episode inside `animex.one`'s own thumbnail list: the
host's site view went to the new episode, the guest stayed on the old one, and the new episode's player was then put on
the old episode's clock, so each window watched a different film at a number the other had measured. **The report does
not include the two addresses.** The mechanism this ADR builds is proved on the repository's own pages by ticket 105
(one window on `probe.html`, a real click on its link, both windows land on `probe-2.html`); the reported fault is
consistent with it **if** the site's episode change moves the top document's address, which is assumed here because
`animex.one`'s addresses are path-based (`/watch/<episode>`) and the limit below says what happens when they are not.
The next live run of that site is the measurement that closes the assumption.

**Why the host relays rather than reads.** The page cannot read the site view's address (different control, different
origin). The host already has the top document's `Source`; the relay is one message per navigation, not per second,
and the host still holds no room decision — it says where the site went, and the page decides what that means
(ADR-034, ADR-038).

**Rejected.** (a) Adopting every navigation automatically, with no stage — a thumbnail click would commit for five
people with no undo, against ADR-032. (b) Letting a guest's navigation change the room — R21's "whoever holds
control", and it would turn a stray ad click into a page change for everyone. (c) Comparing the elected player
frame's URL instead of the top document's — the player is often a cross-origin iframe, so its URL is not the room's
page. (d) Sharing the query string so `?ep=2` sites follow too — it reverses §10.3's "never store a tokenised link"
for a convenience, and that is a separate ADR with the user's answer attached.

**Cost.** One relayed message per navigation and per route change (a site that rewrites its address in a loop is
throttled by the bridge's change check, not by the room). A page whose episode lives only in the query string is still
not followed; the address bar remains the way, and the limitation is written down rather than silently half-fixed. The
bridge now carries one more responsibility, so every existing site test must still pass unchanged.

**Amends.** Nothing. It adds the page half to `spec.md` §7.1's realignment sentence, which now lists four moments - the
new one "when the site changes its own address without a reload (an episode picked inside the site's own page, ADR-048)"
- and it completes R21, whose second route ("or by browsing inside the app") §1 described but nothing wired. The relay's
whitelist and the bridge's message kinds gain `pageAddress`; nothing else about the two views changes.

---

## ADR-049 - The chat column is the room's log

> **Amends nothing.** It gives `spec.md` §4.6 its display and its lifetime, and it is the interface half of phase 6
> (R42, R43). It builds on ADR-038's chat column and ADR-047's layout; neither changes.

**Decision.**

- **A page or file change is announced.** When a page change commits or a file is picked, the authority posts one
  **system line** in the chat - "Moved to <address>", "Opened <file>" - in the same list as the messages and dimmed.
  It is posted at the commit, never at the stage: a cancelled five-second preview posts nothing (the stage was two seconds until 2026-11-24, ADR-032 as amended).
- **Every message carries a small time**, drawn beside the author from the `ts` already on the wire (§4.6). No new
  field.
- **A notice has an end.** The room's transient lines (mute for 10 s, "too many messages", "the player has not
  caught up", "put back") are notices, not chat: each is removed when its end arrives - a timer for the mute, the
  next accepted message for the flood warning, the picture aligning for the sync line, the room moving for the
  put-back - and each can be dismissed with one click. No notice survives for the life of the room.
- **The chat list is the column's only scroller.** The invite bar above it and the roster below stay put; the list
  scrolls itself, with a thin bar that appears when the pointer is over it, drawn by the app.
- **The roster is a count, not a list.** One line, "N online", opens the names on a click and closes them on a
  second. It is below the chat and never pushes the messages.
  > **Amended 2026-11-24 (ticket 154b):** it sits **beside the chat's heading, not below the chat** - the count and its
  > chevron at the right end of the `Chat` heading row, the names opening under that row and above the message list,
  > which keeps its own scroller and gives up the rows' height. The owner asked for it "on top where it says Chat"; the
  > first build followed the sentence above and put it where the old list was, and the owner's words are the decision.
  > The count still pushes nothing: its row's rectangle is identical before and after three arriving messages
  > (measured, 154b, `evidence/154b-count-closed.png`).
- **The name is a chat command.** `/name <text>` in the chat box renames the sender; the always-visible name control
  goes; the input's placeholder offers `/name` as the hint that the command exists; the "(you)" pill goes.
- **The owner wears a crown** in the roster. Control may be granted (ADR-033), so the crown marks the room's owner,
  not whoever currently holds control.
- **A member keeps one seat.** A reconnect reuses the stored member id (ADR-033 rule 1), and the roster shows only
  members the authority has heard from: `offline` after 20 s of silence (§4.4). A rejoin replaces a row; it never
  adds one.

**Why.** The chat is where the evening is remembered, and the roster is a fact ("five of us"), not a list to scroll
past. The shipped build drew the roster as a permanent vertical list inside the same scroller as the messages, so
every message pushed the people down; and a notice that never ends reads as a new message every time the eye returns
to it, which is what happened three times in one evening (`answers.md` 14).

**Rejected.** (a) A separate events panel - a third column for four lines an evening. (b) Notices mixed into the
chat with no end - what shipped. (c) A name dialog or a permanent button - a standing control for a once-a-week
action. (d) A crown on the control holder - it moves when control is granted, and the host is the person whose
computer runs the room.

**Cost.** A shared notice store with an end and a dismiss; one system line per commit; one `/name` parser shared by
the page and its test; a presence sweep in the sidecar. No field is added to `chat`: `ts` and `kind: 'system'` already
exist (§4.6). It does add `warning.retryAfterMs` (required) and `error.retryAfterMs` (optional), so a mute notice knows
its end; the seat's `hello.id` arrived with ADR-053, and `hello.proof` with `welcome.proof` with its 2026-11-25
amendment.

---

## ADR-050 - A new film starts at zero, and the app gives up on a page that fights it

> **Amends ADR-048** (the put-back gains a bound) and **ADR-032** (a commit's reset now clears a picked file's
> position too). It is the behaviour half of phase 6 (R44, R45).

**Decision.**

1. **A committed page change and a picked file both reset the room's playback to position 0, paused.** For a picked
   file the reset happens in `setMedia` itself, before any frame can seek the new film to the old film's position -
   the clamp to `duration - 0.25` is what made a file open "at the end" after a longer one.
2. **The site's player is put to the room's position as soon as it can accept a seek.** A seek issued before the new
   element has metadata is dropped by the bridge, so the element keeps whatever position its own site remembered
   (the 50 s episode). The adapter re-issues the room's position when the new element's duration is known, not only
   when the room's state changes.
3. **Volume and mute belong to the window** (R41, ADR-030). The bridge remembers the level per site origin and
   applies it to a site player element whenever one appears or is replaced, and reports it like any other position
   report. It never travels to the room: a site's episode change no longer resets a viewer to 100%.
4. **The put-back has a bound.** For one window and one address, at most **three** put-backs; after that the window
   stops going back and one line says the site keeps leaving the room. A commit clears the bound. A guest who
   navigates away deliberately is still put back once - the bound is for the site that leaves by itself.
   > **Amended 2026-11-25 (ticket 161, after ADR-052):** "one address" is **the stray address's origin together with the
   > room's page**, not the whole address. ADR-052 keeps a pasted query, so a site whose own redirect adds or changes a
   > parameter presents a different address on every load and would start the count again each time - the measured 197
   > navigations would come back. Origin, not origin and path: a redirect that also rewrites its path would escape an
   > origin-and-path key the same way. Measured in two packaged windows: three put-backs at three different addresses on
   > one origin, then one `stopped going back` line and no fourth (ticket 161).
5. **The put-back line ends** when the room moves or after 30 s (ADR-049's notice rule).

**Why.** Measured on 2026-11-24: one window completed a navigation to the room's `https://www.youtube.com/` **197
times in 130 s** - the put-back and YouTube's own redirect driving each other, presented to the user as a popup
jumping around. Two windows on two pages is a fault; 197 is worse. The other two faults are the same mistake: state
from the last film applied to the new one.

**Rejected.** (a) Put back forever - the measured loop. (b) Drop the put-back - a guest's stray click moves their
window to an ad. (c) Carry volume on the wire - R41 and ADR-030 say a personal choice stays in the window. (d) Trust
the site's own position on a new episode - it is the site's memory, not the room's.

**Cost.** Three reset points and one per-window latch; `§4.2` and `§5` gain the "a pick resets playback" line; the
bridge gains a volume store and a re-seek on metadata; ADR-048 gains its bound.

---

## ADR-051 - YouTube plays in a player the app owns

> **Amends ADR-048** for one host (the put-back does not apply to the embed) and **§10.3** for one host (the video id
> is kept in the room's address). It is the user's answer on 2026-11-24 to "how do sites like sync-tube.de and
> watch2gether do it?"; R46.

**Decision.**

- A YouTube address (`youtube.com/watch?v=<id>`, `youtu.be/<id>`, `youtube.com/shorts/<id>`) becomes the room's page
  like any other, and the room stores it **normalised to `https://www.youtube.com/watch?v=<id>`** - one form for one
  film, so a share link with a tracking parameter and a typed link are the same page. This is the one exception to
  §10.3's "never store a tokenised link": on YouTube the query **is** the film, not a session token. The address bar
  shows what the room is on.
- The picture for that page is **the sidecar's own embed page** (`/embed/youtube.html?id=<id>`), loaded in the site
  view and driven through the YouTube IFrame Player API: `playVideo()`, `pauseVideo()`, `seekTo(s, allowSeekAhead)`,
  `getCurrentTime()`, `getDuration()`, `getPlayerState()` (`1` playing, `2` paused, `3` buffering, `5` cued),
  `setVolume(0-100)`. The API needs no account and no key; it requires an `http(s)` origin, which the sidecar is.
- **The room protocol does not change.** The embed is a site-player adapter like any other: commands in, `report`
  out, echo suppression unchanged.
- **The put-back does not apply to the embed.** The app knows that room page is served by its own embed, so it never
  compares the embed's address to `room.page`. A guest's navigation away from the embed is still put back.
- **One video per address.** Playlists, search and subscriptions are not followed; the address is the film.
- An owner who forbids embedding (player error `101`/`150`) gets one line saying so, and the room stays on the
  address.
- Volume is the window's own (ADR-050 item 3).

**Why.** The three services the user named do not browse youtube.com at all. Watch2Gether, SyncTube and GroupTube
load the **YouTube IFrame player** by video id and drive it through this API; Watch2Gether's own sync product for
non-embeddable sites (Netflix and the like) is a browser extension that reads and controls the page's HTML5 video.
YouTube's own site is a signed-out, consent-and-history-driven application that rewrites its address, which is the
loop in ADR-048's evidence. The user chose this route on 2026-11-24.

**Rejected.** (a) Keep the site view on youtube.com - measured loop. (b) Require a YouTube account - the user has
none, and the player API needs none. (c) YouTube Data API search and queue - a key and a network dependency for a
feature nobody asked for. (d) A generic "detect the video on any page" adapter - the frame election problem this
project already has (ADR-025).

**Cost.** One page, one adapter and one URL parser; the address rule gains one exception; a video whose owner
forbids embedding cannot be watched. No protocol change, no new dependency.

## ADR-052 - A pasted page keeps its query and its fragment

> **Amends ADR-048's Rejected (d), and `spec.md` §4.3 invariant 5, §10.3 and R21.** The owner answered on 2026-11-24
> (phase 6, ticket 160): the whole pasted link is shared with the room.

**Decision.** The page the room stores - the address every other window navigates to, and the address ADR-048's
put-back restores - carries the pasted address's **query string and fragment**, exactly as sent. Scheme, host and path
still name the page; the query is part of what the sender meant by it. Two addresses that differ only in their query are
two different pages, and a committed change to one of them is a change.

**Why.** The previous rule (§10.3, invariant 5) stripped the query so a tokenised or private link was never copied into
the room. Ticket 160 measured what that costs: a pasted `…/probe-2.html?x=1` reached the pasting window, the room's
stored page, the guest's window and the put-back all as `…/probe-2.html`, and every streaming site whose episode lives
in the query lands five people on the front page. The owner's judgement is that a link shared with the four friends
already in the room is a link they were meant to open; the "private" case the old rule guarded is the same case the
evening's faults came from.

**Rejected.** (a) Keep stripping the query - the fault this phase exists to fix. (b) Keep the query only in the
initiator's window - the guest and the put-back would still lose it, and ADR-048 compares addresses, so the two halves
would disagree. (c) Share a whitelist of known episode parameters - a list to maintain forever, wrong for the next
site.

**Cost.** A tokenised link is now copied into the room's state and shown in the chat's `Moved to …` line to everyone
present. A site that rewrites its own query in a loop can no longer be told apart from a person choosing an episode
inside the page, so the loop's two protections stand instead: the put-back is bounded and keyed on **origin** (ticket 161,
ADR-050) rather than on the whole address, and the one site measured doing it - YouTube - now plays in the
app's own player (ADR-051) instead of the followed site view.

> **Amended 2026-11-25 (ticket 161):** this paragraph said "origin and path". The implemented key is the stray
> address's **origin** alone, with the room's page; a path-changing redirect would otherwise escape it. ADR-050 item 4
> carries the dated line.

## ADR-053 - A person's identity lives in a cookie the app sets on its own host

> **Amended 2026-11-25 (ticket 165, the phase-6 review):** the id alone did not prove a seat - every member receives
> every other member's id in `members`, so a guest (or anything on the plain-HTTP path) could quote one and take that
> row, the owner's included. A seat is now **proved**: the room mints a secret at the seat's first join, sends it in
> that member's own `welcome` (never in a broadcast), the page keeps it in the same `wp_member` cookie as
> `{id, name, proof}` (32 random bytes, 64 lowercase hex characters) and presents it on `hello`. A hello naming an
> occupied row without the matching proof is seated as a **fresh member**, never as that row and never with its
> control. Rejected: refusing the claim with a close code (the claimant still needs a `welcome`, and one code path is
> less to get wrong), and one proof shared by the room (any member could then quote it - the fault this amendment
> closes).

> **Amends ADR-033 rule 1** (a returning member keeps their id). It is the first implementation of that rule (phase 6,
> ticket 148) and the record R42 owes.

**Decision.** A member's identity is **one id, minted once by the page and kept in a cookie the app sets on its own
host** (`wp_member`, holding `{id, name}`). The id is what the room counts, what a control grant names and what a
reconnect restores; the name is a label beside it, not the identity. The cookie belongs to the app's host, whatever
port it listens on that evening.

**Why.** The app's page is served by the sidecar on `127.0.0.1:<port>`, and the sidecar asks the operating system for a
free port each run (measured: a new session's copies listen on a different port almost every time). A store scoped to
that origin - `localStorage`, a session-scoped value, anything the page keeps for one origin - is gone at the next
start, and a guest who comes back after a drop appears twice: the room's count says three for two people, and one of
them holds a control the other does not. The cookie is the one store a page can set that is keyed on host rather than
host and port.

**Rejected.** (a) `localStorage` - dies with the port, measured. (b) A name-only cookie - a name is a label two people
can share; the room needs a value nobody else can quote. (c) An id the host hands out - the host moves (ADR-024), so
the id would move or fork with it, and a returning guest would be a stranger to the new host.

**Cost.** The cookie is plain text on that host, readable by anything running there - the same trust the room's plain
HTTP already assumes (ADR-023), not a new exposure. Two people sharing one Windows account share one identity, which is
the correct answer for a program two people do not share. A copy moved to another folder keeps its `runtime` folder and
therefore its cookie; a fresh copy is a fresh guest.

---

## ADR-054 - A browser guest is a viewer like any other

**Decision.** A person with only a browser joins by the plain address -
`http://<address>:<port>/join?c=<code>` - and is a member of the room on the same terms as an app guest: one seat, one
identity (the `wp_member` cookie ADR-053 sets on the owner's host), the same chat, the same play, pause and seek. What
such a guest can **watch** is decided by what the room can serve from the host's own machine or from a player that
cooperates: the room's file, played by the guest's own `<video>` from `/media/<id>?c=<code>`, and the room's YouTube
video, played by the app-owned embed page (ADR-051) carried inside the page and driven through YouTube's own API. An
ordinary website is **not** offered to a browser guest: the picture says so in one plain sentence naming the app, and
never "waiting for the host". The invitation therefore offers **one plain address on every screen**, in the room code's
shape with one Invite button beside it (**Amended 2026-11-26 by ADR-056**, which withdrew the `watchparty://` link from
every screen and gave every guest the same invitation; R51 as amended, tickets 185 and 192) - and a reloaded browser page
learns the room's code from the page the
sidecar serves, because `/discovery` is loopback-only and the `wp_key` cookie is HttpOnly.

**Why.** A `watchparty://` link is nothing to a browser, and the raw address already exists in the invite composer, so
the door has been half-open since phase 4 without anyone being told which form to send to whom. The person this serves
is the seed's persona: a friend who will not install anything for one evening. What a browser cannot do is the limit
ADR-006 recorded, now with the reason visible: the app's own window syncs a website because the **window host injects
the bridge into its site view**, which no browser lets a page do; a website is driven either by the extension (M5) or by
a relay (M6), both already on the roadmap, so nothing here reopens them. A player that publishes an embed API is the one
exception, and YouTube is the one this app depends on.

**Rejected.** (a) The HTML-rewriting proxy, to make a website same-origin with the injected bridge - ADR-006's
rejections hold: CSP, signed assets, referrer checks, and re-hosting other people's pages from a friend's uplink. (b) A
second invitation form that carries a token instead of the code - two things for a person to keep, when the code is
already the key (ADR-044). (c) Telling the browser guest to install the app - that is the premise this phase exists to
remove. (d) Making the embed work only in the app's own window - a browser guest would then see nothing in the room's
commonest evening.

**Cost / risk.** There are now two kinds of viewer, and the record must say which one a `Checked by` line was measured
with. A browser guest gets no ad filtering and no fullscreen interception, so their picture obeys their browser's rules
(the seed accepts this). A YouTube room in a browser needs a message path the window host never needed. The copy button
may be refused by a browser on a plain page (R51). A browser guest's cookie jar is a different scope from the host's, so
one person on two devices is two seats - the room counts devices, as it always has.

## ADR-055 - The narrow layout is the page's when no window says otherwise

**Decision.** The layout's numbers keep one owner - the window host's `data-layout` and `--chat-column` when they are set
(ADR-047) - and gain one **fallback owner**: the page's own stylesheet, from its own CSS width, in exactly one place.
Above the threshold the chat is a 380 px column beside the picture; below it the chat goes under the picture and the
picture keeps usable height. A page that has a host obeys the host, even when the two disagree.

**Why.** A browser guest has no window host at all, and a phone is 360-420 CSS px wide. ADR-047's rule that a page with
no attribute is `wide` was written for a test, not for a phone, and it draws a 380 px chat beside a sliver of picture -
the one shape this phase cannot ship. The alternative - the sidecar guessing the client width - would put a second
layout authority on the server, further from the pixels than the page is.

**Rejected.** (a) A `navigator.userAgent` phone check - a guess about the device where the page already knows its own
width. (b) A second threshold value tuned for phones - two numbers to keep in step, and the failure it prevents is
already covered by the first. (c) Dropping the host's attribute and letting the page always decide - ADR-047's drag
measurement (a settled resize, one publish) is why the host speaks at all.

**Cost.** Two authorities, ordered, instead of one: a reviewer must check that the host's attribute still wins and that
the fallback number appears once. The page's stylesheet now carries a width number, which ADR-047 spent a paragraph
keeping out of it; the amendment is on that ADR.

---



## ADR-056 - One invitation, on every screen, beside the room code

**Decision.** The room has exactly **one** invitation: its plain `http://<address>:<port>/join?c=<code>` address. It is
shown on **every** screen a person can be on - the owner's front door, an app guest's bar, a browser guest's bar - in the
same compact shape as the room code, with one **Invite** button beside it that copies the address and says on the button
itself that it copied (and says so in words when the browser refuses the copy). ADR-047's rule that a guest's bar carries
no invitation is withdrawn, and R51's two labelled forms with two Copy buttons are replaced by this one link.

**Why.** The owner asked for it on 2026-11-26, after seeing a browser guest's bar say "The invite link is the host's to
share." That sentence protects nothing: a guest's own address bar already holds the same address and the same code, so the
invitation is not a secret the owner keeps - the owner is only its first holder. And with the app learning to accept the
plain address (R57), one link is enough for everybody: a friend with the app pastes it, a friend without clicks it.

**Rejected.** (a) Two labelled forms, each with its own Copy (ticket 177's build) - two links to explain and to choose
between, and the host has to decide which to send, or send both. (b) Keeping the guest's bar silent - a protection that is
not there, at the cost of the one person who already has the link being the only one who can pass it on. (c) A share
sheet or a modal - more interface than five friends need for one line of text. (d) Hiding the address behind a disclosure
- the owner asked for it where the room code already sits, because that is the line people read aloud.

**Cost.** The `watchparty://` form leaves the visible screen: an app friend now needs to paste the address into the app,
which is why R57 comes before the gate. A guest can invite anyone, which anyone holding the address could already do, and
chat crosses an opened port in plain text (ADR-023) - the phase's accepted risk, not a new one.
## ADR-057 - Every site in a browser: an add-on for Chrome and Firefox from GitHub, the relay later

**Decision.** R58 is delivered by an **add-on first**, and a **relay later**. The add-on ships for **both Chrome and
Firefox from this project's GitHub releases** - not from the Chrome Web Store and not from Firefox Add-ons - and it speaks
the same room code and the same protocol as the app's own window (ADR-044, ADR-006 as amended). The relay stays where the
roadmap put it: a later phase (M6), for people who will not install anything.

**Why.** This is the owner's call on 2026-11-26, in the same session as R58: they want every site to work in a browser, the
add-on is the route that reaches a site's own player, and a GitHub download keeps it out of a store account (ADR-023: no
account) and out of a review queue.

**Rejected.** (a) A store listing - an account and a review, both against ADR-023, and an add-on still has to be
downloadable from GitHub for the friends who want it tonight. (b) The relay first - it spends the host's upload every
evening and breaks on players that refuse to be captured (E6), while the add-on costs one install per friend. (c) Chrome
only - half the group would be left out for no saving, since the manifests and the bridge are one body of code.

**Cost, and what must be measured before it is promised.** Firefox will not install an **unsigned** extension from a plain
download: a signed `.xpi` needs a submission to Mozilla, so "install from GitHub" means **Firefox Developer Edition or
Nightly with `xpinstall.signatures.required` off**, or a temporary load per session - the owner must know that before it is
promised, and the alternative is a one-off signing submission that puts nothing in a store. Chrome loads an **unpacked
folder** from a GitHub zip in Developer mode; a `.crx` from outside the store is refused by consumer Chrome. Both are work
items with a live check in M5, not assumptions.

> **Decided 2026-11-28 (the owner, for M5):** Chrome is installed **by hand from a downloaded folder** - the zip from the
> GitHub release, unzipped, `chrome://extensions`, Developer mode on, **Load unpacked** - and it is **not** to go to the
> Chrome Web Store. The Developer-mode banner and the warning Chrome shows on install are accepted, and the M5 plan owes a
> one-page install guide with a picture of each step. Whether the same route is offered on Firefox - which needs either the
> one-off signing submission above or Developer Edition with `xpinstall.signatures.required` off - is the M5 plan's
> question, not this record's: the owner has decided Chrome's route, not Firefox's.
## ADR-058 - The relay is a visible choice, and capture is not a fallback

**Decision.** The relay is a setting the **host** owns, shown as a **visible toggle in the window's own chrome**, in space
the window already has (the room strip or the chat column's head) - not behind a settings screen, not a menu item, and its
state readable without hovering. Turning it off stops the relay. What the toggle means is **reusing the site's own
stream**; **capturing the host's picture and sound is out of scope** at this stage, and if it is ever added it is a second,
separate toggle of its own, never the automatic fallback when reuse fails, and never on by default. The toggle's default
state is not settled here - the owner says when M6 is planned (R59).

**Why.** The owner's call on 2026-11-26, in the session that recorded R58: a feature that spends the host's upload and
sends a picture to their friends must be visible where the room is, and it must be the cheap route they asked for, not a
silent upgrade to a screen capture they did not ask for. Two routes with one switch would mean the switch lies about what
the host authorised.

**Rejected.** (a) One switch for both routes, or capture as the fallback - the host would authorise "relay" and get capture,
which costs their processor, softens the quality, and cannot be captured at all on DRM-protected video. (b) A hidden
setting or a config file - a feature that changes what leaves the machine must be legible on the same screen as the room
code. (c) Capture now, on the grounds that it always works - it is the expensive route, it is outside what the owner asked
for, and E6 (can a site's stream be reused) is still unmeasured; measuring it is what decides whether a second toggle is
ever needed.

**Cost.** The window's chrome carries one more control, and the two routes stay two decisions rather than one. If reuse
proves impossible on the sites the group uses, the room says so plainly rather than quietly switching to capture.