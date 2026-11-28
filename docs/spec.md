# Spec — v0.1 (draft for review)

Companion to `research.md`. Every claim about *why* lives there; this file says *what*.

---

## 0. Scope

**In (v1):** a Windows desktop app that carries a browser window with ad filtering, in which one member picks a
third-party page and every other app takes itself there, with playback kept in step; chat; a deliberately small
"play my own file" mode; per-viewer subtitles for files.

**Out (v1):** accounts, friends lists, playlists/queues, voice chat, phone apps, DRM content, built-in site
scrapers, persistent history, the browser add-on, the HLS relay, transcoding, multiple audio languages, and the
rescue relay.

**Explicitly out, forever:** peer-to-peer *video*, Electron, syncing inside a cross-origin iframe we don't control,
paid tunnels, rented servers and third-party meeting services.

Scope order is ADR-027: website mode first, files second. Everything about watching files that is not needed to
prove the sync engine is v2 (see `open-questions.md` §F).

---

## 1. Flows

**Create.** The owner opens the app. It opens its port, learns its own public address, and shows a single link that
carries both the address and the room code on its first screen; the room is live from that moment (ADR-047). There is
no account, no sign-in, and nothing to configure. If the address cannot be learned or the port cannot be opened, the
app says so plainly at this point rather than at join time (§14). Pressing **Start a room** enters the room's watching
screen; it creates nothing.

The invitation is the room's own plain address, `http://<address>:<port>/join?c=<code>`, in the room code's compact
shape with one **Invite** button beside it that copies it (R51, ADR-056). It is the same invitation on every screen -
the owner's front door, the owner's bar, every guest's bar - and it is one link for everybody: a friend with the app
pastes it into the app (R57), a friend without opens it in any browser and joins as a **browser guest** (ADR-054). The
app still registers a `watchparty://` scheme every time it starts (ADR-042), which a person can write by hand, but no
screen prints it.

**Choose the page.** Whoever holds control pastes a page address — or simply browses inside the app: search, pick a
title, pick an episode. The change is **staged for five seconds** (ADR-032): the initiator sees their new page at
once with a *"moving everyone in 5 s — Cancel"* countdown, and the other apps do not move until it commits. A
misclick therefore costs nothing and is invisible to everyone else. The room stores the page address, not the video
address. **Which mirror, which dub, and which subtitles is nobody else's business** (ADR-030): those stay inside
each member's own window because each app has its own browser.

**Invite.** One button copies the link. It is posted wherever the group already talks. Nobody types an address or
a code, and nobody is told to "look up your IP".

**Join.** Click the link → the app opens → **Join**, which is also the autoplay gesture (research §8). A name is
optional: leave it blank and appear as `anonymous`, and set a name later by typing `/name <text>` in the chat box. The app then navigates to
the room's page if there is one.

**Lobby → play.** Room shows who is connected and who has a player. When the page is loaded and the players are
ready (or anyone forces start), playback is scheduled to begin at `now + 1.5 s` and that instant is broadcast with
the position. Everyone starts on the same beat instead of on their own packet arrival.

**During playback.** Whoever holds control may pause, resume, seek, or change the page (ADR-030). Any member may
choose their own mirror, sub/dub, audio track, subtitles, volume and view mode — none of which leaves their window.
Positions are reported every 3 s; corrections go to individuals, not the room.

**Fullscreen.** The app owns it (ADR-028). Our button fills the window with the picture, the page's own fullscreen
button does the same thing, and nothing the site does can take the screen or hide the chat.

**When the site moves the playhead by itself** — skip intro, auto-next, a mirror switch reloading the player — the
rules are in ADR-029: a player is always a follower on load, a controller's skip becomes a room seek, and everyone
else converges.

**Two screens, and the window used.** The first screen is the room's front door: the room code with the room's plain
address in a chip beside it and one Invite button, the router's state and its failure card when there is no public link,
and the box to paste someone else's invite into - and no picture, chat, address bar or picker (ADR-047). Pressing Start a room switches at
once to the watching screen. There the picture takes whatever is left and the chat is a **380 px column on its
right** - member count, message list, input, with the align/offset controls beside it - with the address bar as the
page's own top row above the picture and the column (its Paste button inside the field, **Open a file** beside it), the
invite bar (the room code, the plain address in a chip, one Invite button) as the column's first row under it, and the
player's own controls (play, scrub,
volume) plus subtitle selection under the picture in file mode. Under **900 px** of window width (the page's own width,
measured by the host) the chat column moves below the picture, never beside it, and the picture is
bounded so the chat always has room. Nothing else: the product is the picture, the chat, and the controls.

**Two ways to watch (R28).** The **chat column** keeps chat beside the picture, always visible; when the page's own
player goes fullscreen it stays inside our window rather than taking the screen, which is what makes this possible.
*Cinema* hides the column and floats a translucent chat panel over the picture, which fades out after ~3 s without
pointer movement and comes back on any pointer movement, on a keypress, or briefly when a message arrives. The choice
is per member and remembered. Cinema is the better default for a film, the column for catching up during one.

**Leave.** Closing a member's app removes them. If the **owner** leaves in file mode, the room ends. If the **host**
(the app holding authority) leaves in website mode, authority passes to another connected app and playback is
unaffected (ADR-024, §4.4).

---

## 2. Functional requirements

| # | Requirement | Test |
| --- | --- | --- |
| R1 | Create a room; receive a link that needs no typed address or code | two rooms at once show different links |
| R2 | Join by link with a display name, or none | no email, no password prompt |
| R3 | Duplicate names are disambiguated, not rejected | join as "sam" twice → "sam (2)" |
| R4 | Chat messages reach all members in the same room | 3 windows, one message, 3 receipts |
| R5 | Chat keeps the last 100 messages for late joiners | join after 120 messages, see 100 |
| R6 | Play/pause/seek by one member is applied by all | play/pause visible within 300 ms; a scheduled start may add up to 1.5 s and that is intended (§6.4) |
| R7 | A late joiner starts at the correct position ±0.5 s | join 20 min into a film |
| R8 | A client that stalls 5 s catches up without a room-wide jump | throttle the lagging window only; a window within a quarter second is in step, not drifting (6.3, ADR-039) |
| R9 | Drift > 4 s on one client is corrected by a seek; < 1.5 s by a rate nudge | force drift, observe rate briefly ≠ 1.0 |
| R10 | Seeking during playback pauses everyone, waits for buffering, then resumes together | seek while all playing |
| R11 | A room can play a file from the owner's disk with native seeking | drag scrubber, no re-encode |
| R12 | *v2.* A room can play a pasted direct link without downloading the whole file | watch network: only ranges requested |
| R13 | *v2.* A room can play a pasted HLS link without transcoding | same, segments fetched on demand |
| R14 | *v2 (file mode).* Subtitles can be selected per viewer, including "off" | two viewers, different tracks |
| R15 | *v2.* The room reports the quality the owner's upload can carry | 20 Mbit/s, 5 viewers → 720p |
| R16 | *Dropped.* No TTL: a room exists only while at least one app is in it (§4.4) | close every app; nothing remains |
| R17 | The app opens the room's page and syncs that page's player | two windows, same page, in step |
| R18 | Chat is available and identical in both front doors (app window and add-on overlay) | send from the app, read in the overlay, and vice versa |
| R19 | Chat input never triggers the page's keyboard shortcuts, and the overlay stays visible in fullscreen | type a space on a site where space = pause; enter fullscreen |
| R20 | The app's browser window blocks ad and tracker requests by default | load a page with known ad hosts; no ad-network request completes |
| R21 | Setting a page in the room navigates every other app to it - by the address bar **or by browsing inside the app** (search, a title, an episode thumbnail), by a member who holds control. The address is stored as pasted, query and fragment included (ADR-052) | the controller sets a page from the bar, then picks an episode inside the app's own window; both apps land on it - a `?ep=2` address lands them on episode 2; a non-controller's pick is put back |
| R22 | In website mode the room survives the owner leaving, with no interruption to anyone's film | close the owner's app mid-film; others keep playing, and control moves with the room |
| R23 | A member behind an ordinary home router can host with no settings and no account | fresh install on a home network; the link works from outside |
| R24 | Anyone granted control may change the page, the film, play/pause/seek — not only the owner | a promoted member pauses, seeks, and changes the page |
| R25 | A member who cannot load the site can request a rescue; the owner approves it; only that member is relayed | force a load failure in one app, rescue, that member sees the film |
| R26 | A name may be set after joining; until then the member is `anonymous` | join without typing; type `/name Ada` in the chat box later (R43) |
| R27 | Rooms form without any third-party service in the path | network trace while joining shows no rendezvous service |
| R28 | Chat can float transparently over the video in cinema mode, fading after ~3 s idle and returning on pointer movement, keypress, or a new message | switch to cinema, stop moving the mouse for 3 s, move it; then send a message from the other window |
| R29 | The address bar has a right-click menu (cut/copy/paste/select all) and a visible Paste button **inside the field's own box**; one press of Paste fills the field **and** takes the room there, and Enter does the same | right-click → Paste inserts; Ctrl+V works; pressing Paste with the clipboard holding an address moves the room without a second press |
| R30 | The app owns fullscreen: the page's fullscreen request fills our window and never hides the UI | press fullscreen on a site that used to take the screen; chat stays visible |
| R31 | A room change is staged: the initiator sees it immediately, everyone else moves only after 5 s (two until 2026-11-24, phase 6), and Cancel means nothing ever happened for them | click a title, press Cancel inside 5 s; note the other window never moves, not even a flicker |
| R32 | The player is a follower: after any page load or player replacement every client realigns to the room's position, including the host | switch mirror mid-film; nobody restarts at 0 |
| R33 | Room actions require control; the owner has it, others can be granted it, a grant survives a reconnect, control moves with the host role, and anyone can claim it when nobody has it | a non-controller's pause is refused with a clear reason; after promotion it works; reconnecting keeps it; with no controller online, Take control appears |
| R34 | Personal choices never propagate: mirror, sub/dub, audio, subtitles and volume affect only that member | two members on different dubs stay in sync and neither switches |
| R35 | Peer-to-peer plumbing is blocked by default, with a one-line notice and a per-site Allow switch | load a site that uses WebRTC; the notice appears, playback is unaffected, and Allow makes the site work if it needed it |
| R36 | Two controllers staging different pages at once: the later request replaces the earlier, and the first sees a "replaced" notice | both click a title within 2 s; one commits, the other is told why it did not |
| R37 | A page's request to open a window never opens one; the app says so in one line, naming the host it asked for | click a page's popup link; no window appears, and one line names the host |
| R38 | The app ships as one portable executable per variant, with every dependency except the browser engine inside it | copy the file to a folder on a Windows machine where nothing was installed, run it from there, and the room still syncs |
| R39 | The first screen is invite and join only; Start a room switches to the watching screen at once; a room that ends returns a guest to the first screen with no dead player | start a room (screen changes), a second window joins by the link while the first screen is still up and lands on the watching screen itself, close the host (the guest's window is back on the first screen with one line saying so) |
| R40 | The watching screen spends the window: the picture takes what is left, the chat is a 380 px column on its right, and under 900 px wide the chat moves below the picture (the picture bounded so the chat always has room); the invite bar stays reachable in fullscreen, and **in the owner's window** the address bar and **Open a file** are both present at every moment (a guest has no file to serve, R11) | in the owner's window, in a file room and in a page room, the address bar and Open a file are both present; pictures at maximised and at 800 px wide, the chat's rectangle right of the picture in the first and below it in the second |
| R41 | The local file player has a volume control beside its play and scrub controls; the setting is that window's own and never travels to the room | two windows on one file at different volumes stay in sync (met); **reopening the window keeps the volume is not met yet** - the page's address changes on every run, so a stored level belongs to an origin that is gone (ticket 119; no ADR yet) |
| R42 | The chat is the room's log: every committed page or file change posts one dimmed system line with the time, every message shows its time, the message list is the column's only scroller with a thin bar, and the roster is an "N online" header that opens on a click | two windows see one line for a committed change and none for a cancelled one; thirty messages scroll inside the list while the roster's row does not move (ADR-049) |
| R43 | The name is a chat command - `/name <text>` - with the input's placeholder as the hint; there is no always-visible name control and no "(you)" pill; the owner's roster row wears a crown | typing `/name Ada` renames in both windows and posts no message; the owner's row shows a crown and a guest's does not (ADR-049) |
| R44 | A committed page change and a picked file both start the room at position 0, paused; a viewer's volume and mute survive the site replacing its player and never travel to the room | a 60 s file opened after a longer one starts below 1.5 s; an episode change that replaces the player leaves both windows below 1.5 s at volume 0.4 (ADR-050) |
| R45 | The put-back gives up: at most three tries for one window and one address, then one line and no more navigation; a commit clears it | a page that redirects itself leaves at most four navigations in fifteen seconds and exactly one line (ADR-050) |
| R46 | A YouTube address is the room's page, played in the app's own embed page through the YouTube IFrame API and synced like any site - no account, no youtube.com page | two windows on one video play, pause and seek together within 0.25 s, with no YouTube account (ADR-051) |
| R47 | A dragged window keeps up with the mouse: during a drag the host resizes its two views and publishes nothing, and it publishes once when the drag ends | 120 scripted resizes produce at most two layout publishes and the last is within 300 ms of the last move (ADR-047 as amended) |
| R48 | The front door is centred at every window width and says the room is already open before Start; a guest who arrives early sees "waiting for the host" in the picture area rather than a blank one | at 1400x900 the card's left and right gaps are equal within 2 px; a guest joining before Start reads the waiting line (ADR-047) |
| R49 | The local file player's controls are icons: play/pause and mute are drawn glyphs with an accessible label, the scrub keeps its range and its time readout, and the volume level stays a range | a file room's control row shows two labelled glyph buttons, the time readout and the `data-volume` range at 380 px without clipping (ADR-049) |
| R50 | A play the site refuses is retried without a press: the refusal is reported, retried on the next `canplay` and on a real gesture for ten seconds, and after that the picture area names the fault and offers a Play button that starts it | a page that refuses the first play is playing within 5 s with no press; one that refuses every play shows the line, and the button starts it (ADR-030) |
| R51 | The room has one invitation, and every viewer can pass it on: the plain `http://<address>:<port>/join?c=<code>` address is shown on the owner's front door and on every guest's bar, in the same compact shape as the room code, with one **Invite** button beside it that copies that address and says on the button itself that it copied; where the browser refuses a copy - or a paste - the button says so in words instead of claiming success (ADR-056 withdraws ADR-047's silent guest bar; the `watchparty://` form leaves the screen and the app learns to take the plain address, R57) | the owner and both kinds of guest read the room's address beside the room code and copy it with one button that says it copied; a refused copy says so in words and nothing claims "copied" when nothing was; a guest's Paste on a plain `http://` page says it cannot read the clipboard |
| R52 | A browser guest joins, reloads and keeps one seat: the page works for a caller the room's discovery route refuses, the room's code supplied to it by the page the sidecar serves, and a reload rejoins with the cookie's id and proof instead of showing a fault that is not there | a browser at the plain address joins, chats, reloads, and comes back to the same seat and the same room with no "room process is not answering" line; a request without the code still gets the gate page (ADR-054) |
| R53 | A browser guest watches the room's file: the picture is the guest's own player fed by the room's media address, and play, pause and seek reach it as they reach an app guest | a browser guest and the hosting app stay inside the deadband on one file, and one seek from the app moves the browser's picture once (ADR-054) |
| R54 | A browser guest watches the room's YouTube video through the app-owned embed in the page's picture area, obeying the room's play, pause and seek; a room whose page is an ordinary website shows one plain sentence naming the app as the way to watch it, and never "waiting for the host" | a browser guest in a YouTube room plays, pauses and seeks with the app; a browser guest in a website room reads one sentence naming the app (ADR-054, amending ADR-006) |
| R55 | The page is usable on a small screen: when no window host says otherwise, the page decides for itself, and under its own narrow width the chat goes below a picture that keeps usable height | a phone-sized viewport (360-420 CSS px) draws the picture above the chat and neither column clips; a window host's `data-layout` still wins when it is set (ADR-055, amending ADR-047) |
| R56 | A browser that cannot run the page is told so: the page the sidecar serves carries one plain sentence, readable without the bundle, that names a current browser and stays visible until the page's own code takes over, instead of a blank picture | a caller whose engine cannot run the bundle still reads one sentence and no blank rectangle (ADR-054) |
| R57 | The plain address is a way in for the app too: an app window accepts a pasted `http://<address>:<port>/join?c=<code>` address exactly as it accepts its own join link, joining the same room, so one link can be sent to everyone | pasting the plain address into the app's field joins the room the hosting app is in, on the same seat and the same code, and a malformed or foreign address is refused in words (ADR-054) |
| R58 | A room can be watched in a browser whatever it is on: a browser guest watches a room whose page is an ordinary streaming website, not only a file or a YouTube video, installing nothing; where a site's own player cannot be driven from another page, the picture reaches the guest by one of the two routes already planned - the extension a guest installs (M5, R18/R19) or the host's relay (M6, R25) - and the first site tested is one the owner names (animex.one, 2026-11-26); the route is an add-on for **Chrome and Firefox**, installed from this project's GitHub releases, and the host's relay in a later phase (ADR-057) | a browser guest in the owner's named site room sees the picture, and one play, one pause and one seek from the host reach it and stay inside the deadband; that room's route is named (extension or relay); a browser without the extension still reads the sentence R54 requires (ADR-006 as amended; E2 and E6 still unmeasured) |
| R59 | The relay is the host's choice and it is on screen: a **visible toggle**, placed in the window's own chrome where it already has room (the room strip or the chat column's head - never a hidden settings screen), turns the room's relay on or off and shows its state without hovering; what the toggle means is **reusing the site's own stream**, the route preferred over any capture, and **capturing the host's picture and sound is not in scope** - if it is ever added it gets its own separate toggle, is never switched on as a fallback, and cannot be turned on by default (ADR-058) | the toggle's two states are shown and photographed in the app's window, and turning it off stops the relay; a room with relay on serves guests a plain video inside the deadband; nothing in the page or the app can switch capture on, and no other setting toggles it (the default state is the owner's to say when M6 is planned) |

Rows tagged *v2* are requirements that survive the reordering (ADR-027) but are not built in v1. Nothing was
deleted: R16 is the only one genuinely dropped, because rooms no longer outlive their members.

---

## 3. Non-functional

- **Latency:** p95 correction round-trip < 150 ms on LAN; < 400 ms between two home connections on the same
  continent. Between continents, add the speed of light and say so in the UI rather than pretending.
- **Sync perception:** nobody should be able to *hear* a gap. Target ≤ 250 ms after convergence; the 4 s hard-seek
  threshold means transient divergence is tolerated rather than fought.
- **Footprint:** one program, ≤ 300 MB resident with a page open, zero CPU when paused. No second browser bundled.
- **Ship:** one file (ADR-041), copied into a folder the person can write in (ADR-043): no installer and no
  administrator rights. WebView2 is already present on effectively every such machine; the larger flavour carries the
  browser engine inside itself for the machine that lacks it, and with neither engine the window says one plain
  sentence and stops. No Docker, no database, no
  Caddy, no TLS certificate — see ADR-023 for why plain HTTP on a direct connection is the deliberate trade.
- **Platforms:** Windows now; Linux later (the same UI shell, a different browser component); Android later (a
  browser inside the app is the only way to sync a third-party page there). No iOS, ever, for the reasons in
  `open-questions.md` §F.
- **Failure posture:** every feature degrades to "playback continues, sync gets coarser", never to "nothing plays".
  The one exception is file mode, which cannot survive the owner's app closing (ADR-024) and says so before it
  starts.

---

## 4. Model

### 4.1 Room (in memory, replicated to every connected app, keyed by code)

```ts
type Room = {
  code: string;                    // 6 chars, unambiguous alphabet (no O/0/I/1)
  createdAt: number;
  owner: string;                   // memberId whose app serves file bytes; never moves; a file room dies with it
  authority: { memberId: string; epoch: number };  // the app holding authority right now (§4.4)
  controllers: string[];           // who may do room actions; always includes the owner (ADR-030)
  page: string | null;             // the third-party page every app navigates to (§1)
  media: Media | null;             // file mode only; null in website mode
  playback: Playback;
  revision: number;                // monotonic; clients discard stale
  members: Map<string, Member>;
  chat: ChatMessage[];             // ring buffer, 100
};

type Playback = {
  playing: boolean;
  position: number;   // media seconds, valid at `updatedAt`
  updatedAt: number;  // authority's epoch ms
  rate: number;       // 1.0 unless a room-wide speed change (out of scope v1)
  startAt?: number;   // scheduled start instant, if pending
  timelineDuration?: number; // room's canonical duration, for mismatch detection
};

type Member = {
  id: string; name: string | null; joinedAt: number;   // null renders as "anonymous" (R26)
  transport: 'app' | 'addon';
  status: 'online' | 'suspect' | 'offline';
  lastSeen: number;
  rtt: number;                     // round trip to the authority
  timelineOffset: number;          // seconds, per-member; see §4.5
  source: { origin: string; duration?: number; w?: number; h?: number } | null;
  driftStrikes: number;
  ready: boolean;                  // for the ready gate
  address: string | null;          // direct endpoint for the mesh (ADR-023); null until shared
};
```

`controlMode` is gone; room actions are gated by `controllers` instead (ADR-030). `Member.offset` is gone too — a
clock offset is measured by the client, never by the authority (see the corrected invariant 4). The room is
replicated to every connected app, so a late joiner can be handed the room and the chat tail by any member, not only
by one machine.

### 4.2 Media

v1 uses two kinds. The rest are recorded for later and are not built (ADR-027).

```ts
type Media =
  | { kind: 'external'; page: string }                                        // website mode: the app loads the page
  | { kind: 'file'; id: string; title: string; duration: number; subtitleTracks: Track[] }  // file mode, LAN or test
  // as built in phase 1: the wire record adds `contentType` (the response type for /media/<id>) and omits
  // `subtitleTracks`, which nothing reads yet — R14 is not M1. No other field is added.
  // v2, not built: direct (Mode 1), hls (Mode 2), transcode (Mode 3)
```

In website mode `media` is `null` and `page` carries the address. File mode sets `media` and clears `page`. A room
that held a file may take a page (ADR-038, amended 2026-11-22): the page commit clears `media` in every window.

A commit is a new film: `pageCommitted` and `media` both start the room at position 0, paused (R44, ADR-050). A
viewer's volume and mute are the window's own - they survive the site replacing its player and never travel to the room.

### 4.3 Invariants

1. Only **commands** (play/pause/seek) mutate `playback`. Client position reports never do.
2. `revision` increments on every mutation; clients ignore anything older than what they hold.
3. `position` is always "where the playhead was at `updatedAt`", never "where it is now".
4. `rtt` is measured by the client from its own ping every 5 s; the clock `offset` is computed by the client and
   never by the authority. (Earlier drafts claimed the server held each member's offset; a ping alone cannot
   yield it.)
5. The room stores the page address **as pasted** — query string and fragment included (§10.3, ADR-052) — so a link's
   private part is shared with the room's members, which the owner accepted on 2026-11-24.
6. Authority-bearing mutations carry the authority `epoch`; a stale epoch is rejected. Two apps can never both
   believe they hold authority.
7. `timelineOffset` is per member and never mutates room playback (§4.5).
8. Every member holds a replica of the room; authority is the only writer (ADR-024). Replicas are repaired from
   the authority, never merged.
9. **Every player is a follower.** No client ever adopts a position the player chose by itself; on any load or
   replacement it is commanded to the room's expected position (ADR-029). This is what makes a mirror switch keep
   the time.
10. **Personal choices never mutate room state.** Mirror, sub/dub, audio track, subtitles, volume and view mode are
    that member's alone and are never broadcast (ADR-030, R34).
11. **Room actions require control.** `play`, `pause`, `seek` and page changes from a member outside `controllers`
    are refused with `not_controller`, not silently applied (ADR-030, R33).

### 4.4 Ownership, authority and transfer

Two roles, and the difference matters (ADR-025):

- **Owner** — the member whose app serves local file bytes. Never moves. A file room ends when they leave.
- **Host** — whoever currently holds authority: the single writer of room state. Moves automatically. Website
  mode does not depend on it, which is what makes a transfer invisible (ADR-024).

Presence states, driven by heartbeats every 5 s: `online` → `suspect` at 10 s → `offline` at 20 s.

A member's identity is one id minted once and kept in a cookie the app sets on its own host, beside the name
(ADR-053) - not in `localStorage`, because the sidecar's port changes every run.

Transfer, when the host reaches `offline` (or leaves cleanly):

1. Candidate = the online member with the smallest `joinedAt` (tie-break by id). Deterministic on every replica,
   so no vote and no negotiation.
2. The candidate increments `room.authority.epoch`, takes `memberId`, and broadcasts
   `authorityChanged {epoch, memberId, reason}` to every peer.
3. Every authority-bearing command carries the epoch the sender believes in. Mismatch →
   `error{code:'stale_host'}`, ignored. A returning host is an ordinary member and **never auto-reclaims** (the
   impersonation hole KoalaSync documents as `NOFIX-1`).

4. **Control travels with authority** (ADR-033). The new host can act immediately, and keeps any grant it already
   held. If no online member holds control at all — every controller left — the roster offers **Take control** to
   everyone and the first press wins.

In website mode this is invisible: each app is streaming from the site, so nothing on screen depends on who holds
authority. The gap is a few hundred milliseconds of chat and control, not film. In file mode the room cannot
survive at all, because the owner holds the only bytes.

What each party learns, honestly:

| Party | What happens |
| --- | --- |
| Host, while disconnected | Cannot be told at the moment it happens. Sees "connection lost" within ~10 s, and on return a "Sam has the room now" notice. |
| Host, app open but the film's page closed | May still hold authority with no player. Not an error; the room shows "host has no player" and waits. |
| Everyone else | Toast + roster badge, within one heartbeat. |
| The new host | "You have the room now" toast. Control follows the host role (ADR-033); nothing else changes. |
| Nobody has authority (all apps closed) | Website mode: the film keeps playing in nobody's app, so the room is over. File mode: same. Nothing is left running to keep. |

**Why there is no "orphaned room" any more.** Rooms do not live on a machine that outlives its members, so a room
with no members is simply gone. A replica held by an app that has not noticed its peers left is discarded when its
last connection fails; there is no timer and nothing to clean up.

### 4.5 Per-viewer time offset

Some sources differ between viewers even when they are "the same episode": different mirrors with different
encodes, or a dub whose runtime differs from the sub (extra OP/ED, trimmed silence, a different edit).

Each member carries `timelineOffset` seconds, applied symmetrically — exactly how Syncplay does it:

```
expectedFor(member) = expected(room) + member.timelineOffset
reportFrom(member)  → member.position - member.timelineOffset   // before comparing
```

So a viewer whose copy runs 6 s ahead simply has `timelineOffset = +6` and the correction maths works unchanged.

Setting it:

- **Duration and origin are shared automatically.** Every position report carries the member's `duration` and
  `origin`; nothing is asked of the viewer. The first report of a duration sets the room's canonical
  `timelineDuration`; later reports that disagree are flagged, never overwritten. This is what makes mismatch
  detection free.
- **Align here** (primary): while paused, sets `timelineOffset = room.position − my.position`. The sign falls out
  of the arithmetic, so nobody has to reason about it.
- **Nudge**: −5 / −1 / +1 / +5 s. Deliberately signed both ways — which direction is "wrong" depends on whose copy
  the room is using.
- **Suggested**: whichever app holds authority offers the value when the difference has been stable (§ worked
  example below).

Sign convention, so the table is unambiguous (`target = roomPosition + timelineOffset`):

| Situation | Room timeline comes from | My copy | Offset |
| --- | --- | --- | --- |
| Dub has a 5 s logo, room is the sub | sub | my content runs 5 s ahead | **+5** |
| I'm the sub, room is the dub (logo at 0) | dub | my content runs 5 s behind | **−5** |
| My copy just has 5 s more credits at the end | either | identical until the tail | **0** — do nothing |

**The trap: never align to the longer duration.** "My copy is 5 s longer" is equally consistent with a front logo
(needs ±5) and a tail credit roll (needs 0). Applying 5 in the second case misaligns the entire episode in the
wrong direction, which is worse than the original problem. That is exactly why the value comes from stable observed
position and not from the duration delta.

**Clamping.** Seek targets clamp to `[0, duration − 0.25]`. If `roomPosition + offset < 0` (a negative offset early
in a film), the client holds at 0 and shows "waiting for the room" rather than seeking negative; the ready gate uses
each member's own target, so nobody is released early.

**Scope.** Offsets exist in **website mode only** — the one mode where viewers genuinely have different copies
(different mirrors, different mirrors of a dub). In file mode every viewer receives the same bytes, so the control
is hidden and `timelineOffset` stays 0. (The earlier draft listed `direct` and `hls` here; both were our own proxy,
which sends identical bytes, so the control had no meaning there either.) The control lives in the shared room
panel, so when the add-on arrives it appears there too.

Limits, stated plainly in the UI:

- A constant offset fixes mirrors and constant-length differences. It **cannot** fix a genuinely different edit.
  For that, v2 adds **anchor points**: a list of `{roomTime, myTime}` pairs, piecewise-linearly interpolated, with
  a one-click "add sync point here". Handles a different OP or an ad break.
- If `|myDuration − room.timelineDuration| > 2.5 s` (Syncplay's `DIFFERENT_DURATION_THRESHOLD`), the member gets a
  persistent "your copy differs" badge and corrections become advisory rather than authoritative.

#### Worked example: the dub with a 5-second logo

The dub opens with a 5 s studio logo the original doesn't have. Consequences, all of which the design handles:

- The dub copy is 5 s longer, so the duration check flags it immediately: `|Δduration| = 5 > 2.5`.
- Alignment is a **constant** 5 s for the whole episode, so one offset fixes it: the dub viewer sets
  `timelineOffset = +5` and jumps past the logo; the sub viewer needs nothing.
- If instead the extra 5 s were *credits at the end*, the right offset would be 0 — the episodes agree until the
  tail. So duration delta alone cannot tell you which case you're in.

**Therefore: suggest from observation, not from duration.** Whichever app holds authority watches a member's own
drift samples. If
`myPosition − expected` stays within ±0.5 s of the same value for 10 s **and** the correction ladder has been idle
in that window (no nudge, no seek for 10 s), that value is content, not network. The UI then offers a one-click
"your copy runs 5.0 s ahead — align?" and the member accepts or ignores.

Requiring "ladder idle" is what stops us from baking a bad connection into a permanent offset.

**Per-episode memory.** Offsets are stored per `sourceKey` (origin + rounded duration, or for our own files the
media id) in the member's own app settings, so next week's episode of the same release is aligned automatically.
Never store them per room — a room is a session, the mismatch is a property of the copy. (The add-on keeps its own
copy of this in extension storage when it exists.)

**Explained mismatches.** If a member has an offset and their duration differs by approximately that offset
(±1 s), the badge downgrades from "your copy differs" to an info line: "your copy is 5.0 s longer (intro),
aligned". The point of the badge is to catch *unexplained* divergence, not to nag about the logo.

### 4.6 Chat

One chat per room, held in the replicated room and rendered by both front doors (the app window and, later, the
add-on overlay). Same history, same ordering, same replay for late joiners.

```ts
type ChatMessage = {
  id: string;          // server-generated, sortable
  kind: 'user' | 'system';
  memberId?: string;   // absent for system messages
  name: string;        // display name at send time
  text: string;        // user: ≤ 2000 chars, sanitised; system: generated, never user-supplied
  ts: number;          // server epoch ms
};
```

Rules:

- **Authority-assigned ids and timestamps.** A client cannot backdate a message to reorder history.
- **Ring buffer of 100**, sent in `welcome` as `chatTail`. No paging in v1.
- **Rate limit:** 5 messages per 10 s per member, then a soft warning and a 10 s mute. Also a 2000-char cap and a
  total-bytes-per-minute cap, so one pasted wall of text cannot stall the room.
- **Plain text only.** No HTML, no markdown, no link unfurling (a link is rendered as clickable text; we never fetch
  it). This is the whole of the sanitisation story and it is enough.
- **System messages** are generated by whichever app holds authority and rendered dimmed: *joined*, *left*,
  *has the room now*, *seeked to 12:34*, *page changed*. Never assembled from user input. **Per-member facts do not
  go in chat**: "your copy differs" and "aligned +5 s" are badges on that member's row in the roster and a toast
  for them alone. Chat is room-wide; a member-specific sentence in it confuses everyone else. (An earlier draft put
  them in chat; that was wrong.)
- Chat state lives in the room, not in a member, so it survives a member reconnecting and is identical for a member
  who joins on the other front door.
- **A notice has an end.** A warning the app raises (a mute, "too many messages", "the player has not caught up", a
  put-back that gave up) is not a chat message and never joins the log: it carries a lifetime or a condition and a
  dismiss button, and it leaves the column when that passes, instead of reading as a new message every time the eye
  returns (phase 6, ticket 149).

---

## 5. Protocol

Transport: WebSocket over TCP between apps (ADR-023) — no web server in the middle, no polling, no long-poll
fallback. In v1 the owner's app holds authority and every other app connects to it; from the mesh milestone onward
(v2) every app also connects directly to every other, and the same frames travel peer-to-peer. Direction is written
as **member → authority** and **authority → members** so it survives that change untouched.

| Dir | Type | Payload | Notes |
| --- | --- | --- | --- |
| m→a | `hello` | `{code, name?, lastEpoch, id?, proof?}` | creates or joins; `name` may be absent (R26); `id` is the page's stored seat and `proof` its secret (ADR-033 rule 1, ADR-053 as amended 2026-11-25) - a `hello` naming an occupied seat without the matching proof is seated as a fresh member, and a client with neither still joins |
| a→m | `welcome` | `{selfId, room, members, chatTail, epoch, proof?}` | full snapshot; `proof` is that member's own seat secret (ADR-053), sent to it alone and never in a broadcast |
| a→m | `members` | `{members}` | on join/leave/rename/offset |
| m→a | `ping` | `{t0}` | clock sync + liveness |
| a→m | `pong` | `{t0, t1, t2}` | see §6.1 |
| m→a | `rename` | `{name}` | anyone; null clears back to `anonymous` |
| m→a | `setPage` | `{page, stageMs, epoch}` | controller only (ADR-030); staged, not applied (ADR-032) |
| m→a | `cancelPage` | `{epoch}` | cancels the sender's own pending change; nobody else ever hears of it |
| a→m | `pageCommitted` | `{page, by, at}` | sent when the 5 s window expires; every app navigates now; the room's playback resets to position 0, paused — a new page is a new film |
| m→a | `grantControl` | `{memberId, allow, epoch}` | controller or owner; roster shows the result; survives reconnect (ADR-033) |
| m→a | `claimControl` | `{}` | allowed only when no online member holds control; first to arrive wins |
| m→a | `setMedia` | `{media, epoch}` | file mode; owner only, since they serve the bytes |
| a→m | `media` | `{media}` | the room's media, to every window including the owner's; the only way a window already in the room learns of a pick; a pick starts the room at position 0, paused (R44) |
| a→m | `authorityChanged` | `{epoch, memberId, reason}` | see §4.4 |
| a→m | `roomOver` | `{reason}` | file mode: the owner's close ends the room (`owner_left`) — §14, ADR-024. No reconnect, no recovery; the page also prints the sentence locally when the authority's process is gone |
| m→a | `play` | `{position}` | controller (ADR-030) |
| m→a | `pause` | `{position}` | controller |
| m→a | `seek` | `{position, wasPlaying}` | controller; may trigger ready gate |
| a→m | `state` | `{playback, revision, by, reason}` | broadcast to **all**, incl. sender; a picked file's reset follows the `media` frame with `reason: 'media'` at position 0, paused (R44) |
| a→m | `ready` | `{ready[], waiting[], deadline}` | gate progress |
| m→a | `readyAck` | `{}` | sent when the player is ready at the seek target (§6.5) |
| a→m | `nudge` | `{target, rate, untilAuthorityMs}` | to one client only |
| m→a | `setOffset` | `{timelineOffset}` | per member (§4.5); authority re-broadcasts `members` |
| m→a | `chooseTrack` | `{trackId \| null}` | per member, file mode (R14) |
| a→m | `sourceInfo` | `{membersWithDifferentSource}` | after reports |
| m→a | `report` | `{position, readyState, buffered, rate, duration, origin, rtt}` | every 3 s while playing; duration is auto-shared; `rtt` is client-measured (§6.1) and is how the authority learns `2 × maxRtt` for the scheduled start (§6.4) |
| m→a | `chat` | `{text}` | ≤ 2000 chars, rate-limited |
| a→m | `chat` | `{id, name, text, ts}` | |
| a→m | `warning` | `{code, message, retryAfterMs}` | one transient notice with its own end; `retryAfterMs` is the mute's remainder, so it goes away without a second frame (ADR-049) |
| m→a | `rescueRequest` | `{}` | v2 (ADR-026): "I can't load the site" |
| a→m | `rescueGrant` | `{memberId, allowed}` | v2: the owner's decision, and only that member is relayed |
| a→m | `peers` | `{members: [{id, address}]}` | v2 mesh: who to dial directly (ADR-023) |
| a→m | `error` | `{code, message, retryAfterMs?}` | stable codes only; `retryAfterMs` is the mute's remainder when the code is the mute |

Rules:

- **Every command is echoed to the sender.** Client handlers are idempotent: `play()` on a playing element is a
  no-op; a seek within 0.3 s of current position is skipped. This removes the "local fire + broadcast fire"
  double-apply bug.
- **Chat is centralised on the broadcast**, so the sender does not append locally.
- **Authority-bearing frames carry the epoch** (`setPage`, `setMedia`). A stale epoch is rejected with
  `stale_host` rather than silently applied — the difference between "you are out of date" and two people editing
  the room at once.
- **Playback commands do not carry an epoch.** Any member **with control** may issue them (ADR-030); the authority
  orders them by arrival, and `revision` settles disagreements. Requiring an epoch here would mean a promoted member
  could not pause.
- **A refusal is explicit.** A room action from someone outside `controllers` returns `error{code:'not_controller'}`,
  which the client shows as "only Sam can change this" rather than swallowing. A silent no-op reads as a bug.
- **Player-originated events are tagged.** A seek that came from the site's own skip or auto-next carries
  `reason:'player'` so the other clients can tell a skip from a human seek (ADR-029).
- Unknown message types are ignored, not fatal (forward compatibility).

---

## 6. Sync

### 6.1 Clock offset (§research 4a)

The client keeps an EWMA of `offset` from `pong` samples, weighted toward samples with the lowest `rtt` (min-RTT
filter). `authorityNow() = Date.now() + offset`. Use `performance.now()` for intervals and `Date.now()` only to
anchor. The `ping` that runs every 5 s for liveness is also the clock sample, so there is one loop, not two; the
filter is reset (not just fed) on reconnect and whenever a sample jumps by more than 2 s, which is usually a
sleeping laptop rather than a real clock change. The authority never needs to know a member's offset — it only
needs each member's `rtt` for the scheduled start (§6.4).

### 6.2 Expected position

```ts
const expected = (p: Playback, now: number) =>
  p.playing ? p.position + (now - p.updatedAt) / 1000 * p.rate : p.position;
```

This one function is why late joiners and stalling clients recover without extra traffic.

### 6.3 Correction ladder (from Syncplay's tuned constants)

| Drift | Action |
| --- | --- |
| < 0.25 s | nothing (ADR-039) |
| 0.25 - 1.5 s | `playbackRate = 0.95` (or 1.05) until back under 0.25 s |
| 1.5 – 4 s | same nudge; a bit of visible lag is preferable to a jump |
| > 4 s (or > 1.75 s *behind*) | hard seek to `expected` |
| paused | snap directly |

Rules: two consecutive bad reports before correcting; never correct more than once per 5 s per client; always
restore `playbackRate = 1` afterwards.

### 6.4 Scheduled start

Never "play now". Server sets `startAt = serverNow() + max(2 × maxRtt, 1.5 s)` and every client schedules `play()` on
a timer against the corrected clock. This is Jellyfin's `LastActivity` trick and the single cheapest accuracy win
available. (Corrected 2026-11-20: the earlier `max(2 × maxRtt, 600 ms)` with a "(min 1.5 s)" parenthetical
contradicted itself, since the floor dominates the 600 ms term. R6's test row already allows up to 1.5 s.)

### 6.5 Ready gate (seek during playback)

1. Initiator sends `seek{wasPlaying: true}`.
2. Server pauses everyone, sets `playback`, broadcasts `state{reason:'seek'}` + `ready{deadline: now+8s}`.
3. Each client seeks to the target, waits for `readyState >= 3`, sends `readyAck`.
4. When all ack, or the deadline passes, server broadcasts `state` with `startAt` → scheduled start.
5. Clients that never acked keep trying; they will be nudged by §6.3.

### 6.6 Echo suppression (extension and web player)

Programmatic `play()/pause()/currentTime=` fire the same events as user actions. Keep a Set of expected events
with per-entry expiry (~1 s). On a matching event, consume and drop it. Without this, two clients ping-pong
commands forever.

### 6.7 Offset-aware correction

`timelineOffset` (§4.5) is applied on both sides of the comparison, so the ladder is unchanged:

```ts
const target = expected(room.playback, serverNow()) + me.timelineOffset;
const drift  = Math.abs(target - video.currentTime);
```

Two extra rules:

- **Changing the offset must not fire a hard seek.** When `setOffset` changes, apply the new target silently, and
  suppress the ladder for that member for 2 s (otherwise adjusting by 5 s triggers exactly the jump the user was
  trying to avoid).
- **Never nudge a member that is buffering.** A rate change on a starved client makes the stall worse. While
  `readyState < 3`, correct only by hard seek at an idle moment, or wait.

---

## 7. Media

Two modes are in v1, in this order (ADR-027). Everything else is recorded in research §20 and is not built.

### 7.1 Website mode — the product

A member sets `page`. Every app's browser window navigates itself there, and the player in that page is what gets
synced. No bytes of video ever travel between machines: each app streams from the site directly, which is why this
mode is free, why the owner's upload does not matter, and why the room can survive its owner leaving (ADR-024).

What has to be true for this to work, and what to do when it isn't:

- **Find the playing video.** Ads, hidden preloads and parked mirrors are normal, so score candidates by visible
  area, `readyState`, having a source, and currently playing; keep the winner and only re-elect when it disappears
  (§10.1, which applies to the app's browser too).
- **Suppress our own echoes** (§6.6). Without it two apps ping-pong commands forever.
- **Ad filtering is on by default** (R20). It is not a nicety: these sites are unwatchable otherwise, and it is the
  main reason the app exists rather than an add-on.
- **If the site refuses to play inside our window** — a few do, usually by sniffing the user agent or demanding a
  top-level window — show that plainly and offer the rescue in §7.3 or "open it in your normal browser" (where the
  add-on, once it exists, can still sync).
- **Fullscreen belongs to us** (ADR-028). Intercept the page's fullscreen request, expand the picture to fill our
  window, and keep the chat and roster where they are. Of eleven sites tested in E2, seven took the whole screen
  and four stayed inside; the app has to make that a choice rather than a lottery.
- **The player is a follower, and gets realigned at four moments** (ADR-029, ADR-048, R32): when the video element is
  replaced (mirror switch, quality change, a site rebuilding its own player), when a navigation finishes, when the site
  changes its own address without a reload (an episode picked inside the site's own page, ADR-048), and when the window
  regains focus. Without those four, a site can silently move the goalposts mid-film.
- **A YouTube address is played by us, not by youtube.com** (R46, ADR-051). The address is reduced to one video id and
  one watch form (ticket 156), and the room's page is the app's own embed page, served by the room's host, driving the
  YouTube IFrame API for play, pause and seek - no account, no site page, and the room's commands go through the API
  rather than through whatever player the site chooses to show.
- **Peer-to-peer plumbing is blocked before the page runs**, with a one-line notice and a per-site Allow switch
  (R35, ADR-031). The video is usually not the thing being shared — on the one site that triggered it, the film came
  over plain HTTPS — but a page uploading to strangers is the only part of this design we do not control, so the
  default is off and the override is one click.

### 7.2 File mode — deliberately small

The owner picks one file from their own disk. That one file, no folder scanning, no library grid, no quality
ladder, no transcoding in v1. Everyone gets the same bytes from the owner's app, so `timelineOffset` is hidden
(§4.5) and the room cannot outlive the owner (ADR-024).

Its real job is to be the honest test rig: sync can be measured here without a third party's website deciding
whether today's test works. It also covers the evening when a site is broken and someone happens to have the file.

### 7.3 Rescue relay — one stranded member (v2)

A member who cannot load the page requests a rescue; the owner grants it; the owner's app relays that one member's
picture, fed by the stream the owner's own app is already playing (ADR-026). Everyone else stays on the site. Not
in v1, and gated on **E9** — whether a page's stream can be reused outside the browser at all, which some sites
prevent by tying the address to the browser session.

### 7.4 Not built in v1: Modes 1–4 and the quality ladder

The direct proxy, the HLS relay, live transcoding, and the persist fallback are all written up in research §20 and
§23 and remain available as v2 options. They exist to solve "the browser cannot play this file", which is a
*file-mode* problem, and file mode is now a test rig. **ADR-004's "one rendition / weakest link" rule goes with
them**: in website mode the site picks the quality per viewer, and we do not get a say.

When they are built, the earlier work still applies: coalesce concurrent range requests so five viewers cost one
upstream fetch, tune segment length against avoiding 4 s black screens on seek, and pre-encode at import rather
than at play time. The sizing arithmetic in research §12 is unchanged.

**Where the detail lives.** The Range proxy's coalescing rules, the playlist rewriting, the ffmpeg command, and the
`-copyts`/`-output_ts_offset` landmine that E3 was designed to settle are all in research §20 and §23 — nothing is
lost by not repeating them here. The quality ladder's arithmetic is research §12. What was wrong was only the
*ordering*: all of it serves files, and files are no longer the product.

---

## 8. Subtitles (file mode, v1)

- Extract text tracks at import to WebVTT: `ffmpeg -i in.mkv -map 0:s:0 -c:s webvtt out.en.vtt`.
- Serve sidecars; render as multiple `<track kind="subtitles">`. Selection is per member via `chooseTrack` (§5),
  stored on the member record (not in `playback`), so it never affects sync.
- Image-based subs (PGS/VobSub) are not convertible: either burn in per file or skip. Say so in the UI.
- ASS styling: accept plain-VTT loss in v1; JASSUB later if the anime case proves it matters.
- **In website mode subtitles belong to the site's player**, not to us. We do not extract, convert or style
  anything there; the site's own subtitle menu is the source of truth. That is a deliberate limitation of choosing
  "everyone streams from the site" over "we serve the bytes": see research §13.

## 9. Audio languages (v2, not built)

Plain MP4 cannot switch audio tracks cross-browser (`HTMLMediaElement.audioTracks` is not Baseline). Multi-language
therefore means HLS with `EXT-X-MEDIA` alternate audio: **one video rendition, N audio renditions**, ~128 kbit/s
each. Switching mid-film may force a 1–2 s re-buffer: treat it as a room event (pause, switch, scheduled restart).
In website mode the site's own menu handles it and nothing here applies.

## 10. The add-on (fallback, later — website mode only)

Not v1. When built it does exactly one job: take over the tab, navigate it to the room's page, sync that page's
player, carry chat. No local files, no relaying, no media library. ADR-022 explains why it is second and what it
cannot do that the app can.

```
manifest.json   MV3; host_permissions ["<all_urls>"]; content_scripts all_frames:true, match_about_blank:true
content.js      find the playing <video> (incl. shadow DOM, same-origin subframes)
                report play/pause/seeked/ratechange + currentTime; apply commands; suppress echoes
background.js   one WebSocket per room peer; reconnect with backoff; persist room+name in chrome.storage
popup           name (or anonymous), room link, join/leave, "sync this tab"
```

### 10.1 Frame election

Score candidate `video` elements by: visible area, `readyState`, not muted-and-0×0, has `src`, currently playing.
Stick to the winner; re-elect only when it disappears. Hidden preloads, ads, and parked mirrors are the norm. The
app needs this logic too — owning the browser removes the *cross-frame* problem, not the *which video* problem.

### 10.2 MV3 service worker lifetime

The background worker is killed after ~30 s without events (Chrome 110+ lets events reset the timer, removing the
old hard 5-min cap). **Design for termination:** never hold state only in memory, reconnect on wake, and treat the
connection as re-establishable. Do not depend on being alive between messages. This is the first of the four
problems ADR-022 buys us out of by shipping an app instead.

### 10.3 Page following

`room.page` is set by a member who holds control (R21, R33); on join or on change, the add-on navigates the tab if it
isn't already there. The address is shared with the whole room and is stored **exactly as pasted**, query string and
fragment included (ADR-052; the owner's answer, 2026-11-24), so an episode link that lives in the query takes everyone
to that episode - and a tokenised link is therefore copied to the room's members. The app does the same thing natively.
One exception to *exactly as pasted*: a YouTube address is reduced to one video id and one watch form (R46, ADR-051), so
`youtu.be`, a `?t=` start and a share link are one page for the room (ticket 156).

### 10.5 Chrome and Firefox from one codebase

Both are Manifest V3, but the background differs and one manifest cannot be shipped to both stores unchanged:

```jsonc
// manifest.chrome.json
"background": { "service_worker": "background.js", "type": "module" }
// manifest.firefox.json
"background": { "scripts": ["background.js"] },
"browser_specific_settings": { "gecko": { "id": "watchparty@example.invalid", "strict_min_version": "121.0" } }
```

- Chrome runs the background as a **service worker** and kills it when idle (~30 s without events).
- Firefox runs it as a **non-persistent event page**: same "may be unloaded" discipline, different lifecycle, no
  30 s timer.
- Write the shared code against promise-based APIs and load `webextension-polyfill` (or a 20-line shim) so
  `browser.*` works in both.
- Firefox displays requested host permissions in the install prompt from version 127; Chrome shows them too. Either
  way the user sees "read and change your data on all sites", which is normal for this category but worth a plain
  explanation on the store listing.
- Distribution reality for a five-person tool: Chrome needs either developer-mode unpacked (re-enabled after
  restarts) or an unlisted store listing; Firefox allows free unlisted signing through AMO. Both are one-time
  setup, not per-update.

### 10.6 Chat overlay (the add-on's front door)

The add-on has no room window, so it carries its own minimal UI: one panel with the room's chat, the member count,
and the sync controls that aren't available through the site's own player (align offset, ±1/±5 s, ready state).
Same messages, same code path as the app's chat panel — that is what makes R18 true rather than aspirational, and
it is why chat lives on the room rather than in either client.

Keep it genuinely simple: message list, input, member count, offset controls. No threads, no reactions, no
attachments, no typing indicators.

The app deletes most of this work: its chat is an ordinary panel next to its own browser window, so none of the
following applies to it. Every item below is a cost the add-on pays for living inside someone else's page:

- **Shadow DOM.** Inject one host element and build the UI inside a shadow root, so the site's CSS cannot restyle
  it and ours cannot leak into the page.
- **`adoptedStyleSheets`, not `<style>`.** A strict page CSP can block inline styles; a constructed stylesheet
  attached to the shadow root is not subject to it. This is the single most common way overlays silently lose their
  styling.
- **Fullscreen.** When a page goes fullscreen, only the fullscreen element and its descendants render. On
  `fullscreenchange`, re-parent the host into `document.fullscreenElement` and put it back on exit. Skip the
  picture-in-picture case — nothing overlays PiP; show a "chat available in the tab" note instead.
- **Keyboard isolation.** Sites bind space, arrows, and letters on `document`. The input must swallow
  `keydown`/`keyup`/`keypress` in the capture phase with `stopImmediatePropagation()`, or typing "ar" pauses and
  seeks the film.
- **Click isolation.** Overlay clicks must not reach the player (`stopPropagation`), or reading chat pauses the
  video.
- **Never steal focus on load.** Focus the input only when the user clicks it.
- **Draggable, with a remembered position per origin**, collapsible to an unread-count bubble. Default bottom-right,
  away from typical control bars.
- **Self-healing.** SPA sites replace `document.body` and detach the host. A cheap interval checks that the host is
  still connected and re-attaches; after three failures, fall back to a small always-on-top popup window
  (`chrome.windows.create`) showing chat only.

Chat history lives on the room (spec §4.6), so the overlay and the app window are interchangeable mid-film.

---

## 11. Media library — v2, not built

There is no folder scanning, no grid, and no metadata cache in v1. File mode is "pick one file" (§7.2). The design
below is kept because it was researched and because it is what the library becomes if file mode ever grows up; it
is not a v1 commitment.

When built: walk configured folders for `mp4 mkv webm m4v mov avi ts m2ts`, identity being a hash of the path;
`ffprobe` each changed file into a JSON cache (atomic write); keep duration, codecs, languages, subtitle streams and
chapter count. `h264` + `aac` in `mp4` plays directly; anything else offers a one-time conversion, decided at
import and never per session. Extract subtitles and thumbnails lazily on first use, so a 500-file scan spawns no
ffmpeg processes. Titles come from the filename only. The media directory is mounted read-only; only the cache
grows, and it is safe to delete.

---

## 12. How it runs

```
watch-party.exe
  ├─ UI shell (window, chat, roster, controls)
  ├─ embedded browser (WebView2, ad filtering on)
  └─ listener on one high port, opened via UPnP/NAT-PMP (ADR-023)
```

- **Install:** one file to copy, not an installer (ADR-041, ADR-042). `portable` carries the .NET runtime, the Node
  runtime and the page and uses the WebView2 runtime Windows has; `portable-full` carries the browser engine too. No
  Docker, no Caddy, no TLS certificate, no database, no service.
- **Start:** the app opens on its first screen with its port already open, its address learned and its link shown; one
  press enters the watching screen (ADR-047). If opening the port or learning the address fails it says so *now*, with
  the reason, and offers the fallbacks in §14.
- **Join:** the invite link is the key (ADR-044). A caller who has only the address gets a gate page and nothing
  else; a wrong code is refused and repeated refusals close the door on that caller. The room holds **ten** members
  (ADR-044, 2026-11-22: raised from five, which the design had assumed rather than required).
- **Stop:** closing the app ends the room. In website mode everyone else's film keeps playing from the site; they
  simply lose chat and control until someone starts a new room.
- **Files:** file mode serves from the owner's disk directly. No cache directory, no conversion unless the file is
  already browser-safe (which is checked when it is picked, and refused with a plain message if not).
- **Nothing to configure.** No `PUBLIC_URL`, no `MAX_MEMBERS` — the hard ceiling is ten people, stated in the UI,
  and it is a constraint of the design rather than a setting nobody will change.

## 13. Milestones

Milestones, not modes: each one is demoable. R-numbers are in §2.

| M | Content | Done when |
| --- | --- | --- |
| **M1 A room that syncs** | app shell, room create/join over one direct connection, names/`anonymous`, chat, clock sync, position model, drift ladder, scheduled start, **file mode** | two apps stay within 250 ms for 10 min with one throttled; R1–R9, R11; a file is picked on one machine and plays on the other |
| **M2 Website mode** | embedded browser, ad filtering, **app-owned fullscreen**, page following with **staged changes**, **control role, promotion and Take control**, **personal-choice isolation**, player discovery, echo suppression, per-viewer offsets | R17, R20, R21, R29, R30, R31, R33, R34, R36, R37; two apps open the same page and stay in step; typing in chat never pauses the film |
| **M2b The window uses its space** | two screens (invite/join, then watching), the picture filling the window with a 380 px chat column beside it, chat below the picture under 900 px, the invite bar, a remembered window size, both watching routes always present, the local player's volume bar | R39, R40, and R41's window-local half (its restart half is deferred - ADR-049, ticket 119); pictures at maximised and at 800 px, chat beside in one and below in the other, and a room that ends is back on the first screen |
| **M2c The room behaves** | the chat as the room's log (system lines for changes, times, one scroller, a counting roster), `/name` and the host's crown, a new film at zero and a volume that survives a replaced player, a bounded put-back, a picture that starts without a press, icon controls, YouTube in an app-owned embed, a resize that keeps up, a centred front door that says the room is already open | R42-R50; two windows survive one evening's list - an episode change, a file change, a rejoining guest, a YouTube video, a drag, a cancelled stage - each fault from `phase-6-bugfix/answers.md` not seen again |
| **M2d Browser join** | the invitation a browser can open, a guest who joins and reloads onto one seat, the room's file and the room's YouTube video in an ordinary browser, a small-screen layout, one plain sentence for what a browser cannot show, and one link that serves every friend | R51-R57; two real browsers (one on a phone) in one room with the hosting app: join by the plain address, chat both ways, one play, one seek, one reload; the numbers from the host's log |
| **M3 Gate and resilience** | ready gate, buffering UI, reconnects, source-mismatch badges, quit/join polish, **cinema mode (T29)**, **realign triggers (T35)**, **peer-to-peer block (T37)** | R8, R10, R28, R32, R35; a member on a different mirror is visibly flagged and can fix it in one click |
| **M4 Peer mesh and takeover** | every app connects to every app, room replication, authority transfer with no interruption | R22, R27; the owner closes their app mid-film and nobody's picture stops, chat keeps working, a new host appears within 2 s |
| **M5 Add-on** | website-mode extension, Chrome + Firefox manifests, chat overlay, **installed from GitHub, no store** (ADR-057) | R18, R19, R58; add-on and app share a room; typing "ar" in chat on a site where "a" seeks does not seek |
| **M6 Rescue and Linux** | rescue relay, Linux build | R25, R58, R59; one stranded member is relayed while everyone else stays on the site; the relay has a visible on/off toggle in the window's chrome and never captures the host's picture (ADR-058) |
| **M7 Portable build** | one self-contained executable, and a second with the browser engine bundled; no installer, no rework of the room logic | R38; copied into a fresh folder on a clean machine it starts a room and passes the two-window gate |
| **v2 and later** | single-file library, subtitles for files, HLS relay, transcode, audio languages, Android | as written in §8, §9, §11 and research §23 |

**M7 ran before M2b and M3** (closed 2026-11-22). **M2b runs before M3** - the user's order on 2026-11-23: the layout
first, then "the room obeys". **M2c runs between them** (2026-11-24): the evening's faults and the chat's interface,
planned as `phase-6-bugfix`, because M3's resilience work should not build on a chat that pushes the people down or a
room that duplicates a guest. **M2b also pays an M2 debt:** R21's second route, browsing inside the app, is wired here
(ADR-048), because the address bar and the site view are being reworked anyway. A site's own episode change now takes
the room with it (ADR-048), a controller's typed like an address and a guest's put back.

**M2d runs between M2c and M3** (the owner's order, 2026-11-25): a friend with only a browser should be able to join and
watch before the room's resilience work, so "leave the other ones for later" is on record as M3 waiting for this row.

## 14. Failure behaviour

| Situation | Behaviour |
| --- | --- |
| A member's connection drops | rejoin with the same id, resync from snapshot, no room disruption |
| Host silent 10 s | `suspect`; others see a "reconnecting" badge on that member |
| Host silent 20 s | authority transfers to the earliest-joined online member, epoch bumped, everyone notified |
| Old host returns | rejoins as an ordinary member with a "someone else has the room" notice; cannot reclaim |
| Host returns within the grace window | no transfer happened; silent recovery |
| Everyone gone | the room is over; there is nothing left running to keep (§4.4) |
| Owner leaves in file mode | room ends, everyone told plainly, no pretend recovery |
| Owner leaves in website mode | authority transfers; films keep playing; control goes with it, and if nobody has it, Take control appears (ADR-033) |
| The only controller disconnects and reconnects | control is restored from the stored grant; no ceremony, no regrant |
| Member on a different mirror or dub length | "your copy differs" badge on that member's roster row + per-member offset, never in chat |
| A member cannot load the page | they ask for a rescue; the owner approves or declines (v2, ADR-026) |
| The page's player is replaced by the site mid-film | realign to the room's position (ADR-029); say "reconnecting to the player"; never restart at 0 |
| A site takes the screen on a fullscreen request | refused by design (ADR-028): the picture fills our window, the UI stays |
| A member without control presses pause or clicks an episode | refused with "only Sam can change this" (`not_controller`), and the button explains itself on hover |
| Two members' players auto-skip at different points | the controller's skip becomes the room's; the other member keeps theirs and the offset suggestion explains the gap |
| A page tries to open a peer-to-peer connection | blocked before it opens (ADR-031); one-line notice with an Allow switch; playback unaffected unless the player needed it |
| Windows Firewall asks about the app | it should not any more, because peer-to-peer is blocked by default; if it does, that member allowed a site |
| The page cannot load at all | show the failed load, offer "open in your normal browser", offer the rescue |
| Autoplay blocked | "click to join playback" overlay; that click retries |
| The clock offset is huge (>2 s) | force a re-measure before accepting corrections |
| An address cannot be learned, or the router refuses the port | say so at **start**, with the reason, and offer the fallbacks: same-wifi, or the owner's manual port-forward instructions |
