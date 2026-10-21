import { defineConfig } from 'vite';

export default defineConfig({
  base: '/planet-explorer/',
  server: {
    port: 5173,
    open: false,
  },
  build: {
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'] },
      },
    },
  },
});
