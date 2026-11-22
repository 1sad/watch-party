# Watch Party

Five friends, one film, wherever each of them happens to be. One person starts a small Windows program, shares a
link, and everyone else is in the same room on the same streaming page, in step, with chat.

Status: **M7 ("portable build") closed 2026-11-22** — there is one executable per flavour that opens a window and runs a
room from a folder on a machine with nothing installed. What is proved, and what is not, is in the phase record the owner
keeps on their machine; it is deliberately not part of this repository. The built files are attached to
[release v0.1.0](https://github.com/1sad/watch-party/releases/tag/v0.1.0). This repository is public: code and documents
are published, while the working record (specs, tickets, session notes and costs) stays on the owner's machine.

## Using it

One small Windows program. The person hosting runs it, and it carries its own browser window; everyone else runs the
same file. The room's address travels in an invite link. The video never travels - each window plays it from the site -
and only chat, play, pause and seek cross the connection.

### The host, five minutes before

1. Put one file in a folder you can write in: `WatchParty-<version>-portable.exe` (83 MB) if the machine already has
   Microsoft Edge WebView2, which ordinary Windows 10 and 11 machines do, or `WatchParty-<version>-portable-full.exe`
   (501 MB) if it may not.
2. Not `Program Files`, and not a read-only stick: the app writes its unpacked runtime, its browser profile and its logs
   in the folder it sits in.
3. Double-click it. Windows may warn that the file is unsigned: choose **More info**, then **Run anyway**.
4. If Windows Firewall asks, allow **private networks** only. The public-network tick is for untrusted wifi, and chat is
   not encrypted.
5. The first run takes a few seconds longer while the app unpacks itself; later runs start at once.

### The host, at the evening

1. The window opens on the room, showing the invite link and a six-character room code.
2. Load the page the group is going to watch in the site view, or choose "watch my own file" to play a file you already
   have.
3. Send the link, or the code, to the group.
4. Press play once everyone is in; the roster in the sidebar shows who is there.

Only the owner's controls move the room (ADR-030). Play, pause or seek from anyone else is undone in their own window
and never sent.

### A friend

1. Get the same file from the release page, or from the host. It must be the same build the host is running.
2. Run it, then open the invite link the host sent, or paste the six-character code.
3. Wait for the host to press play. A reload or a dropped connection rejoins at the room's position.

### What it does

- Play, pause and seek stay in step: the host's action reaches the others in milliseconds, and a window that falls more
  than a few seconds behind is pulled back with one hard seek.
- Chat in the sidebar, over the same connection.
- Ads blocked, from a list that ships with the app.
- Two modes: a streaming site in the site view, or a file already on disk.
- No account, no server, no paid service, nothing installed, no administrator rights.

### If something breaks: the log

Every run writes a log beside the program, in the folder it was started from:

```
<folder>\logs\host-<yyyyMMdd-HHmmss-fff>-<pid>.log
```

- The newest file is the last run, and the file's own path is its first line, so a copied file still says where it came
  from. Every line begins `[host HH:mm:ss.fff]`.
- To report a problem, send the whole newest log file, plus one sentence: what you did, and what you saw.
- The lines that matter are near the top: `sidecar started`, `sidecar: PORT <n>`, `navigation completed ... status=<n>`,
  and, on the full build, `engine: folder=<path> version=<v>`.
- A log with no `PORT` line means the room's helper process never started - that is itself the finding.
- Each copy writes its own log in its own folder, so collect one from each side of a problem.

### What it does not do yet

- No volume slider in file mode; website mode keeps the site's own control. It is planned with the next milestone.
- Nothing has been tried between two different machines over a real network yet: every run so far was two copies on one
  machine, on one network.
- No installer and no auto-update. A new build is a new file, and an old folder can simply be deleted.

## Read in this order

If you are an agent starting work here, read `AGENTS.md` first — it sets the rules. Humans can skip it.

| File | What it is |
| --- | --- |
| [`docs/spec.md`](docs/spec.md) | What we're going to build: requirements, protocol, sync algorithm, modes, milestones. |
| [`docs/decisions.md`](docs/decisions.md) | Each decision with the alternatives rejected and why. **Start at ADR-022** — that is where the current shape begins. |
| [`docs/handoff.md`](docs/handoff.md) | Where to start, the experiments, the ticket list, how to test it, what will bite. |
| [`docs/open-questions.md`](docs/open-questions.md) | Assumptions that are *not yet verified*, ordered by how much they would change the plan. Attack these first. |
| [`docs/glossary.md`](docs/glossary.md) | Plain-language definitions of every term the other documents use. |
| [`docs/research.md`](docs/research.md) | Everything found out, with sources. **Reference, not required reading.** §25 is the link index; §27 is the tunnel research that turned out not to be needed. |

## The one-paragraph version

One program, run by the host for the evening. It carries its own browser window with ad filtering, so each person
loads the same streaming page and stays in step; chat rides the same connection. The program asks the home router
to open one door and puts its address in the invite link, so friends click and connect straight to it — no account,
no server, no service in the middle. Only chat and play/pause travel; the video always comes from the site itself,
which is why this costs nothing and why the room survives the host leaving. There is also a small "watch my own
file" mode, kept mostly to prove sync without a website in the way.

## Hard constraints going in

- ≤ 5 viewers. No accounts: a name, or "anonymous", set whenever.
- **Free, permanently.** No paid tunnel, no rented server, no third-party meeting service, no sign-ups.
- The host's own PC is the only machine involved, and it is on for the evening only.
- Windows first. Linux and Android later; iOS never (no add-on exists there).
- The video never travels between people. Only chat and controls do.
- The owner controls playback and which video plays; everyone else follows along (ADR-030).

## Where to start

M1 exists, but it is not a finished product. The two experiments that can still overturn the architecture —
**E1** (can your friends' connections accept visitors at all) and **E2** (can an embedded browser play these sites
with ads blocked) — are answered in [`docs/handoff.md`](docs/handoff.md); E1's hosting half stays unproven on this
machine. Those two decide whether the architecture stands; everything else is a detail.
