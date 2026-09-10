import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const config = {
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react({ compiler: true }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  test: { setupFiles: ["./src/test/test-setup.ts"] },
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.indexOf("/lucide-react/") >= 0) return "icons";
          if (
            ["/react/", "/react-dom/", "/scheduler/", "/i18next/", "/react-i18next/"].some(
              (dependency) => id.indexOf(dependency) >= 0,
            )
          )
            return "framework";
          return undefined;
        },
      },
    },
  },
};

export default defineConfig(config);
