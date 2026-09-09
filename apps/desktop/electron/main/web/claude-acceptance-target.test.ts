// @vitest-environment node
import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { claudeAcceptanceTarget } from "./claude-acceptance-target";

const nativeId = "3121ec99-e4cb-465b-8056-0d653212b113";
const salt = "a".repeat(64);
const id = createHmac("sha256", salt).update(`conversation:claude-code:${nativeId}`).digest("hex");
it("selects the requested native identity among multiple sessions", () => {
  expect(
    claudeAcceptanceTarget(
      [
        { id: "other", agent: "claude-code" },
        { id, agent: "claude-code" },
      ],
      nativeId,
      salt,
    ),
  ).toBe(id);
});
it("refuses a sole unrelated session or wrong provider", () => {
  for (const sessions of [[{ id: "other", agent: "claude-code" }], [{ id, agent: "codex" }], []])
    expect(() => claudeAcceptanceTarget(sessions, nativeId, salt)).toThrow(
      "acceptance_session_not_found",
    );
});
it("fails closed when identity evidence is missing or ambiguous", () => {
  expect(() => claudeAcceptanceTarget([], nativeId, undefined)).toThrow(
    "invalid_acceptance_identity",
  );
  expect(() =>
    claudeAcceptanceTarget(
      [
        { id, agent: "claude-code" },
        { id, agent: "claude-code" },
      ],
      nativeId,
      salt,
    ),
  ).toThrow("acceptance_session_not_found");
});
