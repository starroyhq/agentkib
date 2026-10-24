import { mergeConfig } from "vite";
import { configDefaults, defineConfig } from "vitest/config";
import { rendererConfig } from "./electron.vite.config.ts";

const mcpLatencyTests = [
  "test/mcp-native-scan-snapshot.test.ts",
  "test/mcp-native-import-snapshot.test.ts",
  "test/mcp-policy-runtime.test.ts",
  "test/claude-settings-runtime.test.ts",
  "test/context-skill-visibility.test.ts",
];
const filesystemTests = [
  // Complete source parsing rebuilds large SQLite/FTS generations with real
  // commits; competing native/MCP workers can consume its unchanged deadline.
  "test/history-search-source.test.ts",
  "test/claude-context-memory.test.ts",
  "test/skill-sync-manager.test.ts",
  "test/skills-lifecycle.test.ts",
  "test/skill-target-discovery.test.ts",
  "test/skill-sync-boundaries.test.ts",
  "test/skill-sync-recovery-regressions.test.ts",
  "test/skill-sync-recovery-gate.test.ts",
  "test/skill-native-directory-names.test.ts",
  "test/skill-damaged-backup-snapshots.test.ts",
  "test/skill-sync-legacy-ref-check.test.ts",
  "test/skill-detach-legacy.test.ts",
  "src/features/skills/SkillSyncFlows.integration.test.tsx",
];

export default mergeConfig(
  rendererConfig,
  defineConfig({
    test: {
      setupFiles: ["./src/test/test-setup.ts"],
      projects: [
        {
          extends: true as const,
          test: {
            name: "desktop",
            exclude: [...configDefaults.exclude, ...mcpLatencyTests, ...filesystemTests],
            sequence: { groupOrder: 1 },
          },
        },
        {
          extends: true as const,
          test: {
            name: "filesystem",
            include: filesystemTests,
            // Deep Context reads and journal fsync/rename tests keep their deadlines
            // without contending with the full suite's filesystem-heavy workers.
            fileParallelism: false,
            sequence: { groupOrder: 2 },
          },
        },
        {
          extends: true as const,
          test: {
            name: "mcp-latency",
            include: mcpLatencyTests,
            // Keep wall-clock budgets meaningful without competing test workers.
            fileParallelism: false,
            sequence: { groupOrder: 3 },
          },
        },
      ],
    },
  }),
);
