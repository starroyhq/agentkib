import { surfaceCopy, type SessionSurface } from "./session-surface-copy";

const en = {
  intro: "Pages running on this computer, such as a dev server started in this conversation.",
  found: "Addresses in this conversation",
  none: "No local page addresses in this conversation yet.",
  address: "Port or local address",
  placeholder: "5173 or localhost:5173/path",
  open: "Open",
  invalid: "Enter a port, or an address on localhost or 127.0.0.1.",
  back: "Other pages",
  reload: "Reload",
  external: "Open in browser",
  frame: "Web preview",
  blank: "If the page stays blank, check that its server is still running.",
};
type Copy = typeof en;
const zh: Copy = {
  intro: "这台电脑上正在运行的网页，例如这个会话启动的开发服务器。",
  found: "会话里出现的地址",
  none: "这个会话里还没有本机网页地址。",
  address: "端口或本机地址",
  placeholder: "5173 或 localhost:5173/path",
  open: "打开",
  invalid: "请输入端口，或 localhost、127.0.0.1 上的地址。",
  back: "其他网页",
  reload: "重新加载",
  external: "在浏览器中打开",
  frame: "网页预览",
  blank: "如果页面一直空白，请确认它的服务器仍在运行。",
};
const tw: Copy = {
  intro: "這台電腦上正在執行的網頁，例如這段對話啟動的開發伺服器。",
  found: "對話中出現的位址",
  none: "這段對話中還沒有本機網頁位址。",
  address: "連接埠或本機位址",
  placeholder: "5173 或 localhost:5173/path",
  open: "開啟",
  invalid: "請輸入連接埠，或 localhost、127.0.0.1 上的位址。",
  back: "其他網頁",
  reload: "重新載入",
  external: "在瀏覽器中開啟",
  frame: "網頁預覽",
  blank: "如果頁面一直空白，請確認它的伺服器仍在執行。",
};
const ja: Copy = {
  intro: "このコンピューターで動いている Web ページです。この会話で起動した開発サーバーなど。",
  found: "会話に出てきたアドレス",
  none: "この会話にはまだローカルのアドレスがありません。",
  address: "ポートまたはローカルアドレス",
  placeholder: "5173 または localhost:5173/path",
  open: "開く",
  invalid: "ポート番号、または localhost か 127.0.0.1 のアドレスを入力してください。",
  back: "ほかのページ",
  reload: "再読み込み",
  external: "ブラウザーで開く",
  frame: "Web プレビュー",
  blank: "ページが空白のままなら、サーバーが動いているか確認してください。",
};
export function livePreviewCopy(locale: string, surface: SessionSurface = "desktop"): Copy {
  const language =
    locale === "en-US" || locale === "zh-TW" || locale === "ja-JP" ? locale : "zh-CN";
  const copy =
    language === "en-US" ? en : language === "zh-TW" ? tw : language === "ja-JP" ? ja : zh;
  return surfaceCopy(copy, surface, language);
}
