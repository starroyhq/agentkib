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
      entry: path.resolve(import.meta.dirname, "electron/backend-entry.ts"),
      formats: ["cjs"],
      fileName: () => "backend.cjs",
    },
    rollupOptions: {
      external: ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
      output: { chunkFileNames: "backend-[name]-[hash].cjs" },
    },
  },
});
