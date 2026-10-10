import { createFileRoute } from "@tanstack/react-router";
import { useAppStore } from "@/stores/app-store";
import { QuotaPage } from "@/features/quota/QuotaPage";

function QuotaRoute() {
  const search = Route.useSearch();
  const configurePopoverRequest = useAppStore((state) => state.quotaConfigureRequest);

  return (
    <QuotaPage
      initialProvider={search.quotaProvider}
      initialWindow={search.quotaWindow}
      configurePopoverRequest={configurePopoverRequest}
    />
  );
}

export const Route = createFileRoute("/(main)/quota")({
  staticData: { appRoute: { kind: "global", page: "quota" } },
  component: QuotaRoute,
});
