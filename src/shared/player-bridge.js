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
 * Since T145 two more: `refused` (a `play()` the page answered with a rejection,
 * named) and `retry` (the one more try that refusal earns). Neither is a room
 * event - nothing played - so the app view only writes them into the log.
 * The host's relay drops every other kind - a page can run this script too, so
 * the frame is not trusted with more. Since T08 it posts a third, `fullscreen`:
 * the page's fullscreen *intent* (`wrapFullscreen` below). The host keeps that
 * one for itself and relays none of it, because the layout is the window's and
 * the room has no business with the shape of anyone's window. Since T104 it
 * posts a fourth, `pageAddress`, from the top document only (ADR-048): the only
 * document whose address is the room's page, and the host relays it from there
 * alone. It is plain
 * ES5-ish JavaScript with no
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
  // T08: the page's fullscreen intent, posted, read by the host and by nothing
  // else. It is not in the relay's whitelist on purpose.
  var FULLSCREEN = 'fullscreen'
  // T104, ADR-048: the top document's own address, relayed by the host when the
  // sender is the top document. A frame's address is its own, never the room's.
  var PAGE_ADDRESS = 'pageAddress'

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
  // T145: a `play()` the page refused is one more try, not a loop. The window
  // this frame watches in is this long - the ticket's 10 s - and the first try
  // goes out on this beat, because a page whose element is already loaded never
  // fires `canplay` again and the room would wait for a press that never comes.
  var RETRY_WINDOW_MS = 10000
  var RETRY_BEAT_MS = 500
  // T145 item 2: the picture area's one line, and the button beside it. A press
  // here is a real gesture *in this document*, which is the only kind a browser's
  // autoplay rule counts - a press in the app view's column is another document
  // and would be refused again.
  var OVERLAY_TEXT = 'the site would not start playing - press play'
  var OVERLAY_BUTTON = 'Play'

  var host = window.chrome && window.chrome.webview
  if (!host || typeof host.postMessage !== 'function') return

  // T104, ADR-048: only the top document may name the room's page. This is read
  // once - every message says which kind of document sent it, and only the top
  // one announces its address. A page that hid `top` is treated as a frame: no
  // address message is better than the wrong one.
  var isTop = false
  try {
    isTop = window.top === window
  } catch (error) {
    isTop = false
  }

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
  // T145: id -> the re-arm a refused play opened (its two timers), id -> that the
  // window closed unanswered, and id -> the line the picture then shows. Kept
  // apart because the line outlives the window: it waits for the person.
  var retries = {}
  var gaveUp = {}
  var overlays = {}
  // T146, ADR-050: id -> the position a command asked for while the element had
  // no metadata. Such a write is lost (a busy site's remembered 50 s then wins),
  // so the target is kept and tried once when the element reports its duration.
  var lostSeek = {}
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
    // T104, ADR-048: whether this message came from the top document. A frame
    // says false; the host drops a frame's `pageAddress` and relays only the top
    // document's.
    message.top = isTop
    try {
      host.postMessage(message)
    } catch (error) {
      // A page that broke `postMessage` costs its reports, never its own picture.
    }
  }

  function number(value) {
    return typeof value === 'number' && isFinite(value) ? value : 0
  }

  /**
   * T08, ADR-028: the page's fullscreen intent crosses the bridge, because the
   * engine cannot be the trigger. Measured twice in that ticket: the site view's
   * `requestFullscreen()` is refused with `TypeError: not granted`, and it stays
   * refused when the site view is a direct child of the form, so
   * `ContainsFullScreenElementChanged` never fires for it. The picture filling
   * our window is our layout choice anyway, not the engine's - so what the host
   * needs is the page's wish, and this wrapper is where it is heard.
   *
   * One message per call, before the call runs, then the original unchanged. Its
   * rejection gets a no-op handler here: a site that ignores its own promise has
   * no unhandled error on our account, while a site that watches it still sees
   * the refusal. That is the accepted cost of ADR-028 - a site's own icon does
   * not show itself as toggled when the engine refuses - not a defect to report.
   */
  function wrapFullscreen(owner, name, state) {
    try {
      if (!owner || typeof owner[name] !== 'function') return
      var original = owner[name]
      owner[name] = function () {
        post({ kind: FULLSCREEN, state: state })
        var answer = original.apply(this, arguments)
        // T08: the engine's refusal is ours to swallow, never the site's to
        // crash on. The promise is returned as it was, for a player that reads it.
        if (answer && typeof answer.catch === 'function') answer.catch(function () {})
        return answer
      }
    } catch (error) {
      // A page that froze the prototype keeps its own behaviour and loses the
      // layout; the picture still plays.
    }
  }

  // Every frame this script runs in gets its own realm, so each wraps its own
  // prototypes once and a player in an iframe is heard as well as the top page.
  wrapFullscreen(window.Element && window.Element.prototype, 'requestFullscreen', 'enter')
  wrapFullscreen(window.Document && window.Document.prototype, 'exitFullscreen', 'exit')

  // T104: the address last announced. A site that rewrites its address in a
  // loop sends one message per distinct address, not one per rewrite.
  var lastPageHref = null

  /**
   * T104, ADR-048: one `pageAddress` per distinct address of the top document.
   * Called when the document starts and after every route change. A page that
   * broke `location` loses its address messages, never its picture.
   */
  function announcePageAddress() {
    var href
    try {
      href = String(location.href)
    } catch (error) {
      return
    }
    if (href === lastPageHref) return
    lastPageHref = href
    post({ kind: PAGE_ADDRESS, href: href })
  }

  /**
   * T104: wrap one history method so a same-document route change is announced
   * after it runs, with its return value passed through untouched. The same
   * discipline as `wrapFullscreen`: a page that froze the prototype keeps its
   * own behaviour and loses only its address messages; the picture still plays.
   */
  function wrapHistory(owner, name) {
    try {
      if (!owner || typeof owner[name] !== 'function') return
      var original = owner[name]
      owner[name] = function () {
        var answer = original.apply(this, arguments)
        announcePageAddress()
        return answer
      }
    } catch (error) {
      // As above: the page keeps its own history and only the room loses the
      // address.
    }
  }

  if (isTop) {
    wrapHistory(window.history, 'pushState')
    wrapHistory(window.history, 'replaceState')
    try {
      if (typeof window.addEventListener === 'function') {
        // A route change the page performs with the back button, or a fragment
        // change: both move the address the browser shows.
        window.addEventListener('popstate', announcePageAddress)
        window.addEventListener('hashchange', announcePageAddress)
      }
    } catch (error) {
      // A page that broke its own events still plays.
    }
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
    // T146: a reload is a new source, so a target remembered for the old one must
    // not be applied to this one; the app view's next command is the room's word.
    delete lostSeek[id]
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
    // T145: it plays. Whatever a refusal left waiting here is over - including
    // the line, which a page's own control can satisfy as well as ours.
    if (kind === 'play' && element.paused === false) closeRetry(element)
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
    // T145: an element that only now has enough data is the one more try a
    // refused play asked for; one that starts ends the wait however it started.
    element.addEventListener('canplay', function () {
      if (retries[idOf(element)]) retryPlay(element, 'canplay')
    })
    element.addEventListener('playing', function () {
      closeRetry(element)
    })
    element.addEventListener('seeking', function () {
      seeking[idOf(element)] = element.paused === false
    })
    // T146, ADR-050: the element's duration is known from here on, so a position
    // the room asked for before it existed can be written for real.
    element.addEventListener('loadedmetadata', function () {
      reapplyLostSeek(element)
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

  /**
   * T145: a `play()` the page answered with a rejection. Before this ticket the
   * bridge disarmed and said nothing, so nobody - not the room, not the person in
   * front of it - ever learned the picture had not started. The event carries the
   * element (`id`) and the error's own name, which is the difference between the
   * browser's autoplay rule and a site's own refusal.
   */
  function onRefused(element, error) {
    var name = 'Error'
    try {
      if (error && typeof error.name === 'string' && error.name) name = error.name
    } catch (problem) {
      // A page that broke its own error objects still gets a refusal reported.
    }
    var id = idOf(element)
    post({ kind: EVENT, event: 'refused', id: id, name: name, t: number(element.currentTime) })
    // A window already open owns the next attempt; a refused retry does not open
    // a second one, which is what keeps this from becoming a loop.
    if (gaveUp[id] === true) return
    armRetry(element)
  }

  /** One more `play` on this element, said out loud first so the log names it. */
  function retryPlay(element, why) {
    var arm = retries[idOf(element)]
    if (!arm) return
    if (element.paused === false) {
      closeRetry(element)
      return
    }
    // One automatic attempt, whichever of its two triggers came first - the
    // element's own `canplay` or the beat - so a page that refuses both is
    // refused twice and not once per report. A person's gesture always buys
    // one, because that is the only route the browser's rule answers.
    if (why !== 'gesture' && arm.tried === true) return
    if (why !== 'gesture') arm.tried = true
    if (arm.beat !== undefined) {
      clearTimeout(arm.beat)
      arm.beat = undefined
    }
    post({ kind: EVENT, event: 'retry', id: idOf(element), why: why, t: number(element.currentTime) })
    startPlay(element)
  }

  /** End the re-arm for this element: the picture plays, moved, or stopped being asked. */
  function closeRetry(element) {
    var id = idOf(element)
    var arm = retries[id]
    if (arm) {
      if (arm.beat !== undefined) clearTimeout(arm.beat)
      if (arm.deadline !== undefined) clearTimeout(arm.deadline)
      delete retries[id]
    }
    delete gaveUp[id]
    hideOverlay(element)
  }

  /**
   * T145 item 1: the re-arm a refused play earns. One more try goes out on the
   * beat - a page whose element is already loaded fires no `canplay` after the
   * refusal, so waiting for one would wait forever - and any real gesture in this
   * document buys another try. After the window the picture offers the person the
   * button instead of trying again: a refusal the browser means does not expire.
   */
  function armRetry(element) {
    var id = idOf(element)
    if (retries[id]) return
    var arm = { beat: undefined, deadline: undefined }
    retries[id] = arm
    arm.beat = setTimeout(function () {
      arm.beat = undefined
      if (retries[id] !== arm) return
      retryPlay(element, 'beat')
    }, RETRY_BEAT_MS)
    arm.deadline = setTimeout(function () {
      arm.deadline = undefined
      if (retries[id] !== arm) return
      delete retries[id]
      if (element.paused === false) return
      gaveUp[id] = true
      showOverlay(element)
    }, RETRY_WINDOW_MS)
  }

  /** A gesture a person made in this document: the one thing the browser's rule hears. */
  function onGesture() {
    for (var id in retries) {
      if (!retries.hasOwnProperty(id)) continue
      var element = byId[id]
      if (element && element.paused !== false) retryPlay(element, 'gesture')
    }
  }

  /**
   * T145 item 2: the picture area's one line and its Play button. This is the
   * first half of M3's T19. The press that starts the picture has to be made in
   * this document: the app view's chat column is a different one, and a press
   * there is not the gesture a refusal is waiting for.
   */
  function showOverlay(element) {
    var id = idOf(element)
    if (overlays[id]) return
    try {
      if (!document.createElement || !document.body || !document.body.appendChild) return
      var box = document.createElement('div')
      box.setAttribute('data-watchparty', 'refused-play')
      var place = element.getBoundingClientRect ? element.getBoundingClientRect() : null
      var centre = place && place.width > 0 ? place.left + place.width / 2 : 0
      if (!centre || centre < 8) {
        centre = typeof window.innerWidth === 'number' ? window.innerWidth / 2 : 8
      }
      var top = place && place.height > 0 ? place.top + 12 : 12
      box.style.cssText = 'position:fixed;z-index:2147483647;transform:translateX(-50%);'
        + 'left:' + Math.max(8, Math.round(centre)) + 'px;top:' + Math.max(8, Math.round(top)) + 'px;'
        + 'display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:8px;'
        + 'background:rgba(20,21,26,0.94);color:#e8e8ea;border:1px solid rgba(255,255,255,0.18);'
        + 'font:14px/1.3 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,0.5);'
      var line = document.createElement('p')
      line.textContent = OVERLAY_TEXT
      line.style.cssText = 'margin:0'
      var button = document.createElement('button')
      button.type = 'button'
      button.textContent = OVERLAY_BUTTON
      button.style.cssText = 'font:inherit;padding:4px 12px;cursor:pointer'
      button.addEventListener('click', function () {
        pressOverlay(element)
      })
      box.appendChild(line)
      box.appendChild(button)
      document.body.appendChild(box)
      overlays[id] = box
    } catch (error) {
      // A page that froze its own DOM loses the line; the room still reports the
      // refusal and the person can still press the page's own control.
    }
  }

  /** The overlay's press: the element plays, and the line goes when it does. */
  function pressOverlay(element) {
    try {
      var playing = element.play()
      if (playing && typeof playing.catch === 'function') {
        playing.then(function () {
          hideOverlay(element)
        }, function (error) {
          onRefused(element, error)
        })
      }
    } catch (error) {
      onRefused(element, error)
    }
  }

  function hideOverlay(element) {
    var id = idOf(element)
    var box = overlays[id]
    if (!box) return
    delete overlays[id]
    try {
      if (box.parentNode && box.parentNode.removeChild) box.parentNode.removeChild(box)
    } catch (error) {
      // The page removed it, or its own DOM is gone with the document.
    }
  }

  function startPlay(element) {
    // Arm before the write; a refusal disarms, so the entry cannot tag a
    // person's play a moment later.
    var armed = element.paused !== false
    if (armed) arm(element, 'play')
    try {
      var playing = element.play()
      // T145: a refused autoplay is reported, not swallowed, and earns one more
      // try in this frame - the room has nothing to add to a policy answer.
      if (playing && typeof playing.catch === 'function') {
        playing.catch(function (error) {
          if (armed) disarm(element, 'play')
          onRefused(element, error)
        })
      }
    } catch (error) {
      // Same: a synchronous refusal is the same answer as a rejected promise.
      if (armed) disarm(element, 'play')
      onRefused(element, error)
    }
  }

  function setTime(element, target) {
    var id = idOf(element)
    // T146: a target asked for before metadata may be dropped by the element, so
    // it is remembered and tried once when the duration is known. A later command
    // replaces the entry; at metadata or after it, there is nothing to retry.
    if (number(element.readyState) < 1) lostSeek[id] = target
    else delete lostSeek[id]
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
   * T146, ADR-050: the element can take a seek now. A command whose position was
   * written before metadata was lost, and the page's own player then kept whatever
   * its site remembered (the 50 s episode). Applying the room's position here is
   * the adapter's, not a new room frame: the room has not changed.
   */
  function reapplyLostSeek(element) {
    var id = idOf(element)
    if (!lostSeek.hasOwnProperty(id)) return
    var target = lostSeek[id]
    delete lostSeek[id]
    if (!isFinite(number(element.duration))) return
    setTime(element, target)
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

    // T145: a room that stops this element is not waiting for a retry any more,
    // and the line the picture shows ("press play") would then be a lie. A play
    // or a seek is the very ask that was just refused, so the wait it armed
    // stands: the ladder correcting a stalled picture every few seconds must not
    // push the button further away for ever.
    if (action === 'pause') closeRetry(element)

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
    // T104: a document load is a new bridge, so this is where a load's address
    // is said - the same announcement a pushState earns.
    if (isTop) announcePageAddress()
    // T145: a press made on this page while a refusal waits is the gesture the
    // browser's rule is looking for, so the retry is heard before it is spent.
    try {
      if (typeof document.addEventListener === 'function') {
        document.addEventListener('pointerdown', onGesture, true)
        document.addEventListener('keydown', onGesture, true)
      }
    } catch (error) {
      // A page that broke its own events keeps the beat and loses the gesture.
    }
    tick()
    setInterval(tick, PLAYBACK_POLL_MS)
  }

  if (document.readyState === 'loading' && document.addEventListener) {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
