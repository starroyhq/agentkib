import { FileText, Folder, X } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  SessionResource,
  ManagedAgent,
  ManagedOptions,
  SessionProviderCapabilities,
  WebClient,
} from "@agentkib/web-client";
import { fillCopy, type InteractionLocale } from "./interaction-model";
import { newSessionCopy } from "./new-session";
import { parseGoalDraft, type NewSessionGoalDraft } from "./new-session-draft";

type GoalEditor = { objective: string; budget: string };
type ResourceClient = Pick<WebClient, "newSessionResources">;
type ResourcePage = Awaited<ReturnType<ResourceClient["newSessionResources"]>>;

const noResources: SessionResource[] = [];

/** Keep supported startup entries stable while the host verifies their current availability. */
export function newSessionAddCapabilities(
  options: ManagedOptions | undefined,
  create: SessionProviderCapabilities["create"] | undefined,
  advancedAccess: boolean,
) {
  const reported = options?.provider?.create;
  const planField = create?.planMode;
  const emptyCreate = create?.mode === "empty";
  const ready =
    options?.available === true && emptyCreate && reported?.mode !== "with-first-message";
  const resourcesOffered = emptyCreate && advancedAccess && create.workspaceResources === true;
  const goalsOffered = emptyCreate && advancedAccess && create.goal === true;
  return {
    planField,
    planOffered: emptyCreate && !!planField,
    offersPlan:
      ready &&
      !!planField &&
      (reported?.planMode === planField ||
        (planField === "permissionMode" &&
          options.permissionModes?.some((mode) => mode.id === "plan") === true)),
    resourcesOffered,
    resourcesAllowed: ready && resourcesOffered && reported?.workspaceResources === true,
    goalsOffered,
    goalsAllowed: ready && goalsOffered && reported?.goal === true,
    hideGoalBudget: create?.goalBudget === "rounds",
  };
}

export function useNewSessionAdd({
  agent,
  workspaceId,
  client,
  resourceAuthority,
  resourcesAllowed,
  resourcesOffered = resourcesAllowed,
  locked,
  offline,
  resourceError,
  resourceReason,
}: {
  agent: ManagedAgent;
  workspaceId?: string;
  client: ResourceClient;
  resourceAuthority: string;
  resourcesAllowed: boolean;
  resourcesOffered?: boolean;
  locked: boolean;
  offline?: boolean;
  resourceError: (error: unknown) => string;
  resourceReason: (code?: string) => string;
}) {
  // Use the visit identity so a late read for A cannot populate a new visit to A via B.
  const scope = useMemo(() => ({ agent, workspaceId, client }), [agent, workspaceId, client]);
  const listingScope = useMemo(
    () => ({ scope, resourcesAllowed, offline, resourceAuthority }),
    [scope, resourcesAllowed, offline, resourceAuthority],
  );
  const currentListingScope = useRef<typeof listingScope>(undefined);
  const request = useRef<AbortController>(undefined);
  const [listing, setListing] = useState<{
    scope: typeof listingScope;
    path: string[];
    page?: ResourcePage;
    loading?: boolean;
    error?: string;
    failed?: { directoryId?: string; path: string[] };
  }>();
  const [selection, setSelection] = useState<{
    scope: typeof scope;
    items: { resource: SessionResource; authority: string }[];
  }>();
  const [savedGoal, setSavedGoal] = useState<{ scope: typeof scope; goal: NewSessionGoalDraft }>();
  const [editor, setEditor] = useState<{ scope: typeof scope; fields: GoalEditor }>();
  const activeListing = listing?.scope === listingScope && resourcesAllowed ? listing : undefined;
  const resources = useMemo(
    () =>
      selection?.scope === scope
        ? selection.items.map(({ resource, authority }) =>
            authority === resourceAuthority ? resource : { ...resource, available: false },
          )
        : noResources,
    [resourceAuthority, scope, selection],
  );
  const goal = savedGoal?.scope === scope ? savedGoal.goal : undefined;
  const goalEditor = editor?.scope === scope ? editor.fields : undefined;

  useLayoutEffect(() => {
    currentListingScope.current = listingScope;
    return () => {
      currentListingScope.current = undefined;
      request.current?.abort();
    };
  }, [listingScope]);

  function setResources(items: SessionResource[]) {
    setSelection((previous) => {
      const existing = new Map(
        previous?.scope === scope ? previous.items.map((item) => [item.resource.id, item]) : [],
      );
      return {
        scope,
        items: items.map(
          (item) => existing.get(item.id) ?? { resource: item, authority: resourceAuthority },
        ),
      };
    });
  }

  async function load(directoryId?: string, path: string[] = []) {
    if (!workspaceId || !resourcesAllowed || locked) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const isCurrent = () =>
      !controller.signal.aborted && currentListingScope.current === listingScope;
    setListing({
      scope: listingScope,
      path: activeListing?.path ?? [],
      page: activeListing?.page,
      loading: true,
    });
    try {
      const page = await client.newSessionResources(
        workspaceId,
        agent,
        directoryId,
        controller.signal,
      );
      if (!isCurrent()) return;
      if (page.workspaceId !== workspaceId) throw new Error("workspace-mismatch");
      setListing({ scope: listingScope, path, page });
      // Preserve the selection if its authority or file changes, so it can't silently be omitted.
      setSelection((previous) => {
        if (previous?.scope !== scope) return previous;
        const visible = new Map(page.resources.map((item) => [item.id, item]));
        return {
          scope,
          items: previous.items.map((item) => {
            const next = visible.get(item.resource.id);
            return next ? { ...item, resource: next } : item;
          }),
        };
      });
    } catch (error) {
      if (!isCurrent()) return;
      setListing({
        scope: listingScope,
        path: activeListing?.path ?? [],
        page: activeListing?.page,
        error: resourceError(error),
        failed: { directoryId, path },
      });
    }
  }

  const editedGoal = goalEditor && parseGoalDraft(goalEditor.objective, goalEditor.budget);
  const failed = activeListing?.failed;

  return {
    resources,
    setResources,
    resourceBrowser: resourcesOffered
      ? {
          page: activeListing?.page,
          path: activeListing?.path ?? [],
          selected: resources,
          loading: activeListing?.loading,
          error: activeListing?.error,
          offline,
          disabled: !resourcesAllowed,
          selectable: resourcesAllowed && !locked,
          reasonText: (code?: string) =>
            code === activeListing?.error ? (code ?? "") : resourceReason(code),
          load,
          retry: failed ? () => void load(failed.directoryId, failed.path) : undefined,
          onSelect: setResources,
        }
      : undefined,
    goal,
    goalEditor,
    goalValid: !!editedGoal,
    openGoal: () =>
      setEditor({
        scope,
        fields: { objective: goal?.objective ?? "", budget: goal?.tokenBudget?.toString() ?? "" },
      }),
    editGoal: (change: Partial<GoalEditor>) =>
      setEditor((previous) =>
        previous?.scope === scope ? { scope, fields: { ...previous.fields, ...change } } : previous,
      ),
    closeGoal: () => setEditor(undefined),
    saveGoal: () => {
      if (!editedGoal) return;
      setSavedGoal({ scope, goal: editedGoal });
      setEditor(undefined);
    },
    clearGoal: () => {
      setSavedGoal(undefined);
      setEditor(undefined);
    },
    clearDraftAdditions: () => {
      setSelection(undefined);
      setSavedGoal(undefined);
      setEditor(undefined);
    },
  };
}

export function NewSessionAddDraftChips({
  locale,
  resources,
  disabled,
  onRemoveResource,
}: {
  locale: InteractionLocale;
  resources: readonly SessionResource[];
  disabled: boolean;
  onRemoveResource: (id: string) => void;
}) {
  if (resources.length === 0) return null;
  const copy = newSessionCopy(locale);
  const chip =
    "flex max-w-56 min-w-0 items-center gap-1.5 rounded-md border border-border bg-muted/40 py-1 pl-2 pr-1 text-xs";
  const icon = "size-3.5 shrink-0";
  const remove =
    "grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted disabled:opacity-50";
  return (
    <ul className="flex flex-wrap gap-1.5 px-1 pt-1">
      {resources.map((item) => {
        const Icon = item.kind === "directory" ? Folder : FileText;
        return (
          <li key={item.id} className={chip}>
            <Icon className={icon} aria-hidden />
            <span className="truncate" title={item.name}>
              {item.name}
            </span>
            <button
              type="button"
              className={remove}
              aria-label={fillCopy(copy.removeFile, { name: item.name })}
              disabled={disabled}
              onClick={() => onRemoveResource(item.id)}
            >
              <X className="size-3" aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
