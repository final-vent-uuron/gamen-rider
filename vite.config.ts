import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    nitro({
      config: { preset: 'cloudflare-module', rollupConfig: { external: [/^@sentry\//] } },
    }),
    tanstackStart(),
    viteReact(),
  ],
})
