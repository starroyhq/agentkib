import { legacyConnectionLink } from "@/features/connection/legacy-link";
import { useState } from "react";
import {
  createHashHistory,
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { routeTree } from "@/routeTree.gen";
import type { EnvironmentOptions } from "@/providers/environment";
export { Dialog } from "@/features/conversation/components/dialog";
export { mergeLatestPage } from "@agentkib/conversation-state";

export function makeRouter(options: EnvironmentOptions = {}, memory = false) {
  // Consume legacy connection links before the hash becomes the router's URL.
  const legacy =
    options.hosted && typeof location !== "undefined"
      ? legacyConnectionLink(location.hash)
      : undefined;
  const address = legacy?.address;
  if (legacy) {
    history.replaceState(
      null,
      "",
      location.pathname + location.search + (address ? "#/connect" : "#/"),
    );
  }
  return createRouter({
    routeTree,
    history: memory
      ? createMemoryHistory({
          initialEntries: [
            address
              ? "/connect"
              : options.hosted && !options.origin && !options.connection
                ? "/"
                : "/sessions",
          ],
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
