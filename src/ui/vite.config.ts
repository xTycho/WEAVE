import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";

const NOTICE = "/*! WEAVE map. Bundles the thinking-orbs engine (MIT License, Copyright (c) 2026 Jakub Antalik); see THIRD_PARTY_NOTICES.md */\n";

/** Keeps the third-party license notice at the top of the bundled script. */
const notice: Plugin = {
  name: "weave-notice",
  generateBundle(_opts, bundle) {
    for (const file of Object.values(bundle)) if (file.type === "chunk" && file.isEntry) file.code = NOTICE + file.code;
  },
};

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  base: "./",
  plugins: [notice],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/ws": { target: "ws://127.0.0.1:3000", ws: true },
    },
  },
});
