# Glossary

Plain-language definitions of the terms these documents use. If a document uses a word not defined here, that is
a documentation bug.

## Playback and sync

**Canonical state** — the room's single source of truth: is it playing, at what position, and as of what moment.
The server owns it; browsers never write to it.

**Position** — where the playhead was at the moment the state was written. Always read it together with
**updatedAt**; never as "where it is right now".

**Expected position** — what a browser calculates it *should* be showing:
`position + (now − updatedAt)` while playing, just `position` while paused.

**Drift** — the gap between expected and actual, in seconds. Measured per viewer, not for the room.

**Nudge / rate nudge** — fixing a small drift by playing at 95% or 105% speed for a few seconds. Inaudible because
browsers preserve pitch. Used below ~1.5 s.

**Hard seek** — jumping the playhead. Visible as a hiccup; only used above ~4 s.

**Drift strike** — one bad report. Corrections need two in a row, so a single buffering stutter is not mistaken for
a client that has fallen behind.

**Clock offset** — how far a viewer's clock is from the server's. Measured by pinging and halving the round trip.
Everything time-based depends on it.

**RTT** — round-trip time: how long a message takes to go to the server and back.

**Scheduled start** — instead of "play now", the server says "start at time T", slightly in the future, so that
everyone's message arrives before the start instant. The single biggest accuracy win.

**Ready gate** — when someone seeks during playback, everyone pauses, buffers at the new position, reports ready,
and then all resume together on a new scheduled start.

**Echo suppression** — when we call `play()` ourselves, the browser fires a `play` event that looks exactly like a
user pressing play. We keep a short-lived list of events we caused and ignore them, otherwise two browsers bounce
commands back and forth forever.

## Video delivery

**Byte-range request** — the browser asking for "bytes 1000–2000" of a file instead of the whole thing. This is
what makes seeking a plain `.mp4` instant.

**Mode 0–4** — the five ways video could reach a viewer: 0 = the site's own player (this is what v1 does), 1 = a
direct link proxied, 2 = HLS relayed, 3 = transcoded on the fly, 4 = downloaded once and served as 1. **Only mode 0
and the small file mode are built in v1**; 1–4 are v2 (spec §7.4).

**Proxy / relay** — our server passes bytes between the viewer and the source. No copy is stored, no CPU is used.

**HLS** — the way video is usually delivered on the web: the film is cut into short segments with a playlist file
(`.m3u8`) listing them. Players fetch segments as needed, which is what makes seeking work over HTTP.

**Segment** — one of those short chunks, typically 2–6 seconds.

**Rendition** — one complete version of the media (e.g. the 720p video, or the Japanese audio). A playlist can
offer several; players pick.

**Ladder** — the set of renditions we offer, and their bitrates.

**Rung** — one entry in that ladder. "Pick the highest rung under the budget."

**Transcode** — re-encoding video into a different codec/bitrate. Expensive. Only needed when the browser can't
play the source.

**Remux** — repackaging without re-encoding (e.g. MKV → MP4 with the same video inside). Cheap and lossless.

**Bitrate** — how many bits per second the video needs. This, times the number of viewers, is what the server's
upload must carry.

**Codec** — the compression format. Browsers reliably play H.264 video + AAC audio in MP4; they are unreliable with
HEVC, MKV, AC-3, DTS.

**faststart** — an MP4 layout where the index is at the front, so playback can begin before the whole file
arrives.

**Keyframe** — a complete picture in a video stream; everything after it describes only the changes. Seeking lands
on one, which is why "seek precisely here" is not a thing you can ask for.

**MSE (Media Source Extensions)** — the browser machinery that lets a script feed video data in pieces instead of
pointing at a file. It is what HLS players use, and the reason `readyState` can sit at 2 while the picture is fine.

**ABR (adaptive bitrate)** — offering several quality versions and switching per viewer as their connection changes.
Deliberately not done here: website mode leaves quality to the site, and file mode is a test rig.

**CSP (Content Security Policy)** — a page's rule about what may run or load inside it. Strict policies block
inline styles, which is why browser overlays lose their styling on some sites.

**SPA (single-page app)** — a site that swaps its own content instead of loading new pages, often throwing away
parts of itself. It is why an overlay can vanish without the page appearing to change.

**LRU (least recently used)** — a cache that throws away whatever was used longest ago when it fills up. Only
matters for the v2 relay modes.

**Ring buffer** — a fixed-size list that overwrites its oldest entry when full. That is how chat keeps exactly the
last 100 messages without ever growing.

## Subtitles and audio

**Sidecar subtitle** — a separate subtitle file next to the video, delivered as its own tiny file.

**WebVTT** — the subtitle format browsers understand natively (`.vtt`).

**ASS / SSA** — a subtitle format with styling, fonts, and positioning, used by most anime releases. Converts to
VTT, losing the styling.

**PGS / VobSub** — subtitles stored as *images* (from Blu-rays). Cannot be converted to text; must be burned into
the picture or left out.

**Alternate audio rendition** — a separate audio stream alongside the shared video, so each viewer can pick a
language without re-downloading the picture.

## The app and the network

**The app** — the program one person runs for the evening. It contains a window, a browser, the chat and the sync
engine. There is no separate server to install, rent or run anywhere.

**WebView2** — the browser engine Windows already ships (the same one Edge uses), which the app borrows instead of
bundling a whole browser. The `portable` build uses the machine's copy; `portable-full` carries its own engine; with
neither, the window says one plain sentence (ADR-041, ADR-042).

**Ad filtering** — blocking requests to known ad and tracker addresses before they leave the app. Not a nicety on
these sites; it is why the app exists rather than a browser add-on.

**Anonymous** — a member who joined without typing a name. They can set one later; until then they appear as
`anonymous`.

**Peer-to-peer / mesh** — each person's app connected directly to each other person's app, with nothing in the
middle. In this project the mesh carries chat and control only; the video never travels through it.

**UPnP / NAT-PMP** — the way a program asks a home router to open one door to the internet, so friends can reach
it without anyone touching router settings. When it works, hosting needs no setup at all.

**CGNAT (shared address)** — an internet provider that puts several households behind one public address. Those
connections cannot accept visitors no matter what the app does, so that person can join rooms but never host one.
This is what experiment E1 checks.

**Rescue relay** — one stranded member (geo-blocked, broken player) asking the owner to relay the film to them
alone, fed by the stream the owner's app is already playing. One person, on request, never the whole room.

## Layout of the window

**First screen** - the room's front door. It shows the host's invite in full (the code, the link, the raw fallback,
the same-network link, and the router's state including the failure card), then the box to paste someone else's
invite into. It has no picture, chat, address bar or file picker. Pressing **Start a room** leaves it; a room is
already live behind it (ADR-047).

**Watching screen** - the room itself: the picture with the chat column beside it, and the player's own controls (play,
scrub, volume) under the picture in file mode and the room's controls in the column. Every room in progress is on this
screen.

**Picture** — whatever the room is playing, drawn in the big area: our own `<video>` in file mode, the site's own
view in website mode. The chat never covers it except in cinema mode, which is not built yet.

**Embed page** - the app's own page that hosts a site player: for a YouTube address it holds the YouTube IFrame API
player, and the room's page is that page, served by the room's host, not youtube.com (ADR-051).

**Chat column** - the thin column to the picture's right: invite bar, chat, roster and the room's controls. It is 380 px
wide, and that number is the host's (`--chat-column`), not the page's. Under 900 px of window width it moves below the
picture instead. The address bar is not one of its rows when the page lays out the window itself - see **Address bar**.

**Log line** - a dimmed system line in the chat: a committed page or file change gets one, with its time, and it makes
the chat the room's log rather than a list of messages from people (ADR-049).

**Roster count** - the `N online` row at the chat's head; it opens on a click to show the names and takes no column of
its own (ADR-049 as amended).

**Host crown** - the mark on the owner's row in the roster. A name is set by typing `/name <text>`; there is no other
name control and no "(you)" pill.

**Notice** - a warning the app raises in the chat column for a while - a mute, too many messages, a player that has not
caught up - with its own end and a dismiss button; it never joins the log.

**Address bar** - the page's own top row on the watching screen: one bar across the top holding the field, its **Paste**
button inside the field, and **Open a file** beside it (R29, R40). It sits above the picture and the chat column, which
makes the invite bar the column's first row under it. When the host docks the app view as the chat column - a website
room - the same row is that 380 px column's top row, and the invite bar follows it (ADR-047).

**Invite bar** — the chat column's first row: the room code, the invite link and one Copy button, with the raw address
and code one click inside. Always reachable while watching, including in fullscreen. From R51 it carries **two forms**:
the `watchparty://` link for the app and the plain `http://<address>:<port>/join?c=<code>` address for any browser
(ADR-054).

**Browser guest** — a member who is watching through an ordinary browser, not the app's window: they opened the plain
address from the invite bar, they hold a seat through the same cookie an app guest does, and they have no window host,
so no site view, no Open a file and no app-owned fullscreen. They watch the room's file and the room's YouTube video;
a room on an ordinary website says in one line that this page needs the app (ADR-054).

**Watching route** - one of the two ways a room gets something to play: paste a page address (the address bar) or
**Open a file**. In the owner's window both are on the watching screen at all times, and neither has to be closed to
use the other; a guest has the address bar and no Open a file, because the file is served from the owner's machine
(R11).

**Volume** — how loud this window plays, set by its own slider beside the file player's play and scrub controls. A
personal choice: it never travels to the room (ADR-030, R34).

## Extension

**Extension / add-on** — a small program inside a browser that can read and control a page. In this project it is a
*later, narrower* fallback: website mode only, for anyone who will not install the app.

**Content script** — the part of an add-on that runs inside a web page and can touch its `<video>` element.

**Background / service worker** — the add-on's always-there part. It gets shut down when idle (~30 s), so it must
be able to wake up and rebuild itself. The app has no such problem, which is one reason it exists.

**Frame election** — choosing *which* video element on a page is the real one, when there are several (ads,
hidden preloads, unused mirrors).

**Shadow DOM** — a hidden sub-tree inside a page, where some players keep their `<video>`. Cannot be found with a
plain `querySelector` from outside.

**MV3** — Manifest v3, the current extension format. Stricter than the old one; notably the background worker can
be killed.

## Serverless (ADR-005)

**Signaling** — the initial handshake two browsers need before they can talk directly. WebRTC does not provide it;
something else must.

**WebRTC data channel** — a direct browser-to-browser pipe that carries messages (not video, in our case).

**STUN** — a public service that tells a browser what its address looks like from outside.

**TURN** — a relay used when two browsers cannot reach each other directly. It is a server, and it costs bandwidth.

**Rendezvous** — any agreed meeting point (a public relay, a topic name) that lets two peers find each other.

## Operations

**Room** — one watch session: a code, a member list, a page or a file, a playback position, a chat tail. It exists
only while at least one app is in it.

**Owner** — the member whose app is serving a local file. Never changes hands; if they leave, that room ends.

**Seat** — one person's place in the room, held under a member id the person's own page mints once and the room
adopts (ADR-053); the room mints one itself only when a `hello` names none or a claim is refused. A window that comes
back presents that id together with its **seat proof**; an id presented without the proof that was issued with it is
refused, and the room seats that connection as a fresh member instead (ADR-033 rule 1, ADR-053).

**Seat proof** — the secret the room hands a connection in its `welcome`, stored beside the member id in the app's own
cookie and sent back in `hello`. Only the profile it was issued to can claim that seat; a second window of the same
profile presenting the same pair is seated on the same row (ADR-053 as amended 2026-11-25).

**Host** — whoever currently holds **authority** (see below). The word deliberately does not mean "the person in
charge": the host is only the app that is currently writing the room's state, and holding it is not permission to
change the room — that is **control** (ADR-030).

**Authority** — the right to be the one writer of room state. Exactly one app has it at a time; it moves by rule
when that app goes quiet, and every write carries the **epoch** so a stale writer is rejected. In website mode
losing it changes nothing on screen.

**Control** — permission to do *room* actions: play, pause, seek, choose the page, choose the film. The owner always
has it and may grant it to others; the roster shows who has it; a grant survives a reconnect, control follows the
host role, and anyone can claim it if nobody has it. Not the same as authority: authority is one app writing state,
control is people being allowed to ask.

**Staging** — a room change is held for five seconds before it reaches anyone (two seconds until 2026-11-24, ADR-032 as amended). The person who made it sees the new
page immediately with a countdown; everyone else's screen does not move, and if it is cancelled they never learn it
happened.

**Personal choices** — everything that must never move anyone else: which mirror or server, sub or dub, audio track,
subtitles, volume, chat column or cinema. Each app has its own browser, so these simply stay put.

**Control mode** — *gone.* There is no host-only *mode*: control is a role that anyone may be granted (ADR-025, as
amended by ADR-030 — "everyone controls" was reversed).

**Epoch** — a counter that goes up every time authority moves. Commands carry it so an old writer's late messages
are ignored. Without it, two apps can write the room at once.

**Grace period** — how long the room waits after the host goes quiet (20 s) before handing authority to someone
else, so a brief hiccup does not move the room.

**Promotion / demotion** — the host role moving to another member, and the old host returning as an ordinary
member without getting the role back.

**Mirror** — one of several interchangeable servers/players for the same episode on a streaming site. Different
mirrors can be different encodes with different lengths.

**Sub / dub** — subtitled vs. dubbed audio. Usually the same video; sometimes a different edit, so the runtimes
differ.

**Timeline offset** — a per-viewer, **signed** number of seconds added to that viewer's target position, so someone
watching a slightly different copy still lands on the same scene. Set with "Align here" while paused, or nudged
±1/±5 s. Used in **website mode only**, where viewers genuinely have different copies; never for a file the owner
streams, where everyone gets identical bytes.

**Anchor point** — a recorded pair of "room time ↔ my time" used to map between two differently edited copies.
Several anchors give a piecewise mapping; one is just an offset.

**Event page** — Firefox's equivalent of Chrome's service worker: the extension's background script, unloaded when
idle, with no fixed 30-second timer.

**Invite link** — one link the owner posts once. It carries the room code and the owner's address, so nobody types
either. Clicking it opens the app. The old trick of hiding the code in a third-party site's URL fragment is gone:
the link no longer lands on someone else's page, so there is nothing to hide from.

**Media library** — the folder (or folders) the app is allowed to serve, plus the cached metadata that makes them
browsable. Not a media server: no users, no metadata scraping, no remote access.

**Overlay** — the small chat + controls panel the extension draws on top of a third-party page.

**Cinema mode** — watching with the chat floating translucently over the picture instead of beside it. It fades out
when the mouse stops moving so it is not in the way, and comes back when you move, type, or someone speaks. The
alternative is the **chat column** beside the film. Per member, remembered.

**Shadow root** — an isolated sub-tree a page (or an extension) can attach to an element, so its styles in and out
don't collide.

**Constructed stylesheet** — a stylesheet created in script and attached to a shadow root, rather than written as a
`<style>` tag. Chosen because strict page security policies can block inline styles.

**Picture-in-Picture (PiP)** — the small floating player some sites offer. Nothing can be drawn on top of it, so
chat is unavailable while it's in use.

**Portable build** — the one file a friend runs. `portable` carries the .NET runtime, the Node runtime and the page, and
uses the WebView2 runtime the machine already has; `portable-full` carries the browser engine too. Neither is an
installer (ADR-041).

**Payload** — the zip inside a portable executable: the pinned Node runtime, the room's sources and their production
dependencies, the page and the ad list. It is unpacked once per version and payload hash into the exe's own folder,
`<exe folder>\runtime\<version>-<hash8>\`, which becomes the program root; the profile and the logs sit beside it and
nothing is written under `%LOCALAPPDATA%` (ADR-042, as amended by ADR-043).

**Measuring flavour** (`portable-debug`) — the portable build made with the Debug host and the development page, so the
two-window gate can be run and read without a mouse. It is never handed to anyone (ADR-042).
