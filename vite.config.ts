/**
 * vite.config.ts — Vite dev-server and production build configuration.
 *
 * Purpose:
 *   Configures how the app is served in development and bundled for GitHub Pages deployment.
 *
 * Operations:
 *   - base "/planet-explorer/": public path matching the GitHub Pages project URL.
 *   - server: port 5173, does not auto-open a browser.
 *   - build: target es2020, chunk warning limit 600 kB, manualChunks puts modules whose id contains "three" in a
 *     separate "three" chunk.
 *
 * Usage:
 *   Read by Vite for `npm run dev` and `npm run build` (and the deploy-pages workflow).
 *
 * Important:
 *   - Changing base breaks asset URLs on the deployed site unless the repo/Pages path changes too.
 *   - The manualChunks test is a substring match on the module id, so any path containing "three" joins that chunk.
 */
import { defineConfig } from "vite";

export default defineConfig({
    base: "/planet-explorer/",
    server: {
        port: 5173,
        open: false,
    },
    build: {
        target: "es2020",
        chunkSizeWarningLimit: 600,
        rollupOptions: {
            output: {
                manualChunks: (id) => (id.includes("three") ? "three" : undefined),
            },
        },
    },
});
