import { createFileRoute, Navigate } from "@tanstack/react-router";
export const Route = createFileRoute("/_session/pair")({
  validateSearch: (search: Record<string, unknown>): { session?: string } => ({
    session: typeof search.session === "string" ? search.session : undefined,
  }),
  component: Paired,
});
function Paired() {
  const { session } = Route.useSearch();
  return session ? (
    <Navigate to="/sessions/$sessionId" params={{ sessionId: session }} replace />
  ) : (
    <Navigate to="/sessions" replace />
  );
}
