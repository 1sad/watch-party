<script lang="ts">
  // The page's whole job in M1's first ticket: prove the window loaded a page
  // the sidecar served, and show which sidecar it is talking to.
  let version = $state('…')
  let reachable = $state(true)

  $effect(() => {
    fetch('/healthz')
      .then((response) => response.text())
      .then((body) => {
        version = body.trim()
      })
      .catch(() => {
        reachable = false
        version = 'unavailable'
      })
  })
</script>

<main>
  <h1>Watch Party</h1>
  <p class="lede">The page the window loads, served by the sidecar.</p>
  <p class="version" data-reachable={reachable}>sidecar {version}</p>
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
  }

  h1 {
    margin: 0 0 0.5rem;
    font-size: 2rem;
    letter-spacing: -0.02em;
  }

  .lede {
    margin: 0 0 1.5rem;
    color: #9a9aab;
  }

  .version {
    margin: 0;
    font-family: Consolas, monospace;
    font-size: 0.95rem;
    color: #7fd0a5;
  }
</style>
