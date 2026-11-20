# Watch Party

Five friends, one film, wherever each of them happens to be. One person starts a small Windows program, shares a
link, and everyone else is in the same room on the same streaming page, in step, with chat.

Status: **research and spec only. No code yet.**

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
- Everyone can pause, seek, and change the page — there is no "host only" mode.

## Where to start

Nothing is built yet. Before any product code, run experiments **E1 and E2** in
[`docs/handoff.md`](docs/handoff.md#before-writing-product-code-nine-experiments): whether your friends' connections
can accept visitors at all, and whether an embedded browser can play these sites with ads blocked. Those two decide
whether the architecture stands; everything else is a detail.
