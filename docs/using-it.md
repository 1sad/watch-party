# Using it: the host and a friend

The page for the evening itself: what each person does, what the app does, and where the log is when something breaks.
For why it is built this way see `docs/decisions.md`; for what is proved and what is not, see
`.scratch/phase-3-m7/spec.md` → `## Status`.

## What it is

One small Windows program. The person hosting runs it, and it carries its own browser window; everyone else runs the
same file. The room's address travels in an invite link. The video never travels - each window plays it from the site -
and only chat, play, pause and seek cross the connection.

## The host, five minutes before

1. Put one file in a folder you can write in: `WatchParty-<version>-portable.exe` (83 MB) if the machine already has
   Microsoft Edge WebView2, which ordinary Windows 10 and 11 machines do, or `WatchParty-<version>-portable-full.exe`
   (501 MB) if it may not.
2. Not `Program Files`, and not a read-only stick: the app writes its unpacked runtime, its browser profile and its logs
   in the folder it sits in.
3. Double-click it. Windows may warn that the file is unsigned: choose **More info**, then **Run anyway**.
4. If Windows Firewall asks, allow **private networks** only. The public-network tick is for untrusted wifi, and chat is
   not encrypted.
5. The first run takes a few seconds longer while the app unpacks itself; later runs start at once.

## The host, at the evening

1. The window opens on the room, showing the invite link and a six-character room code.
2. Load the page the group is going to watch in the site view, or choose "watch my own file" to play a file you already
   have.
3. Send the link, or the code, to the group.
4. Press play once everyone is in; the roster in the sidebar shows who is there.

Only the owner's controls move the room (ADR-030). Play, pause or seek from anyone else is undone in their own window
and never sent.

## A friend

1. Get the same file, from the host - the repository is private, so send the file itself rather than a link. It must be
   the same build the host is running.
2. Run it, then open the invite link the host sent, or paste the six-character code.
3. Wait for the host to press play. A reload or a dropped connection rejoins at the room's position.

## What it does

- Play, pause and seek stay in step: the host's action reaches the others in milliseconds, and a window that falls more
  than a few seconds behind is pulled back with one hard seek.
- Chat in the sidebar, over the same connection.
- Ads blocked, from a list that ships with the app.
- Two modes: a streaming site in the site view, or a file already on disk.
- No account, no server, no paid service, nothing installed, no administrator rights.

## If something breaks: the log

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

## What it does not do yet

- No volume slider in file mode; website mode keeps the site's own control. It is planned with the next milestone.
- Nothing has been tried between two different machines over a real network yet: every run so far was two copies on one
  machine, on one network.
- No installer and no auto-update. A new build is a new file, and an old folder can simply be deleted.
