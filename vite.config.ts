import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/ui',
  server: {
    port: 4601,
    host: true, // reachable from a tablet or phone on the same network
    proxy: { '/api': 'http://localhost:4600', '/ws': { target: 'ws://localhost:4600', ws: true } },
  },
  build: { outDir: '../../dist', emptyOutDir: true },
})
