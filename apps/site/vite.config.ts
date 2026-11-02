import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Two pages: the homepage and /docs/. Each is its own entry, so /docs/ is a real file in the build.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, open: true },
  build: { rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), docs: resolve(import.meta.dirname, 'docs/index.html') } } },
})
