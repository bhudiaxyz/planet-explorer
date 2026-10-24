import { defineConfig } from 'vite';

export default defineConfig({
  base: '/planet-explorer/',
  server: {
    port: 5173,
    open: false,
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: (id) => id.includes('three') ? 'three' : undefined,
      },
    },
  },
});
