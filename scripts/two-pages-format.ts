// The row and summary a two-page reading prints, split from the reader so a
// unit case can cover the formatting without dialling a DevTools endpoint
// (T188). `scripts/two-pages.mjs` imports these; nothing here touches the
// network.

/** One reading of both pages in the same tick: each page's `now` and `state`, and their gap. */
export interface Sample {
  index: number
  aNow: number
  aState: unknown
  bNow: number
  bState: unknown
  gap: number
}

/** A number as a reading prints it: four decimals, sign kept. */
export function fixed(value: number): string {
  return value.toFixed(4)
}

/** A state as a reading prints it: a string stays itself, an object is JSON. */
export function show(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/** One sample's row, the columns the ticket names: `a.now a.state b.now b.state gap`. */
export function formatRow(sample: Sample): string {
  return (
    `${sample.index} a.now=${fixed(sample.aNow)} a.state=${show(sample.aState)} ` +
    `b.now=${fixed(sample.bNow)} b.state=${show(sample.bState)} gap=${fixed(sample.gap)}`
  )
}

/** The sample whose gap is farthest from zero, or null when there are none. */
export function worstSample(samples: readonly Sample[]): Sample | null {
  if (samples.length === 0) return null
  let worst = samples[0]!
  for (const sample of samples) {
    if (Math.abs(sample.gap) > Math.abs(worst.gap)) worst = sample
  }
  return worst
}

/** The summary line after the rows: the worst gap and the sample it was at. */
export function formatSummary(worst: Sample | null): string {
  if (worst === null) return 'no samples'
  return `worst gap ${fixed(worst.gap)} at sample ${worst.index}`
}
