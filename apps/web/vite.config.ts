import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react()],
  server: {
    // API_TARGET points a second dev server at another API, e.g. a demo alongside the real one.
    proxy: { "/api": process.env.API_TARGET ?? "http://127.0.0.1:3000" },
  },
});
