import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
export default defineConfig(({ mode }) => ({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: mode === "hosted" ? "dist-hosted" : "dist" },
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: mode !== "test" }),
    tailwindcss(),
    react(),
    {
      name: "agentkib-build-info",
      generateBundle() {
        if (mode === "hosted") {
          for (const fileName of ["_headers", "_redirects"]) {
            this.emitFile({
              type: "asset",
              fileName,
              source: readFileSync(new URL(`./hosting/${fileName}`, import.meta.url), "utf8"),
            });
          }
        }
        const version = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
          .version as string;
        let revision = "unknown";
        let dirty: boolean | null = null;
        try {
          revision = execFileSync("git", ["rev-parse", "HEAD"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
          dirty =
            execFileSync("git", ["status", "--porcelain"], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            }).trim().length > 0;
        } catch {
          /* Source archives need not contain Git metadata. */
        }
        this.emitFile({
          type: "asset",
          fileName: "build-info.json",
          source: JSON.stringify({ version, revision, dirty }, null, 2) + "\n",
        });
      },
    },
  ],
  server: {
    port: 1423,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:1421",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (request) => request.setHeader("Origin", "http://127.0.0.1:1421"));
        },
      },
    },
  },
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"] },
}));
