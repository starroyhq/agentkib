import { createContext, useContext, useState, type ReactNode } from "react";
import type { Locale } from "@/i18n";

export interface EnvironmentOptions {
  hosted?: boolean;
  origin?: string;
  initialLocale?: Locale;
  initialTheme?: string;
  disconnect?: () => void;
  address?: string;
}
function useEnvironmentState(initial: EnvironmentOptions) {
  const [origin, setOrigin] = useState(initial.origin);
  const [locale, setLocale] = useState<Locale>(initial.initialLocale ?? "zh-CN");
  const [theme, setTheme] = useState(initial.initialTheme ?? "system");
  const [attempt, setAttempt] = useState(0);
  return {
    hosted: initial.hosted ?? false,
    origin,
    locale,
    theme,
    attempt,
    address: initial.address ?? "",
    connect(address: string, nextLocale: Locale, nextTheme: string) {
      setLocale(nextLocale);
      setTheme(nextTheme);
      setOrigin(address);
      setAttempt((n) => n + 1);
    },
    disconnect() {
      setOrigin(undefined);
      initial.disconnect?.();
    },
  };
}
const EnvironmentContext = createContext<ReturnType<typeof useEnvironmentState> | null>(null);
export function EnvironmentProvider({
  initial,
  children,
}: {
  initial: EnvironmentOptions;
  children: ReactNode;
}) {
  const value = useEnvironmentState(initial);
  return <EnvironmentContext value={value}>{children}</EnvironmentContext>;
}
export function useEnvironment() {
  const value = useContext(EnvironmentContext);
  if (!value) throw new Error("EnvironmentProvider is missing");
  return value;
}
