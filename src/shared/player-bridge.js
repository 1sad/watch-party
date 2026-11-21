/*
 * The bridge (T05, T06, ADR-038): the only script of ours that runs in the site view.
 *
 * The host injects this text into every document of the site view with
 * `AddScriptToExecuteOnDocumentCreatedAsync`, so it runs in each frame of the
 * page - the cross-origin player frames on 6 of the 11 sites E2 tested included
 * (01 measured that a frame's message reaches the host on its own
 * `frame.WebMessageReceived`). It has two jobs: say what `<video>` elements its
 * frame has, so the app view can elect one (shared/player.ts), and be the hands
 * of the room on that element - accept a command, and report what the element
 * did (T06).
 *
 * It posts one kind, `playerReport`, for the candidate list, and one,
 * `playerEvent`, for everything the element does: `emptied`/`loadstart` (a
 * reload), `play`/`pause`/`seeked` (a state the room may have to hear about),
 * and `applied` (a command this frame just carried out, for the `player:` line).
 * The host's relay drops every other kind - a page can run this script too, so
 * the frame is not trusted with more. It is plain ES5-ish JavaScript with no
 * imports because it is injected as text, and it must not depend on anything the
 * page may have broken: every read of an element is defensive.
 *
 * §6.6's echo suppression is **not** here: the events this script posts include
 * our own commands' effects, and the app view drops them using the one echo set
 * in `shared/echo.ts`, recorded before the command is posted. That keeps the
 * rule in one place, and this file only has to say what happened — plus, since
 * T15, whether this frame caused it (`caused` on every `play`/`pause`/`seeked`/
 * `rate`), so the decision never has to infer it from a stale report.
 *
 * Read from disk by `tests/unit/player-bridge.test.ts` and served to the host at
 * `/bridge.js`; there is one copy of these bytes.
 */
(function () {
  'use strict'

  var REPORT = 'playerReport'
  var EVENT = 'playerEvent'
  var COMMAND = 'siteCommand'
  var APPLY = 'playerCommand'

  // A report never repeats faster than this while the candidate set is the
  // same; a changed set may go sooner, but not more than four times a second.
  var POLL_MS = 1000
  var CHANGE_GAP_MS = 250
  // §6.2 wants a measurement often enough for §6.3's ladder; while a candidate
  // is playing (or the site view has focus), the poll runs at this rate.
  var PLAYBACK_POLL_MS = 500
  // `emptied` and `loadstart` arrive back to back for one reload; one is enough.
  var EVENT_GAP_MS = 100
  // T15: how long an unclaimed "we are about to cause this" entry is believed.
  // The same second `echo.ts` allows, and for the same reason: a write the
  // browser refused, or a value it did not change, must not tag a person's
  // event a moment later.
  var CAUSED_EXPIRY_MS = 1000

  var host = window.chrome && window.chrome.webview
  if (!host || typeof host.postMessage !== 'function') return

  var ids = new WeakMap()
  var nextId = 1
  var byId = {}
  var listened = new WeakSet()
  var eventAt = {}
  var seeking = {}
  // T15: id -> kind -> instants. Armed immediately before a write this frame
  // makes, spent by the event that write causes.
  var caused = {}
  // T15: id -> the pending `setTimeout` of a scheduled start, so a later command
  // can cancel the beat instead of being undone by it.
  var holds = {}
  var seq = 0
  var lastSentAt = 0
  var lastShape = null

  // T07: this document's own name. A navigation builds a new document and so a
  // new bridge, whose `seq` counts from 1 again; the app view cannot tell a
  // restart from old news by the number alone, and 06b measured the election
  // never coming back after a reload because of exactly that. Random, not
  // counted: two frames' documents must not collide, and nothing reads it but
  // the one window placing the report in order.
  var doc = (function () {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return String(window.crypto.randomUUID())
      }
    } catch (error) {
      // A page that broke crypto gets the fallback below, not a silent bridge.
    }
    return String(Date.now()) + '-' + String(Math.random()).slice(2)
  })()

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
    // T07: which document of this frame this is, so a reload's counting can be
    // told from an out-of-order delivery.
    message.doc = doc
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

  function bufferedEnd(element) {
    try {
      if (element.buffered && element.buffered.length > 0) {
        return number(element.buffered.end(element.buffered.length - 1))
      }
    } catch (error) {
      // A detached or empty TimeRanges has no end; 0 is the honest answer.
    }
    return 0
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
      // §5's `report` fields (T06): the app view maps these onto the `report` frame.
      paused: element.paused !== false,
      buffered: bufferedEnd(element),
      rate: number(element.playbackRate),
    }
  }

  function onReloaded(element, kind) {
    var id = idOf(element)
    var now = Date.now()
    if (eventAt[id] !== undefined && now - eventAt[id] < EVENT_GAP_MS) return
    eventAt[id] = now
    post({ kind: EVENT, event: kind, id: id, t: number(element.currentTime) })
  }

  /** Record, before the write, that this frame is about to make the element do `kind`. */
  function arm(element, kind) {
    var id = idOf(element)
    var box = caused[id] || (caused[id] = {})
    var list = box[kind] || (box[kind] = [])
    list.push(Date.now())
  }

  /** Drop one kind's unspent entries: the write they describe is not going to happen. */
  function disarm(element, kind) {
    var box = caused[idOf(element)]
    if (box && box[kind]) box[kind].length = 0
  }

  /**
   * True when this event is one of the writes `arm` recorded, one entry spent.
   * This is T15's provenance: the answer comes from this frame's own hands, not
   * from a report the app view holds that may be half a second old.
   */
  function takeCaused(element, kind) {
    var box = caused[idOf(element)]
    if (!box || !box[kind] || box[kind].length === 0) return false
    var now = Date.now()
    var live = []
    for (var i = 0; i < box[kind].length; i += 1) {
      if (now - box[kind][i] < CAUSED_EXPIRY_MS) live.push(box[kind][i])
    }
    box[kind] = live
    if (live.length === 0) return false
    live.shift()
    return true
  }

  function onPlayback(element, kind) {
    var message = {
      kind: EVENT,
      event: kind,
      id: idOf(element),
      t: number(element.currentTime),
      // T15: `true` when this frame caused it. The app view drops our own
      // events on this, so §6.6's prediction cannot misjudge a hold.
      caused: takeCaused(element, kind),
    }
    // T17: a playing element the page removes from the DOM is paused by the
    // browser itself, and that pause is not a person's. Blink pauses it only
    // after the element is detached (RemovedFrom -> OnRemovedFromDocumentTimerFired,
    // which returns early while isConnected() is still true), so this is the one
    // fact that tells the two apart, and only this frame can see it. Sent only
    // when true: every other message keeps the shape it had.
    if (kind === 'pause' && element.isConnected === false) message.detached = true
    post(message)
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
    // T06: the four events a room command can be mistaken for, or a person can
    // cause. Which of the two it was is the app view's answer (§6.6).
    element.addEventListener('play', function () {
      onPlayback(element, 'play')
    })
    element.addEventListener('pause', function () {
      onPlayback(element, 'pause')
    })
    element.addEventListener('seeking', function () {
      seeking[idOf(element)] = element.paused === false
    })
    element.addEventListener('seeked', function () {
      var id = idOf(element)
      var wasPlaying = seeking[id] === true
      delete seeking[id]
      post({
        kind: EVENT,
        event: 'seeked',
        id: id,
        t: number(element.currentTime),
        wasPlaying: wasPlaying,
        caused: takeCaused(element, 'seeked'),
      })
    })
    // T15: a rate this frame re-rates is ours too, and says so. Since T14 this
    // frame does write rates (the nudge's set and restore), and the app view
    // still never turns one into a room command (§6.3's rate is the ladder's).
    element.addEventListener('ratechange', function () {
      onPlayback(element, 'rate')
    })
  }

  /** What the frame can see right now: every `<video>` in this document, in DOM order. */
  function scan() {
    var videos = document.querySelectorAll ? document.querySelectorAll('video') : []
    var list = []
    for (var i = 0; i < videos.length; i += 1) {
      watch(videos[i])
      byId[idOf(videos[i])] = videos[i]
      list.push(measure(videos[i]))
    }
    return list
  }

  /**
   * The candidate set as one string, without `t` and the playback fields: the
   * position moves every second by itself, and a report per half second is the
   * poll, not a change.
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

  function focused() {
    try {
      return !!(document.hasFocus && document.hasFocus())
    } catch (error) {
      return false
    }
  }

  function tick() {
    var list = scan()
    var shape = shapeOf(list)
    var now = Date.now()
    var busy = focused()
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].playing) busy = true
    }
    if (shape !== lastShape) {
      if (now - lastSentAt >= CHANGE_GAP_MS) send(list, now)
      // A change inside the gap is not lost: the next poll sees it again.
      return
    }
    if (now - lastSentAt >= (busy ? PLAYBACK_POLL_MS : POLL_MS)) send(list, now)
  }

  function startPlay(element) {
    // Arm before the write; a refusal disarms, so the entry cannot tag a
    // person's play a moment later.
    var armed = element.paused !== false
    if (armed) arm(element, 'play')
    try {
      var playing = element.play()
      // A refused autoplay is the site's own business, not a reason to throw here.
      if (playing && typeof playing.catch === 'function') {
        playing.catch(function () {
          if (armed) disarm(element, 'play')
        })
      }
    } catch (error) {
      // Same: the element not starting is reported by the next report.
      if (armed) disarm(element, 'play')
    }
  }

  function setTime(element, target) {
    var moved = Math.abs(number(element.currentTime) - target) > 0.001
    if (moved) arm(element, 'seeked')
    try {
      element.currentTime = target
    } catch (error) {
      // An element with no duration yet refuses the write; the next state tries again.
      if (moved) disarm(element, 'seeked')
    }
  }

  /**
   * T15 item 2: a hold belongs to the element, and any later command for that
   * element supersedes it. The beat it was waiting for would otherwise start the
   * element behind the command's back - a pause during the lead that plays again
   * 1.5 s later, which is the jump R8 forbids.
   */
  function cancelHold(element) {
    var id = idOf(element)
    var hold = holds[id]
    if (hold === undefined) return
    clearTimeout(hold)
    delete holds[id]
    disarm(element, 'play')
  }

  /**
   * One `playerCommand` from the app view: the only write this frame makes on
   * the room's behalf. The host routed it to this frame (T01b measured a
   * cross-origin frame accepts a posted message); `href` is checked again here
   * because the same command falls back to the top document when the host has
   * no frame for that URL, and a stray id must not move a different video.
   *
   * A command with a `leadMs` is §6.4's scheduled start, so it is never "play
   * now": whatever is playing is held first, the playhead is placed, and
   * `play()` waits for the beat. That is what stops the window that pressed
   * play running ahead of the one that only heard about it.
   */
  function applyCommand(payload) {
    if (!payload || payload.kind !== APPLY) return
    var element = byId[payload.id]
    if (!element) return
    if (typeof payload.href === 'string' && payload.href !== String(location.href)) return

    var from = number(element.currentTime)
    var target = typeof payload.target === 'number' && isFinite(payload.target) ? payload.target : from
    var lead = typeof payload.leadMs === 'number' && isFinite(payload.leadMs) ? Math.max(0, payload.leadMs) : 0
    var action = payload.action
    var scheduled = lead > 0

    // T14: §6.3's nudge rate and its restore to 1. One write, nothing else: a
    // rate must not move the playhead, start or stop the element, or cancel a
    // beat that is waiting (a hold is about *when* to play, not how fast). No
    // `applied` line either - the room gave no reason and no target for it.
    if (action === 'rate') {
      var nextRate = typeof payload.rate === 'number' && isFinite(payload.rate) ? payload.rate : 1
      try {
        element.playbackRate = nextRate
      } catch (error) {
        // A page that froze `playbackRate` reports its own number; the app
        // view's deadline still restores, and that restore simply does not take.
      }
      return
    }

    if (action !== 'pause' && action !== 'play' && action !== 'seek') return

    // T15 item 2: this command is newer than any beat still waiting, so the
    // waiting beat is cancelled before this one is carried out.
    cancelHold(element)

    try {
      if (action === 'pause' || (scheduled && element.paused === false)) {
        // Only a write that will really fire `pause` is armed; pausing an
        // already-paused element fires nothing.
        if (element.paused === false) arm(element, 'pause')
        element.pause()
      }
    } catch (error) {
      // A page that broke `pause` still gets the line below, which says so.
    }

    if (typeof payload.target === 'number') setTime(element, target)

    if (action === 'pause') {
      // Nothing more: a paused room's playhead is the ladder's to snap.
    } else if (action === 'seek' && payload.resume !== true) {
      // A paused snap: the playhead moved and the element stays paused.
    } else if (scheduled) {
      var id = idOf(element)
      holds[id] = setTimeout(function () {
        delete holds[id]
        startPlay(element)
      }, lead)
    } else {
      startPlay(element)
    }

    // T06's one line per applied command: the reason the room gave, where the
    // playhead was asked to go, and where it was when this frame looked.
    post({
      kind: EVENT,
      event: 'applied',
      id: idOf(element),
      action: action,
      reason: typeof payload.reason === 'string' ? payload.reason : '(none)',
      target: target,
      from: from,
    })
  }

  function onHostMessage(event) {
    var message = event ? event.data : null
    if (!message || message.kind !== COMMAND) return
    applyCommand(message.payload)
  }

  if (typeof host.addEventListener === 'function') {
    host.addEventListener('message', onHostMessage)
  }

  function start() {
    tick()
    setInterval(tick, PLAYBACK_POLL_MS)
  }

  if (document.readyState === 'loading' && document.addEventListener) {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
