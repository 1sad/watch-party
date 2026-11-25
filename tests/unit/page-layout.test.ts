/**
 * Ticket 180: ADR-055's second layout owner, and the order of the two.
 *
 * The page has no DOM test, so the contract is proved where it now lives - the
 * stylesheet inside `src/ui/App.svelte`. Two facts are read out of it:
 *
 * 1. The threshold (900 CSS px, ADR-047 as amended) appears **once** in the
 *    page's stylesheet, and the fallback narrow rules are inside that one media
 *    query.
 * 2. The host's `data-layout` wins. Every rule the width alone selects is keyed
 *    on `html:not([data-layout])`, so a page the host has spoken to matches none
 *    of them - the unit case below asks the rules themselves, at both widths,
 *    rather than checking that a selector string exists.
 *
 * The live reading of both rectangles is ticket 180's browser check; this is the
 * half that can run in `npm test`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../src/ui/App.svelte', import.meta.url), 'utf8')
const styleStart = source.indexOf('<style>')
const styleEnd = source.indexOf('</style>')
assert.ok(styleStart !== -1 && styleEnd > styleStart, 'App.svelte carries one stylesheet')
// Comments are read by people; the rules are what the page obeys.
const css = source.slice(styleStart + '<style>'.length, styleEnd).replace(/\/\*[\s\S]*?\*\//g, '')

interface Rule {
  selectors: string[]
  body: string
  media: string | null
}

/** The stylesheet's rules with the `@media` guard each sits inside, if any. */
function rules(cssText: string): Rule[] {
  const out: Rule[] = []
  const open: string[] = []
  let start = 0
  for (let i = 0; i < cssText.length; i++) {
    const character = cssText[i]
    if (character === '{') {
      open.push(cssText.slice(start, i).trim())
      start = i + 1
    } else if (character === '}') {
      const prelude = open.pop()
      if (prelude === undefined) continue
      if (!prelude.startsWith('@')) {
        const media = [...open].reverse().find((entry) => entry.startsWith('@media')) ?? null
        out.push({ selectors: prelude.split(',').map((selector) => selector.trim()), body: cssText.slice(start, i), media })
      }
      start = i + 1
    }
  }
  return out
}

interface Host {
  layout?: 'wide' | 'narrow'
  panel?: 'chat'
}

/**
 * Whether one selector's `html` part matches a root with these attributes. The
 * rules in question only ever test `data-layout` and `data-panel` there.
 */
function htmlMatches(selector: string, host: Host): boolean {
  const html = selector.slice(0, selector.indexOf(' ') === -1 ? selector.length : selector.indexOf(' '))
  if (html.includes("data-layout='narrow'") && host.layout !== 'narrow') return false
  if (html.includes("data-layout='wide'") && host.layout !== 'wide') return false
  if (html.includes(':not([data-layout])') && host.layout !== undefined) return false
  if (html.includes("data-panel='chat'") && host.panel !== 'chat') return false
  return true
}

/** Whether a media guard's width condition holds at a page width in CSS px. */
function mediaMatches(media: string | null, width: number): boolean {
  if (media === null) return true
  const under = /\(\s*width\s*<\s*(\d+)px\s*\)/.exec(media)
  if (under !== null) return width < Number(under[1])
  const over = /\(\s*width\s*>=\s*(\d+)px\s*\)/.exec(media)
  if (over !== null) return width >= Number(over[1])
  assert.fail(`a media guard this test cannot read: ${media}`)
}

/**
 * The layout the `.watch` element ends up with, asked of the stylesheet the way
 * a browser asks it: every matching rule's `display`, with a narrower rule
 * (the host's attribute) beating the bare base rule. The narrow rules are the
 * only ones that say `display: flex`, so one match is enough to mean narrow;
 * the zero-match case is the wide grid the base rule draws.
 */
function layoutFor(host: Host, width: number): 'wide' | 'narrow' {
  let narrow = false
  for (const rule of rules(css)) {
    const watchSelectors = rule.selectors.filter((selector) => selector.endsWith('.watch'))
    if (watchSelectors.length === 0) continue
    if (!watchSelectors.some((selector) => htmlMatches(selector, host))) continue
    if (!mediaMatches(rule.media, width)) continue
    if (/display:\s*flex/.test(rule.body)) narrow = true
  }
  return narrow ? 'narrow' : 'wide'
}

test('T180/ADR-055: the page decides from its own width only when no window host has said otherwise', () => {
  const cases: { host: Host; width: number; layout: 'wide' | 'narrow'; why: string }[] = [
    { host: {}, width: 390, layout: 'narrow', why: "a phone's width puts the chat under the picture" },
    { host: {}, width: 899, layout: 'narrow', why: 'one CSS px below the threshold is still narrow' },
    { host: {}, width: 900, layout: 'wide', why: 'the threshold is ADR-047\'s: 900 px and up is wide' },
    { host: {}, width: 1200, layout: 'wide', why: 'a wide page with no host keeps the 380 px column' },
    {
      host: { layout: 'wide' },
      width: 390,
      layout: 'wide',
      why: "the host's attribute wins even when the width disagrees - the ordering this ticket pins",
    },
    { host: { layout: 'wide' }, width: 1200, layout: 'wide', why: "the host's wide is wide at its own width" },
    {
      host: { layout: 'narrow' },
      width: 1200,
      layout: 'narrow',
      why: "the host's narrow wins at a width the page would call wide",
    },
    { host: { layout: 'narrow' }, width: 390, layout: 'narrow', why: 'both agree, both narrow' },
  ]

  for (const one of cases) {
    assert.equal(layoutFor(one.host, one.width), one.layout, `${one.why} (${JSON.stringify(one.host)} at ${one.width} px)`)
  }
})

test('T180/ADR-055: the threshold appears once in the page stylesheet, in the width fallback', () => {
  const thresholds = css.match(/900/g) ?? []
  assert.equal(thresholds.length, 1, 'one threshold value, in one place: 900')
  assert.match(css, /@media \(width < 900px\)/, 'the one place is a media query on the page\'s own width')
})

test('T180/ADR-055: below the threshold the picture is bounded and the chat has the rest', () => {
  const fallback = rules(css).filter((rule) => rule.media === '@media (width < 900px)')
  const picture = fallback.find((rule) => rule.selectors.some((selector) => selector.endsWith('.picture')))
  assert.ok(picture !== undefined, 'the fallback bounds the picture')
  assert.match(picture.body, /max-height:\s*60%/, 'the picture takes at most 60% of the height, never all of it')
  const body = fallback.find((rule) => rule.selectors.some((selector) => selector.endsWith('.room-body')))
  assert.ok(body !== undefined, 'the fallback gives the chat the rest of the column')
  assert.match(body.body, /flex:\s*1 1 0/, 'the chat grows into the space the picture leaves')
  assert.match(body.body, /min-height:\s*8rem/, 'and keeps its list and input on screen')
})
