import { Link } from "@tanstack/react-router";
import { Monitor, Smartphone, ShieldCheck, ArrowRight } from "lucide-react";
import { ConnectionPreferences } from "./connection-preferences";
import { useAppearance } from "@/features/conversation/features/preferences/use-appearance";
import { useEnvironment } from "@/providers/environment";
import type { Locale } from "@/features/conversation/i18n";

export const hostedCopy: Record<
  Locale,
  {
    title: string;
    intro: string;
    steps: string[];
    note: string;
    other: string;
    lan: string;
    lanNote: string;
    account: string;
    accountNote: string;
  }
> = {
  "zh-CN": {
    title: "连接你的电脑",
    account: "登录并选择电脑",
    accountNote: "查看账号下的电脑。新浏览器首次连接仍需电脑上的 AgentKib 显示的授权码。",
    intro: "从电脑上的 AgentKib 开始，在手机上继续查看会话、处理请求和浏览产物。",
    steps: [
      "在电脑上的 AgentKib 打开“设置 → 远程连接 → 手机”，登录账号并开启远程访问。",
      "连接就绪后，用手机扫描电脑上的 AgentKib 显示的配对二维码。",
      "输入电脑上的 AgentKib 显示的授权码，即可使用全部工作区和已支持的远程控制功能。",
    ],
    note: "电脑需要保持开机且 AgentKib 正在运行。连接地址由电脑提供，此页面不接收配对码。",
    other: "其他连接方式",
    lan: "局域网连接",
    lanNote: "已在电脑上的 AgentKib 启用“局域网直连”？同一网络下可使用此入口。",
  },
  "zh-TW": {
    title: "連接你的電腦",
    account: "登入並選擇電腦",
    accountNote: "查看帳號下的電腦。新瀏覽器首次連線仍需電腦上的 AgentKib 顯示的授權碼。",
    intro: "從電腦上的 AgentKib 開始，在手機上繼續查看對話、處理請求和瀏覽產物。",
    steps: [
      "在電腦上的 AgentKib 開啟「設定 → 遠端連線 → 手機」，登入帳號並啟用遠端存取。",
      "連線就緒後，用手機掃描電腦上的 AgentKib 顯示的配對 QR 碼。",
      "輸入電腦上的 AgentKib 顯示的授權碼，即可使用全部工作區和已支援的遠端控制功能。",
    ],
    note: "電腦需要保持開機且 AgentKib 正在執行。連線位址由電腦提供，此頁面不接收配對碼。",
    other: "其他連線方式",
    lan: "區域網路連線",
    lanNote: "已在電腦上的 AgentKib 啟用「區域網路直連」？同一網路下可使用此入口。",
  },
  "en-US": {
    title: "Connect your computer",
    account: "Sign in and choose a computer",
    accountNote:
      "View computers on your account. A new browser still needs the access code shown in AgentKib on your computer to connect for the first time.",
    intro:
      "Start in AgentKib on your computer, then use your phone to read conversations, handle requests and view artifacts.",
    steps: [
      "In AgentKib on your computer, open “Settings → Remote connections → Phones”, sign in and enable remote access.",
      "When the connection is ready, scan the pairing QR code in AgentKib on your computer with your phone.",
      "Enter the access code shown in AgentKib on your computer to access all workspaces and supported remote control features.",
    ],
    note: "Keep your computer on and AgentKib running. Your computer provides the connection link; this page does not accept pairing codes.",
    other: "Other connection methods",
    lan: "Local network connection",
    lanNote:
      "Already enabled LAN direct connection in AgentKib on your computer? Use this option on the same network.",
  },
  "ja-JP": {
    title: "パソコンに接続",
    account: "ログインしてパソコンを選択",
    accountNote:
      "アカウントに登録されたパソコンを表示します。新しいブラウザーでの初回接続には、コンピューター上の AgentKib に表示される認証コードが必要です。",
    intro:
      "パソコンの AgentKib から始めて、スマートフォンで会話の確認、リクエストの処理、成果物の閲覧を続けられます。",
    steps: [
      "コンピューター上の AgentKib で「設定 → リモート接続 → スマートフォン」を開き、ログインしてリモートアクセスを有効にします。",
      "接続の準備ができたら、コンピューター上の AgentKib に表示されたペアリング QR コードをスマートフォンで読み取ります。",
      "コンピューター上の AgentKib に表示された認証コードを入力すると、すべてのワークスペースと対応するリモート操作機能を利用できます。",
    ],
    note: "パソコンの電源を入れ、AgentKib を起動しておく必要があります。接続先はパソコンから取得します。このページではペアリングコードを入力できません。",
    other: "その他の接続方法",
    lan: "LAN 接続",
    lanNote:
      "コンピューター上の AgentKib で「LAN 直接接続」を有効にした場合、同じネットワーク内で利用できます。",
  },
};

export function HostedHome() {
  const env = useEnvironment();
  const copy = hostedCopy[env.locale];
  useAppearance(env.locale, env.theme);
  const icons = [Monitor, Smartphone, ShieldCheck];
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 border-b px-4 py-2 md:px-10 md:py-4">
        <div className="flex items-center gap-3 text-sm">
          <img src="/favicon.svg" width="30" height="30" alt="" />
          <strong>AgentKib</strong>
        </div>
        <ConnectionPreferences locale={env.locale} theme={env.theme} onChange={env.preferences} />
      </header>
      <main className="mx-auto max-w-3xl space-y-6 px-4 py-7 md:space-y-9 md:px-6 md:py-20">
        <div className="space-y-4">
          <h1 className="text-3xl font-medium md:text-4xl tracking-tight">{copy.title}</h1>
          <p className="text-sm leading-7 text-muted-foreground">{copy.intro}</p>
          <a
            href="https://account.agentkib.com/"
            referrerPolicy="no-referrer"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground"
          >
            {copy.account}
            <ArrowRight size={16} aria-hidden="true" />
          </a>
          <p className="text-sm leading-6 text-muted-foreground">{copy.accountNote}</p>
        </div>
        <ol className="space-y-5 rounded-2xl border bg-card p-4 md:p-8">
          {copy.steps.map((step, i) => {
            const Icon = icons[i]!;
            return (
              <li key={step} className="flex items-start gap-4 text-sm leading-7">
                <span
                  className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted"
                  aria-hidden="true"
                >
                  <Icon size={19} />
                </span>
                <span>
                  <span className="mr-2 text-muted-foreground">{i + 1}.</span>
                  {step}
                </span>
              </li>
            );
          })}
        </ol>
        <p className="text-xs leading-6 text-muted-foreground">{copy.note}</p>
        <section className="space-y-3 border-t pt-6" aria-labelledby="other-connections">
          <h2 id="other-connections" className="text-sm font-medium">
            {copy.other}
          </h2>
          <Link
            to="/connect"
            className="inline-flex min-h-11 items-center gap-2 text-sm underline underline-offset-4"
          >
            {copy.lan}
            <ArrowRight size={15} />
          </Link>
          <p className="text-xs leading-6 text-muted-foreground">{copy.lanNote}</p>
        </section>
      </main>
    </div>
  );
}
