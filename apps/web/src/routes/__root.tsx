import { createRootRouteWithContext, Link, Outlet } from "@tanstack/react-router";
import { EnvironmentProvider, type EnvironmentOptions } from "@/providers/environment";

export const Route = createRootRouteWithContext<EnvironmentOptions>()({
  component: Root,
  notFoundComponent: () => (
    <main className="grid min-h-dvh place-content-center gap-5 p-8 text-center">
      <h1 className="text-3xl">404</h1>
      <Link to="/" className="underline">
        AgentKib
      </Link>
    </main>
  ),
});
function Root() {
  const initial = Route.useRouteContext();
  return (
    <EnvironmentProvider initial={initial}>
      <Outlet />
    </EnvironmentProvider>
  );
}
