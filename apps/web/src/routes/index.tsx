import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEnvironment } from "@/providers/environment";
export const Route = createFileRoute("/")({ component: Index });
function Index() {
  const env = useEnvironment();
  return <Navigate to={env.hosted && !env.origin ? "/connect" : "/sessions"} replace />;
}
