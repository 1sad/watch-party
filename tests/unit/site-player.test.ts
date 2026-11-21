/**
 * Ticket 06: the site view's half of the room.
 *
 * `src/shared/site-player.ts` is the only place that decides what a `state`
 * frame makes the elected element do, and whether one of its events is ours
 * (§6.6). The cases below are the ticket's own:
 *
 * - a command the room posted produces no outbound room frame (the echo is
 *   recorded before the command leaves and consumed by the event it causes);
 * - a page event without a matching echo does produce one, as the controller's,
 *   and a guest's is corrected back instead (ADR-030);
 * - the bridge's report fields map onto §5's `report` shape, field names and all.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import type { Playback } from '../../src/shared/protocol.ts'
import type { PlayerCandidate } from '../../src/shared/player.ts'
import { elect, mergeReports, reportIsNewer, type FrameReport, type PlayerEvent } from '../../src/shared/player.ts'
import { ECHO_EXPIRY_MS } from '../../src/shared/echo.ts'
import {
  ALIGN_TOLERANCE_MS,
  PLAYER_DRIFT_LOG_INTERVAL_MS,
  alignmentOverdue,
  createSiteEchoes,
  decidePageEvent,
  driftFromPlayer,
  driftLogDue,
  echoEntries,
  followerStep,
  planFromState,
  playbackAfterPageCommit,
  realignPlan,
  reportFromPlayer,
  type PlayerActionEvent,
  type PlayerReading,
} from '../../src/shared/site-player.ts'

const SOURCE = 'https://plyr.animex.one/embed/G1x?t=80'
const HREF = 'https://plyr.animex.one/embed/G1x?t=80'

function player(over: Partial<PlayerCandidate> = {}): PlayerCandidate {
  return {
    id: 1,
    source: SOURCE,
    href: HREF,
    w: 842,
    h: 474,
    readyState: 4,
    hasSrc: true,
    playing: true,
    duration: 1420.0436,
    t: 600,
    paused: false,
    buffered: 1400,
    rate: 1,
    ...over,
  }
}

function playing(position: number, over: Partial<Playback> = {}): Playback {
  return { playing: true, position, updatedAt: 100_000, rate: 1, ...over }
}

test('a scheduled play places the playhead and waits for the beat, not "play now"', () => {
  const startAt = 110_000
  const beat = startAt - 1500
  const plan = planFromState(
    { playing: true, position: 600, updatedAt: startAt, rate: 1, startAt },
    7,
    'play',
    player({ t: 600, paused: true }),
    beat,
  )

  assert.ok(plan)
  assert.equal(plan.command.action, 'play')
  assert.equal(plan.command.target, undefined, 'it is already where it will be at the beat')
  assert.equal(plan.command.leadMs, 1500)
  assert.equal(plan.command.revision, 7)
  assert.equal(plan.command.reason, 'play')
  assert.deepEqual(plan.echoes, ['play'], 'a paused element will fire play() once')
  assert.equal(plan.beatMs, 1500, 'the play it causes arrives at the beat, not now')
})

test('a play away from the element\'s playhead moves it first, then plays', () => {
  const plan = planFromState(playing(600), 8, 'play', player({ t: 500, paused: true }), 100_000)
  assert.ok(plan)
  assert.equal(plan.command.action, 'seek', 'the move comes first, so the write is a seek')
  assert.equal(plan.command.reason, 'play')
  assert.equal(plan.command.target, 600)
  assert.equal(plan.command.resume, true)
  assert.equal(plan.command.leadMs, undefined)
  assert.deepEqual(plan.echoes, ['seeked', 'play'])
})

test('a scheduled play holds an element that is already playing, then starts it at the beat', () => {
  const startAt = 110_000
  const plan = planFromState(
    { playing: true, position: 600, updatedAt: startAt, rate: 1, startAt },
    7,
    'play',
    player({ t: 600, paused: false }),
    startAt - 1500,
  )
  assert.ok(plan)
  assert.equal(plan.command.action, 'play')
  assert.equal(plan.command.leadMs, 1500)
  assert.deepEqual(
    plan.echoes,
    ['pause', 'play'],
    'never "play now": the window that is playing is held, then the beat starts it',
  )
})

test('a pause command pauses and never seeks: a jump on pause is not the room\'s', () => {
  const plan = planFromState(
    { playing: false, position: 83.5, updatedAt: 100_000, rate: 1 },
    9,
    'pause',
    player({ t: 84.01, paused: false }),
    100_000,
  )
  assert.ok(plan)
  assert.equal(plan.command.action, 'pause')
  assert.equal(plan.command.target, undefined)
  assert.deepEqual(plan.echoes, ['pause'])
})

test('a paused snap (a targeted seek) moves the playhead and stays paused', () => {
  const plan = planFromState(
    { playing: false, position: 83.5, updatedAt: 100_000, rate: 1 },
    10,
    'seek',
    player({ t: 80, paused: true }),
    100_000,
  )
  assert.ok(plan)
  assert.equal(plan.command.action, 'seek')
  assert.equal(plan.command.target, 83.5)
  assert.equal(plan.command.resume, undefined)
  assert.deepEqual(plan.echoes, ['seeked'])
})

test('a hard seek while playing moves the playhead, then resumes it', () => {
  const startAt = 110_000
  const plan = planFromState(
    { playing: true, position: 83.5, updatedAt: startAt, rate: 1, startAt },
    11,
    'seek',
    player({ t: 70, paused: false }),
    startAt - 1500,
  )
  assert.ok(plan)
  assert.equal(plan.command.action, 'seek')
  assert.equal(plan.command.target, 83.5)
  assert.equal(plan.command.resume, true)
  assert.equal(plan.command.leadMs, 1500)
  assert.deepEqual(plan.echoes, ['pause', 'seeked', 'play'], 'held, moved, then played at the beat')
})

test('a seek the element already made is skipped, and joins the play if it is paused', () => {
  const same = planFromState(playing(600), 12, 'seek', player({ t: 600.1, paused: false }), 100_000)
  assert.equal(same, null, 'nothing to do: it is where the room is and already playing')

  const stopped = planFromState(playing(600), 12, 'seek', player({ t: 600.1, paused: true }), 100_000)
  assert.ok(stopped)
  assert.equal(stopped.command.action, 'play')
  assert.equal(stopped.command.target, undefined)
  assert.deepEqual(stopped.echoes, ['play'])
})

test('no elected player means no command', () => {
  assert.equal(planFromState(playing(600), 13, 'play', null, 100_000), null)
})

test('a command the room posted is not re-broadcast: its own event is consumed', () => {
  const echoes = createSiteEchoes()
  const elected = player({ paused: false, t: 84.01 })
  const plan = planFromState(
    { playing: false, position: 84.01, updatedAt: 100_000, rate: 1 },
    14,
    'pause',
    elected,
    100_000,
  )
  assert.ok(plan)
  // The caller records before it posts; the event can only arrive afterwards.
  echoes.expect({ source: elected.source, id: elected.id }, echoEntries(plan, 100_000))

  const ours: PlayerActionEvent = { source: SOURCE, id: 1, event: 'pause', t: 84.01 }
  assert.deepEqual(decidePageEvent(ours, elected, echoes, 100_050, true), { kind: 'echo' })
})

test('a page event with no echo is a person\'s: the controller\'s is a room command', () => {
  const echoes = createSiteEchoes()
  const elected = player()
  const event: PlayerActionEvent = { source: SOURCE, id: 1, event: 'pause', t: 84.01 }

  assert.deepEqual(decidePageEvent(event, elected, echoes, 100_000, true), {
    kind: 'send',
    command: { type: 'pause', position: 84.01 },
  })
})

test('a seek the page made carries §5\'s wasPlaying', () => {
  const echoes = createSiteEchoes()
  const elected = player()
  const event: PlayerActionEvent = { source: SOURCE, id: 1, event: 'seeked', t: 12.5, wasPlaying: true }
  assert.deepEqual(decidePageEvent(event, elected, echoes, 100_000, true), {
    kind: 'send',
    command: { type: 'seek', position: 12.5, wasPlaying: true },
  })
})

test('a guest\'s page event is corrected back, never broadcast', () => {
  const echoes = createSiteEchoes()
  const elected = player()
  const event: PlayerActionEvent = { source: SOURCE, id: 1, event: 'play', t: 12 }
  assert.deepEqual(decidePageEvent(event, elected, echoes, 100_000, false), { kind: 'correct' })
})

test('another candidate\'s event is ignored and leaves the elected player\'s echo alone', () => {
  const echoes = createSiteEchoes()
  const elected = player({ paused: false })
  echoes.expect({ source: SOURCE, id: 1 }, [{ kind: 'pause', atMs: 100_000 }])

  const ad: PlayerActionEvent = { source: 'https://ads.example/1', id: 1, event: 'pause', t: 3 }
  assert.deepEqual(decidePageEvent(ad, elected, echoes, 100_010, true), { kind: 'ignore' })

  const ours: PlayerActionEvent = { source: SOURCE, id: 1, event: 'pause', t: 84.01 }
  assert.deepEqual(decidePageEvent(ours, elected, echoes, 100_020, true), { kind: 'echo' })
})

test('an echo entry expires, so a dropped event cannot silence the next real one', () => {
  const echoes = createSiteEchoes()
  echoes.expect({ source: SOURCE, id: 1 }, [{ kind: 'play', atMs: 0 }])
  assert.equal(echoes.consume({ source: SOURCE, id: 1 }, 'play', ECHO_EXPIRY_MS), false)
})

test('a scheduled play\'s echo is recorded for the beat, so it outlives the wait', () => {
  const plan = planFromState(
    { playing: true, position: 600, updatedAt: 110_000, rate: 1, startAt: 110_000 },
    15,
    'play',
    player({ t: 600, paused: true }),
    108_500,
  )
  assert.ok(plan)
  assert.deepEqual(echoEntries(plan, 1_000), [{ kind: 'play', atMs: 2_500 }])

  const echoes = createSiteEchoes()
  echoes.expect({ source: SOURCE, id: 1 }, echoEntries(plan, 1_000))
  // The play() fired at the beat, 1.5 s after the command: still ours.
  assert.equal(echoes.consume({ source: SOURCE, id: 1 }, 'play', 2_500), true)
})

test('an echo recorded for a beat still expires a second after it', () => {
  const echoes = createSiteEchoes()
  echoes.expect({ source: SOURCE, id: 1 }, [{ kind: 'play', atMs: 2_500 }])
  assert.equal(echoes.consume({ source: SOURCE, id: 1 }, 'play', 2_500 + ECHO_EXPIRY_MS), false)
})

test('the bridge\'s report fields map onto §5\'s report shape, by name', () => {
  const reading: PlayerReading = { t: 83.61, paused: true, readyState: 4, buffered: 1400.5, rate: 1 }
  const frame = reportFromPlayer(reading, { duration: 1420.0436, origin: 'https://x.example', rtt: 3 })

  assert.deepEqual(frame, {
    type: 'report',
    position: 83.61,
    readyState: 4,
    buffered: 1400.5,
    rate: 1,
    duration: 1420.0436,
    origin: 'https://x.example',
    rtt: 3,
  })
  assert.equal('paused' in frame, false, 'the frame has no paused field; the room hears the command')
})

test('the drift numbers are the room\'s expectation, the element\'s truth and their millis', () => {
  const reading: PlayerReading = { t: 83.61, paused: false, readyState: 4, buffered: 1400, rate: 1 }
  const drift = driftFromPlayer(reading, playing(83.5), 100_000)
  assert.equal(drift.expected, 83.5)
  assert.equal(drift.actual, 83.61)
  assert.equal(drift.deltaMs, 110)

  // Behind the room is a negative delta, which is the sign 09 has to read right.
  const behind = driftFromPlayer({ ...reading, t: 83.4 }, playing(83.5), 100_000)
  assert.equal(behind.deltaMs, -100)
})

test('a drift line is written at most once a second', () => {
  assert.equal(driftLogDue(null, 100_000), true, 'the first report always gets one')
  assert.equal(driftLogDue(100_000, 100_000 + PLAYER_DRIFT_LOG_INTERVAL_MS - 1), false)
  assert.equal(driftLogDue(100_000, 100_000 + PLAYER_DRIFT_LOG_INTERVAL_MS), true)
})

// ---- T15: the bridge's provenance, and the stale report it replaces ----

test('a scheduled play whose element is already playing produces no outbound room frame', () => {
  // The report the plan is built from is up to 500 ms old and says the element
  // is paused, because a person pressed play on the site's own player a moment
  // ago. The element is in fact playing, so the hold pauses it.
  const echoes = createSiteEchoes()
  const elected = player({ t: 600, paused: true })
  const startAt = 110_000
  const plan = planFromState(
    { playing: true, position: 600, updatedAt: startAt, rate: 1, startAt },
    30,
    'play',
    elected,
    startAt - 1500,
  )
  assert.ok(plan)
  assert.deepEqual(plan.echoes, ['play'], 'predicted from the stale report: no pause was expected')
  echoes.expect({ source: elected.source, id: elected.id }, echoEntries(plan, startAt - 1500))

  // The hold's pause arrives, tagged by the frame that made it.
  const held: PlayerActionEvent = { source: SOURCE, id: 1, event: 'pause', t: 600.2, caused: true }
  assert.deepEqual(
    decidePageEvent(held, elected, echoes, startAt - 1400, true),
    { kind: 'echo' },
    'the play sticks: the hold is the app\'s pause, not a second person\'s',
  )
})

test('the bridge\'s caused-event flag reaches the decision for play, pause, seeked and rate', () => {
  const elected = player()
  const kinds = ['play', 'pause', 'seeked', 'rate'] as const
  for (const kind of kinds) {
    const event: PlayerActionEvent = { source: SOURCE, id: 1, event: kind, t: 12, caused: true }
    assert.deepEqual(
      decidePageEvent(event, elected, createSiteEchoes(), 100_000, true),
      { kind: 'echo' },
      `a ${kind} the bridge caused is dropped with no room frame`,
    )
  }

  // And the same four without the flag are people, not echoes: the flag is what
  // makes the difference, so it cannot be confused with the prediction.
  const person = (kind: (typeof kinds)[number], t = 12): PlayerActionEvent => ({
    source: SOURCE, id: 1, event: kind, t, caused: false,
  })
  assert.deepEqual(decidePageEvent(person('play'), elected, createSiteEchoes(), 100_000, true), {
    kind: 'send',
    command: { type: 'play', position: 12 },
  })
  assert.deepEqual(decidePageEvent(person('pause'), elected, createSiteEchoes(), 100_000, true), {
    kind: 'send',
    command: { type: 'pause', position: 12 },
  })
  assert.deepEqual(decidePageEvent(person('seeked', 40), elected, createSiteEchoes(), 100_000, true), {
    kind: 'send',
    command: { type: 'seek', position: 40, wasPlaying: false },
  })
  assert.deepEqual(
    decidePageEvent(person('rate'), elected, createSiteEchoes(), 100_000, true),
    { kind: 'ignore' },
    'a rate has no room command: §6.3\'s rate is the ladder\'s own',
  )
})

test('the flag needs no prediction: a caused event is dropped with an empty set', () => {
  const echoes = createSiteEchoes()
  const elected = player()
  const event: PlayerActionEvent = { source: SOURCE, id: 1, event: 'play', t: 600, caused: true }
  assert.deepEqual(decidePageEvent(event, elected, echoes, 100_000, true), { kind: 'echo' })
})

test('a newer plan clears the predictions a superseded one left', () => {
  const echoes = createSiteEchoes()
  const target = { source: SOURCE, id: 1 }
  echoes.expect(target, [{ kind: 'play', atMs: 2_500 }])
  echoes.clear(target)

  // A cancelled hold's `play` must not swallow the person's next one.
  const person: PlayerActionEvent = { source: SOURCE, id: 1, event: 'play', t: 601, caused: false }
  assert.deepEqual(decidePageEvent(person, player(), echoes, 2_500, true), {
    kind: 'send',
    command: { type: 'play', position: 601 },
  })
})

// ---- T07: a player is always a follower (ADR-029 rule 1) -----------------------

test('a changed election applies the room position before any report (T07)', () => {
  const now = 100_000
  const room = playing(600, { updatedAt: now })
  // What a site's own player looks like the moment it is elected: a fresh
  // element the page started at 0, or has not even given metadata yet.
  const fresh = player({ t: 0, readyState: 0, paused: true, playing: false })

  const first = followerStep({
    reason: 'appeared',
    newDocument: false,
    previewPending: false,
    unaligned: false,
    playback: room,
    revision: 12,
    stateReason: 'join',
    elected: fresh,
    nowMs: now,
  })

  assert.equal(first.report, false, "the page's own 0 is not the room's news")
  assert.ok(first.realign, 'the room position is applied first')
  assert.equal(first.realign.command.action, 'seek', 'placed before it is allowed to run')
  assert.equal(first.realign.command.target, 600, 'the room is at 600 s')
  assert.equal(first.realign.command.resume, true)
  assert.deepEqual(first.realign.echoes, ['seeked', 'play'], 'the apply is echo-suppressed')
  assert.equal(first.unaligned, false, 'the apply is the one the page needed')

  // The report after the apply is the first the ladder sees.
  const second = followerStep({
    reason: null,
    newDocument: false,
    previewPending: false,
    unaligned: first.unaligned,
    playback: room,
    revision: 12,
    stateReason: 'join',
    elected: player({ t: 600.1 }),
    nowMs: now + 500,
  })
  assert.equal(second.report, true)
  assert.equal(second.realign, null, 'nothing left to apply')
})

test('an election that leaves nobody elected keeps the page quiet (T07, 06b)', () => {
  const step = followerStep({
    reason: 'replaced',
    newDocument: false,
    previewPending: false,
    unaligned: false,
    playback: playing(600),
    revision: 12,
    stateReason: 'join',
    elected: null,
    nowMs: 100_000,
  })
  assert.equal(step.realign, null, 'nothing to aim at yet')
  assert.equal(step.report, false)
  assert.equal(step.unaligned, true, 'the next elected player is realigned before it reports')
})

test('pageCommitted resets to 0, paused, and realigns to nothing (T07, §5)', () => {
  const committedAt = 120_000
  const after = playbackAfterPageCommit(committedAt)
  assert.deepEqual(after, { playing: false, position: 0, updatedAt: committedAt, rate: 1 })
  assert.ok(Number.isFinite(after.updatedAt), 'the commit instant is the authority\'s, not a position')

  // The new film's player has appeared at 0 and is paused: the room it
  // realigns to is the beginning too, so there is nothing to write.
  const settled = realignPlan(after, 13, 'join', player({ t: 0, paused: true, playing: false }), committedAt)
  assert.equal(settled, null, 'a page change resets; it never realigns to the old film')

  // A page that plays by itself is stopped, and the target is the new film's
  // beginning - never the position the room held before the commit.
  const autoplay = realignPlan(after, 13, 'join', player({ t: 0.4, paused: false }), committedAt)
  assert.ok(autoplay)
  assert.equal(autoplay.command.action, 'pause')
  assert.equal(autoplay.command.target, 0)
})

test('a pending preview is not realigned and sends no report (T07, ADR-032)', () => {
  const room = playing(600, { updatedAt: 100_000 })
  const step = followerStep({
    reason: 'appeared',
    newDocument: true,
    previewPending: true,
    unaligned: false,
    playback: room,
    revision: 9,
    stateReason: 'play',
    elected: player({ t: 0 }),
    nowMs: 100_000,
  })
  assert.equal(step.realign, null, 'a preview is not a follower yet')
  assert.equal(step.report, false)
  assert.equal(step.unaligned, false, 'and it does not start a wait for the old film')

  // On the commit the site view navigates and its new player is elected: that
  // is when the realignment runs, and it aims at the new film's 0.
  const committed = followerStep({
    reason: 'appeared',
    newDocument: true,
    previewPending: false,
    unaligned: true,
    playback: playbackAfterPageCommit(101_000),
    revision: 10,
    stateReason: 'join',
    elected: player({ t: 0, paused: true, playing: false }),
    nowMs: 101_000,
  })
  assert.equal(committed.report, false)
  assert.equal(committed.realign, null, 'the room is at 0 and the element is too')
  assert.equal(committed.unaligned, false)
})

test('a reloaded site view re-elects its player and realigns it (T07, 06b)', () => {
  const at = 100_000
  const frames = new Map<string, FrameReport>()
  const settle = (doc: string, seq: number, candidate: PlayerCandidate, receivedAt: number): void => {
    frames.set(SOURCE, { source: SOURCE, href: HREF, doc, seq, candidates: [candidate], receivedAt })
  }

  // Before: one playing element, elected, and the room a second later in.
  settle('doc-before', 4_000, player({ t: 600 }), at)
  const first = elect(null, mergeReports(frames.values(), at))
  assert.equal(first.reason, 'appeared')
  const room = playing(601, { updatedAt: at + 900 })

  // 06b's reload: the old document says the element emptied, so the incumbent
  // is gone and nothing replaces it in that same election.
  const emptied: PlayerEvent[] = [{ source: SOURCE, id: 1, event: 'emptied', t: 600 }]
  const replaced = elect(first.elected, mergeReports(frames.values(), at + 100), emptied)
  assert.equal(replaced.reason, 'replaced')
  assert.equal(replaced.elected, null, 'the element that went is the one we had')

  // The new document's bridge counts from 1 again. Under the old rule this
  // report was older news than the 4,000th and was dropped for good.
  const held = frames.get(SOURCE)
  assert.ok(held)
  assert.equal(reportIsNewer(held, { doc: 'doc-after', seq: 1 }), true)

  // Its element is new, at 0, and not yet ready.
  settle('doc-after', 1, player({ t: 0, readyState: 0, paused: true, playing: false }), at + 900)
  const again = elect(replaced.elected, mergeReports(frames.values(), at + 900))
  assert.equal(again.reason, 'appeared', 'the election comes back')

  const step = followerStep({
    reason: again.reason,
    newDocument: true,
    previewPending: false,
    unaligned: true,
    playback: room,
    revision: 20,
    stateReason: 'play',
    elected: again.elected,
    nowMs: at + 900,
  })
  assert.equal(step.report, false)
  assert.equal(step.realign?.command.action, 'seek')
  assert.equal(step.realign?.command.target, 601, 'the room is at 601 s, not 0')
})

test('an alignment still out of place after the room\'s tolerance gets one line (T07)', () => {
  assert.equal(alignmentOverdue(null, 1_000), false, 'nothing is being waited for')
  assert.equal(alignmentOverdue(1_000, 1_000 + ALIGN_TOLERANCE_MS - 1), false)
  assert.equal(alignmentOverdue(1_000, 1_000 + ALIGN_TOLERANCE_MS), true)
  assert.equal(ALIGN_TOLERANCE_MS, 4_000, "§6.3's hard-seek threshold is the room's tolerance")
})


