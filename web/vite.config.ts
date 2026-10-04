import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Built into ../static/map and served by the Rust server: index.html at /map,
// home.html at / (the homepage). Both pages share chunks (React, Tailwind).
// `npm run dev` proxies the API to a locally running server (cargo run).
export default defineConfig({
  base: "/map/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../static/map",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        map: "index.html",
        home: "home.html",
      },
    },
    chunkSizeWarningLimit: 1500,
  },
  server: {
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
});
