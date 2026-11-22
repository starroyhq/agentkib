import { SessionContextUsageGauge, type SessionContextUsageGaugeProps } from "@agentkib/session-ui";
import { useSession } from "./web-session-context";

export {
  contextUsagePercent,
  useObservedContextUsage,
  type ContextUsageHandle,
} from "@agentkib/session-ui";

export function ContextUsageGauge(props: SessionContextUsageGaugeProps = {}) {
  const session = useSession();
  return <SessionContextUsageGauge {...props} session={session} surface="web" />;
}
