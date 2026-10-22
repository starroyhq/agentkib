import { createFileRoute, redirect } from "@tanstack/react-router";
import { legacyAgentSettingsSearch } from "@/features/app/app-route";

// Keep saved links and native navigation requests compatible without mounting the old page.
export const Route = createFileRoute("/(main)/agents")({
  staticData: { appRoute: { kind: "global", page: "agents" } },
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/settings", replace: true, search: legacyAgentSettingsSearch(search) });
  },
});
