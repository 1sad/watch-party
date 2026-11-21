/*
 * The bridge (T05, ADR-038): the only script of ours that runs in the site view.
 *
 * The host injects this text into every document of the site view with
 * `AddScriptToExecuteOnDocumentCreatedAsync`, so it runs in each frame of the
 * page - the cross-origin player frames on 6 of the 11 sites E2 tested included
 * (01 measured that a frame's message reaches the host on its own
 * `frame.WebMessageReceived`). Its whole job is to say what `<video>` elements
 * its frame has; the app view scores them and keeps the winner (shared/player.ts).
 *
 * It posts exactly two kinds, `playerReport` and `playerEvent`, and the host's
 * relay drops every other kind - a page can run this script too, so the frame is
 * not trusted with more. It is plain ES5-ish JavaScript with no imports because
 * it is injected as text, and it must not depend on anything the page may have
 * broken: every read of an element is defensive.
 *
 * Read from disk by `tests/unit/player-bridge.test.ts` and served to the host at
 * `/bridge.js`; there is one copy of these bytes.
 */
(function () {
  'use strict'

  var REPORT = 'playerReport'
  var EVENT = 'playerEvent'

  // A report never repeats faster than this while the candidate set is the
  // same; a changed set may go sooner, but not more than four times a second.
  var POLL_MS = 1000
  var CHANGE_GAP_MS = 250
  // `emptied` and `loadstart` arrive back to back for one reload; one is enough.
  var EVENT_GAP_MS = 100

  var host = window.chrome && window.chrome.webview
  if (!host || typeof host.postMessage !== 'function') return

  var ids = new WeakMap()
  var nextId = 1
  var listened = new WeakSet()
  var eventAt = {}
  var seq = 0
  var lastSentAt = 0
  var lastShape = null

  function idOf(element) {
    var id = ids.get(element)
    if (id === undefined) {
      id = nextId
      nextId += 1
      ids.set(element, id)
    }
    return id
  }

  function post(message) {
    seq += 1
    message.seq = seq
    message.href = String(location.href)
    try {
      host.postMessage(message)
    } catch (error) {
      // A page that broke `postMessage` costs its reports, never its own picture.
    }
  }

  function number(value) {
    return typeof value === 'number' && isFinite(value) ? value : 0
  }

  function measure(element) {
    var box = element.getBoundingClientRect ? element.getBoundingClientRect() : null
    var readyState = number(element.readyState)
    return {
      id: idOf(element),
      w: box ? Math.max(0, Math.round(number(box.width))) : 0,
      h: box ? Math.max(0, Math.round(number(box.height))) : 0,
      readyState: readyState,
      hasSrc: !!(element.currentSrc || element.src),
      // §10.1's last criterion: what is actually playing, not merely loaded.
      playing: element.paused === false && element.ended !== true && readyState > 2,
      duration: number(element.duration),
      t: number(element.currentTime),
    }
  }

  function onReloaded(element, kind) {
    var id = idOf(element)
    var now = Date.now()
    if (eventAt[id] !== undefined && now - eventAt[id] < EVENT_GAP_MS) return
    eventAt[id] = now
    post({ kind: EVENT, event: kind, id: id, t: number(element.currentTime) })
  }

  function watch(element) {
    if (listened.has(element) || !element.addEventListener) return
    listened.add(element)
    element.addEventListener('emptied', function (event) {
      onReloaded(element, event ? event.type : 'emptied')
    })
    element.addEventListener('loadstart', function (event) {
      onReloaded(element, event ? event.type : 'loadstart')
    })
  }

  /** What the frame can see right now: every `<video>` in this document, in DOM order. */
  function scan() {
    var videos = document.querySelectorAll ? document.querySelectorAll('video') : []
    var list = []
    for (var i = 0; i < videos.length; i += 1) {
      watch(videos[i])
      list.push(measure(videos[i]))
    }
    return list
  }

  /**
   * The candidate set as one string, without `t`: the position moves every
   * second by itself, and a report per second is the poll, not a change.
   */
  function shapeOf(list) {
    var parts = []
    for (var i = 0; i < list.length; i += 1) {
      var c = list[i]
      parts.push([
        c.id, c.w, c.h, c.readyState, c.hasSrc ? 1 : 0, c.playing ? 1 : 0, Math.round(c.duration),
      ].join(':'))
    }
    return parts.join('|')
  }

  function send(list, now) {
    lastShape = shapeOf(list)
    lastSentAt = now
    post({ kind: REPORT, candidates: list })
  }

  function tick() {
    var list = scan()
    var shape = shapeOf(list)
    var now = Date.now()
    if (shape !== lastShape) {
      if (now - lastSentAt >= CHANGE_GAP_MS) send(list, now)
      // A change inside the gap is not lost: the next poll sees it again.
      return
    }
    if (now - lastSentAt >= POLL_MS) send(list, now)
  }

  function start() {
    tick()
    setInterval(tick, POLL_MS)
  }

  if (document.readyState === 'loading' && document.addEventListener) {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
