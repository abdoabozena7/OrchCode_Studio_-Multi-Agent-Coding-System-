import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    hmr: {
      host: "127.0.0.1",
      protocol: "ws",
      port: 1420
    },
    watch: {
      usePolling: true,
      interval: 250
    }
  },
  envPrefix: ["VITE_", "TAURI_"]
});
