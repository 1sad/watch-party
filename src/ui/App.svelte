<script lang="ts">
  import { onMount } from 'svelte'

  import { ERROR_SENTENCES, type ServerFrame, type WireMember } from '../shared/protocol.ts'
  import { parseJoinLink, UNREADABLE_LINK, UNREACHABLE_ROOM } from './join.ts'

  interface DiscoveryResult {
    kind: 'ok' | 'cgnat' | 'upnp_unavailable' | 'timeout'
    externalIp?: string
    mappedPort: number | null
    localPort: number
    detail: string
    addressClass: 'public' | 'private' | 'cgnat' | 'unknown'
    sentence: string
  }

  interface InviteLinks {
    primary: string
    raw: string
    lanRaw: string | null
  }

  interface StartPayload {
    status: 'pending' | 'ready'
    roomCode: string
    lanIp: string | null
    localPort: number
    result: DiscoveryResult | null
    invite: InviteLinks | null
  }

  let payload = $state<StartPayload | null>(null)
  let unreachable = $state(false)
  let copied = $state(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  // The room on screen is only ever what the last frame said (T3b item 4):
  // `welcome` starts it, `members` replaces it. No ordering, no names, no
  // presence is worked out here — names and the duplicate suffix arrive ready
  // to show (`WireMember.displayName`), so the page cannot disagree with itself.
  let selfId = $state<string | null>(null)
  let roomCode = $state<string | null>(null)
  let members = $state<WireMember[]>([])
  let sentence = $state<string | null>(null)

  let joinText = $state('')
  let nameDraft = $state('')

  let socket: WebSocket | null = null
  /** True once this page has decided which room it dials; the poll never overrides it. */
  let enteredRoom = false

  // The window's own room keeps the whole start screen; a room someone else
  // started does not have this window's invite link to show.
  const inOwnRoom = $derived(roomCode === null || payload === null || roomCode === payload.roomCode)

  function connect(host: string, port: number, code: string): void {
    const previous = socket
    socket = null
    previous?.close()

    selfId = null
    roomCode = null
    members = []

    let opened: WebSocket
    try {
      opened = new WebSocket(`ws://${host}:${port}/`)
    } catch {
      sentence = UNREACHABLE_ROOM
      return
    }

    socket = opened
    opened.onopen = () => {
      if (opened !== socket) return
      // R26: no name, so the member appears as `anonymous`; the roster renames.
      opened.send(JSON.stringify({ type: 'hello', code }))
    }
    opened.onmessage = (event: MessageEvent) => {
      if (opened !== socket) return
      let frame: ServerFrame
      try {
        frame = JSON.parse(String(event.data)) as ServerFrame
      } catch {
        return
      }
      apply(frame)
    }
    opened.onclose = () => {
      if (opened !== socket) return
      socket = null
      if (selfId === null) sentence = UNREACHABLE_ROOM
    }
  }

  function apply(frame: ServerFrame): void {
    if (frame.type === 'welcome') {
      selfId = frame.selfId
      roomCode = frame.room.code
      members = frame.members
      sentence = null
    } else if (frame.type === 'members') {
      members = frame.members
    } else if (frame.type === 'error') {
      // One sentence, no code and no jargon (T3b item 5). The socket stays
      // open: a `bad_room` is answered on the same connection, so the box below
      // is still usable with a corrected link.
      sentence = ERROR_SENTENCES[frame.code]
    }
  }

  function submitJoin(event: SubmitEvent): void {
    event.preventDefault()
    const target = parseJoinLink(joinText)
    if (target === null) {
      sentence = UNREADABLE_LINK
      return
    }
    enteredRoom = true
    connect(target.host, target.port, target.code)
  }

  function submitRename(event: SubmitEvent): void {
    event.preventDefault()
    if (socket === null || selfId === null) return
    // A blank draft is sent as written; the room turns it into `anonymous`
    // (R26). Normalising here would be a second copy of `normalizeName`.
    socket.send(JSON.stringify({ type: 'rename', name: nameDraft }))
  }

  async function refresh(): Promise<void> {
    clearTimeout(timer)
    try {
      const response = await fetch('/discovery', { cache: 'no-store' })
      if (!response.ok) throw new Error(`discovery answered ${response.status}`)
      payload = (await response.json()) as StartPayload
      unreachable = false
      if (!enteredRoom) {
        // The window loads this page from 127.0.0.1, so its own connection is
        // the local one, and the owner seat is settled on it (socket.ts).
        enteredRoom = true
        connect(location.hostname, Number(location.port), payload.roomCode)
      }
      if (payload.status === 'pending') timer = setTimeout(() => void refresh(), 750)
    } catch {
      unreachable = true
    }
  }

  async function retry(): Promise<void> {
    try {
      await fetch('/discovery/retry', { method: 'POST' })
    } finally {
      await refresh()
    }
  }

  async function copy(): Promise<void> {
    const text = payload?.invite?.primary
    if (text === undefined) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const area = document.createElement('textarea')
      area.value = text
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }
    copied = true
    setTimeout(() => (copied = false), 1500)
  }

  onMount(() => {
    // R26's no-typing path: `?join=<encoded link>` is parsed before the first
    // discovery answer can claim this window's own room.
    const prefilled = new URLSearchParams(location.search).get('join')
    if (prefilled !== null) {
      enteredRoom = true
      joinText = prefilled
      const target = parseJoinLink(prefilled)
      if (target === null) sentence = UNREADABLE_LINK
      else connect(target.host, target.port, target.code)
    }

    void refresh()
    return () => clearTimeout(timer)
  })
</script>

<main>
  <h1>Watch Party</h1>

  {#if unreachable}
    <p class="sentence">The room process is not answering. Close the window and start Watch Party again.</p>
  {:else if payload === null}
    <p class="sentence">Starting the room…</p>
  {:else}
    <p class="room">Room code <strong>{roomCode ?? payload.roomCode}</strong></p>

    {#if inOwnRoom}
      <h2>Start a room</h2>

      {#if payload.status === 'pending'}
        <p class="sentence">Asking your router to open a port…</p>
      {:else if payload.result !== null}
        <p class="sentence">{payload.result.sentence}</p>

        {#if payload.invite !== null}
          <section class="invite">
            <p class="label">Invite link</p>
            <p class="link">{payload.invite.primary}</p>
            <button type="button" onclick={() => void copy()}>{copied ? 'Copied' : 'Copy invite link'}</button>
            <p class="label fallback">If the link does not open, paste this:</p>
            <p class="link raw">{payload.invite.raw}</p>
            {#if payload.invite.lanRaw !== null && payload.invite.lanRaw !== payload.invite.raw}
              <p class="label fallback">On this network:</p>
              <p class="link raw">{payload.invite.lanRaw}</p>
            {/if}
          </section>
        {/if}

        <p class="detail">{payload.result.detail}</p>
      {/if}

      {#if payload.status === 'ready'}
        <button type="button" class="secondary" onclick={() => void retry()}>Try again</button>
      {/if}
    {:else}
      <h2>You joined a room</h2>
      <p class="sentence">Someone else started this one, so the link above is not yours to share.</p>
    {/if}

    <section class="join">
      <h2>Join a room</h2>
      <form onsubmit={submitJoin}>
        <input
          type="text"
          aria-label="Invite link"
          placeholder="Paste the invite link someone sent you"
          bind:value={joinText}
        />
        <button type="submit">Join</button>
      </form>
      {#if sentence !== null}
        <p class="sentence error" role="status">{sentence}</p>
      {/if}
    </section>

    {#if members.length > 0}
      <section class="roster">
        <h2>In this room</h2>
        <ul>
          {#each members as member (member.id)}
            <li>
              <span class="dot {member.status}" title={member.status}></span>
              <span class="name">{member.displayName}</span>
              {#if member.id === selfId}<span class="you">you</span>{/if}
            </li>
          {/each}
        </ul>

        {#if selfId !== null}
          <form onsubmit={submitRename}>
            <input type="text" aria-label="Your name" placeholder="Your name" bind:value={nameDraft} />
            <button type="submit">Set name</button>
          </form>
        {/if}
      </section>
    {/if}
  {/if}
</main>

<style>
  :global(html, body) {
    margin: 0;
    height: 100%;
    background: #14151a;
    color: #e9e9ef;
    font-family: 'Segoe UI', system-ui, sans-serif;
  }

  main {
    padding: 2.5rem 3rem;
    max-width: 52rem;
  }

  h1 {
    margin: 0 0 0.5rem;
    font-size: 2rem;
    letter-spacing: -0.02em;
  }

  h2 {
    margin: 1.75rem 0 0.75rem;
    font-size: 1.05rem;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: #c8c8d2;
  }

  .room {
    margin: 0 0 1.5rem;
    color: #9a9aab;
  }

  .room strong {
    font-family: Consolas, monospace;
    font-size: 1.15rem;
    letter-spacing: 0.12em;
    color: #e9e9ef;
  }

  .sentence {
    margin: 0 0 1.5rem;
    font-size: 1.1rem;
    line-height: 1.5;
  }

  .sentence.error {
    margin: 0.75rem 0 0;
    color: #ffb3a7;
  }

  .invite {
    padding: 1rem 1.25rem;
    margin: 0 0 1.5rem;
    border: 1px solid #2c2d36;
    border-radius: 8px;
    background: #1a1b22;
  }

  .label {
    margin: 0 0 0.35rem;
    font-size: 0.85rem;
    color: #9a9aab;
  }

  .label.fallback {
    margin-top: 1rem;
  }

  .link {
    margin: 0 0 0.75rem;
    font-family: Consolas, monospace;
    font-size: 0.95rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
    color: #7fd0a5;
  }

  .link.raw {
    color: #e9e9ef;
  }

  form {
    display: flex;
    gap: 0.5rem;
    margin: 0;
  }

  input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0.45rem 0.6rem;
    border: 1px solid #3a3b46;
    border-radius: 6px;
    background: #1a1b22;
    color: #e9e9ef;
    font: inherit;
  }

  ul {
    margin: 0 0 1rem;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.35rem 0;
    font-size: 1.05rem;
  }

  .dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    background: #5a5a66;
  }

  .dot.online {
    background: #3ec78a;
  }

  .dot.suspect {
    background: #e0b34a;
  }

  .dot.offline {
    background: #5a5a66;
  }

  .name {
    overflow-wrap: anywhere;
  }

  .you {
    padding: 0.05rem 0.4rem;
    border: 1px solid #3b6f5a;
    border-radius: 999px;
    font-size: 0.75rem;
    color: #7fd0a5;
  }

  button {
    padding: 0.45rem 0.9rem;
    border: 1px solid #3b6f5a;
    border-radius: 6px;
    background: #1f3a30;
    color: #d7f5e6;
    font: inherit;
    cursor: pointer;
  }

  button.secondary {
    border-color: #3a3b46;
    background: #22232c;
    color: #c8c8d2;
  }

  .detail {
    margin: 0;
    font-family: Consolas, monospace;
    font-size: 0.8rem;
    color: #6f6f7e;
  }
</style>
