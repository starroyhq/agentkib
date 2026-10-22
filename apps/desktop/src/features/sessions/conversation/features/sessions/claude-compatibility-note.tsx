import {
  claudeBridgeCompatibility,
  type ClaudeBridgeCompatibilityStatus,
} from "@agentkib/web-client";
import { claudeConnectionCopy } from "./claude-connection-copy";

export function ClaudeCompatibilityNote({
  locale,
  compatibility,
  className = "",
}: {
  locale: keyof typeof claudeConnectionCopy;
  compatibility?: ClaudeBridgeCompatibilityStatus | null;
  className?: string;
}) {
  if (
    compatibility?.status !== "unverified" ||
    !["verified", "unverified"].includes(claudeBridgeCompatibility(compatibility.cliVersion))
  )
    return null;
  return (
    <p
      className={`text-xs text-muted-foreground ${className}`}
      data-terminal-compatibility="unverified"
    >
      {claudeConnectionCopy[locale].unverifiedVersion.replace(
        "{version}",
        compatibility.cliVersion,
      )}
    </p>
  );
}
