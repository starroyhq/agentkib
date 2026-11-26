import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import type { InteractionLocale as Locale } from "../../interaction-model";
import { useSessionPlatform, type SessionPlatform } from "../../session-platform";
import { LoadingSkeleton } from "../../loading-feedback";
import {
  CopyField,
  OperationCopy,
  OperationDisclosure,
  OperationGroup,
  OperationRow,
} from "../../conversation/sessions/operation-layout";

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
  /** Launcher status, absent when the Runtime does not manage DSH. */
  autoStart?: {
    available: boolean;
    reason?: string;
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
    install: string;
    desktop: string;
    copyDirectory: string;
    restart: string;
    cli: string;
    copy: string;
    copied: string;
    unsupported: string;
    unavailable: string;
    loading: string;
    installUnavailable: string;
  }
> = {
  "zh-CN": {
    title: "DeepSeek Harness 连接",
    connected: (count) => `已连接 ${count} 个正在运行的 DeepSeek Harness`,
    none: "没有连接到正在运行的 DeepSeek Harness。装好 AgentKib 插件并重启 DeepSeek Harness 后会自动连接。",
    startsWhenNeeded: "DeepSeek Harness 没有运行，需要时 AgentKib 会在后台启动它。",
    noLauncher:
      "没有找到 DeepSeek Harness。安装 DeepSeek Harness Desktop 后，AgentKib 能在需要时启动它。",
    versionUnsupported:
      "这个版本的 DeepSeek Harness 不能由 AgentKib 启动，请更新 DeepSeek Harness 或 AgentKib。",
    startFailed: "上次在后台启动 DeepSeek Harness 没有成功。",
    version: (version) => `版本 ${version}`,
    background: "由 AgentKib 在后台启动",
    readOnly: "这个配置只能查看，不能从这里发送",
    install: "安装 AgentKib 插件",
    desktop:
      "想在 DeepSeek Harness Desktop 开着时也从这里继续会话，在 Desktop 的“添加插件”里粘贴这个目录（只需一次），然后重启 Desktop：",
    copyDirectory: "复制目录",
    restart: "安装后重启 DeepSeek Harness 才会生效。",
    cli: "使用命令行的 DeepSeek Harness：",
    copy: "复制命令",
    copied: "已复制",
    unsupported: "当前只支持 macOS。",
    unavailable: "AgentKib 的连接服务没有启动。",
    loading: "正在读取连接状态。",
    installUnavailable: "当前运行时未提供插件安装信息。",
  },
  "zh-Hant": {
    title: "DeepSeek Harness 連線",
    connected: (count) => `已連線 ${count} 個正在執行的 DeepSeek Harness`,
    none: "沒有連線到正在執行的 DeepSeek Harness。安裝 AgentKib 外掛並重新啟動 DeepSeek Harness 後會自動連線。",
    startsWhenNeeded: "DeepSeek Harness 沒有在執行，需要時 AgentKib 會在背景啟動它。",
    noLauncher:
      "找不到 DeepSeek Harness。安裝 DeepSeek Harness Desktop 後，AgentKib 能在需要時啟動它。",
    versionUnsupported:
      "這個版本的 DeepSeek Harness 不能由 AgentKib 啟動，請更新 DeepSeek Harness 或 AgentKib。",
    startFailed: "上次在背景啟動 DeepSeek Harness 沒有成功。",
    version: (version) => `版本 ${version}`,
    background: "由 AgentKib 在背景啟動",
    readOnly: "這個設定只能檢視，不能從這裡傳送",
    install: "安裝 AgentKib 外掛",
    desktop:
      "想在 DeepSeek Harness Desktop 開著時也從這裡繼續對話，在 Desktop 的「添加插件」裡貼上這個目錄（只需一次），然後重新啟動 Desktop：",
    copyDirectory: "複製目錄",
    restart: "安裝後重新啟動 DeepSeek Harness 才會生效。",
    cli: "使用命令列的 DeepSeek Harness：",
    copy: "複製指令",
    copied: "已複製",
    unsupported: "目前只支援 macOS。",
    unavailable: "AgentKib 的連線服務沒有啟動。",
    loading: "正在讀取連線狀態。",
    installUnavailable: "目前的執行環境未提供外掛安裝資訊。",
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
      "このバージョンの DeepSeek Harness は AgentKib から起動できません。DeepSeek Harness か AgentKib を更新してください。",
    startFailed: "前回、DeepSeek Harness をバックグラウンドで起動できませんでした。",
    version: (version) => `バージョン ${version}`,
    background: "AgentKib がバックグラウンドで起動",
    readOnly: "このプロファイルは表示のみで、ここからは送信できません",
    install: "AgentKib プラグインを入れる",
    desktop:
      "DeepSeek Harness Desktop を開いている間もここから会話を続けるには、Desktop の「プラグインを追加」にこのディレクトリを貼り付け（初回のみ）、Desktop を再起動します：",
    copyDirectory: "ディレクトリをコピー",
    restart: "インストール後、DeepSeek Harness を再起動すると有効になります。",
    cli: "コマンドラインの DeepSeek Harness：",
    copy: "コマンドをコピー",
    copied: "コピーしました",
    unsupported: "現在は macOS のみ対応しています。",
    unavailable: "AgentKib の接続サービスが起動していません。",
    loading: "接続状態を読み込んでいます。",
    installUnavailable: "現在のランタイムではプラグインのインストール情報を取得できません。",
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
      "AgentKib cannot start this version of DeepSeek Harness. Update DeepSeek Harness or AgentKib.",
    startFailed: "The last background start of DeepSeek Harness did not succeed.",
    version: (version) => `Version ${version}`,
    background: "Started by AgentKib in the background",
    readOnly: "This profile can be viewed but cannot take messages from here",
    install: "Install the AgentKib plugin",
    desktop:
      "To continue sessions from here while DeepSeek Harness Desktop is open, paste this directory into Desktop's “Add plugin” (once), then restart Desktop:",
    copyDirectory: "Copy directory",
    restart: "Restart DeepSeek Harness afterwards for it to take effect.",
    cli: "For the DeepSeek Harness command line:",
    copy: "Copy command",
    copied: "Copied",
    unsupported: "Only macOS is supported for now.",
    unavailable: "AgentKib's connection service is not running.",
    loading: "Reading connection status.",
    installUnavailable: "The current runtime does not provide plugin installation details.",
  },
};

function InstallCopyField({
  value,
  label,
  copiedLabel,
  disabledReason,
}: {
  value: string;
  label: string;
  copiedLabel: string;
  disabledReason?: string;
}) {
  const {
    components: { Button },
  } = useSessionPlatform();
  if (!disabledReason) return <CopyField value={value} label={label} copiedLabel={copiedLabel} />;
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-lg border border-border/70 bg-muted/40 py-1 pr-1 pl-3">
      {value ? (
        <code className="min-w-0 flex-1 truncate font-mono text-xs" title={value}>
          {value}
        </code>
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{label}</span>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        className="disabled:pointer-events-auto"
        aria-label={label}
        title={disabledReason}
        disabled
      >
        <Copy aria-hidden />
      </Button>
    </div>
  );
}

/** Shows connection status and instructions for installing the plugin into a DSH the user runs. */
export function DshBridgePanel({
  locale,
  unavailableReason,
}: {
  locale: Locale;
  unavailableReason?: string;
}) {
  const { desktop } = useSessionPlatform();
  return desktop ? (
    <DshBridgeStatusPanel desktop={desktop} locale={locale} unavailableReason={unavailableReason} />
  ) : null;
}

function DshBridgeStatusPanel({
  desktop,
  locale,
  unavailableReason,
}: {
  desktop: NonNullable<SessionPlatform["desktop"]>;
  locale: Locale;
  unavailableReason?: string;
}) {
  const { requestBridge } = desktop;
  const text = copy[locale] ?? copy["en-US"];
  const [observed, setStatus] = useState<DshBridgeStatus>();
  const status = unavailableReason ? undefined : observed;
  useEffect(() => {
    if (unavailableReason) return;
    let current = true;
    const read = () =>
      void requestBridge({ operation: "dsh-bridge-status" }).then(
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
  }, [requestBridge, unavailableReason]);
  const runtimes = status?.runtimes ?? [];
  const directory = status?.pluginDirectory ?? "";
  const command =
    status?.installInstructions?.split("\n").find((line) => line.trim() && !line.startsWith("#")) ??
    "";
  const autoStart = status?.autoStart;
  const bridgeReason =
    unavailableReason ??
    (!status
      ? text.loading
      : status.supported === false
        ? text.unsupported
        : status.reason === "dsh-bridge-unavailable"
          ? text.unavailable
          : undefined);
  const directoryReason = bridgeReason ?? (!directory ? text.installUnavailable : undefined);
  const commandReason = bridgeReason ?? (!command ? text.installUnavailable : undefined);
  // What happens when nothing of the user's runs: the background start, or why it cannot.
  const offline = !autoStart
    ? text.none
    : autoStart.available
      ? autoStart.failure && autoStart.failure !== "dsh-exited"
        ? text.startFailed
        : text.startsWhenNeeded
      : autoStart.reason === "dsh-version-unsupported"
        ? text.versionUnsupported
        : text.noLauncher;
  // Installing matters when nothing is connected and AgentKib cannot start DSH itself; otherwise
  // the steps stay folded.
  const canInstall = !directoryReason || !commandReason;
  const installFirst = canInstall && !runtimes.length && !autoStart?.available;
  return (
    <OperationGroup title={text.title}>
      {!status && !unavailableReason && (
        <LoadingSkeleton label={text.loading} layout="list" rows={2} />
      )}
      {!bridgeReason && (
        <OperationRow>
          {runtimes.length ? (
            <OperationCopy
              title={
                <span className="flex items-center gap-2">
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-emerald-500"
                    aria-hidden="true"
                  />
                  <span className="truncate">{text.connected(runtimes.length)}</span>
                </span>
              }
            >
              {runtimes.map((runtime) => (
                <p key={runtime.runtimeId}>
                  {text.version(runtime.dshVersion)}
                  {runtime.managed && ` · ${text.background}`}
                  {!runtime.sessionController && ` · ${text.readOnly}`}
                </p>
              ))}
            </OperationCopy>
          ) : (
            <p className="text-muted-foreground">{offline}</p>
          )}
        </OperationRow>
      )}
      <OperationDisclosure key={String(canInstall)} title={text.install} defaultOpen={installFirst}>
        <div className="grid gap-1.5">
          {!directoryReason && (
            <p className="text-xs leading-5 text-muted-foreground">{text.desktop}</p>
          )}
          <InstallCopyField
            value={directory}
            label={text.copyDirectory}
            copiedLabel={text.copied}
            disabledReason={directoryReason}
          />
        </div>
        <div className="grid gap-1.5">
          {!commandReason && <p className="text-xs leading-5 text-muted-foreground">{text.cli}</p>}
          <InstallCopyField
            value={command}
            label={text.copy}
            copiedLabel={text.copied}
            disabledReason={commandReason}
          />
          {!commandReason && (
            <p className="text-xs leading-5 text-muted-foreground">{text.restart}</p>
          )}
        </div>
      </OperationDisclosure>
    </OperationGroup>
  );
}
