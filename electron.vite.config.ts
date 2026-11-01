import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rolldownOptions: {
        input: { index: 'src/main/index.ts', core: 'src/core/index.ts', server: 'src/server/index.ts' },
        external: ['node-pty'] // native: it has to stay where npm put it
      }
    }
  },
  // Sandboxed preloads must be CommonJS.
  preload: {
    build: {
      rolldownOptions: {
        input: { index: 'src/preload/index.ts' },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    plugins: [react()]
  }
})
