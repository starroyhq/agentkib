import { useI18n } from "@/core/useI18n";
import { FileCode2, FolderGit2, PlugZap } from "lucide-react";
import type { RemoteGatewaySummary } from "@/core/types";

export function RemoteAgentGatewayDetails({ gateways }: { gateways: RemoteGatewaySummary[] }) {
  const { tr } = useI18n();
  const sectionClass = "grid gap-3 rounded-xl border border-border bg-background p-4";
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <section className={sectionClass}>
        <h3 className="text-sm font-semibold">{tr("gateway.title")}</h3>
        <div className="grid gap-2">
          {gateways.map((gateway) => (
            <div
              className="grid min-h-[58px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg bg-muted/20 px-2 text-sm"
              key={gateway.id}
            >
              <PlugZap size={15} className="text-muted-foreground" />
              <span className="min-w-0 truncate">
                <strong className="block truncate">{gateway.name}</strong>
                <small className="block truncate text-xs text-muted-foreground">
                  {gateway.url}
                </small>
              </span>
              <em className={`not-italic text-xs gateway-${gateway.state}`}>
                {tr(`gateway.state.${gateway.state}`)}
              </em>
            </div>
          ))}
        </div>
      </section>
      <section className={sectionClass}>
        <h3 className="text-sm font-semibold">{tr("gateway.remoteWorkspaces")}</h3>
        <div className="grid gap-2">
          {gateways.flatMap((gateway) =>
            gateway.workspaces.map((workspace) => (
              <div
                className="grid min-h-[58px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg bg-muted/20 px-2 text-sm"
                key={`${gateway.id}:${workspace.id}`}
              >
                <FolderGit2 size={15} className="text-muted-foreground" />
                <span className="min-w-0 truncate">
                  <strong className="block truncate">{workspace.name}</strong>
                  <small className="block truncate text-xs text-muted-foreground">
                    {workspace.path ?? gateway.name}
                  </small>
                </span>
                <small className="text-xs text-muted-foreground">
                  {tr("common.sessions")} {workspace.session_count}
                </small>
              </div>
            )),
          )}
        </div>
      </section>
      <section className={sectionClass}>
        <h3 className="text-sm font-semibold">{tr("gateway.remoteAssets")}</h3>
        <div className="grid gap-2">
          {gateways.flatMap((gateway) =>
            gateway.assets.map((asset) => (
              <div
                className="grid min-h-[58px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg bg-muted/20 px-2 text-sm"
                key={`${gateway.id}:${asset.id}`}
              >
                <FileCode2 size={15} className="text-muted-foreground" />
                <span className="min-w-0 truncate">
                  <strong className="block truncate">{asset.name}</strong>
                  <small className="block truncate text-xs text-muted-foreground">
                    {asset.path}
                  </small>
                </span>
                <em className="not-italic text-xs text-muted-foreground">{asset.kind}</em>
              </div>
            )),
          )}
          {gateways.every((gateway) => !gateway.assets.length) && (
            <p className="pt-2 text-sm text-muted-foreground">
              {tr(
                gateways.every((gateway) => gateway.kind === "hermes")
                  ? "gateway.hermesPartial"
                  : "gateway.noRemoteAssets",
              )}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
