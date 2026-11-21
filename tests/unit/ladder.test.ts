import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CORRECTION_DEADBAND_SECONDS,
  CORRECTION_SPACING_MS,
  MIN_SCHEDULED_START_MS,
  SEEK_AHEAD_SECONDS,
  SEEK_BEHIND_SECONDS,
  SLOW_DOWN_RATE,
  SPEED_UP_RATE,
  STRIKES_BEFORE_CORRECTION,
  clampToMedia,
  decideCorrection,
  nudgeRateAt,
  reportFrom,
  scheduledStartAt,
  targetFor,
  type CorrectionInput,
} from '../../src/shared/timing.ts'
import type { Playback } from '../../src/shared/protocol.ts'

// T7b1 check 1: §6.3's table and the three guards, table-driven. Instants are
// literals and the clock is an argument, so every number below is exact.
//
// The sign of `drift`: positive is **ahead** of the room (slow down, 0.95),
// negative is behind (speed up, 1.05). §6.3 states magnitude bands, except the
// asymmetric "> 1.75 s behind", which is the row this sign makes expressible.

const NOW = 1_000_000

function input(overrides: Partial<CorrectionInput> = {}): CorrectionInput {
  return {
    drift: 0,
    playing: true,
    readyState: 4,
    driftStrikes: STRIKES_BEFORE_CORRECTION,
    lastCorrectionAt: null,
    nowMs: NOW,
    target: 200,
    ...overrides,
  }
}

test('§6.3 table: the six bands pick none, nudge, seek or snap', () => {
  const rows: Array<{
    name: string
    overrides: Partial<CorrectionInput>
    action: 'none' | 'nudge' | 'seek' | 'snap'
    rate: number
  }> = [
    { name: '0.05 s drift is inside the deadband', overrides: { drift: 0.05 }, action: 'none', rate: 1 },
    { name: '0.1 s ahead sits inside the deadband (ADR-039)', overrides: { drift: 0.1 }, action: 'none', rate: 1 },
    { name: '0.26 s ahead nudges 0.95', overrides: { drift: 0.26 }, action: 'nudge', rate: 0.95 },
    { name: '1.4 s ahead nudges 0.95', overrides: { drift: 1.4 }, action: 'nudge', rate: 0.95 },
    { name: '2.0 s ahead nudges 0.95', overrides: { drift: 2.0 }, action: 'nudge', rate: 0.95 },
    { name: '4.1 s ahead seeks', overrides: { drift: 4.1 }, action: 'seek', rate: 1 },
    { name: '1.8 s behind seeks', overrides: { drift: -1.8 }, action: 'seek', rate: 1 },
    { name: '1.0 s behind nudges 1.05', overrides: { drift: -1.0 }, action: 'nudge', rate: 1.05 },
    { name: 'paused snaps', overrides: { drift: 2.0, playing: false }, action: 'snap', rate: 1 },
    {
      name: 'buffering never nudges',
      overrides: { drift: 2.0, readyState: 2 },
      action: 'none',
      rate: 1,
    },
  ]

  for (const row of rows) {
    const decision = decideCorrection(input(row.overrides))
    assert.equal(decision.action, row.action, row.name)
    assert.equal(decision.rate, row.rate, `${row.name}: rate`)
  }
})

test('§6.3 bands are inclusive at the deadband and exclusive at 4 / 1.75-behind', () => {
  assert.equal(CORRECTION_DEADBAND_SECONDS, 0.25)
  assert.equal(SEEK_AHEAD_SECONDS, 4)
  assert.equal(SEEK_BEHIND_SECONDS, 1.75)
  assert.equal(SLOW_DOWN_RATE, 0.95)
  assert.equal(SPEED_UP_RATE, 1.05)

  assert.equal(decideCorrection(input({ drift: 0.2499 })).action, 'none', 'strictly under the deadband')
  assert.equal(decideCorrection(input({ drift: 0.25 })).action, 'nudge', 'exactly the deadband nudges')
  assert.equal(decideCorrection(input({ drift: 4 })).action, 'nudge', 'exactly 4 still nudges')
  assert.equal(decideCorrection(input({ drift: 4.0001 })).action, 'seek', 'past 4 seeks')
  assert.equal(decideCorrection(input({ drift: -1.75 })).action, 'nudge', 'exactly 1.75 behind nudges')
  assert.equal(decideCorrection(input({ drift: -1.7501 })).action, 'seek', 'past 1.75 behind seeks')
})

// ADR-039: the deadband is a quarter of a second, chosen because a healthy
// window measurably sits 0.086-0.112 s behind. These are the edges that change;
// the rungs above it are pinned right after them.

test('ADR-039: 0.24 s either way is no correction, 0.26 s is one', () => {
  assert.equal(CORRECTION_DEADBAND_SECONDS, 0.25, 'one constant, a quarter second')

  for (const drift of [0.24, -0.24, 0.2, -0.2, 0.086, -0.112]) {
    const decision = decideCorrection(input({ drift }))
    assert.equal(decision.action, 'none', `drift ${drift} is inside the deadband`)
    assert.equal(decision.rate, 1, `drift ${drift} keeps rate 1`)
  }

  const ahead = decideCorrection(input({ drift: 0.26 }))
  assert.equal(ahead.action, 'nudge', '0.26 s ahead is corrected')
  assert.equal(ahead.rate, SLOW_DOWN_RATE)

  const behind = decideCorrection(input({ drift: -0.26 }))
  assert.equal(behind.action, 'nudge', '0.26 s behind is corrected')
  assert.equal(behind.rate, SPEED_UP_RATE)
})

test('ADR-039: a correction stops once the gap is back under 0.25 s', () => {
  const correcting = decideCorrection(input({ drift: 0.4, lastCorrectionAt: NOW - 6000 }))
  assert.equal(correcting.action, 'nudge', '0.4 s is still being corrected')

  const closed = decideCorrection(input({ drift: 0.24, lastCorrectionAt: NOW - 6000 }))
  assert.equal(closed.action, 'none', 'inside the deadband again, so the page restores 1')
  assert.equal(closed.rate, 1, 'restored to playbackRate = 1')
})

test('ADR-039: the rungs above the deadband are unchanged', () => {
  // The 1.5 s rung is the same nudge on both sides of it (§6.3: "a bit of
  // visible lag is preferable to a jump"): 1.4 s and 1.6 s both nudge.
  for (const drift of [1.4, 1.5, 1.6]) {
    const decision = decideCorrection(input({ drift }))
    assert.equal(decision.action, 'nudge', `drift ${drift} is the nudge rung`)
    assert.equal(decision.rate, SLOW_DOWN_RATE, `drift ${drift} nudges at 0.95`)
  }

  // The 4 s hard seek and the asymmetric "> 1.75 s behind" trigger.
  assert.equal(decideCorrection(input({ drift: 4 })).action, 'nudge', 'exactly 4 s ahead still nudges')
  assert.equal(decideCorrection(input({ drift: 4.0001 })).action, 'seek', 'past 4 s ahead seeks')
  assert.equal(decideCorrection(input({ drift: -1.75 })).action, 'nudge', 'exactly 1.75 s behind still nudges')
  assert.equal(decideCorrection(input({ drift: -1.7501 })).action, 'seek', 'past 1.75 s behind seeks')
})

test('guard 1: one bad report is not enough; the second one corrects', () => {
  const first = decideCorrection(input({ drift: 1.0, driftStrikes: 1 }))
  assert.equal(first.action, 'none', 'one report cannot move a window')
  assert.equal(first.rate, 1)

  const second = decideCorrection(input({ drift: 1.0, driftStrikes: 2 }))
  assert.equal(second.action, 'nudge')
  assert.equal(second.rate, 0.95)
})

test('guard 2: a second correction inside 5 s is withheld, and allowed again after it', () => {
  assert.equal(CORRECTION_SPACING_MS, 5000)
  const tooSoon = decideCorrection(
    input({ drift: 1.0, lastCorrectionAt: NOW - CORRECTION_SPACING_MS + 1 }),
  )
  assert.equal(tooSoon.action, 'none', 'one correction per client per 5 s')

  const exactlyFive = decideCorrection(input({ drift: 1.0, lastCorrectionAt: NOW - CORRECTION_SPACING_MS }))
  assert.equal(exactlyFive.action, 'nudge', '5 s later is allowed')

  const overdue = decideCorrection(input({ drift: 1.0, lastCorrectionAt: NOW - 60_000 }))
  assert.equal(overdue.action, 'nudge')
})

test('guard 3: never nudge while readyState < 3, and a paused snap waits for its strikes too', () => {
  for (const readyState of [0, 1, 2]) {
    const decision = decideCorrection(input({ drift: 2.0, readyState }))
    assert.equal(decision.action, 'none', `readyState ${readyState} is buffering (§6.7)`)
  }
  assert.equal(decideCorrection(input({ drift: 2.0, readyState: 3 })).action, 'nudge')

  // The existing "a raw report moves nothing" check sends one report while the
  // room is paused; an unguarded snap would move that window. The guards hold.
  assert.equal(
    decideCorrection(input({ drift: 999.5, playing: false, driftStrikes: 1 })).action,
    'none',
    'one stale paused report is not a correction',
  )
  assert.equal(
    decideCorrection(input({ drift: 999.5, playing: false, driftStrikes: 2 })).action,
    'snap',
  )
})

test('a nudge says where it ends and by when, and a good report restores rate 1', () => {
  const nudge = decideCorrection(input({ drift: 1.0 }))
  assert.equal(nudge.action, 'nudge')
  assert.equal(nudge.target, 200, 'the nudge carries the target, not just a rate')
  // 1 s of gap at the extra 0.05 × real time takes 20 s to close.
  assert.equal(nudge.untilAuthorityMs, NOW + 20_000)

  const behind = decideCorrection(input({ drift: -0.5 }))
  assert.equal(behind.action, 'nudge')
  assert.equal(behind.rate, 1.05)
  assert.equal(behind.untilAuthorityMs, NOW + 10_000)

  // §6.3: "always restore playbackRate = 1 afterwards". The decision that sees
  // a good report says so in the one shape the caller reads.
  const good = decideCorrection(input({ drift: 0.02, lastCorrectionAt: NOW - 1000 }))
  assert.equal(good.action, 'none')
  assert.equal(good.rate, 1)
})

test('§6.3: a seek and a paused snap carry the target; the authority does not guess', () => {
  const seek = decideCorrection(input({ drift: 4.2, target: 123.5 }))
  assert.equal(seek.action, 'seek')
  assert.equal(seek.target, 123.5)

  const snap = decideCorrection(input({ drift: -2.0, playing: false, target: 55 }))
  assert.equal(snap.action, 'snap')
  assert.equal(snap.target, 55)
})

// §4.5's worked example, as the phase slice §7 A asks: the dub has a 5 s logo,
// so target = room + 5 and a report in dub time comes back to room time.

test('targetFor and reportFrom are the two halves of one sign (§4.5)', () => {
  const room: Playback = { playing: false, position: 100, updatedAt: 0, rate: 1 }
  const dubLogo = { timelineOffset: 5 }
  const sub = { timelineOffset: -5 }
  const sameEdit = { timelineOffset: 0 }

  assert.equal(targetFor(room, dubLogo, 0), 105, 'the dub copy is 5 s further in')
  assert.equal(reportFrom(105, dubLogo), 100, 'its report comes back to room time')

  assert.equal(targetFor(room, sub, 0), 95)
  assert.equal(reportFrom(95, sub), 100)

  assert.equal(targetFor(room, sameEdit, 0), 100)
  assert.equal(reportFrom(100, sameEdit), 100)

  // The round trip is the identity: a member already at its own target must
  // report exactly the room's position, whatever its offset.
  for (const member of [dubLogo, sub, sameEdit]) {
    assert.equal(reportFrom(targetFor(room, member, 0), member), 100)
  }
})

// §6.4, corrected 2026-11-20: the 1.5 s floor dominates until 2 × rtt passes it.

test('scheduledStartAt is now + max(2 × maxRtt, 1.5 s)', () => {
  assert.equal(MIN_SCHEDULED_START_MS, 1500)
  assert.equal(scheduledStartAt(NOW, 0), NOW + 1500)
  assert.equal(scheduledStartAt(NOW, 1), NOW + 1500, '1 ms rtt is still floored')
  assert.equal(scheduledStartAt(NOW, 749), NOW + 1500, 'just under the floor')
  assert.equal(scheduledStartAt(NOW, 750), NOW + 1500, 'exactly the floor')
  assert.equal(scheduledStartAt(NOW, 1000), NOW + 2000, '2 s of rtt beats the floor')
  assert.equal(scheduledStartAt(NOW, 900), NOW + 1800, 'a 900 ms rtt yields a 1.8 s lead')
  assert.equal(scheduledStartAt(NOW, -10), NOW + 1500, 'a bad rtt cannot go backwards')
})

// §4.5: every seek lands in [0, duration − 0.25].

test('clampToMedia bounds every seek to [0, duration − 0.25]', () => {
  assert.equal(clampToMedia(-5, 100), 0)
  assert.equal(clampToMedia(0, 100), 0)
  assert.equal(clampToMedia(50, 100), 50)
  assert.equal(clampToMedia(99.75, 100), 99.75)
  assert.equal(clampToMedia(99.8, 100), 99.75)
  assert.equal(clampToMedia(500, 100), 99.75)
  assert.equal(clampToMedia(5, 0), 0, 'an unknown/zero duration cannot produce a negative bound')
})

// T7b2: the page's half of the ladder. The bound is the frame's own authority
// instant, so "restore to 1" is decided by a clock the tests can move, not by a
// countdown the page starts when the message lands (§6.3's last rule, T7b2's
// Safety line: a lost restore cannot leave a window sped up).

test('nudgeRateAt holds 0.95/1.05 before the bound and 1 at and after it', () => {
  const hold = { rate: SLOW_DOWN_RATE, untilAuthorityMs: NOW + 4000 }
  assert.equal(nudgeRateAt(hold, NOW), SLOW_DOWN_RATE, 'the instant it is applied')
  assert.equal(nudgeRateAt(hold, NOW + 3999), SLOW_DOWN_RATE, '1 ms before the bound')
  assert.equal(nudgeRateAt(hold, NOW + 4000), 1, 'the bound itself is already over')
  assert.equal(nudgeRateAt(hold, NOW + 60000), 1, 'a minute later, with no message in between')
  assert.equal(
    nudgeRateAt({ rate: SPEED_UP_RATE, untilAuthorityMs: NOW }, NOW - 1),
    SPEED_UP_RATE,
    'speeding up holds on the same rule',
  )
})

test('nudgeRateAt refuses a hold it cannot honour', () => {
  assert.equal(nudgeRateAt({ rate: 1.2, untilAuthorityMs: NOW + 1000 }, NOW), 1, 'not a 6.3 rate')
  assert.equal(nudgeRateAt({ rate: 1, untilAuthorityMs: NOW + 1000 }, NOW), 1, '1.0 is not a nudge')
  assert.equal(nudgeRateAt({ rate: SLOW_DOWN_RATE, untilAuthorityMs: Number.NaN }, NOW), 1, 'a bound that cannot expire')
  assert.equal(nudgeRateAt({ rate: SLOW_DOWN_RATE, untilAuthorityMs: Infinity }, NOW), 1)
})
