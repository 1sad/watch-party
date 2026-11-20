import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// The page the sidecar serves and the window loads. Built to dist/, which
// src/server serves as static files (ADR-034: the sidecar serves the page).
export default defineConfig({
  root: 'src/ui',
  plugins: [svelte()],
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
})
