type CopyLocale = "zh-CN" | "zh-Hant" | "en-US" | "ja-JP";

export type SessionSurface = "desktop" | "web";

const webCopies = new WeakMap<object, Map<CopyLocale, Record<string, string>>>();

/** Applies only to application-owned copy, never to user content or technical errors. */
export function surfaceText(
  text: string,
  surface: SessionSurface = "desktop",
  locale: CopyLocale = "zh-CN",
): string {
  if (surface === "desktop") return text;
  return text
    .replaceAll("AgentKib 需要在这台电脑上保持运行。", "请让电脑上的 AgentKib 保持运行。")
    .replaceAll("AgentKib 需要在這台電腦上保持執行。", "請讓電腦上的 AgentKib 保持執行。")
    .replaceAll(
      "AgentKib must stay running on this computer (the computer running the Agent).",
      "Keep AgentKib running on the computer running the Agent.",
    )
    .replaceAll(
      "AgentKib をこのコンピューターで起動しておく必要があります。",
      "コンピューター上の AgentKib を起動したままにしてください。",
    )
    .replaceAll("这台电脑上的 AgentKib", "电脑上的 AgentKib")
    .replaceAll("這台電腦上的 AgentKib", "電腦上的 AgentKib")
    .replaceAll("AgentKib on this computer", "AgentKib on your computer")
    .replaceAll("このコンピューター上の AgentKib", "コンピューター上の AgentKib")
    .replaceAll("请在 macOS 电脑上操作。", "请在 macOS 电脑上的 AgentKib 里操作。")
    .replaceAll("請在 macOS 電腦上操作。", "請在 macOS 電腦上的 AgentKib 裡操作。")
    .replaceAll("Use a macOS computer.", "Use AgentKib on a macOS computer.")
    .replaceAll(
      "macOS のコンピューターで操作してください。",
      "macOS のコンピューター上の AgentKib で操作してください。",
    )
    .replaceAll("桌面 Web 设置", "电脑上的 AgentKib 的 Web 设置")
    .replaceAll("桌面端", locale === "zh-Hant" ? "電腦上的 AgentKib" : "电脑上的 AgentKib")
    .replaceAll("这台电脑", "运行 AgentKib 的电脑")
    .replaceAll("桌面 Web 設定", "電腦上的 AgentKib 的 Web 設定")
    .replaceAll("這台電腦", "執行 AgentKib 的電腦")
    .replaceAll("desktop Web settings", "Web settings in AgentKib on your computer")
    .replaceAll("the desktop app", "AgentKib on your computer")
    .replaceAll("this computer", "the computer running AgentKib")
    .replaceAll("This computer", "The computer running AgentKib")
    .replaceAll("デスクトップの Web 設定", "コンピューター上の AgentKib の Web 設定")
    .replaceAll("デスクトップアプリ", "コンピューター上の AgentKib")
    .replaceAll("このコンピューター", "AgentKib を実行しているコンピューター")
    .replace(/AgentKib(?=[\p{Script=Han}])/gu, "AgentKib ");
}

export function surfaceCopy<T extends Record<string, string>>(
  copy: T,
  surface: SessionSurface = "desktop",
  locale: CopyLocale = "zh-CN",
): T {
  if (surface === "desktop") return copy;
  let localized = webCopies.get(copy);
  if (!localized) {
    localized = new Map();
    webCopies.set(copy, localized);
  }
  const cached = localized.get(locale);
  if (cached) return cached as T;
  const result = Object.fromEntries(
    Object.entries(copy).map(([key, value]) => [key, surfaceText(value, surface, locale)]),
  );
  localized.set(locale, result);
  return result as T;
}
