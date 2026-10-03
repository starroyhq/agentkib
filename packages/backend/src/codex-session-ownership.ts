import { readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { SessionCollection } from "@agentkib/runtime-protocol";
import { pathIdentity } from "./paths";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};

/** Desktop membership is distinct from cwd: projectless threads also own directories. */
export class CodexSessionOwnership {
  #projectless = new Set<string>();
  #assigned = new Set<string>();
  #outputs = new Set<string>();
  constructor(
    codexHome: string,
    readonly environment: NodeJS.ProcessEnv,
  ) {
    try {
      const file = path.join(codexHome, ".codex-global-state.json");
      if (statSync(file).size > 16 * 1024 * 1024) return;
      const state = record(JSON.parse(readFileSync(file, "utf8")));
      this.#projectless = new Set(
        Array.isArray(state["projectless-thread-ids"])
          ? state["projectless-thread-ids"].filter((id): id is string => typeof id === "string")
          : [],
      );
      for (const [id, assignment] of Object.entries(record(state["thread-project-assignments"]))) {
        const projectId =
          typeof assignment === "string" ? assignment : record(assignment).projectId;
        if (typeof projectId === "string" && projectId.trim()) this.#assigned.add(id);
      }
      for (const [id, directory] of Object.entries(
        record(state["thread-projectless-output-directories"]),
      )) {
        if (typeof directory === "string" && directory) this.#outputs.add(id);
      }
    } catch {
      // CLI installations and older desktops may not have membership metadata.
    }
  }
  collection(id: string, cwd: string, projectId: unknown): SessionCollection | null {
    if ((typeof projectId === "string" && projectId.trim()) || this.#assigned.has(id)) return null;
    if (this.#projectless.has(id) || this.#outputs.has(id)) return "projectless";
    const home = this.environment.HOME ?? this.environment.USERPROFILE ?? homedir();
    const identity = pathIdentity(cwd);
    const temporary = [
      tmpdir(),
      this.environment.TMPDIR,
      this.environment.TEMP,
      this.environment.TMP,
    ].filter((value): value is string => Boolean(value));
    if (
      !path.isAbsolute(cwd) ||
      identity === pathIdentity(home) ||
      path.dirname(cwd) === cwd ||
      temporary.some((directory) => identity === pathIdentity(directory))
    )
      return "unclassified";
    // A sandbox location alone is insufficient proof of a project or explicit projectlessness.
    const sandbox = pathIdentity(path.join(home, "Documents", "Codex"));
    if (identity === sandbox || identity.startsWith(sandbox + path.sep)) return "unclassified";
    return null;
  }
}
