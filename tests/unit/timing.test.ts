import test from 'node:test'
import assert from 'node:assert/strict'

import {
  JUMP_RESET_MS,
  MAX_WEIGHT,
  PING_INTERVAL_MS,
  SEEK_SKIP_SECONDS,
  authorityNow,
  emptyEstimate,
  estimateOffset,
  expected,
  sampleFrom,
  seekIsDuplicate,
  type Sample,
} from '../../src/shared/timing.ts'
import type { Playback } from '../../src/shared/protocol.ts'

// T5 check 3: §6.1's arithmetic and its filter, fed instants a stopwatch would
// have seen. No socket and no real clock, so every number below is exact.

/** The instants a symmetric round trip produces when the authority is `skew` ms ahead. */
function symmetric(t0: number, skew: number, oneWay: number, think = 1): Sample {
  const sample = sampleFrom(t0, t0 + skew + oneWay, t0 + skew + oneWay + think, t0 + oneWay * 2 + think)
  assert.ok(sample, 'four finite instants make a sample')
  return sample
}

test('the four instants give the known offset and the round trip, symmetric or not', () => {
  const exact = symmetric(1000, 137, 25)
  assert.equal(exact.offset, 137)
  assert.equal(exact.rtt, 50)

  // §6.1's identity: with the reply leg 10 ms slower than the request, the
  // estimate is 5 ms low — the error is half the asymmetry, never the whole rtt.
  const skewed = sampleFrom(0, 147, 148, 31)
  assert.ok(skewed)
  assert.equal(skewed.rtt, 30)
  assert.equal(skewed.offset, 132)

  assert.equal(sampleFrom(0, 1, 1, Number.NaN), null, 'a NaN instant is not a sample')
  const backwards = sampleFrom(100, 50, 50, 90)
  assert.ok(backwards)
  assert.equal(backwards.rtt, 0, 'a clock that moved mid-flight cannot give a negative rtt')
})

test('a fresh estimator starts empty rather than from a stale value', () => {
  const fresh = emptyEstimate()
  assert.deepEqual(fresh, { offset: 0, rtt: 0, samples: 0, weight: 0 })

  const first = estimateOffset(symmetric(0, 137, 2), fresh)
  assert.equal(first.samples, 1)
  assert.equal(first.offset, 137, 'the first sample is taken as it is')
  assert.equal(first.rtt, 4)
})

test('a stream with a known offset and a jittery round trip stays within ±5 ms', () => {
  // Deterministic "noise": one-way jitter of at most 3 ms, so the estimate can
  // be at most 3 ms out on any single sample and the mean is well inside 5.
  const jitter = [0, 1, -1, 3, 2, -3, 1, 0, -2, 2, 3, -1]
  let estimate = emptyEstimate()
  let t0 = 0
  for (let index = 0; index < 60; index += 1) {
    const ahead = jitter[index % jitter.length] as number
    const sample = sampleFrom(t0, t0 + 137 + 2 + ahead, t0 + 137 + 3 + ahead, t0 + 4 + 1)
    assert.ok(sample)
    estimate = estimateOffset(sample, estimate)
    t0 += PING_INTERVAL_MS
  }
  assert.equal(estimate.samples, 60)
  assert.ok(Math.abs(estimate.offset - 137) <= 5, `offset ${estimate.offset} is within ±5 ms of 137`)
  assert.ok(Math.abs(authorityNow(t0, estimate) - (t0 + 137)) <= 5)
})

test('a sample with a 300 ms round trip moves the estimate by less than 3 ms', () => {
  let estimate = emptyEstimate()
  for (let index = 0; index < 40; index += 1) {
    estimate = estimateOffset(symmetric(index * PING_INTERVAL_MS, 137, 1), estimate)
  }
  const before = estimate.offset
  assert.ok(Math.abs(before - 137) < 1)

  // Queued behind something for 300 ms, and its own answer 763 ms out — under
  // the jump threshold, so it is fed, and it must barely move the mean.
  const slow = sampleFrom(200_000, 201_050, 201_050, 200_300)
  assert.ok(slow)
  assert.equal(slow.rtt, 300)
  assert.equal(slow.offset, 900)
  const after = estimateOffset(slow, estimate)
  assert.ok(
    Math.abs(after.offset - before) < 3,
    `a 300 ms sample moved the mean by ${Math.abs(after.offset - before)} ms`,
  )
  assert.ok(after.samples === estimate.samples + 1, 'it was folded in, not discarded')
})

test('a 3 s jump resets the filter instead of dragging it', () => {
  let estimate = emptyEstimate()
  for (let index = 0; index < 20; index += 1) {
    estimate = estimateOffset(symmetric(index * PING_INTERVAL_MS, 137, 1), estimate)
  }

  const jumped = estimateOffset(symmetric(200_000, 3137, 1), estimate)
  assert.equal(jumped.samples, 1, 'the history is gone, not averaged with the jump')
  assert.equal(jumped.offset, 3137, 'the estimate is the new truth, unanswered-by-history')
  assert.ok(Math.abs(jumped.offset - estimate.offset) > JUMP_RESET_MS)

  // Just inside the threshold is still a feed: the Safety line is a bound, not a guess.
  const near = symmetric(300_000, 137 + JUMP_RESET_MS - 1, 1)
  const fed = estimateOffset(near, estimate)
  assert.equal(fed.samples, estimate.samples + 1)
  assert.ok(fed.weight <= MAX_WEIGHT, 'the weight window never grows without bound')
})

// T6a check 4: §6.2's `expected()` — the one place a position is worked out.
// Every expectation below is a literal, because a test helper that
// re-computed the formula would be the second copy AGENTS.md forbids.

test('expected() over a paused playback is the stored position, whatever the clock says', () => {
  const paused: Playback = { playing: false, position: 42, updatedAt: 1_000_000, rate: 1 }
  assert.equal(expected(paused, 1_060_000), 42, 'a paused room does not creep')
  assert.equal(expected(paused, 900_000), 42, 'and does not rewind either')
})

test('expected() over a playing playback is position plus elapsed time at rate 1.0', () => {
  const playing: Playback = { playing: true, position: 10, updatedAt: 1_000_000, rate: 1 }
  assert.equal(expected(playing, 1_005_000), 15, '5 s of play moves the playhead 5 s')
  assert.equal(expected(playing, 1_000_000), 10, 'at updatedAt itself it is exactly position')
})

test('expected() multiplies the elapsed time by a non-1.0 rate', () => {
  const fast: Playback = { playing: true, position: 100, updatedAt: 2_000_000, rate: 1.5 }
  assert.equal(expected(fast, 2_004_000), 106, '4 s at 1.5x is 6 s of film')
  const slow: Playback = { playing: true, position: 100, updatedAt: 2_000_000, rate: 0.5 }
  assert.equal(expected(slow, 2_004_000), 102, '4 s at 0.5x is 2 s of film')
})

test('a negative now − updatedAt (skewed clock) never drags the position backwards', () => {
  const playing: Playback = { playing: true, position: 100, updatedAt: 2_000_000, rate: 1 }
  assert.equal(expected(playing, 1_999_500), 100, 'skew is not a rewind')
  assert.equal(expected(playing, 1_990_000), 100, 'however far behind the member clock is')
})

test('a seek within 0.3 s of the expected position is a duplicate; past it, a real seek', () => {
  // Playing since 3_000_000 s, so 2 s in the expected playhead is 102.
  const playing: Playback = { playing: true, position: 100, updatedAt: 3_000_000, rate: 1 }
  assert.equal(seekIsDuplicate(playing, 3_002_000, 102.2), true, 'the site echoing the same move')
  assert.equal(seekIsDuplicate(playing, 3_002_000, 101.7), true, 'the other side of the window too')
  assert.equal(seekIsDuplicate(playing, 3_002_000, 102.4), false, 'outside 0.3 s is a new seek')
  assert.equal(seekIsDuplicate(playing, 3_002_000, 60), false, 'a skip into the intro is a new seek')
  assert.equal(SEEK_SKIP_SECONDS, 0.3, '§5 says 0.3 s, and the constant is what the room uses')
})
