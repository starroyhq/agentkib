export const lanSettingsCopy = {
  "zh-CN": {
    title: "托管网页局域网访问",
    enabled: "启用局域网直连",
    scope:
      "在同一局域网用 Chromium 打开 remote.agentkib.com，直接连接本机。Cloudflare 只提供网页，不中继会话。授权包含全部已登记及以后新增的工作区。",
    risk: "我了解：局域网连接为明文 HTTP，会话、凭据及控制请求可能被窃取或篡改。仅在可信网络使用，不配置公网端口转发。",
    address: "监听网卡地址",
    choose: "请选择私有 IPv4 地址",
    noAddress: "未发现可用的私有 IPv4 地址，请连接局域网后重试。",
    addressLost: "所选网卡地址已失效，连接已停止。请选择当前地址并重新保存。",
    endpoint: "后端地址",
    link: "连接链接",
    qr: "扫描二维码连接（仅包含后端地址）",
    session:
      "浏览器需要允许本地网络访问；刷新或关闭网页后需重新配对。明文风险与配对校验是两回事，配对不能防止网络窃听。",
  },
  "zh-TW": {
    title: "託管網頁區域網路存取",
    enabled: "啟用區域網路直連",
    scope:
      "在同一區域網路以 Chromium 開啟 remote.agentkib.com，直接連接本機。Cloudflare 僅提供網頁，不中繼對話。授權包含全部已登記及以後新增的工作區。",
    risk: "我了解：區域網路連線使用明文 HTTP，對話、憑證及操作請求可能遭竊取或竄改。僅在可信網路使用，不設定公網連接埠轉送。",
    address: "監聽網卡位址",
    choose: "請選擇私有 IPv4 位址",
    noAddress: "未找到可用的私有 IPv4 位址，請連接區域網路後重試。",
    addressLost: "所選網卡位址已失效，連線已停止。請選擇目前位址並重新儲存。",
    endpoint: "後端位址",
    link: "連線連結",
    qr: "掃描 QR 碼連線（僅包含後端位址）",
    session:
      "瀏覽器需要允許本機網路存取；重新整理或關閉網頁後需重新配對。明文風險與配對驗證不同，配對無法防止網路竊聽。",
  },
  "en-US": {
    title: "Hosted Web LAN access",
    enabled: "Enable LAN direct connection",
    scope:
      "Open remote.agentkib.com in Chromium on the same LAN to connect directly to this computer. Cloudflare serves only the website, not conversation traffic. Access includes all registered and future workspaces.",
    risk: "I understand: LAN traffic uses plaintext HTTP. Conversations, credentials and control requests can be intercepted or modified. Use trusted networks only; do not forward this port to the Internet.",
    address: "Network interface address",
    choose: "Select a private IPv4 address",
    noAddress: "No private IPv4 address is available. Connect to your LAN and try again.",
    addressLost:
      "The selected interface address is no longer available. Connections stopped. Select a current address and save again.",
    endpoint: "Backend address",
    link: "Connection link",
    qr: "Scan to connect (backend address only)",
    session:
      "Allow local network access in your browser. Reloading or closing the page requires pairing again. Pairing verifies access; it does not protect plaintext traffic from eavesdropping.",
  },
  "ja-JP": {
    title: "ホスト型 Web の LAN アクセス",
    enabled: "LAN 直接接続を有効化",
    scope:
      "同じ LAN 上の Chromium で remote.agentkib.com を開き、このコンピューターに直接接続します。Cloudflare は Web ページのみを配信し、会話を中継しません。登録済みおよび今後追加される全ワークスペースが対象です。",
    risk: "理解しました：LAN 通信は平文 HTTP です。会話、認証情報、操作要求が盗聴・改ざんされる可能性があります。信頼できるネットワークのみで使用し、インターネットへのポート転送は設定しないでください。",
    address: "ネットワークインターフェースのアドレス",
    choose: "プライベート IPv4 アドレスを選択",
    noAddress:
      "使用可能なプライベート IPv4 アドレスがありません。LAN に接続して再試行してください。",
    addressLost:
      "選択したアドレスが無効になり、接続を停止しました。現在のアドレスを選択して再保存してください。",
    endpoint: "バックエンドアドレス",
    link: "接続リンク",
    qr: "スキャンして接続（バックエンドアドレスのみ）",
    session:
      "ブラウザーでローカルネットワークへのアクセスを許可してください。再読み込みやページを閉じた後は再ペアリングが必要です。ペアリングは平文通信の盗聴を防ぎません。",
  },
};
