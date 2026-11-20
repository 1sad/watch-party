import test from 'node:test'
import assert from 'node:assert/strict'

import {
  JUMP_RESET_MS,
  MAX_WEIGHT,
  PING_INTERVAL_MS,
  authorityNow,
  emptyEstimate,
  estimateOffset,
  sampleFrom,
  type Sample,
} from '../../src/shared/timing.ts'

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
