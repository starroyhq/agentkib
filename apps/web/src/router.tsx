import { useState } from "react";
import {
  createHashHistory,
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { routeTree } from "@/routeTree.gen";
import type { EnvironmentOptions } from "@/providers/environment";
export { Dialog } from "@/components/dialog";
export { mergeLatestPage } from "@/features/sessions/session-model";

export function makeRouter(options: EnvironmentOptions = {}, memory = false) {
  // Consume legacy connection links before the hash becomes the router's URL.
  const address =
    typeof location !== "undefined"
      ? new URLSearchParams(location.hash.slice(1)).get("connect")
      : null;
  if (address !== null) history.replaceState(null, "", location.pathname + location.search);
  return createRouter({
    routeTree,
    history: memory
      ? createMemoryHistory({
          initialEntries: [options.hosted && !options.origin ? "/connect" : "/sessions"],
        })
      : createHashHistory(),
    context: { ...options, address: address ?? options.address },
    defaultPreload: "intent",
    defaultPendingMs: 0,
  });
}
declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
export function WebApplication(options: EnvironmentOptions) {
  const [router] = useState(() => makeRouter(options, import.meta.env.MODE === "test"));
  return <RouterProvider router={router} />;
}
