<script lang="ts">
  import { onMount } from 'svelte'

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

  async function refresh(): Promise<void> {
    clearTimeout(timer)
    try {
      const response = await fetch('/discovery', { cache: 'no-store' })
      if (!response.ok) throw new Error(`discovery answered ${response.status}`)
      payload = (await response.json()) as StartPayload
      unreachable = false
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
    <p class="room">Room code <strong>{payload.roomCode}</strong></p>

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
