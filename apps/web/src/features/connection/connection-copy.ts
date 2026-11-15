import type { Locale } from "@/features/conversation/i18n";

export const connectionCopy: Record<
  Locale,
  {
    title: string;
    intro: string;
    steps: string[];
    formTitle: string;
    hint: string;
    addressHelp: string;
  }
> = {
  "zh-CN": {
    title: "局域网连接",
    addressHelp: "如何获取地址",
    intro:
      "网页连接同一局域网中电脑上的 AgentKib。会话仍在那台电脑上，由 AgentKib 决定这个浏览器的访问权限。",
    steps: [
      "在电脑上的 AgentKib 的远程连接设置中启用“局域网直连”",
      "复制电脑上的 AgentKib 显示的地址，或扫描连接二维码",
      "输入配对码，在电脑上的 AgentKib 核对数字并确认授权",
    ],
    formTitle: "连接你的电脑",
    hint: "地址来自电脑上的 AgentKib 的“局域网直连”，默认端口为 1422。",
  },
  "zh-Hant": {
    title: "區域網路連線",
    addressHelp: "如何取得位址",
    intro:
      "網頁連接同一區域網路中電腦上的 AgentKib。對話仍在那台電腦上，由 AgentKib 決定此瀏覽器的存取權限。",
    steps: [
      "在電腦上的 AgentKib 的遠端連線設定中啟用「區域網路直連」",
      "複製電腦上的 AgentKib 顯示的位址，或掃描連接 QR 碼",
      "輸入配對碼，在電腦上的 AgentKib 核對數字並確認授權",
    ],
    formTitle: "連接你的電腦",
    hint: "位址來自電腦上的 AgentKib 的「區域網路直連」，預設連接埠為 1422。",
  },
  "en-US": {
    title: "Local network connection",
    addressHelp: "How to find your address",
    intro:
      "Connect to AgentKib on your computer over your local network. Conversations stay on that computer, and AgentKib decides what this browser can access.",
    steps: [
      "Enable LAN direct connection in Remote connection settings in AgentKib on your computer",
      "Copy the address shown in AgentKib on your computer, or scan its QR code",
      "Enter the pairing code, then compare the numbers and authorize in AgentKib on your computer",
    ],
    formTitle: "Connect your computer",
    hint: "Use the address from LAN direct connection in AgentKib on your computer. The default port is 1422.",
  },
  "ja-JP": {
    title: "LAN 接続",
    addressHelp: "接続先アドレスの確認方法",
    intro:
      "同じ LAN のコンピューター上の AgentKib に接続します。会話はそのコンピューターに保存され、ブラウザーのアクセス権限は AgentKib で管理します。",
    steps: [
      "コンピューター上の AgentKib のリモート接続設定で「LAN 直接接続」を有効にする",
      "コンピューター上の AgentKib に表示されたアドレスをコピーするか、接続 QR コードを読み取る",
      "ペアリングコードを入力し、コンピューター上の AgentKib で数字を照合して許可する",
    ],
    formTitle: "パソコンに接続",
    hint: "コンピューター上の AgentKib の「LAN 直接接続」に表示されたアドレスを使用します。既定のポートは 1422 です。",
  },
};
