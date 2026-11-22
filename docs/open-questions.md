# Open questions

Ordered by "how much does the answer change the plan". Items marked **blocker** should be settled before writing
product code; the rest can be settled by building. Every item names its experiment (`handoff.md`) or the decision it
would change.

---

## A. Blockers

### A1 — Can the group's connections accept visitors at all?

The whole network design (ADR-023) rests on one assumption: each person's home router will open a port on request
and the internet provider is not hiding them behind a shared address. If two or more of the group are behind a
shared address, the architecture is wrong, not the code.

**Settle:** E1, per person who might host.
**If wrong:** the peer mesh becomes a star through whoever *can* be reached, or someone has to rent a box — which
the user has ruled out. Either way, find out before T2.

**Result so far (2026-11-17):** the owner's own connection **fails** — UPnP works, but the provider NATs the whole
line, so there is no public address to be reached at (`handoff.md` → E1 → Results). This does not kill the plan; it
moves the host role to whichever member has a normal connection, which the design already supports. It does kill
the assumption that the owner can always host, so two things follow:

1. The app must **test its own reachability at start** and say plainly whether it can host (spec §14 already
   requires this; it is now a first-class feature, not an edge case).
2. If **no** member has a normal connection, ADR-023 has to be reopened. The cheapest reopening is a Tailscale
   Funnel for the *control channel only* — the reason it was rejected was its ~7 Mbit/s cap, and with no video on
   that path the cap no longer applies. That is a service and an account, so it is the user's call, not a quiet
   substitution.

### A2 — Does an embedded browser actually work for these sites?

ADR-022 assumes our own window, on the engine Windows ships, can load the group's real pages, block ads, and drive
the player. Sites sometimes refuse embedded browsers or demand a real tab.

**Settle:** E2, on the actual sites, with the actual ad filter.
**If wrong:** the app becomes a shell around a *real* browser (the add-on) — i.e. ADR-022 is reversed again, and
the four problems it exists to remove come back.

### A3 — Will the room really transfer without anybody noticing?

"Instant takeover" is the promise (R22). The mechanism is sound in website mode because no video depends on the
room; what is unproven is whether replicated state, a moving authority and a full mesh stay consistent under a
real stall rather than a clean quit.

**Settle:** E7.
**If wrong:** the fallback is honest — a "reconnecting" banner for a few seconds and a re-formed room, which is
noticeable but survivable.

### A4 — Can a page's stream be reused for the rescue?

ADR-026 assumes the owner's app can take the video stream its own browser is already playing and hand it to one
stranded member. Many sites tie segment addresses to the browser's cookies or session.

**Settle:** E6 on a handful of real sites.
**If wrong:** the rescue is offered only on sites that allow it, and the UI says so per site rather than promising
it everywhere.

---

## B. Assumptions we are making without hard evidence

| Assumption | Why we believe it | How it fails | What it costs |
| --- | --- | --- | --- |
| WebView2 is present on every guest's Windows machine | it ships with Windows 11 and is installed on Windows 10 via Edge | an old or stripped Windows install lacks it | the smaller copy says one sentence and stops; the larger one carries the engine inside itself (ADR-041) |
| Ad filtering at the request level is enough on these sites | most of these players' ads are separate requests | an ad is stitched into the video stream itself | the video cannot be cleaned without relaying (the rescue path) |
| The site's player can be driven from script inside our own window | it is our window; no origin boundary to cross | the player listens only to trusted (real user) events | synthetic events with `isTrusted`-shaped handling; a real click can be required to start |
| Sites tolerate a room's worth of viewers from different addresses | every person's browser requests from their own IP | a site rate-limits a shared room's page loads | staggered joins; the rescue for whoever is refused |
| 95%→100% rate nudging is inaudible on laptop/TV speakers | standard practice; pitch correction is on by default | someone notices on good speakers | raise the slow-down threshold, accept more hard seeks |
| Four-second HLS segments are fine (v2 only) | Apple recommends 6 s | seek lands on a segment boundary and feels coarse | 2 s segments; more requests |
| A 3 s report interval is enough to keep five people together | every reference project uses 3–5 s | corrections lag on a fast connection | drop to 1 s while a member is being corrected |
| Five viewers is the ceiling | stated by the user | it is 8 | the ceiling is a design constant, not a setting |
| Mirrors of the same episode differ by a constant offset | mirror encodes usually share the source master | one mirror truncates the OP/ED or inserts an ad break | E5; anchor points move into v1 (ADR-017) |
| Sub and dub differ by a constant, if at all | most dubs pad or trim silence; the video is often identical | the dub is a different edit | same as above |
| Chat and control traffic is small enough to never matter | it is text and timestamps, ~1 KB/s | a room with 100 messages tail per join is still tiny | nothing |
| The host's program can hold authority for a whole film without being killed by Windows | it is a foreground app with a visible window | sleep, Windows update, a laptop lid | presence detection and transfer, which exist (ADR-024) |

---

## C. Product questions only the user can answer

**Settled on 2026-11-16** (kept so the answers are not re-litigated):

- Who controls: **whoever holds control** — the owner by default, grantable to anyone (ADR-030, which reversed the
  earlier "everyone" answer of ADR-025). There is no host-only mode.
- Who may start a room: **anyone running the app**. There is no server to protect.
- Where the "box" lives: **the host's own PC, for the evening** (ADR-023). No NAS, no VPS.
- Room lifetime: **while at least one app is in it**. No TTL, no persistence (R16 dropped).
- iOS: **never**. Android: later, as an app with its own browser.
- Library: **v2 or never**, depending on whether file mode grows up (§F).

Still open, and cheap to answer whenever:

1. Is "everyone starts within a quarter second" good enough, or does anyone in the group have a hard requirement for
   frame-accurate?
2. Which subtitle languages matter in file mode, and does ASS *styling* matter (anime signs) or is plain text fine?
3. Does the group habitually pick *different mirrors* of the same episode? E5 answers the technical half; this is
   the human half — do they pick per-person because some are blocked, or just because nobody coordinated?
4. Sub, dub, or mixed? If mixed, which is the canonical timeline for the room?
5. Should the roster show everyone's offset, or is that noise? And should a member be able to *ask* someone to align
   ("Sam, you're 5 s ahead") rather than only each person fixing themselves?
6. When a member is stranded and the owner refuses the rescue, what should they see? (Current answer: the reason,
   and nothing else — but "nothing else" is a poor experience among friends.)
7. **Does a grant survive a machine change?** ADR-033 says grants bind to a stable id per install, so a reinstall or
   a second machine is a new member. If anyone in the group will watch from two devices, say so — the alternative is
   a name-based grant, which is spoofable.

---

## D. Technical unknowns worth a spike

- **Authority transfer under a stall, not a clean quit.** A laptop lid closing is a `suspect` member, not a closed
  app. Does the surviving mesh agree on the same candidate, or do two replicas briefly disagree? (E7 should be run
  twice: once by quitting, once by killing the network.)
- **Two apps that cannot connect.** ADR-023 has no relay by design. If E7 shows a pair that cannot reach each other,
  the room is silently split for them. Detection is the hard part, not the fix.
- **`readyState` as the gate:** on some players it sits at 2 while the picture is fine. The gate probably wants
  "`buffered` covers the target + 2 s" instead. Affects spec §6.5 only.
- **Rate nudge vs. buffer health:** nudging to 0.95 can starve a low-bandwidth client that was only just keeping up.
  The rule "never nudge a buffering member" is in §6.7; whether it is enough is unproven.
- **Chrome's tab-audio/energy saver throttling** — irrelevant now: we own the window. (Kept as a note of what the
  app bought us.)
- **Sites that sniff for a real browser.** What they check, and whether a user-agent override survives it (E2).
- **Offset accumulation:** if two members' cuts differ by 0.1%, that is 5 s over 90 minutes. Does the rate nudge
  absorb it invisibly, or does it fight the offset? Test with a deliberately trimmed copy.
- **A player that replaces its own `<video>` mid-film** (an ad break, a quality switch that re-creates the element).
  How long is the room blind, and does the position survive? (Spec §14 has a row for it; nothing has measured it.)
- **Windows sleep.** A laptop lid closing kills the host. Should the app refuse to host on battery, or warn?

---

## E. Things a reviewer will (rightly) challenge

| Challenge | Answer | If you disagree |
| --- | --- | --- |
| "Why an app and not an extension?" | the extension's four worst problems are page-owned; ours are not (ADR-022) | ship the add-on first and pay them back as bugs |
| "Why not use an existing service like Teleparty?" | it does not exist for these sites, and it needs a company's server | adopt one and lose control of the room's lifetime |
| "Why not WebRTC?" | we do not need it: one side opens a port, the other dials, and only text travels (ADR-023) | add WebRTC as a transport; the protocol is unchanged |
| "Why no TURN relay for the pairs that fail?" | TURN is a server, with an account and a bill, which is the thing being avoided | that pair sits out, or someone rents a box |
| "Why not Socket.IO?" | we own both ends; there is no server to fall back from | swap the transport, keep the message table (§5) |
| "Why not Go for a single binary?" | every reference implementation and both clients are TS/JS | rewrite the transport only; the wire protocol is unchanged |
| "Why no database?" | a room lives while people are in it; there is nothing to persist | SQLite changes nothing in the protocol |
| "Why one writer, not a CRDT?" | five friends, one film; a CRDT is the right answer at a scale we do not have | a CRDT is a contained change behind the same messages |
| "Why a 4 s hard-seek threshold? That's a huge drift." | it is Syncplay's tuned value; smaller thresholds cause audible jumpiness | 2 s threshold, more nudge time, more complaints |
| "Why sync at all — just have everyone watch a live stream?" | that removes seeking and pausing, which is the point | a private-broadcast mode is a v2 option (research §21) |
| "Why trust client-reported positions?" | we don't; reports only trigger per-client corrections (invariant 1) | — |
| "Why is chat in the same connection?" | one connection, one auth story, one reconnect path | a second connection doubles the reconnect logic for no benefit |
| "Why does the owner hold the only file?" | because nobody is paying for storage or bandwidth | spend money; that is ADR-023's whole trade |

---

## F. What moved to v2, and what was dropped

Recorded so nothing looks forgotten. ADR-027 is the decision; this is the inventory.

**v2 or later (requirement survives, not built):** direct-link and HLS relay (Modes 1–2, R12/R13), live transcoding
(Mode 3), the persist fallback (Mode 4), the quality ladder and its capacity probe and the "weakest link" rule
(R15, ADR-004), multiple audio languages, the folder library and its metadata cache (§11), per-file subtitles for
anything other than the small file mode (R14), the rescue relay (R25, after E6), Linux, and an Android app with its
own browser.

**Dropped, with the reason:**

- **Room TTL and orphaned rooms (R16).** A room exists only while an app is in it; there is no machine left running
  to hold one.
- **`controlMode: 'host' | 'everyone'` (ADR-011).** Replaced by "everyone controls" (ADR-025).
- **The `#wp=CODE` fragment invite.** The link now carries the address as well as the code, so there is no third-
  party page to hang a fragment on.
- **"Host closes their laptop and someone else takes over" as a *file-mode* promise.** File mode cannot do it; the
  promise now belongs to website mode only (R22).
- **WebRTC, STUN and TURN (ADR-005).** The mesh is plain WebSocket over an opened port.
- **iOS.** No add-on, and an app store path we are not taking.
- **The five-viewer "hard constraint" as a setting (`MAX_MEMBERS=8`).** It is a design constant now, stated in the
  UI, because there is no server config to get wrong.
