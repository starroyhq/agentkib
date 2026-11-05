import { useEffect, useState } from "react";
import { desktopApi } from "@/core/desktop";
import { Button } from "@/components/ui/button";
import { useSession } from "./session-context";
import type { SupportedLocale as Locale } from "@/core/types";

type DshBridgeStatus = {
  supported?: boolean;
  listening?: boolean;
  reason?: string;
  pluginVersion?: string;
  installInstructions?: string;
  runtimes?: {
    runtimeId: string;
    dshVersion: string;
    compatibility: "verified" | "unverified" | "unknown" | "too-old" | "invalid";
    sessionController: boolean;
    sessions: number;
  }[];
};

const copy: Record<
  Locale,
  {
    title: string;
    connected: (count: number) => string;
    none: string;
    version: (version: string) => string;
    unverified: string;
    readOnly: string;
    install: string;
    restart: string;
    copy: string;
    copied: string;
    unsupported: string;
    unavailable: string;
  }
> = {
  "zh-CN": {
    title: "DeepSeek Harness 连接",
    connected: (count) => `已连接 ${count} 个正在运行的 DeepSeek Harness`,
    none: "没有连接到正在运行的 DeepSeek Harness。装好 AgentKib 插件并重启 DeepSeek Harness 后会自动连接。",
    version: (version) => `版本 ${version}`,
    unverified: "这个版本还没有验证过，部分功能可能不完整",
    readOnly: "这个配置只能查看，不能从这里发送",
    install: "在你运行的 profile 中安装插件（只需一次）：",
    restart:
      "安装后重启 DeepSeek Harness 才会生效。DeepSeek Harness Desktop 请在它自己的插件页面安装。",
    copy: "复制命令",
    copied: "已复制",
    unsupported: "当前只支持 macOS。",
    unavailable: "AgentKib 的连接服务没有启动。",
  },
  "zh-TW": {
    title: "DeepSeek Harness 連線",
    connected: (count) => `已連線 ${count} 個正在執行的 DeepSeek Harness`,
    none: "沒有連線到正在執行的 DeepSeek Harness。安裝 AgentKib 外掛並重新啟動 DeepSeek Harness 後會自動連線。",
    version: (version) => `版本 ${version}`,
    unverified: "這個版本還沒有驗證過，部分功能可能不完整",
    readOnly: "這個設定只能檢視，不能從這裡傳送",
    install: "在你執行的 profile 中安裝外掛（只需一次）：",
    restart:
      "安裝後重新啟動 DeepSeek Harness 才會生效。DeepSeek Harness Desktop 請在它自己的外掛頁面安裝。",
    copy: "複製指令",
    copied: "已複製",
    unsupported: "目前只支援 macOS。",
    unavailable: "AgentKib 的連線服務沒有啟動。",
  },
  "ja-JP": {
    title: "DeepSeek Harness の接続",
    connected: (count) => `実行中の DeepSeek Harness ${count} 件に接続済み`,
    none: "実行中の DeepSeek Harness に接続していません。AgentKib プラグインを入れて DeepSeek Harness を再起動すると自動で接続します。",
    version: (version) => `バージョン ${version}`,
    unverified: "このバージョンは未検証のため、一部の機能が不完全な場合があります",
    readOnly: "このプロファイルは表示のみで、ここからは送信できません",
    install: "使用中のプロファイルにプラグインを入れます（初回のみ）：",
    restart:
      "インストール後、DeepSeek Harness を再起動すると有効になります。DeepSeek Harness Desktop では専用のプラグイン画面から入れてください。",
    copy: "コマンドをコピー",
    copied: "コピーしました",
    unsupported: "現在は macOS のみ対応しています。",
    unavailable: "AgentKib の接続サービスが起動していません。",
  },
  "en-US": {
    title: "DeepSeek Harness connection",
    connected: (count) =>
      `Connected to ${count} running DeepSeek Harness ${count === 1 ? "instance" : "instances"}`,
    none: "No running DeepSeek Harness is connected. Install the AgentKib plugin and restart DeepSeek Harness; it then connects by itself.",
    version: (version) => `Version ${version}`,
    unverified: "This version has not been verified yet; some features may be incomplete",
    readOnly: "This profile can be viewed but cannot take messages from here",
    install: "Install the plugin in the profile you run (once):",
    restart:
      "Restart DeepSeek Harness afterwards for it to take effect. For DeepSeek Harness Desktop, install it from its own plugin page.",
    copy: "Copy command",
    copied: "Copied",
    unsupported: "Only macOS is supported for now.",
    unavailable: "AgentKib's connection service is not running.",
  },
};

/** Status and install steps for the per-computer DeepSeek Harness connection. Never installs anything. */
export function DshBridgePanel() {
  const { locale } = useSession();
  const text = copy[locale] ?? copy["en-US"];
  const [status, setStatus] = useState<DshBridgeStatus>();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let current = true;
    const read = () =>
      void desktopApi()
        .claude.request({ operation: "dsh-bridge-status" })
        .then(
          (value) => current && setStatus(value as DshBridgeStatus),
          (error: unknown) => {
            if (!current) return;
            // The host turns reads away while a control runs; that says nothing about the bridge,
            // so the last status stays until the next read.
            if (String(error).includes("operation_busy"))
              setStatus((previous) => previous ?? { reason: "dsh-bridge-unavailable" });
            else setStatus({ reason: "dsh-bridge-unavailable" });
          },
        );
    read();
    const timer = setInterval(read, 5000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 3000);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!status) return null;
  const runtimes = status.runtimes ?? [];
  const command = status.installInstructions?.split("\n").find((line) => !line.startsWith("#"));
  return (
    <section className="space-y-3 border-t pt-4 text-sm" aria-label={text.title}>
      <h3 className="font-medium">{text.title}</h3>
      {status.supported === false ? (
        <p className="text-muted-foreground">{text.unsupported}</p>
      ) : status.reason === "dsh-bridge-unavailable" ? (
        <p className="text-muted-foreground">{text.unavailable}</p>
      ) : runtimes.length ? (
        <div className="space-y-1">
          <p>{text.connected(runtimes.length)}</p>
          {runtimes.map((runtime) => (
            <p key={runtime.runtimeId} className="text-xs leading-5 text-muted-foreground">
              {text.version(runtime.dshVersion)}
              {runtime.compatibility !== "verified" && ` · ${text.unverified}`}
              {!runtime.sessionController && ` · ${text.readOnly}`}
            </p>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground">{text.none}</p>
      )}
      {status.supported !== false && command && (
        <div className="space-y-2">
          <p className="text-xs leading-5 text-muted-foreground">{text.install}</p>
          <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 text-xs">{command}</pre>
          <p className="text-xs leading-5 text-muted-foreground">{text.restart}</p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() =>
              void navigator.clipboard.writeText(command).then(
                () => setCopied(true),
                () => undefined,
              )
            }
          >
            {copied ? text.copied : text.copy}
          </Button>
        </div>
      )}
    </section>
  );
}
