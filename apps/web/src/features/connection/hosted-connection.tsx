import { useEffect, useState } from "react";
import { WebApplication } from "@/router";
import { ConnectionScreen } from "./connection-page";
import type { Locale } from "@/i18n";

export function HostedConnection() {
  const [address, setAddress] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get("connect") ?? "",
  );
  const [connection, setConnection] = useState<{
    origin: string;
    initialLocale: Locale;
    initialTheme: string;
  }>();
  useEffect(() => {
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  }, []);
  return connection ? (
    <WebApplication {...connection} disconnect={() => setConnection(undefined)} />
  ) : (
    <ConnectionScreen
      initialAddress={address}
      onConnect={(origin, initialLocale, initialTheme) => {
        setAddress(origin);
        setConnection({ origin, initialLocale, initialTheme });
      }}
    />
  );
}
