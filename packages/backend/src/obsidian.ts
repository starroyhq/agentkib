import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveCommand } from "./command-resolution";
import { randomUUID } from "node:crypto";

type VaultSource = "discovered" | "manual";

type Vault = {
  path: string;
  name: string;
  source: VaultSource;
  last_opened_at: number | null;
};

type WorkspaceLink = { workspace_id: string; vault_path: string; target_path: string };

type StoredIntegration = {
  manual_vaults?: string[];
  workspace_links?: Record<string, WorkspaceLink>;
};

const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";
const isLinux = process.platform === "linux";

export class ObsidianIntegration {
  #writes: Promise<void> = Promise.resolve();
  constructor(private readonly dataDir: string) {}

  #write<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writes.then(operation);
    this.#writes = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async integration() {
    const stored = await this.#load();
    const manual = await Promise.all(
      (stored.manual_vaults ?? []).map((value) => this.#validateVault(value)),
    );
    const discovered = await this.#discoverVaults();
    const known = new Set(discovered.map((vault) => vault.path));
    for (const vaultPath of manual) {
      if (vaultPath && !known.has(vaultPath)) {
        discovered.push(this.#vault(vaultPath, "manual", null));
        known.add(vaultPath);
      }
    }
    discovered.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    return {
      installation: await this.#installation(),
      vaults: discovered,
      workspace_links: Object.values(stored.workspace_links ?? {}).sort((a, b) =>
        a.workspace_id.localeCompare(b.workspace_id),
      ),
    };
  }

  async addVault(value: string) {
    const vault = await this.#validateVault(value);
    if (!vault) throw new Error(`Obsidian vault does not exist: ${value}`);
    await this.#write(async () => {
      const stored = await this.#load();
      stored.manual_vaults = [...new Set([...(stored.manual_vaults ?? []), vault])].sort();
      await this.#save(stored);
    });
    return this.integration();
  }

  async linkWorkspace(workspaceId: string, vaultPath: string, relativeTarget?: string | null) {
    const vault = await this.#validateVault(vaultPath);
    if (!vault) throw new Error(`Obsidian vault does not exist: ${vaultPath}`);
    return this.#write(async () => {
      const stored = await this.#load();
      const installedVaults = await this.integration();
      if (!installedVaults.vaults.some((item) => item.path === vault))
        throw new Error("The Obsidian vault must be added before it can be linked");
      const target = await this.#resolveTarget(vault, relativeTarget ?? "");
      const link = { workspace_id: workspaceId, vault_path: vault, target_path: target };
      stored.workspace_links = { ...(stored.workspace_links ?? {}), [workspaceId]: link };
      await this.#save(stored);
      return link;
    });
  }

  async unlinkWorkspace(workspaceId: string) {
    await this.#write(async () => {
      const stored = await this.#load();
      delete stored.workspace_links?.[workspaceId];
      await this.#save(stored);
    });
  }

  async openApp() {
    await this.#openUri("obsidian://open");
  }

  async openWorkspace(workspaceId: string) {
    const link = (await this.#load()).workspace_links?.[workspaceId];
    if (!link) throw new Error("The workspace is not linked to Obsidian");
    const [target, vault] = await Promise.all([
      fs.realpath(link.target_path).catch(() => {
        throw new Error("The linked Obsidian target no longer exists");
      }),
      fs.realpath(link.vault_path).catch(() => {
        throw new Error("The linked Obsidian vault no longer exists");
      }),
    ]);
    if (!this.#inside(target, vault))
      throw new Error("The linked target is outside its Obsidian vault");
    await this.#openUri(`obsidian://open?path=${encodeURIComponent(target)}`);
  }

  async #load(): Promise<StoredIntegration> {
    const file = path.join(this.dataDir, "obsidian-integration.json");
    try {
      const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("invalid document");
      const record = value as Record<string, unknown>;
      return {
        manual_vaults: Array.isArray(record.manual_vaults)
          ? record.manual_vaults.filter((item): item is string => typeof item === "string")
          : [],
        workspace_links:
          record.workspace_links &&
          typeof record.workspace_links === "object" &&
          !Array.isArray(record.workspace_links)
            ? (record.workspace_links as Record<string, WorkspaceLink>)
            : {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(
        `Failed to parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #save(value: StoredIntegration) {
    await fs.mkdir(this.dataDir, { recursive: true });
    const target = path.join(this.dataDir, "obsidian-integration.json");
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async #validateVault(value: string): Promise<string | null> {
    try {
      const canonical = await fs.realpath(value);
      const stat = await fs.stat(canonical);
      return stat.isDirectory() &&
        (await fs.stat(path.join(canonical, ".obsidian")).catch(() => null))?.isDirectory()
        ? canonical
        : null;
    } catch {
      return null;
    }
  }

  async #resolveTarget(vault: string, value: string) {
    const relative = value.trim();
    if (!relative) return vault;
    const parts = relative.split(/[\\/]/);
    if (path.isAbsolute(relative) || parts.some((part) => part === ".." || part === ""))
      throw new Error("The linked path must be relative to the Obsidian vault");
    const target = await fs.realpath(path.resolve(vault, relative)).catch(() => {
      throw new Error(`The linked Obsidian path does not exist: ${relative}`);
    });
    if (!this.#inside(target, vault))
      throw new Error("The linked path is outside the Obsidian vault");
    return target;
  }

  #inside(value: string, root: string) {
    const relative = path.relative(root, value);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
  }

  async #discoverVaults(): Promise<Vault[]> {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    const registry = isMac
      ? home && path.join(home, "Library/Application Support/obsidian/obsidian.json")
      : isWindows
        ? path.join(
            process.env.APPDATA ?? path.join(home ?? "", "AppData/Roaming"),
            "obsidian/obsidian.json",
          )
        : path.join(
            process.env.XDG_CONFIG_HOME ?? path.join(home ?? "", ".config"),
            "obsidian/obsidian.json",
          );
    if (!registry) return [];
    let content: { vaults?: Record<string, { path?: unknown; ts?: unknown }> };
    try {
      content = JSON.parse(await fs.readFile(registry, "utf8")) as typeof content;
    } catch {
      return [];
    }
    const result: Vault[] = [];
    for (const entry of Object.values(content.vaults ?? {})) {
      if (typeof entry.path !== "string") continue;
      const vault = await this.#validateVault(entry.path);
      if (vault)
        result.push(
          this.#vault(vault, "discovered", typeof entry.ts === "number" ? entry.ts : null),
        );
    }
    return result;
  }

  #vault(vaultPath: string, source: VaultSource, lastOpenedAt: number | null): Vault {
    return {
      path: vaultPath,
      name: path.basename(vaultPath) || "Obsidian Vault",
      source,
      last_opened_at: lastOpenedAt,
    };
  }

  async #installation() {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    const candidates = isMac
      ? [
          "/Applications/Obsidian.app",
          ...(home ? [path.join(home, "Applications/Obsidian.app")] : []),
        ]
      : isWindows
        ? [
            ...(process.env.LOCALAPPDATA
              ? [
                  path.join(process.env.LOCALAPPDATA, "Obsidian/Obsidian.exe"),
                  path.join(process.env.LOCALAPPDATA, "Programs/Obsidian/Obsidian.exe"),
                ]
              : []),
            ...(process.env.ProgramFiles
              ? [path.join(process.env.ProgramFiles, "Obsidian/Obsidian.exe")]
              : []),
            ...(process.env["ProgramFiles(x86)"]
              ? [path.join(process.env["ProgramFiles(x86)"], "Obsidian/Obsidian.exe")]
              : []),
          ]
        : [
            "/usr/bin/obsidian",
            "/usr/local/bin/obsidian",
            "/opt/Obsidian/obsidian",
            "/opt/Obsidian/Obsidian",
            "/usr/share/obsidian/obsidian",
            ...(home ? [path.join(home, ".local/bin/obsidian")] : []),
          ];
    if (isMac) {
      const search = await this.#capture("mdfind", ["kMDItemCFBundleIdentifier == 'md.obsidian'"]);
      candidates.push(...search.split(/\r?\n/).filter(Boolean));
    }
    if (isLinux) {
      const executable = resolveCommand("obsidian");
      if (executable) candidates.push(executable);
      if (home) {
        const applications = path.join(home, "Applications");
        const items = await fs.readdir(applications).catch(() => []);
        candidates.push(
          ...items
            .filter((item) => /obsidian.*\.appimage$/i.test(item))
            .map((item) => path.join(applications, item)),
        );
      }
    }
    const appPath =
      (
        await Promise.all(
          candidates.map(async (candidate) =>
            (await fs.stat(candidate).catch(() => null)) ? candidate : null,
          ),
        )
      ).find(Boolean) ?? null;
    const cli =
      Boolean(resolveCommand("obsidian")) ||
      Boolean(resolveCommand("obsidian.exe")) ||
      Boolean(resolveCommand("obsidian.cmd")) ||
      Boolean(resolveCommand("obsidian.bat"));
    const version =
      isMac && appPath
        ? (
            await this.#capture("plutil", [
              "-extract",
              "CFBundleShortVersionString",
              "raw",
              "-o",
              "-",
              path.join(appPath, "Contents/Info.plist"),
            ])
          ).trim() || null
        : null;
    return {
      installed: appPath !== null,
      app_path: appPath,
      version,
      cli_available: cli,
    };
  }

  async #capture(command: string, args: string[]) {
    return new Promise<string>((resolve) => {
      let output = "";
      const child = spawn(command, args, {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      const timer = setTimeout(() => child.kill(), 2_000);
      child.stdout.on("data", (chunk: Buffer) => {
        if (output.length < 32_768) output += chunk.toString("utf8");
      });
      child.once("error", () => {
        clearTimeout(timer);
        resolve("");
      });
      child.once("close", () => {
        clearTimeout(timer);
        resolve(output);
      });
    });
  }

  async #openUri(uri: string) {
    const command = isMac ? "open" : isWindows ? "explorer.exe" : "xdg-open";
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, [uri], { stdio: "ignore", windowsHide: true });
      child.once("error", reject);
      child.once("spawn", () => resolve());
    });
  }
}
