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

> **Amended 2026-11-20:** room actions are now **staged** for two seconds before they take effect (ADR-032), so a
> misclick costs nothing; and control survives a reconnect and follows the host role (ADR-033). Everything below
> about *which* actions need control, and about personal choices never being broadcast, stands.

**Decision.** Split every action into two kinds:

- **Room actions** — play, pause, seek, choose the page, choose the film, choose the episode, and whether a
  skip is followed. These require **control**. The owner has it always; anyone may be granted it for the session,
  and the roster shows who has it. Room actions are staged for two seconds before they reach anyone (ADR-032).
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

**Decision.** A room action from a controller (change page, episode, or film) does **not** reach anyone immediately.
The authority holds it as pending for **2 s**, showing the initiator a countdown with **Cancel**. If they cancel
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
> has not committed, not a second kind of media. For the stage's two seconds both views are up: the site view appears
> at once and the host docks the app view to its page-mode width, so the file's picture is briefly a 380 px column.
> A commit clears the file (above) and the layout stays; a cancel hides the site view and the file room is as it was.

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
