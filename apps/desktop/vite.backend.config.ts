import { builtinModules } from "node:module";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    {
      name: "clean-stale-backend-chunks",
      async writeBundle(options, bundle) {
        if (!options.dir) return;
        for (const name of await readdir(options.dir)) {
          if (
            /^backend-.*\.cjs(?:\.map)?$/.test(name) &&
            !Object.hasOwn(bundle, name.replace(/\.map$/, ""))
          )
            await rm(path.join(options.dir, name), { force: true });
        }
      },
    },
  ],
  define: { "import.meta.url": "require('node:url').pathToFileURL(__filename).href" },
  build: {
    target: "node22",
    sourcemap: true,
    minify: true,
    outDir: "dist-electron",
    emptyOutDir: false,
    lib: {
      entry: {
        backend: path.resolve(import.meta.dirname, "electron/backend-entry.ts"),
        "backend-history-search": path.resolve(
          import.meta.dirname,
          "../../packages/backend/src/history-search-worker-entry.ts",
        ),
        "backend-insights": path.resolve(
          import.meta.dirname,
          "../../packages/backend/src/insight-refresh-worker-entry.ts",
        ),
        "backend-skills": path.resolve(
          import.meta.dirname,
          "../../packages/backend/src/skills-worker-entry.ts",
        ),
        "backend-handoff-read": path.resolve(
          import.meta.dirname,
          "../../packages/backend/src/handoff-read-worker.ts",
        ),
        "backend-antigravity-history": path.resolve(
          import.meta.dirname,
          "../../packages/backend/src/agents/antigravity/antigravity-history-worker-entry.ts",
        ),
      },
      formats: ["cjs"],
      fileName: (_format, name) => `${name}.cjs`,
    },
    rolldownOptions: {
      external: (id) => id === "electron" || id.startsWith("node:") || builtinModules.includes(id),
      output: { chunkFileNames: "backend-[name]-[hash].cjs" },
    },
  },
});
