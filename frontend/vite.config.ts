/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = process.env.STUDIO_BACKEND ?? "http://127.0.0.1:8000";

export default defineConfig({
  // Relative URLs so Studio also works behind a path prefix (e.g. /studio/).
  base: "./",
  plugins: [react()],
  server: {
    port: Number(process.env.STUDIO_FRONTEND_PORT ?? 5173),
    proxy: { "/api": { target: backend, changeOrigin: false } },
  },
  test: { include: ["src/**/*.test.ts"] },
});
