import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vite'

// Two separately-deployed apps on separate domains (spec §7, revision 2.2):
// in production the frontend is static-hosted and calls the API cross-origin
// via VITE_API_BASE_URL, with CORS handled on the backend (WEB_ORIGIN). This
// dev proxy stays as a convenience — it keeps `npm run dev` single-command and
// same-origin on localhost — but it's not the deployed topology.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: false,
      },
    },
  },
})
