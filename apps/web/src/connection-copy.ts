import type { Locale } from "./i18n";

export const connectionCopy: Record<
  Locale,
  { title: string; intro: string; steps: string[]; formTitle: string; hint: string }
> = {
  "zh-CN": {
    title: "你的 AgentKib，\n在浏览器中继续查看",
    intro: "网页连接同一局域网中的桌面端。会话仍在你的电脑上，由桌面端决定这个浏览器的访问权限。",
    steps: [
      "在桌面设置中开启托管网页局域网访问",
      "复制桌面显示的地址，或扫描连接二维码",
      "输入配对码，在桌面核对数字并确认授权",
    ],
    formTitle: "连接你的电脑",
    hint: "地址来自桌面端的「托管网页局域网访问」，默认端口为 1422。",
  },
  "zh-TW": {
    title: "你的 AgentKib，\n在瀏覽器中繼續查看",
    intro: "網頁連接同一區域網路中的桌面端。對話仍在你的電腦上，由桌面端決定此瀏覽器的存取權限。",
    steps: [
      "在桌面設定中開啟託管網頁區域網路存取",
      "複製桌面顯示的位址，或掃描連接 QR 碼",
      "輸入配對碼，在桌面核對數字並確認授權",
    ],
    formTitle: "連接你的電腦",
    hint: "位址來自桌面端的「託管網頁區域網路存取」，預設連接埠為 1422。",
  },
  "en-US": {
    title: "Your AgentKib.\nNow in your browser.",
    intro:
      "Connect to the desktop app on your local network. Conversations stay on your computer, and the desktop app decides what this browser can access.",
    steps: [
      "Enable hosted web LAN access in desktop settings",
      "Copy the address shown on desktop, or scan its QR code",
      "Enter the pairing code, compare the numbers and authorize on desktop",
    ],
    formTitle: "Connect your computer",
    hint: "Use the address from Hosted web LAN access in desktop settings. The default port is 1422.",
  },
  "ja-JP": {
    title: "あなたの AgentKib を、\nブラウザでも。",
    intro:
      "同じ LAN のデスクトップアプリに接続します。会話はパソコンに保存され、ブラウザのアクセス権限はデスクトップ側で管理します。",
    steps: [
      "デスクトップ設定でホスト型 Web の LAN アクセスを有効にする",
      "表示されたアドレスをコピーするか、接続 QR コードを読み取る",
      "ペアリングコードを入力し、デスクトップで数字を照合して許可する",
    ],
    formTitle: "パソコンに接続",
    hint: "デスクトップ設定のホスト型 Web LAN アクセスに表示されたアドレスを使用します。既定のポートは 1422 です。",
  },
};
