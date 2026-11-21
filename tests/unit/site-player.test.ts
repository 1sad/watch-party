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
import { ECHO_EXPIRY_MS } from '../../src/shared/echo.ts'
import {
  PLAYER_DRIFT_LOG_INTERVAL_MS,
  createSiteEchoes,
  decidePageEvent,
  driftFromPlayer,
  driftLogDue,
  echoEntries,
  planFromState,
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

