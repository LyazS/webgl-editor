import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  optimizeDeps: {
    // Keep WASM URLs relative to the original modules during development.
    exclude: ["harfbuzzjs", "@playcanvas/msdfgen-wasm"],
    esbuildOptions: {
      target: "esnext"
    }
  },
  build: {
    target: "esnext"
  }
});
