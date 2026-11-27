import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import {
  ClaudeManagedRunnerProcess,
  type ClaudeRunnerOptionsSnapshot,
} from "./claude-managed-runner";

const AUTO_PERMISSION_TTL_MS = 10 * 60_000;

type AutoPermissionObservation = {
  workspace: string;
  available: boolean;
  expiresAt: number;
  listeners?: Map<string, () => void>;
};

/** Reuse bounded, initialize-only workers across reads for a workspace and launch selection. */
export class ClaudeStartupDiscovery {
  #newSessionCatalogs = new Map<string, { at: number; snapshot: ClaudeRunnerOptionsSnapshot }>();
  #autoPermissions = new Map<string, AutoPermissionObservation>();
  #catalogProbe?: {
    key: string;
    runner: ClaudeManagedRunnerProcess;
    result: Promise<ClaudeRunnerOptionsSnapshot>;
  };
  #shuttingDown = false;

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    this.#autoPermissions.clear();
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

  invalidateAutoPermission(workspace: string): void {
    for (const [key, observation] of this.#autoPermissions)
      if (observation.workspace === workspace) this.#autoPermissions.delete(key);
  }

  observeAutoPermission(
    workspace: string,
    executable: string,
    cliVersion: string,
    home: string,
    environment: NodeJS.ProcessEnv,
    model: string | null,
    sessionId: string,
    changed: () => void,
  ): boolean {
    if (this.#shuttingDown) return false;
    const key = this.#newSessionCatalogKey(workspace, executable, cliVersion, home, model);
    const current = this.#autoPermissions.get(key);
    if (current?.listeners) {
      current.listeners.set(sessionId, changed);
      return current.available;
    }
    const now = Date.now();
    if (current && now < current.expiresAt) return current.available;
    // A missing or expired observation stays disabled until its background probe reports.
    const listeners = new Map([[sessionId, changed]]);
    const observation = {
      workspace,
      available: false,
      expiresAt: 0,
      listeners,
    };
    for (const [staleKey, entry] of this.#autoPermissions)
      if (!entry.listeners && now - entry.expiresAt >= AUTO_PERMISSION_TTL_MS)
        this.#autoPermissions.delete(staleKey);
    this.#autoPermissions.set(key, observation);
    void setImmediate()
      .then(async () => {
        if (this.#autoPermissions.get(key) !== observation) return false;
        const proof = await this.read(
          workspace,
          executable,
          cliVersion,
          home,
          environment,
          true,
          model,
        );
        return proof?.autoPermissionAvailable === true;
      })
      .catch(() => false)
      .then((available) => {
        if (this.#autoPermissions.get(key) !== observation) return;
        this.#autoPermissions.set(key, {
          workspace,
          available,
          expiresAt: Date.now() + AUTO_PERMISSION_TTL_MS,
        });
        if (available || current?.available === true)
          for (const notify of listeners.values()) notify();
      })
      .catch(() => undefined);
    return observation.available;
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
      const cached =
        !revalidate && autoModel === undefined
          ? this.cached(workspace, executable, cliVersion, home)
          : undefined;
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
          if (autoModel === undefined && snapshot.settingsAcknowledged) {
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
