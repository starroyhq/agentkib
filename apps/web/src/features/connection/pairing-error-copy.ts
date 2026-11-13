import type { Locale } from "@/features/conversation/i18n";

const zh = {
  requesting: "正在请求连接…",
  invalid_pairing_code: "配对码不正确、已过期或已使用。请在电脑上生成新码后重新输入。",
  device_limit: "已授权设备已达上限。请在电脑的远程访问设置中撤销不再使用的设备后重试。",
  pending_limit: "等待确认的设备请求过多。请先在电脑上处理或取消其他请求后重试。",
  rate_limited: "请求过于频繁，请稍后再试。",
  already_paired: "此浏览器已有配对状态。请重新连接以确认当前访问状态。",
  invalid_input: "请检查配对码和浏览器名称，名称不得超过 80 个字符或包含控制字符。",
  csrf_rejected: "连接验证已失效。请重新连接后再提交配对请求。",
  request_failed: "配对请求失败。请检查网络及电脑上的远程访问状态后重试。",
};

export const pairingErrorCopy: Record<Locale, typeof zh> = {
  "zh-CN": zh,
  "zh-Hant": {
    requesting: "正在請求連線…",
    invalid_pairing_code: "配對碼不正確、已過期或已使用。請在電腦上產生新碼後重新輸入。",
    device_limit: "已授權裝置已達上限。請在電腦的遠端存取設定中撤銷不再使用的裝置後重試。",
    pending_limit: "等待確認的裝置請求過多。請先在電腦上處理或取消其他請求後重試。",
    rate_limited: "請求過於頻繁，請稍後再試。",
    already_paired: "此瀏覽器已有配對狀態。請重新連線以確認目前的存取狀態。",
    invalid_input: "請檢查配對碼和瀏覽器名稱，名稱不得超過 80 個字元或包含控制字元。",
    csrf_rejected: "連線驗證已失效。請重新連線後再提交配對請求。",
    request_failed: "配對請求失敗。請檢查網路及電腦上的遠端存取狀態後重試。",
  },
  "en-US": {
    requesting: "Requesting connection…",
    invalid_pairing_code:
      "The pairing code is incorrect, expired or already used. Generate a new code on your computer and enter it again.",
    device_limit:
      "The authorized device limit has been reached. Revoke an unused device in remote access settings on your computer, then retry.",
    pending_limit:
      "Too many devices are awaiting confirmation. Handle or cancel other requests on your computer, then retry.",
    rate_limited: "Too many requests. Wait a moment, then retry.",
    already_paired:
      "This browser already has a pairing state. Reconnect to confirm its current access.",
    invalid_input:
      "Check the pairing code and browser name. Names must be at most 80 characters and contain no control characters.",
    csrf_rejected:
      "Connection verification expired. Reconnect before submitting the pairing request again.",
    request_failed:
      "The pairing request failed. Check your network and remote access on your computer, then retry.",
  },
  "ja-JP": {
    requesting: "接続をリクエスト中…",
    invalid_pairing_code:
      "ペアリングコードが正しくないか、有効期限切れ、または使用済みです。パソコンで新しいコードを発行して入力してください。",
    device_limit:
      "認証済みデバイスが上限に達しました。パソコンのリモートアクセス設定で使わないデバイスの認証を取り消してから再試行してください。",
    pending_limit:
      "確認待ちのデバイスが多すぎます。パソコンでほかのリクエストを処理またはキャンセルしてから再試行してください。",
    rate_limited: "リクエストが多すぎます。しばらく待ってから再試行してください。",
    already_paired:
      "このブラウザにはすでにペアリング状態があります。再接続して現在のアクセス状態を確認してください。",
    invalid_input:
      "ペアリングコードとブラウザ名を確認してください。名前は 80 文字以内で、制御文字は使用できません。",
    csrf_rejected: "接続の検証が失効しました。再接続してからペアリングをリクエストしてください。",
    request_failed:
      "ペアリングのリクエストに失敗しました。ネットワークとパソコンのリモートアクセス状態を確認してから再試行してください。",
  },
};

const accessCodeErrors: Record<Locale, { invalid_pairing_code: string; invalid_input: string }> = {
  "zh-CN": {
    invalid_pairing_code: "授权码不正确、已过期或已使用。请在电脑上生成新码后重新输入。",
    invalid_input: "请检查授权码和浏览器名称，名称不得超过 80 个字符或包含控制字符。",
  },
  "zh-Hant": {
    invalid_pairing_code: "授權碼不正確、已過期或已使用。請在電腦上產生新碼後重新輸入。",
    invalid_input: "請檢查授權碼和瀏覽器名稱，名稱不得超過 80 個字元或包含控制字元。",
  },
  "en-US": {
    invalid_pairing_code:
      "The access code is incorrect, expired or already used. Generate a new code on your computer and enter it again.",
    invalid_input:
      "Check the access code and browser name. Names must be at most 80 characters and contain no control characters.",
  },
  "ja-JP": {
    invalid_pairing_code:
      "認証コードが正しくないか、有効期限切れ、または使用済みです。パソコンで新しいコードを発行して入力してください。",
    invalid_input:
      "認証コードとブラウザ名を確認してください。名前は 80 文字以内で、制御文字は使用できません。",
  },
};

export function pairingErrorText(
  locale: Locale,
  code: string,
  mode: "pairing" | "access" = "pairing",
) {
  if (mode === "access" && (code === "invalid_pairing_code" || code === "invalid_input"))
    return accessCodeErrors[locale][code];
  const copy = pairingErrorCopy[locale];
  return Object.hasOwn(copy, code) && code !== "requesting"
    ? copy[code as Exclude<keyof typeof zh, "requesting">]
    : copy.request_failed;
}
