import { defineConfig } from "vite";

// base './' zodat de build op elke statische host (GitHub Pages, submap) werkt
export default defineConfig({
  base: "./",
  worker: { format: "es" },
});
