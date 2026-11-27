import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// In dev, the Worker runs in Alchemy's local workerd; Vite serves the UI with HMR
// and forwards /api (including room WebSockets) to it.
const api = process.env.API_URL ?? "http://localhost:1337"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: { "/api": { target: api, ws: true, changeOrigin: true }, "/mcp": { target: api, changeOrigin: true }, "/.well-known/oauth-": { target: api, changeOrigin: true } },
    // Cells write their SQLite under .alchemy on every op; watching it would reload the page on each edit.
    watch: { ignored: ["**/.alchemy/**", "**/dist/**"] },
  },
})
