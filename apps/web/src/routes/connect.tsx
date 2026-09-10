import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEnvironment } from "@/providers/environment";
import { ConnectionPage } from "@/features/connection/connection-page";
export const Route = createFileRoute("/connect")({ component: Connect });
function Connect() {
  const env = useEnvironment();
  return env.hosted && !env.origin ? <ConnectionPage /> : <Navigate to="/sessions" replace />;
}
