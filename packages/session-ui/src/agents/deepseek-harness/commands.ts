import { dshMenuCommands, parseClaudeSlashCommand } from "@agentkib/web-client";
import {
  commandLocale,
  findCommandEntry,
  type CommandRegistration,
  type SlashCommandOption,
} from "../session-commands";

const copy = {
  "zh-CN": {
    dshLabel: "DeepSeek Harness 命令",
  },
  "zh-Hant": {
    dshLabel: "DeepSeek Harness 指令",
  },
  "en-US": {
    dshLabel: "DeepSeek Harness commands",
  },
  "ja-JP": {
    dshLabel: "DeepSeek Harness のコマンド",
  },
};

export function dshCommandCopy(locale: string) {
  return copy[commandLocale(locale)];
}

/**
 * Menu options for a DeepSeek Harness session: DSH runs its own commands, so they keep DSH's
 * descriptions. Composers pass runtime-protocol's `dshMenuCommands` for the device.
 */
export function dshSlashOptions(
  commands: readonly { name: string; description?: string; argumentHint?: string }[],
): SlashCommandOption[] {
  return commands.map((command) => ({ ...command, aliases: [] }));
}

export const dshCommands: CommandRegistration = {
  source: "reported",
  connection: "plugin-bridge",
  copy: (locale) => ({ label: dshCommandCopy(locale).dshLabel }),
  configure({ menu, legacy, owner, canReadNativeCommands }) {
    const entries = menu?.state === "ready" ? menu.entries : [];
    const native = entries.filter(
      (entry) => entry.run.kind === "native" && dshMenuCommands([entry], owner.full).length > 0,
    );
    const options = menu
      ? native.map((entry) => ({
          name: entry.name,
          description: entry.description,
          argumentHint: entry.argumentHint,
          aliases: [...(entry.aliases ?? [])],
        }))
      : dshSlashOptions(dshMenuCommands(legacy ?? [], owner.full));
    return {
      options: canReadNativeCommands ? options.map((option) => ({ ...option, native: true })) : [],
      parse(text) {
        const parsed = parseClaudeSlashCommand(text);
        if (!parsed) return null;
        const match = menu
          ? findCommandEntry(native, parsed.name)
          : options.find((item) => item.name === parsed.name);
        return match ? { kind: "native", command: match.name, args: parsed.args } : null;
      },
    };
  },
};
