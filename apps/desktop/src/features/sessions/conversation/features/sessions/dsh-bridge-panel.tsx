import { useEffect, useState } from "react";
import { desktopApi } from "@/core/desktop";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useSession } from "./session-context";
import type { SupportedLocale as Locale } from "@/core/types";

type DshBridgeStatus = {
  supported?: boolean;
  listening?: boolean;
  reason?: string;
  pluginVersion?: string;
  pluginDirectory?: string;
  installInstructions?: string;
  runtimes?: {
    runtimeId: string;
    dshVersion: string;
    compatibility: "verified" | "unverified" | "unknown" | "too-old" | "invalid";
    sessionController: boolean;
    sessions: number;
    managed?: boolean;
    running?: number;
  }[];
  /** Starting DSH in the background; absent from a Runtime without it. */
  autoStart?: {
    enabled: boolean;
    available: boolean;
    reason?: string;
    phase: "stopped" | "starting" | "running" | "stopping";
    failure: string | null;
  } | null;
};

const copy: Record<
  Locale,
  {
    title: string;
    connected: (count: number) => string;
    none: string;
    startsWhenNeeded: string;
    noLauncher: string;
    versionUnsupported: string;
    startFailed: string;
    version: (version: string) => string;
    background: string;
    readOnly: string;
    autoStart: string;
    autoStartHint: string;
    desktop: string;
    copyDirectory: string;
    restart: string;
    cli: string;
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
    startsWhenNeeded: "DeepSeek Harness 没有运行，需要时 AgentKib 会在后台启动它。",
    noLauncher:
      "没有找到 DeepSeek Harness。安装 DeepSeek Harness Desktop 后，AgentKib 能在需要时启动它。",
    versionUnsupported: "这个版本的 DeepSeek Harness 还不能由 AgentKib 启动，请更新 AgentKib。",
    startFailed: "上次在后台启动 DeepSeek Harness 没有成功。",
    version: (version) => `版本 ${version}`,
    background: "由 AgentKib 在后台启动",
    readOnly: "这个配置只能查看，不能从这里发送",
    autoStart: "需要时自动启动 DeepSeek Harness",
    autoStartHint:
      "没开 DeepSeek Harness 时，在后台启动它，空闲 3 分钟后关闭，退出 AgentKib 时一并关闭。",
    desktop:
      "想在 DeepSeek Harness Desktop 开着时也从这里继续会话，在 Desktop 的“添加插件”里粘贴这个目录（只需一次），然后重启 Desktop：",
    copyDirectory: "复制目录",
    restart: "安装后重启 DeepSeek Harness 才会生效。",
    cli: "使用命令行的 DeepSeek Harness：",
    copy: "复制命令",
    copied: "已复制",
    unsupported: "当前只支持 macOS。",
    unavailable: "AgentKib 的连接服务没有启动。",
  },
  "zh-TW": {
    title: "DeepSeek Harness 連線",
    connected: (count) => `已連線 ${count} 個正在執行的 DeepSeek Harness`,
    none: "沒有連線到正在執行的 DeepSeek Harness。安裝 AgentKib 外掛並重新啟動 DeepSeek Harness 後會自動連線。",
    startsWhenNeeded: "DeepSeek Harness 沒有在執行，需要時 AgentKib 會在背景啟動它。",
    noLauncher:
      "找不到 DeepSeek Harness。安裝 DeepSeek Harness Desktop 後，AgentKib 能在需要時啟動它。",
    versionUnsupported: "這個版本的 DeepSeek Harness 還不能由 AgentKib 啟動，請更新 AgentKib。",
    startFailed: "上次在背景啟動 DeepSeek Harness 沒有成功。",
    version: (version) => `版本 ${version}`,
    background: "由 AgentKib 在背景啟動",
    readOnly: "這個設定只能檢視，不能從這裡傳送",
    autoStart: "需要時自動啟動 DeepSeek Harness",
    autoStartHint:
      "沒開 DeepSeek Harness 時，在背景啟動它，閒置 3 分鐘後關閉，結束 AgentKib 時一併關閉。",
    desktop:
      "想在 DeepSeek Harness Desktop 開著時也從這裡繼續對話，在 Desktop 的「添加插件」裡貼上這個目錄（只需一次），然後重新啟動 Desktop：",
    copyDirectory: "複製目錄",
    restart: "安裝後重新啟動 DeepSeek Harness 才會生效。",
    cli: "使用命令列的 DeepSeek Harness：",
    copy: "複製指令",
    copied: "已複製",
    unsupported: "目前只支援 macOS。",
    unavailable: "AgentKib 的連線服務沒有啟動。",
  },
  "ja-JP": {
    title: "DeepSeek Harness の接続",
    connected: (count) => `実行中の DeepSeek Harness ${count} 件に接続済み`,
    none: "実行中の DeepSeek Harness に接続していません。AgentKib プラグインを入れて DeepSeek Harness を再起動すると自動で接続します。",
    startsWhenNeeded:
      "DeepSeek Harness は起動していません。必要なときに AgentKib がバックグラウンドで起動します。",
    noLauncher:
      "DeepSeek Harness が見つかりません。DeepSeek Harness Desktop を入れると、必要なときに AgentKib が起動できます。",
    versionUnsupported:
      "このバージョンの DeepSeek Harness はまだ AgentKib から起動できません。AgentKib を更新してください。",
    startFailed: "前回、DeepSeek Harness をバックグラウンドで起動できませんでした。",
    version: (version) => `バージョン ${version}`,
    background: "AgentKib がバックグラウンドで起動",
    readOnly: "このプロファイルは表示のみで、ここからは送信できません",
    autoStart: "必要なときに DeepSeek Harness を自動で起動",
    autoStartHint:
      "DeepSeek Harness が開いていないときはバックグラウンドで起動し、3 分間使われなければ終了します。AgentKib を終了すると一緒に終了します。",
    desktop:
      "DeepSeek Harness Desktop を開いている間もここから会話を続けるには、Desktop の「プラグインを追加」にこのディレクトリを貼り付け（初回のみ）、Desktop を再起動します：",
    copyDirectory: "ディレクトリをコピー",
    restart: "インストール後、DeepSeek Harness を再起動すると有効になります。",
    cli: "コマンドラインの DeepSeek Harness：",
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
    startsWhenNeeded:
      "DeepSeek Harness is not running. AgentKib starts it in the background when needed.",
    noLauncher:
      "DeepSeek Harness was not found. With DeepSeek Harness Desktop installed, AgentKib can start it when needed.",
    versionUnsupported:
      "AgentKib cannot start this version of DeepSeek Harness yet. Update AgentKib.",
    startFailed: "The last background start of DeepSeek Harness did not succeed.",
    version: (version) => `Version ${version}`,
    background: "Started by AgentKib in the background",
    readOnly: "This profile can be viewed but cannot take messages from here",
    autoStart: "Start DeepSeek Harness when needed",
    autoStartHint:
      "When DeepSeek Harness is not open, AgentKib starts it in the background, closes it after 3 idle minutes, and closes it when you quit AgentKib.",
    desktop:
      "To continue sessions from here while DeepSeek Harness Desktop is open, paste this directory into Desktop's “Add plugin” (once), then restart Desktop:",
    copyDirectory: "Copy directory",
    restart: "Restart DeepSeek Harness afterwards for it to take effect.",
    cli: "For the DeepSeek Harness command line:",
    copy: "Copy command",
    copied: "Copied",
    unsupported: "Only macOS is supported for now.",
    unavailable: "AgentKib's connection service is not running.",
  },
};

/**
 * Status and settings of the per-computer DeepSeek Harness connection: whether AgentKib starts DSH
 * in the background, and how to install the plugin into a DSH the user runs. Never installs.
 */
export function DshBridgePanel() {
  const { locale } = useSession();
  const text = copy[locale] ?? copy["en-US"];
  const [status, setStatus] = useState<DshBridgeStatus>();
  const [copied, setCopied] = useState<"directory" | "command">();
  const [switching, setSwitching] = useState(false);
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
    const timer = setTimeout(() => setCopied(undefined), 3000);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!status) return null;
  const runtimes = status.runtimes ?? [];
  const command = status.installInstructions?.split("\n").find((line) => !line.startsWith("#"));
  const autoStart = status.autoStart;
  const toggle = (enabled: boolean) => {
    setSwitching(true);
    void desktopApi()
      .claude.request({ operation: "dsh-auto-start", enabled })
      .then(
        (value) => setStatus(value as DshBridgeStatus),
        () => undefined,
      )
      .finally(() => setSwitching(false));
  };
  const write = (value: string, what: "directory" | "command") =>
    void navigator.clipboard.writeText(value).then(
      () => setCopied(what),
      () => undefined,
    );
  // What happens when nothing of the user's runs: the background start, or why it cannot.
  const offline = !autoStart?.enabled
    ? text.none
    : autoStart.available
      ? autoStart.failure && autoStart.failure !== "dsh-exited"
        ? text.startFailed
        : text.startsWhenNeeded
      : autoStart.reason === "dsh-version-unsupported"
        ? text.versionUnsupported
        : text.noLauncher;
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
              {runtime.managed && ` · ${text.background}`}
              {!runtime.sessionController && ` · ${text.readOnly}`}
            </p>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground">{offline}</p>
      )}
      {status.supported !== false && autoStart && (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-0.5">
            <p>{text.autoStart}</p>
            <p className="text-xs leading-5 text-muted-foreground">{text.autoStartHint}</p>
          </div>
          <Switch
            checked={autoStart.enabled}
            disabled={switching}
            aria-label={text.autoStart}
            onCheckedChange={toggle}
          />
        </div>
      )}
      {status.supported !== false && status.pluginDirectory && (
        <div className="space-y-2">
          <p className="text-xs leading-5 text-muted-foreground">{text.desktop}</p>
          <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 text-xs">
            {status.pluginDirectory}
          </pre>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => write(status.pluginDirectory!, "directory")}
          >
            {copied === "directory" ? text.copied : text.copyDirectory}
          </Button>
        </div>
      )}
      {status.supported !== false && command && (
        <div className="space-y-2">
          <p className="text-xs leading-5 text-muted-foreground">{text.cli}</p>
          <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 text-xs">{command}</pre>
          <p className="text-xs leading-5 text-muted-foreground">{text.restart}</p>
          <Button variant="outline" className="min-h-11" onClick={() => write(command, "command")}>
            {copied === "command" ? text.copied : text.copy}
          </Button>
        </div>
      )}
    </section>
  );
}
