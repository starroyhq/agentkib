import { afterEach, describe, expect, it } from "vitest";
import {
  MANAGED_START,
  MANAGED_END,
  defaultManifest,
} from "../../../packages/backend/src/default-manifest";
import {
  instructionImportProof,
  sharedInstructionOverlap,
  unmanagedInstructions,
} from "../../../packages/backend/src/instruction-adoption";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

const fixtures: ContextFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
});

describe("instruction ownership evidence", () => {
  it.each([
    ["# Project\nUse pnpm.\n", "# Project\nUse pnpm.\nAdditional private rule.\n", true],
    ["# Project\nUse pnpm.\n", "# Project\nUse another workflow.\n", false],
    ["# Project\nUse pnpm.\n", "# Project\n<!-- Use pnpm. -->\n", false],
    ["# Project\n- Use pnpm.\n", "Use pnpm.\n", true],
    ["Keep the entire original guideline.\n", "Keep the entire\noriginal guideline.\n", true],
    ["# Project\n", "# Project\n", false],
  ])(
    "matches substantive overlap without treating headings or comments as duplicate instructions",
    (shared, outside, matches) => {
      expect(sharedInstructionOverlap(shared, outside)).toBe(matches);
    },
  );

  it("extracts the prefix and suffix without taking ownership of either", () => {
    expect(unmanagedInstructions(`prefix\n${MANAGED_START}\nmanaged\n${MANAGED_END}\nsuffix`)).toBe(
      "prefix\n\n\nsuffix",
    );
    expect(unmanagedInstructions("unmanaged body")).toBe("unmanaged body");
  });

  it.each([
    MANAGED_START,
    MANAGED_END,
    `${MANAGED_END}\n${MANAGED_START}`,
    `${MANAGED_START}\na\n${MANAGED_END}\n${MANAGED_START}`,
  ])("does not reinterpret incomplete or ambiguous managed markers", (content) => {
    expect(unmanagedInstructions(content)).toBeNull();
  });

  it("does not establish first-import proof for a previously managed native file", () => {
    const f = contextFixture();
    fixtures.push(f);
    f.write("AGENTS.md", `${MANAGED_START}\nUse pnpm.\n${MANAGED_END}\n`);
    f.write("CLAUDE.md", "Use pnpm.\n");
    expect(instructionImportProof(f.project, defaultManifest(f.project))?.source_hashes).toEqual(
      {},
    );
  });
});
