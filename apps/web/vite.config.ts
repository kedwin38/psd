import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // scene-graph builds to CommonJS for the API; linked CJS packages must be pre-bundled to import in dev.
  optimizeDeps: {
    include: ["@psd-studio/scene-graph"],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
