import { randomUUID } from "node:crypto";
import {
  ClaudeManagedRunnerProcess,
  type ClaudeRunnerOptionsSnapshot,
} from "./claude-managed-runner";

/** Reuse bounded, initialize-only workers across reads for a workspace and launch selection. */
export class ClaudeStartupDiscovery {
  #newSessionCatalogs = new Map<string, { at: number; snapshot: ClaudeRunnerOptionsSnapshot }>();
  #catalogProbe?: {
    key: string;
    runner: ClaudeManagedRunnerProcess;
    result: Promise<ClaudeRunnerOptionsSnapshot>;
  };
  #shuttingDown = false;

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    await this.#catalogProbe?.runner.shutdown();
  }

  #newSessionCatalogKey(
    workspace: string,
    executable: string,
    cliVersion: string,
    home: string,
    autoModel?: string | null,
  ) {
    return JSON.stringify([
      workspace,
      executable,
      cliVersion,
      home,
      autoModel === undefined ? "catalog" : ["auto", autoModel],
    ]);
  }

  cached(
    workspace: string,
    executable: string,
    cliVersion: string,
    home: string,
    autoModel?: string | null,
  ) {
    const key = this.#newSessionCatalogKey(workspace, executable, cliVersion, home, autoModel);
    const cached = this.#newSessionCatalogs.get(key);
    if (!cached || Date.now() - cached.at >= 30_000) return;
    this.#newSessionCatalogs.delete(key);
    this.#newSessionCatalogs.set(key, cached);
    return cached.snapshot;
  }

  async read(
    workspace: string,
    executable: string,
    cliVersion: string,
    home: string,
    environment: NodeJS.ProcessEnv,
    revalidate: boolean,
    autoModel?: string | null,
  ) {
    const key = this.#newSessionCatalogKey(workspace, executable, cliVersion, home, autoModel);
    // Overlapping requests share the initialize, including during rapid workspace changes.
    while (!this.#shuttingDown) {
      const cached = revalidate
        ? undefined
        : this.cached(workspace, executable, cliVersion, home, autoModel);
      if (cached) return cached;
      const probe = this.#catalogProbe;
      if (probe) {
        if (probe.runner.cleanupError) return;
        if (probe.key === key && (!revalidate || autoModel === undefined)) return probe.result;
        await probe.result.catch(() => undefined);
        continue;
      }
      const runner = new ClaudeManagedRunnerProcess(
        workspace,
        randomUUID(),
        true,
        0,
        environment,
        () => undefined,
        false,
        undefined,
        {
          catalogOnly: autoModel === undefined ? true : "auto-permission",
          ...(autoModel === undefined
            ? {}
            : { permissionMode: "auto", model: autoModel ?? undefined }),
          controlTimeoutMs: 4_000,
          cliVersion,
        },
      );
      const result = runner
        .prepare(executable)
        .then(async (snapshot) =>
          autoModel === undefined
            ? snapshot
            : {
                ...snapshot,
                autoPermissionAvailable: await runner.confirmsAutoPermission().catch(() => false),
              },
        )
        .finally(() => runner.shutdown())
        .then((snapshot) => {
          if (snapshot.settingsAcknowledged) {
            this.#newSessionCatalogs.delete(key);
            this.#newSessionCatalogs.set(key, { at: Date.now(), snapshot });
            for (const oldest of this.#newSessionCatalogs.keys()) {
              if (this.#newSessionCatalogs.size <= 32) break;
              this.#newSessionCatalogs.delete(oldest);
            }
          }
          return snapshot;
        })
        .finally(() => {
          // An unconfirmed cleanup stays owned for shutdown. Do not start a replacement.
          if (this.#catalogProbe?.runner === runner && !runner.hasWorker)
            this.#catalogProbe = undefined;
        });
      this.#catalogProbe = { key, runner, result };
      return result;
    }
  }
}
